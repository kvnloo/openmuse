import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The standalone task worker (npm run start:worker / dev:worker) boots without the API,
 * so index.ts's boot-time recovery never runs for it. A worker crash during action
 * execution would leave the review in "executing" forever: decide() returns a
 * non-awaiting review unchanged with 200 (actions.ts), execute() re-parks the task on
 * the dead review on every tick (service.ts), and the tick's expiry flip only touches
 * "awaiting_review" rows — so the review can never be decided and the task re-parks
 * until cancelled. worker-entry.ts must run the same recoverInterruptedActions() boot
 * recovery as index.ts. This module has top-level side effects (readConfig,
 * createStore, createApp, agent.start), so the boot invariant is pinned by source
 * instead of by import.
 */
test("the standalone task worker entry recovers interrupted actions at boot", () => {
  const source = readFileSync(
    new URL("../apps/server/src/worker-entry.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("recoverInterruptedActions"),
    "worker-entry.ts must call db.recoverInterruptedActions() at boot like index.ts",
  );
});
