CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" varchar(30) NOT NULL,
	"config" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"config_status" varchar(20) DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "destinations_builtin_type_uidx" ON "destinations" USING btree ("type") WHERE "destinations"."builtin" = true;