/**
 * Bench 2: OpenMuse maintenance pass AFTER the publishedOutcome-marker intervention.
 *
 * Replicates the NEW query pattern of AgentService.maintain() /
 * publishOutcome() on branch perf/maintain-n1-abatement (base 205cc38):
 *   maintain(): scan("tasks") -> per row, compute outcomeKey(value); SKIP
 *     publishOutcome entirely when value.state.publishedOutcome === key.
 *   publishOutcome(): getTask + branch notify() as before, then one
 *     compareAndSwap recording state.publishedOutcome = key (verbatim SQL).
 *
 * outcomeKey() mirrors the notify branches exactly:
 *   succeeded        -> task-done:{id}
 *   failed           -> task-error:{id}:{attempts}
 *   waiting_input    -> input:{id}:sha256(question)
 *   waiting_approval -> review:{actionId}
 *   cancelled        -> cancelled:{id}            (publishOutcome is a no-op for it)
 *   scheduled / paused+error with valid notice -> notice.key
 *   else -> undefined (never skipped)
 *
 * Also includes the crash-recovery correctness suite:
 *   A. terminal task committed, publishOutcome NEVER ran (crash between the
 *      worker's checkpoint and the settled callback) -> recovery pass must
 *      create exactly one notification and set the marker.
 *   B. crash between notify() and the marker write (notification exists,
 *      marker absent) -> recovery pass must NOT duplicate the notification.
 *   C. failed-task retry (attempts 1 -> 2, stale marker) -> second failure
 *      must produce a second notification and update the marker.
 *   D. waiting_input question change -> new notification.
 *   E. cancelled task -> never notified, skipped on later passes.
 *   F. steady-state pass issues ZERO getTask/insert/CAS queries for marked rows.
 */
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const hash = (text) => createHash("sha256").update(text).digest("hex");

