import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const SQL_SCAN = `SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC`;
const SQL_GET = `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3`;
const SQL_INSERT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)`;
const SQL_UPSERT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`;
function outcomeKey(task) {
  if (task.status === "succeeded") return `task-done:${task.id}`;
  if (task.status === "failed") return `task-error:${task.id}:${task.attempts}`;
  return undefined;
}
async function oldPass(db) {
  const t0 = process.hrtime.bigint();
  for (const row of (await db.query(SQL_SCAN, ["tasks"])).rows) {
    const r = await db.query(SQL_GET, [row.data.owner, "tasks", row.data.value.id]);
    const task = r.rows[0]?.data, key = outcomeKey(task);
    if (key) await db.query(SQL_UPSERT, [row.data.owner, "notifications", hash(key), JSON.stringify({ id: hash(key) })]);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
async function newPass(db) {
  const t0 = process.hrtime.bigint();
  for (const row of (await db.query(SQL_SCAN, ["tasks"])).rows) {
    const v = row.data.value, key = outcomeKey(v);
    if (key && v.state?.publishedOutcome === key) continue;
    await db.query(SQL_GET, [row.data.owner, "tasks", v.id]);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function seed(n, active, withMarkers) {
  const db = new PGlite(); await db.waitReady;
  await db.query("CREATE TABLE records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))");
  for (let i = 0; i < n; i++) {
    const terminal = i >= active;
    const t = { id: `t-${i}`, kind: "agent", status: terminal ? (i % 7 === 0 ? "failed" : "succeeded") : "running",
      title: `task ${i}`, input: {}, state: {}, attempts: 1, createdAt: new Date().toISOString() };
    if (withMarkers && terminal) t.state.publishedOutcome = outcomeKey(t);
    await db.query(SQL_INSERT, ["o", "tasks", t.id, JSON.stringify(t)]);
  }
  return db;
}
// 5k realistic: old vs new, 2 warmups + 10 timed
for (const [variant, marked] of [["old", false], ["new", true]]) {
  const db = await seed(5000, 50, marked);
  const runs = [];
  for (let i = 0; i < 12; i++) { const ms = variant === "old" ? await oldPass(db) : await newPass(db); if (i >= 2) runs.push(ms); }
  await db.close();
  console.log(JSON.stringify({ variant, nTasks: 5000, active: 50, medianMs: +med(runs).toFixed(1) }));
}
// 20k new only
{
  const db = await seed(20000, 50, true);
  const runs = [];
  for (let i = 0; i < 12; i++) { const ms = await newPass(db); if (i >= 2) runs.push(ms); }
  await db.close();
  console.log(JSON.stringify({ variant: "new", nTasks: 20000, active: 50, medianMs: +med(runs).toFixed(1) }));
}
