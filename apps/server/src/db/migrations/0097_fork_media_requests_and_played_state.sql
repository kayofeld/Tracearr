CREATE TABLE IF NOT EXISTS "media_request_user_mappings" (
	"source" varchar(10) NOT NULL,
	"source_user_id" varchar(64) NOT NULL,
	"source_username" varchar(255) NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_request_user_mappings_pk" PRIMARY KEY("source","source_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(10) NOT NULL,
	"source_request_id" integer NOT NULL,
	"source_parent_request_id" integer,
	"media_type" varchar(10) NOT NULL,
	"title" varchar(500),
	"release_year" integer,
	"imdb_id" varchar(20),
	"tmdb_id" integer,
	"tvdb_id" integer,
	"seasons" jsonb,
	"is_4k" boolean DEFAULT false NOT NULL,
	"status" varchar(20) NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone,
	"source_user_id" varchar(64) NOT NULL,
	"source_username" varchar(255) NOT NULL,
	"source_alias" varchar(255),
	"source_external_user_id" varchar(64),
	"user_id" uuid,
	"match_method" varchar(20),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "played_state_sync_status" (
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
CREATE TABLE IF NOT EXISTS "played_states" (
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
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_request_user_mappings_user_id_users_id_fk') THEN ALTER TABLE "media_request_user_mappings" ADD CONSTRAINT "media_request_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_requests_user_id_users_id_fk') THEN ALTER TABLE "media_requests" ADD CONSTRAINT "media_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'played_state_sync_status_server_id_servers_id_fk') THEN ALTER TABLE "played_state_sync_status" ADD CONSTRAINT "played_state_sync_status_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'played_states_server_id_servers_id_fk') THEN ALTER TABLE "played_states" ADD CONSTRAINT "played_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'played_states_server_user_id_server_users_id_fk') THEN ALTER TABLE "played_states" ADD CONSTRAINT "played_states_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_requests_source_media_type_request_id_unique" ON "media_requests" USING btree ("source","media_type","source_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_user_id_idx" ON "media_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_source_user_id_idx" ON "media_requests" USING btree ("source","source_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_requested_at_idx" ON "media_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_imdb_partial" ON "media_requests" USING btree ("imdb_id") WHERE "media_requests"."imdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_tmdb_partial" ON "media_requests" USING btree ("tmdb_id") WHERE "media_requests"."tmdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_requests_tvdb_partial" ON "media_requests" USING btree ("tvdb_id") WHERE "media_requests"."tvdb_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "played_states_user_rating_unique" ON "played_states" USING btree ("server_user_id","rating_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "played_states_server_rating_idx" ON "played_states" USING btree ("server_id","rating_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "played_states_server_series_idx" ON "played_states" USING btree ("server_id","series_rating_key") WHERE "played_states"."series_rating_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "played_states_user_synced_idx" ON "played_states" USING btree ("server_user_id","synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_single_emby" ON "servers" USING btree ("type") WHERE type = 'emby';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_single_owner" ON "users" USING btree ("role") WHERE role = 'owner';