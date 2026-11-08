// Test-only: a stand-in for GitHub's REST API, just the calls onboarding (§10) and Ship (FR-43) make. Worker tests, e2e
// and browser checks point KANBOT_GITHUB_API at it; clone_url is a local repo, so git needs no network.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type GitHubStub = {
  url: string;
  /** The PUT protection bodies, the PRs opened, PR updates and the files written, in order. */
  calls: {
    protection: unknown[];
    pulls: unknown[];
    pullUpdates: { number: number; body: unknown }[];
    contents: { path: string; body: unknown }[];
  };
  close: () => Promise<void>;
};

export async function startGitHubStub(o: {
  owner: string;
  repo: string;
  cloneUrl: string;
  workflows?: string[];
  port?: number;
}): Promise<GitHubStub> {
  const calls: GitHubStub["calls"] = { protection: [], pulls: [], pullUpdates: [], contents: [] };
  let protection: unknown = null;
  const closed = new Set<number>();
  const repo = {
    name: o.repo,
    owner: { login: o.owner },
    default_branch: "main",
    private: false,
    clone_url: o.cloneUrl,
  };
  const base = `/repos/${o.owner}/${o.repo}`;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const path = new URL(req.url!, "http://x").pathname;
      const body = raw ? JSON.parse(raw) : undefined;
      const route = `${req.method} ${path}`;
      if (route === "GET /app/installations") return send(200, [{ id: 1 }]);
      if (route === "POST /app/installations/1/access_tokens")
        return send(201, { token: "stub-token" });
      if (route === "GET /installation/repositories") return send(200, { repositories: [repo] });
      if (route === `GET ${base}/installation`) return send(200, { id: 1 });
      if (route === `GET ${base}`) return send(200, repo);
      if (route === `GET ${base}/contents/.github/workflows`)
        return o.workflows?.length
          ? send(
              200,
              o.workflows.map((name) => ({ name })),
            )
          : send(404, { message: "Not Found" });
      if (route === `GET ${base}/branches/main/protection`)
        return protection ? send(200, protection) : send(404, { message: "Branch not protected" });
      if (route === `PUT ${base}/branches/main/protection`) {
        calls.protection.push(body);
        const b = body as { allow_force_pushes: boolean; allow_deletions: boolean };
        protection = {
          ...body,
          allow_force_pushes: { enabled: b.allow_force_pushes },
          allow_deletions: { enabled: b.allow_deletions },
        };
        return send(200, protection);
      }
      if (route === `GET ${base}/git/ref/heads/main`)
        return send(200, { object: { sha: "a".repeat(40) } });
      if (route === `POST ${base}/git/refs`) return send(201, {});
      if (req.method === "GET" && path.startsWith(`${base}/contents/`))
        return send(404, { message: "Not Found" });
      if (req.method === "PUT" && path.startsWith(`${base}/contents/`)) {
        calls.contents.push({ path: path.slice(`${base}/contents/`.length), body });
        return send(201, {});
      }
      if (route === `GET ${base}/pulls`) return send(200, []);
      if (route === `POST ${base}/pulls`) {
        calls.pulls.push(body);
        const number = calls.pulls.length;
        return send(201, {
          number,
          state: "open",
          html_url: `https://github.com/${o.owner}/${o.repo}/pull/${number}`,
        });
      }
      const pr =
        path.startsWith(`${base}/pulls/`) && /^\d+$/.exec(path.slice(`${base}/pulls/`.length));
      if (pr) {
        const number = Number(pr[0]);
        const view = () => ({
          number,
          state: closed.has(number) ? "closed" : "open",
          merged: false,
          html_url: `https://github.com/${o.owner}/${o.repo}/pull/${number}`,
        });
        if (req.method === "GET") return send(200, view());
        if (req.method === "PATCH") {
          calls.pullUpdates.push({ number, body });
          const state = (body as { state?: string }).state;
          if (state === "closed") closed.add(number);
          if (state === "open") closed.delete(number);
          return send(200, view());
        }
      }
      if (req.method === "GET" && path.startsWith("/users/")) return send(200, { id: 4242 });
      if (route === `GET ${base}/commits/main/check-runs`) return send(200, { check_runs: [] });
      send(404, { message: `stub: no route for ${route}` });
    });
  });
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
