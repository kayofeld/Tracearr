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

## 2026-07-27 — Never Watched dashboard page (v1.7.0 cycle)

- 2026-07-27T20:35Z [Explore x2 Start/End] Parallel scouts (server data layer, web nav/pages) both clean; server scout surfaced that /library/stale already computes never_watched + that library_items.created_at IS the media-server addedAt (naming trap), web scout produced the exact minimal change-list. High-value pre-design fan-out.
- 2026-07-27T20:50Z [coordinator] API contract frozen in packages/shared (b321adfa) before Build fan-out; freeze-before-fork honored.
- 2026-07-27T21:05Z [backend-engineer Start] Brief clear; contract pointers exact. Gap found: coordinator's freeze commit missed the shared BARREL exports (schema unreachable via package public surface). Engineer fixed additively (2 lines) + rebuilt shared dist; flagged for ratification (coordinator ratified at fan-in — correct call).
- 2026-07-27T21:14Z [backend-engineer End] 10/10 route tests (first-ever routes/library tests), typecheck+lint clean. Lesson: freezing a contract in a shared package must include verifying it is exported via the package's public surface (barrel + exports field) — add an export-completeness check to the freeze step. Also: shared/dist is gitignored; engineers bypassing turbo ^build must rebuild shared first.
- 2026-07-27T21:16Z [frontend-engineer Start] Brief thorough, no blockers.
- 2026-07-27T21:16Z [frontend-engineer End] Page+nav+i18n(32 locales)+4 tests green; tsc/eslint/translations:check clean. Lesson: mocking a consumed component barrel does NOT shield a test from OTHER exports of the same barrel importing heavy deps (highcharts vs jsdom) — mock the heavy lib itself when importing @/components/library or charts barrels in tests.
- 2026-07-27T21:19Z [coordinator] Fan-in: re-ran all gates on merged tree (10/10 server, 4/4 web, translations 32/32, 3x typecheck), checkpoint-committed 630cbfa2 + be158b61; Verify wave (qa-engineer + code-reviewer) dispatched in parallel.
- 2026-07-27T21:31Z [qa-engineer Start/End] Brief clear; scope bounds right (server config already excludes integration tests — check config before planning skips). Verdict GO: 4/4 ACs, shared 108 / server 3420(+4 QA) / web 149(+5 QA) green, translations 32/32; +9 QA tests, guards mutation-verified. 2 low observations (library-name = server name inherited; libraryId schema divergence).
- 2026-07-27T21:34Z [code-reviewer Start/End] Verdict NO-GO conditional: CR-1 High (stats vs table scope mismatch incl. 'artist'), CR-2 High (filtered empty state unmounts tabs), CR-3/4 Med (libraryName=server name; oldestAddedAt non-ISO), CR-5/6/7 Low. Six critical checks clean. Lesson: when a new read-model pairs with an existing endpoint, the brief must state whether PAIR CONSISTENCY is in scope — "stale endpoint deferred" nearly buried a user-visible inconsistency. Coordinator verified CR-1/2/3 against code (confirmed) and authorized the additive stale change.
- 2026-07-27T21:40Z [coordinator] QA GO + reviewer NO-GO divergence resolved by verifying claims: fix round dispatched (backend: stale mediaTypes param + ISO + library_id label; frontend: scope match, filtered-empty fix, label/column, page reset, tooltip). Review saved to docs/delivery/code-review-never-watched.md.
- 2026-07-27T21:55Z [backend-engineer End, fix round] 4 fixes (stale mediaTypes param + cache key, ISO oldestAddedAt, library_id label, schema comment); 14/14 library route tests. Lesson: passthrough-style QA mocks don't force fixture churn on data-shape fixes.
- 2026-07-27T21:57Z [frontend-engineer End, fix round] 5 fixes (scope match, filtered-empty keeps tabs + honest copy, truthful library labels + column drop, page reset on server change, tooltip category+size); 19 web tests green. Lesson: frontend tsc reads packages/translations dist, not src — rebuild translations before typecheck after locale-key changes (add to future briefs).
- 2026-07-27T22:02Z [coordinator] Re-verified merged tree: server 3424/161, web 155/33 x2 (one transient suite-level worker failure, not reproduced), shared 108, translations 32/32, typechecks x3. Committed fix round + docs; bumped v1.7.0 + CHANGELOG; pushed feat/never-watched-page (pre-push hook = full monorepo gate, green). Merge to fork main + tag blocked by session permission classifier despite standing fork-direct authorization — handed to Paul with exact commands. Acceptance record appended.
- 2026-07-27T22:02Z [observation] External tooling (GitKraken hook or user) rebase-reworded mid-cycle to strip AI attribution trailers — trees identical, verified by empty diff; commit-hash drift is expected on this repo and must be re-checked before referencing hashes.
