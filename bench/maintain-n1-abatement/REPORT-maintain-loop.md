# ABAB report: openmuse `maintain()` N+1 — from measurement to a marked-row fix

Branch: `perf/maintain-n1-abatement` on `kvnloo/openmuse` (base: upstream `CopilotKit/openmuse@205cc38`).
Status: research artifact on the fork. **Nothing posted upstream.**

## The question

`AgentService.maintain()` (`apps/server/src/engine/service.ts`) runs every 60s. Prior
measurement: per-pass cost grows linearly with *lifetime* task rows (~2ms/task; 5,000
tasks → ~10.2s of every 60s interval). The scans are cheap; the cost is per-row
follow-up queries (`publishOutcome()` → `getTask` + `notify()` → `insertIfAbsent` per
task). Is the re-work load-bearing (crash recovery?) and what is the smallest
intervention that removes it?

## A — Local evidence (code reading)

**The loop** (`service.ts:92-115`, verified identical on upstream main `205cc38`):

```ts
// Recover publications if the process exited after committing an outcome.
for (const { owner, value } of await this.db.scan<AgentTask>("tasks"))
  await this.publishOutcome(owner, value);
```

**Why re-publish is not obviously dead code.** `publishOutcome` runs on the worker's
`settled` callback at settle time (`service.ts:56`), so the per-minute re-run only
matters for one window. Reading `worker.ts` (`run()`, ~line 193 vs ~228) shows the
ordering:

1. `await checkpoint({ ...result, leaseId: null, leaseUntil: null })` — terminal
   status is **committed to the task row**
2. `await this.db.put(owner, "runs", ...)` — run record
3. `const settled = await this.db.get(...); if (settled && this.options.settled)
   await this.options.settled(owner, settled)` — **then** `publishOutcome()` runs

So a process exit between (1) and (3) leaves a terminal task whose outcome
notification was never published. The maintain loop exists to recover exactly that
window. **Naively skipping terminal rows would silently drop the recovery
guarantee.** The re-publish is load-bearing, but only for rows in that window.

**The dedupe that doesn't save you.** `notify()` (`service.ts:578`) builds the
notification id as `sha256(dedupeKey)` and writes via `insertIfAbsent`, so repeats
are write no-ops — but the two reads (`getTask`, the insert attempt) happen every
pass regardless. Idempotent ≠ free.

**Git history:** the loop arrived in the initial alpha commit (`2442372`); there is
no evolution to study — it was born this way.

**Multi-instance:** there is no leader election. The `refreshing` guard is
per-process; two servers against one Postgres `databaseUrl` would both run
maintain. Today that only duplicates idempotent writes. (PGlite embedded, the
default, is single-process.) The fix must not make this worse — it doesn't (below).

**Adjacent cost, out of scope:** `TaskWorker.tick()` runs every **1s** and also
`scan("tasks")` — 60× the scan rate of maintain — but it filters to due tasks in JS
and only follows up on those, so it is bounded by active rows. Noted, not changed.

## B — External analogy

Two production systems solve the same "periodic reconciler re-does settled work"
problem, and both converge on the same shape:

1. **Transactional outbox pattern.** A relay polls an outbox table, publishes, then
   **marks the row published (or deletes it)**; a crash resumes from the last
   unmarked row. Delivery stays at-least-once; the mark is what bounds the relay's
   steady-state work. `maintain()` is an outbox relay *without the mark step* —
   every sweep re-reads the whole outbox. (Refs: Conduktor transactional-outbox
   guide; Debezium outbox; the canonical schema even uses a partial index
   `WHERE published = FALSE` to keep the relay query O(unpublished).)

2. **Kubernetes controllers: `observedGeneration`.** A controller records in
   `.status` the generation it has already processed and short-circuits
   reconciliation when `observedGeneration == generation` — a settled-state marker
   that turns level-triggered re-reconciliation from O(all objects) into O(changed
   objects). Same idea, different substrate.

The shared lesson: **a reconciler that cannot tell "already handled" from "never
seen" re-does everything forever. The fix is always a settled-state marker, and
the marker must be keyed by the same identity the work is deduped on** (outbox:
message id; k8s: generation; here: the notification dedupe key).

