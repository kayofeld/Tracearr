# Per-User Played-State Sync + Optional Playback Reporting Ingest — Design

**Status:** Accepted (design frozen for build)
**Date:** 2026-07-29
**Author:** software-architect
**ADRs:** 0010 (played-state mirror + query semantics), 0011 (no-data vs never-watched representation), 0012 (Playback Reporting ingest)
**Branch:** `feat/emby-played-state`

---

## 1. Problem

Tracearr derives "never watched" purely from its own `sessions` table: an item is
never-watched when no session with `duration_ms >= 120000` matches it, with shows rolling up
over child episodes via `library_items.grandparent_rating_key`
(`apps/server/src/routes/library/neverWatched.ts`, `apps/server/src/routes/library/stale.ts`).
Tracearr's session history only begins when its polling started, so anything watched before
that is falsely flagged.

Measured on the production instance (read-only probes, 2026-07-28 — all figures **counted**
unless marked otherwise):

- Library scope (movies + shows): **1,623** items. Currently flagged never-watched: **1,160**.
- Emby's own per-user played flags contradict **472 of those 1,160 (41%)** — 293 movies,
  179 shows (e.g. 1917, 28 Days Later, Airplane!, Cobra Kai).
- **856** of the flagged items were added before session coverage began (2026-01-02) —
  Tracearr has no session data at all for them.
- Emby played-state source: **18,381** played rows across **42 of 49** users. For historical
  plays `UserData.Played` is `true` but `PlayCount` is `0` and `LastPlayedDate` is `null` —
  the source answers _whether_, never _when_ or _how long_.
- Emby Playback Reporting plugin: **6,884** timestamped rows over 91 days (retention now set
  to forever); would correct **~23** additional items today (**estimated** from the probe;
  it grows from here). Its unique value is timestamps + durations.

Two independent corrections follow, deliberately decoupled:

1. **Played-state sync (this increment):** mirror each capable server's per-user played
   flags and OR them into the never-watched predicate.
2. **Playback Reporting ingest (designed here, build deferred):** opt-in import of the
   plugin's timestamped rows as `sessions`, filling the pre-polling history gap with real
   dates/durations.

## 2. Scope

### In scope (increment 1 — the build boundary)

- New tables `played_states` and `played_state_sync_status` (migration **0071**, DDL owned
  by data-engineer — see §9).
- `PlayedStateSyncService` + BullMQ queue `played-state-sync` (scheduled, boot, manual).
- Optional `getPlayedItems` client method, implemented for Emby + Jellyfin in the shared
  base client; absent for Plex.
- Query changes in `neverWatched.ts` and `stale.ts` only (both endpoints, both query paths
  of `stale.ts` — see §5.2).
- Cache invalidation for `LIBRARY_STALE` and `LIBRARY_NEVER_WATCHED` on sync completion.
- Coverage object on both endpoint responses + page-level banner semantics (ADR 0011).
- API contract additions in `@tracearr/shared` (§7, with completeness check §8).
- Running-tasks + WebSocket progress integration.

### Deferred (NOT defects if absent from increment 1)

- **Playback Reporting ingest** (increment 2; ADR 0012 records the accepted design so the
  seam is stable, but no ingest code ships in increment 1).
- Plex per-user played state (needs per-user Plex tokens Tracearr does not hold; Plex
  servers report `capability: 'unsupported'` honestly — ADR 0011).
- Reclassifying played-flag-only items into a dated "stale" category (impossible without
  timestamps; they leave the stale endpoint entirely — ADR 0010 §consequences).
- Extending the other session-only analytics routes (§5.4 list) to consume played state.
  Their session-only assumption is flagged, not fixed, in this increment.
- Any UI redesign beyond the coverage banner and the "No recorded plays" copy rule.

**Consistency seam explicitly in scope:** `neverWatched.ts` and
`stale.ts?category=never_watched` must keep returning the _same_ never-watched set — the
predicate change lands in both, in the same increment, with the same semantics.

## 3. Authoritative sources (verified characteristics)

