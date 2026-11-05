CREATE TYPE "public"."link_kind" AS ENUM('blocks', 'relates');--> statement-breakpoint
CREATE TYPE "public"."link_source" AS ENUM('user', 'agent');--> statement-breakpoint
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
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_from_ticket_id_tickets_id_fk" FOREIGN KEY ("from_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_to_ticket_id_tickets_id_fk" FOREIGN KEY ("to_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_links_to_ticket_id_index" ON "ticket_links" USING btree ("to_ticket_id");