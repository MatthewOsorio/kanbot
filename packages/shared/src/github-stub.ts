// Test-only: a stand-in for GitHub's REST API, just the calls onboarding (§10), Ship (FR-43) and the PR watcher
// (FR-46, FR-47) make. Worker tests, e2e and browser checks point KANBOT_GITHUB_API at it; clone_url is a local repo,
// so git needs no network.
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckRun, Review, ReviewComment } from "./github";

export type GitHubStub = {
  url: string;
  /** The PUT protection bodies, the PRs opened, PR updates and the files written, in order. */
  calls: {
    protection: unknown[];
    pulls: unknown[];
    pullUpdates: { number: number; body: unknown }[];
    contents: { path: string; body: unknown }[];
  };
  /** The PR watcher's view: a PR's head (default: its branch in cloneUrl) or state, a commit's checks, reviews, job logs. */
  setPr: (number: number, pr: { headSha?: string; merged?: boolean; closed?: boolean }) => void;
  setChecks: (sha: string, runs: CheckRun[]) => void;
  addReview: (number: number, review: Review, comments?: ReviewComment[]) => void;
  setJobLog: (jobId: number, log: string) => void;
  /** The repo's workflow files (the `workflows` option), changeable per test. */
  setWorkflows: (names: string[]) => void;
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
  let workflows = o.workflows ?? [];
  const closed = new Set<number>();
  const merged = new Set<number>();
  const heads = new Map<number, string>();
  const branches = new Map<number, string>();
  const checks = new Map<string, CheckRun[]>();
  const reviews = new Map<number, { review: Review; comments: ReviewComment[] }[]>();
  const jobLogs = new Map<number, string>();
  const headOf = (n: number) => {
    const set = heads.get(n);
    if (set) return set;
    const branch = branches.get(n);
    if (!branch) return "0".repeat(40);
    return execFileSync("git", ["-C", o.cloneUrl, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim();
  };
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
        return workflows.length
          ? send(
              200,
              workflows.map((name) => ({ name })),
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
        branches.set(number, (body as { head: string }).head);
        return send(201, {
          number,
          state: "open",
          html_url: `https://github.com/${o.owner}/${o.repo}/pull/${number}`,
        });
      }
      const rest = path.startsWith(`${base}/`) ? path.slice(base.length) : "";
      const pr = /^\/pulls\/(\d+)$/.exec(rest);
      if (pr) {
        const number = Number(pr[1]);
        const view = () => ({
          number,
          state: closed.has(number) ? "closed" : "open",
          merged: merged.has(number),
          head: { sha: headOf(number) },
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
      const rv = /^\/pulls\/(\d+)\/reviews(?:\/(\d+)\/comments)?$/.exec(rest);
      if (rv && req.method === "GET") {
        const list = reviews.get(Number(rv[1])) ?? [];
        if (!rv[2])
          return send(
            200,
            list.map((r) => r.review),
          );
        return send(200, list.find((r) => r.review.id === Number(rv[2]))?.comments ?? []);
      }
      const cr = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
      if (cr && req.method === "GET") return send(200, { check_runs: checks.get(cr[1]!) ?? [] });
      const job = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
      if (job && req.method === "GET") {
        const log = jobLogs.get(Number(job[1]));
        if (log === undefined) return send(404, { message: "Not Found" });
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(log);
      }
      if (req.method === "GET" && path.startsWith("/users/")) return send(200, { id: 4242 });
      send(404, { message: `stub: no route for ${route}` });
    });
  });
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setPr: (number, pr) => {
      if (pr.headSha) heads.set(number, pr.headSha);
      if (pr.merged) merged.add(number);
      if (pr.merged || pr.closed) closed.add(number);
      if (pr.closed === false) closed.delete(number);
    },
    setChecks: (sha, runs) => checks.set(sha, runs),
    addReview: (number, review, comments = []) =>
      reviews.set(number, [...(reviews.get(number) ?? []), { review, comments }]),
    setJobLog: (jobId, log) => jobLogs.set(jobId, log),
    setWorkflows: (names) => (workflows = names),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
