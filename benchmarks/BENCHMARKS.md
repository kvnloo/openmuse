# OpenMuse engine-loop benchmarks

Research artifact on a contributor fork. **Nothing here is posted upstream.**
Scripts reproduce exact query/code patterns from `CopilotKit/openmuse` main
(`205cc38`); numbers were measured on this sandbox and re-run on 2026-09-25.

Environment: Node v24.20.0, `@electric-sql/pglite` 0.3.14 (in-memory),
medians of 15 timed passes after warm-ups unless noted.

## Bench 1 — `maintain()` per-60s pass cost vs lifetime row volume

Script: `bench-maintain.mjs`.

Reproduces the exact query pattern of `AgentService.maintain()`
(`apps/server/src/engine/service.ts`, lines 76-108): four full-table scans
(`tasks`, `monitors`, `ideas`, `agent-settings`) plus per-row follow-ups —
`publishOutcome()` → `getTask` + `notify()` → `insertIfAbsent` per task.
Uses the verbatim SQL from the `Store` methods in `apps/server/src/db.ts`.

### Reproduction (2026-09-25 re-run vs original)

Median ms per 60s maintenance pass. 30%-active synthetic mix (pessimistic).

| tasks | original | re-run 2026-09-25 | publishTasks share (re-run) |
|------:|---------:|------------------:|----------------------------:|
| 100   | 338      | 404.88            | 89% |
| 1,000 | 2,717    | 1,620.77          | 94% |
| 5,000 | 10,229   | 8,009.01          | 94% |
| 20,000| ~32,400 (extrapolated) | 19,181.06 (measured) | 93% |

Absolute numbers move between runs (shared sandbox, GC), but the claim
reproduces in both runs: **cost is linear in lifetime task rows and
`publishTasks` — the per-task `getTask` + idempotent re-notify follow-ups —
is >90% of every pass**. The scans themselves are cheap (~18 ms / 1k rows).
`notify()`'s `insertIfAbsent` dedupe makes repeats write no-ops, but the
reads feeding the dedupe are not skipped: idempotent ≠ free.

Realistic mix (50 active + rest terminal, tasks loop only), from
`bench-realistic.mjs`:

| tasks | baseline/pass | with settled-outcome marker |
|------:|--------------:|----------------------------:|
| 5,000 (50 active)  | 8,104 ms | **105 ms (77×)** |
| 20,000 (50 active) | ~32,400 ms (linear fit) | **478 ms (~68×)** |

The terminal-fraction of a real deployment is what decides the win; the
30%-active mix above is the pessimistic floor.

### What the numbers point at

`maintain()` is an outbox relay without the mark step: every sweep re-reads
the whole outbox. The re-publish is load-bearing only for a narrow crash
window (the worker commits terminal state *before* the `settled` callback,
so a process exit between the two leaves a terminal task whose notification
never published) — but today every settled row pays the recovery cost every
minute. The minimal intervention is a settled-state marker keyed by the
notification dedupe identity (`outcomeKey`), skipped at zero query cost
because the scan row already carries `state`. See `bench-maintain-fixed.mjs`
for the measured fixed variant: 5,000 tasks → 1,047 ms/pass steady-state
(3,500 rows skipped, **0 GET / 0 inserts / 0 CAS for marked rows**), with a
14/14 correctness suite covering the crash window, retry re-notification,
and cancelled rows.

### Not validated

- Production Postgres path (`databaseUrl`): same SQL, no Postgres in this
  sandbox. The win should be larger (round trips saved), not smaller.
- Real row sizes and real terminal/active ratios (synthetic ~1–2 KB rows).
- Multi-owner fan-out (same pattern per owner; linear either way).
- The goal-milestone CAS path inside `publishOutcome` (excluded; measured
  cost ≤ real cost).
- Long-run marker behavior (one CAS per task settlement, amortized).

## Bench 2 — monitor `observe()` tick text-processing cost vs page size

Script: `bench-tick.mjs`.

Runs the exact shipped code from `EngineService.observe()`
(`apps/server/src/engine/service.ts:925-928`) — full-page-text
`replace(/\s+/g, " ").trim()` + sha256 — on synthetic HN-style page text with
realistic whitespace runs. 5 warm-ups, median of 20–60 iterations.

### Reproduction (median ms per tick; normalize-only and sha256-only splits)

| page text | original current | re-run current | re-run normalize | re-run sha256 |
|----------:|-----------------:|---------------:|-----------------:|--------------:|
| 50 KB     | 0.50 | 0.459 | 0.349 | 0.058 |
| 500 KB    | 8.05 | 4.703 | 3.662 | 0.574 |
| 2 MB      | 39.9 | 31.836 | 29.361 | 2.507 |
| 5 MB      | 68.5 | 67.539 | 61.359 | 12.069 |

The claim reproduces: **the regex normalization is ~70–90% of per-tick
text-processing cost and grows linearly with page size** (p95s show GC noise;
medians stable across runs).

### Verdict

Absolute cost is small next to the browser fetch that dominates each tick
(seconds) — not a fire. But it is the entire CPU budget of the tick, and
the monitor path is **uncapped**: `browser.observe()` → `readOwned()`
(`apps/server/src/browser.ts:158-164`) returns the worker's `/read` text
with no server-side cap, while the sibling `observeForThread` slices to
30,000 chars (`browser.ts:194`). The normalization also runs when the
check's outcome only needs the first 1,000 chars (`observe()` keeps
`text.slice(0, 1000)` for the event/DB). If tick frequency ever increases,
bounding the text before normalizing is the first lever.

### Not validated

- Real page-text sizes from the browser worker (synthetic text used).
- Worker-side text length distribution across real monitored URLs.

---
authored with AI assistance (Muse, Meta's Muse Spark) under the contributor's direction.
