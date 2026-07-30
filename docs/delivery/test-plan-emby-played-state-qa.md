# QA Test Plan — Emby/Jellyfin Played-State Sync (increment 1)

**Branch:** `feat/emby-played-state` — pinned SHA `6251d981`
**Spec:** `docs/architecture/emby-played-state-sync.md` §2, §5, §6, §7, §10; ADR 0010, ADR 0011
**Author:** qa-engineer, 2026-07-30
**Scope note:** Playback Reporting ingest (ADR 0012), §5.4 session-only routes, review findings
F2/F4 are deferred by design and are NOT tested as defects here.

## Context

The engineering gate (typecheck, lint, 3,911 server unit tests, 271 integration, 286 web tests) was
already verified by the coordinator at this SHA on a fresh database, and two review lenses returned GO
with their findings fixed. This plan covers only what that coverage did NOT: the review fixes'
guards, aggregate self-consistency, replay semantics, and the authorization oracle.

## Risks probed, test level, and where the tests live

| #   | Risk                                                                                                                                                                          | Level                                     | Test                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CR-1 fix regression: multi-page `syncUser` where the parser drops a row on a full page — offset drift would strand and then prune the tail                                    | Integration (real DB, mocked HTTP client) | `test/integration/playedStateQa.integration.test.ts` — "pages on the raw row count..." (guard verified non-vacuous by mutation: reverting to parsed-length paging makes it fail) |
| 2   | Mirror replay: sync twice must be a no-op; un-marking an item must remove exactly that row                                                                                    | Integration                               | same file — idempotency describe block                                                                                                                                           |
| 3   | Aggregate self-consistency in `neverWatched.ts`: totals vs byMediaType vs byLibrary vs ageDistribution (count AND sizeBytes) must move together when an item flips to watched | Integration (real SQL via route inject)   | same file — aggregate consistency describe block                                                                                                                                 |
| 4   | `stale.ts` pagination: exclusions straddling a page boundary; `summary_stats` = `pagination.total` = union of returned rows; empty-page duplicated query path agrees          | Integration                               | same file — stale boundary describe block                                                                                                                                        |
| 5   | Coverage honesty (ADR 0011): `error` run must NOT count as coverage; success counts; any Plex server forces `full: false`                                                     | Integration                               | same file — coverage honesty describe block                                                                                                                                      |
| 6   | F1 fix regression: existence/type oracle on POST /played-state/sync for a scoped admin; sync-all owner-only                                                                   | Unit (route with mocked queue)            | `src/routes/library/__tests__/playedState.test.ts`                                                                                                                               |

## Already covered elsewhere (verified by reading, not re-run)

- Per-user failure isolation, prune-on-success, Plex no-status-row: `test/integration/playedStateSync.integration.test.ts`
- Predicate correctness (movie + show roll-up), Plex `unsupported` coverage in response, stale.ts
  single-item exclusion + both query paths agreeing: `test/integration/playedStatePredicate.integration.test.ts`
- Web banner semantics (absent → no banner; `full: true` → no banner; `full: false` → banner + "No
  recorded plays" copy swap): `apps/web/src/pages/library/NeverWatched.test.tsx`,
  `PlayedStateCoverageBanner.test.tsx`, `StaleContentTabs.test.tsx`
- Parser unit fixtures (Emby/Jellyfin raw rows): `baseMediaServerClient.playedItems.test.ts`
- Cache invalidation pattern list: `jobs/__tests__/playedStateSyncQueue.test.ts`

## Known / out of scope

- Pre-existing (NOT this diff): `neverWatched.ts` totals de-duplicate shared items while per-row
  values don't.
- Jellyfin live-instance verification: spec §3 marks the Jellyfin path inferred-from-shared-API;
  a recorded fixture exists in the parser tests. No live Jellyfin was available to QA.

## Environment / run conditions

- Fresh test DB: `docker compose -f docker/docker-compose.test.yml down -v && up -d`
  (timescale on 5433, redis on 6380), migrations applied by the test setup.
- Suites run serially (`fileParallelism: false`, `singleFork` — enforced by
  `vitest.integration.config.ts`); one vitest process at a time.
- Command: `pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts <filter>`

## Results

See `docs/delivery/defects-emby-played-state-qa.md` and the QA verdict returned to the coordinator.
