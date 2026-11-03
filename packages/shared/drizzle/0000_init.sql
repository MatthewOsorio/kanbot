CREATE TYPE "public"."activity_action" AS ENUM('created', 'moved', 'edited', 'commented');--> statement-breakpoint
CREATE TYPE "public"."criterion_status" AS ENUM('open', 'pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('P0', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('feature', 'bug', 'chore', 'spike', 'epic');--> statement-breakpoint
CREATE TABLE "acceptance_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"status" "criterion_status" DEFAULT 'open' NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"ticket_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_prefix_unique" UNIQUE("key_prefix")
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_project_id_number_unique" UNIQUE("project_id","number")
);
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_criteria_ticket_id_index" ON "acceptance_criteria" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "activity_ticket_id_index" ON "activity" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "comments_ticket_id_index" ON "comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_column_id_index" ON "tickets" USING btree ("column_id");