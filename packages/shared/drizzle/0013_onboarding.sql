ALTER TABLE "projects" ADD COLUMN "github_owner" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repo" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "onboarding" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "baseline" jsonb;