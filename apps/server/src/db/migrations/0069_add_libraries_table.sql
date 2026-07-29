-- Add the "libraries" dimension table: maps each server's library key
-- (library_items.library_id / library_snapshots.library_id) to its display
-- name and type, so UI/reporting can show "Movies" instead of the raw
-- server-side section key. Purely additive - drizzle-kit-generated (no
-- rename to resolve, no interactive prompt needed). Table starts empty; no
-- backfill here - librarySync populates it going forward. Consumers must
-- tolerate a missing row (fall back to the raw library_id) until the next
-- sync runs for a given server.
--
-- Runs in a single transaction under drizzle-kit's migrator (Postgres DDL is
-- transactional by default) - either every statement below applies, or none
-- do.
--
-- Rollback: db/migrations/0069_add_libraries_table.down.sql (sibling file,
-- same convention as 0068). Not auto-run by drizzle-kit - apply manually via
-- `psql -f` if a rollback is ever needed.

CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_server_library_unique" ON "libraries" USING btree ("server_id","library_id");