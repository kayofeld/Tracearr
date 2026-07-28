# Acceptance log - <project>

Auditable record of every gate the coordinator accepted: the verdict, the verifiable evidence, the
reviewing agents, open items, and the sign-off. Append one entry per gate using
`templates/acceptance-record.md`. Applies to every engagement type (code, infra, governance, compliance).

<!-- newest entries at the bottom; never edit or delete a past record -->

---

---

## 2026-07-27 — Never Watched dashboard page (v1.7.0)

- **Increment:** New Library > Never Watched menu + page (/library/never-watched): never-played movies/series with date added + days on server, sortable/paginated/filterable table, stats (count, size, % of library, oldest item, 5-bucket age distribution, per-library breakdown). New `GET /library/never-watched` aggregate endpoint; additive `mediaTypes` filter on `/library/stale` (backward compatible). Branch `feat/never-watched-page`, 6 commits `0e5f2994..cbf2b180`, pushed to fork origin.
- **Verdict:** GO (coordinator), after review findings fixed and re-verified.
- **Lenses run:** qa-engineer (GO — 4/4 ACs, +9 mutation-verified tests) and code-reviewer (conditional NO-GO — 7 findings CR-1..CR-7, 2 High; all 7 fixed same cycle, coordinator re-verified CR-1 SQL parameterization + cache key directly). security-reviewer omitted: read-only analytics endpoint following the established authenticate + resolveServerIds pattern; the auth/scoping seam was explicitly covered by reviewer checks + 403/cache tests. ciso/legal omitted: no personal-data or legal-surface change.
- **Evidence:** server 3424 passed/161 files; web 155 passed/33 files (twice; one transient suite-level worker failure did not reproduce across 2 full reruns); shared 108; translations 32/32 locales; typechecks clean x3; pre-push hook re-ran full turbo typecheck+unit+translations green. Review record: docs/delivery/code-review-never-watched.md.
- **Open items (backlog, non-blocking):** persist library display names during librarySync (labels currently show section keys); align stale `libraryId` zod to string; stale `addedAt` non-ISO latent pattern; synthetic Jan-1 added-at dates inflate gt365/oldest.
- **Deferred scope:** mobile app surface; UI flagging of synthetic added-at dates.
- **Sign-off:** Coordinator (Claude, Fable 5). Release: versions bumped to 1.7.0 + CHANGELOG on the branch; merge --no-ff to fork main + tag v1.7.0 + push PENDING USER (session permission classifier blocked main-branch git operations; standing fork-direct authorization noted but not exercisable this session).

---

## 2026-07-28 — Ombi connector (v1.8.0)

- **Increment:** Optional Ombi integration attributing library items to whoever requested them. Mirrors Ombi requests (`ombi_requests` + `ombi_user_mappings`, migration 0067), resolves requesters (manual → provider → case-insensitive username → unattributed), and surfaces: `Requested By` on Never Watched, a per-requester statistics page, requested-but-never-watched on individual user profiles, and an owner-only settings panel with test-connection, manual sync, requester mapping and a disconnect-gated purge. Branch `feat/ombi-connector`, commits `db14ab9c..1252c794`.
- **Verdict:** GO.
- **Lenses run:** `security-reviewer` (GO — 0 Critical/High; 1 Medium decision item, 4 Low fixed), `code-reviewer` (GO — 0 Critical/High; 2 Medium + 5 Low, all fixed), `qa-engineer` (GO — 0 defects, +10 tests, 5 guards mutation-verified). ciso/legal not run: no new personal-data class (usernames only; emails deliberately not stored) and no legal surface.
- **Evidence (unit):** server 3529 passed/1 skipped file, web 178 passed, shared 108, translations 32/32 locales, three typechecks clean.
- **Evidence (live, production seedbox):** deployed at `1252c794`; migration 0067 applied at boot (67→68); sync mirrored **938 requests (658 movies + 280 TV), 0 skipped**; 834/938 matched a library item; attribution 778/938 (82.9%); routes verified registered and 401 unauthenticated including `DELETE /ombi/data`; per-user figures verified against real data (e.g. 196 matched items / 1081 GB for the top requester).
- **Defects found ONLY by live data (not by any fixture):** (1) `denied: null` rejected 100% of TV requests — a Zod `.default()` does not cover explicit null; (2) `releaseYear` on TV children is a date string, never a number. Both fixed, with a real-payload regression test (`ombi.realpayload.test.ts`, self-skipping without the capture).
- **Coordinator-initiated hardening:** placeholder `tvdb_id = 0` (9 rows, 9 distinct titles) guarded out of the match join — harmless today only because `library_items` never stores zero ids.
- **Accepted risks (owner-decided):** SEC-01 Ombi API key stored plaintext per repo convention (ADR 0005) — compensations: treat DB dumps/backups as secret material, rotate the key on backup leak; repo-wide secrets-at-rest encryption backlogged. PRIV-01 requester identity and wasted-storage visible to any authenticated user — accepted as all accounts are admin; revisit if `allowGuestAccess` is ever enabled.
- **Open items (non-blocking):** owner must map the ambiguous `draner` requester (two identities share the username; 142 requests currently unattributed) plus Azel/Neopier/Tiwoof. OMB-7 (a mapping edit during an in-flight sync is overwritten until the next run) accepted and documented.
- **Sign-off:** Coordinator (Claude, Fable 5), on live evidence above.

