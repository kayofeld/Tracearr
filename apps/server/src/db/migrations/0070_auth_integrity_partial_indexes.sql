-- Auth-integrity partial unique indexes (SEC-04 fix, docs/architecture/
-- emby-native-setup.md §7.1 and §4.3; security review
-- docs/delivery/security-review-emby-setup.md SEC-04).
--
-- The two CREATE UNIQUE INDEX statements below are exactly what
-- `drizzle-kit generate` produces from the schema.ts changes in this
-- increment (verified in this worktree: generate against the two new
-- uniqueIndex() declarations emitted these two statements, in this table
-- order, byte-for-byte except for the added IF NOT EXISTS and the guard
-- blocks below, which are hand-added defense that generate does not know to
-- write). Hand-editing is limited to: (a) adding the pre-flight guards so a
-- pre-existing violation aborts with an actionable message instead of a raw
-- duplicate-key error, and (b) IF NOT EXISTS for idempotent re-runs, matching
-- the precedent already established by 0063_long_maria_hill.sql's
-- users_login_username_unique.
--
-- Both indexes were originally proposed for createPartialIndexes()
-- (db/timescale.ts), whose only caller wraps the whole function in a
-- try/catch that logs "Partial indexes: some may already exist" and
-- continues (timescale.ts:1734-1740) - a failure downgrades to an unnoticed
-- warning, and every index declared after a failing one in that function is
-- silently skipped. An auth-integrity constraint cannot be established that
-- way. They belong in a migration instead: migration failure aborts startup
-- (index.ts:607-615), which is the correct failure mode for a constraint
-- whose absence is an auth-integrity hole. Precedent for a migration-created
-- unique index in this codebase: users_login_username_unique
-- (0063_long_maria_hill.sql), asserted by
-- db/__tests__/loginUsernameCollision.integration.test.ts.
--
-- Whole migration runs in one transaction (Postgres DDL is transactional by
-- default under drizzle-kit's migrator) - either both indexes are created,
-- or neither is.
--
-- Rollback: db/migrations/0070_auth_integrity_partial_indexes.down.sql
-- (sibling file). Not auto-run by drizzle-kit (no down-migration runner) -
-- apply manually via `psql -f` if a rollback is ever needed.

-- 1. servers_single_emby: at most one row in `servers` may have type='emby'
-- (SEC-02 fix, design §4.3 design A - single Emby is the product rule, owner
-- decision 3). Without this, /emby/login's `resolveConfiguredEmbyServerUrl()`
-- resolves its authentication authority with an unordered `limit(1)`; two
-- Emby rows make that authority nondeterministic and, combined with an
-- ownerless instance, reach the auth-bypass the embyPlugin.ts NOTE exists to
-- prevent (design §2, §4). Every row this predicate selects shares the
-- value 'emby', so uniqueness on that value is exactly "at most one such
-- row".
--
-- Guard first: an instance that already has two or more Emby server rows
-- would otherwise fail to boot with a raw duplicate-key error and no
-- indication of what to do. Raise an actionable exception instead, naming
-- the table, the conflict, and the remediation.
DO $$
DECLARE
  emby_count integer;
BEGIN
  SELECT count(*) INTO emby_count FROM "servers" WHERE "type" = 'emby';
  IF emby_count > 1 THEN
    RAISE EXCEPTION 'Tracearr migration 0070 blocked: % rows in "servers" have type = ''emby'', but at most one is allowed. Remove or merge the extra server row(s) (e.g. via the Servers admin UI, or a manual DELETE after confirming which row is authoritative), then re-run migrations. See docs/delivery/runbook.md.',
      emby_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_single_emby" ON "servers" USING btree ("type") WHERE type = 'emby';
--> statement-breakpoint

-- 2. users_single_owner: at most one row in `users` may have role='owner'
-- (SR-02 / T5 in the design's threat model). Uses the (role) form, not
-- ((true)): every row this predicate selects shares the identical indexed
-- value 'owner', so uniqueness on that value is exactly "at most one such
-- row" - semantically identical to ((true)) WHERE role = 'owner' but an
-- unambiguously valid expression rather than an assertion made without a
-- verification note (design §12 item 5). users.role is varchar(20), so the
-- default btree opclass applies with no cast needed.
--
-- Guard first, same shape as above: an instance that already holds two or
-- more owner rows (SR-02 having fired historically, e.g. through the two
-- Plex insert sites that bypass the better-auth hook chain - design §7.2)
-- would otherwise fail to boot with a raw duplicate-key error.
DO $$
DECLARE
  owner_count integer;
BEGIN
  SELECT count(*) INTO owner_count FROM "users" WHERE "role" = 'owner';
  IF owner_count > 1 THEN
    RAISE EXCEPTION 'Tracearr migration 0070 blocked: % rows in "users" have role = ''owner'', but at most one is allowed. Resolve to exactly one owner (demote or delete the extra row(s), e.g. via `pnpm --filter @tracearr/server cli list-users` and a manual UPDATE/DELETE), then re-run migrations. See docs/delivery/runbook.md.',
      owner_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_single_owner" ON "users" USING btree ("role") WHERE role = 'owner';
