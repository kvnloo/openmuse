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

test("listByTaskId returns only the task's rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-db-"));
  try {
    const db = await createStore({ dataDir: join(root, "postgres") });
    try {
      await db.put("owner", "run-events", {
        id: "e1",
        taskId: "t1",
        date: "2026-01-01T00:00:00.000Z",
      });
      await db.put("owner", "run-events", {
        id: "e2",
        taskId: "t2",
        date: "2026-01-01T00:00:01.000Z",
      });
      await db.put("owner", "run-events", {
        id: "e3",
        taskId: "t1",
        date: "2026-01-01T00:00:02.000Z",
      });
      await db.put("owner", "run-events", { id: "e4", date: "2026-01-01T00:00:03.000Z" });
      const rows = await db.listByTaskId<{ id: string }>("owner", "run-events", "t1");
      assert.deepEqual(rows.map((r) => r.id).sort(), ["e1", "e3"]);
      assert.deepEqual(await db.listByTaskId("owner", "run-events", "nope"), []);
    } finally {
      await db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
