-- Rollback for 0069_add_libraries_table.sql. Exact inverse, in reverse
-- order. NOT auto-run by drizzle-kit (it has no down-migration mechanism) -
-- apply manually:
--   psql "$DATABASE_URL" -f 0069_add_libraries_table.down.sql
--
-- Safe unconditionally: the table is purely additive dimension data
-- (upserted by librarySync, never referenced by a FK from another table), so
-- dropping it cannot orphan or misrepresent data elsewhere - unlike 0068's
-- rollback, no source-row guard is needed here.

DROP TABLE "libraries";