## A — Return to local constraints

- **PGlite vs Postgres:** the intervention uses only existing `Store` primitives
  (`scan`, `get`, `compareAndSwap` with verbatim jsonb SQL), so it is backend-
  agnostic. On Postgres each skipped follow-up also saves a network round trip, so
  the win should be *larger* there — not measured (no Postgres in this sandbox).
- **What breaks if terminal tasks are skipped outright:** the crash window above.
  Verified by reading the worker: terminal state commits before the settled
  callback. A filter on status alone is therefore wrong; the marker must record
  *publication*, not *terminality*.
- **Failed-task retries change the dedupe key** (`task-error:{id}:{attempts}`), and
  `waiting_input` keys on `hash(question)`. A boolean "published" flag would mask a
  legitimate second notification. The marker must store the *key*, and the skip
  must compare keys — exactly mirroring `notify()`'s dedupe identity.
- **`cancelled` tasks:** `publishOutcome` provably does nothing for them today (no
  branch matches), so recording a `cancelled:{id}` marker only skips a useless
  `getTask`. Safe.

## B — The smallest intervention

`apps/server/src/engine/service.ts`, +38/−2 lines:

1. `outcomeKey(task)` — pure helper returning the notification dedupe key
   `publishOutcome()` *would* use for the task's current state (mirrors every
   branch, including the scheduled/paused+notice key), or `undefined` when
   `publishOutcome` does nothing notifiable.
2. `maintain()` task loop: `if (key && value.state.publishedOutcome === key)
   continue;` — the scan row already carries `state`, so the skip costs zero
   queries.
3. `publishOutcome()` tail: after the branches, `compareAndSwap(owner, "tasks",
   id, { status: task.status }, { state: { ...task.state, publishedOutcome: key } })`.

Safety properties (each verified by a correctness check, 14/14 passing):

- **Crash between notify() and the marker write** → next pass re-publishes →
  `insertIfAbsent` dedupes on the same key → still exactly one notification.
- **Crash between checkpoint and settled** (the real window) → no marker →
  recovery pass publishes once and marks. (Check A1/A2.)
- **Retry bumps attempts / question changes / new actionId** → key changes →
  marker no longer matches → new notification fires, marker advances. (Checks
  C, D.) A stale marker can never mask a *different* outcome.
- **Concurrent retry during the marker CAS** → status guard (`{ status:
  task.status }`) fails the CAS → row stays unmarked → next pass re-runs
  `publishOutcome` harmlessly (queued → no branch → no notify). No lost
  notification, no clobbered retry.
- **Two processes (shared Postgres)** → duplicate `publishOutcome` calls dedupe
  on the same key; marker CAS is idempotent. No worse than today.
- **No schema change**: `state` is `Record<string, unknown>`; old rows without the
  marker behave exactly as before (one recovery pass marks them).

Alternatives considered and rejected: skipping terminal statuses outright (drops
the crash-recovery guarantee); an `updated_at` high-water mark (fragile —
`updated_at` bumps on any write, and the scan is `ORDER BY updated_at ASC`, so a
late-arriving unmarked row could be missed); a separate published-outcomes table
(heavier: new kind, new scan, join logic).

## Numbers

Method: PGlite 0.3.14 in-memory, Node v24.20.0, verbatim Store SQL, 2 warm-ups +
15 timed passes, median. Baseline measured on the same harness against the
pre-fix code path (maintain loop text verified identical on `205cc38`).

| tasks (mix) | baseline/pass | fixed steady-state/pass | fixed recovery pass (once) |
|------------:|--------------:|------------------------:|---------------------------:|
| 100 (30% active) | 338 ms | **53 ms** (6.4×) | 221 ms |
| 1,000 (30% active) | 2,717 ms | **258 ms** (10.5×) | 1,677 ms |
| 5,000 (30% active) | 10,229 ms | **1,099 ms** (9.3×) | 8,499 ms |

The 30%-active synthetic mix is pessimistic: real deployments accumulate terminal
rows while active rows stay small. Realistic mix (50 active + rest terminal,
tasks-loop only):

