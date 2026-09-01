ALTER TABLE "rules" RENAME TO "automations";--> statement-breakpoint
ALTER TABLE "violations" RENAME TO "automation_runs";--> statement-breakpoint
ALTER INDEX "rules_pkey" RENAME TO "automations_pkey";--> statement-breakpoint
ALTER INDEX "violations_pkey" RENAME TO "automation_runs_pkey";--> statement-breakpoint
ALTER INDEX "rules_active_idx" RENAME TO "automations_active_idx";--> statement-breakpoint
ALTER INDEX "rules_server_id_idx" RENAME TO "automations_server_id_idx";--> statement-breakpoint
ALTER INDEX "rules_server_user_id_idx" RENAME TO "automations_server_user_id_idx";--> statement-breakpoint
ALTER INDEX "rules_user_id_idx" RENAME TO "automations_user_id_idx";--> statement-breakpoint
ALTER INDEX "violations_server_user_id_idx" RENAME TO "automation_runs_server_user_id_idx";--> statement-breakpoint
ALTER INDEX "violations_rule_id_idx" RENAME TO "automation_runs_rule_id_idx";--> statement-breakpoint
ALTER INDEX "violations_created_at_idx" RENAME TO "automation_runs_created_at_idx";--> statement-breakpoint
ALTER INDEX "violations_dedup_idx" RENAME TO "automation_runs_dedup_idx";--> statement-breakpoint
ALTER INDEX "violations_inactivity_dedup_idx" RENAME TO "automation_runs_inactivity_dedup_idx";--> statement-breakpoint
-- timescale.ts creates these on first boot, so a fresh database has none of them yet.
ALTER INDEX IF EXISTS "violations_session_lookup_idx" RENAME TO "automation_runs_session_lookup_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_violations_unacked_partial" RENAME TO "idx_automation_runs_unacked_partial";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_violations_unacked_list" RENAME TO "idx_automation_runs_unacked_list";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_violations_dismissed_partial" RENAME TO "idx_automation_runs_dismissed_partial";--> statement-breakpoint
-- violations_session_id_sessions_id_fk deliberately keeps its name: migrations 0000-0089
-- still create it on fresh installs and timescale.ts drops it by that name.
ALTER TABLE "automations" RENAME CONSTRAINT "rules_server_id_servers_id_fk" TO "automations_server_id_servers_id_fk";--> statement-breakpoint
ALTER TABLE "automations" RENAME CONSTRAINT "rules_server_user_id_server_users_id_fk" TO "automations_server_user_id_server_users_id_fk";--> statement-breakpoint
ALTER TABLE "automations" RENAME CONSTRAINT "rules_user_id_users_id_fk" TO "automations_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "automation_runs" RENAME CONSTRAINT "violations_rule_id_rules_id_fk" TO "automation_runs_rule_id_automations_id_fk";--> statement-breakpoint
ALTER TABLE "automation_runs" RENAME CONSTRAINT "violations_server_user_id_server_users_id_fk" TO "automation_runs_server_user_id_server_users_id_fk";--> statement-breakpoint
ALTER TABLE "rule_action_results" RENAME CONSTRAINT "rule_action_results_violation_id_violations_id_fk" TO "rule_action_results_violation_id_automation_runs_id_fk";--> statement-breakpoint
ALTER TABLE "rule_action_results" RENAME CONSTRAINT "rule_action_results_rule_id_rules_id_fk" TO "rule_action_results_rule_id_automations_id_fk";--> statement-breakpoint
ALTER TABLE "termination_logs" RENAME CONSTRAINT "termination_logs_violation_id_violations_id_fk" TO "termination_logs_violation_id_automation_runs_id_fk";--> statement-breakpoint
ALTER TABLE "termination_logs" RENAME CONSTRAINT "termination_logs_rule_id_rules_id_fk" TO "termination_logs_rule_id_automations_id_fk";--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_automation_version_uq" UNIQUE("automation_id","version")
);
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "kind" text DEFAULT 'policy' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "triggers" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "cooldown_minutes" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "template_inputs" jsonb;--> statement-breakpoint
-- The run defaults are chosen so historical rows read as finished/completed policy runs.
ALTER TABLE "automation_runs" ADD COLUMN "kind" text DEFAULT 'policy' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "status" text DEFAULT 'finished' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "outcome" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "human_summary" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "definition_version_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_definition_version_id_automation_versions_id_fk" FOREIGN KEY ("definition_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "severity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "server_user_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "violations_unique_active_user_session_rule";--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_unique_active_subject" ON "automation_runs" USING btree ("rule_id","subject_key") WHERE kind = 'policy' AND outcome = 'completed' AND acknowledged_at IS NULL AND session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_runs_retention_idx" ON "automation_runs" USING btree ("kind","finished_at");