`GET /Users/{userId}/Items?Recursive=true&IsPlayed=true&IncludeItemTypes=Movie,Episode&Fields=UserData&EnableImages=false`
(paged with `StartIndex`/`Limit`), one call sequence per user:

- Returns only played items for that user; item `Id` equals `library_items.rating_key`;
  episodes carry `SeriesId` equal to the show's `rating_key`. **Verified on production Emby.**
- `UserData.Played: true`; `PlayCount`/`LastPlayedDate` unreliable for historical plays
  (0 / null). Store them when present, never depend on them.
- `MinDateLastSaved` is **not** a trustworthy incremental cursor (`DateLastSaved` also moves
  on metadata refresh). A full sync is ~49 requests on the reference instance — always full
  sync, mirror-style (ADR 0010).
- **Jellyfin exposes the same endpoint shape** (shared API family; the repo already shares
  one `BaseMediaServerClient` between the two). **Inferred — unverified:** verified on Emby
  only; the build must confirm against a Jellyfin instance or a recorded fixture before
  enabling the Jellyfin path (a unit fixture in
  `services/mediaServer/__tests__/shared/jellyfinEmbyParserTests.ts` is the natural place).
- Plex has no equivalent without per-user tokens — out of scope, degrades per ADR 0011.

## 4. Data model (ADR 0010)

### 4.1 `played_states` — per-user played mirror

One row per (server account, played item). Full-mirror semantics like `media_requests`
(ADR 0004): every sync run upserts and stamps `synced_at`, then prunes stale rows for the
users it successfully synced. Idempotent and replayable by construction.

| Column                      | Type                                                   | Notes                                                                                        |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `id`                        | uuid PK default random                                 |                                                                                              |
| `server_id`                 | uuid NOT NULL, FK `servers(id)` ON DELETE CASCADE      | denormalized for the analytics join                                                          |
| `server_user_id`            | uuid NOT NULL, FK `server_users(id)` ON DELETE CASCADE | the account that played it                                                                   |
| `rating_key`                | varchar(255) NOT NULL                                  | Emby/Jellyfin item `Id` = `library_items.rating_key`                                         |
| `media_type`                | varchar(20) NOT NULL                                   | `'movie'` \| `'episode'` (only types synced)                                                 |
| `series_rating_key`         | varchar(255) NULL                                      | Emby `SeriesId` for episodes; enables show roll-up without touching `library_items` children |
| `played_at`                 | timestamptz NULL                                       | from `LastPlayedDate`; null for historical plays — display-only, never filtered on           |
| `play_count`                | integer NULL                                           | from `PlayCount`; 0/null for historical — display-only                                       |
| `synced_at`                 | timestamptz NOT NULL                                   | run-start stamp; drives the prune                                                            |
| `created_at` / `updated_at` | timestamptz NOT NULL default now()                     | repo convention                                                                              |

Indexes:

- `played_states_user_rating_unique` UNIQUE (`server_user_id`, `rating_key`) — the upsert
  conflict target (`server_user_id` implies `server_id`, so this is globally unique).
- `played_states_server_rating_idx` (`server_id`, `rating_key`) — movie/any-user EXISTS join.
- `played_states_server_series_idx` (`server_id`, `series_rating_key`) partial
  `WHERE series_rating_key IS NOT NULL` — show roll-up EXISTS join.
- `played_states_user_synced_idx` (`server_user_id`, `synced_at`) — per-user prune.

Sizing: 18,381 rows today (counted), growth bounded by (users × library size). All joins are
index-backed EXISTS probes; no materialized "watched by anyone" roll-up is stored — at this
scale a derived column is pure invalidation liability (ADR 0010, option 2).

Relationship notes:

- **No FK to `library_items`** — that table churns on every library sync (same reasoning as
  ADR 0003). The join happens at query time on (`server_id`, `rating_key`).
