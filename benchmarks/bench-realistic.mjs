import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const SQL_SCAN = `SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC`;
const SQL_GET = `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3`;
const SQL_INSERT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)`;
function outcomeKey(task) {
  if (task.status === "succeeded") return `task-done:${task.id}`;
  if (task.status === "failed") return `task-error:${task.id}:${task.attempts}`;
  return undefined;
}
// OLD pattern: publishOutcome (getTask + notify attempt) for every row
async function oldPass(db) {
  const t0 = process.hrtime.bigint();
  const tasks = (await db.query(SQL_SCAN, ["tasks"])).rows;
  for (const row of tasks) {
    const r = await db.query(SQL_GET, [row.data.owner, "tasks", row.data.value.id]);
    const task = r.rows[0]?.data;
    if (task.status === "succeeded" || task.status === "failed") {
      const key = task.status === "succeeded" ? `task-done:${task.id}` : `task-error:${task.id}:${task.attempts}`;
      await db.query(`INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`,
        [row.data.owner, "notifications", hash(key), JSON.stringify({ id: hash(key) })]);
    }
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
// NEW pattern: skip marked rows
async function newPass(db) {
  const t0 = process.hrtime.bigint();
  const tasks = (await db.query(SQL_SCAN, ["tasks"])).rows;
  let skipped = 0;
  for (const row of tasks) {
    const v = row.data.value, key = outcomeKey(v);
    if (key && v.state?.publishedOutcome === key) { skipped++; continue; }
    await db.query(SQL_GET, [row.data.owner, "tasks", v.id]);
  }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, skipped };
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [n, active] of [[5000, 50], [20000, 50]]) {
  for (const variant of ["old", "new"]) {
    const db = new PGlite(); await db.waitReady;
    await db.query("CREATE TABLE records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))");
    for (let i = 0; i < n; i++) {
      const terminal = i >= active;
      const t = { id: `t-${i}`, kind: "agent", status: terminal ? (i % 7 === 0 ? "failed" : "succeeded") : "running",
        title: `task ${i}`, input: {}, state: {}, attempts: 1, createdAt: new Date().toISOString() };
      if (variant === "new" && terminal) t.state.publishedOutcome = outcomeKey(t);
      await db.query(SQL_INSERT, ["o", "tasks", t.id, JSON.stringify(t)]);
    }
    const runs = [];
    for (let i = 0; i < 17; i++) { const r = variant === "old" ? await oldPass(db) : (await newPass(db)).ms; if (i >= 2) runs.push(r); }
    await db.close();
    console.log(JSON.stringify({ variant, nTasks: n, active, terminal: n - active, medianMs: +med(runs).toFixed(1) }));
  }
}