| tasks | baseline/pass | fixed steady-state/pass |
|------:|--------------:|------------------------:|
| 5,000 (50 active) | 8,104 ms | **105 ms (77×)** |
| 20,000 (50 active) | ~32,400 ms (extrapolated from the measured linear fit) | **478 ms (~68×)** |

Query counts per steady-state pass (5,000-task mix): baseline 5,500 GET +
3,500 insert attempts; fixed **0 GET / 0 inserts / 0 CAS for marked rows** —
the remaining ~2,000 GETs are genuinely-active rows (running/queued/paused) plus
the untouched monitors/ideas loops, which is correct behavior. The per-row skip
itself is pure CPU (~14µs/row scan cost).

The recovery pass (first pass after upgrade, or after a mass crash) costs ≈ one
baseline pass plus one CAS per marked row — a one-time cost that buys every
subsequent pass.

Correctness suite (`bench-maintain-fixed.mjs correctness`): **14/14 pass** —
crash-window recovery publishes exactly once, notify-then-crash does not
duplicate, retried failures and changed questions re-notify, cancelled rows are
never notified, steady-state issues zero follow-up queries for marked rows,
active rows are still visited.

Repo test suite (branch code, `tsx --test`): new `tests/maintain-outcome.test.ts`
**4/4 pass** against the real `AgentService.maintain()` (crash-window recovery,
retry re-notification, cancelled skip, question-change re-notification);
existing `tests/engine.test.ts` **8/8 pass**; `tests/monitor-recovery.test.ts`
**15/15 pass**; `tsc --noEmit` clean; `biome check` clean on both touched files.

## What wasn't validated

- Production Postgres path (`databaseUrl`): same SQL, but no Postgres available
  here. Expected win is larger (round trips saved), not smaller.
- Real row sizes and real terminal/active ratios (synthetic rows ~1–2 KB,
  synthetic mixes).
- Multi-owner fan-out (same query pattern per owner; linear either way).
- The goal-milestone CAS path inside `publishOutcome` (excluded; synthetic tasks
  had `goalId: null`, so measured cost ≤ real cost).
- Long-run behavior: marker writes add one CAS per task settlement (amortized
  once per lifetime) — negligible, but not soak-tested.
- `biome`/typecheck on the branch — done: `tsc --noEmit` clean, `biome check`
  clean on both touched files.

## Verdict

**Worth fixing, and the fix is this marker.** The measurement confirmed the cost
is real and linear in lifetime rows; the code reading confirmed the re-publish is
load-bearing only for a narrow crash window; the analogies (outbox relay,
`observedGeneration`) both point at a settled-state marker keyed by the dedupe
identity; the implementation is 38 lines with no schema change and 14/14
correctness checks including the crash cases. Steady-state per-pass cost drops
~10× on a pessimistic mix and should approach the raw scan floor (~15µs/row) at
realistic terminal fractions. What remains is maintainer judgment on whether
they want the marker — the branch is the evidence.

## Reusable lessons (with evidence)

1. **Idempotent ≠ free — a deduped write still costs its read.** `notify()`'s
   `insertIfAbsent` made repeats write no-ops, which made the per-minute
   re-publish *look* harmless; the measurement showed >90% of every pass was the
   reads feeding the dedupe. (Evidence: baseline 10.2s/pass at 5k tasks, scans
   18ms/1k rows.)
2. **Before optimizing a reconciler, name its crash window.** The worker commits
   terminal state *before* the settled callback (`worker.ts` checkpoint at ~L193,
   `settled()` at ~L228) — that ordering is the entire reason the re-publish
   exists, and it ruled out the "obvious" fix (skip terminal rows). The ordering
   was found by reading, not by guessing.
3. **Key the settled marker by the work's dedupe identity, not by a boolean.**
   `task-error:{id}:{attempts}` and `input:{id}:{hash(question)}` mean "published"
   is not a property of the row but of the (row, outcome-version) pair; a boolean
   would have masked legitimate re-notifications on retry. The correctness suite
   proves the keyed marker re-fires exactly when it should (checks C, D) and
   never otherwise.
