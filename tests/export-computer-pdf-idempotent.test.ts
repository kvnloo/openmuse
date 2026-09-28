import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { ComputerService } from "../apps/server/src/computer.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf, fillPdf } from "../packages/integrations/src/pdf.ts";

async function fixture(
  t: import("node:test").TestContext,
  pdfBytes: (path: string) => Promise<{ name: string; bytes: Uint8Array }>,
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-export-test-"));
  const db = await createStore();
  const config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    workerUrl: "http://127.0.0.1:1",
    workerToken: "test-worker-token-at-least-32-characters",
  } as Config;
  const auth = new Auth(db, config, "test-signing-key");
  const files = new Files(db, config, auth);
  const computer = { pdfBytes } as unknown as ComputerService;
  const tools = computerTools(computer, files, "owner-1", "task:test", {});
  const tool = tools.find((entry) => entry.name === "export_computer_pdf");
  assert.ok(tool, "export_computer_pdf tool exists");
  // defineTool types execute as optional; the runtime object always carries it.
  const execute = tool.execute as unknown as (args: { path: string }) => Promise<{ id: string }>;
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { files, execute, directory };
}

test("a retried export_computer_pdf returns the same file instead of duplicating it", async (t) => {
  const pdf = await createSamplePdf();
  const { files, execute, directory } = await fixture(t, async () => ({
    name: "report.pdf",
    bytes: pdf,
  }));
  const first = await execute({ path: "/workspace/report.pdf" });
  // The run retries (lease loss, pause/cancel, worker stop) and the model
  // re-emits the export: the tool has no operations-cache entry to reuse.
  const second = await execute({ path: "/workspace/report.pdf" });
  assert.equal(second.id, first.id);
  assert.equal((await files.list("owner-1")).length, 1);
  assert.equal((await readdir(join(directory, "files"))).length, 1);
});

test("an export with changed content still mints a new file", async (t) => {
  const source = await createSamplePdf();
  const versions = [
    await fillPdf(source, { participant_name: "Alpha" }),
    await fillPdf(source, { participant_name: "Beta" }),
  ];
  let calls = 0;
  const { files, execute } = await fixture(t, async () => ({
    name: "report.pdf",
    bytes: versions[calls++ % versions.length],
  }));
  const first = await execute({ path: "/workspace/report.pdf" });
  const second = await execute({ path: "/workspace/report.pdf" });
  assert.notEqual(second.id, first.id);
  assert.equal((await files.list("owner-1")).length, 2);
});

test("explicit file ids are content-bound: identical bytes reuse the row, differing bytes fail loud", async (t) => {
  const source = await createSamplePdf();
  const pdfA = await fillPdf(source, { participant_name: "Alpha" });
  const pdfB = await fillPdf(source, { participant_name: "Beta" });
  const { files } = await fixture(t, async () => ({ name: "x.pdf", bytes: pdfA }));
  const first = await files.import("owner-1", "a.pdf", pdfA, "test", undefined, "fixed-id-1");
  const second = await files.import("owner-1", "a.pdf", pdfA, "test", undefined, "fixed-id-1");
  assert.equal(second.id, first.id);
  assert.equal((await files.list("owner-1")).length, 1);
  await assert.rejects(
    files.import("owner-1", "b.pdf", pdfB, "test", undefined, "fixed-id-1"),
    /Conflicting upload/,
  );
});
