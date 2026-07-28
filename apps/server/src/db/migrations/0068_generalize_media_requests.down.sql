-- Rollback for 0068_generalize_media_requests.sql. Exact inverse of that
-- migration's steps, in reverse order, per design §4.3. NOT auto-run by
-- drizzle-kit (it has no down-migration mechanism) - apply manually:
--   psql "$DATABASE_URL" -f 0068_generalize_media_requests.down.sql
--
-- Only safe to run if no Seerr rows have been written yet (source='seerr').
-- If any exist, this script aborts before touching anything (see the guard
-- at the top) - rolling back the schema would silently orphan or misrepresent
-- those rows, and downgrading application code that already writes/reads the
-- generalized shape is a separate, larger action than a schema rollback.
-- Restoring from the pre-migration backup (mandated by the upgrade runbook)
-- is the supported path once Seerr rows exist.

DO $$
DECLARE
  seerr_count integer;
BEGIN
  SELECT count(*) INTO seerr_count FROM "media_requests" WHERE "source" = 'seerr';
  IF seerr_count > 0 THEN
    RAISE EXCEPTION 'Refusing rollback: % seerr-sourced row(s) exist in media_requests; restore from the pre-migration backup instead of running this script', seerr_count;
  END IF;
END $$;
--> statement-breakpoint

-- Reverse step 9: restore the single-column requester index.
DROP INDEX "media_requests_source_user_id_idx";--> statement-breakpoint
CREATE INDEX "ombi_requests_ombi_user_id_idx" ON "media_requests" USING btree ("source_user_id");--> statement-breakpoint

-- Reverse step 8: rename indexes/constraints back to the ombi_* names.
ALTER INDEX "media_requests_tvdb_partial" RENAME TO "ombi_requests_tvdb_partial";--> statement-breakpoint
ALTER INDEX "media_requests_tmdb_partial" RENAME TO "ombi_requests_tmdb_partial";--> statement-breakpoint
ALTER INDEX "media_requests_imdb_partial" RENAME TO "ombi_requests_imdb_partial";--> statement-breakpoint
ALTER INDEX "media_requests_requested_at_idx" RENAME TO "ombi_requests_requested_at_idx";--> statement-breakpoint
ALTER INDEX "media_requests_user_id_idx" RENAME TO "ombi_requests_user_id_idx";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" RENAME CONSTRAINT "media_request_user_mappings_user_id_users_id_fk" TO "ombi_user_mappings_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME CONSTRAINT "media_requests_user_id_users_id_fk" TO "ombi_requests_user_id_users_id_fk";--> statement-breakpoint

-- Reverse step 7: restore the single-column mappings primary key.
ALTER TABLE "media_request_user_mappings" DROP CONSTRAINT "media_request_user_mappings_pk";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" ADD CONSTRAINT "ombi_user_mappings_pkey" PRIMARY KEY ("source_user_id");--> statement-breakpoint

-- Reverse step 6: restore the original unique key. Recreated as a bare
-- CREATE UNIQUE INDEX (not ADD CONSTRAINT ... UNIQUE) to exactly match how
-- migration 0067 originally created it - Postgres tracks these differently
-- (a constraint-backed unique index vs a plain one), and 0068 step 6's DROP
-- INDEX (not DROP CONSTRAINT) already established that the original was the
-- bare-index form.
DROP INDEX "media_requests_source_media_type_request_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "ombi_requests_media_type_request_id_unique" ON "media_requests" USING btree ("media_type","source_request_id");--> statement-breakpoint

-- Reverse step 5: drop the external-user-id column (null on every row at this
-- point, since the guard above already refused rollback if any seerr row
-- exists, so no data loss here).
ALTER TABLE "media_requests" DROP COLUMN "source_external_user_id";--> statement-breakpoint

-- Reverse step 4: title becomes NOT NULL again. Safe: only seerr rows can
-- have a null title (ADR 0007), and the guard above already refused rollback
-- if any exist.
ALTER TABLE "media_requests" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint

-- Reverse step 3: rename source_* columns back to ombi_*.
ALTER TABLE "media_request_user_mappings" RENAME COLUMN "source_username" TO "ombi_username";--> statement-breakpoint
ALTER TABLE "media_request_user_mappings" RENAME COLUMN "source_user_id" TO "ombi_user_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "source_alias" TO "ombi_alias";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "source_username" TO "ombi_username";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "source_user_id" TO "ombi_user_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "source_parent_request_id" TO "ombi_parent_request_id";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME COLUMN "source_request_id" TO "ombi_request_id";--> statement-breakpoint

-- Reverse step 2: drop the source discriminator (every remaining row is
-- 'ombi' by the guard above, so nothing is lost).
ALTER TABLE "media_request_user_mappings" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "media_requests" DROP COLUMN "source";--> statement-breakpoint

-- Reverse step 1: rename tables back.
ALTER TABLE "media_request_user_mappings" RENAME TO "ombi_user_mappings";--> statement-breakpoint
ALTER TABLE "media_requests" RENAME TO "ombi_requests";
