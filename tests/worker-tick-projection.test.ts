import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    title: "t",
    prompt: "t",
    kind: "agent",
    status: "queued",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
    ...overrides,
  };
}

const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3600000).toISOString();
const fat = "x".repeat(20000);

test("tick executes exactly the due tasks via the projected scan", async () => {
  const db = await createStore();
  try {
    const executed: string[] = [];
    const handle = async (_owner: string, value: AgentTask) => {
      executed.push(value.id);
      return { status: "succeeded" as const, result: "r" };
    };
    await db.put("o", "tasks", task("q1"));
    await db.put("o", "tasks", task("sched-due", { status: "scheduled", nextRunAt: past }));
    await db.put("o", "tasks", task("sched-future", { status: "scheduled", nextRunAt: future }));
    await db.put(
      "o",
      "tasks",
      task("run-expired", { status: "running", leaseId: "l1", leaseUntil: past }),
    );
    await db.put(
      "o",
      "tasks",
      task("run-fresh", { status: "running", leaseId: "l2", leaseUntil: future }),
    );
    await db.put("o", "tasks", task("term-fat", { status: "succeeded", result: fat }));
    await db.put("o", "tasks", task("paused", { status: "paused" }));
    // waiting_approval with a live review action is skipped; with an expired one the
    // action flips to expired and the task runs; with no action the task runs.
    await db.put("o", "actions", { id: "a-live", status: "awaiting_review", expiresAt: future });
    await db.put("o", "actions", { id: "a-exp", status: "awaiting_review", expiresAt: past });
    await db.put("o", "tasks", task("wa-live", { status: "waiting_approval", actionId: "a-live" }));
    await db.put("o", "tasks", task("wa-exp", { status: "waiting_approval", actionId: "a-exp" }));
    await db.put("o", "tasks", task("wa-none", { status: "waiting_approval" }));

    // The tick runs at most 3 eligible tasks per pass; a second tick picks up the rest.
    await new TaskWorker(db, handle).tick();
    await new TaskWorker(db, handle).tick();

    assert.deepEqual(
      executed.sort(),
      ["q1", "sched-due", "run-expired", "wa-exp", "wa-none"].sort(),
    );
    assert.equal((await db.get<{ status: string }>("o", "actions", "a-exp"))?.status, "expired");
    assert.equal(
      (await db.get<{ status: string }>("o", "actions", "a-live"))?.status,
      "awaiting_review",
    );
    // Terminal + non-due tasks untouched.
    assert.equal((await db.get<AgentTask>("o", "tasks", "term-fat"))?.status, "succeeded");
    assert.equal((await db.get<AgentTask>("o", "tasks", "sched-future"))?.status, "scheduled");
    assert.equal((await db.get<AgentTask>("o", "tasks", "run-fresh"))?.status, "running");
  } finally {
    await db.close();
  }
});

test("scanTaskTickCandidates projects only the filter fields", async () => {
  const db = await createStore();
  try {
    await db.put(
      "o",
      "tasks",
      task("fat1", {
        status: "succeeded",
        result: fat,
        evidence: [{ id: "e", kind: "web", title: "t", excerpt: fat }],
        state: { note: fat },
      }),
    );
    const rows = await db.scanTaskTickCandidates();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ["actionId", "id", "leaseUntil", "nextRunAt", "owner", "status"].sort(),
    );
    assert.equal(rows[0].status, "succeeded");
    // The fat payloads never leave the database on the tick path.
    assert.ok(!("result" in rows[0]) && !("evidence" in rows[0]) && !("state" in rows[0]));
  } finally {
    await db.close();
  }
});