- **Users disappearing:** rows cascade only when the `server_users` row is deleted. A user
  removed on the media server keeps `server_users.removed_at` set and keeps their played
  rows — their historical plays legitimately keep items out of never-watched. Users the sync
  cannot resolve to a `server_users` row are skipped and counted (`usersSkipped` in logs);
  the existing user sync creates the row and the next played sync picks them up.
- **Items disappearing:** an item removed from the server stops appearing in the IsPlayed
  response and is pruned on the next successful sync of each user (prune scope: per
  successfully-synced user, `synced_at < runStart`). A failed user fetch never prunes that
  user's rows.

### 4.2 `played_state_sync_status` — one row per server (coverage + last run)

Persisted in Postgres (not Redis) because ADR 0011's honesty guarantee depends on coverage
surviving restarts and cache flushes.

| Column           | Type                                        | Notes                                                  |
| ---------------- | ------------------------------------------- | ------------------------------------------------------ |
| `server_id`      | uuid PK, FK `servers(id)` ON DELETE CASCADE | one row per server                                     |
| `status`         | varchar(20) NOT NULL                        | `'running'` \| `'success'` \| `'partial'` \| `'error'` |
| `started_at`     | timestamptz NOT NULL                        | current/last run start                                 |
| `completed_at`   | timestamptz NULL                            | null while running                                     |
| `users_total`    | integer NOT NULL default 0                  |                                                        |
| `users_synced`   | integer NOT NULL default 0                  | successfully synced this run                           |
| `items_upserted` | integer NOT NULL default 0                  |                                                        |
| `items_pruned`   | integer NOT NULL default 0                  |                                                        |
| `error`          | text NULL                                   | last error message (partial/error runs)                |
| `updated_at`     | timestamptz NOT NULL default now()          |                                                        |

"Coverage exists" for a server = a row with `status IN ('success','partial')` and
`completed_at IS NOT NULL`. `lastSyncedAt` in the API = `completed_at` of that row.

## 5. Analytics query changes

### 5.1 The shared predicate

An item is **watched** if EITHER a qualifying session exists (unchanged, `duration_ms >=
120000`, show roll-up via child episodes) OR any user's played flag covers it:

```sql
EXISTS (
  SELECT 1 FROM played_states ps
  WHERE ps.server_id = li.server_id
    AND (
      (li.media_type = 'movie' AND ps.rating_key = li.rating_key)
      OR (li.media_type = 'show' AND ps.series_rating_key = li.rating_key)
    )
)
```

The show branch uses `series_rating_key` directly — no child-episode subquery, because every
Emby/Jellyfin episode row carries `SeriesId` (verified for Emby; Jellyfin per §3). Plex
servers simply have zero `played_states` rows, so the predicate is a no-op there — honest
degradation, not silent claims.

### 5.2 `neverWatched.ts` and `stale.ts`

