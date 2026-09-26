import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { type ActionProposal, eventDraftSchema } from "../packages/domain/src/index.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
const email = {
  kind: "email.send" as const,
  data: {
    to: ["sam@example.com"],
    subject: "Visit",
    body: "See attached.",
    cc: [],
    bcc: [],
    attachmentIds: [],
  },
};
test("denying a persisted proposal never calls its adapter", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("deny-user", email);
  assert.equal(proposal.status, "awaiting_review");
  const result = await service.decide("deny-user", proposal.id, proposal.hash, "deny");
  assert.equal(result.status, "denied");
  assert.equal(calls, 0);
});
test("concurrent approval consumes the proposal only once", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "provider-receipt";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("once-user", email);
  await Promise.allSettled([
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
  ]);
  assert.equal(calls, 1);
  const saved = await db.get("once-user", "actions", proposal.id);
  assert.equal(saved?.status, "succeeded");
  assert.equal(saved?.result, "provider-receipt");
});
test("wrong owner and stale hash cannot approve", async () => {
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const proposal = await service.propose("private-user", email);
  await assert.rejects(
    service.decide("attacker", proposal.id, proposal.hash, "approve"),
    /not found/i,
  );
  await assert.rejects(service.decide("private-user", proposal.id, "stale", "approve"), /changed/i);
});
test("expired and disconnected proposals never reach the provider", async () => {
  let now = Date.now();
  let connected = true;
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => connected,
    now: () => now,
  });
  const expired = await service.propose("expired-user", email);
  now += 31 * 60 * 1000;
  await assert.rejects(
    service.decide("expired-user", expired.id, expired.hash, "approve"),
    /expired/i,
  );
  const revoked = await service.propose("revoked-user", email);
  connected = false;
  await assert.rejects(
    service.decide("revoked-user", revoked.id, revoked.hash, "approve"),
    /disconnected/i,
  );
  assert.equal(calls, 0);
});
test("uncertain writes retain uncertainty and cannot be retried", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      throw Object.assign(new Error("Provider response lost"), { outcomeUnknown: true });
    },
    connected: async () => true,
  });
  const proposal = await service.propose("uncertain-user", email);
  const result = await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(result.status, "outcome_unknown");
  await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(calls, 1);
});
test("another service instance sees persisted proposals", async () => {
  const options = { execute: async () => "created", connected: async () => true };
  const first = new ActionService(db, options);
  const proposal = await first.propose("resume-user", email);
  const second = new ActionService(db, options);
  assert.equal(
    (await second.decide("resume-user", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});
test("event validation preserves all-day semantics and rejects missing offsets", () => {
  const base = { title: "Visit", start: "2026-10-23", end: "2026-10-24", allDay: true };
  assert.equal(eventDraftSchema.parse(base).start, "2026-10-23");
  assert.equal(eventDraftSchema.safeParse({ ...base, allDay: false }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, end: "2026-10-22" }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, timeZone: "Not/AZone" }).success, false);
});
test("account switching and reconnecting invalidate a prepared action", async () => {
  let connection = { id: "connection-a", account: "a@example.com" };
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
    connection: async () => connection,
  });
  const proposal = await service.propose("account-user", email);
  assert.equal(proposal.account, "a@example.com");
  connection = { id: "connection-b", account: "b@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  connection = { id: "connection-new-a", account: "a@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  assert.equal(calls, 0);
});

