# Seerr Connector — Design

**Status:** Design for build (feat/seerr-connector) — no implementation yet.
**Author:** software-architect, 2026-07-28.
**Companion docs:** [seerr-api-contract.md](./seerr-api-contract.md), ADRs
[0006](./adr/0006-generalized-media-requests-table.md),
[0007](./adr/0007-seerr-title-query-time-derivation.md),
[0008](./adr/0008-seerr-external-id-first-requester-matching.md).
**Inherited (apply as-is unless noted):** the Ombi connector design
([ombi-connector.md](./ombi-connector.md)) and ADRs
[0002](./adr/0002-ombi-username-matching-with-manual-override.md) (matching pipeline shape),
[0003](./adr/0003-ombi-query-time-external-id-join.md) (query-time library join, no FK),
[0004](./adr/0004-ombi-full-mirror-resync.md) (full-mirror + prune),
[0005](./adr/0005-ombi-api-key-plaintext-settings.md) (plaintext key + redaction).

## 1. Goal and scope

Sync media requests from a Seerr instance (https://github.com/seerr-team/seerr — the
continuation of the Overseerr/Jellyseerr lineage; called **seerr** everywhere in code, config,
and docs, never "jellyseerr") so Tracearr shows **who requested which media**: requester
attribution on Never Watched rows and per-requester statistics, exactly as the Ombi connector
does. Strictly optional: complete no-op until the owner configures `seerrUrl` + `seerrApiKey`.

Ombi and Seerr are **independent connectors that may coexist** on one instance. The owner today
runs them on separate instances (production: Ombi; dev: Seerr), but nothing prevents both being
configured at once, and the storage/stats layer is designed for that (ADR 0006).

Out of scope (proportionality, same as Ombi): request management from Tracearr, webhooks/push,
multi-Seerr-instance support, per-season attribution granularity (a TV request row carries its
season list for display only), quotas/permissions mirroring.

### Verified inputs this design relies on (ground truth from the coordinator's live probe, 2026-07-28 — do not re-probe)

- Seerr **3.4.0** at `https://seerr.myrtille.online`, auth header **`X-Api-Key`**.
- `GET /api/v1/status` → `{version, commitTag, updateAvailable, ...}`.
- `GET /api/v1/request?take=N&skip=M` → `{pageInfo: {pages, pageSize, results, page},
results: [...]}` — **paginated** (unlike Ombi's unpaged endpoints). Totals today (counted by
  probe): **108 requests** (65 movie, 43 tv), 16 distinct requesters.
- `GET /api/v1/request/count` → `{total, movie, tv, pending, approved, declined, processing,
available, completed}` — cheap totals.
- `GET /api/v1/user?take=N` → paginated users (46 total, counted by probe).
- Request `status` is an **integer**; observed values `[1, 2, 5]` over all 108. **Verified against
  seerr-team/seerr's own source** (`server/constants/media.ts`, `MediaRequestStatus`):
  `PENDING=1, APPROVED=2, DECLINED=3, FAILED=4, COMPLETED=5`. An earlier version of this doc
  guessed 4=processing from the field order of `GET /api/v1/request/count`'s response
  (`{..., processing, available, completed}`) — that guess was wrong: `processing`/`available` on
  the count endpoint are derived display aggregates, not raw status values, and do not correspond
  to any request `status` integer (fix-forward review, 2026-07-28; empirically confirmed against
  the live instance's 108 requests: 1×13 + 2×18 + 5×77 = 108, matching `pending`+`approved`+
  `completed` on the count endpoint exactly, with `processing`(12) and `available`(6) unaccounted
  for by any status integer).
- Field census over all 108 requests (probe-counted): `media.tmdbId` int on **108/108**;
  `media.tvdbId` int on 43 (all tv), null on all 65 movies; `media.imdbId` str on 56, null on 52. **`media` carries no title field** (design constraint — §7, ADR 0007).
