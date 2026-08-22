import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { AiJobRuntimePhysicalAdapter } from "./ai-job-runtime.js";
import type { AiJobClaimBoundary } from "./ai-job-runtime-state.js";
import type {
  AiJobClaim,
  AiJobFailure,
  AiJobLedger,
  AiJobWorkflowAllowlist,
} from "./ai-job-ledger.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import type { ResearchWorker } from "./research-worker.js";
import {
  LiveAcquisitionActionPolicyError,
  type LiveAcquisitionActionLedger,
} from "./live-acquisition-action-ledger.js";
import { LIVE_ACQUISITION_WORKFLOW } from "./live-acquisition-foundation.js";
import { parseRobotsPolicy } from "./live-acquisition-policy.js";
import {
  createSafePublicHttpClient,
  type SafePublicHttpClient,
} from "./safe-public-http-client.js";

export interface ResearchAcquisitionCoordinator {
  executeAction(actionId: number, signal?: AbortSignal): Promise<void>;
  runTracked(actionId: number): void;
  activeCount(): number;
  stop(): Promise<void>;
}

export interface ResearchAcquisitionCoordinatorOptions {
  readonly actionLedger: LiveAcquisitionActionLedger;
  readonly client?: SafePublicHttpClient;
  readonly onSettled?: (actionId: number) => void;
}

const C81_WORKFLOW = Object.freeze({ id: "research_workflow:c81:v1", version: 1 });
const C90_ALLOWLIST = [LIVE_ACQUISITION_WORKFLOW] as const satisfies AiJobWorkflowAllowlist;
const C81_ALLOWLIST = [C81_WORKFLOW] as const satisfies AiJobWorkflowAllowlist;
const visitedPageOutcomeCodes = new Set([
  "META_REFRESH", "AUTH_REQUIRED", "CHALLENGE_PAGE", "SPA_SHELL",
  "INSUFFICIENT_PUBLIC_TEXT", "INVALID_UTF8",
]);

/**
 * Bridges C90's reconstructable page counters into the generic scheduler budget.
 * Callers pass the persisted count of page reservations that reached a terminal
 * state; the helper charges only the monotonic delta and is replay-idempotent.
 */
export function checkpointC90TerminalPages(
  ledger: AiJobLedger,
  claim: AiJobClaim,
  terminalReservedPages: number,
): AiJobClaim {
  if (claim.kind !== "resource_research" || claim.task.kind !== "resource_research" ||
      claim.task.workflowRef.id !== LIVE_ACQUISITION_WORKFLOW.id ||
      claim.task.workflowRef.version !== LIVE_ACQUISITION_WORKFLOW.version) {
    throw new TypeError("C90 terminal page checkpoint requires an exact C90 claim");
  }
  if (!Number.isSafeInteger(terminalReservedPages) || terminalReservedPages < 0 ||
      terminalReservedPages > 50 || claim.usage.steps > terminalReservedPages) {
    throw new TypeError("invalid C90 terminal page count");
  }
  if (claim.progress.completed !== 0 || claim.progress.total !== 1 ||
      (claim.checkpoint !== null && (!("nextStep" in claim.checkpoint) ||
        claim.checkpoint.nextStep !== 0))) {
    throw new TypeError("invalid C90 generic checkpoint state");
  }
  const delta = terminalReservedPages - claim.usage.steps;
  if (delta === 0) return claim;
  ledger.checkpoint(claim, {
    progress: { completed: 0, total: 1, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: {
      steps: delta,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    },
  });
  return ledger.refresh(claim);
}

/**
 * Reads C90's durable action history and charges only terminal actions backed
 * by a durable page reservation. Pre-request failures still consume their
 * admitted page; robots never consume page steps.
 */
export function checkpointC90PersistedTerminalPages(
  connection: Database.Database,
  ledger: AiJobLedger,
  claim: AiJobClaim,
): AiJobClaim {
  const terminalReservedPages = Number(connection.prepare(`
    SELECT COUNT(*)
    FROM live_acquisition_consents AS consent
    JOIN live_acquisition_actions AS action ON action.consent_id = consent.id
    JOIN live_acquisition_page_reservations AS reservation
      ON reservation.consent_id = consent.id AND reservation.action_id = action.id
    WHERE consent.coordinator_job_id = ?
      AND action.action_kind = 'page'
      AND action.state IN ('completed', 'blocked', 'ambiguous')
  `).pluck().get(claim.id));
  return checkpointC90TerminalPages(ledger, claim, terminalReservedPages);
}

export interface C90ActionPlanOptions {
  readonly claim: AiJobClaim;
  readonly actionIds: readonly number[];
  readonly signal: AbortSignal;
  readonly executeAction: (actionId: number, signal: AbortSignal) => Promise<void>;
  readonly reconcile: (claim: AiJobClaim) => AiJobClaim;
  readonly renewLease: () => boolean | void;
}

/**
 * Reconciles durable page reservations before an empty-plan decision and in a
 * finally boundary after every action. Cancellation prevents the next action
 * and lease renewal, but never skips accounting for the action that returned.
 */
export async function executeC90ActionPlan(
  options: C90ActionPlanOptions,
): Promise<AiJobClaim> {
  let current = options.reconcile(options.claim);
  for (let index = 0; index < options.actionIds.length; index += 1) {
    if (options.signal.aborted) break;
    try {
      await options.executeAction(options.actionIds[index]!, options.signal);
    } finally {
      current = options.reconcile(current);
    }
    if (options.signal.aborted) break;
    if (index + 1 < options.actionIds.length) options.renewLease();
  }
  return current;
}

export interface C90DynamicActionPlanOptions {
  readonly claim: AiJobClaim;
  readonly signal: AbortSignal;
  /** Pure durable read. It is called only after the previous action transaction settled. */
  readonly nextActionId: () => number | undefined;
  readonly executeAction: (actionId: number, signal: AbortSignal) => Promise<void>;
  readonly reconcile: (claim: AiJobClaim) => AiJobClaim;
  readonly renewLease: () => boolean | void;
  readonly maxActions?: number;
}

/** Drains a changing durable frontier, including actions admitted by page terminal CAS. */
export async function executeC90DynamicActionPlan(
  options: C90DynamicActionPlanOptions,
): Promise<AiJobClaim> {
  const maxActions = options.maxActions ?? 100;
  if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 100) {
    throw new TypeError("invalid C90 dynamic action bound");
  }
  let current = options.reconcile(options.claim);
  let actionId = options.nextActionId();
  let executed = 0;
  while (actionId !== undefined && !options.signal.aborted && executed < maxActions) {
    try {
      await options.executeAction(actionId, options.signal);
    } finally {
      current = options.reconcile(current);
    }
    executed += 1;
    if (options.signal.aborted || executed >= maxActions) break;
    actionId = options.nextActionId();
    if (actionId !== undefined) options.renewLease();
  }
  return current;
}

