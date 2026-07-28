# Ombi Connector — API Contract

**Status:** Frozen for build once Wave 2 gate clears. Additive-only relative to v1.7.0.
**Companion:** [ombi-connector.md](./ombi-connector.md) (design), ADRs 0002–0005.

Conventions used throughout: all new routes live under the existing `/api/v1` prefix; owner
gating via `app.requireOwner` (cf. `routes/settings.ts:41`); authenticated reads via
`app.authenticate`; server filtering via `resolveServerIds`/`buildMultiServerFragment`
(`utils/serverFiltering.ts`); Redis caching via `buildLibraryCacheKey`-style keys. TypeScript
interfaces below are ready to drop into `packages/shared/src/types.ts`; constants into
`packages/shared/src/constants.ts`.

---

## 1. Settings additions (existing endpoints, additive keys)

`GET /settings` / `PUT /settings` (owner) gain two keys on the existing `Settings` object —
no new endpoint, no shape change beyond added optional keys:

```ts
// extend interface Settings
ombiUrl: string | null; // base URL, e.g. "http://localhost:5420"
ombiApiKey: string | null; // Ombi API key; plaintext per repo convention (ADR 0005),
// returned to owner like tautulliApiKey; MUST be redacted in logs
```

Defaults `null` in `PUBLIC_DEFAULTS` (`services/settings.ts:14-45`). No migration (kv table).
Feature is "configured" iff both are non-null (Tautulli gate convention). The settings PUT
handler additionally (re)schedules or unschedules the repeatable sync job when these keys
change, and enqueues one immediate sync on configure.

Internal (not exposed on the Settings object): `ombiSyncStatus` jsonb, written by the sync
job, read by `GET /ombi/status`.

---

## 2. `POST /ombi/test-connection` — validate before save

- **Auth:** owner. **Caching:** none.
- **Body** (tests the _submitted_ values, not the saved ones — Tautulli `testConnection()` model):

```ts
interface OmbiTestConnectionRequest {
  url: string;
  apiKey: string;
}
```

- **Behavior:** `assertSafeProbeUrl(url)` (`utils/ssrf.ts` — RFC1918/loopback allowed by
  design), then `GET {url}/api/v1/Identity/Users` with `ApiKey` header, 10s timeout, no
  retries. Validates reachability + key validity (that endpoint requires admin scope, which
  sync needs). User payload is counted, never returned.
- **Response 200:**

```ts
interface OmbiTestConnectionResponse {
  success: boolean;
  userCount?: number; // present on success
  error?: string; // human-readable cause on failure (auth vs network vs bad URL)
}
```

Always 200 with `success:false` for remote-side failures (matches existing test-connection
UX); 400 only for malformed body / SSRF rejection.

---

## 3. `POST /ombi/sync` — manual sync trigger

