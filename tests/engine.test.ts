import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore } from "../apps/server/src/db.ts";
import { analyzeSpending } from "../apps/server/src/engine/finance.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import { AppError } from "../apps/server/src/errors.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";

function task(id = "task1"): AgentTask {
  return {
    id,
    title: "Check a source",
    prompt: "Check a source",
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
  };
}
test("two workers claim one task only once", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let calls = 0;
    const handle = async () => {
      calls++;
      return { status: "succeeded" as const, result: "actual result" };
    };
    await Promise.all([new TaskWorker(db, handle).tick(), new TaskWorker(db, handle).tick()]);
    assert.equal(calls, 1);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "succeeded");
  } finally {
    await db.close();
  }
});
test("cancellation invalidates a stale worker before its next effect", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let effects = 0;
    const worker = new TaskWorker(db, async (owner, value, ctx) => {
      await db.compareAndSwap(
        owner,
        "tasks",
        value.id,
        { status: "running" },
        { status: "cancelled", leaseId: null, leaseUntil: null },
      );
      await ctx.guard();
      effects++;
      return { status: "succeeded" };
    });
    await worker.tick();
    assert.equal(effects, 0);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "cancelled");
  } finally {
    await db.close();
  }
});
test("expired leases recover saved checkpoints after the database restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-engine-"));
  try {
    let db = await createStore({ dataDir: join(directory, "db") });
    await db.put("owner", "tasks", {
      ...task(),
      status: "running",
      leaseId: "dead-worker",
      leaseUntil: "2020-01-01T00:00:00Z",
      state: { completedStep: "imported", fileId: "persisted-file" },
    });
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    try {
      let observed: unknown;
      const worker = new TaskWorker(db, async (_owner, value, ctx) => {
        observed = value.state;
        await ctx.event("step", "Resumed at the checkpoint");
        return { status: "succeeded", result: "Recovered" };
      });
      await worker.tick();
      assert.deepEqual(observed, { completedStep: "imported", fileId: "persisted-file" });
      assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "succeeded");
    } finally {
      await db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("scheduled tasks wait for due time and approvals wait for a recorded outcome", async () => {
  const db = await createStore();
  try {
    let now = 1000,
      calls = 0;
    const worker = new TaskWorker(
      db,
      async () => {
        calls++;
        return { status: "succeeded" };
      },
      { now: () => now },
    );
    await db.put("owner", "tasks", {
      ...task("later"),
      status: "scheduled",
      nextRunAt: new Date(2000).toISOString(),
    });
    await worker.tick();
    assert.equal(calls, 0);
    now = 3000;
    await worker.tick();
    assert.equal(calls, 1);
    await db.put("owner", "tasks", {
      ...task("review"),
      status: "waiting_approval",
      actionId: "a",
    });
    await db.put("owner", "actions", { id: "a", status: "awaiting_review" });
    await worker.tick();
    assert.equal(calls, 1);
    await db.put("owner", "actions", { id: "a", status: "succeeded" });
    await worker.tick();
    assert.equal(calls, 2);
  } finally {
    await db.close();
  }
});
test("finance artifacts compute cents exactly and reject ambiguous CSV", () => {
  const report = analyzeSpending(
    'date,description,amount,category\n2026-09-01,Salary,-1000,Income\n2026-09-02,"Coffee, local",10.10,Food\n2026-09-03,Lunch,20.20,Food',
  );
  assert.equal(report.spending, 30.3);
  assert.equal(report.saved, 969.7);
  assert.equal(report.categories[0].amount, 30.3);
  assert.throws(() =>
    analyzeSpending("date,description,amount,category\n2026-02-31,Purchase,10,Food"),
  );
  assert.throws(() =>
    analyzeSpending("date,description,amount,category\n2026-09-01,Purchase,1.234,Food"),
  );
});

test("pending reviews do not starve queued work", async () => {
  const db = await createStore();
  try {
    for (let i = 0; i < 4; i++) {
      await db.put("owner", "tasks", {
        ...task(`review-${i}`),
        status: "waiting_approval",
        actionId: `action-${i}`,
      });
      await db.put("owner", "actions", { id: `action-${i}`, status: "awaiting_review" });
    }
    await db.put("owner", "tasks", task("ready"));
    await new TaskWorker(db, async () => ({ status: "succeeded" })).tick();
    assert.equal((await db.get<AgentTask>("owner", "tasks", "ready"))?.status, "succeeded");
  } finally {
    await db.close();
  }
});
test("run history keeps the time the run started", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    await new TaskWorker(
      db,
      async () => {
        clock += 60000;
        return { status: "succeeded" };
      },
      { now: () => clock },
    ).tick();
    const [run] = (await db.scan<{ startedAt: string; finishedAt: string }>("runs")).map(
      ({ value }) => value,
    );
    assert.equal(run?.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(run?.finishedAt, "2026-01-01T00:01:00.000Z");
  } finally {
    await db.close();
  }
});
test("a failed run record does not leave the task stuck in the worker", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "tasks", task());
    const flaky = Object.create(db) as typeof db;
    flaky.put = (async (owner: string, kind: string, value: { id: string }) => {
      if (kind === "runs") throw new Error("database unavailable");
      return db.put(owner, kind, value);
    }) as typeof db.put;
    const worker = new TaskWorker(flaky, async () => ({ status: "succeeded" }));
    await worker.tick().catch(() => {});
    const stopped = await Promise.race([
      worker.stop().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ]);
    assert.equal(stopped, true);
    assert.equal((await db.get<AgentTask>("owner", "tasks", "task1"))?.status, "failed");
  } finally {
    await db.close();
  }
});
test("cancelling a task still succeeds when its cleanup deny loses to a concurrent decision", async (t) => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      connected: async () => true,
      now: () => Date.now(),
      execute: async () => "sent",
    });
    const service = new AgentService(
      db,
      {} as never,
      {} as never,
      {} as never,
      actions,
      {} as never,
    );
    const proposal = await actions.propose("owner", {
      kind: "email.send",
      data: { to: ["reviewer@example.com"], subject: "Review", body: "Approve?" },
    });
    await db.put("owner", "tasks", {
      ...task(),
      status: "waiting_approval",
      actionId: proposal.id,
    });
    // A concurrent decision (or expiry) wins the cleanup claim after the
    // awaiting_review read: the cleanup deny throws 409.
    t.mock.method(actions, "decide", async () => {
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    });
    const cancelled = await service.control("owner", "task1", "cancel");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(
      (await db.get<ActionProposal>("owner", "actions", proposal.id))?.status,
      "awaiting_review",
    );
  } finally {
    await db.close();
  }
});
test("cancelling a task still surfaces a non-conflict cleanup failure", async (t) => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      connected: async () => true,
      now: () => Date.now(),
      execute: async () => "sent",
    });
    const service = new AgentService(
      db,
      {} as never,
      {} as never,
      {} as never,
      actions,
      {} as never,
    );
    const proposal = await actions.propose("owner", {
      kind: "email.send",
      data: { to: ["reviewer@example.com"], subject: "Review", body: "Approve?" },
    });
    await db.put("owner", "tasks", {
      ...task(),
      status: "waiting_approval",
      actionId: proposal.id,
    });
    t.mock.method(actions, "decide", async () => {
      throw new AppError("database unavailable", 500);
    });
    await assert.rejects(service.control("owner", "task1", "cancel"), /database unavailable/);
  } finally {
    await db.close();
  }
});
test("a fresh user answer is not swallowed by a pending review", async () => {
  const db = await createStore();
  try {
    const { AgentService } = await import("../apps/server/src/engine/service.ts");
    const agent = new AgentService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await db.put("owner", "actions", { id: "p1", status: "awaiting_review" });
    await db.put("owner", "tasks", {
      ...task("answer-task"),
      kind: "finance",
      status: "queued",
      actionId: "p1",
      input: { csv: "date,description,amount,category\n2026-09-01,Coffee,3.50,Food" },
      state: { answer: "count the coffee separately" },
    });
    await agent.worker.tick();
    const saved = await db.get<AgentTask>("owner", "tasks", "answer-task");
    assert.equal(saved?.status, "succeeded");
  } finally {
    await db.close();
  }
});
test("a consumed answer is cleared from task state when the run commits", async () => {
  const db = await createStore();
  try {
    const waiting = task("task1");
    waiting.status = "waiting_input";
    waiting.question = "Old question";
    waiting.state = { answer: "stale answer" };
    await db.put("owner", "tasks", waiting);
    // Mirror service.answer(): re-queue, clear the question, keep the answer.
    await db.compareAndSwap(
      "owner",
      "tasks",
      "task1",
      { status: "waiting_input" },
      { status: "queued", question: null },
    );
    let seenAnswer: unknown;
    const handle = async (_owner: string, value: AgentTask) => {
      seenAnswer = value.state.answer;
      return { status: "waiting_input" as const, question: "New question" };
    };
    await new TaskWorker(db, handle).tick();
    assert.equal(seenAnswer, "stale answer", "the run must still receive the answer");
    const saved = await db.get<AgentTask>("owner", "tasks", "task1");
    assert.equal(saved?.status, "waiting_input");
    assert.equal(saved?.question, "New question");
    assert.equal(
      saved?.state.answer,
      null,
      "the consumed answer must not leak into the next round",
    );
  } finally {
    await db.close();
  }
});
test("a task paused during review prep gets a fresh review on resume, not the cleanup-denied one", async () => {
  const { ActionService } = await import("../apps/server/src/actions.ts");
  const { AgentService } = await import("../apps/server/src/engine/service.ts");
  const { LostLeaseError } = await import("../apps/server/src/engine/worker.ts");
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      execute: async () => "sent",
      prepare: async (_owner, input) => ({ input }),
      connected: async () => true,
      connection: async () => ({ id: "conn-1", account: "sam@example.com" }),
    });
    const agent = new AgentService(
      db,
      { mode: "sample" } as never,
      { connection: async () => ({ id: "conn-1", account: "sam@example.com" }) } as never,
      {} as never,
      actions,
      {} as never,
    );
    const owner = "prepare-owner";
    const docTask = { ...task("task1"), state: { connectionId: "conn-1" } };
    const input = {
      kind: "email.send" as const,
      data: {
        to: ["sam@example.com"],
        cc: [],
        bcc: [],
        subject: "Visit",
        body: "See attached.",
        attachmentIds: [],
      },
    };
    const lostLease = {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (): Promise<never> => {
        throw new LostLeaseError();
      },
      event: async () => {},
    };
    // A pause lands between propose() and the actionId checkpoint: prepare()
    // denies the orphaned proposal as cleanup and rethrows.
    await assert.rejects(
      agent.prepare(owner, docTask, input, "document-reply", lostLease as never),
      LostLeaseError,
    );
    const orphaned = await db.list<{ id: string; status: string }>(owner, "actions");
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].status, "denied");
    // On resume the task re-prepares with the same idempotency key. The dead
    // review must not be returned: the task would fail with a "Reviewed action
    // denied" the user never issued.
    const resumed = {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch: Record<string, unknown>) => ({ ...docTask, ...patch }),
      event: async () => {},
    };
    const fresh = await agent.prepare(owner, docTask, input, "document-reply", resumed as never);
    assert.equal(fresh.status, "awaiting_review");
    assert.notEqual(fresh.id, orphaned[0].id);
  } finally {
    await db.close();
  }
});
test("resuming a task whose linked review died while paused re-proposes instead of failing", async () => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      execute: async () => "sent",
      prepare: async (_owner, input) => ({ input }),
      connected: async () => true,
      connection: async () => ({ id: "conn-1", account: "sam@example.com" }),
    });
    const agent = new AgentService(db, {} as never, {} as never, {} as never, actions, {} as never);
    const owner = "resume-dead-owner";
    const input = {
      kind: "email.send" as const,
      data: { to: ["sam@example.com"], subject: "Visit", body: "See attached." },
    };
    const proposal = await actions.propose(owner, input, "task1:document-reply", "task1");
    // The orphaned review is denied (prepare()'s checkpoint-failure cleanup, or
    // a user deny) while the task sits paused.
    await actions.decide(owner, proposal.id, proposal.hash, "deny");
    await db.put(owner, "tasks", {
      ...task("task1"),
      status: "paused",
      actionId: proposal.id,
    });
    const resumed = await agent.control(owner, "task1", "resume");
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.actionId, null);
    // The worker must not fail the task with "Reviewed action denied": with no
    // linked review the agent simply continues (no model configured -> asks).
    await agent.worker.tick();
    const after = await db.get<AgentTask>(owner, "tasks", "task1");
    assert.equal(after?.status, "waiting_input");
  } finally {
    await db.close();
  }
});
test("retrying a failed task with a dead linked review is allowed and clears the link", async () => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      execute: async () => "sent",
      connected: async () => true,
    });
    const agent = new AgentService(db, {} as never, {} as never, {} as never, actions, {} as never);
    const owner = "retry-dead-owner";
    const proposal = await actions.propose(owner, {
      kind: "email.send" as const,
      data: { to: ["sam@example.com"], subject: "Visit", body: "See attached." },
    });
    // The review expired while the task was away; the outcome is certain
    // (nothing executed), so retry must be allowed.
    await db.put(owner, "actions", {
      ...proposal,
      status: "expired",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await db.put(owner, "tasks", {
      ...task("task1"),
      status: "failed",
      error: "Reviewed action expired: no decision was made in time",
      actionId: proposal.id,
    });
    const retried = await agent.control(owner, "task1", "retry");
    assert.equal(retried.status, "queued");
    assert.equal(retried.actionId, null);
    await agent.worker.tick();
    const after = await db.get<AgentTask>(owner, "tasks", "task1");
    assert.equal(after?.status, "waiting_input");
  } finally {
    await db.close();
  }
});
test("retry still refuses when the linked review outcome is uncertain", async () => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      execute: async () => "sent",
      connected: async () => true,
    });
    const agent = new AgentService(db, {} as never, {} as never, {} as never, actions, {} as never);
    const owner = "retry-uncertain-owner";
    const proposal = await actions.propose(owner, {
      kind: "email.send" as const,
      data: { to: ["sam@example.com"], subject: "Visit", body: "See attached." },
    });
    await db.put(owner, "actions", { ...proposal, status: "outcome_unknown" });
    await db.put(owner, "tasks", {
      ...task("task1"),
      status: "failed",
      error: "boom",
      actionId: proposal.id,
    });
    await assert.rejects(agent.control(owner, "task1", "retry"), /uncertain/);
  } finally {
    await db.close();
  }
});
test("retry with a succeeded linked review keeps the receipt replay path", async () => {
  const db = await createStore();
  try {
    const actions = new ActionService(db, {
      execute: async () => "sent",
      connected: async () => true,
    });
    const agent = new AgentService(db, {} as never, {} as never, {} as never, actions, {} as never);
    const owner = "retry-receipt-owner";
    const proposal = await actions.propose(owner, {
      kind: "email.send" as const,
      data: { to: ["sam@example.com"], subject: "Visit", body: "See attached." },
    });
    await db.put(owner, "actions", { ...proposal, status: "succeeded", result: "sent" });
    await db.put(owner, "tasks", {
      ...task("task1"),
      status: "failed",
      error: "crashed after the review completed",
      actionId: proposal.id,
    });
    const retried = await agent.control(owner, "task1", "retry");
    assert.equal(retried.status, "waiting_approval");
    assert.equal(retried.actionId, proposal.id);
    await agent.worker.tick();
    // The receipt is consumed into state and the agent run continues (no
    // model configured here, so it asks for input); the link is cleared.
    const after = await db.get<AgentTask>(owner, "tasks", "task1");
    assert.equal(after?.status, "waiting_input");
    assert.equal(after?.actionId, null);
    assert.equal((after?.state as Record<string, unknown> | undefined)?.approvalResult, "sent");
  } finally {
    await db.close();
  }
});