/** Selects one current durable frontier item; no IDs are cached across actions. */
export function selectC90NextPlannedActionId(
  connection: Database.Database,
  coordinatorJobId: number,
): number | undefined {
  if (!Number.isSafeInteger(coordinatorJobId) || coordinatorJobId < 1) {
    throw new TypeError("invalid C90 coordinator job id");
  }
  return connection.prepare(`
    SELECT action.id
    FROM research_runs AS run
    JOIN privacy_subject_generations AS generation
      ON generation.subject_kind = 'research_run'
      AND generation.research_run_id = run.id AND generation.is_active = 1
    JOIN live_acquisition_consents AS consent
      ON consent.coordinator_job_id = run.job_id
      AND consent.coordinator_run_generation_id = generation.id
      AND consent.status = 'active'
    JOIN live_acquisition_actions AS action ON action.consent_id = consent.id
    JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
    WHERE run.job_id = ? AND action.state = 'planned'
    ORDER BY CASE action.action_kind WHEN 'robots' THEN 0 ELSE 1 END,
      action.depth, CAST(url.exact_url AS BLOB), action.id
    LIMIT 1
  `).pluck().get(coordinatorJobId) as number | undefined;
}

export interface C90RecoveryFacts {
  readonly attemptNo: number;
  readonly maxAttempts: number;
  readonly wallBudgetRemaining: boolean;
  readonly remainingNeverStartedPlanned: number;
  readonly capturedPages: number;
  readonly ambiguousActions: number;
}

export type C90RecoveryPlan =
  | { readonly kind: "handoff_ready" }
  | {
      readonly kind: "reconsent_required";
      readonly networkActions: 0;
      readonly reuseCapturedMaterial: boolean;
    }
  | {
      readonly kind: "terminal";
      readonly code: "WORKFLOW_AMBIGUOUS" | "NO_ELIGIBLE_SOURCE" | "BUDGET_EXHAUSTED";
    };

/** Pure recovery decision: a retired consent can never authorize another request. */
export function planC90Recovery(facts: C90RecoveryFacts): C90RecoveryPlan {
  for (const count of [facts.attemptNo, facts.maxAttempts,
    facts.remainingNeverStartedPlanned, facts.capturedPages, facts.ambiguousActions]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("invalid C90 recovery facts");
    }
  }
  if (facts.attemptNo < 1 || facts.maxAttempts < 1 || facts.attemptNo > facts.maxAttempts) {
    throw new TypeError("invalid C90 recovery attempt boundary");
  }
  if (facts.ambiguousActions > 0) {
    return { kind: "terminal", code: "WORKFLOW_AMBIGUOUS" };
  }
  if (facts.remainingNeverStartedPlanned === 0) {
    return facts.capturedPages > 0
      ? { kind: "handoff_ready" }
      : { kind: "terminal", code: "NO_ELIGIBLE_SOURCE" };
  }
  if (!facts.wallBudgetRemaining || facts.attemptNo >= facts.maxAttempts) {
    return { kind: "terminal", code: "BUDGET_EXHAUSTED" };
  }
  return {
    kind: "reconsent_required",
    networkActions: 0,
    reuseCapturedMaterial: facts.capturedPages > 0,
  };
}

