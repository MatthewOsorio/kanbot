import { acceptProposalsBody } from "@kanbot/shared";
import { idParam, parseBody, route } from "@/lib/api";
import { acceptProposals } from "@/lib/tickets";

export const POST = route(async (req, ctx) => {
  const id = await idParam(ctx);
  return Response.json(await acceptProposals(id, await parseBody(req, acceptProposalsBody)), {
    status: 201,
  });
});
