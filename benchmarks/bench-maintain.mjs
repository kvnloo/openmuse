/**
 * Bench 1: OpenMuse 60-second maintenance pass cost vs. lifetime record volume.
 *
 * Reproduces the EXACT query pattern of EngineService.maintain() in
 * apps/server/src/engine/service.ts (lines 76-108) on CopilotKit/openmuse main
 * at f5534c7, plus publishOutcome() (749-805) and notify() (578-588).
 *
 * maintain() every 60s:
 *   1. scan("tasks")      -> for EVERY task: publishOutcome -> getTask (1 read)
 *   2. scan("monitors")   -> for EVERY active monitor: activateMonitor -> getTask
 *   3. scan("ideas")      -> for every accepted idea with taskId: db.get(task)
 *   4. scan("agent-settings")
 * publishOutcome re-notifies terminal tasks every pass; notify() dedupes via
 * insertIfAbsent(id = sha256(dedupeKey)) so repeats are no-ops, but the READS
 * are not skipped: cost scales with TOTAL rows, not active rows.
 *
 * Faithfulness notes (documented, not hidden):
 * - Uses the verbatim SQL from apps/server/src/db.ts Store methods.
 * - publishOutcome's goal-milestone CAS loop (succeeded tasks WITH goalId) is
 *   excluded; synthetic tasks have goalId: null. Real cost is >= measured.
 * - activateMonitor's CAS fires only for paused+initializingMonitor tasks;
 *   synthetic tasks are "running", so only the getTask read is measured.
 * - "scheduled"/"paused"+notice path excluded (rare).
 * - Single owner; multi-owner adds linear scans per owner (same pattern).
 */
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const hash = (text) => createHash("sha256").update(text).digest("hex");

// --- verbatim Store SQL (apps/server/src/db.ts) ---
const SQL_SCAN = `SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC`;
const SQL_GET = `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3`;
const SQL_INSERT_IF_ABSENT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`;

function makeTask(i, status) {
  return {
    id: `task-${i}`,
    kind: "agent",
    status,
    title: `Task ${i} title for benchmarking the maintenance loop`,
    input: { messageId: status === "waiting_input" ? `msg-${i}` : undefined },
    state: {},
    goalId: null,
    attempts: status === "failed" ? 3 : 1,
    error: status === "failed" ? "simulated failure" : null,
    result: status === "succeeded" ? "Work completed" : null,
    question: status === "waiting_input" ? "Which date works?" : null,
    actionId: status === "waiting_approval" ? `action-${i}` : null,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  };
}

// publishOutcome replica (service.ts 749-805), goal-milestone CAS excluded (goalId null)
async function publishOutcome(db, owner, saved) {
  const r = await db.query(SQL_GET, [owner, "tasks", saved.id]);
  const task = r.rows[0]?.data;
  if (!task) return;
  const notify = async (title, body, taskId, key) => {
    const value = {
      id: key ? hash(key) : `n-${Math.random()}`,
      taskId,
      title,
      body,
      createdAt: new Date().toISOString(),
      read: false,
    };
    await db.query(SQL_INSERT_IF_ABSENT, [owner, "notifications", value.id, JSON.stringify(value)]);
  };
  if (task.status === "succeeded") {
    await notify(task.title, task.result ?? "Work completed", task.id, `task-done:${task.id}`);
  } else if (task.status === "failed") {
    await notify(task.title, task.error ?? task.title, task.id, `task-error:${task.id}:${task.attempts}`);
  } else if (task.status === "waiting_input") {
    await notify(task.title, task.question ?? task.title, task.id, `input:${task.id}:${hash(task.question ?? "")}`);
  } else if (task.status === "waiting_approval") {
    await notify(task.title, task.title, task.id, `review:${task.actionId}`);
  }
}

async function maintenancePass(db) {
  const t0 = process.hrtime.bigint();
  const parts = {};
  let s = process.hrtime.bigint();
  const tasks = (await db.query(SQL_SCAN, ["tasks"])).rows;
  parts.scanTasks = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  for (const row of tasks) await publishOutcome(db, row.data.owner, row.data.value);
  parts.publishTasks = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  const monitors = (await db.query(SQL_SCAN, ["monitors"])).rows;
  parts.scanMonitors = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  for (const row of monitors) {
    const m = row.data.value;
    if (m.status !== "active") continue;
    await db.query(SQL_GET, [row.data.owner, "tasks", m.taskId]); // activateMonitor's getTask
  }
  parts.activateMonitors = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  const ideas = (await db.query(SQL_SCAN, ["ideas"])).rows;
  parts.scanIdeas = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  for (const row of ideas) {
    const idea = row.data.value;
    if (idea.status === "accepted" && idea.taskId)
      await db.query(SQL_GET, [row.data.owner, "tasks", idea.taskId]);
  }
  parts.recoverIdeas = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  await db.query(SQL_SCAN, ["agent-settings"]);
  parts.scanSettings = Number(process.hrtime.bigint() - s) / 1e6;
  parts.total = Number(process.hrtime.bigint() - t0) / 1e6;
  return parts;
}

async function run(nTasks, nMonitors, nIdeas) {
  const db = new PGlite();
  await db.waitReady;
  await db.query(
    "CREATE TABLE records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  const owner = "owner-1";
  const statuses = ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "waiting_input", "waiting_approval", "running", "queued", "paused"];
  const insert = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)`;
  for (let i = 0; i < nTasks; i++) {
    const t = makeTask(i, statuses[i % statuses.length]);
    await db.query(insert, [owner, "tasks", t.id, JSON.stringify(t)]);
  }
  for (let i = 0; i < nMonitors; i++) {
    const m = { id: `mon-${i}`, status: i % 5 === 0 ? "paused" : "active", taskId: `task-${i % nTasks}`, url: "https://example.com", condition: "change", intervalMinutes: 60, checks: 10 };
    await db.query(insert, [owner, "monitors", m.id, JSON.stringify(m)]);
  }
  for (let i = 0; i < nIdeas; i++) {
    const idea = { id: `idea-${i}`, status: i % 10 === 0 ? "accepted" : "new", taskId: i % 10 === 0 ? `task-${i % nTasks}` : undefined, title: `idea ${i}` };
    await db.query(insert, [owner, "ideas", idea.id, JSON.stringify(idea)]);
  }
  await db.query(insert, [owner, "agent-settings", "identity", JSON.stringify({ id: "identity", name: "OpenMuse", lastIdeasAt: new Date().toISOString() })]);

  // warm-up (also exercises the notify insert path once; later passes hit conflicts)
  await maintenancePass(db);
  await maintenancePass(db);
  const runs = [];
  for (let i = 0; i < 15; i++) runs.push(await maintenancePass(db));
  await db.close();
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const keys = Object.keys(runs[0]);
  const out = { nTasks, nMonitors, nIdeas, rows: nTasks + nMonitors + nIdeas + 1 };
  for (const k of keys) out[k] = +med(runs.map((r) => r[k])).toFixed(2);
  return out;
}

const results = [];
for (const n of [100, 1000, 5000, 20000]) {
  const r = await run(n, Math.floor(n / 10), Math.floor(n / 5));
  results.push(r);
  console.log(JSON.stringify(r));
}
console.log("ENV", JSON.stringify({ node: process.version, pglite: "0.3.14 (in-memory)", warmups: 2, iterations: 15, metric: "median ms" }));
