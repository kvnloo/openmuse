import assert from "node:assert/strict";
import { test } from "node:test";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import type { TaskContext } from "../apps/server/src/engine/worker.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

const FILL_ID = "filled:src:deadbeef";
const FILL_ARGS = { fileId: "src", fields: { name: "Kevin" } };

const baseTask = (): AgentTask => ({
  id: "task-1",
  title: "t",
  prompt: "Fill the form.",
  kind: "agent",
  status: "running",
  plan: [],
  evidence: [],
  input: {},
  state: { operations: {} },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  attempts: 1,
  leaseId: "lease-1",
  leaseUntil: null,
  artifactIds: [],
});

// A retried fill_pdf whose inner artifact checkpoint landed but whose outer
// operations-cache checkpoint was lost (lease lost mid-tool) must not record
// the same artifact id twice when the retry re-runs the operation.
test("fill_pdf retry after a lost operations checkpoint records the artifact once", async (t) => {
  let persisted = baseTask();
  // Fail exactly the outer operations-cache checkpoint of the first run.
  let failNextOperationsWrite = true;
  const checkpoint = async (patch: Partial<AgentTask>): Promise<AgentTask> => {
    if (
      failNextOperationsWrite &&
      patch.state !== null &&
      typeof patch.state === "object" &&
      "operations" in patch.state
    ) {
      failNextOperationsWrite = false;
      throw new Error("simulated lease loss between checkpoints");
    }
    // Deep-copy like the real store's DB round-trip: the in-memory operations
    // map must not alias the persisted row.
    persisted = JSON.parse(JSON.stringify({ ...persisted, ...patch }));
    return persisted;
  };
  const ctx: TaskContext = {
    signal: new AbortController().signal,
    guard: async () => {},
    checkpoint,
    event: async () => {},
  };
  const service = {
    config: { model: "openai/fixture" },
    db: {
      get: async () => ({ name: "Test", tone: "warm" }),
      list: async () => [],
    },
    computer: {},
    files: {
      // Deterministic id mirrors the idempotent files.fill on the storage layer.
      fill: async () => ({ id: FILL_ID, name: "filled.pdf", fields: [] }),
    },
    workspace: {},
  };
  // Emit the fill_pdf call once per run: the request right after an emission
  // carries the tool result, so it must not emit again.
  let callsEmitted = 0;
  let awaitingResult = false;
  let requestCount = 0;
  await modelFixture(
    t,
    () => {
      requestCount += 1;
      if (awaitingResult || callsEmitted >= 2 || requestCount > 10) {
        awaitingResult = false;
        return undefined;
      }
      callsEmitted += 1;
      awaitingResult = true;
      return { name: "fill_pdf", arguments: FILL_ARGS };
    },
    {},
  );
  const asService = service as never;

  await executeModelTask(asService, "owner-1", persisted, ctx);
  // The inner artifact checkpoint landed; the operations write was lost.
  assert.deepEqual(persisted.artifactIds, [FILL_ID]);
  assert.ok(
    !(
      persisted.state.operations &&
      typeof persisted.state.operations === "object" &&
      Object.keys(persisted.state.operations).length > 0
    ),
    "operations cache write must have been lost on run 1",
  );

  // Retry with the rehydrated task: the operations key is missing, so the
  // operation re-runs and hits the inner checkpoint again.
  const outcome = await executeModelTask(asService, "owner-1", persisted, {
    ...ctx,
    checkpoint: async (patch: Partial<AgentTask>): Promise<AgentTask> => {
      persisted = JSON.parse(JSON.stringify({ ...persisted, ...patch }));
      return persisted;
    },
  });
  void outcome;
  assert.deepEqual(persisted.artifactIds, [FILL_ID], "retry must not duplicate the artifact id");
});
