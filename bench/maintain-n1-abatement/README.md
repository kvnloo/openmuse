# maintain() N+1 abatement — benchmark harness + report (research artifact)

Research branch `perf/maintain-n1-abatement`. Not for upstream merge without
maintainer discussion; the intervention is in
`apps/server/src/engine/service.ts` (`outcomeKey` + `publishedOutcome` marker).

- `bench-maintain-fixed.mjs` — steady-state + recovery-pass benchmark of the
  fixed query pattern, and the crash-recovery correctness suite
  (`node bench-maintain-fixed.mjs correctness`). Needs `@electric-sql/pglite`
  resolvable from the repo root (`pnpm install`).
- `bench-realistic2.mjs` — realistic-mix (50 active + rest terminal) benchmark.
- `REPORT-maintain-loop.md` — full ABAB reasoning, numbers, verdict.
