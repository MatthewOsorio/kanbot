ALTER TABLE "projects" ADD COLUMN "commands" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "test_globs" text[];--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "hotspots" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "settings" jsonb;