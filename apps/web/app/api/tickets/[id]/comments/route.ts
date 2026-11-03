import { createCommentBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { addComment, listComments } from "@/lib/tickets";

export const GET = route(async (_req, ctx) =>
  Response.json(await listComments(await idParam(ctx))),
);

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  return Response.json(await addComment(id, await parseBody(req, createCommentBody)), {
    status: 201,
  });
});
