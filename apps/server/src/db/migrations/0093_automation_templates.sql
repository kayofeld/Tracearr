CREATE TABLE "automation_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_template_versions_template_version_uq" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "automation_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"group" text NOT NULL,
	"kind" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"author" text,
	"min_server_version" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "triggers" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "origin_template_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "origin_template_version" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "latest_version" text;--> statement-breakpoint
ALTER TABLE "automation_template_versions" ADD CONSTRAINT "automation_template_versions_template_id_automation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."automation_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_template_id_automation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."automation_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" DROP COLUMN "rule_type";--> statement-breakpoint
ALTER TABLE "automation_runs" DROP COLUMN "status";--> statement-breakpoint
CREATE INDEX "automation_runs_server_started_idx" ON "automation_runs" USING btree ("server_id","started_at" DESC NULLS LAST);
