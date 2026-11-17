ALTER TABLE "columns" ADD COLUMN "wip_limit" integer;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "auto_advance" boolean DEFAULT true NOT NULL;