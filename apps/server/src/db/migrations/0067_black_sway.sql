CREATE TABLE "ombi_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ombi_request_id" integer NOT NULL,
	"ombi_parent_request_id" integer,
	"media_type" varchar(10) NOT NULL,
	"title" varchar(500) NOT NULL,
	"release_year" integer,
	"imdb_id" varchar(20),
	"tmdb_id" integer,
	"tvdb_id" integer,
	"seasons" jsonb,
	"is_4k" boolean DEFAULT false NOT NULL,
	"status" varchar(20) NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone,
	"ombi_user_id" varchar(64) NOT NULL,
	"ombi_username" varchar(255) NOT NULL,
	"ombi_alias" varchar(255),
	"user_id" uuid,
	"match_method" varchar(20),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ombi_user_mappings" (
	"ombi_user_id" varchar(64) PRIMARY KEY NOT NULL,
	"ombi_username" varchar(255) NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ombi_requests" ADD CONSTRAINT "ombi_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ombi_user_mappings" ADD CONSTRAINT "ombi_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ombi_requests_media_type_request_id_unique" ON "ombi_requests" USING btree ("media_type","ombi_request_id");--> statement-breakpoint
CREATE INDEX "ombi_requests_user_id_idx" ON "ombi_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ombi_requests_ombi_user_id_idx" ON "ombi_requests" USING btree ("ombi_user_id");--> statement-breakpoint
CREATE INDEX "ombi_requests_requested_at_idx" ON "ombi_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "ombi_requests_imdb_partial" ON "ombi_requests" USING btree ("imdb_id") WHERE "ombi_requests"."imdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ombi_requests_tmdb_partial" ON "ombi_requests" USING btree ("tmdb_id") WHERE "ombi_requests"."tmdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ombi_requests_tvdb_partial" ON "ombi_requests" USING btree ("tvdb_id") WHERE "ombi_requests"."tvdb_id" IS NOT NULL;