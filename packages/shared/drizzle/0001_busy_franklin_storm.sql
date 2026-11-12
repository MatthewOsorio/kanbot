CREATE TABLE "agent_versions" (
	"hash" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "config_hash" text;