ALTER TABLE "library_items" ADD COLUMN "removed_source" varchar(10);--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "replaces_library_item_id" uuid;--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "first_seen_at" timestamp with time zone;