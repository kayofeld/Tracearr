CREATE TABLE "played_state_sync_status" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"users_total" integer DEFAULT 0 NOT NULL,
	"users_synced" integer DEFAULT 0 NOT NULL,
	"items_upserted" integer DEFAULT 0 NOT NULL,
	"items_pruned" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "played_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"server_user_id" uuid NOT NULL,
	"rating_key" varchar(255) NOT NULL,
	"media_type" varchar(20) NOT NULL,
	"series_rating_key" varchar(255),
	"played_at" timestamp with time zone,
	"play_count" integer,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "played_state_sync_status" ADD CONSTRAINT "played_state_sync_status_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "played_states" ADD CONSTRAINT "played_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "played_states" ADD CONSTRAINT "played_states_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "played_states_user_rating_unique" ON "played_states" USING btree ("server_user_id","rating_key");--> statement-breakpoint
CREATE INDEX "played_states_server_rating_idx" ON "played_states" USING btree ("server_id","rating_key");--> statement-breakpoint
CREATE INDEX "played_states_server_series_idx" ON "played_states" USING btree ("server_id","series_rating_key") WHERE "played_states"."series_rating_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "played_states_user_synced_idx" ON "played_states" USING btree ("server_user_id","synced_at");