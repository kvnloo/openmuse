import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import type { AgentNotification, AgentTask } from "../packages/domain/src/agent.ts";

// Exercises the real AgentService.maintain() task loop with stubbed collaborators.
// Only tasks are seeded, so the monitors/ideas/agent-settings loops are no-ops
// and each maintain() pass exercises exactly the tasks recovery loop.
function task(id: string, status: AgentTask["status"], extra: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Task ${id}`,
    kind: "agent",
    status,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: status === "failed" ? 3 : 1,
    error: status === "failed" ? "simulated failure" : null,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
    ...extra,
  };
}

async function serviceWith(db: Store) {
  const service = new AgentService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return service as unknown as { maintain(): Promise<void> };
}

async function notifications(db: Store): Promise<AgentNotification[]> {
  return (await db.scan<AgentNotification>("notifications")).map(({ value }) => value);
}

test("maintenance recovers a publication lost to a crash, then skips the marked row", async () => {
  const db = await createStore();
  try {
    // Simulates the crash window: terminal state committed by the worker's
    // checkpoint, but the process exited before the settled callback ran
    // publishOutcome — so no notification and no marker exist yet.
    await db.put("owner", "tasks", task("task1", "succeeded"));
    const service = await serviceWith(db);

    await service.maintain();
    const first = await notifications(db);
    assert.equal(first.filter((n) => n.taskId === "task1").length, 1);
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "task1"))?.state.publishedOutcome,
      "task-done:task1",
    );

    // Second pass: the row is skipped, so no new notification and no re-read.
    let taskGets = 0;
    const originalGet = db.get.bind(db);
    db.get = (async (owner: string, kind: string, id: string) => {
      if (kind === "tasks") taskGets++;
      return originalGet(owner, kind, id);
    }) as Store["get"];
    await service.maintain();
    db.get = originalGet;
    const second = await notifications(db);
    assert.equal(second.length, first.length);
    assert.equal(taskGets, 0);
  } finally {
    await db.close();
  }
});

test("a retried failure re-notifies because the outcome key changed", async () => {
  const db = await createStore();
  try {
    await db.put(
      "owner",
      "tasks",
      task("task1", "failed", { state: { publishedOutcome: "task-error:task1:3" } }),
    );
    // Retry ran and failed again: attempts bumped, stale marker.
    await db.compareAndSwap("owner", "tasks", "task1", { status: "failed" }, { attempts: 4 });
    const service = await serviceWith(db);

    await service.maintain();
    assert.equal((await notifications(db)).filter((n) => n.taskId === "task1").length, 1);
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "task1"))?.state.publishedOutcome,
      "task-error:task1:4",
    );
  } finally {
    await db.close();
  }
});

test("cancelled tasks are never notified and are skipped on later passes", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task("task1", "cancelled"));
    const service = await serviceWith(db);

    await service.maintain();
    assert.equal(await notifications(db).then((ns) => ns.length), 0);
    assert.equal(
      (await db.get<AgentTask>("owner", "tasks", "task1"))?.state.publishedOutcome,
      "cancelled:task1",
    );

    let taskGets = 0;
    const originalGet = db.get.bind(db);
    db.get = (async (owner: string, kind: string, id: string) => {
      if (kind === "tasks") taskGets++;
      return originalGet(owner, kind, id);
    }) as Store["get"];
    await service.maintain();
    db.get = originalGet;
    assert.equal(taskGets, 0);
  } finally {
    await db.close();
  }
});

test("a changed waiting_input question re-notifies", async () => {
  const db = await createStore();
  try {
    const t = task("task1", "waiting_input", { question: "Which date works?" });
    const { createHash } = await import("node:crypto");
    const key = `input:task1:${createHash("sha256").update("Which date works?").digest("hex")}`;
    t.state.publishedOutcome = key;
    await db.put("owner", "tasks", t);
    await db.compareAndSwap(
      "owner",
      "tasks",
      "task1",
      { status: "waiting_input" },
      { question: "A different question?" },
    );
    const service = await serviceWith(db);

    await service.maintain();
    assert.equal((await notifications(db)).filter((n) => n.taskId === "task1").length, 1);
  } finally {
    await db.close();
  }
});
