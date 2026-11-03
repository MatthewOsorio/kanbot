// M1 subset of requirements §11. Later milestones add their tables/columns in their own migrations
// (see "Deferred from M1" in docs/requirements.md §16).
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "../ids";
import { activityActions, criterionStatuses, priorities, ticketTypes } from "../schemas";

const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const ticketType = pgEnum("ticket_type", ticketTypes);
export const ticketPriority = pgEnum("ticket_priority", priorities);
export const criterionStatus = pgEnum("criterion_status", criterionStatuses);
export const activityAction = pgEnum("activity_action", activityActions);

export const projects = pgTable("projects", {
  id: id(),
  keyPrefix: text("key_prefix").notNull().unique(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  ticketSeq: integer("ticket_seq").notNull().default(0),
  createdAt: createdAt(),
});

export const columns = pgTable(
  "columns",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    agentSlug: text("agent_slug"),
  },
  (t) => [unique().on(t.projectId, t.slug)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    descriptionMd: text("description_md").notNull().default(""),
    type: ticketType("type").notNull().default("feature"),
    priority: ticketPriority("priority").notNull().default("P2"),
    labels: text("labels").array().notNull().default([]),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id),
    // fractional-indexing key; always ORDER BY it with COLLATE "C" (byte order), never the default collation
    position: text("position").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.projectId, t.number), index().on(t.columnId)],
);

export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    status: criterionStatus("status").notNull().default("open"),
  },
  (t) => [index().on(t.ticketId)],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    bodyMd: text("body_md").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ticketId)],
);

export const activity = pgTable(
  "activity",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorKind: text("actor_kind").notNull().default("user"),
    actor: text("actor").notNull().default("owner"),
    action: activityAction("action").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ticketId)],
);
