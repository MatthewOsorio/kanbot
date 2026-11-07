import { DEFAULT_COLUMNS } from "@kanbot/shared";
import { loadAgent } from "@kanbot/shared/agents";
import { loadGitHubApp } from "@kanbot/shared/github";
import { Home } from "@/components/home";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic"; // agent files are read per request, like the board's

/** The agents whose files have shipped, in board order (a column without one is a gate). */
function shippedAgents() {
  return DEFAULT_COLUMNS.flatMap((c) => {
    try {
      const a = c.agentSlug ? loadAgent(c.agentSlug) : null;
      return a ? [{ slug: a.slug, name: a.name }] : [];
    } catch {
      return []; // an invalid file: the board and its runs report it
    }
  });
}

export default async function Page() {
  const app = await loadGitHubApp(db);
  const installUrl = app ? `https://github.com/apps/${app.slug}/installations/new` : undefined;
  return <Home agents={shippedAgents()} installUrl={installUrl} />;
}
