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

test("listByStatus matches list()+filter semantics", async () => {
  const db = await createStore();
  try {
    await db.put("owner", "computer-commands", {
      id: "a",
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await db.put("owner", "computer-commands", {
      id: "b",
      status: "succeeded",
      startedAt: "2026-01-02T00:00:00Z",
    });
    await db.put("owner", "computer-commands", { id: "c", startedAt: "2026-01-03T00:00:00Z" }); // no status
    await db.put("other", "computer-commands", {
      id: "d",
      status: "running",
      startedAt: "2026-01-04T00:00:00Z",
    });
    const expected = (
      (await db.list<{ id: string; status?: string }>("owner", "computer-commands")) as {
        id: string;
        status?: string;
      }[]
    ).filter((c) => c.status === "running");
    const scoped = await db.listByStatus("owner", "computer-commands", "running");
    assert.deepEqual(
      scoped.map((c: { id: string }) => c.id),
      expected.map((c) => c.id),
    );
  } finally {
    await db.close();
  }
});

test("listRecent matches list()+sort+slice semantics", async () => {
  const db = await createStore();
  try {
    const mk = (id: string, startedAt: string) => ({ id, status: "succeeded", startedAt });
    await db.put("owner", "computer-commands", mk("a", "2026-01-03T00:00:00Z"));
    await db.put("owner", "computer-commands", mk("b", "2026-01-01T00:00:00Z"));
    await db.put("owner", "computer-commands", mk("c", "2026-01-02T00:00:00Z"));
    await db.put("owner", "computer-commands", mk("d", "2026-01-02T00:00:00Z")); // tie on startedAt
    await db.put("other", "computer-commands", mk("e", "2026-01-05T00:00:00Z"));
    const all = (await db.list<{ id: string; startedAt: string }>(
      "owner",
      "computer-commands",
    )) as {
      id: string;
      startedAt: string;
    }[];
    const expected = all
      .sort((x, y) => y.startedAt.localeCompare(x.startedAt))
      .slice(0, 2)
      .map((c) => c.id);
    const scoped = await db.listRecent("owner", "computer-commands", "startedAt", 2);
    assert.deepEqual(
      scoped.map((c: { id: string }) => c.id),
      expected,
    );
  } finally {
    await db.close();
  }
});
