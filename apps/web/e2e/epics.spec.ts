import { expect, test } from "@playwright/test";

// UC-11 (M4.5): Plan B splits an epic into proposed tickets; accepting creates them in Backlog as its
// children, with criteria and confirmed "blocks" links; an epic itself never enters the build loop.
test("accepting an epic's proposed tickets creates linked children in Backlog", async ({
  request,
}) => {
  const prefix = `E${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const project = await (
    await request.post("/api/projects", { data: { name: "Epics", keyPrefix: prefix } })
  ).json();
  const columnId = async (slug: string) =>
    (await (await request.get(`/api/projects/${project.id}/board`)).json()).columns.find(
      (c: { slug: string }) => c.slug === slug,
    ).id as string;
  const epic = await (
    await request.post(`/api/projects/${project.id}/tickets`, {
      data: { title: "Due dates for todos", type: "epic", labels: ["replay:epic"] },
    })
  ).json();
  const detail = async (id = epic.id) => (await request.get(`/api/tickets/${id}`)).json();
  const accept = (refs: string[]) =>
    request.post(`/api/tickets/${epic.id}/accept-proposals`, { data: { refs } });

  // Nothing to accept before Plan B has run.
  expect((await accept(["t1"])).status()).toBe(409);
  await request.post(`/api/tickets/${epic.id}/move`, {
    data: { toColumnId: await columnId("planning"), position: "a0" },
  });
  await expect.poll(async () => (await detail()).statusFlag).toBe("plan_ready");

  const first = await accept(["t1", "t2"]);
  expect(first.status()).toBe(201);
  const { created } = await first.json();
  expect(created.map((c: { ref: string }) => c.ref)).toEqual(["t1", "t2"]);
  expect((await accept(["t1"])).status()).toBe(409); // already accepted
  expect((await accept(["nope"])).status()).toBe(400);
  expect((await accept(["t3"])).status()).toBe(201);

  const e = await detail();
  expect(e.children.map((c: { key: string }) => c.key)).toEqual([
    `${prefix}-2`,
    `${prefix}-3`,
    `${prefix}-4`,
  ]);
  expect(e.children.every((c: { columnSlug: string }) => c.columnSlug === "backlog")).toBe(true);

  // The API ticket: blocked by the store ticket, with its criteria, touch set and parent.
  const api = await detail(created[1].id);
  expect(api.parent.key).toBe(`${prefix}-1`);
  expect(api.touchPaths).toEqual(["src/server.ts"]);
  expect(api.criteria.map((c: { text: string; source: string }) => [c.text, c.source])).toEqual([
    ["POST with an invalid `due` returns 400", "agent"],
  ]);
  expect(api.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relation: "blocked_by", key: `${prefix}-2`, confirmed: true }),
      expect.objectContaining({ relation: "blocks", key: `${prefix}-4`, confirmed: true }),
    ]),
  );
  expect(api.links).toHaveLength(2);
  // Accepted later, the page ticket still gets its link to the API ticket.
  expect((await detail(e.children[2].id)).links).toEqual([
    expect.objectContaining({ relation: "blocked_by", key: `${prefix}-3` }),
  ]);

  const board = await (await request.get(`/api/projects/${project.id}/board`)).json();
  expect(board.tickets.find((t: { id: string }) => t.id === epic.id).epic).toEqual({
    total: 3,
    done: 0,
  });
  const toBuild = await request.post(`/api/tickets/${epic.id}/move`, {
    data: { toColumnId: await columnId("in_progress"), position: "a0" },
  });
  expect(toBuild.status()).toBe(409);
  expect((await toBuild.json()).error.code).toBe("epic");
});

// UC-10: Dr. Rabbit Hole's research on a spike proposes tickets; approving the spike creates them all in
// Backlog and moves the spike to Done.
test("approving a spike creates its proposed tickets and finishes it", async ({ request }) => {
  const prefix = `S${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const project = await (
    await request.post("/api/projects", { data: { name: "Spikes", keyPrefix: prefix } })
  ).json();
  const board = async () => (await request.get(`/api/projects/${project.id}/board`)).json();
  const planning = (await board()).columns.find((c: { slug: string }) => c.slug === "planning").id;
  const spike = await (
    await request.post(`/api/projects/${project.id}/tickets`, {
      data: { title: "How to persist?", type: "spike" },
    })
  ).json();
  const detail = async () => (await request.get(`/api/tickets/${spike.id}`)).json();
  await request.post(`/api/tickets/${spike.id}/move`, {
    data: { toColumnId: planning, position: "a0" },
  });
  await expect.poll(async () => (await detail()).statusFlag).toBe("plan_ready");

  expect((await request.post(`/api/tickets/${spike.id}/approve-plan`)).status()).toBe(204);
  const s = await detail();
  expect(s.columnSlug).toBe("done");
  expect(s.children.length).toBeGreaterThan(0);
  expect(s.children.every((c: { columnSlug: string }) => c.columnSlug === "backlog")).toBe(true);
});
