// Onboarding's worker steps (§10): clone + detect, the baseline, and the gates that depend on them.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COLUMNS, uuidv7 } from "@kanbot/shared";
import {
  AgentsDisabledError,
  columns,
  createDb,
  projects,
  settings,
  startColumnAgent,
  tickets,
} from "@kanbot/shared/db";
import { prepareSampleRepo, TEST_DATABASE_URL } from "@kanbot/shared/db/testing";
import { decryptEnv, encryptEnv } from "@kanbot/shared/github";
import { git } from "@kanbot/shared/repo";
import { startGitHubStub, type GitHubStub } from "@kanbot/shared/github-stub";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardNext } from "../src/onboard";
import { runChecks } from "../src/commands";
import { connectTestApp } from "./github-app";

const db = createDb(TEST_DATABASE_URL);
let tmp: string;
let stub: GitHubStub;
const env = { ...process.env };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kanbot-onboard-"));
  const origin = await prepareSampleRepo(join(tmp, "origin"));
  stub = await startGitHubStub({ owner: "octo", repo: "sample", cloneUrl: origin });
  process.env.KANBOT_REPOS_DIR = join(tmp, "repos");
  await connectTestApp(db, stub.url);
  // Other files' queued steps must not be picked up here.
  await db
    .update(projects)
    .set({ onboarding: sql`jsonb_set(${projects.onboarding}, '{state}', '"failed"')` })
    .where(sql`${projects.onboarding}->>'state' in ('queued', 'running')`);
});

afterAll(async () => {
  process.env = env;
  // Encrypted under this file's random key: anything else reading the test database couldn't open it.
  await db.update(settings).set({ githubApp: null });
  await stub.close();
  await db.$client.end();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function githubProject() {
  const [p] = await db
    .insert(projects)
    .values({
      name: "sample",
      keyPrefix: `G${uuidv7()
        .slice(-6)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "X")}`,
      githubOwner: "octo",
      githubRepo: "sample",
      onboarding: { step: "clone", state: "queued" },
    })
    .returning();
  await db
    .insert(columns)
    .values(DEFAULT_COLUMNS.map((c, i) => ({ ...c, projectId: p!.id, position: i })));
  return p!;
}
const reload = async (id: string) =>
  (await db.select().from(projects).where(eq(projects.id, id)))[0]!;

describe("onboarding (§10)", () => {
  it("clones with the App's token, seeds the settings and waits for the owner", async () => {
    const p = await githubProject();
    expect(await onboardNext(db)).toBe(true);
    const q = await reload(p.id);
    expect(q.onboarding).toEqual({ step: "commands", state: "waiting" });
    expect(q.repoPath).toBe(join(tmp, "repos", p.keyPrefix.toLowerCase()));
    // The sample repo's .kanbot/project.yml wins over detection; package.json fills nothing it set.
    expect(q.commands?.test).toBe("node --test");
    expect(q.image).toBe("node:24-bookworm"); // detected: the repo names no image
    expect(await onboardNext(db)).toBe(false);
    // Retry (or the key reused): the clone is there, with main checked out; it is fetched and reset.
    await db
      .update(projects)
      .set({ onboarding: { step: "clone", state: "queued" } })
      .where(eq(projects.id, p.id));
    await onboardNext(db);
    expect((await reload(p.id)).onboarding).toEqual({ step: "commands", state: "waiting" });
  });

  it("records the baseline, and the checks gate skips what already failed", async () => {
    const p = await githubProject();
    await onboardNext(db);
    // Host toolchain (no image), and a lint that fails on main before any ticket.
    await db
      .update(projects)
      .set({
        image: null,
        commands: { test: "node --test", lint: "node no-such-file.js" },
        onboarding: { step: "baseline", state: "queued" },
      })
      .where(eq(projects.id, p.id));
    await onboardNext(db);
    const q = await reload(p.id);
    expect(q.onboarding).toEqual({ step: "baseline", state: "waiting" });
    expect(q.baseline?.test).toMatchObject({ ok: true });
    expect(q.baseline?.lint).toMatchObject({ command: "node no-such-file.js", ok: false });
    expect(q.baseline?.lint?.output).toMatch(/no-such-file/);
    const commands = q.commands!;
    expect((await runChecks(commands, q.repoPath!))?.command).toBe("node no-such-file.js");
    expect(await runChecks(commands, q.repoPath!, undefined, ["node no-such-file.js"])).toBeNull();
  });

  it("proposes the example env file's names, and the baseline runs with the values, redacted (§10)", async () => {
    const origin = join(tmp, "origin");
    await writeFile(join(origin, ".env.example"), "# keys\nKB_SECRET=\nexport KB_OTHER=x\n");
    await git(origin, ["add", ".env.example"]);
    await git(origin, ["commit", "-q", "-m", "env example"]);
    const p = await githubProject();
    await onboardNext(db);
    const q = await reload(p.id);
    expect(decryptEnv(q.env)).toEqual({ KB_SECRET: "", KB_OTHER: "" });

    // The owner fills one in; the baseline's commands see it, and what they print is stored redacted.
    const value = "s3cret-value-1";
    await db
      .update(projects)
      .set({
        image: null,
        env: encryptEnv({ KB_SECRET: value, KB_OTHER: "" }),
        commands: {
          test: `node -e "process.exit(process.env.KB_SECRET === '${value}' ? 0 : 1)"`,
          lint: `node -e "console.log('got ' + process.env.KB_SECRET); process.exit(1)"`,
        },
        onboarding: { step: "baseline", state: "queued" },
      })
      .where(eq(projects.id, p.id));
    await onboardNext(db);
    const b = (await reload(p.id)).baseline!;
    expect(b.test).toMatchObject({ ok: true });
    expect(b.lint?.output).toContain("got [redacted]");
    expect(
      Object.values(b)
        .map((r) => r.output)
        .join(),
    ).not.toContain(value);
  });

  it("reports a failed clone on the step, for the owner to retry", async () => {
    const p = await githubProject();
    await db.update(projects).set({ githubRepo: "missing" }).where(eq(projects.id, p.id));
    await onboardNext(db);
    const q = await reload(p.id);
    expect(q.onboarding).toMatchObject({ step: "clone", state: "failed" });
    expect(q.onboarding!.error).toMatch(/404/);
  });

  it("keeps agents off a GitHub project until setup is ready", async () => {
    const p = await githubProject();
    const [backlog, planning] = await db
      .select()
      .from(columns)
      .where(eq(columns.projectId, p.id))
      .orderBy(columns.position);
    const [t] = await db
      .insert(tickets)
      .values({ projectId: p.id, number: 1, title: "x", columnId: backlog!.id, position: "a0" })
      .returning();
    await expect(
      db.transaction((tx) => startColumnAgent(tx, p.id, t!.id, planning!)),
    ).rejects.toBeInstanceOf(AgentsDisabledError);
    await db
      .update(projects)
      .set({ onboarding: { step: "ready", state: "waiting", override: true } })
      .where(eq(projects.id, p.id));
    const run = await db.transaction((tx) => startColumnAgent(tx, p.id, t!.id, planning!));
    expect(run?.agentSlug).toBe("plan-b");
  });
});
