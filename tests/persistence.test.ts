import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPool, createStore } from "../apps/server/src/db.ts";

test("fresh nested data directory starts and survives a database restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const options = { dataDir: join(root, "new-install", "postgres") };
    const first = await createStore(options);
    await first.put("owner", "actions", { id: "action1", status: "executing" });
    await first.close();
    const second = await createStore(options);
    await second.recoverInterruptedActions();
    assert.equal((await second.get("owner", "actions", "action1"))?.status, "outcome_unknown");
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle Postgres client errors are logged instead of crashing the process", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const pool = createPool("postgres://127.0.0.1:1/openmuse");
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection")));
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await pool.end();
  }
});

test("listByGoalId matches list()+filter semantics", async () => {
  const store = await createStore();
  try {
    await store.put("owner", "tasks", { id: "t0", goalId: "g1" });
    await store.put("owner", "tasks", { id: "t1", goalId: "g2" });
    await store.put("owner", "tasks", { id: "t2", goalId: "g1" });
    // A goalId-less record never matches, exactly like `x.goalId === "g1"`.
    await store.put("owner", "tasks", { id: "t-none" });
    const scoped = await store.listByGoalId("owner", "tasks", "g1");
    const unscoped = (await store.list("owner", "tasks")).filter((x) => x.goalId === "g1");
    assert.deepEqual(
      scoped.map((x) => x.id),
      unscoped.map((x) => x.id),
    );
    assert.deepEqual(scoped.map((x) => x.id).sort(), ["t0", "t2"]);
    // Other owners and other kinds don't leak in.
    await store.put("other", "tasks", { id: "x", goalId: "g1" });
    await store.put("owner", "goals", { id: "g", goalId: "g1" });
    assert.equal((await store.listByGoalId("owner", "tasks", "g1")).length, 2);
    assert.equal((await store.listByGoalId("nobody", "tasks", "g1")).length, 0);
  } finally {
    await store.close();
  }
});