export interface TrackedC90ClaimExecutor {
  runTrackedClaim(claim: AiJobClaim): void;
  abortAndWait(input: TrackedC90AbortRequest): Promise<TrackedC90AbortResult>;
  activeCount(): number;
  stop(): Promise<void>;
}

export interface TrackedC90AbortRequest {
  readonly actionId: number;
  readonly jobId: number;
  readonly attemptId: number;
  readonly attemptNo: number;
  readonly leaseTokenDigest: string;
  readonly executionKeyDigest: string;
  readonly abortRequestDigest: string;
}

export interface TrackedC90AbortAcknowledgement {
  readonly status: "acknowledged";
  readonly actionId: number;
  readonly jobId: number;
  readonly attemptId: number;
  readonly attemptNo: number;
  readonly leaseTokenDigest: string;
  readonly executionKeyDigest: string;
  readonly abortRequestDigest: string;
  readonly signalled: true;
  readonly settled: true;
  readonly settlement: "fulfilled" | "rejected";
  readonly acknowledgementDigest: string;
}

export interface TrackedC90AlreadySettled {
  readonly status: "already_settled";
  readonly actionId: number;
  readonly jobId: number;
  readonly attemptId: number;
  readonly attemptNo: number;
  readonly leaseTokenDigest: string;
  readonly executionKeyDigest: string;
  readonly abortRequestDigest: string | null;
  readonly signalled: false;
  readonly settled: true;
  readonly settlement: "fulfilled" | "rejected";
  readonly terminalOutcome: "settled_without_abort" | "settled_after_external_abort";
  readonly resultDigest: string;
}

/**
 * Result digests bind the plain data returned by this exact bridge invocation.
 * They are not bearer capabilities: downstream code must trust only the direct
 * return value, never a caller-supplied object or independently recomputed hash.
 */
export type TrackedC90AbortResult =
  | TrackedC90AbortAcknowledgement
  | TrackedC90AlreadySettled;

export interface TrackedC90AbortSignalReason {
  readonly kind: "privacy_purge";
  readonly requestDigest: string;
  readonly actionId: number;
  readonly executionKeyDigest: string;
}

export function trackedC90PrivacyPurgeAbortFromSignal(
  signal: AbortSignal | undefined,
  actionId: number,
): TrackedC90AbortSignalReason | null {
  if (signal?.aborted !== true) return null;
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return null;
  const record = reason as Record<string, unknown>;
  return record.kind === "privacy_purge" && record.actionId === actionId &&
    Number.isSafeInteger(record.actionId) && Number(record.actionId) > 0 &&
    typeof record.requestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(record.requestDigest) &&
    typeof record.executionKeyDigest === "string" &&
    /^[0-9a-f]{64}$/.test(record.executionKeyDigest)
    ? Object.freeze({
      kind: "privacy_purge", requestDigest: record.requestDigest,
      actionId: Number(record.actionId), executionKeyDigest: record.executionKeyDigest,
    }) : null;
}

export class TrackedC90AbortError extends Error {
  constructor(
    readonly code:
      | "C90_EXECUTION_NOT_ACTIVE"
      | "C90_EXECUTION_IDENTITY_MISMATCH"
      | "C90_ABORT_ALREADY_REQUESTED"
      | "C90_EXECUTION_ALREADY_ABORTED"
      | "INVALID_C90_ABORT_REQUEST",
  ) {
    super(code);
    this.name = "TrackedC90AbortError";
  }
}

export interface TrackedC90ClaimExecutorOptions {
  readonly ledger: AiJobLedger;
  readonly executeClaim: (
    claim: AiJobClaim,
    signal: AbortSignal,
    control: C90ClaimExecutionControl,
  ) => Promise<void>;
  readonly onSettled?: (claim: AiJobClaim) => void;
  readonly clock?: () => Date;
}

export interface C90ClaimExecutionControl {
  /** Must be called between durable acquisition actions. */
  renewLease(): boolean;
}

/**
 * Owns the in-memory half of the C90 attempt fence. Durable claim/lease CAS stays
 * in AiJobLedger; this layer only deduplicates that exact claimed attempt,
 * tracks its abortable promise, and wakes the shared runtime after settlement.
 */
