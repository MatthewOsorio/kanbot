import { AgentsDisabledError, QaSetupError } from "@kanbot/shared/db";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);

type Ctx = { params: Promise<Record<string, string>> };

/** Wraps a route handler so thrown HttpErrors and zod errors become `{error: {code, message}}`. */
export function route(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError)
        return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
      if (e instanceof AgentsDisabledError)
        return Response.json(
          { error: { code: "unprotected", message: e.message } },
          { status: 409 },
        );
      if (e instanceof QaSetupError)
        return Response.json({ error: { code: "qa_setup", message: e.message } }, { status: 409 });
      if (e instanceof z.ZodError)
        return Response.json(
          { error: { code: "invalid_body", message: z.prettifyError(e) } },
          { status: 400 },
        );
      throw e;
    }
  };
}

export async function parseBody<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<z.output<T>> {
  return schema.parse(await req.json().catch(() => undefined));
}

/** Reads the `[id]` route param; a non-UUID can't exist, so it's a 404 rather than a DB error. */
export async function idParam(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) throw notFound();
  return id!;
}

/** Postgres unique-violation, unwrapped from drizzle's error. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null | undefined;
  return err?.code === "23505" || err?.cause?.code === "23505";
}
