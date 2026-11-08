CREATE TYPE "public"."ci_state" AS ENUM('none', 'pending', 'passing', 'failing');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('none', 'approved', 'changes_requested');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'pr_merged';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'ci_changed';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'review_imported';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'pushed';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ci_state" "ci_state" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "review_state" "review_state" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_review_id" bigint;