// --- verbatim Store SQL (apps/server/src/db.ts) ---
const SQL_SCAN = `SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC`;
const SQL_GET = `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3`;
const SQL_INSERT_IF_ABSENT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`;
const SQL_CAS = `UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data`;
const SQL_INSERT = `INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)`;

// --- outcomeKey replica (service.ts, branch perf/maintain-n1-abatement) ---
function outcomeKey(task) {
  if (task.status === "succeeded") return `task-done:${task.id}`;
  if (task.status === "failed") return `task-error:${task.id}:${task.attempts}`;
  if (task.status === "waiting_input") return `input:${task.id}:${hash(task.question ?? "")}`;
  if (task.status === "waiting_approval") return `review:${task.actionId}`;
  if (task.status === "cancelled") return `cancelled:${task.id}`;
  const n = task.state?.notice;
  if (
    (task.status === "scheduled" || (task.status === "paused" && task.error)) &&
    n && typeof n.title === "string" && typeof n.body === "string" && typeof n.key === "string"
  )
    return n.key;
  return undefined;
}

function makeTask(i, status, extra = {}) {
  return {
    id: `task-${i}`,
    kind: "agent",
    status,
    title: `Task ${i} title for benchmarking the maintenance loop`,
    input: {},
    state: {},
    goalId: null,
    attempts: status === "failed" ? 3 : 1,
    error: status === "failed" ? "simulated failure" : null,
    result: status === "succeeded" ? "Work completed" : null,
    question: status === "waiting_input" ? "Which date works?" : null,
    actionId: status === "waiting_approval" ? `action-${i}` : null,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
    ...extra,
  };
}

// publishOutcome replica WITH the marker write (goal-milestone CAS excluded, goalId null,
// monitor watch-pause CAS excluded: synthetic tasks are kind=agent)
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
  const key = outcomeKey(task);
  if (key) {
    await db.query(SQL_CAS, [
      owner, "tasks", task.id,
      JSON.stringify({ status: task.status }),
      JSON.stringify({ state: { ...task.state, publishedOutcome: key } }),
    ]);
  }
}

// maintain() replica WITH the skip (tasks loop only; monitors/ideas/settings unchanged)
async function maintenancePass(db, count) {
  const t0 = process.hrtime.bigint();
  const parts = {};
  let s = process.hrtime.bigint();
  const tasks = (await db.query(SQL_SCAN, ["tasks"])).rows;
  parts.scanTasks = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  let skipped = 0;
  for (const row of tasks) {
    const value = row.data.value;
    const key = outcomeKey(value);
    if (key && value.state?.publishedOutcome === key) { skipped++; continue; }
    await publishOutcome(db, row.data.owner, value);
  }
  parts.publishTasks = Number(process.hrtime.bigint() - s) / 1e6;
  parts.skipped = skipped;
  s = process.hrtime.bigint();
  const monitors = (await db.query(SQL_SCAN, ["monitors"])).rows;
  parts.scanMonitors = Number(process.hrtime.bigint() - s) / 1e6;
  s = process.hrtime.bigint();
  for (const row of monitors) {
    const m = row.data.value;
    if (m.status !== "active") continue;
    await db.query(SQL_GET, [row.data.owner, "tasks", m.taskId]);
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
  if (count) {
    parts.qScan = count.n("SCAN");
    parts.qGet = count.n("GET");
    parts.qInsert = count.n("INSERT_IF_ABSENT");
    parts.qCas = count.n("CAS");
  }
  return parts;
}

function makeCounter(db) {
  const counts = { SCAN: 0, GET: 0, INSERT_IF_ABSENT: 0, CAS: 0, OTHER: 0 };
  const orig = db.query.bind(db);
  db.query = (sql, params) => {
    if (sql === SQL_SCAN) counts.SCAN++;
    else if (sql === SQL_GET) counts.GET++;
    else if (sql === SQL_INSERT_IF_ABSENT) counts.INSERT_IF_ABSENT++;
    else if (sql === SQL_CAS) counts.CAS++;
    else counts.OTHER++;
    return orig(sql, params);
  };
  return { n: (k) => counts[k], reset: () => { for (const k of Object.keys(counts)) counts[k] = 0; }, counts };
}

async function freshDb() {
  const db = new PGlite();
  await db.waitReady;
  await db.query(
    "CREATE TABLE records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  return db;
}

const STATUSES = ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "waiting_input", "waiting_approval", "running", "queued", "paused"];

async function seed(db, nTasks, nMonitors, nIdeas, withMarkers) {
  const owner = "owner-1";
  for (let i = 0; i < nTasks; i++) {
    const t = makeTask(i, STATUSES[i % STATUSES.length]);
    if (withMarkers) {
      const k = outcomeKey(t);
      if (k) t.state.publishedOutcome = k; // steady state after one settle/recovery pass
    }
    await db.query(SQL_INSERT, [owner, "tasks", t.id, JSON.stringify(t)]);
  }
  for (let i = 0; i < nMonitors; i++) {
    const m = { id: `mon-${i}`, status: i % 5 === 0 ? "paused" : "active", taskId: `task-${i % nTasks}`, url: "https://example.com", condition: "change", intervalMinutes: 60, checks: 10 };
    await db.query(SQL_INSERT, [owner, "monitors", m.id, JSON.stringify(m)]);
  }
  for (let i = 0; i < nIdeas; i++) {
    const idea = { id: `idea-${i}`, status: i % 10 === 0 ? "accepted" : "new", taskId: i % 10 === 0 ? `task-${i % nTasks}` : undefined, title: `idea ${i}` };
    await db.query(SQL_INSERT, [owner, "ideas", idea.id, JSON.stringify(idea)]);
  }
  await db.query(SQL_INSERT, [owner, "agent-settings", "identity", JSON.stringify({ id: "identity", name: "OpenMuse", lastIdeasAt: new Date().toISOString() })]);
}

const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];

// ---------- steady-state + recovery-pass benchmark ----------
const mode = process.argv[2] || "bench";
if (mode === "bench") {
  const results = [];
  for (const n of [100, 1000, 5000]) {
    // steady state: markers present (the common case after the fix)
    {
      const db = await freshDb();
      const counter = makeCounter(db);
      await seed(db, n, Math.floor(n / 10), Math.floor(n / 5), true);
      await maintenancePass(db); await maintenancePass(db); // warm-ups
      const runs = [];
      for (let i = 0; i < 15; i++) { counter.reset(); runs.push(await maintenancePass(db, counter)); }
      await db.close();
      const keys = Object.keys(runs[0]);
      const out = { variant: "fixed-steady-state", nTasks: n };
      for (const k of keys) out[k] = typeof runs[0][k] === "number" ? +med(runs.map((r) => r[k])).toFixed(2) : runs[0][k];
      results.push(out);
      console.log(JSON.stringify(out));
    }
    // recovery pass: no markers (first pass after upgrade, or mass crash)
    {
      const db = await freshDb();
      const counter = makeCounter(db);
      await seed(db, n, Math.floor(n / 10), Math.floor(n / 5), false);
      counter.reset();
      const one = await maintenancePass(db, counter); // single recovery pass
      await db.close();
      console.log(JSON.stringify({ variant: "fixed-recovery-pass", nTasks: n, total: +one.total.toFixed(2), publishTasks: +one.publishTasks.toFixed(2), skipped: one.skipped, qGet: one.qGet, qInsert: one.qInsert, qCas: one.qCas }));
    }
  }
  console.log("ENV", JSON.stringify({ node: process.version, pglite: "0.3.14 (in-memory)", warmups: 2, iterations: 15, metric: "median ms" }));
}

// ---------- crash-recovery correctness suite ----------
if (mode === "correctness") {
  const db = await freshDb();
  const counter = makeCounter(db);
  const owner = "owner-1";
  const putTask = (t) => db.query(SQL_INSERT, [owner, "tasks", t.id, JSON.stringify(t)]);
  const getTask = async (id) => (await db.query(SQL_GET, [owner, "tasks", id])).rows[0]?.data;
  const notifications = async () =>
    (await db.query(`SELECT data FROM records WHERE owner=$1 AND kind='notifications'`, [owner])).rows.map((r) => r.data);
  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  };

  // A: crash between worker checkpoint (terminal state committed) and settled callback
  await putTask(makeTask(1, "succeeded"));
  await maintenancePass(db);
  let notifs = await notifications();
  let t = await getTask("task-1");
  check("A1 crash-window task gets exactly one notification", notifs.filter((n) => n.taskId === "task-1").length === 1);
  check("A2 marker recorded after recovery", t.state.publishedOutcome === "task-done:task-1", t.state.publishedOutcome);

  // B: crash between notify() and the marker write
  const tb = makeTask(2, "failed");
  await putTask(tb);
  await db.query(SQL_INSERT_IF_ABSENT, [owner, "notifications", hash("task-error:task-2:3"),
    JSON.stringify({ id: hash("task-error:task-2:3"), taskId: "task-2", title: "t", body: "b", createdAt: new Date().toISOString(), read: false })]);
  await maintenancePass(db);
  notifs = await notifications();
  check("B no duplicate notification after notify-then-crash", notifs.filter((n) => n.taskId === "task-2").length === 1);
  check("B2 marker healed", (await getTask("task-2")).state.publishedOutcome === "task-error:task-2:3");

  // C: failed retry -> attempts bump -> new notification, marker advances
  const tc = makeTask(3, "failed"); tc.state.publishedOutcome = "task-error:task-3:3";
  await putTask(tc);
  await db.query(`UPDATE records SET data = data || '{"attempts": 4}'::jsonb WHERE owner=$1 AND kind='tasks' AND id='task-3'`, [owner]);
  await maintenancePass(db);
  notifs = await notifications();
  check("C retried failure notifies again", notifs.filter((n) => n.taskId === "task-3").length === 1);
  check("C2 marker advanced to new attempts", (await getTask("task-3")).state.publishedOutcome === "task-error:task-3:4");

  // D: waiting_input question change -> new notification
  const td = makeTask(4, "waiting_input"); td.state.publishedOutcome = outcomeKey(td);
  await putTask(td);
  await db.query(`UPDATE records SET data = data || '{"question": "Different question?"}'::jsonb WHERE owner=$1 AND kind='tasks' AND id='task-4'`, [owner]);
  await maintenancePass(db);
  notifs = await notifications();
  check("D changed question re-notifies", notifs.filter((n) => n.taskId === "task-4").length === 1);

  // E: cancelled task -> never notified, skipped afterwards
  await putTask(makeTask(5, "cancelled"));
  await maintenancePass(db);
  notifs = await notifications();
  check("E cancelled task never notified", notifs.filter((n) => n.taskId === "task-5").length === 0);
  check("E2 cancelled marker set", (await getTask("task-5")).state.publishedOutcome === "cancelled:task-5");

  // F: steady-state pass issues zero follow-up queries for marked rows
  counter.reset();
  const p = await maintenancePass(db, counter);
  const markedRows = 5; // tasks 1..5 all marked now
  check("F zero getTask queries in steady state", counter.n("GET") === 0, `GET=${counter.n("GET")}`);
  check("F2 zero notify inserts in steady state", counter.n("INSERT_IF_ABSENT") === 0, `INSERT=${counter.n("INSERT_IF_ABSENT")}`);
  check("F3 zero marker CAS in steady state", counter.n("CAS") === 0, `CAS=${counter.n("CAS")}`);
  check("F4 all marked rows skipped", p.skipped === markedRows, `skipped=${p.skipped}`);

  // G: active (non-terminal) rows still get publishOutcome each pass
  await putTask(makeTask(6, "running"));
  counter.reset();
  await maintenancePass(db, counter);
  check("G active rows still visited", counter.n("GET") === 1, `GET=${counter.n("GET")}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} correctness checks passed`);
  await db.close();
  if (failed.length) process.exit(1);
}
