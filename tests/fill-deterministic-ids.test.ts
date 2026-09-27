import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

const owner = "owner-1";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openmuse-fill-"));
  const db = await createStore({ dataDir: join(root, "pg") });
  const files = new Files(
    db,
    { dataDir: join(root, "data") } as never,
    { sign: () => "signed" } as never,
  );
  return { root, db, files };
}

test("fill retries reuse the same artifact id instead of minting duplicate files", async () => {
  const { root, db, files } = await setup();
  try {
    const source = await files.import(owner, "form.pdf", await createSamplePdf(), "test");
    // A lease-loss retry re-runs fill after the operations-cache checkpoint was lost.
    const first = await files.fill(owner, source.id, { participant_name: "Kevin" });
    const second = await files.fill(owner, source.id, { participant_name: "Kevin" });
    assert.equal(second.id, first.id, "retry must return the same filled artifact id");
    const rows = await db.list(owner, "files");
    assert.equal(rows.length, 2, `expected source + one filled row, found ${rows.length}`);
    const pdfs = await readdir(join(root, "data", "files"));
    assert.equal(pdfs.length, 2, `expected 2 pdf files on disk, found ${pdfs.length}`);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fill id is insensitive to field key order", async () => {
  const { root, db, files } = await setup();
  try {
    const source = await files.import(owner, "form.pdf", await createSamplePdf(), "test");
    const a = await files.fill(owner, source.id, {
      participant_name: "Kevin",
      emergency_phone: "555-0100",
    });
    const b = await files.fill(owner, source.id, {
      emergency_phone: "555-0100",
      participant_name: "Kevin",
    });
    assert.equal(a.id, b.id);
    assert.equal((await db.list(owner, "files")).length, 2);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("different field values still produce distinct filled files", async () => {
  const { root, db, files } = await setup();
  try {
    const source = await files.import(owner, "form.pdf", await createSamplePdf(), "test");
    const a = await files.fill(owner, source.id, { participant_name: "Kevin" });
    const b = await files.fill(owner, source.id, { participant_name: "Priya" });
    assert.notEqual(a.id, b.id);
    assert.equal((await db.list(owner, "files")).length, 3);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-import with the same explicit id overwrites instead of duplicating", async () => {
  const { root, db, files } = await setup();
  try {
    const bytes = await createSamplePdf();
    const first = await files.import(owner, "doc.pdf", bytes, "test", undefined, "fixed-id");
    const second = await files.import(owner, "doc.pdf", bytes, "test", undefined, "fixed-id");
    assert.equal(second.id, "fixed-id");
    assert.equal(first.id, "fixed-id");
    assert.equal((await db.list(owner, "files")).length, 1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
