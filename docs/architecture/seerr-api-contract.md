# Seerr Connector — API Contract

**Status:** Frozen for build once the Wave 2 gate clears. **Additive-only relative to the
shipped v1.8.2 contract** — the v1.8.2 web client (and the mobile app) must keep working
against a server that carries these changes.
**Companion:** [seerr-connector.md](./seerr-connector.md) (design), ADRs 0006–0008;
Ombi contract: [ombi-api-contract.md](./ombi-api-contract.md) (unchanged on the wire).

Conventions are identical to the Ombi contract: routes under `/api/v1`; owner gating via
`app.requireOwner`; authenticated reads via `app.authenticate`; SSRF checks via
`assertSafeProbeUrl`. TypeScript below is ready for `packages/shared/src/types.ts` /
`constants.ts`; every new type MUST be re-exported through the package's public surface
(`packages/shared/src/index.ts` barrel) — an unreachable schema is not frozen.

---

## 1. Settings additions (existing endpoints, additive keys)

`GET /settings` / `PUT /settings` (owner) gain two keys on the existing `Settings` object:

```ts
// extend interface Settings
seerrUrl: string | null; // base URL, e.g. "https://seerr.myrtille.online"
seerrApiKey: string | null; // Seerr API key, sent as X-Api-Key; plaintext per ADR 0005,
// returned to owner like ombiApiKey/tautulliApiKey; MUST be redacted in logs
```

Defaults `null` in `PUBLIC_DEFAULTS`. Configured ⇔ both non-null. The settings PUT handler
enqueues one immediate sync on configure and invalidates the attribution/stats caches on
clearing (the fifth lifecycle transition), exactly like the Ombi keys.

Internal (never on the Settings object): `seerrSyncStatus` jsonb, written by the sync job,
read by `GET /seerr/status`.

---

## 2. `POST /seerr/test-connection` — validate before save

- **Auth:** owner. **Caching:** none.
- **Body** (tests the submitted values, not the saved ones):

```ts
interface SeerrTestConnectionRequest {
  url: string;
  apiKey: string;
}
```

- **Behavior:** `assertSafeProbeUrl(url)`, then **two calls**, 10s timeout each, no retries:
  1. `GET {url}/api/v1/status` — reachability + version. In the Overseerr lineage this
     endpoint is typically **unauthenticated**, so it cannot validate the key by itself
     (divergence from the coordinator's suggested single-call probe, reasoned).
  2. `GET {url}/api/v1/user?take=1` with `X-Api-Key` — key validity + admin scope; the
     paginated payload's `pageInfo.results` supplies `userCount`. Payload never returned.
- **Response 200:**

```ts
interface SeerrTestConnectionResponse {
  success: boolean;
  version?: string; // e.g. "3.4.0", from /status, present on success
  userCount?: number; // present on success
  error?: string; // human-readable cause (auth vs network vs bad URL)
}
```

Always 200 with `success:false` for remote-side failures; 400 only for malformed body /
SSRF rejection. (Same UX contract as `OmbiTestConnectionResponse`.)

---

## 3. `POST /seerr/sync` — manual sync trigger

Identical contract to `POST /ombi/sync`: owner; no body;
`202 { jobId: string }` | `409 { error }` (already queued/running) | `400 { error }`
(not configured). Progress via `GET /tasks/running` and the WS event (§8).

---

## 4. `GET /seerr/status` — connector + sync health

- **Auth:** owner. **Caching:** none.
- **Response 200:**

```ts
interface SeerrStatusResponse {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null; // ISO-8601
  lastSuccessAt: string | null;
  lastError: string | null;
  counts: {
    movieRequests: number; // media_requests rows, source='seerr', media_type='movie'
    tvRequests: number;
    total: number;
    skippedValidation: number; // records skipped in the last run
  };
  attribution: {
    matched: number; // match_method = 'provider' | 'username' (provider = external-id tier)
    manual: number;
    unattributed: number;
  };
  mediaMatch: {
    matched: number; // query-time join coverage, computed on demand
    unmatched: number;
  };
  purgeAvailable: boolean; // true iff disconnected AND source='seerr' rows remain
}
```

Same shape family as `OmbiStatusResponse` (which is unchanged; its counts become
source-scoped queries internally — no wire change).

---

## 5. User-mapping endpoints

### 5.1 `GET /seerr/mappings`

- **Auth:** owner. **Caching:** none.
- **Response 200:** one entry per distinct Seerr requester seen in `media_requests`
  (source='seerr'), plus stale override rows:

```ts
type SeerrRequesterResolutionType = 'manual' | 'provider' | 'username' | 'unattributed';
// 'provider' = matched via jellyfinUserId/plexId -> server_users (ADR 0008)

interface SeerrRequesterMapping {
  seerrUserId: string; // Seerr's numeric user id, as string (source_user_id)
  seerrUsername: string; // source_username (jellyfinUsername ?? plexUsername ?? username)
  seerrDisplayName: string | null; // source_alias (displayName)
  requestCount: number;
  resolution: {
    type: SeerrRequesterResolutionType;
    userId: string | null; // null for 'unattributed' and force-unattributed overrides
    username: string | null; // Tracearr users.username for display
  };
  ambiguous: boolean; // auto-match refused (multi-candidate external id or username)
  suggestions: Array<{ userId: string; username: string }>;
  stale: boolean; // override exists but requester absent from Seerr
}

interface SeerrMappingsResponse {
  requesters: SeerrRequesterMapping[];
}
```

### 5.2 `PUT /seerr/mappings/:seerrUserId`

```ts
interface SeerrMappingUpsertRequest {
  userId: string | null; // users.id; null = force-unattributed
}
```

Upsert into `media_request_user_mappings` (source='seerr'); immediately re-resolve that
requester's rows through the **full** pipeline (manual → persisted external id → username —
ADR 0008) and invalidate `LIBRARY_STALE` + requester-stats caches.
Responses: `200 { updated: number }` | `404` unknown `userId` | `400` malformed.

