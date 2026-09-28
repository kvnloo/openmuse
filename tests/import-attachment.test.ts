import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
const owner = "import-attachment-user";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-import-attachment-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  await server.workspace.ensureSample(owner, server.actions);
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("importAttachment resolves an already-imported artifact id", async () => {
  const mail = (await server.workspace.snapshot(owner)).mail.find((m) => m.attachments.length);
  assert.ok(mail, "seeded sample mail carries an attachment");
  const ref = mail.attachments[0];
  assert.ok(!ref.includes(":"), `seeded sample attachment is a bare artifact id, got ${ref}`);
  const file = await server.workspace.importAttachment(owner, ref);
  assert.equal(file.id, ref);
  assert.equal(file.name, "Field trip permission slip.pdf");
  assert.ok(file.url, "returned artifact carries a signed content url");
});

test("importAttachment still rejects references that are neither artifacts nor mail refs", async () => {
  await assert.rejects(
    server.workspace.importAttachment(owner, "no-such-file"),
    /Attachment reference is invalid/,
  );
  // A well-formed 3-part ref for unknown mail still reaches the mail lookup.
  await assert.rejects(
    server.workspace.importAttachment(owner, "missing:missing:missing.pdf"),
    /Attachment not found/,
  );
});
