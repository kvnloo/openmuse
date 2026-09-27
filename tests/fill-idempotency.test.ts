import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-fill-idempotency-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const auth = new Auth(db, config, "test-signing-key");
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, files: new Files(db, config, auth) };
}

test("filling the same form with the same values twice returns the same artifact", async (t) => {
  const { db, files } = await fixture(t);
  const source = await files.import("owner", "form.pdf", await createSamplePdf(), "test");
  const values = { participant_name: "Ada Lovelace", permission_granted: true };
  const first = await files.fill("owner", source.id, values);
  const second = await files.fill("owner", source.id, values);
  assert.equal(first.id, second.id, "retry of an identical fill must not mint a new artifact");
  assert.equal(
    (await db.list("owner", "files")).length,
    2,
    "source plus exactly one filled artifact",
  );
});

test("different fill values still produce distinct artifacts", async (t) => {
  const { db, files } = await fixture(t);
  const source = await files.import("owner", "form.pdf", await createSamplePdf(), "test");
  const first = await files.fill("owner", source.id, { participant_name: "Ada" });
  const second = await files.fill("owner", source.id, { participant_name: "Grace" });
  assert.notEqual(first.id, second.id, "different values must not collide");
  assert.equal((await db.list("owner", "files")).length, 3);
  assert.ok(first.url.length > 0 && second.url.length > 0, "both artifacts stay signed");
});
