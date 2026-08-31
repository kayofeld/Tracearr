ALTER TABLE "users" ADD COLUMN "first_joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "server_users_username_trgm_idx" ON "server_users" USING gin ("username" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_display_name_idx" ON "users" USING btree (coalesce("name", "username"),"id");--> statement-breakpoint
CREATE INDEX "users_aggregate_trust_idx" ON "users" USING btree ("aggregate_trust_score" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "users_first_joined_idx" ON "users" USING btree ("first_joined_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "users_last_activity_idx" ON "users" USING btree ("last_activity_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "users" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
-- Seed the identity date rollups from the accounts that already exist. Removed
-- accounts count here: an account being removed does not un-happen its history,
-- which is the same rule mergeService applies when it combines two accounts.
UPDATE "users" u SET
  first_joined_at  = agg.min_joined,
  last_activity_at = agg.max_activity
FROM (
  SELECT user_id, MIN(joined_at) AS min_joined, MAX(last_activity_at) AS max_activity
  FROM server_users
  GROUP BY user_id
) agg
WHERE u.id = agg.user_id;
