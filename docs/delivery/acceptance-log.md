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
- **Reviewer:** `security-reviewer` — 4 High, 4 Medium, 3 Low. It endorsed the architecture's shape.
- **Correction (verified against the code, 2026-07-29):** the review stated that `/plex/connect` performs a pre-auth probe "with no SSRF check at all". That is wrong — `PlexClient.verifyServerAdmin` calls `assertSafeProbeUrl` first (`services/mediaServer/plex/client.ts:629`). The finding survives only in the narrower form the Emby path also had: literal-only validation, redirects followed, no connect-time re-validation. Owner decision 5 is restated on that basis. Recorded because the original claim was relayed before it was checked.
- **Design rev 2 (`389188f9`) resolves the architect-owned findings**, replacing the single owner-row check with a three-state model (unclaimed / ownerless-with-data / owned); a client-supplied URL is accepted only while genuinely unclaimed, and an instance that lost its owner but kept its data is a refused recovery state.
- **Scope grew for a good reason:** the revision found that refusing setup in the recovery state would have BRICKED the instance — `scripts/reset-password.ts` bails when no owner row exists and there is no promote-owner command, so the legitimate operator would have had no door either. A `promote-owner` CLI command is now part of the increment. Refusing an attacker is only correct if the operator has a recovery path.
- **Contract surface changed:** an `EmbySetupErrorCode` union plus three mirrors (server mapper, client copy map, the error table), forced by the requirement that no upstream status text reaches the client. Enumerated in the freeze checklist.
- **Owner decisions required before build (6):** claim code default-on plus persistence across restarts and single-use; in-app set-password surface versus CLI-only recovery (the design's stated mitigation does not exist — there is no HTTP surface, only `pnpm reset-password`); whether multiple Emby servers are supported (two designs specified, A: partial unique index, B: an `is_auth_authority` column); acceptance of the residual internal-probe exposure; whether to harden `/plex/connect` in the same increment; and whether the unclaimed gate should extend to `/sign-up/username` and OIDC.
- **Sign-off:** gate not cleared; recorded as a blocked increment awaiting owner input.

---

## 2026-07-30 — Played-state mirror (Never Watched correctness)

**Increment:** per-user played-state sync from Emby/Jellyfin, correcting the "Never Watched"
analytics. Branch `feat/emby-played-state`, verified at `45e814c4`.

**Why:** Never Watched derived its answer purely from tracearr's own `sessions` table, which
only covers the period since tracearr was installed. Measured read-only against the owner's
production instance: of 1,160 items flagged never-watched, **472 (41%) had in fact been
watched** — 293 movies, 179 shows. 856 of the flagged items predate any session data at all,
so for those the page was asserting a fact it had no basis for.

**Verdict: GO for merge. NOT yet accepted as fixed in production** — see open items.

**Evidence** (every run below on a freshly created database unless stated, at `45e814c4`):

- `turbo run typecheck --force` — 9/9 packages, uncached.
- `turbo run lint --force` — 9/9, 0 errors (pre-existing warning baseline unchanged).
- `pnpm --filter @tracearr/server test` — 3,911 passed, 4 skipped.
- Integration suite (real Postgres, database dropped and recreated first) — 38 files, 271 passed.
- `pnpm --filter @tracearr/web test` — 50 files, 286 passed.
- Migration 0071 applied to a fresh database; both tables, all four indexes (including the
  partial one on `series_rating_key`) and both cascades confirmed present. A second
  `drizzle-kit generate` reported no schema changes, proving the snapshot chain intact.
- Contract reachability: every frozen member imported through the package barrel exactly as a
  consumer would, with a deliberate negative control confirming the check was not vacuous.

**Reviewing agents:** `code-reviewer` (GO — 0 critical, 0 high, 3 medium, 4 low),
`security-reviewer` (GO — 0 critical, 0 high, 1 medium, 4 low). Both pinned to a stated SHA.
`qa-engineer` **did not run** — four dispatch attempts died on upstream API 529 errors. The
coordinator ran the gate directly and verified the flagged risk areas by reading the code, but
this increment has **not** had an independent QA lens, which is a documented weakening of the
Verify gate rather than a satisfied one.

**Findings fixed after review:** paging advanced on the parsed rather than raw row count and
had no stable sort (either could strand items for the prune to delete — the exact failure this
feature exists to remove); a run resolving no users reported coverage over an empty mirror; a
server added after boot never synced; `POST /played-state/sync` checked role but not server
access, letting a scoped admin probe and act on servers hidden from them; persisted error text
could carry the full server URL.

**Coordinator-found defect (not raised by either reviewer):** the played predicate as first
written could not drive a hash or merge anti-join, so it rescanned `played_states` per candidate
row and used neither index migration 0071 had just added — 1,417 ms at production scale,
degrading as items × played_rows on a page already slow when cold. Rewritten as a flattened
`watched_keys` CTE: 19.8 ms, both indexes via index-only scans, with set-equivalence proven in
both directions (1,222 rows either way, empty `EXCEPT` both directions) before the code changed.

**Deferred, by decision, not oversight:** the Playback Reporting ingest (ADR 0012) — it adds
timestamps that played flags lack, but corrects only ~23 further items against this increment's 472. Routes in design §5.4 keep session-only semantics deliberately, since they compute counts
and durations that played flags cannot supply. Review findings F2 (progress events broadcast
unscoped, mirroring existing library-sync behaviour) and F4 (bounding pagination against a
hostile media server) are backlogged with their suggested fixes.

**Open items:**

1. **The 41% correction is arithmetic, not observation.** The intersection was measured; nobody
   has run the sync and watched 1,160 fall to ~688. That needs a deploy and is the acceptance
   test that actually matters.
2. No independent QA lens ran (above).
3. `/library/never-watched` has a pre-existing ~91 s cold query on production, untouched here.
4. `totals.neverWatchedSizeBytes` de-duplicates shared items while per-row values do not
   (pre-existing, ~81.8 GB discrepancy).
5. Design §6.3 promises BullMQ retry on backoff; the worker never throws, so `attempts: 3` is
   inert. Either implement or amend the spec — currently doc and code disagree.

**Sign-off:** coordinator, pending owner decision on deploying to production to settle item 1.
