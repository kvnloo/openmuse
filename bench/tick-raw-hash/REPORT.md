# REPORT: monitor tick text-processing — raw-hash short-circuit

## Problem
`EngineService` monitor check ran `observation.text.replace(/\s+/g, " ").trim()` + sha256
on the **full page text on every check**, before change detection. The monitor
`observe()` path (unlike `observeForThread`) has no server-side text cap, so
per-tick CPU was unbounded in page size. Measured (Node v24.20.0, exact shipped
code, DRAFT-tick-normalize methodology, 5 warm-ups, median of 30):

| page text | before (normalize+sha256) | after, page unchanged | after, page changed |
|----------:|--------------------------:|----------------------:|--------------------:|
| 50 KB     | 1.0 ms  | 0.06 ms (~17x) | 1.1 ms |
| 500 KB    | 12.9 ms | 1.2 ms (~11x)  | 14.1 ms |
| 2 MB      | 84.3 ms | 3.6 ms (~24x)  | 87.9 ms |
| 5 MB      | 166 ms  | 7.7 ms (~21x)  | 174 ms |

## Intervention
`dedupeMonitorText()` (`apps/server/src/engine/monitor-text.ts`): hash the raw
bytes first; when the raw sha256 matches the previous check's, the normalized
text and hash are necessarily identical, so the O(n) regex is skipped and the
cached values are reused. The changed case costs exactly one extra sha256 over
the old path (measured above: +0.06–7.7 ms).

Semantics are exactly preserved: whitespace-only edits still do not count as a
change (proven by unit test), real edits still do, and every downstream value
(display prefix, match outcome, hashes) on the reused path is byte-identical to
what the full computation would have produced. New persisted field
`lastRawHash` on the monitor record and task state; old records without it take
the full path once, then populate it.

## Validation
- `tests/monitor-text.test.ts`: 5/5 new unit tests pass.
- `tests/monitor-recovery.test.ts`: 15/15 existing monitor tests pass.
- Full `tests/*.test.ts` suite: see LOG.
- `biome check`: clean. `tsc --noEmit`: no new errors (9 pre-existing, all from
  missing `playwright` types in this environment; identical count with and
  without the change).

## Not validated
- Production Postgres path (measured against the same in-memory Store semantics).
- Real page-text size distribution from the browser worker (synthetic HN-style text).
