import { createHash, randomUUID } from "node:crypto";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string) => Promise<boolean>;
  connection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
// A denied or expired proposal in the idempotent slot is a dead review: the
// worker's checkpoint-failure cleanup may have denied it, or it expired while
// the task was paused. Other terminal states (succeeded/failed/outcome_unknown)
// are receipts that idempotent replay must preserve.
const deadReviewStatuses = new Set(["denied", "expired"]);
function isDeadReview(proposal: ActionProposal, now: number): boolean {
  if (deadReviewStatuses.has(proposal.status)) return true;
  return proposal.status === "awaiting_review" && Date.parse(proposal.expiresAt) <= now;
}
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    const slot =
      idempotencyKey === undefined
        ? null
        : createHash("sha256").update(idempotencyKey).digest("hex");
    // A dead review occupying the idempotent slot must not be returned: a
    // resumed task would fail with a "Reviewed action denied/expired" the user
    // never saw. Mint a fresh id so the task gets a new review instead.
    let id = slot ?? randomUUID();
    if (slot) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", slot);
      if (existing && !isDeadReview(existing, this.now())) return existing;
      if (existing) id = randomUUID();
    }
    const parsed = proposalSchema.parse(raw);
    const connection = await this.options.connection?.(owner);
    if (this.options.connection && !connection)
      throw new AppError("Connect Google before preparing an action", 409);
    const prepared = await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "email.send"
        ? `Send “${input.data.subject}”`
        : input.kind === "calendar.delete"
          ? `Delete ${input.data.title}`
          : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      id === slot
        ? await this.db.insertIfAbsent(owner, "actions", proposal)
        : await this.db.put(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") {
      // The fresh read already shows the recorded outcome: a conflicting
      // decision is rejected, an idempotent repeat returns the row as-is.
      this.rejectLostDecision(proposal, decision);
      return proposal;
    }
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string; actionId?: string | null }>(
        owner,
        "tasks",
        proposal.taskId,
      );
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
      if (task.actionId && task.actionId !== id)
        throw new AppError("This review is no longer the task's current proposal.", 409);
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        // The tick's identical CAS (or a concurrent decision) won the race.
        // A lost decision is never reported as a success.
        this.rejectLostDecision(current, decision);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    if (decision === "approve" && !(await this.options.connected(owner)))
      throw new AppError("Google is disconnected. Reconnect before approving this action.", 409);
    if (decision === "approve" && this.options.connection) {
      const connection = await this.options.connection(owner);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      // The atomic claim refused: a concurrent decision, the tick's expiry,
      // or (for approve) a task that left running/waiting_approval. None of
      // these may be reported as a successful decision.
      this.rejectLostDecision(current, decision);
      if (decision === "approve" && current.status === "awaiting_review" && proposal.taskId) {
        const task = await this.db.get<{ status: string; actionId?: string | null }>(
          owner,
          "tasks",
          proposal.taskId,
        );
        if (!task || !["running", "waiting_approval"].includes(task.status))
          throw new AppError(
            "Resume the task before approving this action. Cancelled tasks cannot execute.",
            409,
          );
        // The task re-linked to a newer proposal after the pre-check: this
        // decision lost to the re-link and must not read as a success.
        if (task.actionId && task.actionId !== id)
          throw new AppError("This review is no longer the task's current proposal.", 409);
      }
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny" ? "Declined; no changes made" : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    let finished: ActionProposal;
    try {
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
      );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.record(owner, finished, finished.result ?? finished.error ?? finished.status);
    return finished;
  }
  /**
   * A decision whose atomic claim (or expiry CAS) lost to a concurrent
   * decision, the tick's expiry flip, or a time-expired row must never be
   * reported as a success. Conflicting decisions get a 409; only an
   * idempotent repeat of the recorded outcome returns the row as-is.
   */
  private rejectLostDecision(current: ActionProposal, decision: "approve" | "deny"): void {
    if (current.status === "expired" || Date.parse(current.expiresAt) <= this.now())
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    if (decision === "deny" && current.status === "executing")
      throw new AppError("This review was already approved; the action is executing.", 409);
    if (decision === "approve" && current.status === "denied")
      throw new AppError("This review was already denied.", 409);
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