test("review stores authoritative calendar details and binds execution to their version", async () => {
  const target = {
    id: "event-1",
    ...eventDraftSchema.parse({
      title: "Provider title",
      start: "2026-10-23",
      end: "2026-10-24",
      allDay: true,
    }),
  };
  let version = '"revision-1"';
  const service = new ActionService(db, {
    connected: async () => true,
    connection: async () => ({ id: "calendar-connection", account: "me@example.com" }),
    prepare: async (_owner, input, connectionId) => {
      assert.equal(connectionId, "calendar-connection");
      assert.equal(input.kind, "calendar.delete");
      return {
        input: {
          kind: "calendar.delete",
          data: { eventId: target.id, calendarId: "primary", title: target.title },
        },
        target,
        targetVersion: version,
      };
    },
    execute: async (_owner, input, connectionId, targetVersion) => {
      assert.ok(input.kind === "calendar.delete");
      assert.equal(input.data.title, "Provider title");
      assert.equal(connectionId, "calendar-connection");
      assert.equal(targetVersion, '"revision-1"');
      return "Deleted";
    },
  });
  const input = {
    kind: "calendar.delete",
    data: { eventId: target.id, calendarId: "primary", title: "Untrusted title" },
  };
  const proposal = await service.propose("review-owner", input);
  assert.equal(proposal.title, "Delete Provider title");
  assert.deepEqual(proposal.target, target);
  assert.equal(proposal.targetVersion, version);
  version = '"revision-2"';
  const newer = await service.propose("review-owner", input);
  assert.notEqual(newer.hash, proposal.hash);
  assert.equal(
    (await service.decide("review-owner", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});

test("idempotent proposal replay returns a completed action before another provider preparation", async () => {
  let preparations = 0;
  const service = new ActionService(db, {
    connected: async () => true,
    prepare: async (_owner, input) => {
      preparations++;
      return { input };
    },
    execute: async () => "sent",
  });
  const proposal = await service.propose("replay-owner", email, "run/tool-1");
  await service.decide("replay-owner", proposal.id, proposal.hash, "approve");
  const replay = await service.propose("replay-owner", email, "run/tool-1");
  assert.equal(replay.id, proposal.id);
  assert.equal(replay.status, "succeeded");
  assert.equal(preparations, 1);
  const otherOwner = await service.propose("different-owner", email, "run/tool-1");
  assert.equal(otherOwner.status, "awaiting_review");
});

test("concurrent idempotent proposals retain a single persisted review and activity entry", async () => {
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  const results = await Promise.all([
    service.propose("concurrent-replay", email, "run/tool-1"),
    service.propose("concurrent-replay", email, "run/tool-1"),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await db.list("concurrent-replay", "actions")).length, 1);
  assert.equal((await db.list("concurrent-replay", "activity")).length, 1);
});

test("an expired stale review cannot overwrite a concurrently executing action", async (t) => {
  let now = Date.now();
  const read = deferred<void>();
  const resumeRead = deferred<void>();
  const executing = deferred<void>();
  const finishExecution = deferred<string>();
  const service = new ActionService(db, {
    connected: async () => true,
    now: () => now,
    execute: async () => {
      executing.resolve();
      return finishExecution.promise;
    },
  });
  const proposal = await service.propose("expiry-race", email);
  const originalGet = db.get.bind(db);
  let intercept = true;
  t.mock.method(db, "get", async (...args: Parameters<Store["get"]>) => {
    const result = await originalGet(...args);
    if (intercept && args[0] === "expiry-race" && args[1] === "actions") {
      intercept = false;
      read.resolve();
      await resumeRead.promise;
    }
    return result;
  });
  const stale = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await read.promise;
  const approval = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await executing.promise;
  now += 31 * 60 * 1000;
  resumeRead.resolve();
  await stale.catch((error) => assert.match(error.message, /expired/i));
  const saved = await db.get<ActionProposal>("expiry-race", "actions", proposal.id);
  finishExecution.resolve("sent");
  await approval;
  assert.equal(saved?.status, "executing");
});

test("a deny that loses the claim to a concurrent approve is rejected, not silently dropped", async () => {
  const gate = deferred<void>();
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => {
      await gate.promise;
      return "sent";
    },
  });
  const proposal = await service.propose("conflict-user", email);
  const approval = service.decide("conflict-user", proposal.id, proposal.hash, "approve");
  for (let i = 0; i < 200; i++) {
    const snap = await db.get<ActionProposal>("conflict-user", "actions", proposal.id);
    if (snap?.status === "executing") break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await assert.rejects(
    service.decide("conflict-user", proposal.id, proposal.hash, "deny"),
    /already approved/i,
  );
  const during = await db.get<ActionProposal>("conflict-user", "actions", proposal.id);
  assert.equal(during?.status, "executing");
  gate.resolve();
  assert.equal((await approval).status, "succeeded");
});

test("an approve that loses the claim to a concurrent deny is rejected, not silently dropped", async () => {
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  const proposal = await service.propose("conflict-user-2", email);
  assert.equal(
    (await service.decide("conflict-user-2", proposal.id, proposal.hash, "deny")).status,
    "denied",
  );
  await assert.rejects(
    service.decide("conflict-user-2", proposal.id, proposal.hash, "approve"),
    /already denied/i,
  );
  const saved = await db.get<ActionProposal>("conflict-user-2", "actions", proposal.id);
  assert.equal(saved?.status, "denied");
});

test("repeating the recorded decision stays idempotent", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => {
      calls++;
      return "sent";
    },
  });
  const denied = await service.propose("idem-user-1", email);
  assert.equal(
    (await service.decide("idem-user-1", denied.id, denied.hash, "deny")).status,
    "denied",
  );
  assert.equal(
    (await service.decide("idem-user-1", denied.id, denied.hash, "deny")).status,
    "denied",
  );
  const approved = await service.propose("idem-user-2", email);
  assert.equal(
    (await service.decide("idem-user-2", approved.id, approved.hash, "approve")).status,
    "succeeded",
  );
  assert.equal(
    (await service.decide("idem-user-2", approved.id, approved.hash, "approve")).status,
    "succeeded",
  );
  assert.equal(calls, 1);
});

