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

test("listByTaskId returns only the task's rows in list() order", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const db = await createStore({ dataDir: join(root, "postgres") });
    try {
      await db.put("owner", "agent-artifacts", { id: "a1", taskId: "t1", title: "one" });
      await db.put("owner", "agent-artifacts", { id: "a2", taskId: "t2", title: "two" });
      await db.put("owner", "agent-artifacts", { id: "a3", taskId: "t1", title: "three" });
      await db.put("owner", "agent-artifacts", { id: "a4", title: "no-task" });
      const scoped = await db.listByTaskId<{ id: string }>("owner", "agent-artifacts", "t1");
      const full = await db.list<{ id: string }>("owner", "agent-artifacts");
      assert.deepEqual(
        scoped.map((r) => r.id),
        full.filter((r) => ["a1", "a3"].includes(r.id)).map((r) => r.id),
      );
      assert.deepEqual(scoped.map((r) => r.id).sort(), ["a1", "a3"]);
    } finally {
      await db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listByIds returns the requested ids in list() order, empty for none", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const db = await createStore({ dataDir: join(root, "postgres") });
    try {
      await db.put("owner", "files", { id: "f1", name: "one" });
      await db.put("owner", "files", { id: "f2", name: "two" });
      await db.put("owner", "files", { id: "f3", name: "three" });
      const some = await db.listByIds<{ id: string }>("owner", "files", ["f3", "f1"]);
      const full = await db.list<{ id: string }>("owner", "files");
      assert.deepEqual(
        some.map((r) => r.id),
        full.filter((r) => ["f1", "f3"].includes(r.id)).map((r) => r.id),
      );
      assert.deepEqual(await db.listByIds("owner", "files", []), []);
      assert.deepEqual(await db.listByIds("owner", "files", ["missing"]), []);
    } finally {
      await db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
