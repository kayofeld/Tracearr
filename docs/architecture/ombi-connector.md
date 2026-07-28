# Ombi Connector — Design

**Status:** Design accepted for build (feat/ombi-connector) — no implementation yet.
**Author:** software-architect, 2026-07-28.
**Companion docs:** [ombi-api-contract.md](./ombi-api-contract.md), ADRs [0002](./adr/0002-ombi-username-matching-with-manual-override.md), [0003](./adr/0003-ombi-query-time-external-id-join.md), [0004](./adr/0004-ombi-full-mirror-resync.md), [0005](./adr/0005-ombi-api-key-plaintext-settings.md).

## 1. Goal and scope

Sync media requests from an Ombi instance so Tracearr can show **who requested which media**
(attribution on the Never Watched page) and **per-requester statistics** (request volume,
never-watched requests, wasted storage per requester).

Strictly optional: the feature is a no-op until the owner configures an Ombi URL + API key.
No new env vars, no migration side effects visible to non-users beyond two empty tables, no
health-check or log noise when unconfigured.

Out of scope (deliberately, proportionality): request management (approve/deny from Tracearr),
webhooks/push from Ombi, multi-Ombi-instance support, request deletion sync-back, Overseerr/
Jellyseerr support (the schema is named `ombi_*`; a future connector would be a sibling, not a
generalization — see §10).

### Verified inputs this design relies on (ground truth from the coordinator's live probe — do not re-probe)

