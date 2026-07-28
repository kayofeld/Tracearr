# ADR 0006: Generalize `ombi_requests` into a source-discriminated `media_requests` table

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect (coordinator pre-work: live Seerr probe + DB matching evidence)
**Supersedes:** the "a future connector would be a sibling table, not a generalization" note
in ombi-connector.md §1/§10 (written before the stats query layer existed).

## Context

The Seerr connector needs the same storage and query behavior the Ombi connector shipped in
v1.8.0: mirrored request rows, requester resolution, attribution on `GET /library/stale`, and
per-requester statistics. Shipped state: `ombi_requests` + `ombi_user_mappings` (migration
0067), 938 live rows in production (coordinator-stated); the frozen wire contract already
carries `StaleItemRequestedBy.source: 'ombi'` as a discriminator for sibling connectors. The
owner runs Ombi and Seerr on separate instances today, but one instance may plausibly
configure both, and the request-tool lineage (Overseerr → Jellyseerr → Seerr) keeps forking —
a third source someday is not fanciful.

The decisive technical fact: the hard logic lives in **raw SQL**. The requester-stats query
(`routes/stats/requesters.ts`) is ~270 lines of CTEs (item dedup, episode roll-ups,
watched-by-requester semantics, unattributed bucket); the stale-attribution fragments
(`routes/library/stale.ts`) are raw SQL too. TypeScript verifies none of it. Whatever the
schema choice, cross-source stats must behave as one relation: same-human dedup (grouping by
resolved `user_id`) and same-media dedup (item-level CTE) only work over a unified row set.

## Decision

One table pair, source-discriminated:

- `ombi_requests` → **`media_requests`** with `source varchar(10) NOT NULL` in
  `('ombi','seerr')`; ombi-prefixed columns renamed to `source_*` generics; `title` made
  nullable (Seerr supplies none — ADR 0007); new nullable `source_external_user_id`
  (ADR 0008); unique key becomes `(source, media_type, source_request_id)`.
- `ombi_user_mappings` → **`media_request_user_mappings`** with composite PK
  `(source, source_user_id)`.
- Shipped Ombi rows migrated **in place** (migration 0068): renames + additive columns +
  `DEFAULT 'ombi'` backfill, one transaction, all metadata-ops or instant rewrites at ≤1k
  rows; inverse rollback script kept alongside; DB backup precondition per the upgrade
  runbook. No expand-contract phase — the app is single-writer on its own DB and migration +
  code ship in one release.
- Shared queries (stats, stale attribution) stay **single-code-path** over `media_requests`,
  scoped to the currently-configured source set. Per-source code (client, sync job, routes,
  mappings UI) remains per-source — only storage and the query layer generalize.
- Wire contract: **unchanged for Ombi**; `StaleItemRequestedBy.source` widens to
  `'ombi' | 'seerr'` as designed.

## Options considered

1. **Generalize into `media_requests` (chosen)** — pros: the subtle raw-SQL layer stays
   single-path (one place to fix bugs, one place to test cross-source dedup); coexistence
   semantics (unattributed bucket, earliest-requester across sources, item dedup) fall out of
   the relational model instead of being reimplemented per query; a third connector costs one
   enum value; rename churn in shipped code is compiler-enumerated (Drizzle identifiers are
   typed). Cons: touches a live production table (mitigated: metadata-only DDL at 938 rows,
   transactional, backup + rollback script); the one compiler-blind hazard is source-scoping
   predicates in rewritten queries — addressed with an explicit build/review checklist
   (design §4.4) and an acceptance grep for leftover `ombi_*` column names.
2. **Parallel `seerr_*` tables, UNION ALL in shared queries** — pros: zero migration, shipped
   Ombi code untouched. Cons: UNION column alignment lives inside raw SQL where the compiler
   cannot see it — a silent-runtime-bug class in the most subtle queries of the codebase,
   duplicated schema definitions to keep in sync, and every future connector multiplies both;
   cross-source distinct-requester and item-dedup logic must be rebuilt at query time on
   every query anyway, i.e. the unified relation gets constructed per-query instead of once
   in the schema.
3. **Parallel tables + a Postgres UNION view as the single query surface** — pros: no
   migration, one query path. Cons: the view is a hand-maintained alignment contract with the
   same compiler-blindness as option 2, plus a second schema object Drizzle handles poorly;
   two physical tables still duplicate constraints/indexes; cleverness without removing the
   underlying duplication.

## Consequences

- Positive: one stats/attribution implementation with cross-source correctness by
  construction; Ombi and Seerr coexist on one instance; the shipped `source` discriminator
  finally earns its keep; future sources are cheap.
- Negative / trade-offs: a production migration on a shipped feature — the DDL risk is
  near-zero but the **rewrite of shipped Ombi queries must be re-verified end-to-end**
  (Ombi sync, purge, mappings, status against a migrated DB) at the Verify gate; the
  source-scoping checklist is mandatory review material because the type system cannot catch
  a missing `WHERE source = ...`.
- Follow-ups: acceptance grep (`ombi_requests|ombi_user_id|ombi_username|ombi_alias|
ombi_user_mappings` → zero hits outside `db/migrations/`); QA regression suite runs the
  full Ombi path against a 0068-migrated database seeded with pre-migration-shaped data.