### 5.3 `DELETE /seerr/mappings/:seerrUserId`

Remove the override; re-resolve automatically; same invalidation.
Responses: `200 { updated: number }` | `404` no override.

### 5.4 `DELETE /seerr/data` — purge mirrored data

Same contract as `DELETE /ombi/data`: owner; `409` while still configured; deletes all
`media_requests` and `media_request_user_mappings` rows **where source='seerr'** in one
transaction; invalidates the attribution/stats caches.

```ts
interface SeerrPurgeResponse {
  deletedRequests: number;
  deletedMappings: number;
}
```

---

## 6. `GET /stats/requesters` — now spans both sources (additive changes)

Same endpoint, same auth, same query params (`serverId`/`serverIds`, `mediaType`), same
caching keys. The dataset is `media_requests` scoped to the **currently-configured source
set** (design §4.4): a disconnected source's retained rows stay invisible, preserving shipped
behavior when only Ombi is configured bit-for-bit.

Additive/semantic changes to the shipped shapes:

```ts
// RequesterStatsRow: UNCHANGED (rows merge across sources by resolved user_id;
// statusCounts vocabulary unchanged - Seerr ints are mapped at sync, design §4.1).

// RequesterStatsResponse - one semantic generalization + one additive field:
interface RequesterStatsResponse {
  // ... all shipped fields unchanged ...
  /** GENERALIZED semantics: true iff AT LEAST ONE request connector (ombi or seerr)
   *  is configured. Shipped meaning ("ombi configured") is the degenerate case;
   *  v1.8.2 clients use this only to hide the page - still correct. */
  configured: boolean;
  /** NEW, optional: per-source configuration breakdown for newer UIs. */
  configuredSources?: { ombi: boolean; seerr: boolean };
}
```

Cross-source correctness (informative, tested at Verify): one human resolved from both
sources = one row (grouping is `user_id`); the same media item requested in both sources is
counted once in size/never-watched math (item-level dedup, shipped CTE); `requestCount`
counts both request rows (two requests were genuinely made); the unattributed bucket spans
both sources.

---

## 7. Attribution on library rows — `StaleItemRequestedBy` (additive changes)