- Ombi 4.47.1 at `https://ombi.draner.pet` / `http://localhost:5420`, auth header `ApiKey: <key>`.
- `GET /api/v1/Request/movie`: **658** records (counted), ~1.5 MB, **unpaged** (paged variants 404).
- `GET /api/v1/Request/tv`: **274** parent records (counted), ~3.4 MB, each with `childRequests[]`
  (child = one user's request for a season batch). Exact child count not probed; ≥274, total
  attributable rows estimated **~950–1,100** (658 movies + ~300–450 children).
- `GET /api/v1/Identity/Users`: 33 distinct requesters among 60 identities; **all** Ombi local
  accounts (`userType=1`), `providerUserId` empty on all, email empty on 32/33.
- Matchability (measured): movies **658/658** carry `theMovieDbId` and/or `imdbId`; series
  **271/274** carry `tvDbId` and/or `imdbId`. Case-insensitive username match resolves **30/33**
  requesters against both `server_users.username` and `users.username`; unmatched: `Azel`,
  `Neopier`, `Tiwoof`.
- `requestedDate` is ISO-8601 UTC with 7 fractional digits — parse explicitly, store `timestamptz`.

## 2. Component view

```
                         ┌────────────────────────────────────────────┐
                         │ apps/server                                │
 Ombi 4.x  ◄──HTTP───────┤  services/ombi.ts        (OmbiClient)      │
 (ApiKey header)         │  jobs/ombiSyncQueue.ts   (BullMQ, 6h)      │
                         │  services/ombi/resolveRequesters.ts        │
                         │  routes/ombi.ts          (config/sync/map) │
                         │  routes/stats/requesters.ts (stats)        │
                         │  routes/library/stale.ts (+attribution)    │
                         └───────┬───────────────────────┬────────────┘
                                 │                       │
                        Postgres │              Redis    │  WS (pubsub)
                    ombi_requests│         cache + job   │  OMBI_SYNC_PROGRESS
                ombi_user_mappings         queue         │
                   settings (kv) │                       │
```

New modules (paths follow existing layout; engineers implement, this doc specifies):

| Module                                               | Responsibility                                                                                                                                                     | Model/precedent                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `apps/server/src/services/ombi.ts`                   | Outbound Ombi client: ctor(url, apiKey), 30s `AbortController` timeout, 3 retries linear backoff, Zod-validated responses, `testConnection()`                      | `services/tautulli.ts:337-424`, `utils/http.ts` (`fetchJson`, `HttpClientError`) |
| `apps/server/src/services/ombi/resolveRequesters.ts` | Requester → Tracearr user resolution (manual map → providerUserId → username; §6)                                                                                  | `services/import/userMapping.ts`                                                 |
| `apps/server/src/jobs/ombiSyncQueue.ts`              | Repeatable + manual sync job; progress via `job.updateProgress` + pubsub; cache invalidation; enqueue guard                                                        | `jobs/librarySyncQueue.ts` (attempts 3, exp 60s backoff, removeOnComplete)       |
| `apps/server/src/routes/ombi.ts`                     | Owner-gated config/test/sync/status/mapping endpoints                                                                                                              | `routes/settings.ts:41` (`app.requireOwner`)                                     |
| `apps/server/src/routes/stats/requesters.ts`         | Authenticated requester-stats endpoint                                                                                                                             | `routes/stats/users.ts`                                                          |
| `db/schema.ts` additions                             | `ombi_requests`, `ombi_user_mappings` (§4) — migration authored by data-engineer per Drizzle flow                                                                  | `pnpm --filter @tracearr/server db:generate`                                     |
| `packages/shared/src/constants.ts` / `types.ts`      | `WS_EVENTS.OMBI_SYNC_PROGRESS`, `REDIS_KEYS.OMBI_*`, `CACHE_TTL.OMBI_REQUESTER_STATS`, `RunningTaskType` += `'ombi_sync'` (types.ts:1819), new response interfaces | existing constants blocks                                                        |

Wiring: `index.ts` registers the queue inside the existing non-throwing try/catch for
non-critical subsystems (~l.784-798) plus shutdown hooks. If the feature is unconfigured at
boot, the repeatable job is not scheduled at all (cheapest possible no-op).

## 3. Configuration and lifecycle

**Enablement = settings, not env** (repo convention: `db/schema.ts:734` settings kv table;
precedents `mobileEnabled`, `tailscaleEnabled`; Tautulli gates purely on `url && apiKey`).

New keys in `PUBLIC_DEFAULTS` (`services/settings.ts:14-45`), both defaulting to `null`:

| Key          | Type             | Meaning                                                                                                                            |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ombiUrl`    | `string \| null` | Base URL, e.g. `http://localhost:5420`                                                                                             |
| `ombiApiKey` | `string \| null` | Ombi API key (plaintext per repo convention — ADR 0005; **must** be redacted in all logs, model `jobs/telegramCommandListener.ts`) |

Plus one **internal** key (in `INTERNAL_DEFAULTS`, `services/settings.ts:51` — never in the
public Settings object): `ombiSyncStatus: jsonb | null` — last run/success timestamps, last
error, row counts, attribution coverage. Read by `GET /ombi/status`; written only by the sync
job. Persisting in settings (not Redis) survives restarts, mirroring how backup schedule state
is settings-driven (`index.ts:822`).

Typed getter `getOmbiSettings()` modeled on `getNotificationSettings()` (`services/settings.ts:201`).
"Configured" is derived: `ombiUrl != null && ombiApiKey != null`. No separate enabled flag —
matches the Tautulli precedent exactly.

Sync cadence: fixed **every 6 hours** (repeatable BullMQ job) + manual trigger. Not settings-
driven in v1 — requests change slowly and the sync is cheap (§5); a cadence setting is
speculative complexity. Revisit only if asked.

**Lifecycle transitions:**

| Event                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unconfigured (fresh install)             | No repeatable job scheduled; routes return `configured: false` / 400 on sync trigger; zero log output; stale/never-watched behave exactly as v1.7.0                                                                                                                                                                                                                           |
| Configured (settings PUT with both keys) | Settings route hook schedules the repeatable job and enqueues one immediate sync                                                                                                                                                                                                                                                                                              |
| Credentials removed/cleared              | Repeatable job unscheduled (same hook); **data retained** in `ombi_requests`/`ombi_user_mappings` (reconnection keeps history); attribution joins and stats endpoints gate on `configured` and stop surfacing the data — retained but invisible. A purge endpoint (`DELETE /ombi/data`) is available once disconnected - owner decision 2026-07-28, see the API contract §5.4 |
| Ombi unreachable                         | Job fails after 3 attempts (exp backoff 60s); `ombiSyncStatus.lastError` recorded; one structured warn per run, no error spam, no health-check impact; previous synced data remains served                                                                                                                                                                                    |
| Tracearr user deleted                    | `ombi_requests.user_id` FK `ON DELETE SET NULL` — rows fall back to unattributed but keep raw Ombi identity; next sync may re-resolve                                                                                                                                                                                                                                         |

SSRF: `assertSafeProbeUrl()` from `utils/ssrf.ts` before the first request of every client
instantiation (it intentionally allows RFC1918/loopback — required for `localhost:5420`).

## 4. Data model

Two tables. Exact Drizzle definitions are the data-engineer's to author; this is the normative
schema. All timestamps `timestamptz`.

### 4.1 `ombi_requests` — mirrored request units

One row per **attributable request unit**: a movie request, or a TV **child request** (Ombi's
per-user, per-season-batch unit under a parent series). Volume today ~950–1,100 rows
(estimated, §1); growth a few hundred/year. This is a **mirror** of Ombi (full resync +
prune, ADR 0004), not an event log.

| Column                      | Type                                        | Null | Rationale                                                                                                                                                                            |
| --------------------------- | ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                        | `uuid` PK `defaultRandom()`                 | no   | Repo convention for PKs                                                                                                                                                              |
| `ombi_request_id`           | `integer`                                   | no   | Ombi's id — movie request id or TV _child_ id. Movie and child ids are independent sequences, hence composite uniqueness below                                                       |
| `ombi_parent_request_id`    | `integer`                                   | yes  | TV parent id; null for movies. Groups children of one series for display                                                                                                             |
| `media_type`                | `varchar(10)`                               | no   | `'movie' \| 'tv'`. Part of the upsert key                                                                                                                                            |
| `title`                     | `varchar(500)`                              | no   | Denormalized from Ombi so unmatched/removed media still renders (never lose a request row to a failed library match)                                                                 |
| `release_year`              | `integer`                                   | yes  | Movies: from `releaseDate`; TV children: `releaseYear`. Display only                                                                                                                 |
| `imdb_id`                   | `varchar(20)`                               | yes  | External ids for **query-time** join to `library_items` (ADR 0003). Same formats as `library_items` (`schema.ts:990-992`)                                                            |
| `tmdb_id`                   | `integer`                                   | yes  | Movies: `theMovieDbId`                                                                                                                                                               |
| `tvdb_id`                   | `integer`                                   | yes  | TV: parent `tvDbId` copied onto each child row                                                                                                                                       |
| `seasons`                   | `jsonb`                                     | yes  | TV: `number[]` of requested season numbers from `seasonRequests[]`; null for movies. Display only, never queried relationally — jsonb is proportionate                               |
| `is_4k`                     | `boolean` default false                     | no   | Movies: `is4kRequest`; false for TV                                                                                                                                                  |
| `status`                    | `varchar(20)`                               | no   | Derived at sync: `'available'` if `available`, else `'denied'` if `denied`, else `'approved'` if `approved`, else `'pending'`. Single derived enum beats mirroring four booleans     |
| `requested_at`              | `timestamptz`                               | no   | `requestedDate`, parsed explicitly as UTC (7-digit fractional ISO — pass through `new Date()` is fine, but the Zod schema must `z.coerce.date()` / explicit parse, not string-store) |
| `available_at`              | `timestamptz`                               | yes  | `markedAsAvailable` when present                                                                                                                                                     |
| `ombi_user_id`              | `varchar(64)`                               | no   | Ombi GUID of the requester — the stable raw identity; unmatched requests are never lost                                                                                              |
| `ombi_username`             | `varchar(255)`                              | no   | Raw Ombi `userName` (matching input + fallback display)                                                                                                                              |
| `ombi_alias`                | `varchar(255)`                              | yes  | Ombi `alias` (preferred fallback display name). **No email column — PII decision §7**                                                                                                |
| `user_id`                   | `uuid` FK → `users.id` `ON DELETE SET NULL` | yes  | Resolved Tracearr **identity** (`users.id`, not serverUser — consistent with stats aggregation, `routes/stats/users.ts`, `utils/representativeAccount.ts`). Null = unattributed      |
| `match_method`              | `varchar(20)`                               | yes  | `'manual' \| 'provider' \| 'username'`; null when unattributed. Observability + mapping UI                                                                                           |
| `synced_at`                 | `timestamptz`                               | no   | Set to the sync run's start timestamp on every upsert; drives prune (ADR 0004)                                                                                                       |
| `created_at` / `updated_at` | `timestamptz` default now                   | no   | Repo convention                                                                                                                                                                      |

Indexes:

| Index                                                                        | Why                                                                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `UNIQUE (media_type, ombi_request_id)`                                       | Idempotent upsert key (ADR 0004)                                                                               |
| `(user_id)`                                                                  | Requester-stats grouping                                                                                       |
| `(ombi_user_id)`                                                             | Re-resolution when a mapping changes; mapping UI counts                                                        |
| partial `(imdb_id) WHERE imdb_id IS NOT NULL`, same for `tmdb_id`, `tvdb_id` | Query-time join to `library_items` (mirrors `library_items`' own partial-index pattern, `schema.ts:1026-1033`) |
| `(requested_at)`                                                             | Stats date ranges / earliest-requester pick                                                                    |

At ~1k rows every index except the upsert key is a rounding error; they're specified for
correctness of access paths, not performance necessity.

**Retention:** rows live while mirrored in Ombi; pruned when Ombi deletes them (ADR 0004).
No independent retention policy — the table cannot outgrow Ombi itself.

### 4.2 `ombi_user_mappings` — manual overrides only

Holds **only owner-set overrides** (expected: ~3 rows today — the stragglers `Azel`,
`Neopier`, `Tiwoof` — plus future drift). Automatic matches are computed at sync time and
stored on the request rows; they need no mapping row. Precedent:
`services/import/userMapping.ts` (`createUserMapping`, `lookupUser`).

| Column                      | Type                                       | Null | Rationale                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ombi_user_id`              | `varchar(64)` PK                           | no   | One override per Ombi account                                                                                                                                                                           |
| `ombi_username`             | `varchar(255)`                             | no   | Snapshot for display in the mapping UI                                                                                                                                                                  |
| `user_id`                   | `uuid` FK → `users.id` `ON DELETE CASCADE` | yes  | Target identity. **`null` = "force unattributed"** (owner explicitly says: never attribute this Ombi account). Cascade: deleting the user deletes the override; next sync falls back to auto-resolution |
| `created_at` / `updated_at` | `timestamptz`                              | no   | Convention                                                                                                                                                                                              |

## 5. Sync strategy (ADR 0004: full-mirror resync)

**Full fetch + upsert + prune, every run.** Justification: both endpoints are unpaged anyway
(paged variants 404 — verified), total payload ~5 MB / ~1k rows, and Ombi offers no reliable
change feed. Incremental sync would add delta bookkeeping to save nothing.

Per run (BullMQ job, attempts 3, exponential 60s backoff, `removeOnComplete` — clone of
`librarySyncQueue.ts` shape):

1. Read `getOmbiSettings()`; if unconfigured, exit silently (guards the race between
   unschedule and an in-flight job).
2. `runStartedAt = now()`.
3. **Movies phase:** fetch `/api/v1/Request/movie`; Zod-validate per record (unknown fields
   passthrough). Invalid records are skipped with a warn + counter (never fail the run for
   one malformed row). Resolve requesters (§6). Upsert all rows in one transaction on
   `(media_type, ombi_request_id)`, setting `synced_at = runStartedAt`.
   **Prune** `DELETE FROM ombi_requests WHERE media_type='movie' AND synced_at < runStartedAt`
   in the same transaction — but **only if the fetch succeeded AND zero records failed
   validation** (a skipped-but-present record must not be pruned into flapping).
4. **TV phase:** same, over the flattened children of `/api/v1/Request/tv`
   (`media_type='tv'`, external ids copied from the parent). Independent transaction:
   a TV-phase failure leaves the completed movie phase intact (partial-sync semantics —
   the two phases are independently consistent; status reports which succeeded).
5. Write `ombiSyncStatus` (lastRunAt, lastSuccessAt per phase, counts, skipped, attribution
   coverage, lastError).
6. Invalidate caches: `LIBRARY_STALE` keys (they now embed attribution) and
   `OMBI_REQUESTER_STATS`. Same invalidation pattern as librarySyncQueue.
7. Progress: `job.updateProgress` + pubsub on `WS_EVENTS.OMBI_SYNC_PROGRESS`
   (`'ombi:sync:progress'`, matching `library:sync:progress` naming, `constants.ts:90`).

Idempotency: the upsert key makes re-runs and retries harmless; `synced_at` monotonicity makes
prune safe under retry (a retried run gets a fresh `runStartedAt`).

Manual trigger: `POST /ombi/sync` enqueues with the same dedup/enqueue guard as the library
sync's manual path (reject with 409 while a run is active). Surfaced in `GET /tasks/running`
via `RunningTaskType` `'ombi_sync'`.

Expected duration: seconds (two HTTP calls + ~1k upserts). No batching needed.

## 6. Matching

### 6.1 Media → library (query-time, ADR 0003)

No FK to `library_items.id`. Join **at query time** on external ids, precedence
imdb → tmdb → tvdb (same order as `services/library/buildExternalIdMatchKey.ts`):

```sql
LEFT JOIN library_items li ON li.media_type = <'movie'|'show'>
  AND (
    (r.imdb_id IS NOT NULL AND li.imdb_id = r.imdb_id)
    OR (r.tmdb_id IS NOT NULL AND li.tmdb_id = r.tmdb_id)
    OR (r.tvdb_id IS NOT NULL AND li.tvdb_id = r.tvdb_id)
  )
```

(Implementations may prefer a LATERAL pick-first for determinism when ids disagree; with
658/658 and 271/274 coverage measured, disagreement is edge-case, not the norm.)

Why not a FK: `library_items` rows are churned by library sync (delete/recreate); a hard FK
would orphan or cascade attribution on every re-sync and couple the Ombi mirror's lifecycle to
the library sync's. External ids are the stable identity of the _media_, which is what a
request refers to. Cost: a slightly heavier join — trivial at this scale. The 3/274 series
without any external id simply never match (they still appear in requester stats as
requested-but-unmatched; they can never appear on library views, which is correct — the
library row, if any, can't be identified).

Normalized-title fallback (the fourth COALESCE tier of `buildExternalIdMatchKey`) is
**deliberately not used** for attribution: a wrong attribution is worse than a missing one,
and measured id coverage is 99.7%.

### 6.2 Requester → Tracearr user (ADR 0002)

Measured reality: all 33 requesters are Ombi local accounts, `providerUserId` empty, no
usable email — there is **no strong id**. Resolution pipeline at sync time, first hit wins,
result written to `user_id` + `match_method`:

1. **Manual override** (`ombi_user_mappings` row): use its `user_id` (or force-unattribute if
   `user_id` is null). `match_method='manual'`.
2. **Provider id** (future-proofing, costs one condition): if Ombi `providerUserId` is
   non-empty (Plex-OAuth Ombi accounts, `userType=2`), match
   `server_users.plex_account_id = providerUserId` → that serverUser's `user_id`
   (`schema.ts:219`). `match_method='provider'`. Matches zero rows today; makes the design
   correct for standard Ombi+Plex setups.
3. **Case-insensitive username**: `lower(ombi_username) = lower(users.username)`.
   Matches 30/33 today (measured). If **multiple** users match (theoretically possible for
   `member`-role name collisions — `users_login_username_unique` is only enforced for
   owner/admin/viewer, `schema.ts:154-156`), treat as ambiguous → unattributed + flagged in
   the mapping UI, never guess. `match_method='username'`.
4. **Unattributed**: `user_id = null`, `match_method = null`. The raw Ombi identity stays on
   the row; these surface in `GET /ombi/mappings` for the owner to resolve, and aggregate
   into the explicit **unattributed bucket** in stats.

Resolution is recomputed on **every sync** (users appear/rename; a new Tracearr user can
claim previously-unattributed requests automatically). A mapping PUT/DELETE additionally
triggers immediate re-resolution of that `ombi_user_id`'s rows (single indexed UPDATE) +
cache invalidation, so the owner sees the effect without waiting for the next sync.

Aliases are **not** used for auto-matching (an alias is a free-text display name — e.g.
`requestedByAlias` — too weak an identity signal); they're shown in the mapping UI as a hint
and used as fallback display text.

## 7. PII decision

**Stored:** `ombi_user_id` (GUID), `ombi_username`, `ombi_alias`. **Not stored: email** —
concurring with the coordinator's pre-decision, on the evidence:

- Zero matching value here: 32/33 requesters have no email (measured); the one email adds
  nothing over username matching.
- Data minimization: usernames/aliases are already displayed throughout Tracearr; an email is
  a strictly higher-sensitivity identifier duplicated from a system (Ombi) that remains its
  source of truth. Don't copy what you won't use.
- The plausible counter-argument — email matching for Plex-OAuth Ombi setups — is better
  served by the `providerUserId → plex_account_id` tier (§6.2 step 2), a stronger and less
  sensitive identifier. If a future setup genuinely needs email matching, do it
  **transiently in memory at sync time** without persisting the email; noted in ADR 0002 as
  the sanctioned escape hatch.

`lastLoggedIn` and `claims[]` from the Identity payload are likewise not stored (no use case).

Deletion semantics: user deleted → `SET NULL` (history survives, unattributed); Ombi request
deleted → pruned next sync; owner wants full erasure of Ombi data → clear credentials +
the purge endpoint (`DELETE /ombi/data`, available once disconnected), or truncate via DB — acceptable for a single-owner homelab tool,
documented rather than automated.

## 8. Surfacing on existing views (additive-only)

The Never Watched page consumes `GET /library/never-watched` (aggregates) and
`GET /library/stale?category=never_watched` (item list). v1.7.0 shapes are frozen —
**additive only**:

- `GET /library/stale` items gain one **new optional field** `requestedBy` (nullable object;
  full shape in the API contract). Existing clients ignore unknown fields; no existing field
  changes type or meaning. When the connector is unconfigured the field is `null` on every
  row (and the join is skipped entirely — a single settings check, zero cost).
- Where several requests match one item (multiple TV children across users), attribution
  shows the **earliest** request (`requestedAt` min — "who caused this item to exist"),
  plus an `otherRequesterCount` so the UI can hint at co-requesters. Deterministic, one row
  stays one row.
- `GET /library/never-watched` (aggregate stats) is **unchanged** in v1 — per-requester
  aggregates live in the dedicated stats endpoint instead of widening a frozen shape.
- Cache note: the stale response cache (`REDIS_KEYS.LIBRARY_STALE`, TTL 3600) now embeds
  attribution, so the sync job and mapping changes must invalidate those keys (§5 step 6).
  Cache keys themselves are unchanged.

## 9. Observability and failure surfacing

- **Status endpoint** (`GET /ombi/status`): configured flag, last run/success/error, per-phase
  counts, skipped-validation count, attribution coverage (matched/manual/unattributed),
  media-match coverage. This is the primary "is it working" surface.
- **Running task**: `'ombi_sync'` in `RunningTaskType` → visible in `GET /tasks/running`
  with progress.
- **WS progress**: `WS_EVENTS.OMBI_SYNC_PROGRESS` for live UI, mirroring library sync.
- **Logs**: structured, one warn per failed run with cause; per-record validation skips logged
  at warn with the Ombi request id (never the payload); **API key redacted everywhere**
  (model: `jobs/telegramCommandListener.ts`). Unconfigured = zero log lines.
- **No health-check coupling**: Ombi being down never degrades `/health` or any existing
  endpoint; stale attribution just serves the last-synced data.
- **Test-connection endpoint** gives the owner an immediate configuration-time verdict
  (reachability, auth validity) before the first sync — same UX as Tautulli's.

## 10. Deferred / explicitly out of scope

| Item                                                                | Why deferred                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sync-cadence setting                                                | 6h fixed is fine for ~1k slow-moving rows; YAGNI                                                                                                                   |
| Requester aggregates inside `/library/never-watched`                | Covered by the stats endpoint; avoid widening a frozen shape without a UI need                                                                                     |
| Overseerr/Jellyseerr connector                                      | Different API; would be a sibling connector reusing the same table _pattern_, not this table                                                                       |
| Ombi `watchedByRequestedUser` / `requestedUserPlayedProgress` flags | Rejected as a second source of truth; "watched" is computed from Tracearr's own sessions with the established ≥120s rule (consistent with never-watched semantics) |

## 11. Story → component map

| Story                                                                  | Components                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Configure/enable Ombi connector                                        | settings keys + `getOmbiSettings()` + settings PUT hook + `POST /ombi/test-connection` |
| Sync requests from Ombi                                                | `services/ombi.ts` + `jobs/ombiSyncQueue.ts` + `ombi_requests`                         |
| See requester on Never Watched items                                   | `requestedBy` on `GET /library/stale` (query-time join)                                |
| Per-user request statistics incl. wasted storage + unattributed bucket | `GET /stats/requesters` + `(user_id)` index                                            |
| Resolve unmatched requesters                                           | `ombi_user_mappings` + `GET/PUT/DELETE /ombi/mappings*` + re-resolution                |
| Monitor sync health                                                    | `GET /ombi/status`, `RunningTaskType`, WS event                                        |
| Feature off = invisible                                                | configured-derivation, unscheduled job, null `requestedBy`, gated endpoints            |
