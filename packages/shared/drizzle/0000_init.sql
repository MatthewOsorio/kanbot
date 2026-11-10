CREATE TYPE "public"."activity_action" AS ENUM('created', 'moved', 'edited', 'commented', 'run_started', 'run_finished', 'pr_opened', 'pr_closed', 'pr_merged', 'ci_changed', 'review_imported', 'pushed');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('plan', 'research', 'review', 'test_report', 'blocker', 'retro', 'diff_snapshot', 'pr_description');--> statement-breakpoint
CREATE TYPE "public"."author_kind" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."ci_state" AS ENUM('none', 'pending', 'passing', 'failing');--> statement-breakpoint
CREATE TYPE "public"."criterion_source" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."criterion_status" AS ENUM('open', 'pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('blocks', 'relates');--> statement-breakpoint
CREATE TYPE "public"."link_source" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('none', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."run_event_type" AS ENUM('assistant', 'tool_call', 'tool_result', 'stdout', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'awaiting_input', 'succeeded', 'changes_requested', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."ticket_status_flag" AS ENUM('none', 'running', 'needs_input', 'plan_ready', 'awaiting_approval', 'waiting_on_ticket', 'pr_open', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('P0', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('feature', 'bug', 'chore', 'spike', 'epic');--> statement-breakpoint
CREATE TABLE "acceptance_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"status" "criterion_status" DEFAULT 'open' NOT NULL,
	"source" "criterion_source" DEFAULT 'user' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"actor" text DEFAULT 'owner' NOT NULL,
	"action" "activity_action" NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"agent_slug" text,
	CONSTRAINT "columns_project_id_slug_unique" UNIQUE("project_id","slug")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"body_md" text NOT NULL,
	"author_kind" "author_kind" DEFAULT 'user' NOT NULL,
	"agent_slug" text,
	"file" text,
	"line" integer,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"repo_path" text,
	"github_owner" text,
	"github_repo" text,
	"onboarding" jsonb,
	"baseline" jsonb,
	"commands" jsonb,
	"test_globs" text[],
	"hotspots" jsonb,
	"image" text,
	"dockerfile" jsonb,
	"env" text,
	"settings" jsonb,
	"ticket_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_prefix_unique" UNIQUE("key_prefix")
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
	"request_md" text,
	"session_id" text,
	"resume_session_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT 0 NOT NULL,
	"budget_usd" numeric(10, 4),
	"error" text,
	"files_changed" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"run_id" uuid,
	"name" text NOT NULL,
	"png" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"daily_budget_usd" numeric(10, 2) DEFAULT 5 NOT NULL,
	"github_app" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ticket_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"from_ticket_id" uuid NOT NULL,
	"to_ticket_id" uuid NOT NULL,
	"kind" "link_kind" NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"source" "link_source" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_links_from_ticket_id_to_ticket_id_kind_unique" UNIQUE("from_ticket_id","to_ticket_id","kind")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description_md" text DEFAULT '' NOT NULL,
	"type" "ticket_type" DEFAULT 'feature' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'P2' NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"column_id" uuid NOT NULL,
	"position" text NOT NULL,
	"status_flag" "ticket_status_flag" DEFAULT 'none' NOT NULL,
	"branch_name" text,
	"worktree_path" text,
	"pr_number" integer,
	"pr_url" text,
	"head_sha" text,
	"ci_state" "ci_state" DEFAULT 'none' NOT NULL,
	"review_state" "review_state" DEFAULT 'none' NOT NULL,
	"last_review_id" bigint,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"touch_paths" text[] DEFAULT '{}' NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_project_id_number_unique" UNIQUE("project_id","number")
);
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_from_ticket_id_tickets_id_fk" FOREIGN KEY ("from_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_to_ticket_id_tickets_id_fk" FOREIGN KEY ("to_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_id_tickets_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_criteria_ticket_id_index" ON "acceptance_criteria" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "activity_ticket_id_index" ON "activity" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "comments_ticket_id_index" ON "comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_ticket" ON "runs" USING btree ("ticket_id") WHERE "runs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "runs_state_created_at_index" ON "runs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "runs_ticket_id_created_at_index" ON "runs" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_ended_at_index" ON "runs" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "screenshots_ticket_id_index" ON "screenshots" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_links_to_ticket_id_index" ON "ticket_links" USING btree ("to_ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_column_id_index" ON "tickets" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "tickets_parent_id_index" ON "tickets" USING btree ("parent_id");