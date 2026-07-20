# Tracearr contribution backlog (kayofeld fork)

Ordered. Model (2026-07-20): fork-direct — feature branch → gates + Fable review → merge --no-ff into kayofeld/Tracearr main. No upstream PRs; Claude never opens PRs. The pr-*.md handoff docs in delivery/ are kept only in case Paul later decides to upstream a change.

## 1. MERGED to fork main (6a6dc2f4) — Emby admin-verify robustness

Branch `fix/emby-admin-verify-robustness`, pushed to fork. Fable-reviewed (GO), live-validated
on Emby 4.9.5. PR text: `docs/delivery/pr-1-emby-admin-verify.md`.

## 2. MERGED to fork main (6a6dc2f4) — User delete / resync from the view

Branch `feat/users-remove-and-resync`, pushed to fork. Fable-reviewed (GO, 2 low findings
fixed, 3 accepted-as-is documented). PR text: `docs/delivery/pr-2-users-remove-resync.md`.
Original scope note below.
Paul's report: users deleted on his Emby server still show in Tracearr.
Root cause (verified in code): user sync only auto-runs at server-add time; the existing
`POST /servers/:id/sync` (which marks absent users `removedAt`, list hides them) is only
surfaced as a button in Server Settings, and there is no per-user delete endpoint (only a
debug delete-all). Scope:

- Per-user delete endpoint (owner-only) + row action w/ confirm in the Users page.
- "Resync users" action surfaced on the Users page (reuse existing endpoint + hook).
- Live validation against draner.pet (48 users; deleted-on-Emby users should disappear after resync).

## 3. MERGED (opt-in) — Emby native real-time (no plugin)

Branch `feat/emby-native-websocket`. `JellyfinEmbyWebSocketSource` diffs `SessionsStart`
snapshots and emits the same `session:event` trigger as the SSE plugin (drop-in; reuses the
whole poll pipeline). Gated behind `TRACEARR_NATIVE_WS_ENABLED` (default off). 15 unit tests.
ADR `docs/architecture/adr/0001-...`. REMAINING: live end-to-end validation — flip the flag on
Paul's instance, confirm sessions flow WS→DB, then make it the default fallback tier + add a
third connection-status UI state.

## 4. TODO — Beta features validation (added by Paul 2026-07-20)

Strong validation, consolidation, and checks for Tracearr's beta-flagged features.
**Inventory done (2026-07-20)** — the beta-flagged surfaces are:

- **Backup / restore** (`components/settings/BackupSettings.tsx`, 3 BETA badges; `routes/backup.ts`,
  `jobs/backupQueue.ts`) — highest-risk beta (data safety): backup create/upload/restore + schedule.
- **Data import** (`components/settings/ImportSettings.tsx`; Tautulli + Jellystat; `routes/import.ts`,
  `services/tautulli.ts`, `services/jellystat.ts`) — incl. "(BETA)" stream-detail enrichment.
- **Mobile beta mode** (`routes/mobile.ts` `MOBILE_BETA_MODE`) — reusable tokens, no expiry, unlimited
  devices; security-sensitive (validate it can NEVER be on in a real deployment by accident).
- **Beta update channel** (`components/layout/{AppSidebar,UpdateDialog}.tsx`, `jobs/versionCheckQueue.ts`
  prerelease handling) — opting into alpha/beta/rc updates.
- (Adjacent) **Rules V2 migration** preview (`routes/rules.ts` `/migrate/preview`) — migration correctness.

Per-feature: define validation criteria (functional happy-path, edge/failure cases, data-correctness &
idempotency, security posture), consolidate into a checklist doc, then fix/harden per finding. Backup/restore
and import (data-integrity) rank first. Each becomes its own branch. Ready to start on Paul's go.

## 6. TODO — Version listener tracks the fork, not upstream (added by Paul 2026-07-20)

`jobs/versionCheckQueue.ts` hardcodes `connorgallopo/Tracearr` in 3 constants
(GITHUB_API_LATEST_URL / GITHUB_API_ALL_RELEASES_URL / GITHUB_RELEASES_URL). Make the repo
slug env-configurable (`TRACEARR_UPDATE_REPO`, default `connorgallopo/Tracearr`) and build the
3 URLs from it, so Paul points it at `kayofeld/Tracearr`. Small, self-contained, unit-testable —
good standalone branch. Note: the fork must publish GitHub releases for release-based checking to
find anything; if the updater is git-pull-based (item 7), the version compare may instead track
the fork's default-branch commit/tag. Confirm which signal Paul wants (releases vs branch head).
(`routes/public.openapi.ts:822` also hardcodes the upstream URL — cosmetic, fix alongside.)

## 7. TODO — In-app "Update" button (added by Paul 2026-07-20)

An update control in the UI (owner-only) that triggers the update flow (item 5's script:
git pull already done or done by the button? decide — likely button runs pull + update.sh via a
privileged local runner). Ties directly to item 5 (the script) and item 6 (knowing an update is
available). Design questions: how the web/server process invokes a host-level update safely
(the server can't `git pull` + restart itself cleanly while running); likely a small
supervisor/systemd unit or a detached updater the button signals. Needs item 5's runtime-manager
decision first. Security: owner-only, no arbitrary command exposure.

## 5. TODO — Docker-free deployment + git-pull update script (added by Paul 2026-07-20)

Paul runs the ORIGINAL solution deployed directly on a target machine (no Docker). Wants:
`git pull` then run one update script that brings the install fully up to date every time —
systematically, no manual steps. The script MUST be kept current as the app evolves (new
dependency, migration, build step → the script covers it). Scope to design:

- A single `scripts/update.sh` (+ Windows counterpart if the target is Windows — confirm OS)
  that is idempotent and safe to re-run: pull already done by Paul, then: install deps
  (`pnpm install --frozen-lockfile`), build workspace packages + apps (`pnpm build`), run DB
  migrations (find the migration runner — drizzle; there's `docker/init-timescale.sql` +
  drizzle migrations under apps/server), rebuild translations, restart the service
  (systemd? pm2? — confirm how the non-Docker install is run/kept alive).
- Bare-metal runtime prerequisites doc: Node >=22, pnpm >=11.8, Postgres+TimescaleDB, Redis
  (currently provided by docker-compose — the non-Docker target needs these installed/running).
- A migration step that is authoritative (fails loudly, never silently skips) and a documented
  rollback. Env via a real `.env` (not compose).
- KEY CONSTRAINT: the update script is part of the definition-of-done for future changes —
  whenever a change adds a dependency/migration/build/asset step, update.sh must be amended in
  the same change. Encode this as a repo rule once the script exists.
  Needs an OS/runtime-manager confirmation from Paul before building (systemd vs pm2 vs bare node;
  which host OS).

## Parking lot (from security review of PR 1, out of scope there)

- `buildStaticAuthHeader` interpolates the token unescaped into the MediaBrowser header (all callers, fails closed).
- Custom `X-Emby-Authorization` header survives cross-origin redirects (undici strips only `authorization`/`cookie`); consider `redirect: 'error'` for verify probes.
- Emby OpenAPI version cited in comments (4.1.1.0) predates current Emby 4.9.x; periodic compatibility pass.
