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

test("sectionSnapshot matches snapshot() for the selected section", async () => {
  const { WorkspaceService } = await import("../apps/server/src/workspace.ts");
  const { Files } = await import("../apps/server/src/files.ts");
  const db = await createStore();
  try {
    const config = { mode: "sample" } as unknown as import("../apps/server/src/config.ts").Config;
    const workspace = new WorkspaceService(
      db,
      config,
      new Files(db, config, { sign: () => "sig" } as never),
      {} as never,
    );
    await db.put("owner", "mail", {
      id: "m1",
      sender: "a@x.co",
      subject: "s",
      body: "b",
      date: "2026-01-01T00:00:00Z",
      label: "INBOX",
      threadId: "t1",
      attachments: [],
    });
    await db.put("owner", "mail", {
      id: "m2",
      sender: "a@x.co",
      subject: "s",
      body: "b",
      date: "2026-01-02T00:00:00Z",
      label: "INBOX",
      threadId: "t2",
      attachments: [],
    });
    await db.put("owner", "events", {
      id: "e1",
      title: "ev",
      start: "2026-01-02T00:00:00Z",
      end: "2026-01-02T01:00:00Z",
    });
    await db.put("owner", "files", { id: "f1", name: "doc.pdf", fields: {}, pageCount: 1 });
    await db.put("owner", "browsers", { id: "b1", url: "https://x.co" });
    await db.put("owner", "actions", {
      id: "a1",
      kind: "calendar.create",
      status: "awaiting_review",
      data: {},
    });
    await db.put("owner", "activity", { id: "n1", text: "hello" });
    const full = await workspace.snapshot("owner");
    const mailOnly = await workspace.sectionSnapshot("owner", "mail");
    assert.deepEqual(mailOnly.mail, full.mail);
    assert.equal(mailOnly.events, undefined);
    assert.equal(mailOnly.files, undefined);
    const calOnly = await workspace.sectionSnapshot("owner", "calendar");
    assert.deepEqual(calOnly.events, full.events);
    assert.equal(calOnly.mail, undefined);
    const filesOnly = await workspace.sectionSnapshot("owner", "files");
    assert.deepEqual(
      filesOnly.files,
      full.files.map(({ url, ...file }) => file),
    );
    assert.equal(filesOnly.mail, undefined);
    const all = await workspace.sectionSnapshot("owner", "all");
    assert.deepEqual(all.mail, full.mail);
    assert.deepEqual(all.events, full.events);
  } finally {
    await db.close();
  }
});
