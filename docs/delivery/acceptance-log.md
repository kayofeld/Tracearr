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
