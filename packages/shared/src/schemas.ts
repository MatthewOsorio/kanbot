import { z } from "zod";

export const ticketTypes = ["feature", "bug", "chore", "spike", "epic"] as const;
export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const criterionStatuses = ["open", "pass", "fail"] as const;
export const activityActions = ["created", "moved", "edited", "commented"] as const;

export type TicketType = (typeof ticketTypes)[number];
export type Priority = (typeof priorities)[number];
export type CriterionStatus = (typeof criterionStatuses)[number];
export type ActivityAction = (typeof activityActions)[number];

const nonEmpty = <T extends object>(o: T) => Object.keys(o).length > 0;

export const createProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  keyPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2-10 uppercase letters or digits, starting with a letter"),
  defaultBranch: z.string().trim().min(1).max(200).default("main"),
});

const ticketFields = {
  title: z.string().trim().min(1).max(200),
  descriptionMd: z.string().max(50_000),
  type: z.enum(ticketTypes),
  priority: z.enum(priorities),
  labels: z.array(z.string().trim().min(1).max(50)).max(20),
};

export const createTicketBody = z.object({
  ...ticketFields,
  descriptionMd: ticketFields.descriptionMd.default(""),
  type: ticketFields.type.default("feature"),
  priority: ticketFields.priority.default("P2"),
  labels: ticketFields.labels.default([]),
});

export const patchTicketBody = z
  .object(ticketFields)
  .partial()
  .refine(nonEmpty, "No fields to update");

// Fractional-index key (fractional-indexing package); validated server-side in the move handler.
export const moveTicketBody = z.object({
  toColumnId: z.uuid(),
  position: z.string().min(1).max(200),
});

export const createCommentBody = z.object({ bodyMd: z.string().trim().min(1).max(20_000) });

export const createCriterionBody = z.object({ text: z.string().trim().min(1).max(1_000) });

export const patchCriterionBody = z
  .object({ text: createCriterionBody.shape.text, status: z.enum(criterionStatuses) })
  .partial()
  .refine(nonEmpty, "No fields to update");
