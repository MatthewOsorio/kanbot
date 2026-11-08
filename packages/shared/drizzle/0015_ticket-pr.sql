ALTER TYPE "public"."activity_action" ADD VALUE 'pr_opened';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'pr_closed';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'pr_description';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "head_sha" text;