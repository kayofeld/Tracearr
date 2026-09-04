CREATE TABLE IF NOT EXISTS "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"name" text NOT NULL,
	"media_type" varchar(20) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'libraries_server_id_servers_id_fk') THEN ALTER TABLE "libraries" ADD CONSTRAINT "libraries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "libraries_server_library_unique" ON "libraries" USING btree ("server_id","library_id");