- `requestedBy` census: `jellyfinUserId` str on **108/108**, `jellyfinUsername` str on 108/108,
  `displayName` str on 108/108, `email` str on 108/108; `username`/`plexUsername`/`plexId`
  null on all (this instance is Jellyfin/Emby-backed).
- Matching, measured against the real databases: the 16 distinct `jellyfinUserId` values match
  `server_users.external_id` **16/16** on `tracearr-dev` (54 server_users) and 0/16 on
  production (different media server — expected). Usernames also matched 16/16 on dev.
- Shipped Ombi state: `ombi_requests` holds **938 rows in production** (coordinator-stated);
  migrations run through `0067_black_sway.sql` (counted in
  `apps/server/src/db/migrations/`), which created the Ombi tables.

## 2. The load-bearing decision: one generalized table (ADR 0006)

`ombi_requests` / `ombi_user_mappings` are **generalized** into source-discriminated tables
`media_requests` / `media_request_user_mappings` with `source IN ('ombi','seerr')`, migrating
the shipped Ombi rows in place. The alternative — parallel `seerr_*` tables UNIONed in every
query — was rejected. Full reasoning in ADR 0006; the two decisive points:

1. **The hard, bug-prone surface is the raw-SQL query layer**, not the schema. The requester
   stats query (`routes/stats/requesters.ts`) is ~270 lines of raw-SQL CTEs (dedup, episode
   roll-ups, watched-by semantics); the stale-attribution fragments in
   `routes/library/stale.ts` are raw SQL too. TypeScript verifies none of it. With one table,
   these stay single-code-path; with two tables they need UNION-ALL column alignment inside
   raw SQL — a silent-runtime-bug class, duplicated again for every future connector in a
   lineage that keeps forking.
2. **The migration risk is small and bounded, and mostly compiler-checked.** At 938 rows every
   ALTER is a metadata-op or instant rewrite inside one transaction. The churn in shipped Ombi
   code is mechanical renames that the TypeScript compiler enumerates exhaustively — except
   for the _source-scoping predicates_, which are the one genuinely dangerous spot and are
   therefore an explicit build checklist (§4.4).

This supersedes the "a future connector would be a sibling, not a generalization" note in
ombi-connector.md §1/§10, which was written before the stats SQL existed (ADR 0006 records
the supersession).

## 3. Component view

```
                          ┌─────────────────────────────────────────────────┐
                          │ apps/server                                     │
 Seerr 3.x  ◄──HTTP───────┤  services/seerr.ts        (SeerrClient)         │
 (X-Api-Key header)       │  jobs/seerrSyncQueue.ts   (BullMQ, 6h)          │
                          │  routes/seerr.ts          (config/sync/map)     │
                          │  routes/stats/requesters.ts  (SHARED, reads     │
 Ombi 4.x   ◄──HTTP───────┤  services/ombi.ts             media_requests)   │
 (unchanged pipeline,     │  jobs/ombiSyncQueue.ts    routes/library/stale  │
  now writes source=      │  routes/ombi.ts               (SHARED join)     │
  'ombi' rows)            └───────┬────────────────────────┬────────────────┘
                                  │                        │
                         Postgres │               Redis    │  WS (pubsub)
                    media_requests│          cache + job   │  SEERR_SYNC_PROGRESS
         media_request_user_mappings        queues         │  OMBI_SYNC_PROGRESS
                    settings (kv) │                        │
```

New modules (paths follow the Ombi layout; engineers implement, this doc specifies):

