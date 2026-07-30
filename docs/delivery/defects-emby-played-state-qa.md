# QA Defect Log — Emby/Jellyfin Played-State Sync (increment 1)

**Branch:** `feat/emby-played-state`, SHA `6251d981` | **QA:** qa-engineer, 2026-07-30
**Test plan:** `docs/delivery/test-plan-emby-played-state-qa.md`

## DEF-PS-1 — Zero-resolved-users run publishes a "Sync complete" progress event while persisting status `error`

- **Severity:** Low
- **Status:** Open (does not block release — see impact)
- **Where:** `apps/server/src/services/playedStateSync.ts` (`syncServer` finalize block, ~lines 257–269)
- **Reproduction (verified against a real run, fresh test DB at SHA 6251d981):**
  1. Emby server with one media-server user that has no matching `server_users` row
     (`getUsers` returns a user, resolution skips it).
  2. `playedStateSyncService.syncServer(serverId, onProgress)`.
- **Expected:** The review fix makes this run finalize as `error` ("No media-server users could be
  resolved (1 skipped); run the user sync first.") so it cannot claim coverage. The final progress
  event pushed over `WS_EVENTS.PLAYED_STATE_SYNC_PROGRESS` should carry the same truth
  (`status: 'error'` with the error message), and `PlayedStateSyncResult.error` should carry it too.
- **Actual (captured from the run):** status row = `error` with the honest message (correct), but the
  final WS progress event is `{"status":"complete", "message":"Sync complete: 0/0 users, 0 items
upserted, 0 pruned", ...}` with no `error` field, and the returned `PlayedStateSyncResult.error` is
  `null` (the return only forwards `lastError` for `partial` runs).
- **Impact:** Live WS consumers are told the sync completed while the persisted status says it
  failed. The current web UI is shielded by accident: `PlayedStateSettings` treats `complete` and
  `error` identically (refetch status) and the card badge renders from the persisted row, so users
  end up seeing the error. Any other consumer of the progress stream (future mobile surface, the
  running-tasks toast) would be misled. The coverage-honesty guarantee itself (ADR 0011) is NOT
  affected — verified separately that `buildPlayedStateCoverage` reports no coverage for this server.
- **Suggested fix:** In the finalize path, when `finalStatus === 'error'` emit the `error`-shaped
  progress event (as `finalizeError` already does for server-level failures) and set
  `result.error = finalError` for both `partial` and `error` outcomes.

## Observations (not defects)

- **OBS-1 — Zero-access coverage asymmetry:** for a non-owner with zero accessible servers,
  `stale.ts`'s empty short-circuit embeds `playedStateCoverage: { servers: [], full: false }` while
  `neverWatched.ts`'s empty path omits the field entirely. No user-visible effect today: the banner
  returns `null` when the uncovered list is empty, and the page's "no data" copy swap reads coverage
  from the never-watched response (absent → normal copy). Flagging so the seam does not drift later.
- **OBS-2 — Integration tests are not typechecked:** `apps/server/tsconfig.json` includes `src/**/*`
  only, so nothing under `test/integration/` (this increment's included) passes through
  `tsc --noEmit`; vitest transpiles without checking. Pre-existing repo posture, not this diff.
- **OBS-3 (pre-existing, per brief):** `neverWatched.ts` totals de-duplicate shared items while
  per-row values don't — out of this increment's scope.