- **`neverWatched.ts`:** add `AND NOT EXISTS (…played predicate…)` to the
  `never_watched_items` CTE, alongside the existing session `NOT EXISTS`. Everything else
  (buckets, roll-ups, response shape except §7's coverage field) is unchanged.
- **`stale.ts`:** surgical rule — a row whose `last_watched IS NULL` (no qualifying session)
  but which matches the played predicate is **excluded from the endpoint entirely**: it is
  provably watched (so not `never_watched`) but undatable (so not honestly `stale`, whose
  `daysStale` is computed from `last_watched`). Implementation: add the exclusion to the
  `stale_items` CTE filter (`WHERE NOT (last_watched IS NULL AND <played predicate>)`), which
  automatically keeps `summary_stats`, `pagination.total`, and the page rows consistent
  because they all read the same CTE. **Both query paths must be patched:** the main
  combined query AND the duplicated empty-page summary query (lines ~668–705). The
  `category` enum and `StaleItem` wire shape are untouched. Other categories
  (`stale`) behave exactly as before — items with dated sessions are unaffected.
- Once increment 2 (Playback Reporting ingest) lands, many of those excluded items acquire
  real dated sessions and reappear under `stale` with correct `daysStale` — the two
  increments compose without further query changes.

### 5.3 Caching / invalidation

- Cache keys and TTLs are unchanged (`buildLibraryCacheKey` over
  `REDIS_KEYS.LIBRARY_NEVER_WATCHED` / `REDIS_KEYS.LIBRARY_STALE`, TTL 3600s).
- **New invalidation trigger:** on played-state sync completion (success or partial), the
  queue worker deletes `${REDIS_KEYS.LIBRARY_STALE}*` and
  `${REDIS_KEYS.LIBRARY_NEVER_WATCHED}*` patterns — export
  `invalidatePlayedStateCaches(redis, serverId)` from `playedStateSyncQueue.ts`, mirroring
  `invalidateLibraryCaches` in `librarySyncQueue.ts` so the pattern list is unit-testable.
- Existing triggers keep working: library sync completion already clears both keys.
- The coverage object (§7) is embedded in the cached payloads; a sync completion changes
  coverage AND data, and the same invalidation covers both.

### 5.4 Other routes with the same session-only assumption (flagged, out of scope)

Counted by `grep 120000` over `apps/server/src` (2026-07-29): `routes/library/watch.ts`,
`routes/library/roi.ts`, `routes/library/patterns.ts`, `routes/stats/queries.ts`,
`routes/stats/requesters.ts`, `services/dashboardStats.ts` (plus poller/import internals
where the threshold is definitional, not an assumption). These compute watch _counts,
durations, and dates_, which played state cannot supply — extending them is meaningless
until a dated source (increment 2) exists. They keep their current semantics; reviewers
should not treat their unchanged behavior as a defect.

## 6. Sync job

### 6.1 Placement

- `apps/server/src/services/playedStateSync.ts` — `PlayedStateSyncService.syncServer(serverId, onProgress)`,
  sibling of `librarySync.ts`, same structural conventions (progress callback, batch
  constants, Redis injection not needed — state lives in Postgres).
- `apps/server/src/jobs/playedStateSyncQueue.ts` — BullMQ queue `played-state-sync`,
  mirroring `librarySyncQueue.ts` (init/start/schedule/enqueue/status/shutdown functions,
  `activeSyncs` per-server guard, worker `concurrency: 1`, `attempts: 3` exponential
  backoff from 60s).

### 6.2 Per-run algorithm (per server)

1. Load server; if `type === 'plex'`, return immediately (capability-unsupported, no status
   row written — coverage stays honest).
2. Upsert `played_state_sync_status` row: `status='running'`, `started_at=runStart`.
3. `client.getUsers()`; resolve each to `server_users` by (`server_id`, `external_id`).
   Unresolvable users are skipped and counted.
4. Per resolved user, sequentially:
   - Page `getPlayedItems(userExternalId, { offset, limit: 5000 })` until exhausted
     (bounds payload size; 18k rows total today means most users are one page).
   - Upsert in batches of 500 on conflict (`server_user_id`, `rating_key`) setting
     `media_type`, `series_rating_key`, `played_at`, `play_count`, `synced_at=runStart`,
     `updated_at=now()`.
   - On success: `DELETE FROM played_states WHERE server_user_id = ? AND synced_at < runStart`
     (per-user prune — removed items and un-marked plays disappear).
   - On failure: log, increment failed-user count, **no prune for that user**, continue.
   - Delay 150 ms between users (matches `BATCH_DELAY_MS` posture in `librarySync.ts`);
     HTTP timeouts via the shared `fetchJson` service config.
5. Finalize status row: `success` (all users), `partial` (some users failed — `error` holds
   the last failure), or `error` (server-level failure, e.g. unreachable). Stamp
   `completed_at`, counters.
6. Worker then invalidates caches (§5.3) and publishes the final progress event.

Failure semantics: BullMQ retries rerun the whole server; the mirror upsert + per-user prune
make replays safe. A run that dies mid-way leaves `status='running'`; the next run's step 2
overwrites it (single row per server — no zombie accumulation). Stale `running` older than
the schedule interval is displayed as such by the status endpoint; no separate reaper needed.

### 6.3 Scheduling, triggers, locking

- **Schedule:** every 12 h per capable server, staggered at minute `(40 + i*4) % 60`
  (library sync uses `(10 + i*4) % 60` — offsets avoid firing together on small fleets).
  Boot sync with 10 s × index stagger, skipping servers with pending jobs (same pattern as
  `scheduleAutoSync`).
- **Manual trigger:** `POST /api/v1/library/played-state/sync` (§7) →
  `enqueuePlayedStateSync(serverId?, userId?)`; rejects when a run for that server is
  already active (same rule as `enqueueLibrarySync`).
- **Locking:** per-server `activeSyncs` map + BullMQ job-id dedup, exactly like library
  sync. The job does **not** acquire `heavyOpsLock` — that lock serializes heavy
  TimescaleDB import/maintenance work; this job writes ≤ tens of thousands of small rows to
  a plain table and, like library sync's item upserts, can safely run alongside a heavy op
  (library sync itself only consults `getHeavyOpsStatus()` to skip _snapshot_ work, which
  this job does not do).
- **Rate/timeout posture against live Emby:** sequential per-user requests, 150 ms
  inter-user delay, 5,000-item pages, shared HTTP timeout — worst case on the reference
  instance ≈ 49 requests over well under a minute; an unreachable server fails fast to
  `error` and retries on backoff.

### 6.4 Client interface addition

`apps/server/src/services/mediaServer/types.ts` (server-internal, not the shared package):

```ts
/** One played item for one user, from /Users/{id}/Items?IsPlayed=true */
export interface MediaPlayedItem {
  ratingKey: string;                 // Emby/Jellyfin item Id
  mediaType: 'movie' | 'episode';
  seriesRatingKey?: string;          // Emby SeriesId (episodes)
  playedAt?: Date;                   // UserData.LastPlayedDate when present
  playCount?: number;                // UserData.PlayCount when present
}

// On IMediaServerClient (optional method, like getLibraryLeaves):
getPlayedItems?(
  userExternalId: string,
  options?: { offset?: number; limit?: number }
): Promise<{ items: MediaPlayedItem[]; totalCount: number }>;
```

Implemented once in `BaseMediaServerClient` (Emby + Jellyfin inherit); `PlexClient` does not
implement it. Capability derivation in service code: `server.type !== 'plex'` (v1 rule;
revisit if a Plex path ever exists).

## 7. API contract + settings surface — **FROZEN BUILD BOUNDARY**

Backend and frontend build against this in parallel. Every identifier below is final;
no renaming, no "corresponding fields" left to inference. All shared-package changes are
authored by the backend-engineer as the contract's single writer, in one commit, before
frontend consumption.

### 7.1 New endpoints (Fastify, under the existing library plugin prefix `/api/v1/library`)

| Method + path                             | Auth                                                                                                                 | Request                              | Response                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/library/played-state/status` | `app.authenticate` (any logged-in role; server list filtered by `resolveServerIds` access like other library routes) | —                                    | `PlayedStateSyncStatusResponse`                                                                              |
| `POST /api/v1/library/played-state/sync`  | owner/admin only                                                                                                     | body: `playedStateSyncTriggerSchema` | `202` with `PlayedStateSyncTriggerResponse`; `409` when already running; `400` for a Plex/unknown `serverId` |

Errors follow the repo's existing `reply.badRequest` / sensible-style envelope.

### 7.2 New types (`packages/shared/src/types.ts`)

```ts
export type PlayedStateCapability = 'supported' | 'unsupported';

export interface PlayedStateServerCoverage {
  serverId: string;
  serverName: string;
  capability: PlayedStateCapability;
  /** ISO-8601 completion time of the last successful/partial sync; null = never synced */
  lastSyncedAt: string | null;
}

export interface PlayedStateCoverage {
  servers: PlayedStateServerCoverage[];
  /** true only when EVERY server in the response scope is supported AND has synced */
  full: boolean;
}

export type PlayedStateSyncRunStatus = 'never_run' | 'running' | 'success' | 'partial' | 'error';

export interface PlayedStateServerSyncStatus {
  serverId: string;
  serverName: string;
  capability: PlayedStateCapability;
  status: PlayedStateSyncRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  usersTotal: number;
  usersSynced: number;
  itemsUpserted: number;
  itemsPruned: number;
  error: string | null;
}

export interface PlayedStateSyncStatusResponse {
  servers: PlayedStateServerSyncStatus[];
}

export interface PlayedStateSyncTriggerResponse {
  jobId: string;
}

export interface PlayedStateSyncProgress {
  serverId: string;
  serverName: string;
  status: 'running' | 'complete' | 'error';
  totalUsers: number;
  processedUsers: number;
  itemsProcessed: number;
  message: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}
```

### 7.3 Modified types (`packages/shared/src/types.ts`)

- `NeverWatchedStatsResponse` gains **`playedStateCoverage?: PlayedStateCoverage;`**
- `StaleResponse` gains **`playedStateCoverage?: PlayedStateCoverage;`**

Optional (`?`) deliberately: Redis holds cached pre-deploy payloads for up to 1 h after
rollout; the web UI treats a missing field as "coverage unknown — show no banner" and the
field becomes ubiquitous after one TTL. Note: `stale.ts` re-declares its response interfaces
locally (file comment at its line 33) — the backend-engineer must add the field in BOTH the
shared type and the route-local `StaleResponse` mirror.

### 7.4 New zod schema (`packages/shared/src/schemas.ts`)

```ts
export const playedStateSyncTriggerSchema = z.object({
  /** Omit to sync every capable server */
  serverId: z.uuid().optional(),
});
export type PlayedStateSyncTriggerInput = z.infer<typeof playedStateSyncTriggerSchema>;
```

### 7.5 New constants + mirror-map entries

- `packages/shared/src/constants.ts` — `WS_EVENTS` gains:
  `PLAYED_STATE_SYNC_PROGRESS: 'played-state:sync:progress',`
- `packages/shared/src/types.ts` — `ServerToClientEvents` gains the paired entry:
  `'played-state:sync:progress': (progress: PlayedStateSyncProgress) => void;`
- `packages/shared/src/types.ts` — `RunningTaskType` union gains member **`'played_state_sync'`**.
- Server-side mirror consumer: `apps/server/src/routes/tasks.ts` must map the
  `played-state-sync` queue into `RunningTask` rows with `type: 'played_state_sync'`
  (it is the only file mapping queue → `RunningTaskType`, counted by grep for `'ombi_sync'`).
- No new `REDIS_KEYS` or `CACHE_TTL` entries — invalidation reuses `LIBRARY_STALE` /
  `LIBRARY_NEVER_WATCHED`; the BullMQ queue name stays a module-local constant like
  `librarySyncQueue.ts`'s `QUEUE_NAME`.

### 7.6 Settings surface

- **Increment 1: none.** Played-state sync is always-on for capable servers (it corrects
  wrong data; there is nothing to opt into) with the fixed 12 h schedule + manual trigger.
- **Increment 2 (deferred):** settings key **`playbackReportingEnabled`** (boolean, default
  `false`) in the existing `settings` key-value table, following the `ombiUrl`/`seerrUrl`
  convention of connector opt-ins. Its endpoints/types are specified in ADR 0012 and frozen
  when increment 2 is planned — not part of this build boundary.

### 7.7 Web UI needs (served entirely by the above)

- Never Watched page + Stale table: read `playedStateCoverage` from the responses they
  already fetch; when `full === false` (or field present with a gap), render one page-level
  banner naming the uncovered servers (ADR 0011); when coverage is absent/`full`, no banner.
  UI copy rule: with any uncovered server in scope, the page heading/empty-state language
  uses "No recorded plays" instead of "Never watched".
- Settings/Tasks surface: `GET /played-state/status` for the per-server status card
  (last run, counts, error), `POST /played-state/sync` for the "Sync now" button,
  `WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS` + `tasks:updated` for live progress.

## 8. Enumerated completeness check (contract freeze verification)

Every contract item, every artifact it touches, and its reachability through the barrel
(`packages/shared/src/index.ts` re-exports `types.js`, `schemas.js`, `constants.js`; the
package's `exports` field already serves the barrel — verified against the current file):

| #   | Contract item                                                  | types.ts        | schemas.ts                 | constants.ts                           | Mirror artifact                                                                                              | Barrel export to add                                                         |
| --- | -------------------------------------------------------------- | --------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | `PlayedStateCapability`                                        | new type        | —                          | —                                      | —                                                                                                            | `export type` block (Library statistics section)                             |
| 2   | `PlayedStateServerCoverage`                                    | new interface   | —                          | —                                      | —                                                                                                            | same                                                                         |
| 3   | `PlayedStateCoverage`                                          | new interface   | —                          | —                                      | consumed by items 12–13                                                                                      | same                                                                         |
| 4   | `PlayedStateSyncRunStatus`                                     | new type        | —                          | —                                      | —                                                                                                            | same                                                                         |
| 5   | `PlayedStateServerSyncStatus`                                  | new interface   | —                          | —                                      | —                                                                                                            | same                                                                         |
| 6   | `PlayedStateSyncStatusResponse`                                | new interface   | —                          | —                                      | —                                                                                                            | same                                                                         |
| 7   | `PlayedStateSyncTriggerResponse`                               | new interface   | —                          | —                                      | —                                                                                                            | same                                                                         |
| 8   | `PlayedStateSyncProgress`                                      | new interface   | —                          | —                                      | **`ServerToClientEvents['played-state:sync:progress']`** (types.ts)                                          | same                                                                         |
| 9   | `WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS`                         | —               | —                          | new key `'played-state:sync:progress'` | must equal the `ServerToClientEvents` key string exactly                                                     | already covered (`WS_EVENTS` is barrel-exported)                             |
| 10  | `RunningTaskType` member `'played_state_sync'`                 | union extension | —                          | —                                      | `apps/server/src/routes/tasks.ts` queue→type mapping                                                         | already covered (`RunningTaskType` barrel-exported)                          |
| 11  | `playedStateSyncTriggerSchema` + `PlayedStateSyncTriggerInput` | —               | new schema + inferred type | —                                      | —                                                                                                            | schema in the schema-export block; input type in the schema-input-type block |
| 12  | `NeverWatchedStatsResponse.playedStateCoverage?`               | field addition  | —                          | —                                      | —                                                                                                            | already exported                                                             |
| 13  | `StaleResponse.playedStateCoverage?`                           | field addition  | —                          | —                                      | **route-local `StaleResponse` mirror in `apps/server/src/routes/library/stale.ts`** must gain the same field | already exported                                                             |
| 14  | Route `GET /api/v1/library/played-state/status`                | uses 6          | —                          | —                                      | registered in the library routes plugin index                                                                | n/a (server)                                                                 |
| 15  | Route `POST /api/v1/library/played-state/sync`                 | uses 7          | uses 11                    | —                                      | same plugin index                                                                                            | n/a (server)                                                                 |

Verification rule for the implementer: after editing, confirm each of items 1–13 resolves
via `import { X } from '@tracearr/shared'` exactly as a consumer would — an artifact not in
`index.ts` is **not frozen**. Items 9+8 share one literal string; a drift typechecks clean
in `WS_EVENTS` (plain string) and fails only at runtime — copy the key from the
`ServerToClientEvents` entry, never retype it.

## 9. Migration outline (data-engineer owns the DDL)

- **Migration number 0071** (highest existing is 0070 — counted from
  `apps/server/src/db/migrations/`). Drizzle with cumulative snapshots:
  add both tables to `apps/server/src/db/schema.ts` (data-engineer authors the schema.ts
  table definitions AND the migration; backend-engineer consumes them — one writer),
  then `drizzle-kit generate --config=drizzle.config.cjs`; hand-written SQL with a
  `.down.sql` companion is the precedent for special cases (0068–0070) but plain generate
  should suffice here — two new plain tables, no Timescale involvement, no backfill.
- Target schema: §4.1 and §4.2 exactly (names, types, nullability, FKs, the four
  `played_states` indexes, the `played_state_sync_status` PK).
- No data backfill: the first sync run populates everything.
- Rollback: drop both tables (safe — mirror data, reproducible from source servers).

## 10. NFRs / failure modes

- **Correctness:** the 472 false never-watched items disappear after the first successful
  sync; Plex-only instances see zero behavior change plus an honest banner.
- **Performance:** never-watched query gains two indexed EXISTS probes over an 18k-row
  table — negligible against the existing sessions NOT EXISTS. Sync run: ≤ ~1 min network,
  ≤ ~40 upsert batches. No new steady-state load between runs.
- **Idempotency/replay:** mirror upsert + run-stamped prune; any run can be repeated.
- **Partial failure:** per-user isolation; prune only follows a user's own successful fetch;
  status row reports `partial` with counts, surfaced verbatim in the status endpoint.
- **Concurrency:** per-server BullMQ guard; no cross-job lock needed (§6.3).
- **Observability:** progress WS event, running-tasks entry, status endpoint, structured
  `[PlayedStateSync]` logs mirroring `[LibrarySync]` conventions.

## 11. Playback Reporting ingest (increment 2 — designed, deferred; ADR 0012)

Summarized here for the seam; full rationale in ADR 0012.

- **Opt-in:** settings key `playbackReportingEnabled` (default false). The played-state sync
  has zero dependency on the plugin; the ingest has zero dependency on `played_states`.
- **Source:** `POST {embyUrl}/user_usage_stats/submit_custom_query` (plugin endpoint; 404 =
  "plugin not installed", surfaced honestly on the settings card). New `EmbyClient` method,
  Emby-only (client method does not exist in the repo today — counted: zero grep hits for
  `user_usage_stats`).
- **Rows → sessions:** one `sessions` row per PlaybackActivity row: `serverUserId` resolved
  via `server_users.external_id = UserId`; `ratingKey = ItemId`; `startedAt = DateCreated`;
  `durationMs = PlayDuration * 1000`; `state = 'stopped'`;
  `externalSessionId = 'pbrep:' + rowid`. `sessions.ip_address` is NOT NULL — rows carry no
  IP; follow the import precedent for a sentinel value (backend decision within
  `services/import/` conventions, flagged explicitly).
- **No double counting — two dedup tiers**, reusing `services/import/deduplication.ts`:
  1. exact `externalSessionId` (`pbrep:{rowid}`) — re-run idempotency;
  2. time-key fallback: skip when any existing session (any source, including
     Tracearr-polled) matches (`serverId`, `serverUserId`, `ratingKey`) with `startedAt`
     within ±120 s (`sessions_dedup_fallback_idx` supports this — the Tautulli-import
     precedent).
- **Cursor:** stateless and self-healing — next run ingests rows with
  `DateCreated > (SELECT max(started_at) FROM sessions WHERE server_id = ? AND external_session_id LIKE 'pbrep:%') - 1 day`;
  dedup absorbs the overlap margin. No Redis cursor to drift.
- **Job:** separate BullMQ queue `playback-reporting-ingest`, scheduled 6-hourly when
  enabled; the initial historical run acquires `heavyOpsLock` as jobType `'import'`
  (it is an import in all but delivery mechanism); incremental runs are light.
- **Effect on analytics:** ingested sessions flow through every existing session-based
  metric (stale dating, watch counts, ROI, patterns) with no further query changes.

## 12. Decision log

- ADR 0010 — Per-user played-state mirror table with query-time OR-extension of the
  never-watched predicate.
- ADR 0011 — "No data" is represented as server-level coverage in the response plus a
  page-level banner, not a per-item state.
- ADR 0012 — Playback Reporting ingest as a decoupled, opt-in second session source
  (accepted design, deferred build).
