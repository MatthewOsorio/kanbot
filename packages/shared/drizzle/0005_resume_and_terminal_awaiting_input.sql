DROP INDEX "runs_one_active_per_ticket";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resume_session_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_ticket" ON "runs" USING btree ("ticket_id") WHERE "runs"."state" in ('queued', 'running');