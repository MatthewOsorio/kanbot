CREATE TYPE "public"."artifact_kind" AS ENUM('plan', 'research', 'review', 'test_report', 'blocker', 'retro', 'diff_snapshot');--> statement-breakpoint
CREATE TYPE "public"."criterion_source" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."run_event_type" AS ENUM('assistant', 'tool_call', 'tool_result', 'stdout', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'awaiting_input', 'succeeded', 'changes_requested', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."ticket_status_flag" AS ENUM('none', 'running', 'needs_input', 'plan_ready', 'awaiting_approval', 'waiting_on_ticket', 'pr_open', 'failed');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'run_started';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'run_finished';--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"version" integer NOT NULL,
	"content_md" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_ticket_id_kind_version_unique" UNIQUE("ticket_id","kind","version")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" "run_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_unique" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"agent_slug" text NOT NULL,
	"column_slug" text NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"verdict" text,
	"summary" text,
	"session_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD COLUMN "source" "criterion_source" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_path" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "status_flag" "ticket_status_flag" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_ticket" ON "runs" USING btree ("ticket_id") WHERE "runs"."state" in ('queued', 'running', 'awaiting_input');--> statement-breakpoint
CREATE INDEX "runs_state_created_at_index" ON "runs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "runs_ticket_id_created_at_index" ON "runs" USING btree ("ticket_id","created_at");