- **Auth:** owner. **Caching:** none.
- **Body:** none.
- **Responses:**
  - `202` `{ jobId: string }` — enqueued.
  - `409` `{ error: string }` — a sync is already queued/running (enqueue guard, same
    pattern as library sync's manual path).
  - `400` `{ error: string }` — connector not configured.

Progress is observable via `GET /tasks/running` (`RunningTaskType` gains `'ombi_sync'`,
`types.ts:1819`) and the WS event below.

---

## 4. `GET /ombi/status` — connector + sync health

- **Auth:** owner (configuration surface). **Caching:** none (reads `ombiSyncStatus` setting + queue state).
- **Response 200:**

```ts
interface OmbiStatusResponse {
  configured: boolean;
  running: boolean; // a sync job is active
  lastRunAt: string | null; // ISO-8601
  lastSuccessAt: string | null;
  lastError: string | null; // cause of last failed run, null if last run succeeded
  counts: {
    movieRequests: number; // rows currently mirrored
    tvRequests: number; // child-request rows
    total: number;
    skippedValidation: number; // records skipped in the last run
  };
  attribution: {
    // over all mirrored rows
    matched: number; // match_method = 'username' | 'provider'
    manual: number; // match_method = 'manual'
    unattributed: number; // user_id IS NULL
  };
  mediaMatch: {
    // query-time join coverage, computed on demand
    matched: number; // rows whose external id hits a library_items row
    unmatched: number;
  };
}
```

When `configured: false`, all counts are still reported from retained data (may be nonzero
after a disconnect) but `running` is false and `lastError` explains nothing new.

---

## 5. User-mapping endpoints

### 5.1 `GET /ombi/mappings`

- **Auth:** owner. **Caching:** none (tiny, owner-only).
- **Response 200:** one entry per distinct requester seen in `ombi_requests`, plus any
  mapping rows for requesters no longer present (flagged `stale: true`):

```ts
type OmbiRequesterResolutionType = 'manual' | 'provider' | 'username' | 'unattributed';

interface OmbiRequesterMapping {
  ombiUserId: string;
  ombiUsername: string;
  ombiAlias: string | null;
  requestCount: number;
  resolution: {
    type: OmbiRequesterResolutionType;
    userId: string | null; // users.id when resolved; null for 'unattributed'
    // and for a manual "force unattributed" override
    username: string | null; // Tracearr users.username for display
  };
  ambiguous: boolean; // true when >1 case-insensitive username candidates
  // exist (auto-match refused; owner must decide)
  suggestions: Array<{
    // candidate users for the mapping UI (username
    userId: string; // similarity; empty when resolved or no candidates)
    username: string;
  }>;
  stale: boolean; // mapping exists but requester absent from Ombi
}

interface OmbiMappingsResponse {
  requesters: OmbiRequesterMapping[];
}
```

### 5.2 `PUT /ombi/mappings/:ombiUserId`

- **Auth:** owner.
- **Body:**

```ts
interface OmbiMappingUpsertRequest {
  userId: string | null; // users.id to attribute to; null = force-unattributed ("ignore")
}
```

- **Behavior:** upsert into `ombi_user_mappings`; immediately re-resolve that requester's
  `ombi_requests` rows (indexed UPDATE) and invalidate `LIBRARY_STALE` +
  `OMBI_REQUESTER_STATS` caches.
- **Responses:** `200` `{ updated: number }` (rows re-resolved); `404` unknown `userId`;
  `400` malformed.

### 5.3 `DELETE /ombi/mappings/:ombiUserId`

- **Auth:** owner.
- **Behavior:** remove the override; re-resolve that requester via the automatic pipeline
  (provider → username → unattributed); same cache invalidation.
- **Responses:** `200` `{ updated: number }`; `404` no override exists.

---

## 5.4 `DELETE /ombi/data` — purge mirrored data

Added by owner decision 2026-07-28, before build fan-out (not a mid-wave patch).

- **Auth:** owner. **Caching:** none.
- **Precondition:** the connector must be **disconnected** (`ombiUrl`/`ombiApiKey` cleared).
  Returns `409` while still configured — otherwise the next scheduled sync would simply
  repopulate what was just deleted, which reads as the purge having failed.
- **Behavior:** deletes all `ombi_requests` rows and all `ombi_user_mappings` rows in one
  transaction, then invalidates `LIBRARY_STALE` + `OMBI_REQUESTER_STATS` caches so
  attribution disappears from library rows immediately.
- **Response 200:** `OmbiPurgeResponse { deletedRequests, deletedMappings }`.

`GET /ombi/status` carries `purgeAvailable: boolean` (true iff disconnected AND rows remain)
so the settings panel can reveal the control exactly when it is actionable, per the owner's
"show it once the connection is removed" requirement. Disconnecting still **retains** data by
default; purging is always an explicit, separate act.

---

## 6. `GET /stats/requesters` — per-user request statistics

- **Auth:** authenticated (read-only stats, same level as other stats routes).
- **Query params:**

| Param                    | Type                       | Default        | Meaning                                                                                                                                                                                                                          |
| ------------------------ | -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverId` / `serverIds` | uuid / uuid[]              | all accessible | Scopes the **watch/size computation** (`library_items` + `sessions` joins) via `resolveServerIds`. Requests themselves are server-agnostic (Ombi is global): request counts don't vary with this filter, watch-derived fields do |
| `mediaType`              | `'all' \| 'movie' \| 'tv'` | `'all'`        | Filters request rows                                                                                                                                                                                                             |

- **Caching:** Redis, key `REDIS_KEYS.OMBI_REQUESTER_STATS` (per server-segment +
  mediaType), TTL `CACHE_TTL.OMBI_REQUESTER_STATS = 3600`. Invalidated by sync completion
  and mapping changes.
- **Response 200:**

```ts
interface RequesterStatsRow {
  userId: string | null; // users.id; null ONLY on the unattributed bucket
  username: string | null; // Tracearr username; null on the unattributed bucket
  requestCount: number; // all mirrored request rows for this identity
  movieCount: number;
  tvCount: number; // child-request rows
  statusCounts: {
    pending: number;
    approved: number;
    denied: number;
    available: number;
  };
  matchedToLibraryCount: number; // rows whose media matched a library item (query-time join)
  totalSizeBytes: number; // file size of matched library items (show roll-up via
  // episode sizes, same semantics as never-watched page)
  neverWatchedCount: number; // matched items with NO qualifying play by ANYONE
  // (session duration_ms >= 120000 — same rule as /stale)
  neverWatchedSizeBytes: number; // "wasted storage" for this requester
  watchedByRequesterCount: number; // matched items with a qualifying play by THIS user's
  // own serverUsers (0 for the unattributed bucket)
  firstRequestAt: string | null; // ISO-8601
  lastRequestAt: string | null;
}

interface RequesterStatsResponse {
  requesters: RequesterStatsRow[]; // attributed identities, sorted requestCount desc
  unattributed: RequesterStatsRow; // EXPLICIT bucket: userId/username null; aggregates all
  // rows with user_id IS NULL (always present, zeroed
  // when empty)
  totals: {
    requestCount: number;
    requesterCount: number; // distinct attributed identities
    unattributedCount: number; // rows in the unattributed bucket
    neverWatchedSizeBytes: number; // total wasted storage across everyone
  };
  configured: boolean; // false => all zeros/empty (feature off; UI hides page)
  generatedAt: string; // ISO-8601, from cache-fill time
}
```

- When unconfigured: `200` with `configured:false` and empty/zero payload (no error — the
  feature is invisible, not broken).
- Note: "watched" is always computed from Tracearr sessions (≥120s rule), never from Ombi's
  `watchedByRequestedUser` flags (design §10 — one source of truth).

---

## 7. Attribution on existing library rows (additive to frozen v1.7.0 shapes)

### `GET /library/stale` — items gain one optional field

The `StaleItem` shape (currently local to `routes/library/stale.ts:30-46`) gains:

```ts
/** Requester attribution from the Ombi connector. Null when the connector is
 *  unconfigured, the item matched no request, or the request is unattributed
 *  to a Tracearr user (then ombiUsername still identifies the raw requester). */
interface StaleItemRequestedBy {
  userId: string | null; // resolved users.id; null = unattributed
  username: string | null; // Tracearr username; falls back null when unattributed
  ombiUsername: string; // raw Ombi identity (alias preferred at render time
  ombiAlias: string | null; //   by the client: alias ?? ombiUsername)
  requestedAt: string; // ISO-8601 of the EARLIEST matching request
  otherRequesterCount: number; // additional distinct requesters of the same media
  //   (multi-child TV case); 0 for the common case
  source: 'ombi'; // future-proofs sibling connectors
}

// additive change to the stale items row:
interface StaleItem {
  // ... all existing v1.7.0 fields unchanged ...
  requestedBy: StaleItemRequestedBy | null; // NEW, always present going forward
}
```

Rules:

- **No existing field changes** name, type, optionality, or semantics. Adding a field is
  additive; the v1.7.0 web client ignores it.
- Join is performed only when the connector is configured (single settings check); otherwise
  `requestedBy: null` on every row with zero query cost.
- Multiple matching requests → earliest `requestedAt` wins (deterministic; "who caused this
  item to exist"), `otherRequesterCount` carries the rest.
- Applies to **all** `/stale` categories (`never_watched` and `stale`) — same query, no
  reason to special-case.
- Cache: keys unchanged; cached payloads now embed attribution, so sync completion and
  mapping changes invalidate `REDIS_KEYS.LIBRARY_STALE` entries (design §5/§8).

### `GET /library/never-watched`

**Unchanged** in this increment. Per-requester aggregates are served by
`GET /stats/requesters`; widening the frozen aggregate shape has no consuming UI yet
(design §10).

---

## 8. Shared constants and types (additions)

```ts
// packages/shared/src/constants.ts
WS_EVENTS.OMBI_SYNC_PROGRESS = 'ombi:sync:progress'; // payload mirrors library sync progress
REDIS_KEYS.OMBI_REQUESTER_STATS; // getter, key pattern 'ombi:requester-stats:{servers}:{params}'
CACHE_TTL.OMBI_REQUESTER_STATS = 3600; // 1h, matches LIBRARY_STALE cadence

// packages/shared/src/types.ts
export type RunningTaskType =
  'library_sync' | 'tautulli_import' | 'jellystat_import' | 'maintenance' | 'ombi_sync';
// + Settings gains ombiUrl / ombiApiKey (section 1)
// + OmbiTestConnectionRequest/Response, OmbiStatusResponse, OmbiMappingsResponse,
//   OmbiRequesterMapping, OmbiMappingUpsertRequest, RequesterStatsResponse,
//   RequesterStatsRow, StaleItemRequestedBy (sections 2-7)
```

WS progress payload (mirror of the library sync event shape):

```ts
interface OmbiSyncProgressEvent {
  jobId: string;
  phase: 'movies' | 'tv' | 'resolve' | 'done' | 'error';
  progress: number | null; // 0-100, null = indeterminate
  error?: string;
}
```

---

## 9. Endpoint summary

| Method  | Path                              | Auth          | Cache    | Purpose                                    |
| ------- | --------------------------------- | ------------- | -------- | ------------------------------------------ |
| GET/PUT | `/settings` (+2 keys)             | owner         | —        | Configure connector                        |
| POST    | `/ombi/test-connection`           | owner         | —        | Validate URL+key pre-save                  |
| POST    | `/ombi/sync`                      | owner         | —        | Manual sync (202/409/400)                  |
| GET     | `/ombi/status`                    | owner         | —        | Sync health + coverage                     |
| GET     | `/ombi/mappings`                  | owner         | —        | Requester list + resolutions + suggestions |
| PUT     | `/ombi/mappings/:ombiUserId`      | owner         | —        | Set/force mapping (null = ignore)          |
| DELETE  | `/ombi/mappings/:ombiUserId`      | owner         | —        | Revert to auto-resolution                  |
| GET     | `/stats/requesters`               | authenticated | Redis 1h | Per-requester stats + unattributed bucket  |
| GET     | `/library/stale` (+`requestedBy`) | authenticated | existing | Attribution on Never Watched/stale rows    |