| Module                                               | Responsibility                                                                                                                                                                                                    | Model/precedent                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/seerr.ts`                  | Outbound Seerr client: ctor(url, apiKey), `X-Api-Key` header, 30s timeout, 3 retries linear backoff, Zod-validated responses (unknown-field passthrough), pagination iterator, `testConnection()`                 | `services/ombi.ts`                                                                                                       |
| `apps/server/src/jobs/seerrSyncQueue.ts`             | Repeatable + manual sync; single-phase paginated full mirror (§6); progress via `job.updateProgress` + pubsub; cache invalidation; enqueue guard; always-registered scheduler with no-op firing when unconfigured | `jobs/ombiSyncQueue.ts` (clone the queue/worker/scheduler shape exactly, incl. the pure-function split for unit testing) |
| `apps/server/src/routes/seerr.ts`                    | Owner-gated config/test/sync/status/mapping/purge endpoints                                                                                                                                                       | `routes/ombi.ts`                                                                                                         |
| `db/schema.ts` changes                               | Generalize to `media_requests` + `media_request_user_mappings` (§4) — **migration authored by data-engineer** per Drizzle flow                                                                                    | migration 0068 plan, §4.3                                                                                                |
| `packages/shared` additions                          | `WS_EVENTS.SEERR_SYNC_PROGRESS`, `RunningTaskType += 'seerr_sync'`, Seerr response interfaces, `StaleItemRequestedBy.source` union widening                                                                       | contract doc                                                                                                             |
| `apps/web/src/components/settings/SeerrSettings.tsx` | Settings panel: url/key, test-connection, sync-now, status, mappings, purge-once-disconnected                                                                                                                     | `OmbiSettings.tsx` (same states and controls)                                                                            |

Changed modules (rename churn from ADR 0006, behavior identical for Ombi):
`services/ombi.ts`, `jobs/ombiSyncQueue.ts`, `routes/ombi.ts`, `routes/stats/requesters.ts`,
`routes/library/stale.ts` — see §4.4 for the scoping checklist.

Unchanged UI: `pages/stats/Requesters.tsx` and `components/users/UserRequestsCard.tsx` keep
working with zero changes — they consume `GET /stats/requesters`, which now aggregates over
both sources transparently.

## 4. Data model (ADR 0006)

### 4.1 `media_requests` (generalized from `ombi_requests`)

One row per attributable request unit: an Ombi movie request, an Ombi TV child request, or a
Seerr request (movie or tv — Seerr has no parent/child split; one request row per request,
seasons carried in the row). Volume: 938 Ombi rows (production, coordinator-stated) + 108
Seerr rows (probe-counted, dev) ≈ **~1,050 across both instances today**; growth a few hundred
per year per source. Still a mirror, not an event log (ADR 0004 semantics per source).

Column changes relative to shipped `ombi_requests` (everything not listed is unchanged):

| Column                                             | Change                                                                    | Rationale / per-source semantics                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                                           | **NEW** `varchar(10) NOT NULL`, values `'ombi' \| 'seerr'`                | Discriminator. Backfilled `'ombi'` in migration; no column default afterwards (writers must be explicit)                                                                                                                                                                                                                                                                                                                                                            |
| `source_request_id`                                | renamed from `ombi_request_id`                                            | Ombi movie/child id, or Seerr request `id`. Seerr ids are one sequence across movie+tv; Ombi's are per-type — the composite unique key below covers both                                                                                                                                                                                                                                                                                                            |
| `source_parent_request_id`                         | renamed from `ombi_parent_request_id`                                     | Ombi TV parent id; **always null for seerr** (no parent concept)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `title`                                            | **now nullable**                                                          | Seerr provides no title (ADR 0007): null for seerr rows in v1. Ombi rows keep their non-null titles                                                                                                                                                                                                                                                                                                                                                                 |
| `release_year`                                     | unchanged (nullable)                                                      | Null for seerr rows in v1 (no source field; same derivation chain as title if ever needed)                                                                                                                                                                                                                                                                                                                                                                          |
| `seasons`                                          | unchanged                                                                 | Seerr tv: `seasons[].seasonNumber` as `number[]` (1..19 per request observed); null for movies. Display only                                                                                                                                                                                                                                                                                                                                                        |
| `is_4k`                                            | unchanged                                                                 | Seerr: request-level `is4k` (bool, present on all 108)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `status`                                           | unchanged vocabulary `'pending' \| 'approved' \| 'denied' \| 'available'` | Seerr integer mapping at sync (verified against seerr-team/seerr's `MediaRequestStatus` enum, §"Verified inputs" above): 1→pending, 2→approved, 3→denied, 4→denied (FAILED - closest bucket the shipped 4-value vocabulary offers; a failed grab is not "approved"), 5→available. Unknown ints → `'pending'` + warn counter (never skip the row; attribution outranks status fidelity). Keeping one vocabulary keeps every status FILTER in the stats SQL unchanged |
| `requested_at`                                     | unchanged                                                                 | Seerr `createdAt` (ISO str, parsed explicitly, stored timestamptz)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `available_at`                                     | unchanged                                                                 | Seerr `media.mediaAddedAt` when present (when the media became available)                                                                                                                                                                                                                                                                                                                                                                                           |
| `imdb_id` / `tmdb_id` / `tvdb_id`                  | unchanged                                                                 | Seerr `media.imdbId` (56/108) / `media.tmdbId` (**108/108**) / `media.tvdbId` (43/108, tv only). Join coverage via tmdb is 100% — better than Ombi's measured 99.7%                                                                                                                                                                                                                                                                                                 |
| `source_user_id`                                   | renamed from `ombi_user_id`                                               | Raw requester identity: Ombi account GUID, or Seerr `requestedBy.id` (int, stored as text). Always retained, even unattributed                                                                                                                                                                                                                                                                                                                                      |
| `source_username`                                  | renamed from `ombi_username`                                              | Ombi `userName`, or Seerr `jellyfinUsername ?? plexUsername ?? username` (first non-null; jellyfin populated on 108/108 here)                                                                                                                                                                                                                                                                                                                                       |
| `source_alias`                                     | renamed from `ombi_alias`                                                 | Ombi `alias`, or Seerr `displayName` (preferred fallback display name; present 108/108)                                                                                                                                                                                                                                                                                                                                                                             |
| `source_external_user_id`                          | **NEW** `varchar(64)` nullable                                            | Seerr's strong media-server user id: `jellyfinUserId` (or `plexId` on Plex-backed instances). **Null for ombi rows** — Ombi's `providerUserId` deliberately stays transient (ADR 0002). Persisted for seerr because it is the _primary_ match tier and must survive for offline re-resolution (ADR 0008)                                                                                                                                                            |
| `user_id`, `match_method`, `synced_at`, timestamps | unchanged                                                                 | `match_method` vocabulary reused as-is: `'manual' \| 'provider' \| 'username'` — the Seerr external-id tier records `'provider'` (semantically identical: a media-server provider user id). No enum widening                                                                                                                                                                                                                                                        |

Indexes (renamed to `media_requests_*`; changes only):

| Index                                                                      | Change                                     | Why                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `UNIQUE (source, media_type, source_request_id)`                           | source prepended to the shipped unique key | Idempotent upsert key per source; Ombi's per-type id sequences and Seerr's global sequence both collision-free under it |
| `(source, source_user_id)`                                                 | replaces `(ombi_user_id)`                  | Re-resolution on mapping change and mapping-UI counts are always per-source                                             |
| `(user_id)`, `(requested_at)`, partial `(imdb_id)`/`(tmdb_id)`/`(tvdb_id)` | rename only                                | Same access paths; at ~1k rows all remain correctness documentation, not perf necessity                                 |

Retention: unchanged per source — rows live while mirrored in their source, pruned when the
source deletes them (ADR 0004). Each source's prune is scoped `WHERE source = '<x>'`.

### 4.2 `media_request_user_mappings` (generalized from `ombi_user_mappings`)

Manual owner overrides only, same contract as before. Expected Seerr rows: **~0** — the
external-id tier auto-matches 16/16 measured; this table exists for future drift and for
force-unattribute. Changes:

| Column                             | Change                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `source`                           | **NEW** `varchar(10) NOT NULL`, backfilled `'ombi'`                              |
| `source_user_id`                   | renamed from `ombi_user_id`; **PK becomes composite `(source, source_user_id)`** |
| `source_username`                  | renamed from `ombi_username` (snapshot for the mapping UI)                       |
| `user_id` FK (CASCADE), timestamps | unchanged, incl. `null` = force-unattributed                                     |

### 4.3 Migration strategy for the live Ombi rows (migration 0068, data-engineer authors)

One transaction (Postgres DDL is transactional); every step is metadata-only or an instant
rewrite at ≤1k rows:

1. `ALTER TABLE ombi_requests RENAME TO media_requests;` same for the mappings table.
2. `ADD COLUMN source varchar(10) NOT NULL DEFAULT 'ombi'` on both, then
   `ALTER COLUMN source DROP DEFAULT` (backfill happens via the default; dropping it forces
   explicit writes forever after).
3. `RENAME COLUMN` for `ombi_request_id → source_request_id`,
   `ombi_parent_request_id → source_parent_request_id`, `ombi_user_id → source_user_id`,
   `ombi_username → source_username`, `ombi_alias → source_alias` (and the mappings columns).
4. `ALTER COLUMN title DROP NOT NULL`.
5. `ADD COLUMN source_external_user_id varchar(64)` (null everywhere — correct for ombi).
6. Drop `ombi_requests_media_type_request_id_unique`; create
   `media_requests_source_media_type_request_id_unique (source, media_type, source_request_id)`.
7. Drop the mappings PK; create composite PK `(source, source_user_id)`.
8. Rename remaining indexes `ombi_requests_* → media_requests_*`; replace
   `(ombi_user_id)` index with `(source, source_user_id)`.

Rollback: the exact inverse script (kept alongside the migration), or restore from backup —
the upgrade runbook already mandates a DB backup before migrating. Deployment note: **both of
the owner's instances** run this migration on upgrade; production renames 938 live rows in
place, dev renames an empty/near-empty table. No dual-write or expand-contract phase is
needed at this scale — the migration and the code that speaks the new names ship in the same
release, and the app is single-writer against its own DB.

### 4.4 Source-scoping checklist (the one risk the compiler cannot catch)

Renaming Drizzle schema exports (`ombiRequests → mediaRequests`, etc.) makes TypeScript
enumerate every code touch point. What it will NOT catch is a query that now needs — or must
NOT have — a `source` predicate, and raw-SQL strings still naming old columns. Binding on the
build (and on the code-reviewer at Verify):

| Query site                                                | Scoping after migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ombi sync upsert (`jobs/ombiSyncQueue.ts`)                | writes `source: 'ombi'`; conflict target gains `source`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Ombi prune                                                | `WHERE source = 'ombi' AND media_type = <phase> AND synced_at < run`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Ombi purge (`DELETE /ombi/data`)                          | `WHERE source = 'ombi'` on both tables                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Ombi mappings list / status counts / re-resolution UPDATE | `WHERE source = 'ombi'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Seerr equivalents of all of the above                     | `WHERE source = 'seerr'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Requester stats SQL (`routes/stats/requesters.ts`)        | scoped to the **set of currently-configured sources** (`WHERE source IN (...)`, computed from settings per request) — this preserves the shipped retained-but-invisible rule per source: a disconnected source's rows stay in the table but vanish from stats. `otherRequesterCount`-style distinct-requester keys become `COALESCE(user_id::text, source \|\| ':' \|\| source_user_id)` so one human resolved from both sources counts once and unresolved requesters never collide across sources |
| Stale attribution fragments (`routes/library/stale.ts`)   | scoped to the configured-source set, same rule; raw-SQL column names updated (`ombi_username → source_username`, …); wire field `ombiUsername` is populated from `source_username` (contract §7). Zero configured sources ⇒ the shipped NULL-literals fast path (no join)                                                                                                                                                                                                                           |
| Acceptance grep                                           | `grep -rE 'ombi_requests\|ombi_user_id\|ombi_username\|ombi_alias\|ombi_user_mappings' apps/server/src` returns zero hits outside `db/migrations/`                                                                                                                                                                                                                                                                                                                                                  |

## 5. Configuration and lifecycle

Identical to Ombi (settings-not-env; no enabled flag; configured ⇔ both keys non-null):

- New `PUBLIC_DEFAULTS` keys: `seerrUrl: string | null`, `seerrApiKey: string | null`
  (plaintext per ADR 0005, which applies verbatim — a Seerr API key is likewise full-admin on
  a reachable instance; redaction rules binding, no new ADR needed).
- New `INTERNAL_DEFAULTS` key: `seerrSyncStatus: jsonb | null` (same shape/lifecycle as
  `ombiSyncStatus`).
- Typed getter `getSeerrSettings()` beside `getOmbiSettings()`.
- Cadence: fixed 6h repeatable job + manual trigger, same as Ombi. Not settings-driven.
- Scheduler: follow the **implemented** Ombi pattern (always-registered scheduler; each firing
  reads settings fresh and no-ops silently when unconfigured — configure/disconnect takes
  effect without restart). Note: ombi-connector.md §2 described "not scheduled at all"; the
  implementation evolved to always-registered, and Seerr copies the implementation.
- Lifecycle transitions: the same five as Ombi, including the fifth — **clearing settings
  invalidates `LIBRARY_STALE` + requester-stats caches** so attribution vanishes from cached
  payloads immediately; data retained on disconnect; `DELETE /seerr/data` purge available only
  while disconnected (409 otherwise), scoped `source='seerr'`.
- SSRF: `assertSafeProbeUrl()` before the first request of every client instantiation.
- User deleted: `user_id` SET NULL (rows fall back to unattributed, raw identity retained).

## 6. Sync strategy (full mirror, paginated — ADR 0004 pattern adapted)

Full mirror + prune remains right for Seerr: 108 rows, statuses mutate (approve/decline/
available flips), requests are deletable, and there is no delta feed. What differs from Ombi
is pagination and phasing:

- **Single phase** (one endpoint serves movies + tv), one transaction — versus Ombi's two
  independent phases. Simpler, and partial-phase semantics have nothing to attach to.
- **Pagination loop:** `GET /api/v1/request?take=100&skip=k`, iterating until collected count
  reaches the final page's `pageInfo.results` or an empty page returns; hard page cap
  `ceil(results / take) + 1`; in-memory dedupe by request `id` (offset paging can duplicate a
  row if requests land mid-iteration). Today: 2 pages.

Per run (BullMQ job, attempts 3, exp 60s backoff, `removeOnComplete`):

1. `getSeerrSettings()`; unconfigured → silent exit (guards the disconnect race).
2. `runStartedAt = now()`.
3. `GET /api/v1/request/count` — progress denominator + consistency reference.
4. Paginate as above; Zod-validate per record with unknown-field passthrough; invalid records
   skipped with warn + counter (never fail the run for one malformed row).
5. Map fields (§4.1), resolve requesters (§8), upsert all rows in one transaction on
   `(source='seerr', media_type, source_request_id)` with `synced_at = runStartedAt`.
6. **Prune** `DELETE FROM media_requests WHERE source='seerr' AND synced_at < runStartedAt`
   in the same transaction — only if (a) every page fetched successfully, (b) zero validation
   failures, and (c) collected count equals the final page's `pageInfo.results`
   (pagination-consistency guard — offset paging during concurrent inserts can drop a row; a
   dropped live row must not be pruned into flapping). A skipped prune self-heals next run.
7. Write `seerrSyncStatus` (lastRunAt, lastSuccessAt, counts, skipped, attribution coverage,
   lastError).
8. Invalidate caches: `LIBRARY_STALE` keys + the requester-stats keys (shared cache — both
   connectors' syncs and mapping changes invalidate the same keys).
9. Progress: `job.updateProgress` + pubsub on `WS_EVENTS.SEERR_SYNC_PROGRESS`
   (`'seerr:sync:progress'`), phases `count | fetch | resolve | done | error`.

Idempotency: upsert key + `synced_at` monotonicity, identical to Ombi. Manual trigger:
`POST /seerr/sync`, 409 while active, surfaced via `RunningTaskType` `'seerr_sync'`.
Expected duration: seconds (3 HTTP calls + ~108 upserts today).

## 7. Title handling (ADR 0007)

Seerr's request payload carries **no title** (probe-verified). Decision: **store `title = NULL`
for seerr rows in v1 and derive display titles at query time from the matched library item**,
with the render chain `title ?? matched library_items.title ?? "TMDB #<tmdbId>"`.

Proportionality evidence: no endpoint reads `media_requests.title` today (grep-counted: the
only references are the Ombi sync write path and its tests) — the stale-attribution fragment
and the stats page both take titles from `library_items`. Building sync-time title hydration
(one Seerr media-detail call per request) would add a second fetch path for a column nothing
renders. The sanctioned upgrade path, recorded in ADR 0007 for when a per-request list UI
ships: hydrate only rows with NULL title via `GET /api/v1/movie/{tmdbId}` /
`GET /api/v1/tv/{tmdbId}` (Overseerr-lineage endpoints are keyed by TMDB id — verify the
exact shape at build time before relying on it), title immutable once set, hydration failure
degrades to the query-time chain. No blank column is silently shipped: every surface that
could show a request title specifies the fallback chain above.

## 8. Matching

### 8.1 Media → library (ADR 0003, applies verbatim)

Query-time external-id join, imdb → tmdb → tvdb precedence, LATERAL pick-first, **no title
fallback** — the shipped SQL is reused unchanged (it already reads the id columns, which keep
their names). Seerr's `tmdbId` on 108/108 gives 100% joinable coverage; movies additionally
carry imdb on ~half, tv carries tvdb on all.

### 8.2 Requester → Tracearr user (ADR 0008 — where Seerr must differ from Ombi)

Unlike Ombi (no provider ids, username-only, 30/33), Seerr supplies a **strong, stable
external id on every request** (`jellyfinUserId` 108/108, matching `server_users.external_id`
16/16 measured). The pipeline keeps ADR 0002's shape but promotes the external-id tier to
primary and **persists** the id (`source_external_user_id`):

1. **Manual override** (`media_request_user_mappings`, source='seerr'): `user_id` or
   force-unattributed. `match_method='manual'`.
2. **External id**: `jellyfinUserId` → `server_users.external_id`; if null (Plex-backed Seerr),
   `plexId` → `server_users.plex_account_id`. Resolve to that server_user's `user_id`. If the
   id matches server_users rows resolving to **more than one distinct** `user_id`, refuse and
   flag ambiguous (never guess — same rule as username ambiguity). `match_method='provider'`
   (vocabulary reused; no enum change).
3. **Case-insensitive username**: `lower(source_username)` vs `lower(users.username)`;
   ambiguity → refuse and flag. `match_method='username'`.
4. **Unattributed**: `user_id=null`, raw identity retained, surfaces in `GET /seerr/mappings`
   and the explicit unattributed stats bucket.

Recomputed every sync. Mapping PUT/DELETE re-resolves that requester's rows immediately —
and because `source_external_user_id` is persisted, the offline re-resolution runs the
**full** pipeline including tier 2 (Ombi's live re-resolution must skip its provider tier
because `providerUserId` is transient; that asymmetry is the reason for persisting here —
ADR 0008).

### 8.3 PII decision (consistent with ombi design §7)

Stored: `source_user_id` (Seerr numeric id), `source_username` (jellyfinUsername),
`source_alias` (displayName), `source_external_user_id` (jellyfinUserId — an opaque
media-server GUID of the same sensitivity class as the already-stored
`server_users.external_id`). **Not stored: `email`** — present on 108/108 but adds zero
matching value over the 16/16 external-id tier; same minimization ruling as Ombi.
Also not stored: `avatar`, `permissions`, `modifiedBy`, `isAutoRequest`, quota fields.

## 9. Surfacing on existing views (additive-only)

- `GET /library/stale` rows: the same `requestedBy` field now draws from **every
  currently-configured source** (configured-source-set scoping, §4.4). `StaleItemRequestedBy.source` widens to `'ombi' | 'seerr'`; the
  legacy-named `ombiUsername`/`ombiAlias` wire fields carry the source-side
  username/alias for either source (contract §7 documents this; renaming them would break the
  frozen shape). Earliest-request-wins now spans sources; `otherRequesterCount` counts
  distinct requester identities across sources with resolved-user dedup (§4.4).
- `GET /stats/requesters`: same endpoint, now aggregating `media_requests` across sources.
  A user resolved from both sources merges into one row (grouping is by `user_id` — already
  the design); the same media item requested in both sources is deduped in size/never-watched
  math by the existing `distinct_items_global` CTE (dedup key is the library item, not the
  request). `configured` becomes "any source configured"; new optional `configuredSources`
  breakdown (contract §6).
- `GET /library/never-watched`: unchanged, as with Ombi.
- Cache seam: stale + requester-stats cached payloads embed cross-source attribution; **both**
  sync jobs, **both** mapping paths, **both** purges, and **both** settings-clear transitions
  invalidate the same key sets.

## 10. Observability and failure surfacing

Mirrors Ombi exactly, per source: `GET /seerr/status` (configured, running, last run/success/
error, counts incl. skipped-validation, attribution coverage split by method, media-match
coverage, `purgeAvailable`); `'seerr_sync'` in `GET /tasks/running`;
`WS_EVENTS.SEERR_SYNC_PROGRESS`; one structured warn per failed run; per-record validation
skips logged with the Seerr request id, never the payload; **API key redacted everywhere**;
zero log lines when unconfigured; no health-check coupling. Test-connection gives an
immediate configuration-time verdict including the instance version (§ contract 2 — note the
two-call design: `/status` alone cannot validate the key).

## 11. Deferred / explicitly out of scope

| Item                                                                                | Why deferred                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sync-time title hydration                                                           | No consuming surface (grep-verified); ADR 0007 records the upgrade path                                   |
| Per-request list endpoint/UI                                                        | No current UI need; when built, triggers title hydration                                                  |
| `source` filter param on `/stats/requesters`; per-row source badges                 | Merged rows are single-source in practice today (sources live on different instances); add when a UI asks |
| Seerr webhooks                                                                      | Same reasoning as Ombi's (ADR 0004 option 3)                                                              |
| Distinguishing `processing`/`completed` statuses in the frozen `statusCounts` shape | Mapped onto the shipped 4-bucket vocabulary; widening the shape needs a UI consumer first                 |
| Mirroring Seerr `media.status`, quotas, tags                                        | No use case                                                                                               |

## 12. Story → component map

| Story                                                            | Components                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure/enable Seerr connector                                 | settings keys + `getSeerrSettings()` + settings PUT hook + `POST /seerr/test-connection`                                                                                                              |
| Sync requests from Seerr (paginated)                             | `services/seerr.ts` + `jobs/seerrSyncQueue.ts` + `media_requests` (source='seerr')                                                                                                                    |
| See requester on Never Watched items (either source)             | shared `requestedBy` join over `media_requests`                                                                                                                                                       |
| Per-user request stats across both sources + unattributed bucket | `GET /stats/requesters` over `media_requests`                                                                                                                                                         |
| Resolve unmatched requesters                                     | `media_request_user_mappings` + `GET/PUT/DELETE /seerr/mappings*` + offline full-pipeline re-resolution                                                                                               |
| Monitor sync health                                              | `GET /seerr/status`, `RunningTaskType`, WS event                                                                                                                                                      |
| Purge after disconnect                                           | `DELETE /seerr/data` (source-scoped)                                                                                                                                                                  |
| Feature off = invisible                                          | configured-derivation, no-op scheduler firing, configured-source-set scoping in the shared queries (retained rows of a disconnected source stay invisible), gated endpoints return `configured:false` |
| Shipped Ombi keeps working                                       | migration 0068 + §4.4 checklist + unchanged Ombi wire contract                                                                                                                                        |
