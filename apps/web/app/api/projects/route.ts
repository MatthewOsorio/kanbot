import { createProjectBody } from "@kanbot/shared";
import { parseBody, route } from "@/lib/api";
import { createProject, listProjects } from "@/lib/projects";

export const GET = route(async () => Response.json(await listProjects()));

export const POST = route(async (req) =>
  Response.json(await createProject(await parseBody(req, createProjectBody)), { status: 201 }),
);