export function createTrackedC90ClaimExecutor(
  options: TrackedC90ClaimExecutorOptions,
): TrackedC90ClaimExecutor {
  type Settlement = "fulfilled" | "rejected";
  interface ExecutionIdentity {
    readonly jobId: number;
    readonly attemptId: number;
    readonly attemptNo: number;
    readonly leaseTokenDigest: string;
    readonly executionKeyDigest: string;
  }
  interface ActiveExecution extends ExecutionIdentity {
    readonly key: string;
    readonly controller: AbortController;
    readonly promise: Promise<Settlement>;
    abortRequested: boolean;
    operationSettled: boolean;
    externallyAbortedAtSettlement: boolean;
    abortRequestDigest: string | null;
  }
  interface SettledExecution extends ExecutionIdentity {
    readonly settlement: Settlement;
    readonly externallyAborted: boolean;
    readonly abortRequestDigest: string | null;
  }
  const active = new Map<number, ActiveExecution>();
  const recentlySettled = new Map<number, SettledExecution>();
  const clock = options.clock ?? (() => new Date());
  let stopping = false;
  const keyOf = (claim: AiJobClaim) =>
    `${claim.id}:${claim.attemptId}:${claim.attemptNo}:${claim.leaseToken}`;
  const digest = (domain: string, value: unknown) => createHash("sha256")
    .update(`${domain}\0${JSON.stringify(value)}`, "utf8").digest("hex");
  const identityOf = (claim: AiJobClaim): ExecutionIdentity => {
    const leaseTokenDigest = createHash("sha256")
      .update(claim.leaseToken, "utf8").digest("hex");
    const identity = {
      jobId: claim.id,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      leaseTokenDigest,
    };
    return Object.freeze({
      ...identity,
      executionKeyDigest: digest("tabhub:c90-tracked-execution:v1", identity),
    });
  };
  const snapshotAbortRequest = (
    input: TrackedC90AbortRequest,
  ): TrackedC90AbortRequest => {
    let jobId: unknown;
    let actionId: unknown;
    let attemptId: unknown;
    let attemptNo: unknown;
    let leaseTokenDigest: unknown;
    let abortRequestDigest: unknown;
    let executionKeyDigest: unknown;
    try {
      actionId = input.actionId;
      jobId = input.jobId;
      attemptId = input.attemptId;
      attemptNo = input.attemptNo;
      leaseTokenDigest = input.leaseTokenDigest;
      abortRequestDigest = input.abortRequestDigest;
      executionKeyDigest = input.executionKeyDigest;
    } catch {
      throw new TrackedC90AbortError("INVALID_C90_ABORT_REQUEST");
    }
    const snapshot = Object.freeze({
      actionId, jobId, attemptId, attemptNo, leaseTokenDigest,
      executionKeyDigest, abortRequestDigest,
    });
    if (!Number.isSafeInteger(snapshot.actionId) || Number(snapshot.actionId) < 1 ||
        !Number.isSafeInteger(snapshot.jobId) || Number(snapshot.jobId) < 1 ||
        !Number.isSafeInteger(snapshot.attemptId) || Number(snapshot.attemptId) < 1 ||
        !Number.isSafeInteger(snapshot.attemptNo) || Number(snapshot.attemptNo) < 1 ||
        typeof snapshot.leaseTokenDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(snapshot.leaseTokenDigest) ||
        typeof snapshot.abortRequestDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(snapshot.abortRequestDigest) ||
        typeof snapshot.executionKeyDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(snapshot.executionKeyDigest)) {
      throw new TrackedC90AbortError("INVALID_C90_ABORT_REQUEST");
    }
    return snapshot as TrackedC90AbortRequest;
  };
  const validateAbortRequest = (input: TrackedC90AbortRequest) => {
    if (!Number.isSafeInteger(input.actionId) || input.actionId < 1 ||
        !Number.isSafeInteger(input.jobId) || input.jobId < 1 ||
        !Number.isSafeInteger(input.attemptId) || input.attemptId < 1 ||
        !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 ||
        !/^[0-9a-f]{64}$/.test(input.leaseTokenDigest) ||
        !/^[0-9a-f]{64}$/.test(input.abortRequestDigest) ||
        !/^[0-9a-f]{64}$/.test(input.executionKeyDigest)) {
      throw new TrackedC90AbortError("INVALID_C90_ABORT_REQUEST");
    }
  };
  const exactIdentity = (
    execution: ExecutionIdentity,
    input: TrackedC90AbortRequest,
  ) => execution.jobId === input.jobId &&
    execution.attemptId === input.attemptId &&
    execution.attemptNo === input.attemptNo &&
    execution.leaseTokenDigest === input.leaseTokenDigest &&
    execution.executionKeyDigest === input.executionKeyDigest;
  const rememberSettlement = (execution: ActiveExecution, settlement: Settlement) => {
    recentlySettled.delete(execution.jobId);
    recentlySettled.set(execution.jobId, Object.freeze({
      jobId: execution.jobId,
      attemptId: execution.attemptId,
      attemptNo: execution.attemptNo,
      leaseTokenDigest: execution.leaseTokenDigest,
      executionKeyDigest: execution.executionKeyDigest,
      settlement,
      externallyAborted: execution.externallyAbortedAtSettlement,
      abortRequestDigest: execution.abortRequestDigest,
    }));
    while (recentlySettled.size > 256) {
      recentlySettled.delete(recentlySettled.keys().next().value!);
    }
  };
  const settledResult = (
    settled: SettledExecution,
    request: TrackedC90AbortRequest,
  ): TrackedC90AlreadySettled => {
    const result = {
      status: "already_settled" as const,
      actionId: request.actionId,
      jobId: settled.jobId,
      attemptId: settled.attemptId,
      attemptNo: settled.attemptNo,
      leaseTokenDigest: settled.leaseTokenDigest,
      executionKeyDigest: settled.executionKeyDigest,
      abortRequestDigest: settled.abortRequestDigest,
      signalled: false as const,
      settled: true as const,
      settlement: settled.settlement,
      terminalOutcome: settled.externallyAborted
        ? "settled_after_external_abort" as const
        : "settled_without_abort" as const,
    };
    return Object.freeze({
      ...result,
      resultDigest: digest("tabhub:c90-tracked-settled:v1", result),
    });
  };
  const assertClaim = (claim: AiJobClaim) => {
    if (claim.kind !== "resource_research" || claim.task.kind !== "resource_research" ||
        claim.task.workflowRef.id !== LIVE_ACQUISITION_WORKFLOW.id ||
        claim.task.workflowRef.version !== LIVE_ACQUISITION_WORKFLOW.version) {
      throw new TypeError("tracked C90 executor requires an exact C90 claim");
    }
  };
  const initialCheckpoint = {
    progress: { completed: 0, total: 1, stage: "claimed" },
    checkpoint: { version: 1 as const, nextStep: 0, stage: "claimed" as const },
    usage: {
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    },
  };
  const retryAt = (attemptNo: number): string => {
    const exponent = Math.max(0, Math.min(8, attemptNo - 1));
    return new Date(clock().getTime() + Math.min(300_000, 1_000 * 2 ** exponent))
      .toISOString();
  };
  const failureFor = (error: unknown, attemptNo: number): AiJobFailure | undefined => {
    if (error instanceof DurableAiJobError) {
      if (error.code === "JOB_LEASE_LOST") return undefined;
      if (error.code === "JOB_SUBJECT_NOT_FOUND" ||
          error.code === "JOB_BUDGET_EXHAUSTED" ||
          error.code === "INVALID_JOB_TRANSITION") {
        return { code: error.code };
      }
      if (error.code === "JOB_INPUT_UNAVAILABLE") {
        return attemptNo < 3
          ? { code: error.code, retryAt: retryAt(attemptNo) }
          : { code: error.code };
      }
      if (error.code === "JOB_CLOCK_REGRESSION") return { code: error.code };
    }
    return attemptNo < 3
      ? { code: "JOB_INPUT_UNAVAILABLE", retryAt: retryAt(attemptNo) }
      : { code: "JOB_INPUT_UNAVAILABLE" };
  };

  return Object.freeze({
    runTrackedClaim(claim: AiJobClaim) {
      assertClaim(claim);
      if (stopping) return;
      const key = keyOf(claim);
      const existing = active.get(claim.id);
      if (existing?.key === key) return;
      if (existing !== undefined) {
        throw new DurableAiJobError(
          "JOB_ACTIVE_CONFLICT",
          "C90 job already has another active attempt",
        );
      }
      const controller = new AbortController();
      let entry!: ActiveExecution;
      const executionPromise = Promise.resolve().then(async () => {
        try {
          const view = options.ledger.checkpoint(claim, initialCheckpoint);
          if (view.status !== "running") return;
          const control: C90ClaimExecutionControl = Object.freeze({
            renewLease() {
              try {
                const renewed = options.ledger.renew(claim);
                if (renewed !== undefined) return true;
              } catch (error) {
                controller.abort();
                throw error;
              }
              controller.abort();
              throw new DurableAiJobError("JOB_LEASE_LOST", "C90 lease was lost");
            },
          });
          await options.executeClaim(claim, controller.signal, control);
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = failureFor(error, claim.attemptNo);
          if (failure === undefined) return;
          try {
            const current = options.ledger.refresh(claim);
            options.ledger.fail(current, initialCheckpoint, failure);
          } catch (fenceError) {
            if (!(fenceError instanceof DurableAiJobError) ||
                fenceError.code !== "JOB_LEASE_LOST") throw fenceError;
          }
        } finally {
          entry.operationSettled = true;
          entry.externallyAbortedAtSettlement = controller.signal.aborted;
          const reason = controller.signal.reason as Partial<TrackedC90AbortSignalReason>;
          entry.abortRequestDigest = reason?.kind === "privacy_purge" &&
            typeof reason.requestDigest === "string" ? reason.requestDigest : null;
        }
      });
      const identity = identityOf(claim);
      const promise = executionPromise.then(
        (): Settlement => "fulfilled",
        (): Settlement => "rejected",
      ).then((settlement) => {
        rememberSettlement(entry, settlement);
        return settlement;
      }).finally(() => {
        if (active.get(claim.id)?.key === key) active.delete(claim.id);
        try {
          options.onSettled?.(claim);
        } catch {
          // Observation/wakeup callbacks cannot change execution settlement or abort proof.
        }
      });
      entry = {
        ...identity,
        key,
        controller,
        promise,
        abortRequested: false,
        operationSettled: false,
        externallyAbortedAtSettlement: false,
        abortRequestDigest: null,
      };
      active.set(claim.id, entry);
    },
    async abortAndWait(input: TrackedC90AbortRequest) {
      const request = snapshotAbortRequest(input);
      validateAbortRequest(request);
      const execution = active.get(request.jobId);
      if (execution === undefined) {
        const settled = recentlySettled.get(request.jobId);
        if (settled === undefined) {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        }
        if (!exactIdentity(settled, request)) {
          throw new TrackedC90AbortError("C90_EXECUTION_IDENTITY_MISMATCH");
        }
        return settledResult(settled, request);
      }
      if (!exactIdentity(execution, request)) {
        throw new TrackedC90AbortError("C90_EXECUTION_IDENTITY_MISMATCH");
      }
      if (execution.operationSettled) {
        await execution.promise;
        const settled = recentlySettled.get(request.jobId);
        if (settled === undefined || !exactIdentity(settled, request)) {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        }
        return settledResult(settled, request);
      }
      if (execution.abortRequested) {
        throw new TrackedC90AbortError("C90_ABORT_ALREADY_REQUESTED");
      }
      if (execution.controller.signal.aborted) {
        throw new TrackedC90AbortError("C90_EXECUTION_ALREADY_ABORTED");
      }
      execution.abortRequested = true;
      execution.abortRequestDigest = request.abortRequestDigest;
      const reason: TrackedC90AbortSignalReason = Object.freeze({
        kind: "privacy_purge",
        requestDigest: request.abortRequestDigest,
        actionId: request.actionId,
        executionKeyDigest: request.executionKeyDigest,
      });
      execution.controller.abort(reason);
      const settlement = await execution.promise;
      if (active.get(request.jobId) === execution) {
        throw new Error("Tracked C90 abort acknowledgement preceded active removal");
      }
      const acknowledgement = {
        status: "acknowledged" as const,
        actionId: request.actionId,
        jobId: execution.jobId,
        attemptId: execution.attemptId,
        attemptNo: execution.attemptNo,
        leaseTokenDigest: execution.leaseTokenDigest,
        executionKeyDigest: execution.executionKeyDigest,
        abortRequestDigest: request.abortRequestDigest,
        signalled: true as const,
        settled: true as const,
        settlement,
      };
      return Object.freeze({
        ...acknowledgement,
        acknowledgementDigest: digest("tabhub:c90-tracked-abort-ack:v1", acknowledgement),
      });
    },
    activeCount: () => active.size,
    async stop() {
      stopping = true;
      for (const execution of active.values()) execution.controller.abort();
      await Promise.allSettled([...active.values()].map(({ promise }) => promise));
    },
  });
}

