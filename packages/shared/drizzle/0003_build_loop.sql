CREATE TYPE "public"."author_kind" AS ENUM('user', 'agent');--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "author_kind" "author_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "agent_slug" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "file" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "line" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "branch_name" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "bounce_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "touch_paths" text[] DEFAULT '{}' NOT NULL;