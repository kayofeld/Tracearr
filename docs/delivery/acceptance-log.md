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
