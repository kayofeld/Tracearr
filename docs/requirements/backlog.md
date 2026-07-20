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
First step: inventory which features are flagged beta (repo grep + UI), define per-feature
validation criteria (functional checks, edge cases, data correctness), consolidate findings,
then fix/harden per finding. Needs scoping before it becomes branches.

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