export interface CompositeResourceResearchAdapterOptions {
  readonly connection: Database.Database;
  readonly ledger: AiJobLedger;
  readonly c90: TrackedC90ClaimExecutor;
  readonly c81: ResearchWorker;
  readonly c90Enabled?: boolean;
  readonly workerId?: string;
  readonly maxC90AttemptsPerUtcDay?: number;
  readonly clock?: () => Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Sole production owner of SafePublicHttpClient. The public module boundary is
 * action IDs, never arbitrary methods, headers, cookies, credentials or agents.
 */
export function createResearchAcquisitionCoordinator(
  options: ResearchAcquisitionCoordinatorOptions,
): ResearchAcquisitionCoordinator {
  const client = options.client ?? createSafePublicHttpClient();
  const active = new Map<number, { controller: AbortController; promise: Promise<void> }>();
  let stopping = false;

  async function executeAction(actionId: number, signal?: AbortSignal): Promise<void> {
    const isAborted = () => signal?.aborted === true;
    if (isAborted()) return;
    const initial = options.actionLedger.read(actionId);
    if (initial.state !== "planned") return;
    try {
      if (isAborted()) return;
      options.actionLedger.beginResolution(actionId);
      const resolution = await client.resolve({
        version: "safe_public_http_request:v1",
        url: initial.exact_url,
        expiresAt: initial.expires_at,
        ...(signal === undefined ? {} : { signal }),
      });
      if (isAborted()) return;
      if (resolution.kind === "blocked") {
        options.actionLedger.block(actionId, resolution.code);
        return;
      }
      options.actionLedger.recordResolution(actionId, resolution);
      const authorization = options.actionLedger.authorize(actionId);
      if (isAborted()) return;
      options.actionLedger.reserveRequest(actionId);
      if (isAborted()) return;
      options.actionLedger.start(actionId);
      const response = await client.request({
        version: "safe_public_http_request:v1",
        actionKind: initial.action_kind,
        canonicalUrl: resolution.canonicalUrl,
        canonicalOrigin: resolution.canonicalOrigin,
        hostname: resolution.hostname,
        pinnedIpv4: resolution.selectedIpv4,
        answerSetDigest: resolution.answerSetDigest,
        expiresAt: authorization.expiresAt,
        ...(signal === undefined ? {} : { signal }),
      });
      if (isAborted()) {
        const provenance = trackedC90PrivacyPurgeAbortFromSignal(signal, actionId);
        if (provenance === null) options.actionLedger.block(actionId, "CANCELLED", true);
        else options.actionLedger.blockForPrivacyPurgeAbort(actionId, provenance);
        return;
      }
      if (response.kind === "blocked") {
        options.actionLedger.block(actionId, response.code,
          response.code === "CONSENT_EXPIRED_IN_FLIGHT",
          response.retryAfter ?? undefined,
          initial.action_kind === "page" && visitedPageOutcomeCodes.has(response.code));
        return;
      }
      if (initial.action_kind === "robots") {
        const text = response.status === 404 || response.status === 410
          ? ""
          : new TextDecoder("utf-8", { fatal: true }).decode(response.body);
        const policy = parseRobotsPolicy(text);
        if (policy.kind === "blocked") {
          options.actionLedger.block(actionId, policy.code);
          return;
        }
        options.actionLedger.completeRobots(actionId, {
          policyDigest: policy.policyDigest,
          crawlDelayMs: policy.crawlDelayMs,
          policyText: text,
        });
        return;
      }
      if (response.usability === null || response.usability.kind !== "usable") {
        options.actionLedger.block(actionId, "POLICY_BLOCKED", false, undefined, true);
        return;
      }
      options.actionLedger.completePage(actionId, {
        rawBody: response.body,
        extractedText: response.usability.primaryText,
        contentDigest: response.usability.contentDigest,
        responseMetadataDigest: sha256(JSON.stringify({
          status: response.status,
          contentType: response.contentType,
          answerSetDigest: response.answerSetDigest,
          selectedIpv4: response.selectedIpv4,
        })),
        discoveredLinks: response.usability.links,
      });
    } catch (error) {
      const current = options.actionLedger.read(actionId);
      if (!["completed", "blocked", "ambiguous"].includes(current.state)) {
        const provenance = trackedC90PrivacyPurgeAbortFromSignal(signal, actionId);
        if (isAborted() && current.state === "started" && provenance !== null) {
          options.actionLedger.blockForPrivacyPurgeAbort(actionId, provenance);
        } else {
          options.actionLedger.block(actionId,
            error instanceof LiveAcquisitionActionPolicyError
              ? error.code
              : isAborted() ? "CANCELLED" : "POLICY_BLOCKED",
            current.state === "started");
          }
      }
      const terminal = options.actionLedger.read(actionId);
      if (["completed", "blocked", "ambiguous"].includes(terminal.state)) return;
      if (error instanceof LiveAcquisitionActionPolicyError) return;
      if (!isAborted()) throw error;
    }
  }

  const coordinator: ResearchAcquisitionCoordinator = {
    executeAction,
    runTracked(actionId) {
      if (stopping) return;
      if (active.has(actionId)) return;
      const controller = new AbortController();
      const promise = executeAction(actionId, controller.signal).finally(() => {
        active.delete(actionId);
        options.onSettled?.(actionId);
      });
      active.set(actionId, { controller, promise });
      void promise.catch(() => undefined);
    },
    activeCount: () => active.size,
    async stop() {
      stopping = true;
      for (const execution of active.values()) execution.controller.abort();
      await Promise.allSettled([...active.values()].map(({ promise }) => promise));
    },
  };
  return Object.freeze(coordinator);
}

interface UnknownWorkflowRow {
  readonly id: number;
  readonly status: "queued" | "running";
  readonly event_sequence: number;
  readonly lease_token: string | null;
  readonly updated_at: string;
  readonly attempt_id: number | null;
}

function canonicalClock(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("invalid composite research adapter clock");
  }
  return value.toISOString();
}

