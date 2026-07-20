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

## 3. SPIKE DONE — Emby native real-time (no plugin)

Spike validated live 2026-07-20: `/embywebsocket` + `SessionsStart` pushes full session
snapshots (~2s cadence, same shape as GET /Sessions — reuses the existing parser). Two
caveats (subscribe race at onopen; snapshot-not-delta bandwidth). ADR:
`docs/architecture/adr/0001-emby-native-websocket-for-realtime.md`. GATE before building:
upstream requires features to be discussed first (Discussions/Discord) — Paul to open the
Discussion; implementation only after maintainer buy-in.

## 4. TODO — Beta features validation (added by Paul 2026-07-20)

Strong validation, consolidation, and checks for Tracearr's beta-flagged features.
First step: inventory which features are flagged beta (repo grep + UI), define per-feature
validation criteria (functional checks, edge cases, data correctness), consolidate findings,
then fix/harden per finding. Needs scoping before it becomes branches.

## Parking lot (from security review of PR 1, out of scope there)

- `buildStaticAuthHeader` interpolates the token unescaped into the MediaBrowser header (all callers, fails closed).
- Custom `X-Emby-Authorization` header survives cross-origin redirects (undici strips only `authorization`/`cookie`); consider `redirect: 'error'` for verify probes.
- Emby OpenAPI version cited in comments (4.1.1.0) predates current Emby 4.9.x; periodic compatibility pass.
