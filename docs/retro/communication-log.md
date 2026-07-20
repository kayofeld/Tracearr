# Communication log - <project>

Chronological, append-only record of inter-agent communication feedback. The **coordinator** appends a
timestamped START and END entry for every agent task (format: `templates/feedback-entry.md`). The focus is
**what worked and (especially) what didn't work in the communication/handoffs between agents** - this log is
the raw material for `/retrospective`.

<!-- newest entries at the bottom; never edit or delete past entries -->

## 2026-07-20 — Emby improvement cycle (coordinator-direct + Fable QC)

- 2026-07-20T16:10Z [digest] Branch 1 `fix/emby-admin-verify-robustness`: coordinator implemented (parity w/ Jellyfin reference), security-reviewer (Fable) GO w/ 4 low/nit; F1 closed empirically vs live Emby 4.9.5 (/Users/Me w/ API key = 500, not 400), F4 tests added; 12/12 unit, pushed to fork. PR text in delivery/pr-1.
- 2026-07-20T16:30Z [digest] Branch 2 `feat/users-remove-and-resync`: root cause = user sync only at server-add; added owner-only POST /users/bulk/remove + Users-page remove action + Sync users button; gates 549 routes/145 web/typechecks/build/translations green; Fable GO (F1 copy + F2 >1000 guard fixed; F3/F4/F5 accepted-documented); pushed. PR text in delivery/pr-2.
- 2026-07-20T16:35Z [digest] Branch 3 spike: native /embywebsocket + SessionsStart validated live (snapshots ~2s, existing parser shape, no plugin); subscribe-race + snapshot-size caveats; ADR 0001 written; blocked on upstream Discussion (Paul).
- Lessons: (a) verify-before-build killed 2 of 3 planned fixes (#2 pause timing already handled, #3 DirectStream not a bug) — the assessment-then-verify loop saved two useless PRs; (b) reviewer asked for observed-not-inherited status codes — live probe found the comment was wrong (500 vs 400); (c) user rule recorded: never open PRs, prepare handoff text instead.

## 2026-07-20 (cont.) — native-WS + version-listener merged; fork-direct model

- [digest] Branch 3 (feat/emby-native-websocket) Fable-reviewed: GO flag-off, H1(jellyfin keepalive)/M1(false plugin-nag)/M2(api-key leak via ctor error)/L2/L3/N1/N2 fixed, tests 15→22. Merged 2ed41fb1.
- [digest] Item 6 (version listener → TRACEARR_UPDATE_REPO, slug-validated) built+tested (4 tests), merged 4c05b7bc. Both pushed to fork main; combined gates green (1425 unit/544 routes/2149 services/145 web).
- [digest] Model switched to FORK-DIRECT: merge --no-ff to kayofeld/Tracearr main, no upstream PRs, Claude never opens PRs.
- Lessons: (a) branch-switching mid-review caused a reviewer false-negative (.env.example L4) — keep the branch checked out while its review runs; (b) reviewer hit Grep false-negatives on the linked repo path — brief review agents to prefer Read/Glob (CLAUDE.md linked-path rule); (c) heartbeat(15s)<keepalive(30s) interaction surfaced only in tests w/o ongoing frames — realistic tests must pump frames.

## 2026-07-20 (cont.) — full improvement review + HIGH security fix

- [digest] Fable improvement review (6 areas, ranked top-10). Report: docs/architecture/improvement-review-2026-07-20.md.
- [digest] X3 HIGH found + VERIFIED exploitable: unauth /images/proxy string-concatenated client `url` into upstream URL → `@evil.com/x` hijacks host, exfiltrates media-server token. Fixed via resolveSameOrigin (origin-lock, preserves base paths) + redirect:'error'; 7 tests. Merged c4a8943b, pushed.
- Corrected the reviewer's suggested fix (assertSafeProbeUrl would block the legitimate INTERNAL media server) — origin-lock is the right guard. Verify-before-action caught it.
- Lesson: "improvement lens" review still surfaced a real HIGH security bug — worth running security-reviewer on improvement passes.