function supersedeUnknownResearchWorkflows(
  connection: Database.Database,
  clock: () => Date,
): number {
  if (connection.inTransaction) {
    throw new Error("composite research workflow cleanup requires autocommit");
  }
  const rows = connection.prepare(`
    SELECT job.id, job.status, job.event_sequence, job.lease_token, job.updated_at,
      (SELECT attempt.id FROM ai_job_attempts AS attempt
       WHERE attempt.job_id = job.id AND attempt.outcome = 'running'
       ORDER BY attempt.attempt_no DESC LIMIT 1) AS attempt_id
    FROM ai_jobs AS job
    WHERE job.kind = 'resource_research'
      AND job.status IN ('queued', 'running')
      AND NOT (
        (job.workflow_id = ? AND job.workflow_version = ?)
        OR (job.workflow_id = ? AND job.workflow_version = ?)
      )
    ORDER BY job.id
  `).all(
    C90_ALLOWLIST[0].id,
    C90_ALLOWLIST[0].version,
    C81_ALLOWLIST[0].id,
    C81_ALLOWLIST[0].version,
  ) as UnknownWorkflowRow[];
  if (rows.length === 0) return 0;
  const now = canonicalClock(clock);
  connection.exec("BEGIN IMMEDIATE");
  try {
    const insert = connection.prepare(`
      INSERT INTO ai_job_events (
        job_id, sequence_no, event_type, from_status, to_status,
        attempt_id, lease_token, occurred_at
      ) VALUES (?, ?, 'superseded', ?, 'superseded', ?, ?, ?)
    `);
    for (const row of rows) {
      if (
        row.status === "running" &&
        (row.attempt_id === null || row.lease_token === null)
      ) {
        throw new Error("unknown running research workflow has no exact attempt fence");
      }
      const occurredAt = now >= row.updated_at ? now : row.updated_at;
      insert.run(
        row.id,
        row.event_sequence + 1,
        row.status,
        row.status === "running" ? row.attempt_id : null,
        row.status === "running" ? row.lease_token : null,
        occurredAt,
      );
    }
    connection.exec("COMMIT");
    return rows.length;
  } catch (error) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The one physical `resource_research` adapter. Workflow filtering happens in
 * the ledger claim transaction; the adapter never claims a row and dispatches
 * it afterward. C90 execution is registered as tracked background work and thus
 * returns to the common runtime immediately.
 */
export function createCompositeResourceResearchAdapter(
  options: CompositeResourceResearchAdapterOptions,
): AiJobRuntimePhysicalAdapter {
  const c90Enabled = options.c90Enabled ?? true;
  const maxC90AttemptsPerUtcDay = options.maxC90AttemptsPerUtcDay ?? 20;
  if (!Number.isSafeInteger(maxC90AttemptsPerUtcDay) ||
      maxC90AttemptsPerUtcDay < 1 || maxC90AttemptsPerUtcDay > 100) {
    throw new TypeError("C90 daily attempt limit must be between 1 and 100");
  }
  const clock = options.clock ?? (() => new Date());
  const workerId = options.workerId ?? "tabhub-research-runtime";
  const c90Limits = Object.freeze({
    maxConcurrent: 1,
    maxAttemptsPerUtcDay: maxC90AttemptsPerUtcDay,
    maxCostUsdPerUtcDay: null,
  });
  const c81Limits = Object.freeze({
    maxConcurrent: 1,
    maxAttemptsPerUtcDay: 10,
    maxCostUsdPerUtcDay: 2,
  });
  let stopping = false;

  function workflowOrder(): readonly AiJobWorkflowAllowlist[] {
    const rows = options.connection.prepare(`
      SELECT job.workflow_id, job.workflow_version,
        MAX(attempt.id) AS last_attempt_id
      FROM ai_job_attempts AS attempt
      JOIN ai_jobs AS job ON job.id = attempt.job_id
      WHERE job.kind = 'resource_research' AND (
        (job.workflow_id = ? AND job.workflow_version = ?)
        OR (job.workflow_id = ? AND job.workflow_version = ?)
      )
      GROUP BY job.workflow_id, job.workflow_version
    `).all(
      C90_ALLOWLIST[0].id,
      C90_ALLOWLIST[0].version,
      C81_ALLOWLIST[0].id,
      C81_ALLOWLIST[0].version,
    ) as Array<{ workflow_id: string; workflow_version: number; last_attempt_id: number }>;
    const lastAttempt = (allowlist: AiJobWorkflowAllowlist): number =>
      rows.find((row) => row.workflow_id === allowlist[0].id &&
        row.workflow_version === allowlist[0].version)?.last_attempt_id ?? 0;
    return (c90Enabled ? [C90_ALLOWLIST, C81_ALLOWLIST] : [C81_ALLOWLIST]).sort((left, right) =>
      lastAttempt(left) - lastAttempt(right) || left[0].id.localeCompare(right[0].id, "en")
    );
  }

  return Object.freeze({
    kind: "resource_research" as const,
    recoverInterrupted() {
      supersedeUnknownResearchWorkflows(options.connection, clock);
      const c90Recovered = c90Enabled
        ? options.ledger.recoverInterrupted(C90_ALLOWLIST)
        : 0;
      const c81Recovered = options.ledger.recoverInterrupted(C81_ALLOWLIST);
      return c90Recovered + c81Recovered;
    },
    claim(boundary: AiJobClaimBoundary) {
      if (stopping) return undefined;
      supersedeUnknownResearchWorkflows(options.connection, clock);
      for (const allowlist of workflowOrder()) {
        const isC90 = allowlist[0].id === LIVE_ACQUISITION_WORKFLOW.id;
        const claim = options.ledger.claimNext(
          "resource_research",
          workerId,
          isC90 ? c90Limits : c81Limits,
          boundary,
          allowlist,
        );
        if (claim === undefined) continue;
        return {
          id: `resource_research:${claim.id}`,
          execute: isC90
            ? () => { options.c90.runTrackedClaim(claim); }
            : () => options.c81.executeClaim(claim),
        };
      }
      return undefined;
    },
    async stop() {
      stopping = true;
      await Promise.all([options.c90.stop(), options.c81.stop()]);
    },
  });
}
