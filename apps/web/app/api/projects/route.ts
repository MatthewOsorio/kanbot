import { createProjectBody } from "@kanbot/shared";
import { parseBody, route } from "@/lib/api";
import { createGitHubProject } from "@/lib/onboarding";
import { createProject, listProjects } from "@/lib/projects";

export const GET = route(async () => Response.json(await listProjects()));

/** A GitHub repo starts onboarding (§10); a local folder (or nothing) is a project at once. */
export const POST = route(async (req) => {
  const body = await parseBody(req, createProjectBody);
  const project = body.githubRepo ? await createGitHubProject(body) : await createProject(body);
  return Response.json(project, { status: 201 });
});
