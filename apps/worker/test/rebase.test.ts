// Keeping branches current (§9, FR-48, FR-51): rebase onto main, replay onto the owner's pushes, the leased force-push.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, git, settings } from "@kanbot/shared/server";
import {
  type GitHubStub,
  prepareSampleRepo,
  startGitHubStub,
  TEST_DATABASE_URL,
} from "@kanbot/shared/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keepCurrent, rebaseBranch } from "../src/ship";
import { connectTestApp } from "./github-app";

const db = createDb(TEST_DATABASE_URL);
let tmp: string;
let origin: string;
let stub: GitHubStub;
const gh = { githubOwner: "octo", githubRepo: "sample" };
const who = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kanbot-rebase-"));
  origin = await prepareSampleRepo(join(tmp, "origin"));
  stub = await startGitHubStub({ owner: "octo", repo: "sample", cloneUrl: origin });
  await connectTestApp(db, stub.url);
});
afterAll(async () => {
  await db.update(settings).set({ githubApp: null });
  await stub.close();
  await db.$client.end();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const commit = async (cwd: string, file: string, text: string) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(cwd, file), text);
  await git(cwd, ["add", file]);
  await git(cwd, [...who, "commit", "-q", "-m", `edit ${file}`]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
};

let n = 0;
/** A clone of origin with a `kanbot/` worktree beside it, branched from main. */
async function setup() {
  const id = ++n;
  const checkout = join(tmp, `checkout-${id}`);
  await git(tmp, ["clone", "-q", "--", origin, checkout]);
  const wt = { path: join(tmp, `wt-${id}`), branch: `kanbot/T-${id}` };
  await git(checkout, ["worktree", "add", "-q", "-b", wt.branch, wt.path, "main"]);
  return { checkout, wt };
}

describe("rebaseBranch", () => {
  it("does nothing when main is already in the branch", async () => {
    const { wt } = await setup();
    expect(await rebaseBranch(wt, "main")).toEqual({ rebased: false });
  });

  it("replays the branch's commits onto a moved main, keeping their authors", async () => {
    const { checkout, wt } = await setup();
    await commit(wt.path, "mine.txt", "mine\n");
    const main = await commit(checkout, "theirs.txt", "theirs\n");
    expect(await rebaseBranch(wt, "main")).toEqual({ rebased: true });
    expect((await git(wt.path, ["merge-base", "main", "HEAD"])).trim()).toBe(main);
    expect(await git(wt.path, ["log", "-1", "--format=%an|%cn"])).toBe("Test|Kanbot\n");
  });

  it("aborts on a conflict and names the files, leaving the branch as it was", async () => {
    const { checkout, wt } = await setup();
    const mine = await commit(wt.path, "same.txt", "mine\n");
    await commit(checkout, "same.txt", "theirs\n");
    const r = await rebaseBranch(wt, "main");
    expect(r.rebased).toBe(false);
    expect(r.conflict?.files).toEqual(["same.txt"]);
    expect(r.conflict?.diff).toContain("same.txt");
    expect((await git(wt.path, ["rev-parse", "HEAD"])).trim()).toBe(mine);
    expect(await git(wt.path, ["status", "--porcelain"])).toBe("");
  });

  it("leaves a worktree with uncommitted work alone", async () => {
    const { checkout, wt } = await setup();
    await commit(checkout, "theirs.txt", "theirs\n");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(wt.path, "wip.txt"), "wip\n");
    expect(await rebaseBranch(wt, "main")).toEqual({ rebased: false });
    expect(await git(wt.path, ["status", "--porcelain"])).toBe("?? wip.txt\n");
  });

  it("refuses a branch outside kanbot/", async () => {
    const { wt } = await setup();
    await expect(rebaseBranch({ ...wt, branch: "main" }, "main")).rejects.toThrow(/Refusing/);
  });
});

describe("keepCurrent", () => {
  it("force-pushes a rebased PR branch with a lease", async () => {
    const { checkout, wt } = await setup();
    await commit(wt.path, "mine.txt", "mine\n");
    await git(wt.path, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
    await commit(checkout, "theirs.txt", "theirs\n");
    const r = await keepCurrent(db, gh, true, wt, "main");
    expect(r.conflict).toBeUndefined();
    const head = (await git(wt.path, ["rev-parse", "HEAD"])).trim();
    expect(r.pushedSha).toBe(head);
    expect((await git(origin, ["rev-parse", wt.branch])).trim()).toBe(head);
  });

  it("keeps the owner's pushed commits when Kanbot also committed", async () => {
    const { wt } = await setup();
    await commit(wt.path, "mine.txt", "mine\n");
    await git(wt.path, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
    const owner = join(tmp, `owner-${n}`);
    await git(tmp, ["clone", "-q", "-b", wt.branch, "--", origin, owner]);
    const theirs = await commit(owner, "owner.txt", "owner\n");
    await git(owner, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
    await commit(wt.path, "more.txt", "more\n");
    const r = await keepCurrent(db, gh, true, wt, "main");
    expect(r.conflict).toBeUndefined();
    await git(wt.path, ["merge-base", "--is-ancestor", theirs, "HEAD"]); // throws if rewritten away
    expect(await git(wt.path, ["log", "--format=%s", "-3"])).toBe(
      "edit more.txt\nedit owner.txt\nedit mine.txt\n",
    );
  });

  it("reports a conflict with the owner's commits and changes nothing", async () => {
    const { wt } = await setup();
    await commit(wt.path, "base.txt", "base\n");
    await git(wt.path, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
    const owner = join(tmp, `owner-${n}`);
    await git(tmp, ["clone", "-q", "-b", wt.branch, "--", origin, owner]);
    await commit(owner, "base.txt", "owner\n");
    await git(owner, ["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`]);
    const mine = await commit(wt.path, "base.txt", "kanbot\n");
    const r = await keepCurrent(db, gh, true, wt, "main");
    expect(r.conflict?.files).toEqual(["base.txt"]);
    expect(r.conflict?.onto).toBe(`${wt.branch} on GitHub`);
    expect((await git(wt.path, ["rev-parse", "HEAD"])).trim()).toBe(mine);
  });

  it("rebases a ticket without a PR but pushes nothing", async () => {
    const { checkout, wt } = await setup();
    await commit(wt.path, "mine.txt", "mine\n");
    await commit(checkout, "theirs.txt", "theirs\n");
    expect(await keepCurrent(db, gh, false, wt, "main")).toEqual({});
    expect(await git(wt.path, ["log", "--format=%s", "-2"])).toBe(
      "edit mine.txt\nedit theirs.txt\n",
    );
  });
});