test("an approval crossing the expiry line mid-request is rejected, not silently dropped", async () => {
  const t0 = Date.now();
  let expired = false;
  const service = new ActionService(db, {
    // The connected() check runs immediately before the claim SQL, so arming
    // the clock here simulates the review expiring between decide()'s
    // pre-checks and the atomic claim.
    connected: async () => {
      expired = true;
      return true;
    },
    now: () => (expired ? t0 + 31 * 60 * 1000 : t0),
    execute: async () => "sent",
  });
  const proposal = await service.propose("midflight-expiry", email);
  await assert.rejects(
    service.decide("midflight-expiry", proposal.id, proposal.hash, "approve"),
    /expired/i,
  );
  const saved = await db.get<ActionProposal>("midflight-expiry", "actions", proposal.id);
  assert.equal(saved?.status, "awaiting_review");
});

test("a decision whose own expiry CAS loses to the tick is rejected", async (t) => {
  let now = Date.now();
  const service = new ActionService(db, {
    connected: async () => true,
    now: () => now,
    execute: async () => "sent",
  });
  const proposal = await service.propose("cas-race", email);
  now += 31 * 60 * 1000;
  // The tick flips the row between decide()'s read and its expiry CAS.
  const originalCAS = db.compareAndSwap.bind(db);
  let flipped = false;
  t.mock.method(db, "compareAndSwap", async (...args: Parameters<Store["compareAndSwap"]>) => {
    if (!flipped && args[1] === "actions") {
      flipped = true;
      await db.put("cas-race", "actions", { ...proposal, status: "expired" });
    }
    return originalCAS(...args);
  });
  await assert.rejects(
    service.decide("cas-race", proposal.id, proposal.hash, "approve"),
    /expired/i,
  );
});

test("an approval whose claim loses to a task pause is rejected with the resume hint", async (t) => {
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  await db.put("pause-user", "tasks", { id: "task-pause-1", status: "running" });
  const proposal = await service.propose("pause-user", email, undefined, "task-pause-1");
  // The pause lands between decide()'s task pre-check and the claim SQL.
  const originalClaim = db.claim.bind(db);
  let paused = false;
  t.mock.method(db, "claim", async (...args: Parameters<Store["claim"]>) => {
    if (!paused) {
      paused = true;
      await db.put("pause-user", "tasks", { id: "task-pause-1", status: "paused" });
    }
    return originalClaim(...args);
  });
  await assert.rejects(
    service.decide("pause-user", proposal.id, proposal.hash, "approve"),
    /Resume the task before approving/i,
  );
  const saved = await db.get<ActionProposal>("pause-user", "actions", proposal.id);
  assert.equal(saved?.status, "awaiting_review");
});
