import { route } from "@/lib/api";
import { listRepos } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/** The repos the GitHub App can see, for onboarding's repo picker (§10 step 2). */
export const GET = route(async () => Response.json(await listRepos()));
