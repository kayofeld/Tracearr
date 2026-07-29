-- Rollback for 0070_auth_integrity_partial_indexes.sql. Exact inverse:
-- drops both partial unique indexes, in reverse order of creation. NOT
-- auto-run by drizzle-kit (no down-migration mechanism) - apply manually:
--   psql "$DATABASE_URL" -f 0070_auth_integrity_partial_indexes.down.sql
--
-- This is a pure schema rollback: it removes the auth-integrity guarantee
-- (at most one owner, at most one Emby server) but touches no data and no
-- application code path. Safe to run at any time; it re-opens the SR-02 /
-- SEC-02 exposure the indexes close, so only run it if the application code
-- that depends on the constraint (docs/architecture/emby-native-setup.md)
-- has also been rolled back or was never deployed.

DROP INDEX IF EXISTS "users_single_owner";
--> statement-breakpoint
DROP INDEX IF EXISTS "servers_single_emby";