```ts
interface StaleItemRequestedBy {
  userId: string | null;
  username: string | null;
  /** LEGACY NAMES, kept for wire compatibility (shipped in v1.8.0): these carry the
   *  SOURCE-SIDE raw username/alias for WHICHEVER source attributed the row -
   *  Ombi userName/alias, or Seerr jellyfinUsername/displayName. Clients keep
   *  rendering `ombiAlias ?? ombiUsername`. Renaming would break the frozen shape;
   *  duplicating under generic names is clutter without a consumer. */
  ombiUsername: string;
  ombiAlias: string | null;
  requestedAt: string; // earliest matching request - now across all configured sources
  otherRequesterCount: number; // distinct OTHER requester identities across sources,
  // deduped by resolved user_id (design §4.4)
  /** WIDENED union (was 'ombi'). Sanctioned widening: shipped as a future-proofing
   *  discriminator for exactly this purpose. Runtime-additive for JS clients; in-repo
   *  TS consumers doing exhaustive switches recompile together with this change. */
  source: 'ombi' | 'seerr';
}
```

No other `StaleItem` change. The join runs only when at least one source is configured;
zero configured sources keeps the shipped NULL-literals fast path.

Known cosmetic caveat (accepted, documented): a stale v1.8.2 client (e.g. an un-updated
mobile app) that hardcodes Ombi wording in labels would show a Seerr requester under an
"Ombi" label. It has the `source` field to branch on; newer clients use it.

---

## 8. Shared constants and types (additions)

```ts
// packages/shared/src/constants.ts
WS_EVENTS.SEERR_SYNC_PROGRESS = 'seerr:sync:progress'; // payload mirrors OmbiSyncProgressEvent
// REDIS_KEYS.OMBI_REQUESTER_STATS is REUSED for the merged stats cache (legacy name,
// internal only - renaming would orphan keys for zero wire benefit; documented here).

// packages/shared/src/types.ts
export type RunningTaskType =
  | 'library_sync'
  | 'tautulli_import'
  | 'jellystat_import'
  | 'maintenance'
  | 'ombi_sync'
  | 'seerr_sync'; // += 'seerr_sync'

interface SeerrSyncProgressEvent {
  jobId: string;
  phase: 'count' | 'fetch' | 'resolve' | 'done' | 'error';
  progress: number | null; // 0-100, null = indeterminate
  error?: string;
}

// + Settings gains seerrUrl / seerrApiKey (§1)
// + SeerrTestConnectionRequest/Response, SeerrStatusResponse, SeerrMappingsResponse,
//   SeerrRequesterMapping, SeerrMappingUpsertRequest, SeerrPurgeResponse,
//   SeerrRequesterResolutionType, SeerrSyncProgressEvent (§2-5, §8)
// + RequesterStatsResponse.configuredSources (§6)
// + StaleItemRequestedBy.source widened to 'ombi' | 'seerr' (§7)
// ALL of the above re-exported via packages/shared/src/index.ts (export-completeness rule).
```

Ombi wire types (`Ombi*`, `RequesterStatsRow`, endpoint shapes in
[ombi-api-contract.md](./ombi-api-contract.md)) are unchanged.

---

## 9. Endpoint summary

| Method  | Path                             | Auth          | Cache    | Purpose                                    |
| ------- | -------------------------------- | ------------- | -------- | ------------------------------------------ |
| GET/PUT | `/settings` (+2 keys)            | owner         | —        | Configure connector                        |
| POST    | `/seerr/test-connection`         | owner         | —        | Validate URL+key pre-save (2-call probe)   |
| POST    | `/seerr/sync`                    | owner         | —        | Manual sync (202/409/400)                  |
| GET     | `/seerr/status`                  | owner         | —        | Sync health + coverage + purgeAvailable    |
| GET     | `/seerr/mappings`                | owner         | —        | Requester list + resolutions + suggestions |
| PUT     | `/seerr/mappings/:seerrUserId`   | owner         | —        | Set/force mapping (null = ignore)          |
| DELETE  | `/seerr/mappings/:seerrUserId`   | owner         | —        | Revert to auto-resolution                  |
| DELETE  | `/seerr/data`                    | owner         | —        | Purge seerr rows (only while disconnected) |
| GET     | `/stats/requesters` (changed §6) | authenticated | Redis 1h | Merged per-requester stats across sources  |
| GET     | `/library/stale` (changed §7)    | authenticated | existing | Attribution from any configured source     |
