-- enforce_across_servers defaults false for every existing row, matching today's
-- per-account-only enforcement exactly. No backfill needed.
ALTER TABLE "rules" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "enforce_across_servers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_user_id_idx" ON "rules" USING btree ("user_id");