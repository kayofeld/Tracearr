-- Generalize ombi_requests / ombi_user_mappings into source-discriminated
-- media_requests / media_request_user_mappings (ADR 0006, seerr-connector.md
-- §4.3). Hand-written, NOT drizzle-kit-generated DDL: `drizzle-kit generate`
-- cannot resolve a rename across snapshots without an interactive TTY prompt
-- (tablesResolver), which is unavailable in this environment, and would
-- otherwise be at risk of emitting a destructive DROP+CREATE for a table
-- rename. This preserves the 938 live production rows in ombi_requests by
-- using ALTER TABLE ... RENAME / ADD COLUMN / DROP CONSTRAINT + CREATE
-- CONSTRAINT throughout - every statement here is either metadata-only or an
-- instant rewrite at the table's current size (<1k rows). Precedent for
-- hand-written migrations in this codebase: 0008_update_mobile_tokens_schema,
-- 0027_covering_index_optimization, 0061_better_auth_backfill.
--
-- Whole migration runs in one transaction (Postgres DDL is transactional by
-- default under drizzle-kit's migrator) - either every step below applies, or
-- none do.
--
-- Rollback: db/migrations/0068_generalize_media_requests.down.sql (sibling
-- file, kept alongside per the design's §4.3 "exact inverse script"
-- instruction). Not auto-run by drizzle-kit (which has no down-migration
-- runner) - apply manually via `psql -f` against the target database if a
-- rollback is ever needed, or restore from the pre-migration backup that the
-- upgrade runbook already mandates.

-- 1. Rename tables.
ALTER TABLE "ombi_requests" RENAME TO "media_requests";--> statement-breakpoint
ALTER TABLE "ombi_user_mappings" RENAME TO "media_request_user_mappings";--> statement-breakpoint

-- 2. Add the source discriminator, backfilled via DEFAULT for existing rows,
-- then drop the default so every future writer (Ombi and Seerr sync jobs)
-- must be explicit about which source it is writing (ADR 0006).
ALTER TABLE "media_requests" ADD COLUMN "source" varchar(10) NOT NULL DEFAULT 'ombi';--> statement-breakpoint
ALTER TABLE "media_requests" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" ADD COLUMN "source" varchar(10) NOT NULL DEFAULT 'ombi';--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint

-- 3. Rename ombi_* identity columns to source_* generics (metadata-only, no
-- rewrite - column renames never touch table data in Postgres).
ALTER TABLE "media_requests" RENAME COLUMN "ombi_request_id" TO "source_request_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "ombi_parent_request_id" TO "source_parent_request_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "ombi_user_id" TO "source_user_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "ombi_username" TO "source_username";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "ombi_alias" TO "source_alias";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" RENAME COLUMN "ombi_user_id" TO "source_user_id";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" RENAME COLUMN "ombi_username" TO "source_username";--> statement-breakpoint

-- 4. title becomes nullable - Seerr's request payload carries no title (ADR
-- 0007); Ombi rows are unaffected (they already have non-null titles).
ALTER TABLE "media_requests" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint

-- 5. New nullable external-user-id column (ADR 0008). Null for every existing
-- (Ombi) row - correct: Ombi's providerUserId is deliberately never persisted.
ALTER TABLE "media_requests" ADD COLUMN "source_external_user_id" varchar(64);--> statement-breakpoint

-- 6. Replace the upsert unique key: source prepended so Ombi's per-media-type
-- id sequences and Seerr's single global id sequence cannot collide. The
-- original key was created as a bare unique INDEX (CREATE UNIQUE INDEX in
-- migration 0067), not an ADD CONSTRAINT ... UNIQUE, so Postgres tracks no
-- constraint object for it - DROP INDEX is correct here, not DROP CONSTRAINT
-- (verified against a migrated copy of production data; see report).
DROP INDEX "ombi_requests_media_type_request_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "media_requests_source_media_type_request_id_unique" ON "media_requests" USING btree ("source","media_type","source_request_id");--> statement-breakpoint

-- 7. Replace the mappings primary key: composite (source, source_user_id) so
-- an Ombi override and a Seerr override can share the same underlying account
-- id space without colliding. The existing single-column PK constraint kept
-- Postgres's default auto-generated name from the original CREATE TABLE
-- (ombi_user_mappings_pkey) - RENAME TABLE in step 1 does not rename
-- constraints, so that name is still current here.
ALTER TABLE "media_request_user_mappings" DROP CONSTRAINT "ombi_user_mappings_pkey";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" ADD CONSTRAINT "media_request_user_mappings_pk" PRIMARY KEY ("source","source_user_id");--> statement-breakpoint

-- 8. Rename remaining indexes/constraints to the new table's naming (Postgres
-- ALTER ... RENAME on indexes/constraints is metadata-only).
ALTER TABLE "media_requests" RENAME CONSTRAINT "ombi_requests_user_id_users_id_fk" TO "media_requests_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" RENAME CONSTRAINT "ombi_user_mappings_user_id_users_id_fk" TO "media_request_user_mappings_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "ombi_requests_user_id_idx" RENAME TO "media_requests_user_id_idx";--> statement-breakpoint
ALTER INDEX "ombi_requests_requested_at_idx" RENAME TO "media_requests_requested_at_idx";--> statement-breakpoint
ALTER INDEX "ombi_requests_imdb_partial" RENAME TO "media_requests_imdb_partial";--> statement-breakpoint
ALTER INDEX "ombi_requests_tmdb_partial" RENAME TO "media_requests_tmdb_partial";--> statement-breakpoint
ALTER INDEX "ombi_requests_tvdb_partial" RENAME TO "media_requests_tvdb_partial";--> statement-breakpoint

-- 9. Replace the old single-column requester index with the source-scoped one
-- (design §4.1: "(source, source_user_id) replaces (ombi_user_id)").
DROP INDEX "ombi_requests_ombi_user_id_idx";--> statement-breakpoint
CREATE INDEX "media_requests_source_user_id_idx" ON "media_requests" USING btree ("source","source_user_id");--> statement-breakpoint

-- 10. Verify the shipped Ombi rows landed correctly. Safety assertion, not a
-- fix: on failure the migration aborts and the whole transaction rolls back
-- (nothing partially applied).
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count FROM "media_requests" WHERE "source" <> 'ombi';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'media_requests backfill invariant violated: % row(s) have source <> ''ombi'' immediately after migration', bad_count;
  END IF;
END $$;