---

## 2026-07-29 — Watch-analytics init fix (`fix/timescale-toolkit-optional` @ 2dbf3394)

- **Verdict:** GO. Not merged — branch pushed, PR is the owner's to open.
- **Scope:** `/library/watch` and `/library/patterns` returned a failed query on a missing relation. Root cause was three steps upstream: `initTimescaleDB()` ran `CREATE EXTENSION timescaledb_toolkit` outside any try/catch; that statement needs superuser, so a least-privilege role made it throw and abort the rest of init — skipping the hypertable conversion, the continuous aggregates, and all seven engagement views. Toolkit is optional and nothing consumes it. Review then found the same silent-abort mode twice more in the same function (compression, aggregate creation), because the caller catches and continues.
- **Evidence:** on the dev instance, with the Toolkit extension still NOT installed, a restart created all 7 engagement views, 4 continuous aggregates and 2 hypertables; `/library/watch` and `/library/patterns` returned 200 with real data. Unit suite 49 files / 1441 tests. Each new guard test was proven non-vacuous by stripping its guard, observing the failure, and restoring it.
- **Reviewers:** `code-reviewer` (GO; found B1/B2, which are fixed here), `qa-engineer` (GO; flagged the fix shipped with zero coverage, which is now closed).
- **Deliberately unchanged:** `convertToHypertable()` stays unguarded — it is a genuine prerequisite, not an optional step.
- **Open item:** the caller at `index.ts:649` swallowing init errors means any FUTURE unguarded statement inherits the same silent-symptom class. Worth a lint or a structural change rather than repeated case-by-case guards.
- **Sign-off:** Coordinator, on the live evidence above.

## 2026-07-29 — Library display names + requester profile links (`feat/library-display-names` @ 9bf4f656)

- **Verdict:** GO. Not merged — branch pushed, PR is the owner's to open.
- **Scope:** Never Watched's "By library" breakdown showed raw server-side library keys. Adds a `libraries` dimension table (migration 0069), populated on sync, left-joined with a fallback to the raw key. Requester usernames now link to their profile. No contract change — `libraryName` and `userId` were already frozen.
- **Evidence:** server suite 3673 tests; web suite 208; integration suite against a real TimescaleDB **36 files / 264 tests**, which also rehearsed migration 0069 (table and unique index verified by inspection afterward). Live on dev: 6 libraries persisted with real names including the accented "Clips Vidéos"; the breakdown renders "Films"/"TV" in place of "3"/"5054"; requesters 16/16 carry a userId and the unattributed bucket is null, so no dead links.
- **Reviewers:** `code-reviewer` GO (1 Low), `qa-engineer` GO (3 Low). Both independently found the same top defect — `upsertLibraries` skipped the file's own `scrubStringFields` convention, so one null byte or one overlength name aborted the single multi-row INSERT and silently cost that server every display name on every sync. Fixed, with regression tests.
- **Tests added from QA's gap list:** two servers sharing a `library_id` (the JOIN fan-out case, previously unexercised anywhere) and the cache-invalidation pattern list, which no test covered at all — QA confirmed that dropping the never-watched key survived the entire suite.
- **Corrected during verification:** the rename integration test initially passed a comma-separated `serverIds`, which fails UUID validation and 400s before any SQL runs; and it had simulated a sync by writing only the database row, omitting the cache invalidation a real sync performs, so it read a stale name. Both fixed — the test now exercises the real invalidation path.
- **Known, not defects of this increment:** the ~91 s cold `/library/never-watched` query (pre-existing, still open); a stale-name window if a cold compute finishes after an invalidation (self-healing, pattern predates this change).
- **Sign-off:** Coordinator, on the live evidence above.

## 2026-07-29 — Emby-native first-run setup — DESIGN GATE FAILED (`feat/emby-native-setup`)

- **Verdict:** NO-GO to build as designed. No implementation written. Design revision in progress.
- **Why it matters:** the design's first-run gate asked whether an owner row exists. That is not the same as a fresh instance. An instance can be ownerless yet fully populated (support incident, partial restore, a deleted owner account), and in that state an attacker could supply their own Emby URL, be trivially admin on their own server, claim the instance, and use the existing owner-only `pg_dump` backup export to pull the database — including the real operator's plaintext Emby and Plex tokens. Three further High findings: a second `emby` server row makes `/emby/login`'s authority nondeterministic (`limit(1)` with no ORDER BY); the SSRF guard follows redirects and never resolves hostnames, and the error path echoes upstream status, making it an internal port scanner; and the index meant to fix the concurrent-owner race sat in a warn-and-continue path where its failure would be invisible.
- **Reviewer:** `security-reviewer` — 4 High, 4 Medium, 3 Low. It endorsed the architecture's shape and corrected the design in tracearr's favour on one point: pre-auth outbound probing is not new, since `/plex/connect` already does it with no SSRF check at all.
- **Owner decisions required before build:** claim code default-on plus persistence across restarts; in-app set-password surface versus CLI-only recovery (the design's stated mitigation does not exist — there is no HTTP surface, only `pnpm reset-password`); whether multiple Emby servers are supported; acceptance of the residual internal-probe exposure; and whether to fix `/plex/connect` in the same increment.
- **Sign-off:** gate not cleared; recorded as a blocked increment awaiting owner input.
