import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import {
  createAiJobLedger,
  type AiJobExpiredCancellation,
  type AiJobOwnedMutation,
} from "./ai-job-ledger.js";
import {
  digestPrivacyPurgeExecutionTargets,
  executePrivacyPurgePlan,
} from "./live-acquisition-migration.js";
import {
  createLiveAcquisitionActionLedger,
  installLiveAcquisitionPrivacyPurgeAbortFence,
  type LiveAcquisitionOwnedMutation,
} from "./live-acquisition-action-ledger.js";
import {
  derivePrivacyPurgeBudgetCarryoverRows,
  freezePrivacyPurgeBudgetCarryover,
  type PrivacyPurgeBudgetCarryoverRow,
} from "./privacy-purge-budget-carryover.js";
import {
  compilePrivacyPurgeTargetCandidatesV26,
  type PrivacyPurgeIntentTarget,
} from "./privacy-purge-fence-spec.js";
import {
  TrackedC90AbortError,
  type TrackedC90AbortRequest,
  type TrackedC90AbortResult,
  type TrackedC90ClaimExecutor,
} from "./research-acquisition-coordinator.js";

type Row = Readonly<Record<string, unknown>>;

interface CapabilityLease {
  readonly token: symbol;
  readonly kind:
    | "publication"
    | "reconcile"
    | "ready"
    | "repair"
    | "migration"
    | "link"
    | "terminal";
  readonly expected: Map<string, Set<string>>;
  readonly attestations: Set<string>;
}

interface CapabilityState {
  activeLease: CapabilityLease | null;
  executorInvocation: CapabilityLease | null;
}

const states = new WeakMap<Database.Database, CapabilityState>();

export interface PrivacyPurgeWaitingPublication {
  readonly intentKey: string;
  readonly idempotencyKeyHash: string;
  readonly requestFingerprint: string;
  readonly target: PrivacyPurgeIntentTarget;
}

interface TimestampedPrivacyPurgeWaitingPublication
  extends PrivacyPurgeWaitingPublication {
  readonly createdAt: string;
}

export interface PublishedPrivacyPurgeIntent {
  readonly intentKey: string;
  readonly status: "waiting";
  readonly runTargetCount: number;
  readonly actionWaitCount: number;
  readonly jobWaitCount: number;
  readonly waitSnapshotDigest: string;
}

export interface ReadyPrivacyPurgeIntent {
  readonly intentKey: string;
  readonly status: "ready";
  readonly executionTargetCount: number;
  readonly executionPlanDigest: string;
}

export interface PrivacyPurgeReadyCommandIdentity {
  readonly idempotencyKeyHash: string;
  readonly requestFingerprint: string;
  readonly targetKind: "run" | "logical_page" | "resource_history";
  readonly subjectGenerationId: number | null;
  readonly historyEpochId: number | null;
}

interface TimestampedPrivacyPurgeReadyCommandIdentity
  extends PrivacyPurgeReadyCommandIdentity {
  readonly createdAt: string;
}

export interface PrivacyPurgeIntentStoreOptions {
  readonly clock?: () => Date;
  readonly finalSettlementVerifier?: PrivacyPurgeFinalSettlementVerifier;
  readonly trackedC90Executor?: Pick<TrackedC90ClaimExecutor, "abortAndWait">;
  readonly testOnlyFailActionAbortPhaseBOnce?: boolean;
  readonly testOnlyBeforeActionAbortPhaseA?: () => void;
}

export interface PrivacyPurgeStartedActionAbortResult {
  readonly intentKey: string;
  readonly ordinal: number;
  readonly status: "terminalized" | "pending";
  readonly outcome?: "acknowledged" | "response_wins" | "prior_epoch_ambiguous" |
    "prior_epoch_recovery";
}

export interface PrivacyPurgeStartedActionAbortDrainResult {
  readonly intentKey: string;
  readonly processed: number;
  readonly remaining: number;
  readonly results: readonly PrivacyPurgeStartedActionAbortResult[];
  readonly ordinal?: number;
  readonly status?: "terminalized" | "pending";
  readonly outcome?: "acknowledged" | "response_wins" | "prior_epoch_ambiguous" |
    "prior_epoch_recovery";
}

export interface PrivacyPurgeFinalSettlementRequest {
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly requestBoundAt: string;
  readonly settlementDeadlineAt: string;
}

export type PrivacyPurgeFinalSettlementResult =
  | Readonly<{
      status: "final_zero";
      verifierVersion: "provider_final_zero:v1";
      providerFinalAt: string;
    }>
  | Readonly<{
      status: "final_positive";
      verifierVersion: "provider_final_usage:v1";
      providerFinalAt: string;
      finalCostUsd: number;
    }>
  | Readonly<{ status: "unknown" }>;

export interface PrivacyPurgeFinalSettlementVerifier {
  verifyFinalProviderUsage(
    request: PrivacyPurgeFinalSettlementRequest,
  ): Promise<PrivacyPurgeFinalSettlementResult>;
}

export interface RepairedPrivacyPurgeFinalSettlements {
  readonly intentKey: string;
  readonly inspectedJobs: number;
  readonly recordedEvidence: number;
  readonly status: "failed_hold" | "waiting";
  readonly transitioned: boolean;
  readonly settlementProofGeneration: number;
}

export interface PrivacyPurgeWaitingReconcileLimit {
  readonly maxJobs: number;
}

export interface ReconciledPrivacyPurgeIntent {
  readonly intentKey: string;
  readonly status: "waiting" | "failed_hold";
  readonly holdCode: "PROVIDER_USAGE_UNKNOWN" | null;
  readonly inspectedJobs: number;
  readonly transitioned: boolean;
}

export interface ReconciledPrivacyPurgeJobWaits {
  readonly intentKey: string;
  readonly processed: number;
  readonly remaining: number;
}

export interface TerminalizedPrivacyPurgeJobWaits {
  readonly intentKey: string;
  readonly terminalized: number;
  readonly adopted: number;
  readonly remaining: number;
}

export type PrivacyPurgeIntentStoreErrorCode =
  | "PURGE_CLOCK_INVALID"
  | "PURGE_CLOCK_REGRESSION";

export class PrivacyPurgeIntentStoreError extends Error {
  readonly code: PrivacyPurgeIntentStoreErrorCode;

  constructor(code: PrivacyPurgeIntentStoreErrorCode) {
    super(code);
    this.name = "PrivacyPurgeIntentStoreError";
    this.code = code;
  }
}

interface Legacy25TerminalAdoption {
  readonly command_id: number;
  readonly idempotency_key_hash: string;
  readonly request_fingerprint: string;
  readonly target_kind: "run" | "logical_page" | "resource_history";
  readonly subject_generation_id: number | null;
  readonly history_epoch_id: number | null;
  readonly deletion_target_count: number;
  readonly deletion_plan_digest: string;
  readonly status: "completed" | "failed";
  readonly created_at: string;
  readonly safe_counts_json: string;
  readonly result_digest: string;
  readonly completed_at: string;
  readonly tombstone_digest: string | null;
  readonly current_utc_date: string;
  readonly wait_snapshot_digest: string;
  readonly intent_key: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKey(parts: readonly unknown[]): string {
  return parts.map((part) => {
    if (part === null) return "null:";
    if (typeof part === "number") return `number:${part}`;
    if (typeof part === "string") return `string:${part}`;
    return `${typeof part}:${String(part)}`;
  }).join("\u0000");
}

function stateFor(connection: Database.Database): CapabilityState {
  const state = states.get(connection);
  if (state === undefined) {
    throw new Error("Schema26 privacy purge capabilities are not installed");
  }
  return state;
}

function consume(
  connection: Database.Database,
  bucket: string,
  parts: readonly unknown[],
): number {
  if (!connection.inTransaction) return 0;
  const lease = stateFor(connection).activeLease ??
    stateFor(connection).executorInvocation;
  if (lease === null) return 0;
  const entries = lease.expected.get(bucket);
  if (entries === undefined || !entries.delete(exactKey(parts))) return 0;
  return 1;
}

function consumeAny(
  connection: Database.Database,
  buckets: readonly string[],
  parts: readonly unknown[],
): number {
  for (const bucket of buckets) {
    if (consume(connection, bucket, parts) === 1) return 1;
  }
  return 0;
}

function consumeExecutorMutation(
  connection: Database.Database,
  parts: readonly unknown[],
): number {
  if (consumeAny(connection, ["executor", "executor_root"], parts) === 1) {
    return 1;
  }
  if (parts.length !== 5) return 0;
  const [intentKey, commandId, tableName, pkV1, operation] = parts;
  if (
    operation !== "INSERT" ||
    (tableName !== "privacy_subject_generations" &&
      tableName !== "research_history_epochs") ||
    typeof pkV1 !== "string" ||
    !/^pk:v1\|1\|i:\d+:-?\d+$/.test(pkV1)
  ) {
    return 0;
  }
  // The frozen executor allocates the row id (and logical-page token) inside
  // its own BEGIN IMMEDIATE, so those values cannot be precomputed safely.
  // This is a separate one-shot semantic capability, restricted to the exact
  // committed intent/command/table while the synchronous executor is active.
  return consume(connection, "lifecycle_successor", [
    intentKey,
    commandId,
    tableName,
    operation,
  ]);
}

function attest(
  connection: Database.Database,
  name: string,
  parts: readonly unknown[],
  requiredBuckets: readonly string[],
): number {
  if (!connection.inTransaction) return 0;
  const lease = stateFor(connection).activeLease;
  if (lease === null) return 0;
  if (requiredBuckets.some((bucket) => (lease.expected.get(bucket)?.size ?? 0) !== 0)) {
    return 0;
  }
  const candidate = exactKey([name, ...parts]);
  if (!lease.attestations.delete(candidate)) return 0;
  return 1;
}

function attestExecutor(
  connection: Database.Database,
  name: string,
  parts: readonly unknown[],
  requiredBuckets: readonly string[],
): number {
  if (!connection.inTransaction) return 0;
  const lease = stateFor(connection).executorInvocation;
  if (lease === null || lease.kind !== "terminal") return 0;
  if (requiredBuckets.some((bucket) => (lease.expected.get(bucket)?.size ?? 0) !== 0)) {
    return 0;
  }
  const candidate = exactKey([name, ...parts]);
  if (!lease.attestations.delete(candidate)) return 0;
  return 1;
}

function checkedSet(entries: readonly (readonly unknown[])[]): Set<string> {
  const keys = entries.map(exactKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Privacy purge capability lease contains duplicate entries");
  }
  return new Set(keys);
}

function addExpected(
  connection: Database.Database,
  bucket: string,
  parts: readonly unknown[],
): void {
  const lease = stateFor(connection).activeLease;
  if (!connection.inTransaction || lease === null || lease.kind !== "terminal") {
    throw new Error("Privacy purge drain mutation requires an active terminal scope");
  }
  const entries = lease.expected.get(bucket) ?? new Set<string>();
  const key = exactKey(parts);
  if (entries.has(key)) throw new Error("Privacy purge drain capability is duplicated");
  entries.add(key);
  lease.expected.set(bucket, entries);
}

function createLease(
  kind: CapabilityLease["kind"],
  buckets: Readonly<Record<string, readonly (readonly unknown[])[]>>,
  attestations: readonly (readonly unknown[])[],
): CapabilityLease {
  return {
    token: Symbol(`privacy-purge-${kind}`),
    kind,
    expected: new Map(Object.entries(buckets).map(([name, entries]) => [
      name,
      checkedSet(entries),
    ])),
    attestations: checkedSet(attestations),
  };
}

function assertSchema26ConnectionSafety(connection: Database.Database): void {
  const foreignKeys = connection.prepare(`
    SELECT foreign_keys AS enabled FROM pragma_foreign_keys
  `).get() as { enabled: number } | undefined;
  const recursiveTriggers = connection.prepare(`
    SELECT recursive_triggers AS enabled FROM pragma_recursive_triggers
  `).get() as { enabled: number } | undefined;
  if (foreignKeys?.enabled !== 1 || recursiveTriggers?.enabled !== 1) {
    throw new Error(
      "Schema26 privacy purge requires foreign_keys=ON and recursive_triggers=ON",
    );
  }
}

function runOwnedTransaction<T>(
  connection: Database.Database,
  buildLease: () => CapabilityLease,
  operation: () => T,
): T {
  if (connection.inTransaction) {
    throw new Error("Privacy purge scoped operation requires autocommit mode");
  }
  assertSchema26ConnectionSafety(connection);
  const state = stateFor(connection);
  if (state.activeLease !== null || state.executorInvocation !== null) {
    throw new Error("Another privacy purge capability scope is active");
  }
  connection.exec("BEGIN IMMEDIATE");
  let lease: CapabilityLease | null = null;
  try {
    assertSchema26ConnectionSafety(connection);
    lease = buildLease();
    state.activeLease = lease;
    const result = operation();
    if (state.activeLease !== lease || !connection.inTransaction) {
      throw new Error("Privacy purge scope crossed its transaction boundary");
    }
    const unconsumed = [...lease.expected.values()].some((entries) =>
      entries.size !== 0
    ) || lease.attestations.size !== 0;
    if (unconsumed) {
      throw new Error("Privacy purge scoped operation left capability unused");
    }
    assertSchema26ConnectionSafety(connection);
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    if (lease !== null && state.activeLease === lease) state.activeLease = null;
  }
}

function registerFunctions(connection: Database.Database): void {
  const register = (
    name: string,
    implementation: (...parts: unknown[]) => number,
  ): void => {
    connection.function(name, { varargs: true }, implementation);
  };
  register("tabhub_purge26_run_row_v1", (...parts: unknown[]) =>
    consume(connection, "run", parts));
  register("tabhub_purge26_action_row_v1", (...parts: unknown[]) =>
    consume(connection, "action", parts));
  register("tabhub_purge26_job_row_v1", (...parts: unknown[]) =>
    consume(connection, "job", parts));
  register("tabhub_purge26_execution_row_v1", (...parts: unknown[]) =>
    consume(connection, "execution", parts));
  register(
    "tabhub_purge26_action_terminal_v1",
    (...parts: unknown[]) => consume(connection, "action_terminal", parts),
  );
  register(
    "tabhub_purge26_action_abort_request_v1",
    (...parts: unknown[]) => consume(connection, "action_abort_request", parts),
  );
  register(
    "tabhub_purge26_action_abort_receipt_v1",
    (...parts: unknown[]) => consume(connection, "action_abort_receipt", parts),
  );
  register(
    "tabhub_purge26_job_terminal_v1",
    (...parts: unknown[]) => consume(connection, "job_terminal", parts),
  );
  register(
    "tabhub_purge26_execution_cleanup_v1",
    (...parts: unknown[]) => consume(connection, "execution_cleanup", parts),
  );
  register("tabhub_purge26_receipt_row_v1", (...parts: unknown[]) =>
    consume(connection, "receipt", parts));
  register("tabhub_purge26_catalog_row_v1", (...parts: unknown[]) =>
    consume(connection, "catalog", parts));
  register(
    "tabhub_purge26_publication_attest_v1",
    (...parts: unknown[]) => attest(
      connection,
      "publication",
      parts,
      ["run", "action", "job", "transition"],
    ),
  );
  register(
    "tabhub_purge26_ready_attest_v1",
    (...parts: unknown[]) => attest(
      connection,
      "ready",
      parts,
      ["execution", "carryover_insert"],
    ),
  );
  register(
    "tabhub_purge26_terminal_attest_v1",
    (...parts: unknown[]) => attestExecutor(
      connection,
      "terminal",
      parts,
      [
        "executor", "executor_root", "receipt", "carryover_activation",
        "execution_cleanup", "lifecycle_successor",
        "lifecycle_successor_shape", "transition",
      ],
    ),
  );
  register(
    "tabhub_purge26_transition_v1",
    (...parts: unknown[]) => consume(connection, "transition", parts),
  );
  register(
    "tabhub_purge26_command_link_v1",
    (...parts: unknown[]) => consume(connection, "command_link", parts),
  );
  register(
    "tabhub_purge26_drain_v1",
    (...parts: unknown[]) => consume(connection, "drain", parts),
  );
  register(
    "tabhub_purge26_drain_insert_v1",
    (...parts: unknown[]) => consume(connection, "drain_insert", parts),
  );
  register(
    "tabhub_purge26_executor_v1",
    (...parts: unknown[]) => consumeExecutorMutation(connection, parts),
  );
  register(
    "tabhub_purge26_carryover_insert_v1",
    (...parts: unknown[]) => consume(connection, "carryover_insert", parts),
  );
  register(
    "tabhub_purge26_carryover_activate_v1",
    (...parts: unknown[]) => consume(connection, "carryover_activation", parts),
  );
  register(
    "tabhub_purge26_settlement_final_v1",
    (...parts: unknown[]) => consume(connection, "settlement_final", parts),
  );
  register(
    "tabhub_purge26_lifecycle_successor_v1",
    (...parts: unknown[]) => consume(
      connection,
      "lifecycle_successor_shape",
      parts,
    ),
  );
}

export function installPrivacyPurgeIntentCapabilities(
  connection: Database.Database,
): void {
  installLiveAcquisitionPrivacyPurgeAbortFence(connection);
  const existing = states.get(connection);
  if (existing !== undefined &&
    (existing.activeLease !== null || existing.executorInvocation !== null)) {
    throw new Error("Cannot reinstall privacy purge capabilities during a scope");
  }
  assertSchema26ConnectionSafety(connection);
  states.set(connection, { activeLease: null, executorInvocation: null });
  registerFunctions(connection);
}

function legacy25IntentKey(row: Omit<Legacy25TerminalAdoption,
  "intent_key" | "wait_snapshot_digest">): string {
  return sha256(`tabhub:privacy-purge:legacy25-intent:v1\0${JSON.stringify({
    purgeCommandId: row.command_id,
    idempotencyKeyHash: row.idempotency_key_hash,
    requestFingerprint: row.request_fingerprint,
    targetKind: row.target_kind,
    subjectGenerationId: row.subject_generation_id,
    historyEpochId: row.history_epoch_id,
    executionTargetCount: row.deletion_target_count,
    executionPlanDigest: row.deletion_plan_digest,
    outcome: row.status,
    createdAt: row.created_at,
    safeCountsJson: row.safe_counts_json,
    resultDigest: row.result_digest,
    completedAt: row.completed_at,
    tombstoneDigest: row.tombstone_digest,
  })}`);
}

function legacy25CarryoverDigest(
  intentKey: string,
  utcDate: string,
  budgetClass: "c90_coordinator" | "provider",
  workflowId: string,
  coordinatorStarts: number,
  providerAttempts: number,
  chargedCostNanos: number,
  completedAt: string,
): string {
  return sha256(
    `tabhub:privacy-purge:legacy25-day-block:v1\0${JSON.stringify({
      intentKey,
      utcDate,
      budgetClass,
      jobKind: "resource_research",
      workflowId,
      workflowVersion: 1,
      coordinatorStarts,
      providerAttempts,
      chargedCostNanos,
      activeExposureNanos: 0,
      legacy25DayBlock: 1,
      state: "active",
      frozenAt: completedAt,
      activatedAt: completedAt,
    })}`,
  );
}

interface CarryoverInsertRow {
  readonly intentKey: string;
  readonly utcDate: string;
  readonly budgetClass: "c90_coordinator" | "provider";
  readonly jobKind: "resource_research";
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly coordinatorStarts: number;
  readonly providerAttempts: number;
  readonly chargedCostNanos: number;
  readonly activeExposureNanos: number;
  readonly legacy25DayBlock: 0 | 1;
  readonly state: "frozen" | "active";
  readonly payloadDigest: string;
  readonly frozenAt: string;
  readonly activatedAt: string | null;
}

function carryoverInsertParts(row: CarryoverInsertRow): readonly unknown[] {
  return [
    row.intentKey, row.utcDate, row.budgetClass, row.jobKind,
    row.workflowId, row.workflowVersion, row.coordinatorStarts,
    row.providerAttempts, row.chargedCostNanos, row.activeExposureNanos,
    row.legacy25DayBlock, row.state, row.payloadDigest, row.frozenAt,
    row.activatedAt,
  ];
}

function privacyPurgeCarryoverManifest(
  connection: Database.Database,
  intentKey: string,
): { readonly count: number; readonly digest: string } {
  return connection.prepare(`
    SELECT COUNT(*) AS count, tabhub_sha256_v1(COALESCE((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'intentKey', intent_key, 'utcDate', utc_date,
          'budgetClass', budget_class, 'jobKind', job_kind,
          'workflowId', workflow_id, 'workflowVersion', workflow_version,
          'coordinatorStarts', coordinator_starts,
          'providerAttempts', provider_attempts,
          'chargedCostNanos', charged_cost_nanos,
          'activeExposureNanos', active_exposure_nanos,
          'legacy25DayBlock', legacy25_day_block,
          'payloadDigest', payload_digest, 'frozenAt', frozen_at
        ) AS row_json
        FROM privacy_purge_budget_carryover_days
        WHERE intent_key = @intentKey AND state = 'frozen'
        ORDER BY utc_date, budget_class, job_kind, workflow_id, workflow_version
      )
    ), '[]')) AS digest
    FROM privacy_purge_budget_carryover_days
    WHERE intent_key = @intentKey AND state = 'frozen'
  `).get({ intentKey }) as { count: number; digest: string };
}

function privacyPurgeCarryoverManifestFromRows(
  rows: readonly PrivacyPurgeBudgetCarryoverRow[],
): { readonly count: number; readonly digest: string } {
  const ordered = [...rows].sort((left, right) =>
    [left.utcDate, left.budgetClass, left.jobKind, left.workflowId,
      left.workflowVersion].join("\0").localeCompare(
      [right.utcDate, right.budgetClass, right.jobKind, right.workflowId,
        right.workflowVersion].join("\0"),
    )
  );
  return {
    count: ordered.length,
    digest: sha256(JSON.stringify(ordered.map((row) => ({
      intentKey: row.intentKey,
      utcDate: row.utcDate,
      budgetClass: row.budgetClass,
      jobKind: row.jobKind,
      workflowId: row.workflowId,
      workflowVersion: row.workflowVersion,
      coordinatorStarts: row.coordinatorStarts,
      providerAttempts: row.providerAttempts,
      chargedCostNanos: row.chargedCostNanos,
      activeExposureNanos: row.activeExposureNanos,
      legacy25DayBlock: row.legacy25DayBlock,
      payloadDigest: row.payloadDigest,
      frozenAt: row.frozenAt,
    })))),
  };
}

function privacyPurgeWaitTerminalDigest(
  connection: Database.Database,
  intentKey: string,
): string {
  return String(connection.prepare(`
    SELECT tabhub_sha256_v1(json_object(
      'actions', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'actionId', action_id, 'state', terminal_state,
            'sequenceNo', terminal_sequence_no,
            'eventDigest', terminal_event_digest,
            'proofDigest', terminal_proof_digest, 'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_action_waits
          WHERE intent_key = @intentKey ORDER BY ordinal
        )
      ), '[]'),
      'jobs', COALESCE((
        SELECT json_group_array(json(proof_json)) FROM (
          SELECT json_object(
            'jobId', job_id, 'status', terminal_status,
            'eventSequence', terminal_event_sequence,
            'attemptOutcome', terminal_attempt_outcome,
            'usageDigest', terminal_usage_digest,
            'proofDigest', terminal_proof_digest,
            'reservationState', terminal_reservation_state,
            'terminalAt', terminal_at
          ) AS proof_json
          FROM privacy_purge_intent_job_waits
          WHERE intent_key = @intentKey ORDER BY ordinal
        )
      ), '[]')
    ))
  `).pluck().get({ intentKey }));
}

function privacyPurgeTerminalEvidenceDigest(
  connection: Database.Database,
  intentKey: string,
  settlementProofGeneration: number,
  settlementEvidenceDigest: string | null,
): string {
  const waitTerminalDigest = privacyPurgeWaitTerminalDigest(connection, intentKey);
  return String(connection.prepare(`
    SELECT tabhub_sha256_v1(json_object(
      'waitTerminalDigest', @waitTerminalDigest,
      'settlementProofGeneration', CAST(@settlementProofGeneration AS INTEGER),
      'settlementEvidenceDigest', @settlementEvidenceDigest
    ))
  `).pluck().get({
    waitTerminalDigest,
    settlementProofGeneration,
    settlementEvidenceDigest,
  }));
}

function privacyPurgeResultDigestV3(
  connection: Database.Database,
  intentKey: string,
  planDigest: string,
  carryoverManifestCount: number,
  carryoverManifestDigest: string,
  terminalEvidenceDigest: string,
): string {
  return String(connection.prepare(`
    SELECT tabhub_sha256_v1(json_object(
      'version', 'tabhub:privacy-purge:result:v3',
      'intentKey', @intentKey, 'planDigest', @planDigest,
      'actionQuiescenceDigest', (
        SELECT action_quiescence_digest FROM privacy_purge_intents
        WHERE intent_key = @intentKey
      ),
      'carryoverManifestCount', CAST(@carryoverManifestCount AS INTEGER),
      'carryoverManifestDigest', @carryoverManifestDigest,
      'terminalEvidenceDigest', @terminalEvidenceDigest
    ))
  `).pluck().get({
    intentKey,
    planDigest,
    carryoverManifestCount,
    carryoverManifestDigest,
    terminalEvidenceDigest,
  }));
}

function privacyPurgeSchema26TransitionDigest(
  actionQuiescenceDigest: string,
  evidenceDigest: string,
): string {
  return rowDigest({ actionQuiescenceDigest, evidenceDigest });
}

function assertPrivacyPurgeActionQuiescence(
  connection: Database.Database,
  intentKey: string,
): string {
  const intent = connection.prepare(`
    SELECT action_wait_count, action_wait_digest, action_quiescence_digest
    FROM privacy_purge_intents
    WHERE intent_key = ? AND origin = 'schema26'
  `).get(intentKey) as {
    action_wait_count: number;
    action_wait_digest: string;
    action_quiescence_digest: string;
  } | undefined;
  if (intent === undefined) throw new Error("PURGE_INVARIANT_VIOLATION");
  const waits = connection.prepare(`
    SELECT wait.ordinal, wait.action_id, wait.consent_id, wait.action_kind,
      wait.state, wait.sequence_no, wait.runtime_epoch, wait.action_key_digest,
      wait.resolution_start_sequence_no, wait.resolution_start_event_digest,
      wait.resolution_started_at, wait.resolution_deadline_at,
      wait.deadline_at, wait.row_digest, wait.quiescence_snapshot_digest,
      event.id AS event_id, event.action_id AS event_action_id,
      event.sequence_no AS event_sequence_no, event.from_state AS event_from_state,
      event.to_state AS event_to_state, event.outcome_code AS event_outcome_code,
      event.safe_details_json AS event_safe_details_json,
      event.occurred_at AS event_occurred_at
    FROM privacy_purge_intent_action_waits AS wait
    LEFT JOIN live_acquisition_action_events AS event
      ON event.action_id = wait.action_id
      AND event.sequence_no = wait.resolution_start_sequence_no
    WHERE wait.intent_key = ? ORDER BY wait.ordinal
  `).all(intentKey) as Array<Row>;
  const rowDigests: string[] = [];
  const digests = waits.map((wait, ordinal) => {
    if (wait.ordinal !== ordinal) throw new Error("PURGE_INVARIANT_VIOLATION");
    const expectedRowDigest = rowDigest({
      intentKey,
      ordinal: wait.ordinal,
      actionId: wait.action_id,
      consentId: wait.consent_id,
      actionKind: wait.action_kind,
      state: wait.state,
      sequenceNo: wait.sequence_no,
      runtimeEpoch: wait.runtime_epoch,
      actionKeyDigest: wait.action_key_digest,
      deadlineAt: wait.deadline_at,
    });
    if (expectedRowDigest !== wait.row_digest) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    rowDigests.push(expectedRowDigest);
    const hasResolutionStart = wait.state === "resolution_started";
    if (hasResolutionStart) {
      const exactDeadline = typeof wait.resolution_started_at === "string"
        ? new Date(Date.parse(wait.resolution_started_at) + 3_000).toISOString()
        : null;
      const eventDigest = rowDigest({
        id: wait.event_id,
        actionId: wait.event_action_id,
        sequenceNo: wait.event_sequence_no,
        fromState: wait.event_from_state,
        toState: wait.event_to_state,
        outcomeCode: wait.event_outcome_code,
        safeDetailsJson: wait.event_safe_details_json,
        occurredAt: wait.event_occurred_at,
      });
      if (wait.resolution_start_sequence_no !== wait.sequence_no ||
          wait.event_action_id !== wait.action_id ||
          wait.event_sequence_no !== wait.resolution_start_sequence_no ||
          wait.event_from_state !== "planned" ||
          wait.event_to_state !== "resolution_started" ||
          wait.event_occurred_at !== wait.resolution_started_at ||
          eventDigest !== wait.resolution_start_event_digest ||
          exactDeadline !== wait.resolution_deadline_at) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
    } else if (wait.resolution_start_sequence_no !== null ||
        wait.resolution_start_event_digest !== null ||
        wait.resolution_started_at !== null || wait.resolution_deadline_at !== null) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    const quiescenceDigest = rowDigest({
      intentKey,
      ordinal: wait.ordinal,
      rowDigest: wait.row_digest,
      resolutionStartSequenceNo: wait.resolution_start_sequence_no,
      resolutionStartEventDigest: wait.resolution_start_event_digest,
      resolutionStartedAt: wait.resolution_started_at,
      resolutionDeadlineAt: wait.resolution_deadline_at,
    });
    if (quiescenceDigest !== wait.quiescence_snapshot_digest) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    return quiescenceDigest;
  });
  if (waits.length !== intent.action_wait_count ||
      sha256(JSON.stringify(rowDigests)) !== intent.action_wait_digest) {
    throw new Error("PURGE_INVARIANT_VIOLATION");
  }
  const aggregate = sha256(JSON.stringify(digests));
  if (aggregate !== intent.action_quiescence_digest) {
    throw new Error("PURGE_INVARIANT_VIOLATION");
  }
  return aggregate;
}

function legacy25CarryoverRows(
  row: Legacy25TerminalAdoption,
): readonly CarryoverInsertRow[] {
  if (row.status !== "completed" ||
      row.completed_at.slice(0, 10) !== row.current_utc_date) {
    return [];
  }
  const scopes = [
    {
      budgetClass: "c90_coordinator" as const,
      workflowId: "research_acquisition:c90:v1",
      coordinatorStarts: 100,
      providerAttempts: 0,
      chargedCostNanos: 0,
    },
    {
      budgetClass: "provider" as const,
      workflowId: "research_workflow:c81:v1",
      coordinatorStarts: 0,
      providerAttempts: 10,
      chargedCostNanos: 2_000_000_000,
    },
  ];
  return scopes.map((scope) => ({
    intentKey: row.intent_key,
    utcDate: row.current_utc_date,
    ...scope,
    jobKind: "resource_research" as const,
    workflowVersion: 1,
    activeExposureNanos: 0,
    legacy25DayBlock: 1 as const,
    state: "active" as const,
    payloadDigest: legacy25CarryoverDigest(
      row.intent_key,
      row.current_utc_date,
      scope.budgetClass,
      scope.workflowId,
      scope.coordinatorStarts,
      scope.providerAttempts,
      scope.chargedCostNanos,
      row.completed_at,
    ),
    frozenAt: row.completed_at,
    activatedAt: row.completed_at,
  }));
}

/**
 * Adopt terminal schema-25 purge proofs into the schema-26 intent ledger.
 * Every value is derived inside one owned BEGIN IMMEDIATE transaction; callers
 * provide neither identities nor accounting quantities. Replays find no
 * unadopted terminal proofs and therefore commit as a deterministic no-op.
 */
export function adoptLegacy25PrivacyPurgeTerminals(
  connection: Database.Database,
): number {
  let adoptions: Legacy25TerminalAdoption[] = [];
  return runOwnedTransaction(
    connection,
    () => {
      const migrationNow = canonicalTimestamp(
        connection.prepare(`SELECT tabhub_migration_now()`).pluck().get(),
        "legacy25 privacy purge migration clock",
      );
      const currentUtcDate = migrationNow.slice(0, 10);
      const sourceRows = connection.prepare(`
        SELECT command.id AS command_id,
          command.idempotency_key_hash, command.request_fingerprint,
          command.target_kind, command.subject_generation_id,
          command.history_epoch_id, command.deletion_target_count,
          command.deletion_plan_digest, command.status, command.created_at,
          result.safe_counts_json, result.result_digest, result.completed_at,
          CASE WHEN command.status = 'completed' THEN (
            SELECT tombstone.tombstone_digest
            FROM privacy_subject_tombstones AS tombstone
            WHERE tombstone.purge_command_id = command.id
            ORDER BY tombstone.id LIMIT 1
          ) ELSE NULL END AS tombstone_digest,
          @currentUtcDate AS current_utc_date
        FROM privacy_purge_commands AS command
        JOIN privacy_purge_results AS result ON result.command_id = command.id
        WHERE command.status IN ('completed', 'failed')
          AND result.outcome = command.status
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intents AS intent
            WHERE intent.purge_command_id = command.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_authorities AS authority
            WHERE authority.command_id = command.id
          )
          AND (
            (command.status = 'failed' AND NOT EXISTS (
              SELECT 1 FROM privacy_subject_tombstones AS tombstone
              WHERE tombstone.purge_command_id = command.id
            )) OR
            (command.status = 'completed' AND EXISTS (
              SELECT 1 FROM privacy_subject_tombstones AS tombstone
              WHERE tombstone.purge_command_id = command.id
            ))
          )
        ORDER BY command.id
      `).all({ currentUtcDate }) as Array<Omit<Legacy25TerminalAdoption,
        "intent_key" | "wait_snapshot_digest">>;
      if (sourceRows.some((row) =>
        row.completed_at.slice(0, 10) > currentUtcDate
      )) {
        throw new Error(
          "Legacy25 privacy purge terminal proof is future-dated",
        );
      }
      adoptions = sourceRows.map((row) => {
        const intentKey = legacy25IntentKey(row);
        const waitSnapshotDigest = String(connection.prepare(`
          SELECT tabhub_sha256_v1(json_object(
            'origin', 'legacy25', 'purgeCommandId', command.id,
            'idempotencyKeyHash', command.idempotency_key_hash,
            'requestFingerprint', command.request_fingerprint,
            'targetKind', command.target_kind,
            'subjectGenerationId', command.subject_generation_id,
            'historyEpochId', command.history_epoch_id,
            'executionTargetCount', command.deletion_target_count,
            'executionPlanDigest', command.deletion_plan_digest,
            'outcome', command.status, 'resultDigest', result.result_digest,
            'createdAt', command.created_at, 'completedAt', result.completed_at
          ))
          FROM privacy_purge_commands AS command
          JOIN privacy_purge_results AS result ON result.command_id = command.id
          WHERE command.id = ?
        `).pluck().get(row.command_id));
        return {
          ...row,
          intent_key: intentKey,
          wait_snapshot_digest: waitSnapshotDigest,
        };
      });
      return createLease("migration", {
        transition: adoptions.map((row) => [
          row.intent_key, "", row.status, row.wait_snapshot_digest,
        ]),
        receipt: adoptions.map((row) => [
          row.intent_key, row.status, "legacy25", row.command_id,
          row.safe_counts_json, row.deletion_target_count,
          row.deletion_plan_digest, row.result_digest,
          row.wait_snapshot_digest, row.completed_at,
        ]),
        carryover_insert: adoptions.flatMap((row) =>
          legacy25CarryoverRows(row).map(carryoverInsertParts)
        ),
      }, []);
    },
    () => {
      const emptyDigest = sha256("[]");
      const insertIntent = connection.prepare(`
        INSERT INTO privacy_purge_intents (
          intent_key, origin, idempotency_key_hash, request_fingerprint,
          target_kind, subject_generation_id, history_epoch_id,
          logical_page_id_snapshot, resource_id_snapshot,
          root_generation_token, history_epoch_no_snapshot,
          run_target_count, run_target_digest,
          action_wait_count, action_wait_digest, action_quiescence_digest,
          job_wait_count, job_wait_digest, wait_snapshot_digest,
          execution_target_count, execution_plan_digest, purge_command_id,
          tombstone_digest, result_digest, status, hold_code,
          created_at, updated_at
        ) VALUES (
          @intent_key, 'legacy25', @idempotency_key_hash, @request_fingerprint,
          @target_kind, @subject_generation_id, @history_epoch_id,
          NULL, NULL, NULL, NULL,
          0, @emptyDigest, 0, @emptyDigest, @emptyDigest, 0, @emptyDigest,
          @wait_snapshot_digest, @deletion_target_count,
          @deletion_plan_digest, @command_id, @tombstone_digest,
          @result_digest, @status, NULL, @created_at, @completed_at
        )
      `);
      const insertReceipt = connection.prepare(`
        INSERT INTO privacy_purge_intent_receipts (
          intent_key, outcome, origin, purge_command_id, safe_counts_json,
          execution_target_count, execution_plan_digest, result_digest,
          wait_terminal_digest, completed_at
        ) VALUES (
          @intent_key, @status, 'legacy25', @command_id, @safe_counts_json,
          @deletion_target_count, @deletion_plan_digest, @result_digest,
          @wait_snapshot_digest, @completed_at
        )
      `);
      const insertCarryover = connection.prepare(`
        INSERT INTO privacy_purge_budget_carryover_days (
          intent_key, utc_date, budget_class,
          job_kind, workflow_id, workflow_version, coordinator_starts,
          provider_attempts, charged_cost_nanos, active_exposure_nanos,
          legacy25_day_block, state, payload_digest, frozen_at, activated_at
        ) VALUES (
          @intentKey, @utcDate, @budgetClass,
          'resource_research', @workflowId, 1, @coordinatorStarts,
          @providerAttempts, @chargedCostNanos, 0,
          1, 'active', @payloadDigest, @completedAt, @completedAt
        )
      `);
      for (const row of adoptions) {
        const insertedIntent = insertIntent.run({ ...row, emptyDigest });
        if (insertedIntent.changes !== 1) {
          throw new Error("Legacy25 privacy purge intent adoption failed");
        }
        for (const carryover of legacy25CarryoverRows(row)) {
          insertCarryover.run({
            ...carryover,
            completedAt: row.completed_at,
          });
        }
        if (insertReceipt.run(row).changes !== 1) {
          throw new Error("Legacy25 privacy purge receipt adoption failed");
        }
      }
      return adoptions.length;
    },
  );
}

function rowDigest(value: Row): string {
  return sha256(JSON.stringify(value));
}

function exactPlainData(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") ||
    [...keys].sort().join("\0") !== [...expectedKeys].sort().join("\0")) {
    throw new TypeError(`${label} has invalid own keys`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) ||
      descriptor.get !== undefined || descriptor.set !== undefined ||
      typeof descriptor.value === "function") {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase SHA-256`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function snapshotReconcileLimit(
  input: PrivacyPurgeWaitingReconcileLimit,
): PrivacyPurgeWaitingReconcileLimit {
  const maxJobs = snapshotBoundedIntegerInput(
    input,
    "maxJobs",
    100,
    "privacy purge reconcile limit.maxJobs",
  );
  return Object.freeze({ maxJobs });
}

function snapshotBoundedIntegerInput(
  input: object,
  key: string,
  maximum: number,
  label: string,
): number {
  if (input === null || typeof input !== "object") {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  const value = Reflect.get(input, key) as unknown;
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical millisecond UTC timestamp`);
  }
  return value;
}

function samplePrivacyPurgeClock(clock: () => Date): string {
  let sampled: Date;
  try {
    sampled = clock();
    if (!(sampled instanceof Date) || Number.isNaN(sampled.getTime())) {
      throw new Error("invalid clock sample");
    }
    return sampled.toISOString();
  } catch {
    throw new PrivacyPurgeIntentStoreError("PURGE_CLOCK_INVALID");
  }
}

function assertPrivacyPurgeClockNotRegressed(at: string, floor: string): void {
  if (at < floor) {
    throw new PrivacyPurgeIntentStoreError("PURGE_CLOCK_REGRESSION");
  }
}

function snapshotPublication(
  input: PrivacyPurgeWaitingPublication,
  createdAt: string,
): TimestampedPrivacyPurgeWaitingPublication {
  const publication = exactPlainData(input, [
    "intentKey",
    "idempotencyKeyHash",
    "requestFingerprint",
    "target",
  ], "privacy purge publication");
  const rawTarget = exactPlainData(
    publication.target,
    publication.target !== null && typeof publication.target === "object" &&
        !utilTypes.isProxy(publication.target) &&
        Object.getOwnPropertyDescriptor(publication.target, "kind")?.value ===
          "resource_history"
      ? ["kind", "historyEpochId"]
      : ["kind", "subjectGenerationId"],
    "privacy purge target",
  );
  let target: PrivacyPurgeIntentTarget;
  if (rawTarget.kind === "resource_history") {
    target = Object.freeze({
      kind: "resource_history" as const,
      historyEpochId: positiveSafeInteger(
        rawTarget.historyEpochId,
        "privacy purge target.historyEpochId",
      ),
    });
  } else if (rawTarget.kind === "run" || rawTarget.kind === "logical_page") {
    target = Object.freeze({
      kind: rawTarget.kind,
      subjectGenerationId: positiveSafeInteger(
        rawTarget.subjectGenerationId,
        "privacy purge target.subjectGenerationId",
      ),
    });
  } else {
    throw new TypeError("privacy purge target.kind is invalid");
  }
  return Object.freeze({
    intentKey: canonicalHash(publication.intentKey, "privacy purge intentKey"),
    idempotencyKeyHash: canonicalHash(
      publication.idempotencyKeyHash,
      "privacy purge idempotencyKeyHash",
    ),
    requestFingerprint: canonicalHash(
      publication.requestFingerprint,
      "privacy purge requestFingerprint",
    ),
    target,
    createdAt: canonicalTimestamp(createdAt, "privacy purge createdAt"),
  });
}

function snapshotReadyCommandIdentity(
  input: PrivacyPurgeReadyCommandIdentity,
  createdAt: string,
): TimestampedPrivacyPurgeReadyCommandIdentity {
  const identity = exactPlainData(input, [
    "idempotencyKeyHash",
    "requestFingerprint",
    "targetKind",
    "subjectGenerationId",
    "historyEpochId",
  ], "privacy purge ready command identity");
  if (identity.targetKind !== "run" &&
      identity.targetKind !== "logical_page" &&
      identity.targetKind !== "resource_history") {
    throw new TypeError("privacy purge ready command targetKind is invalid");
  }
  const resourceHistory = identity.targetKind === "resource_history";
  const subjectGenerationId = resourceHistory
    ? identity.subjectGenerationId
    : positiveSafeInteger(
      identity.subjectGenerationId,
      "privacy purge ready command subjectGenerationId",
    );
  const historyEpochId = resourceHistory
    ? positiveSafeInteger(
      identity.historyEpochId,
      "privacy purge ready command historyEpochId",
    )
    : identity.historyEpochId;
  if ((resourceHistory && subjectGenerationId !== null) ||
      (!resourceHistory && historyEpochId !== null)) {
    throw new TypeError("privacy purge ready command target identity is invalid");
  }
  return Object.freeze({
    idempotencyKeyHash: canonicalHash(
      identity.idempotencyKeyHash,
      "privacy purge ready command idempotencyKeyHash",
    ),
    requestFingerprint: canonicalHash(
      identity.requestFingerprint,
      "privacy purge ready command requestFingerprint",
    ),
    targetKind: identity.targetKind,
    subjectGenerationId: subjectGenerationId as number | null,
    historyEpochId: historyEpochId as number | null,
    createdAt: canonicalTimestamp(createdAt, "privacy purge command createdAt"),
  });
}

function targetColumns(target: PrivacyPurgeIntentTarget): {
  subjectGenerationId: number | null;
  historyEpochId: number | null;
} {
  return target.kind === "resource_history"
    ? { subjectGenerationId: null, historyEpochId: target.historyEpochId }
    : { subjectGenerationId: target.subjectGenerationId, historyEpochId: null };
}

function requestOwnedPrivacyPurgeCancellations(
  connection: Database.Database,
  publication: TimestampedPrivacyPurgeWaitingPublication,
): void {
  const activeJobIds = compilePrivacyPurgeTargetCandidatesV26(
    connection,
    publication.target,
  ).filter((entry) =>
    entry.tableName === "ai_jobs" &&
    ["queued", "running"].includes(String(entry.values.status))
  ).map((entry) => Number(entry.values.id)).sort((left, right) => left - right);
  const readJob = connection.prepare(`
    SELECT id, status, event_sequence, cancellation_requested_at, updated_at
    FROM ai_jobs WHERE id = ? AND status IN ('queued', 'running')
  `);
  const insertCancellation = connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, attempt_id,
      lease_token, cancellation_requested_by, error_code, available_at,
      occurred_at
    ) VALUES (
      @jobId, @sequenceNo, @eventType, @fromStatus, @toStatus, NULL,
      NULL, 'user', NULL, NULL, @occurredAt
    )
  `);
  for (const jobId of activeJobIds) {
    const job = readJob.get(jobId) as {
      id: number;
      status: "queued" | "running";
      event_sequence: number;
      cancellation_requested_at: string | null;
      updated_at: string;
    } | undefined;
    if (job === undefined || job.cancellation_requested_at !== null) continue;
    assertPrivacyPurgeClockNotRegressed(publication.createdAt, job.updated_at);
    insertCancellation.run({
      jobId: job.id,
      sequenceNo: job.event_sequence + 1,
      eventType: job.status === "queued" ? "cancelled" : "cancel_requested",
      fromStatus: job.status,
      toStatus: job.status === "queued" ? "cancelled" : "running",
      occurredAt: publication.createdAt,
    });
  }
}

function jobWaitRowDigest(connection: Database.Database, value: Row): string {
  return String(connection.prepare(`
    SELECT tabhub_sha256_v1(json_object(
      'intentKey', @intentKey, 'ordinal', CAST(@ordinal AS INTEGER),
      'jobId', CAST(@jobId AS INTEGER), 'status', @status,
      'eventSequence', CAST(@eventSequence AS INTEGER),
      'cancellationRequestedBy', @cancellationRequestedBy,
      'cancellationRequestedAt', @cancellationRequestedAt,
      'attemptId', CAST(@attemptId AS INTEGER),
      'attemptNo', CAST(@attemptNo AS INTEGER), 'workerId', @workerId,
      'leaseTokenDigest', @leaseTokenDigest,
      'leaseExpiresAt', @leaseExpiresAt,
      'requestBound', CAST(@requestBound AS INTEGER),
      'requestIdDigest', @requestIdDigest, 'requestBoundAt', @requestBoundAt,
      'provider', @provider, 'model', @model, 'promptVersion', @promptVersion,
      'pricingVersion', @pricingVersion,
      'providerAdoptionUtcDate', @providerAdoptionUtcDate,
      'providerAdoptedAt', @providerAdoptedAt,
      'providerReservationId', CAST(@providerReservationId AS INTEGER),
      'providerReservationUtcDate', @providerReservationUtcDate,
      'providerReservedUsd', @providerReservedUsd,
      'providerConsumedUsd', @providerConsumedUsd,
      'providerReservationStatus', @providerReservationStatus,
      'settlementDeadlineAt', @settlementDeadlineAt,
      'providerUsageState', @providerUsageState
    ))
  `).pluck().get(value));
}

function waitingRows(
  connection: Database.Database,
  publication: TimestampedPrivacyPurgeWaitingPublication,
): {
  root: Row;
  runs: Row[];
  actions: Row[];
  jobs: Row[];
  runDigest: string;
  actionDigest: string;
  actionQuiescenceDigest: string;
  jobDigest: string;
  waitDigest: string;
} {
  const exactTargets = compilePrivacyPurgeTargetCandidatesV26(
    connection,
    publication.target,
  );
  const runs: Row[] = [];
  let root: Row;
  if (publication.target.kind === "logical_page") {
    root = connection.prepare(`
      SELECT generation.logical_page_id AS logicalPageId,
        generation.generation_token AS rootGenerationToken,
        NULL AS resourceId, NULL AS historyEpochNo
      FROM privacy_subject_generations AS generation
      WHERE generation.id = ? AND generation.subject_kind = 'logical_page'
        AND generation.is_active = 1
    `).get(publication.target.subjectGenerationId) as Row;
  } else if (publication.target.kind === "run") {
    root = connection.prepare(`
      SELECT NULL AS logicalPageId, generation.generation_token AS rootGenerationToken,
        NULL AS resourceId, NULL AS historyEpochNo
      FROM privacy_subject_generations AS generation
      WHERE generation.id = ? AND generation.subject_kind = 'research_run'
        AND generation.is_active = 1
    `).get(publication.target.subjectGenerationId) as Row;
    const rows = connection.prepare(`
      WITH root_generation AS (
        SELECT id, generation_token, research_run_id
        FROM privacy_subject_generations
        WHERE id = ? AND subject_kind = 'research_run' AND is_active = 1
      )
      SELECT generation.id AS subjectGenerationId,
        generation.generation_token AS generationToken,
        run.id AS researchRunId, run.job_id AS aiJobId,
        generation.id = ? AS isRoot,
        NULL AS handoffId, NULL AS handoffStatus,
        NULL AS existingReceiptDigest, NULL AS existingReceiptCompletedAt
      FROM root_generation AS root
      JOIN research_runs AS run ON run.id = root.research_run_id
      JOIN privacy_subject_generations AS generation ON generation.id = root.id
      UNION ALL
      SELECT successor.id, successor.generation_token,
        final_run.id, final_run.job_id, 0,
        handoff.id, handoff.status, receipt.receipt_digest, receipt.completed_at
      FROM root_generation AS root
      JOIN live_acquisition_handoffs AS handoff
        ON handoff.coordinator_run_generation_id = root.id
        AND handoff.status IN ('assembling', 'completed')
      JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
      JOIN privacy_subject_generations AS successor
        ON successor.subject_kind = 'research_run'
        AND successor.research_run_id = final_run.id AND successor.is_active = 1
      LEFT JOIN live_acquisition_handoff_receipts AS receipt
        ON receipt.handoff_id = handoff.id
      ORDER BY subjectGenerationId
    `).all(
      publication.target.subjectGenerationId,
      publication.target.subjectGenerationId,
    ) as Row[];
    runs.push(...rows.map((row) => {
      if (row.handoffId === null) {
        return {
          subjectGenerationId: row.subjectGenerationId,
          generationToken: row.generationToken,
          researchRunId: row.researchRunId,
          aiJobId: row.aiJobId,
          isRoot: row.isRoot,
          handoffId: null,
          handoffStatus: null,
          handoffReceiptDigest: null,
          handoffReceiptCompletedAt: null,
        };
      }
      const assembling = row.handoffStatus === "assembling";
      return {
        subjectGenerationId: row.subjectGenerationId,
        generationToken: row.generationToken,
        researchRunId: row.researchRunId,
        aiJobId: row.aiJobId,
        isRoot: row.isRoot,
        handoffId: row.handoffId,
        handoffStatus: row.handoffStatus,
        handoffReceiptDigest: assembling
          ? sha256(
            `tabhub:privacy-purge:handoff-receipt:v1\0${publication.intentKey}\0${row.handoffId}`,
          )
          : row.existingReceiptDigest,
        handoffReceiptCompletedAt: assembling
          ? publication.createdAt
          : row.existingReceiptCompletedAt,
      };
    }));
  } else {
    root = connection.prepare(`
      SELECT NULL AS logicalPageId, NULL AS rootGenerationToken,
        history.resource_id AS resourceId, history.epoch_no AS historyEpochNo
      FROM research_history_epochs AS history
      WHERE history.id = ? AND history.is_active = 1
    `).get(publication.target.historyEpochId) as Row;
    runs.push(...connection.prepare(`
      SELECT generation.id AS subjectGenerationId,
        generation.generation_token AS generationToken,
        run.id AS researchRunId, run.job_id AS aiJobId, 0 AS isRoot,
        NULL AS handoffId, NULL AS handoffStatus,
        NULL AS handoffReceiptDigest, NULL AS handoffReceiptCompletedAt
      FROM research_runs AS run
      JOIN privacy_subject_generations AS generation
        ON generation.subject_kind = 'research_run'
        AND generation.research_run_id = run.id AND generation.is_active = 1
      WHERE run.history_epoch_id = ? ORDER BY generation.id
    `).all(publication.target.historyEpochId) as Row[]);
  }
  if (root === undefined) throw new Error("SUBJECT_FORGOTTEN_OR_INVALID");

  const actions = exactTargets.filter((entry) =>
    entry.tableName === "live_acquisition_actions" &&
    !["completed", "blocked", "ambiguous"].includes(String(entry.values.state))
  ).map((entry, ordinal) => {
    const consent = connection.prepare(`
      SELECT expires_at FROM live_acquisition_consents WHERE id = ?
    `).get(entry.values.consent_id) as { expires_at: string } | undefined;
    if (consent === undefined) throw new Error("PURGE_INVARIANT_VIOLATION");
    const resolutionStart = entry.values.state === "resolution_started"
      ? connection.prepare(`
          SELECT id, action_id, sequence_no, from_state, to_state,
            outcome_code, safe_details_json, occurred_at
          FROM live_acquisition_action_events
          WHERE action_id = ? AND sequence_no = ?
            AND from_state = 'planned' AND to_state = 'resolution_started'
        `).get(entry.values.id, entry.values.sequence_no) as Row | undefined
      : undefined;
    if (entry.values.state === "resolution_started" && resolutionStart === undefined) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    const resolutionStartedAt = resolutionStart?.occurred_at ?? null;
    const resolutionDeadlineAt = resolutionStartedAt === null ? null
      : new Date(Date.parse(String(resolutionStartedAt)) + 3_000).toISOString();
    const resolutionStartEventDigest = resolutionStart === undefined ? null : rowDigest({
      id: resolutionStart.id,
      actionId: resolutionStart.action_id,
      sequenceNo: resolutionStart.sequence_no,
      fromState: resolutionStart.from_state,
      toState: resolutionStart.to_state,
      outcomeCode: resolutionStart.outcome_code,
      safeDetailsJson: resolutionStart.safe_details_json,
      occurredAt: resolutionStart.occurred_at,
    });
    return {
      ordinal,
      actionId: entry.values.id,
      consentId: entry.values.consent_id,
      actionKind: entry.values.action_kind,
      state: entry.values.state,
      sequenceNo: entry.values.sequence_no,
      runtimeEpoch: entry.values.runtime_epoch,
      actionKeyDigest: entry.values.action_key_digest,
      resolutionStartSequenceNo: resolutionStart?.sequence_no ?? null,
      resolutionStartEventDigest,
      resolutionStartedAt,
      resolutionDeadlineAt,
      deadlineAt: consent.expires_at,
    };
  });
  const jobs = exactTargets.filter((entry) =>
    entry.tableName === "ai_jobs" &&
    ["queued", "running"].includes(String(entry.values.status))
  ).map((entry, ordinal) => {
    const attempt = connection.prepare(`
      SELECT * FROM ai_job_attempts
      WHERE job_id = ? AND outcome = 'running' ORDER BY id DESC LIMIT 1
    `).get(entry.values.id) as Row | undefined;
    const reservation = connection.prepare(`
      SELECT * FROM live_acquisition_provider_reservations
      WHERE final_job_id = ? ORDER BY id DESC LIMIT 1
    `).get(entry.values.id) as Row | undefined;
    const adoption = attempt === undefined ? undefined : connection.prepare(`
      SELECT * FROM live_acquisition_provider_reservation_adoptions
      WHERE attempt_id = ? AND final_job_id = ?
    `).get(attempt.id, entry.values.id) as Row | undefined;
    const requestBound = attempt?.request_bound_at === null ||
        attempt?.request_bound_at === undefined
      ? 0
      : 1;
    const boundedSettlement = requestBound === 0 ? null : new Date(Math.max(
      new Date(String(attempt!.request_bound_at)).getTime() + 31 * 60_000,
      new Date(String(entry.values.lease_expires_at)).getTime(),
    )).toISOString();
    return {
      ordinal,
      jobId: entry.values.id,
      status: entry.values.status,
      eventSequence: entry.values.event_sequence,
      cancellationRequestedBy: entry.values.cancellation_requested_by,
      cancellationRequestedAt: entry.values.cancellation_requested_at,
      attemptId: attempt?.id ?? null,
      attemptNo: attempt?.attempt_no ?? null,
      workerId: attempt?.worker_id ?? null,
      leaseTokenDigest: entry.values.lease_token === null
        ? null
        : sha256(String(entry.values.lease_token)),
      leaseExpiresAt: entry.values.lease_expires_at ?? null,
      requestBound,
      requestIdDigest: attempt?.request_id === null || attempt === undefined
        ? null
        : sha256(String(attempt.request_id)),
      requestBoundAt: attempt?.request_bound_at ?? null,
      provider: attempt?.provider ?? null,
      model: attempt?.model ?? null,
      promptVersion: attempt?.prompt_version ?? null,
      pricingVersion: attempt?.pricing_version ?? null,
      providerAdoptionUtcDate: adoption?.utc_date ?? null,
      providerAdoptedAt: adoption?.adopted_at ?? null,
      providerReservationId: reservation?.id ?? null,
      providerReservationUtcDate: reservation?.utc_date ?? null,
      providerReservedUsd: reservation?.reserved_usd ?? null,
      providerConsumedUsd: reservation?.consumed_usd ?? null,
      providerReservationStatus: reservation?.status ?? null,
      settlementDeadlineAt: boundedSettlement,
      providerUsageState: requestBound === 1 ? "pending" :
        reservation === undefined ? "none" : "known",
    };
  });

  const runRows = runs.map((run, ordinal) => {
    const value = {
      intentKey: publication.intentKey,
      ordinal,
      ...run,
    };
    return { ordinal, ...run, rowDigest: rowDigest(value) };
  });
  const actionRows = actions.map((action) => {
    const legacyValue = {
      intentKey: publication.intentKey,
      ordinal: action.ordinal,
      actionId: action.actionId,
      consentId: action.consentId,
      actionKind: action.actionKind,
      state: action.state,
      sequenceNo: action.sequenceNo,
      runtimeEpoch: action.runtimeEpoch,
      actionKeyDigest: action.actionKeyDigest,
      deadlineAt: action.deadlineAt,
    };
    const legacyRowDigest = rowDigest(legacyValue);
    return {
      ...action,
      rowDigest: legacyRowDigest,
      quiescenceSnapshotDigest: rowDigest({
        intentKey: publication.intentKey,
        ordinal: action.ordinal,
        rowDigest: legacyRowDigest,
        resolutionStartSequenceNo: action.resolutionStartSequenceNo,
        resolutionStartEventDigest: action.resolutionStartEventDigest,
        resolutionStartedAt: action.resolutionStartedAt,
        resolutionDeadlineAt: action.resolutionDeadlineAt,
      }),
    };
  });
  const jobRows = jobs.map((job) => {
    const { cancellationRequestedBy, cancellationRequestedAt } = job;
    const value = { intentKey: publication.intentKey, ...job };
    const cancellationSnapshotDigest = rowDigest({
      intentKey: publication.intentKey,
      jobId: job.jobId,
      eventSequence: job.eventSequence,
      cancellationRequestedBy,
      cancellationRequestedAt,
    });
    return {
      ...job,
      cancellationSnapshotDigest,
      rowDigest: jobWaitRowDigest(connection, value),
    };
  });
  const runDigest = sha256(JSON.stringify(runRows.map((row) => row.rowDigest)));
  const actionDigest = sha256(JSON.stringify(actionRows.map((row) => row.rowDigest)));
  const actionQuiescenceDigest = sha256(JSON.stringify(
    actionRows.map((row) => row.quiescenceSnapshotDigest),
  ));
  const jobDigest = sha256(JSON.stringify(jobRows.map((row) => row.rowDigest)));
  const columns = targetColumns(publication.target);
  const waitDigest = rowDigest({
    intentKey: publication.intentKey,
    idempotencyKeyHash: publication.idempotencyKeyHash,
    requestFingerprint: publication.requestFingerprint,
    targetKind: publication.target.kind,
    subjectGenerationId: columns.subjectGenerationId,
    historyEpochId: columns.historyEpochId,
    logicalPageIdSnapshot: root.logicalPageId,
    resourceIdSnapshot: root.resourceId,
    rootGenerationToken: root.rootGenerationToken,
    historyEpochNoSnapshot: root.historyEpochNo,
    runTargetCount: runRows.length,
    runTargetDigest: runDigest,
    actionWaitCount: actionRows.length,
    actionWaitDigest: actionDigest,
    actionQuiescenceDigest,
    jobWaitCount: jobRows.length,
    jobWaitDigest: jobDigest,
  });
  return {
    root,
    runs: runRows,
    actions: actionRows,
    jobs: jobRows,
    runDigest,
    actionDigest,
    actionQuiescenceDigest,
    jobDigest,
    waitDigest,
  };
}

function publishPrivacyPurgeWaitingIntentAt(
  connection: Database.Database,
  input: PrivacyPurgeWaitingPublication,
  createdAt: string,
): PublishedPrivacyPurgeIntent {
  const publication = snapshotPublication(input, createdAt);
  let snapshot: ReturnType<typeof waitingRows>;
  return runOwnedTransaction(
    connection,
    () => {
      requestOwnedPrivacyPurgeCancellations(connection, publication);
      snapshot = waitingRows(connection, publication);
      const runEntries = snapshot.runs.map((row) => [
        publication.intentKey,
        row.ordinal,
        row.subjectGenerationId,
        row.generationToken,
        row.researchRunId,
        row.aiJobId,
        row.isRoot,
        row.handoffId,
        row.handoffStatus,
        row.handoffReceiptDigest,
        row.handoffReceiptCompletedAt,
        row.rowDigest,
      ]);
      const actionEntries = snapshot.actions.map((row) => [
        publication.intentKey,
        row.ordinal,
        row.actionId,
        row.consentId,
        row.actionKind,
        row.state,
        row.sequenceNo,
        row.runtimeEpoch,
        row.actionKeyDigest,
        row.resolutionStartSequenceNo,
        row.resolutionStartEventDigest,
        row.resolutionStartedAt,
        row.resolutionDeadlineAt,
        row.deadlineAt,
        row.quiescenceSnapshotDigest,
        row.rowDigest,
      ]);
      const jobEntries = snapshot.jobs.map((row) => [
        publication.intentKey,
        row.ordinal,
        row.jobId,
        row.status,
        row.eventSequence,
        row.cancellationRequestedBy,
        row.cancellationRequestedAt,
        row.cancellationSnapshotDigest,
        row.attemptId,
        row.attemptNo,
        row.workerId,
        row.leaseTokenDigest,
        row.leaseExpiresAt,
        row.requestBound,
        row.requestIdDigest,
        row.requestBoundAt,
        row.provider,
        row.model,
        row.promptVersion,
        row.pricingVersion,
        row.providerAdoptionUtcDate,
        row.providerAdoptedAt,
        row.providerReservationId,
        row.providerReservationUtcDate,
        row.providerReservedUsd,
        row.providerConsumedUsd,
        row.providerReservationStatus,
        row.settlementDeadlineAt,
        row.providerUsageState,
        row.rowDigest,
      ]);
      return createLease("publication", {
        run: runEntries,
        action: actionEntries,
        job: jobEntries,
        transition: [[publication.intentKey, "", "waiting", snapshot.waitDigest]],
      }, [["publication", publication.intentKey, snapshot.waitDigest]]);
    },
    () => {
      const insertRun = connection.prepare(`
        INSERT INTO privacy_purge_intent_run_targets (
          intent_key, ordinal, subject_generation_id, generation_token,
          research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
          handoff_receipt_digest, handoff_receipt_completed_at, row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of snapshot!.runs) {
        insertRun.run(
          publication.intentKey,
          row.ordinal,
          row.subjectGenerationId,
          row.generationToken,
          row.researchRunId,
          row.aiJobId,
          row.isRoot,
          row.handoffId,
          row.handoffStatus,
          row.handoffReceiptDigest,
          row.handoffReceiptCompletedAt,
          row.rowDigest,
        );
      }
      const insertAction = connection.prepare(`
        INSERT INTO privacy_purge_intent_action_waits (
          intent_key, ordinal, action_id, consent_id, action_kind, state,
          sequence_no, runtime_epoch, action_key_digest,
          resolution_start_sequence_no, resolution_start_event_digest,
          resolution_started_at, resolution_deadline_at, deadline_at,
          quiescence_snapshot_digest, row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of snapshot!.actions) {
        insertAction.run(
          publication.intentKey,
          row.ordinal,
          row.actionId,
          row.consentId,
          row.actionKind,
          row.state,
          row.sequenceNo,
          row.runtimeEpoch,
          row.actionKeyDigest,
          row.resolutionStartSequenceNo,
          row.resolutionStartEventDigest,
          row.resolutionStartedAt,
          row.resolutionDeadlineAt,
          row.deadlineAt,
          row.quiescenceSnapshotDigest,
          row.rowDigest,
        );
      }
      const insertJob = connection.prepare(`
        INSERT INTO privacy_purge_intent_job_waits (
          intent_key, ordinal, job_id, status, event_sequence, attempt_id,
          cancellation_requested_by, cancellation_requested_at,
          cancellation_snapshot_digest, attempt_no, lease_token_digest,
          lease_expires_at, request_bound,
          worker_id, request_id_digest, request_bound_at, provider, model,
          prompt_version, pricing_version, provider_adoption_utc_date,
          provider_adopted_at, provider_reservation_id,
          provider_reservation_utc_date, provider_reserved_usd,
          provider_consumed_usd, provider_reservation_status,
          settlement_deadline_at, provider_usage_state, row_digest
        ) VALUES (
          @intentKey, @ordinal, @jobId, @status, @eventSequence, @attemptId,
          @cancellationRequestedBy, @cancellationRequestedAt,
          @cancellationSnapshotDigest, @attemptNo, @leaseTokenDigest,
          @leaseExpiresAt, @requestBound, @workerId, @requestIdDigest,
          @requestBoundAt, @provider, @model, @promptVersion, @pricingVersion,
          @providerAdoptionUtcDate, @providerAdoptedAt, @providerReservationId,
          @providerReservationUtcDate, @providerReservedUsd,
          @providerConsumedUsd, @providerReservationStatus,
          @settlementDeadlineAt, @providerUsageState, @rowDigest
        )
      `);
      for (const row of snapshot!.jobs) {
        insertJob.run({ intentKey: publication.intentKey, ...row });
      }

      const columns = targetColumns(publication.target);
      connection.prepare(`
        INSERT INTO privacy_purge_intents (
          intent_key, origin, idempotency_key_hash, request_fingerprint,
          target_kind, subject_generation_id, history_epoch_id,
          logical_page_id_snapshot, resource_id_snapshot, root_generation_token,
          history_epoch_no_snapshot, run_target_count, run_target_digest,
          action_wait_count, action_wait_digest, action_quiescence_digest,
          job_wait_count, job_wait_digest,
          wait_snapshot_digest, status, created_at, updated_at
        ) VALUES (?, 'schema26', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'waiting', ?, ?)
      `).run(
        publication.intentKey,
        publication.idempotencyKeyHash,
        publication.requestFingerprint,
        publication.target.kind,
        columns.subjectGenerationId,
        columns.historyEpochId,
        snapshot!.root.logicalPageId,
        snapshot!.root.resourceId,
        snapshot!.root.rootGenerationToken,
        snapshot!.root.historyEpochNo,
        snapshot!.runs.length,
        snapshot!.runDigest,
        snapshot!.actions.length,
        snapshot!.actionDigest,
        snapshot!.actionQuiescenceDigest,
        snapshot!.jobs.length,
        snapshot!.jobDigest,
        snapshot!.waitDigest,
        publication.createdAt,
        publication.createdAt,
      );
      return {
        intentKey: publication.intentKey,
        status: "waiting" as const,
        runTargetCount: snapshot!.runs.length,
        actionWaitCount: snapshot!.actions.length,
        jobWaitCount: snapshot!.jobs.length,
        waitSnapshotDigest: snapshot!.waitDigest,
      };
    },
  );
}

function reconcilePrivacyPurgeWaitingIntentAt(
  connection: Database.Database,
  intentKey: string,
  limit: PrivacyPurgeWaitingReconcileLimit,
  at: string,
): ReconciledPrivacyPurgeIntent {
  let inspectedJobs = 0;
  let shouldHold = false;
  let transitionDigest = "";
  return runOwnedTransaction(
    connection,
    () => {
      const intent = connection.prepare(`
        SELECT status, hold_code, updated_at, repair_count,
          settlement_proof_generation, settlement_evidence_digest,
          action_quiescence_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey) as {
        status: string;
        hold_code: string | null;
        updated_at: string;
        repair_count: number;
        settlement_proof_generation: number;
        settlement_evidence_digest: string | null;
        action_quiescence_digest: string;
      } | undefined;
      if (intent === undefined) throw new Error("Privacy purge intent does not exist");
      if (intent.status === "failed_hold" &&
          intent.hold_code === "PROVIDER_USAGE_UNKNOWN") {
        return createLease("reconcile", {}, []);
      }
      if (intent.status !== "waiting") {
        throw new Error("Privacy purge intent is not waiting");
      }
      assertPrivacyPurgeClockNotRegressed(at, intent.updated_at);
      const rows = connection.prepare(`
        SELECT wait.ordinal
        FROM privacy_purge_intent_job_waits AS wait
        WHERE wait.intent_key = @intentKey
          AND wait.request_bound = 1
          AND wait.provider_usage_state = 'pending'
          AND wait.terminal_status IS NULL
          AND wait.settlement_deadline_at IS NOT NULL
          AND @at >= wait.settlement_deadline_at
          AND NOT EXISTS (
            SELECT 1 FROM ai_job_events AS known_usage
            WHERE known_usage.job_id = wait.job_id
              AND known_usage.attempt_id = wait.attempt_id
              AND known_usage.event_type = 'progress'
              AND known_usage.sequence_no > wait.event_sequence
              AND known_usage.delta_steps > 0
              AND known_usage.occurred_at <= wait.settlement_deadline_at
              AND tabhub_sha256_v1(known_usage.lease_token)
                = wait.lease_token_digest
          )
        ORDER BY wait.ordinal
        LIMIT @maxJobs
      `).all({ intentKey, at, maxJobs: limit.maxJobs }) as Array<{ ordinal: number }>;
      inspectedJobs = rows.length;
      shouldHold = rows.length > 0;
      if (!shouldHold) return createLease("reconcile", {}, []);
      transitionDigest = rowDigest({
        intentKey,
        fromStatus: "waiting",
        toStatus: "failed_hold",
        holdCode: "PROVIDER_USAGE_UNKNOWN",
        repairCount: intent.repair_count,
        settlementProofGeneration: intent.settlement_proof_generation,
        settlementEvidenceDigest: intent.settlement_evidence_digest,
        actionQuiescenceDigest: intent.action_quiescence_digest,
        updatedAt: at,
      });
      return createLease("reconcile", {
        transition: [[intentKey, "waiting", "failed_hold", transitionDigest]],
      }, []);
    },
    () => {
      if (!shouldHold) {
        const state = connection.prepare(`
          SELECT status, hold_code FROM privacy_purge_intents WHERE intent_key = ?
        `).get(intentKey) as { status: string; hold_code: string | null };
        return {
          intentKey,
          status: state.status as "waiting" | "failed_hold",
          holdCode: state.hold_code as "PROVIDER_USAGE_UNKNOWN" | null,
          inspectedJobs,
          transitioned: false,
        };
      }
      const updated = connection.prepare(`
        UPDATE privacy_purge_intents
        SET status = 'failed_hold', hold_code = 'PROVIDER_USAGE_UNKNOWN',
          updated_at = ?
        WHERE intent_key = ? AND status = 'waiting'
      `).run(at, intentKey);
      if (updated.changes !== 1) {
        throw new Error("Privacy purge reconcile transition failed");
      }
      return {
        intentKey,
        status: "failed_hold" as const,
        holdCode: "PROVIDER_USAGE_UNKNOWN" as const,
        inspectedJobs,
        transitioned: true,
      };
    },
  );
}

async function repairPrivacyPurgeFinalSettlementsAt(
  connection: Database.Database,
  intentKey: string,
  limit: PrivacyPurgeWaitingReconcileLimit,
  verifier: PrivacyPurgeFinalSettlementVerifier,
  clock: () => Date,
): Promise<RepairedPrivacyPurgeFinalSettlements> {
  const intent = connection.prepare(`
    SELECT status, hold_code, settlement_proof_generation
    FROM privacy_purge_intents WHERE intent_key = ?
  `).get(intentKey) as {
    status: string;
    hold_code: string | null;
    settlement_proof_generation: number;
  } | undefined;
  if (intent === undefined) throw new Error("Privacy purge intent does not exist");
  if (intent.status === "waiting" && intent.settlement_proof_generation > 0) {
    return {
      intentKey,
      inspectedJobs: 0,
      recordedEvidence: 0,
      status: "waiting",
      transitioned: false,
      settlementProofGeneration: intent.settlement_proof_generation,
    };
  }
  if (intent.status !== "failed_hold" ||
      intent.hold_code !== "PROVIDER_USAGE_UNKNOWN") {
    throw new Error("Privacy purge intent is not held for provider usage");
  }
  const proofGeneration = intent.settlement_proof_generation + 1;
  const candidates = connection.prepare(`
    SELECT wait.ordinal, wait.row_digest, wait.provider, wait.model,
      wait.request_bound_at, wait.settlement_deadline_at, attempt.request_id
      , wait.provider_consumed_usd
    FROM privacy_purge_intent_job_waits AS wait
    JOIN ai_job_attempts AS attempt
      ON attempt.id = wait.attempt_id AND attempt.job_id = wait.job_id
    WHERE wait.intent_key = @intentKey
      AND wait.request_bound = 1
      AND wait.provider_usage_state = 'pending'
      AND wait.terminal_status IS NULL
      AND tabhub_sha256_v1(attempt.request_id) = wait.request_id_digest
      AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_intent_final_settlements AS evidence
        WHERE evidence.intent_key = wait.intent_key
          AND evidence.job_wait_ordinal = wait.ordinal
          AND evidence.proof_generation = @proofGeneration
      )
    ORDER BY wait.ordinal LIMIT @maxJobs
  `).all({ intentKey, proofGeneration, maxJobs: limit.maxJobs }) as Array<{
    ordinal: number;
    row_digest: string;
    provider: string;
    model: string;
    request_bound_at: string;
    settlement_deadline_at: string;
    request_id: string;
    provider_consumed_usd: number | null;
  }>;
  const accepted: Array<{
    ordinal: number;
    rowDigest: string;
    providerFinalAt: string;
    recordedAt: string;
    evidenceKind: "provider_request_final_additional_usage_zero:v1" |
      "provider_request_final_usage_positive:v1";
    verifierVersion: "provider_final_zero:v1" | "provider_final_usage:v1";
    finalCostNanos: number;
    evidenceDigest: string;
  }> = [];
  for (const candidate of candidates) {
    const rawResult = await verifier.verifyFinalProviderUsage(Object.freeze({
      provider: candidate.provider,
      model: candidate.model,
      requestId: candidate.request_id,
      requestBoundAt: candidate.request_bound_at,
      settlementDeadlineAt: candidate.settlement_deadline_at,
    }));
    const status = rawResult !== null && typeof rawResult === "object" &&
        !utilTypes.isProxy(rawResult)
      ? Object.getOwnPropertyDescriptor(rawResult, "status")?.value
      : undefined;
    const result = exactPlainData(
      rawResult,
      status === "final_zero"
        ? ["status", "verifierVersion", "providerFinalAt"]
        : status === "final_positive"
        ? ["status", "verifierVersion", "providerFinalAt", "finalCostUsd"]
        : ["status"],
      "privacy purge final settlement verifier result",
    ) as unknown as PrivacyPurgeFinalSettlementResult;
    if (!['final_zero', 'final_positive', 'unknown'].includes(result.status)) {
      throw new Error("Privacy purge final settlement verifier result is invalid");
    }
    if (result.status === "unknown") continue;
    const expectedVerifierVersion = result.status === "final_zero"
      ? "provider_final_zero:v1" as const
      : "provider_final_usage:v1" as const;
    if (result.verifierVersion !== expectedVerifierVersion) {
      throw new Error("Privacy purge settlement verifier is not allowlisted");
    }
    let finalCostNanos = 0;
    if (result.status === "final_positive") {
      if (typeof result.finalCostUsd !== "number" ||
          !Number.isFinite(result.finalCostUsd) || result.finalCostUsd <= 0) {
        throw new Error("Privacy purge final provider cost is invalid");
      }
      finalCostNanos = Math.ceil(result.finalCostUsd * 1_000_000_000);
      const consumedNanos = Math.ceil((candidate.provider_consumed_usd ?? 0) *
        1_000_000_000);
      if (!Number.isSafeInteger(finalCostNanos) ||
          finalCostNanos < consumedNanos) {
        throw new Error("Privacy purge final provider cost is stale");
      }
    }
    const providerFinalAt = canonicalTimestamp(
      result.providerFinalAt,
      "privacy purge provider final settlement timestamp",
    );
    const recordedAt = samplePrivacyPurgeClock(clock);
    if (providerFinalAt < candidate.settlement_deadline_at ||
        recordedAt < providerFinalAt) {
      throw new Error("Privacy purge settlement proof is stale");
    }
    const evidenceDigest = rowDigest({
      version: "tabhub:privacy-purge:settlement-final:v1",
      intentKey,
      jobWaitOrdinal: candidate.ordinal,
      proofGeneration,
      waitRowDigest: candidate.row_digest,
      evidenceKind: result.status === "final_zero"
        ? "provider_request_final_additional_usage_zero:v1"
        : "provider_request_final_usage_positive:v1",
      verifierVersion: expectedVerifierVersion,
      finalCostNanos,
      providerFinalAt,
      recordedAt,
    });
    accepted.push({
      ordinal: candidate.ordinal,
      rowDigest: candidate.row_digest,
      evidenceKind: result.status === "final_zero"
        ? "provider_request_final_additional_usage_zero:v1"
        : "provider_request_final_usage_positive:v1",
      verifierVersion: expectedVerifierVersion,
      finalCostNanos,
      providerFinalAt,
      recordedAt,
      evidenceDigest,
    });
  }
  let transitioned = false;
  let recordedEvidence = 0;
  let plannedEvidenceDigest: string | null = null;
  let plannedRepairDigest: string | null = null;
  let plannedRepairAt: string | null = null;
  let evidenceToInsert: typeof accepted = [];
  let replayedSettledGeneration = false;
  const repaired = runOwnedTransaction(
    connection,
    () => {
      const current = connection.prepare(`
        SELECT status, hold_code, repair_count, settlement_proof_generation,
          action_quiescence_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey) as {
        status: string;
        hold_code: string | null;
        repair_count: number;
        settlement_proof_generation: number;
        action_quiescence_digest: string;
      } | undefined;
      if (current === undefined) {
        throw new Error("Privacy purge settlement state changed during verification");
      }
      const heldGeneration = current.status === "failed_hold" &&
        current.hold_code === "PROVIDER_USAGE_UNKNOWN" &&
        current.settlement_proof_generation + 1 === proofGeneration;
      replayedSettledGeneration = current.status === "waiting" && current.hold_code === null &&
        current.settlement_proof_generation === proofGeneration;
      if (!heldGeneration && !replayedSettledGeneration) {
        throw new Error("Privacy purge settlement state changed during verification");
      }
      const existing = connection.prepare(`
        SELECT job_wait_ordinal, wait_row_digest, evidence_kind,
          verifier_version, final_cost_nanos, provider_final_at,
          evidence_digest, recorded_at
        FROM privacy_purge_intent_final_settlements
        WHERE intent_key = ? AND proof_generation = ?
        ORDER BY job_wait_ordinal
      `).all(intentKey, proofGeneration) as Array<{
        job_wait_ordinal: number;
        wait_row_digest: string;
        evidence_kind: string;
        verifier_version: string;
        final_cost_nanos: number;
        provider_final_at: string;
        evidence_digest: string;
        recorded_at: string;
      }>;
      const existingByOrdinal = new Map(existing.map((row) => [
        row.job_wait_ordinal,
        row,
      ]));
      for (const row of existing) {
        const currentWaitDigest = connection.prepare(`
          SELECT row_digest FROM privacy_purge_intent_job_waits
          WHERE intent_key = ? AND ordinal = ?
        `).pluck().get(intentKey, row.job_wait_ordinal);
        if (currentWaitDigest !== row.wait_row_digest) {
          throw new Error("Privacy purge settlement evidence is stale");
        }
      }
      evidenceToInsert = [];
      for (const row of accepted) {
        const currentWaitDigest = connection.prepare(`
          SELECT row_digest FROM privacy_purge_intent_job_waits
          WHERE intent_key = ? AND ordinal = ?
            AND request_bound = 1 AND provider_usage_state = 'pending'
            AND terminal_status IS NULL
        `).pluck().get(intentKey, row.ordinal);
        if (currentWaitDigest !== row.rowDigest) {
          throw new Error("Privacy purge settlement candidate changed during verification");
        }
        const prior = existingByOrdinal.get(row.ordinal);
        if (prior === undefined) {
          if (replayedSettledGeneration) {
            throw new Error("Privacy purge settled evidence replay is incomplete");
          }
          evidenceToInsert.push(row);
          continue;
        }
        if (prior.wait_row_digest !== row.rowDigest ||
            prior.evidence_kind !== row.evidenceKind ||
            prior.verifier_version !== row.verifierVersion ||
            prior.final_cost_nanos !== row.finalCostNanos ||
            prior.provider_final_at !== row.providerFinalAt) {
          throw new Error("Privacy purge settlement evidence conflicts with replay");
        }
      }
      const required = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? AND request_bound = 1
          AND provider_usage_state = 'pending' AND terminal_status IS NULL
      `).pluck().get(intentKey));
      const combined = [
        ...existing.map((row) => ({
          jobWaitOrdinal: row.job_wait_ordinal,
          evidenceDigest: row.evidence_digest,
          recordedAt: row.recorded_at,
        })),
        ...evidenceToInsert.map((row) => ({
          jobWaitOrdinal: row.ordinal,
          evidenceDigest: row.evidenceDigest,
          recordedAt: row.recordedAt,
        })),
      ].sort((left, right) => left.jobWaitOrdinal - right.jobWaitOrdinal);
      if (!replayedSettledGeneration && combined.length === required && required > 0) {
        plannedEvidenceDigest = sha256(JSON.stringify(combined.map((row) => ({
          jobWaitOrdinal: row.jobWaitOrdinal,
          evidenceDigest: row.evidenceDigest,
        }))));
        plannedRepairAt = combined.reduce(
          (latest, row) => row.recordedAt > latest ? row.recordedAt : latest,
          "",
        );
        plannedRepairDigest = rowDigest({
          intentKey,
          holdCode: "PROVIDER_USAGE_UNKNOWN",
          repairCount: current.repair_count + 1,
          settlementProofGeneration: proofGeneration,
          settlementEvidenceDigest: plannedEvidenceDigest,
          actionQuiescenceDigest: current.action_quiescence_digest,
          repairAt: plannedRepairAt,
        });
      }
      const parts = evidenceToInsert.map((row) => [
        intentKey, row.ordinal, proofGeneration, row.rowDigest,
        row.evidenceKind, row.verifierVersion, row.finalCostNanos,
        row.providerFinalAt, row.recordedAt, row.evidenceDigest,
      ]);
      return createLease("repair", {
        settlement_final: parts,
        transition: replayedSettledGeneration || plannedRepairDigest === null ? [] : [[
          intentKey, "failed_hold", "waiting", plannedRepairDigest,
        ]],
      }, []);
    },
    () => {
      const insert = connection.prepare(`
        INSERT INTO privacy_purge_intent_final_settlements (
          intent_key, job_wait_ordinal, proof_generation, wait_row_digest,
          evidence_kind, verifier_version, final_cost_nanos,
          provider_final_at, recorded_at, evidence_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of evidenceToInsert) {
        insert.run(
          intentKey, row.ordinal, proofGeneration, row.rowDigest,
          row.evidenceKind, row.verifierVersion, row.finalCostNanos,
          row.providerFinalAt, row.recordedAt, row.evidenceDigest,
        );
        recordedEvidence += 1;
      }
      if (replayedSettledGeneration) return true;
      const remaining = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_job_waits AS wait
        WHERE wait.intent_key = ? AND wait.request_bound = 1
          AND wait.provider_usage_state = 'pending'
          AND wait.terminal_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_final_settlements AS evidence
            WHERE evidence.intent_key = wait.intent_key
              AND evidence.job_wait_ordinal = wait.ordinal
              AND evidence.proof_generation = ?
              AND evidence.wait_row_digest = wait.row_digest
          )
      `).pluck().get(intentKey, proofGeneration));
      if (remaining !== 0) return false;
      const evidenceDigest = String(connection.prepare(`
        SELECT tabhub_sha256_v1(COALESCE((
          SELECT json_group_array(json(evidence_json)) FROM (
            SELECT json_object(
              'jobWaitOrdinal', job_wait_ordinal,
              'evidenceDigest', evidence_digest
            ) AS evidence_json
            FROM privacy_purge_intent_final_settlements
            WHERE intent_key = ? AND proof_generation = ?
            ORDER BY job_wait_ordinal
          )
        ), '[]'))
      `).pluck().get(intentKey, proofGeneration));
      if (plannedEvidenceDigest === null || plannedRepairDigest === null ||
          plannedRepairAt === null || evidenceDigest !== plannedEvidenceDigest) {
        throw new Error("Privacy purge settlement evidence changed during repair");
      }
      const state = connection.prepare(`
        SELECT repair_count FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey) as { repair_count: number };
      if (state.repair_count < 0) throw new Error("Privacy purge repair state is corrupt");
      const updated = connection.prepare(`
        UPDATE privacy_purge_intents
        SET status = 'waiting', hold_code = NULL,
          repair_count = repair_count + 1,
          last_repair_digest = ?, last_repair_at = ?,
          settlement_proof_generation = ?, settlement_evidence_digest = ?,
          updated_at = ?
        WHERE intent_key = ? AND status = 'failed_hold'
          AND hold_code = 'PROVIDER_USAGE_UNKNOWN'
      `).run(
        plannedRepairDigest, plannedRepairAt, proofGeneration, evidenceDigest,
        plannedRepairAt, intentKey,
      );
      if (updated.changes !== 1) throw new Error("Privacy purge repair failed");
      transitioned = true;
      return true;
    },
  );
  void repaired;
  return {
    intentKey,
    inspectedJobs: candidates.length,
    recordedEvidence,
    status: transitioned || replayedSettledGeneration ? "waiting" : "failed_hold",
    transitioned,
    settlementProofGeneration: transitioned || replayedSettledGeneration
      ? proofGeneration
      : intent.settlement_proof_generation,
  };
}

function freezePrivacyPurgeIntentReadyAt(
  connection: Database.Database,
  intentKey: string,
  at: string,
): ReadyPrivacyPurgeIntent {
  let targets: Array<{
    intent_key: string;
    ordinal: number;
    table_name: string;
    pk_v1: string;
    delete_rank: number;
    live_action_depth: number | null;
    row_digest: string;
  }>;
  let planDigest: string;
  let carryoverRows: ReturnType<typeof derivePrivacyPurgeBudgetCarryoverRows>;
  let carryoverManifest: ReturnType<typeof privacyPurgeCarryoverManifestFromRows>;
  let terminalEvidenceDigest: string;
  return runOwnedTransaction(
    connection,
    () => {
      const intent = connection.prepare(`
        SELECT intent_key, updated_at, settlement_proof_generation,
          settlement_evidence_digest, action_quiescence_digest
        FROM privacy_purge_intents
        WHERE intent_key = ? AND status = 'waiting'
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_action_waits
            WHERE intent_key = ? AND terminal_state IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_purge_intent_job_waits AS wait
            WHERE wait.intent_key = ? AND wait.terminal_status IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM privacy_purge_intent_final_settlements AS evidence
                WHERE evidence.intent_key = wait.intent_key
                  AND evidence.job_wait_ordinal = wait.ordinal
                  AND evidence.proof_generation = (
                    SELECT settlement_proof_generation
                    FROM privacy_purge_intents WHERE intent_key = wait.intent_key
                  )
                  AND evidence.wait_row_digest = wait.row_digest
              )
          )
      `).get(intentKey, intentKey, intentKey) as {
        intent_key: string;
        updated_at: string;
        settlement_proof_generation: number;
        settlement_evidence_digest: string | null;
        action_quiescence_digest: string;
      } | undefined;
      if (intent === undefined) throw new Error("PURGE_SUBJECT_BUSY");
      assertPrivacyPurgeClockNotRegressed(at, intent.updated_at);
      targets = connection.prepare(`
        SELECT intent_key, ordinal, table_name, pk_v1, delete_rank,
          live_action_depth, row_digest
        FROM privacy_purge26_expected_execution_targets
        WHERE intent_key = ? ORDER BY ordinal
      `).all(intentKey) as typeof targets;
      planDigest = digestPrivacyPurgeExecutionTargets(
        targets.map((row) => ({
          tableName: row.table_name,
          pkV1: row.pk_v1,
        })),
      );
      carryoverRows = derivePrivacyPurgeBudgetCarryoverRows(
        connection,
        intentKey,
        at,
      );
      carryoverManifest = privacyPurgeCarryoverManifestFromRows(carryoverRows);
      terminalEvidenceDigest = privacyPurgeTerminalEvidenceDigest(
        connection,
        intentKey,
        intent.settlement_proof_generation,
        intent.settlement_evidence_digest,
      );
      assertPrivacyPurgeActionQuiescence(connection, intentKey);
      return createLease("ready", {
        execution: targets.map((row) => [
          row.intent_key,
          row.ordinal,
          row.table_name,
          row.pk_v1,
          row.delete_rank,
          row.live_action_depth,
          row.row_digest,
        ]),
        transition: [[intentKey, "waiting", "ready",
          privacyPurgeSchema26TransitionDigest(
            intent.action_quiescence_digest,
            planDigest,
          )]],
        carryover_insert: carryoverRows.map(carryoverInsertParts),
      }, [["ready", intentKey, planDigest]]);
    },
    () => {
      const inserted = connection.prepare(`
        INSERT INTO privacy_purge_intent_execution_targets (
          intent_key, ordinal, table_name, pk_v1, delete_rank,
          live_action_depth, row_digest
        )
        SELECT intent_key, ordinal, table_name, pk_v1, delete_rank,
          live_action_depth, row_digest
        FROM privacy_purge26_expected_execution_targets
        WHERE intent_key = ? ORDER BY ordinal
      `).run(intentKey);
      if (inserted.changes !== targets!.length) {
        throw new Error("Privacy purge execution enumeration changed during freeze");
      }
      freezePrivacyPurgeBudgetCarryover(connection, intentKey, at);
      const persistedManifest = privacyPurgeCarryoverManifest(connection, intentKey);
      if (persistedManifest.count !== carryoverManifest!.count ||
          persistedManifest.digest !== carryoverManifest!.digest) {
        throw new Error("Privacy purge carryover manifest changed during freeze");
      }
      const tombstoneDigest = sha256(
        `tabhub:privacy-purge:tombstone:v2\0${intentKey}\0${planDigest!}`,
      );
      if (connection.prepare(`
        UPDATE privacy_purge_intents
        SET execution_target_count = @targetCount,
          execution_plan_digest = @planDigest,
          tombstone_digest = @tombstoneDigest,
          carryover_manifest_count = @manifestCount,
          carryover_manifest_digest = @manifestDigest,
          terminal_evidence_digest = @terminalEvidenceDigest,
          result_digest = tabhub_sha256_v1(json_object(
            'version', 'tabhub:privacy-purge:result:v3',
            'intentKey', @intentKey, 'planDigest', @planDigest,
            'actionQuiescenceDigest', (
              SELECT action_quiescence_digest FROM privacy_purge_intents
              WHERE intent_key = @intentKey
            ),
            'carryoverManifestCount', CAST(@manifestCount AS INTEGER),
            'carryoverManifestDigest', @manifestDigest,
            'terminalEvidenceDigest', @terminalEvidenceDigest
          )), status = 'ready', updated_at = @at
        WHERE intent_key = @intentKey AND status = 'waiting'
      `).run({
        targetCount: targets!.length,
        planDigest: planDigest!,
        tombstoneDigest,
        manifestCount: carryoverManifest!.count,
        manifestDigest: carryoverManifest!.digest,
        terminalEvidenceDigest: terminalEvidenceDigest!,
        at,
        intentKey,
      }).changes !== 1) {
        throw new Error("Privacy purge intent ready transition failed");
      }
      return {
        intentKey,
        status: "ready" as const,
        executionTargetCount: targets!.length,
        executionPlanDigest: planDigest!,
      };
    },
  );
}

function linkPrivacyPurgeReadyIntentCommandAt(
  connection: Database.Database,
  identity: TimestampedPrivacyPurgeReadyCommandIdentity,
): number {
  let ready: {
    intent_key: string;
    execution_target_count: number;
    execution_plan_digest: string;
    action_quiescence_digest: string;
    updated_at: string;
  };
  return runOwnedTransaction(
    connection,
    () => {
      ready = connection.prepare(`
        SELECT intent_key, execution_target_count, execution_plan_digest,
          action_quiescence_digest,
          updated_at
        FROM privacy_purge_intents
        WHERE origin = 'schema26' AND status = 'ready'
          AND idempotency_key_hash = @idempotencyKeyHash
          AND request_fingerprint = @requestFingerprint
          AND target_kind = @targetKind
          AND subject_generation_id IS @subjectGenerationId
          AND history_epoch_id IS @historyEpochId
      `).get(identity) as typeof ready | undefined as typeof ready;
      if (ready === undefined) {
        throw new Error("Schema26 privacy purge ready intent is unavailable");
      }
      assertPrivacyPurgeClockNotRegressed(identity.createdAt, ready.updated_at);
      assertPrivacyPurgeActionQuiescence(connection, ready.intent_key);
      return createLease("link", {
        command_link: [[
          ready.intent_key,
          identity.idempotencyKeyHash,
          identity.requestFingerprint,
          identity.targetKind,
          identity.subjectGenerationId,
          identity.historyEpochId,
          ready.execution_target_count,
          ready.execution_plan_digest,
        ]],
        transition: [[
          ready.intent_key,
          "ready",
          "committed",
          privacyPurgeSchema26TransitionDigest(
            ready.action_quiescence_digest,
            ready.execution_plan_digest,
          ),
        ]],
      }, []);
    },
    () => {
      const inserted = connection.prepare(`
        INSERT INTO privacy_purge_commands (
          idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, deletion_target_count,
          deletion_plan_digest, status, created_at
        ) VALUES (
          @idempotencyKeyHash, @requestFingerprint, @targetKind,
          @subjectGenerationId, @historyEpochId, @executionTargetCount,
          @executionPlanDigest, 'pending', @createdAt
        )
      `).run({
        ...identity,
        executionTargetCount: ready!.execution_target_count,
        executionPlanDigest: ready!.execution_plan_digest,
      });
      return Number(inserted.lastInsertRowid);
    },
  );
}

function executePrivacyPurgeCommittedIntentAt(
  connection: Database.Database,
  commandId: number,
  completedAt: string,
): void {
  if (connection.inTransaction) {
    throw new Error("Schema26 privacy purge execution requires autocommit mode");
  }
  assertSchema26ConnectionSafety(connection);
  const state = stateFor(connection);
  if (state.activeLease !== null || state.executorInvocation !== null) {
    throw new Error("Another privacy purge capability scope is active");
  }
  const intent = connection.prepare(`
    SELECT intent.intent_key, intent.target_kind, intent.subject_generation_id,
      intent.history_epoch_id, intent.logical_page_id_snapshot,
      intent.resource_id_snapshot, intent.history_epoch_no_snapshot,
      intent.execution_target_count,
      intent.execution_plan_digest, intent.tombstone_digest,
      intent.result_digest, intent.carryover_manifest_count,
      intent.carryover_manifest_digest, intent.terminal_evidence_digest,
      intent.action_quiescence_digest,
      intent.settlement_proof_generation, intent.settlement_evidence_digest,
      intent.updated_at, command.created_at
    FROM privacy_purge_intents AS intent
    JOIN privacy_purge_commands AS command ON command.id = intent.purge_command_id
    WHERE intent.origin = 'schema26' AND intent.status = 'committed'
      AND intent.purge_command_id = ? AND command.status IN ('pending', 'waiting')
  `).get(commandId) as {
    intent_key: string;
    target_kind: "run" | "logical_page" | "resource_history";
    subject_generation_id: number | null;
    history_epoch_id: number | null;
    logical_page_id_snapshot: number | null;
    resource_id_snapshot: number | null;
    history_epoch_no_snapshot: number | null;
    execution_target_count: number;
    execution_plan_digest: string;
    tombstone_digest: string;
    result_digest: string;
    carryover_manifest_count: number;
    carryover_manifest_digest: string;
    terminal_evidence_digest: string;
    action_quiescence_digest: string;
    settlement_proof_generation: number;
    settlement_evidence_digest: string | null;
    updated_at: string;
    created_at: string;
  } | undefined;
  if (intent === undefined) {
    throw new Error("Schema26 privacy purge committed intent is unavailable");
  }
  assertPrivacyPurgeClockNotRegressed(completedAt, intent.updated_at);
  assertPrivacyPurgeClockNotRegressed(completedAt, intent.created_at);
  const targets = connection.prepare(`
    SELECT ordinal, table_name, pk_v1, delete_rank, live_action_depth, row_digest
    FROM privacy_purge_intent_execution_targets
    WHERE intent_key = ? ORDER BY ordinal
  `).all(intent.intent_key) as Array<{
    ordinal: number;
    table_name: string;
    pk_v1: string;
    delete_rank: number;
    live_action_depth: number | null;
    row_digest: string;
  }>;
  const orderedTargets = targets.map((row) => ({
    tableName: row.table_name,
    pkV1: row.pk_v1,
  }));
  if (targets.length !== intent.execution_target_count ||
      digestPrivacyPurgeExecutionTargets(orderedTargets) !==
        intent.execution_plan_digest) {
    throw new Error("Schema26 privacy purge frozen execution plan is corrupt");
  }
  const safeCountsJson = JSON.stringify({ deleted_rows: targets.length });
  const waitTerminalDigest = privacyPurgeWaitTerminalDigest(
    connection,
    intent.intent_key,
  );
  const committedManifest = privacyPurgeCarryoverManifest(
    connection,
    intent.intent_key,
  );
  const terminalEvidenceDigest = privacyPurgeTerminalEvidenceDigest(
    connection,
    intent.intent_key,
    intent.settlement_proof_generation,
    intent.settlement_evidence_digest,
  );
  const expectedResultDigest = privacyPurgeResultDigestV3(
    connection,
    intent.intent_key,
    intent.execution_plan_digest,
    committedManifest.count,
    committedManifest.digest,
    terminalEvidenceDigest,
  );
  if (committedManifest.count !== intent.carryover_manifest_count ||
      committedManifest.digest !== intent.carryover_manifest_digest ||
      terminalEvidenceDigest !== intent.terminal_evidence_digest ||
      expectedResultDigest !== intent.result_digest) {
    throw new Error("Schema26 privacy purge committed evidence manifest drifted");
  }
  const rootTables = new Set([
    "privacy_subject_generations",
    "research_history_epochs",
    "logical_pages",
    "resources",
  ]);
  const retirementTargets = connection.prepare(`
    SELECT 'pk:v1|1|' || 'i:'
      || length(CAST(subject_generation_id AS TEXT)) || ':'
      || CAST(subject_generation_id AS TEXT) AS pk_v1
    FROM privacy_purge_intent_run_targets
    WHERE intent_key = ? ORDER BY ordinal
  `).all(intent.intent_key) as Array<{ pk_v1: string }>;
  const lifecycleRootUpdate = intent.target_kind === "logical_page"
    ? {
      tableName: "privacy_subject_generations",
      pkV1: `pk:v1|1|i:${String(intent.subject_generation_id).length}:${intent.subject_generation_id}`,
    }
    : intent.target_kind === "resource_history"
    ? {
      tableName: "research_history_epochs",
      pkV1: `pk:v1|1|i:${String(intent.history_epoch_id).length}:${intent.history_epoch_id}`,
    }
    : null;
  const lifecycleSuccessorTable = intent.target_kind === "logical_page"
    ? "privacy_subject_generations"
    : intent.target_kind === "resource_history"
    ? "research_history_epochs"
    : null;
  const historyResourceGenerationId = intent.target_kind === "resource_history"
    ? Number(connection.prepare(`
      SELECT resource_generation_id FROM research_history_epochs
      WHERE id = ? AND resource_id = ? AND epoch_no = ? AND is_active = 1
    `).pluck().get(
      intent.history_epoch_id,
      intent.resource_id_snapshot,
      intent.history_epoch_no_snapshot,
    ))
    : null;
  if (intent.target_kind === "resource_history" &&
      !Number.isSafeInteger(historyResourceGenerationId)) {
    throw new Error("Schema26 privacy purge history successor provenance drifted");
  }
  const carryoverRows = connection.prepare(`
    SELECT intent_key, utc_date, budget_class, job_kind, workflow_id,
      workflow_version, coordinator_starts, provider_attempts,
      charged_cost_nanos, active_exposure_nanos, legacy25_day_block,
      state, payload_digest, frozen_at, activated_at
    FROM privacy_purge_budget_carryover_days
    WHERE intent_key = ? AND state = 'frozen'
    ORDER BY utc_date, budget_class, job_kind, workflow_id, workflow_version
  `).all(intent.intent_key) as Array<{
    intent_key: string;
    utc_date: string;
    budget_class: string;
    job_kind: string;
    workflow_id: string;
    workflow_version: number;
    coordinator_starts: number;
    provider_attempts: number;
    charged_cost_nanos: number;
    active_exposure_nanos: number;
    legacy25_day_block: number;
    state: "frozen";
    payload_digest: string;
    frozen_at: string;
    activated_at: null;
  }>;
  const carryoverParts = (row: typeof carryoverRows[number]): readonly unknown[] => [
    row.intent_key, row.utc_date, row.budget_class, row.job_kind,
    row.workflow_id, row.workflow_version, row.coordinator_starts,
    row.provider_attempts, row.charged_cost_nanos, row.active_exposure_nanos,
    row.legacy25_day_block, row.state, row.payload_digest, row.frozen_at,
    row.activated_at,
  ];
  assertPrivacyPurgeActionQuiescence(connection, intent.intent_key);
  const lease = createLease("terminal", {
    executor: [
      ...targets.map((row) => [
        intent.intent_key, commandId, row.table_name, row.pk_v1, "DELETE",
      ]),
      ...retirementTargets.map((row) => [
        intent.intent_key, commandId, "privacy_subject_generations",
        row.pk_v1, "UPDATE",
      ]),
      ...(lifecycleRootUpdate === null ? [] : [[
        intent.intent_key,
        commandId,
        lifecycleRootUpdate.tableName,
        lifecycleRootUpdate.pkV1,
        "UPDATE",
      ]]),
    ],
    executor_root: targets.filter((row) => rootTables.has(row.table_name)).flatMap(
      (row) => [
        [intent.intent_key, commandId, row.table_name, row.pk_v1, "DELETE"],
      ],
    ),
    receipt: [[
      intent.intent_key, "completed", "schema26", commandId,
      safeCountsJson, targets.length, intent.execution_plan_digest,
      intent.result_digest, waitTerminalDigest, completedAt,
    ]],
    carryover_activation: carryoverRows.map((row) => [
      ...carryoverParts(row),
      row.intent_key, row.utc_date, row.budget_class, row.job_kind,
      row.workflow_id, row.workflow_version, row.coordinator_starts,
      row.provider_attempts, row.charged_cost_nanos, row.active_exposure_nanos,
      row.legacy25_day_block, "active", row.payload_digest, row.frozen_at,
      completedAt,
    ]),
    execution_cleanup: targets.map((row) => [
      intent.intent_key, row.ordinal, row.table_name, row.pk_v1,
      row.delete_rank, row.live_action_depth, row.row_digest,
    ]),
    lifecycle_successor: lifecycleSuccessorTable === null ? [] : [[
      intent.intent_key,
      commandId,
      lifecycleSuccessorTable,
      "INSERT",
    ]],
    lifecycle_successor_shape: intent.target_kind === "logical_page" ? [[
      intent.intent_key,
      commandId,
      "logical_page",
      intent.subject_generation_id,
      intent.logical_page_id_snapshot,
      completedAt,
    ]] : intent.target_kind === "resource_history" ? [[
      intent.intent_key,
      commandId,
      "resource_history",
      intent.history_epoch_id,
      intent.resource_id_snapshot,
      historyResourceGenerationId,
      intent.history_epoch_no_snapshot,
      intent.history_epoch_no_snapshot! + 1,
      completedAt,
    ]] : [],
    transition: [[
      intent.intent_key, "committed", "completed",
      privacyPurgeSchema26TransitionDigest(
        intent.action_quiescence_digest,
        intent.execution_plan_digest,
      ),
    ]],
  }, [["terminal", intent.intent_key, commandId, intent.result_digest]]);
  state.executorInvocation = lease;
  try {
    executePrivacyPurgePlan(connection, {
      version: "privacy_purge_execution:v1",
      commandId,
      outcome: "completed",
      orderedTargets,
      tombstoneDigest: intent.tombstone_digest,
      safeCounts: { deleted_rows: targets.length },
      resultDigest: intent.result_digest,
      completedAt,
    });
    const unconsumed = [...lease.expected.values()].some((entries) =>
      entries.size !== 0
    ) || lease.attestations.size !== 0;
    if (unconsumed) {
      throw new Error("Privacy purge executor left exact capability unused");
    }
  } finally {
    if (state.executorInvocation === lease) state.executorInvocation = null;
  }
}

export interface PrivacyPurgeIntentStore {
  publishWaiting(input: PrivacyPurgeWaitingPublication): PublishedPrivacyPurgeIntent;
  reconcileActionWaits(
    intentKey: string,
    options: { readonly maxActions: number },
  ): { readonly intentKey: string; readonly processed: number; readonly remaining: number };
  abortStartedActionWait(
    intentKey: string,
    input: { readonly maxActions: number },
  ): Promise<PrivacyPurgeStartedActionAbortDrainResult>;
  reconcileJobWaits(
    intentKey: string,
    options: { readonly maxJobs: number },
  ): ReconciledPrivacyPurgeJobWaits;
  terminalizeJobWaits(
    intentKey: string,
    options: { readonly maxJobs: number },
  ): TerminalizedPrivacyPurgeJobWaits;
  terminalizeResourceResearchJobWaits(
    intentKey: string,
    options: { readonly maxJobs: number },
  ): TerminalizedPrivacyPurgeJobWaits;
  reconcileWaiting(
    intentKey: string,
    limit: PrivacyPurgeWaitingReconcileLimit,
  ): ReconciledPrivacyPurgeIntent;
  repairFinalSettlements(
    intentKey: string,
    limit: PrivacyPurgeWaitingReconcileLimit,
  ): Promise<RepairedPrivacyPurgeFinalSettlements>;
  freezeReady(intentKey: string): ReadyPrivacyPurgeIntent;
  linkReadyCommand(identity: PrivacyPurgeReadyCommandIdentity): number;
  executeCommitted(commandId: number): void;
}

function aiJobEventDigestSql(alias: "event" | "known"): string {
  return `tabhub_sha256_v1(json_object(
    'id', ${alias}.id, 'jobId', ${alias}.job_id,
    'sequenceNo', ${alias}.sequence_no, 'eventType', ${alias}.event_type,
    'fromStatus', ${alias}.from_status, 'toStatus', ${alias}.to_status,
    'attemptId', ${alias}.attempt_id, 'leaseOwner', ${alias}.lease_owner,
    'leaseToken', ${alias}.lease_token,
    'leaseExpiresAt', ${alias}.lease_expires_at,
    'progressCompleted', ${alias}.progress_completed,
    'progressTotal', ${alias}.progress_total,
    'progressStage', ${alias}.progress_stage,
    'checkpointJson', ${alias}.checkpoint_json,
    'cancellationRequestedBy', ${alias}.cancellation_requested_by,
    'resultType', ${alias}.result_type,
    'resultOutputFingerprint', ${alias}.result_output_fingerprint,
    'resultReportId', ${alias}.result_report_id,
    'errorCode', ${alias}.error_code, 'availableAt', ${alias}.available_at,
    'spentSteps', ${alias}.spent_steps, 'spentTokens', ${alias}.spent_tokens,
    'spentInputTokens', ${alias}.spent_input_tokens,
    'spentOutputTokens', ${alias}.spent_output_tokens,
    'deltaInputTokens', ${alias}.delta_input_tokens,
    'deltaOutputTokens', ${alias}.delta_output_tokens,
    'deltaCostUsd', ${alias}.delta_cost_usd,
    'deltaSteps', ${alias}.delta_steps,
    'deltaWallTimeMs', ${alias}.delta_wall_time_ms,
    'spentCostUsd', ${alias}.spent_cost_usd,
    'spentWallTimeMs', ${alias}.spent_wall_time_ms,
    'occurredAt', ${alias}.occurred_at
  ))`;
}

function adoptPrivacyPurgeSettledJobWaits(
  connection: Database.Database,
  intentKey: string,
  maxJobs: number,
  jobIds?: readonly number[],
): ReconciledPrivacyPurgeJobWaits {
  const waiting = connection.prepare(`
        SELECT 1 FROM privacy_purge_intents
        WHERE intent_key = ? AND status = 'waiting'
      `).get(intentKey);
      if (waiting === undefined) throw new Error("PURGE_SUBJECT_BUSY");
      const waits = connection.prepare(`
        SELECT wait.ordinal, wait.job_id, wait.row_digest, wait.event_sequence,
          wait.attempt_id, wait.lease_token_digest, wait.request_bound,
          wait.settlement_deadline_at, wait.provider_reservation_id,
          job.status AS terminal_status,
          job.event_sequence AS terminal_event_sequence,
          job.updated_at AS terminal_at,
          attempt.outcome AS terminal_attempt_outcome,
          CASE WHEN reservation.id IS NULL THEN 'none'
            ELSE reservation.status END AS terminal_reservation_state,
          intent.settlement_proof_generation
        FROM privacy_purge_intent_job_waits AS wait
        JOIN privacy_purge_intents AS intent ON intent.intent_key = wait.intent_key
        JOIN ai_jobs AS job ON job.id = wait.job_id
        JOIN ai_job_events AS terminal_event
          ON terminal_event.job_id = job.id
          AND terminal_event.sequence_no = job.event_sequence
          AND terminal_event.event_type IN ('failed', 'cancelled')
          AND terminal_event.to_status = job.status
          AND terminal_event.occurred_at = job.updated_at
        LEFT JOIN ai_job_attempts AS attempt ON attempt.id = wait.attempt_id
        LEFT JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.id = wait.provider_reservation_id
        WHERE wait.intent_key = @intentKey AND wait.terminal_status IS NULL
          AND (@jobIdsJson IS NULL OR wait.job_id IN (
            SELECT CAST(value AS INTEGER) FROM json_each(@jobIdsJson)
          ))
          AND job.status IN ('failed', 'cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM ai_job_events AS newer
            WHERE newer.job_id = job.id
              AND newer.sequence_no > terminal_event.sequence_no
          )
          AND (wait.request_bound = 0 OR EXISTS (
            SELECT 1 FROM ai_job_events AS known_usage
            WHERE known_usage.job_id = wait.job_id
              AND known_usage.attempt_id = wait.attempt_id
              AND known_usage.event_type = 'progress'
              AND known_usage.sequence_no > wait.event_sequence
              AND known_usage.sequence_no < terminal_event.sequence_no
              AND known_usage.delta_steps > 0
              AND known_usage.occurred_at <= wait.settlement_deadline_at
              AND tabhub_sha256_v1(known_usage.lease_token)
                = wait.lease_token_digest
          ))
          AND ((wait.attempt_id IS NULL AND attempt.id IS NULL)
            OR (attempt.id = wait.attempt_id AND attempt.job_id = wait.job_id
              AND attempt.outcome <> 'running'))
          AND ((wait.provider_reservation_id IS NULL AND reservation.id IS NULL)
            OR (reservation.id = wait.provider_reservation_id
              AND reservation.final_job_id = wait.job_id
              AND reservation.status IN ('released', 'consumed')))
        ORDER BY wait.ordinal, wait.job_id
        LIMIT @maxJobs
      `).all({
        intentKey,
        maxJobs,
        jobIdsJson: jobIds === undefined ? null : JSON.stringify(jobIds),
      }) as Array<Row>;
      const selectTerminalEventDigest = connection.prepare(`
        SELECT ${aiJobEventDigestSql("event")} FROM ai_job_events AS event
        WHERE event.job_id = ? AND event.sequence_no = ?
      `).pluck();
      const selectTerminalUsageDigest = connection.prepare(`
        SELECT tabhub_sha256_v1(json_object(
          'attemptId', attempt.id, 'attemptJobId', attempt.job_id,
          'attemptNo', attempt.attempt_no, 'attemptLeaseToken', attempt.lease_token,
          'workerId', attempt.worker_id, 'provider', attempt.provider,
          'model', attempt.model, 'promptVersion', attempt.prompt_version,
          'providerBoundAt', attempt.provider_bound_at,
          'requestId', attempt.request_id,
          'requestBoundAt', attempt.request_bound_at,
          'attemptStartedAt', attempt.started_at,
          'attemptCompletedAt', attempt.completed_at,
          'attemptOutcome', attempt.outcome,
          'inputTokens', attempt.input_tokens,
          'outputTokens', attempt.output_tokens, 'costUsd', attempt.cost_usd,
          'attemptErrorCode', attempt.error_code,
          'attemptErrorMessage', attempt.error_message,
          'pricingVersion', attempt.pricing_version,
          'reservationId', reservation.id,
          'handoffId', reservation.handoff_id,
          'reservationFinalJobId', reservation.final_job_id,
          'utcDate', reservation.utc_date,
          'reservedUsd', reservation.reserved_usd,
          'consumedUsd', reservation.consumed_usd,
          'reservationStatus', reservation.status,
          'reservationCreatedAt', reservation.created_at,
          'reservationTerminalAt', reservation.terminal_at,
          'knownUsageEventDigest', (
            SELECT ${aiJobEventDigestSql("known")}
            FROM ai_job_events AS known
            WHERE known.job_id = @jobId AND known.attempt_id = @attemptId
              AND known.event_type = 'progress'
              AND known.sequence_no > @eventSequence
              AND known.sequence_no < @terminalEventSequence
              AND known.delta_steps > 0
              AND known.occurred_at <= @settlementDeadlineAt
              AND tabhub_sha256_v1(known.lease_token) = @leaseTokenDigest
            ORDER BY known.sequence_no DESC LIMIT 1
          )
        ))
        FROM (SELECT 1) AS anchor
        LEFT JOIN ai_job_attempts AS attempt ON attempt.id = @attemptId
        LEFT JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.id = @providerReservationId
      `).pluck();
      const updateWait = connection.prepare(`
        UPDATE privacy_purge_intent_job_waits
        SET terminal_status = @terminalStatus,
          terminal_event_sequence = @terminalEventSequence,
          terminal_attempt_outcome = @terminalAttemptOutcome,
          terminal_usage_digest = @terminalUsageDigest,
          terminal_proof_digest = @terminalProofDigest,
          terminal_reservation_state = @terminalReservationState,
          terminal_at = @terminalAt
        WHERE intent_key = @intentKey AND ordinal = @ordinal
          AND terminal_status IS NULL
      `);
      for (const wait of waits) {
        const terminalEventDigest = String(selectTerminalEventDigest.get(
          wait.job_id,
          wait.terminal_event_sequence,
        ));
        const terminalUsageDigest = String(selectTerminalUsageDigest.get({
          jobId: wait.job_id,
          attemptId: wait.attempt_id,
          providerReservationId: wait.provider_reservation_id,
          eventSequence: wait.event_sequence,
          terminalEventSequence: wait.terminal_event_sequence,
          settlementDeadlineAt: wait.settlement_deadline_at,
          leaseTokenDigest: wait.lease_token_digest,
        }));
        const terminalProofDigest = rowDigest({
          intentKey,
          ordinal: wait.ordinal,
          rowDigest: wait.row_digest,
          terminalStatus: wait.terminal_status,
          terminalEventSequence: wait.terminal_event_sequence,
          terminalEventDigest,
          terminalAttemptOutcome: wait.terminal_attempt_outcome,
          terminalUsageDigest,
          terminalReservationState: wait.terminal_reservation_state,
          settlementProofGeneration: wait.settlement_proof_generation,
          terminalAt: wait.terminal_at,
        });
        addExpected(connection, "job_terminal", [
          intentKey,
          wait.ordinal,
          wait.job_id,
          wait.row_digest,
          wait.terminal_status,
          wait.terminal_event_sequence,
          wait.terminal_attempt_outcome,
          terminalUsageDigest,
          wait.terminal_reservation_state,
          wait.terminal_at,
          terminalProofDigest,
        ]);
        const updated = updateWait.run({
          intentKey,
          ordinal: wait.ordinal,
          terminalStatus: wait.terminal_status,
          terminalEventSequence: wait.terminal_event_sequence,
          terminalAttemptOutcome: wait.terminal_attempt_outcome,
          terminalUsageDigest,
          terminalProofDigest,
          terminalReservationState: wait.terminal_reservation_state,
          terminalAt: wait.terminal_at,
        });
        if (updated.changes !== 1) throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const remaining = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? AND terminal_status IS NULL
      `).pluck().get(intentKey));
  return { intentKey, processed: waits.length, remaining };
}

function reconcilePrivacyPurgeJobWaits(
  connection: Database.Database,
  intentKey: string,
  maxJobs: number,
): ReconciledPrivacyPurgeJobWaits {
  return runOwnedTransaction(
    connection,
    () => createLease("terminal", {}, []),
    () => adoptPrivacyPurgeSettledJobWaits(connection, intentKey, maxJobs),
  );
}

function terminalizePrivacyPurgeJobWaitsAt(
  connection: Database.Database,
  intentKey: string,
  maxJobs: number,
  at: string,
): TerminalizedPrivacyPurgeJobWaits {
  return runOwnedTransaction(
    connection,
    () => createLease("terminal", {}, []),
    () => {
      const intent = connection.prepare(`
        SELECT updated_at FROM privacy_purge_intents
        WHERE intent_key = ? AND status = 'waiting'
      `).get(intentKey) as { updated_at: string } | undefined;
      if (intent === undefined) throw new Error("PURGE_SUBJECT_BUSY");
      assertPrivacyPurgeClockNotRegressed(at, intent.updated_at);
      const waits = connection.prepare(`
        SELECT wait.ordinal, wait.job_id, wait.status, wait.event_sequence,
          wait.cancellation_requested_by, wait.cancellation_requested_at,
          wait.cancellation_snapshot_digest, wait.attempt_id, wait.attempt_no,
          wait.worker_id, wait.lease_token_digest, wait.lease_expires_at,
          wait.provider_reservation_id,
          job.kind, job.status, job.event_sequence AS current_event_sequence,
          job.cancellation_requested_by AS current_cancellation_requested_by,
          job.cancellation_requested_at AS current_cancellation_requested_at,
          job.lease_owner, job.lease_token, job.lease_expires_at AS current_lease_expires_at,
          attempt.attempt_no AS current_attempt_no,
          attempt.worker_id AS current_worker_id,
          attempt.lease_token AS current_attempt_lease_token,
          attempt.outcome AS current_attempt_outcome
        FROM privacy_purge_intent_job_waits AS wait
        JOIN ai_jobs AS job ON job.id = wait.job_id
        LEFT JOIN ai_job_attempts AS attempt ON attempt.id = wait.attempt_id
        WHERE wait.intent_key = @intentKey AND wait.terminal_status IS NULL
          AND wait.request_bound = 0 AND wait.lease_expires_at <= @at
          AND job.kind = 'priority_assessment'
        ORDER BY wait.ordinal, wait.job_id
        LIMIT @maxJobs
      `).all({ intentKey, at, maxJobs }) as Array<Row>;
      const authorizeOwnedMutation = (mutation: AiJobOwnedMutation): void => {
        if (mutation.operation === "INSERT") {
          addExpected(connection, "drain_insert", [
            intentKey,
            mutation.tableName,
            mutation.newPkV1,
            mutationRowDigest(connection, mutation),
          ]);
        } else {
          addExpected(connection, "drain", [
            intentKey,
            mutation.tableName,
            mutation.operation,
            mutation.oldPkV1,
            mutation.newPkV1,
          ]);
        }
      };
      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        kindAvailable: (kind) => kind === "priority_assessment",
        transactionBound: true,
        authorizeOwnedMutation,
      });
      const terminalizedIds: number[] = [];
      for (const wait of waits) {
        const cancellationSnapshotDigest = rowDigest({
          intentKey,
          jobId: wait.job_id,
          eventSequence: wait.event_sequence,
          cancellationRequestedBy: wait.cancellation_requested_by,
          cancellationRequestedAt: wait.cancellation_requested_at,
        });
        const exact = wait.status === "running" &&
          wait.attempt_id !== null && wait.attempt_no !== null &&
          wait.worker_id !== null && wait.lease_token_digest !== null &&
          wait.lease_expires_at !== null &&
          wait.current_event_sequence === wait.event_sequence &&
          wait.current_cancellation_requested_by === wait.cancellation_requested_by &&
          wait.current_cancellation_requested_at === wait.cancellation_requested_at &&
          wait.cancellation_snapshot_digest === cancellationSnapshotDigest &&
          wait.lease_owner === wait.worker_id &&
          wait.current_lease_expires_at === wait.lease_expires_at &&
          wait.current_attempt_no === wait.attempt_no &&
          wait.current_worker_id === wait.worker_id &&
          wait.current_attempt_lease_token === wait.lease_token &&
          wait.current_attempt_outcome === "running" &&
          sha256(String(wait.lease_token)) === wait.lease_token_digest;
        const hasResearchRun = connection.prepare(`
          SELECT 1 FROM research_runs WHERE job_id = ?
        `).get(wait.job_id) !== undefined;
        const hasActiveReservation = connection.prepare(`
          SELECT 1 FROM live_acquisition_provider_reservations
          WHERE final_job_id = ? AND status = 'active'
        `).get(wait.job_id) !== undefined;
        if (!exact || hasResearchRun || hasActiveReservation ||
            wait.provider_reservation_id !== null) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
        const cancellation: AiJobExpiredCancellation = {
          id: Number(wait.job_id),
          kind: "priority_assessment",
          attemptId: Number(wait.attempt_id),
          attemptNo: Number(wait.attempt_no),
          workerId: String(wait.worker_id),
          leaseToken: String(wait.lease_token),
          leaseExpiresAt: String(wait.lease_expires_at),
        };
        ledger.settleExpiredCancellation(cancellation);
        terminalizedIds.push(cancellation.id);
      }
      const adopted = terminalizedIds.length === 0
        ? { intentKey, processed: 0, remaining: Number(connection.prepare(`
            SELECT COUNT(*) FROM privacy_purge_intent_job_waits
            WHERE intent_key = ? AND terminal_status IS NULL
          `).pluck().get(intentKey)) }
        : adoptPrivacyPurgeSettledJobWaits(
            connection,
            intentKey,
            terminalizedIds.length,
            terminalizedIds,
          );
      if (adopted.processed !== terminalizedIds.length) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      return {
        intentKey,
        terminalized: terminalizedIds.length,
        adopted: adopted.processed,
        remaining: adopted.remaining,
      };
    },
  );
}

function terminalizePrivacyPurgeResourceResearchJobWaitsAt(
  connection: Database.Database,
  intentKey: string,
  maxJobs: number,
  at: string,
): TerminalizedPrivacyPurgeJobWaits {
  return runOwnedTransaction(
    connection,
    () => createLease("terminal", {}, []),
    () => {
      const intent = connection.prepare(`
        SELECT updated_at, target_kind FROM privacy_purge_intents
        WHERE intent_key = ? AND status = 'waiting'
      `).get(intentKey) as { updated_at: string; target_kind: string } | undefined;
      if (intent === undefined) throw new Error("PURGE_SUBJECT_BUSY");
      assertPrivacyPurgeClockNotRegressed(at, intent.updated_at);
      const waits = connection.prepare(`
        SELECT wait.ordinal, wait.job_id, wait.status, wait.event_sequence,
          wait.cancellation_requested_by, wait.cancellation_requested_at,
          wait.cancellation_snapshot_digest, wait.attempt_id, wait.attempt_no,
          wait.worker_id, wait.lease_token_digest, wait.lease_expires_at,
          wait.request_bound, wait.request_id_digest, wait.request_bound_at,
          wait.provider_reservation_id,
          wait.provider_reservation_utc_date, wait.provider_reserved_usd,
          wait.provider_consumed_usd, wait.provider_reservation_status,
          job.kind, job.workflow_id, job.workflow_version,
          job.status, job.event_sequence AS current_event_sequence,
          job.cancellation_requested_by AS current_cancellation_requested_by,
          job.cancellation_requested_at AS current_cancellation_requested_at,
          job.lease_owner, job.lease_token,
          job.lease_expires_at AS current_lease_expires_at,
          run.id AS run_id, head.status AS run_status,
          attempt.attempt_no AS current_attempt_no,
          attempt.worker_id AS current_worker_id,
          attempt.lease_token AS current_attempt_lease_token,
          attempt.outcome AS current_attempt_outcome,
          attempt.request_id AS current_request_id,
          attempt.request_bound_at AS current_request_bound_at,
          handoff.id AS handoff_id, handoff.status AS handoff_status,
          reservation.id AS current_reservation_id,
          reservation.utc_date AS current_reservation_utc_date,
          reservation.reserved_usd AS current_reserved_usd,
          reservation.consumed_usd AS current_consumed_usd,
          reservation.status AS current_reservation_status,
          consent.id AS consent_id,
          consent.status AS consent_status,
          consent.coordinator_run_generation_id AS coordinator_run_generation_id,
          target.is_root AS target_is_root,
          target.handoff_id AS target_handoff_id,
          target.handoff_status AS target_handoff_status,
          target.subject_generation_id AS target_subject_generation_id,
          target.generation_token AS target_generation_token,
          target_generation.id AS current_target_generation_id,
          target_generation.subject_kind AS current_target_subject_kind,
          target_generation.generation_token AS current_target_generation_token,
          target_generation.research_run_id AS current_target_research_run_id,
          target_generation.is_active AS current_target_is_active
        FROM privacy_purge_intent_job_waits AS wait
        LEFT JOIN ai_jobs AS job ON job.id = wait.job_id
        LEFT JOIN research_runs AS run ON run.job_id = job.id
        LEFT JOIN research_run_heads AS head ON head.run_id = run.id
        LEFT JOIN ai_job_attempts AS attempt
          ON attempt.id = wait.attempt_id AND attempt.job_id = job.id
        LEFT JOIN privacy_purge_intent_run_targets AS target
          ON target.intent_key = wait.intent_key
          AND target.research_run_id = run.id
          AND target.ai_job_id = job.id
        LEFT JOIN privacy_subject_generations AS target_generation
          ON target_generation.id = target.subject_generation_id
        LEFT JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
        LEFT JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.id = wait.provider_reservation_id
        LEFT JOIN live_acquisition_consents AS consent
          ON consent.coordinator_job_id = job.id
          AND consent.coordinator_run_generation_id = target_generation.id
        WHERE wait.intent_key = @intentKey AND wait.terminal_status IS NULL
          AND wait.status = 'running'
          AND wait.lease_expires_at <= @at
          AND (job.kind = 'resource_research' OR job.id IS NULL)
        ORDER BY wait.ordinal, wait.job_id
        LIMIT @maxJobs
      `).all({ intentKey, at, maxJobs }) as Array<Row>;
      const classified = waits.map((wait) => {
        const cancellationSnapshotDigest = rowDigest({
          intentKey,
          jobId: wait.job_id,
          eventSequence: wait.event_sequence,
          cancellationRequestedBy: wait.cancellation_requested_by,
          cancellationRequestedAt: wait.cancellation_requested_at,
        });
        const targetAnchorExact = wait.current_target_generation_id ===
            wait.target_subject_generation_id &&
          wait.current_target_subject_kind === "research_run" &&
          wait.current_target_generation_token === wait.target_generation_token &&
          wait.current_target_research_run_id === wait.run_id &&
          wait.current_target_is_active === 1;
        const directC81 = wait.workflow_id === "research_workflow:c81:v1" &&
          wait.workflow_version === 1 && wait.handoff_id === null &&
          wait.consent_id === null && wait.provider_reservation_id === null &&
          wait.target_handoff_id === null && wait.target_handoff_status === null &&
          ((["run", "logical_page"].includes(intent.target_kind) &&
              wait.target_is_root === 1) ||
            (intent.target_kind === "resource_history" && wait.target_is_root === 0));
        const c90Final = wait.workflow_id === "research_workflow:c81:v1" &&
          wait.workflow_version === 1 && wait.handoff_id !== null &&
          wait.handoff_status === "completed" && wait.consent_id === null &&
          wait.target_is_root === 0 && wait.target_handoff_id === wait.handoff_id &&
          wait.target_handoff_status === wait.handoff_status;
        const c90Coordinator = wait.workflow_id === "research_acquisition:c90:v1" &&
          wait.workflow_version === 1 && wait.handoff_id === null &&
          wait.consent_id !== null && wait.consent_status === "active" &&
          wait.coordinator_run_generation_id !== null &&
          wait.provider_reservation_id === null && wait.target_is_root === 1 &&
          wait.target_handoff_id === null && wait.target_handoff_status === null &&
          ["run", "logical_page"].includes(intent.target_kind);
        const exact = wait.kind === "resource_research" && wait.job_id !== null &&
          wait.run_id !== null && wait.run_status === "running" &&
          targetAnchorExact && wait.current_event_sequence === wait.event_sequence &&
          wait.current_cancellation_requested_by === wait.cancellation_requested_by &&
          wait.current_cancellation_requested_at === wait.cancellation_requested_at &&
          wait.cancellation_requested_by === "user" &&
          wait.cancellation_requested_at !== null &&
          wait.cancellation_snapshot_digest === cancellationSnapshotDigest &&
          wait.attempt_id !== null && wait.attempt_no !== null &&
          wait.worker_id !== null && wait.lease_token_digest !== null &&
          wait.lease_expires_at !== null && wait.lease_owner === wait.worker_id &&
          wait.current_lease_expires_at === wait.lease_expires_at &&
          wait.current_attempt_no === wait.attempt_no &&
          wait.current_worker_id === wait.worker_id &&
          wait.current_attempt_lease_token === wait.lease_token &&
          wait.current_attempt_outcome === "running" &&
          ((wait.request_bound === 0 && wait.current_request_id === null &&
              wait.current_request_bound_at === null) ||
            (wait.request_bound === 1 && wait.current_request_id !== null &&
              sha256(String(wait.current_request_id)) === wait.request_id_digest &&
              wait.current_request_bound_at === wait.request_bound_at)) &&
          sha256(String(wait.lease_token)) === wait.lease_token_digest;
        let barrier: "safety" | "request_bound" | "action" | "reservation" | null = null;
        if (!exact || (!directC81 && !c90Final && !c90Coordinator)) {
          barrier = "safety";
        } else if (wait.request_bound !== 0) {
          barrier = "request_bound";
        } else if (c90Coordinator) {
          const pendingActions = Number(connection.prepare(`
            SELECT COUNT(*) FROM privacy_purge_intent_action_waits
            WHERE intent_key = ? AND terminal_state IS NULL
          `).pluck().get(intentKey));
          const existingOutcome = connection.prepare(`
            SELECT 1 FROM live_acquisition_workflow_outcomes
            WHERE coordinator_job_id = ?
          `).get(wait.job_id);
          if (pendingActions !== 0) barrier = "action";
          else if (existingOutcome !== undefined) barrier = "safety";
        }
        if (barrier === null && c90Final) {
          const reservationExact = wait.provider_reservation_id !== null &&
            wait.current_reservation_id === wait.provider_reservation_id &&
            wait.current_reservation_utc_date === wait.provider_reservation_utc_date &&
            wait.current_reserved_usd === wait.provider_reserved_usd &&
            wait.current_consumed_usd === wait.provider_consumed_usd &&
            wait.current_reservation_status === wait.provider_reservation_status &&
            wait.current_reservation_status === "active";
          if (!reservationExact) barrier = "reservation";
        }
        return { wait, directC81, c90Final, c90Coordinator, barrier };
      });
      const barrierIndex = classified.findIndex((candidate) => candidate.barrier !== null);
      if (barrierIndex === 0) {
        if (classified[0]!.barrier === "action") throw new Error("PURGE_WAITING_FOR_ACTION");
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const eligible = barrierIndex < 0 ? classified : classified.slice(0, barrierIndex);
      const authorizeOwnedMutation = (mutation: AiJobOwnedMutation): void => {
        if (mutation.operation === "INSERT") {
          addExpected(connection, "drain_insert", [
            intentKey,
            mutation.tableName,
            mutation.newPkV1,
            mutationRowDigest(connection, mutation),
          ]);
        } else {
          addExpected(connection, "drain", [
            intentKey,
            mutation.tableName,
            mutation.operation,
            mutation.oldPkV1,
            mutation.newPkV1,
          ]);
        }
      };
      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        kindAvailable: (kind) => kind === "resource_research",
        transactionBound: true,
        authorizeOwnedMutation,
      });
      const terminalizedIds: number[] = [];
      for (const candidate of eligible) {
        const { wait, c90Final, c90Coordinator } = candidate;
        const aiEventId = Number(connection.prepare(`
          SELECT COALESCE(MAX(id), 0) + 1 FROM ai_job_events
        `).pluck().get());
        const researchEventId = Number(connection.prepare(`
          SELECT COALESCE(MAX(id), 0) + 1 FROM research_run_events
        `).pluck().get());
        const researchSequence = Number(connection.prepare(`
          SELECT COALESCE(MAX(sequence_no), 0) + 1
          FROM research_run_events WHERE run_id = ?
        `).pluck().get(wait.run_id));
        const researchEventRow = {
          id: researchEventId,
          run_id: wait.run_id,
          sequence_no: researchSequence,
          event_type: "cancelled",
          status: "cancelled",
          report_id: null,
          idempotency_key: `ai-job-event:${aiEventId}`,
          occurred_at: at,
        };
        addExpected(connection, "drain_insert", [
          intentKey,
          "research_run_events",
          integerPk(researchEventId),
          mutationRowDigest(connection, {
            tableName: "research_run_events",
            newRow: researchEventRow,
          }),
        ]);
        if (c90Final) {
          addExpected(connection, "drain", [
            intentKey,
            "live_acquisition_provider_reservations",
            "UPDATE",
            integerPk(Number(wait.provider_reservation_id)),
            integerPk(Number(wait.provider_reservation_id)),
          ]);
        }
        const cancellation: AiJobExpiredCancellation = {
          id: Number(wait.job_id),
          kind: "resource_research",
          attemptId: Number(wait.attempt_id),
          attemptNo: Number(wait.attempt_no),
          workerId: String(wait.worker_id),
          leaseToken: String(wait.lease_token),
          leaseExpiresAt: String(wait.lease_expires_at),
        };
        ledger.settleExpiredCancellation(cancellation);
        if (c90Coordinator) {
          const outcomeId = Number(connection.prepare(`
            SELECT COALESCE(MAX(id), 0) + 1 FROM live_acquisition_workflow_outcomes
          `).pluck().get());
          const details = JSON.stringify({
            outcome_class: "cancelled",
            attempt_count: 1,
          });
          const outcomeRow = {
            id: outcomeId,
            coordinator_job_id: wait.job_id,
            coordinator_run_generation_id: wait.coordinator_run_generation_id,
            outcome: "blocked",
            outcome_code: "WORKFLOW_CANCELLED",
            safe_details_json: details,
            created_at: at,
          };
          addExpected(connection, "drain_insert", [
            intentKey,
            "live_acquisition_workflow_outcomes",
            integerPk(outcomeId),
            mutationRowDigest(connection, {
              tableName: "live_acquisition_workflow_outcomes",
              newRow: outcomeRow,
            }),
          ]);
          connection.prepare(`
            INSERT INTO live_acquisition_workflow_outcomes (
              id, coordinator_job_id, coordinator_run_generation_id,
              outcome, outcome_code, safe_details_json, created_at
            ) VALUES (?, ?, ?, 'blocked', 'WORKFLOW_CANCELLED', ?, ?)
          `).run(
            outcomeId,
            wait.job_id,
            wait.coordinator_run_generation_id,
            details,
            at,
          );
          addExpected(connection, "drain", [
            intentKey,
            "live_acquisition_consents",
            "UPDATE",
            integerPk(Number(wait.consent_id)),
            integerPk(Number(wait.consent_id)),
          ]);
          const revoked = connection.prepare(`
            UPDATE live_acquisition_consents
            SET status = 'revoked', terminal_at = ?
            WHERE id = ? AND status = 'active'
          `).run(at, wait.consent_id);
          if (revoked.changes !== 1) throw new Error("PURGE_INVARIANT_VIOLATION");
        }
        terminalizedIds.push(cancellation.id);
      }
      const adopted = terminalizedIds.length === 0
        ? { intentKey, processed: 0, remaining: Number(connection.prepare(`
            SELECT COUNT(*) FROM privacy_purge_intent_job_waits
            WHERE intent_key = ? AND terminal_status IS NULL
          `).pluck().get(intentKey)) }
        : adoptPrivacyPurgeSettledJobWaits(
            connection,
            intentKey,
            terminalizedIds.length,
            terminalizedIds,
          );
      if (adopted.processed !== terminalizedIds.length) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      return {
        intentKey,
        terminalized: terminalizedIds.length,
        adopted: adopted.processed,
        remaining: adopted.remaining,
      };
    },
  );
}

function integerPk(value: number): string {
  const text = String(value);
  return `pk:v1|1|i:${text.length}:${text}`;
}

function mutationRowDigest(
  connection: Database.Database,
  mutation: {
    readonly tableName: string;
    readonly newRow?: Readonly<Record<string, unknown>>;
  },
): string {
  if (mutation.newRow === undefined) {
    throw new Error("Privacy purge INSERT mutation lost its exact row");
  }
  const columnRows = connection.pragma(
    `table_info(${mutation.tableName})`,
  ) as Array<{ name: string; type: string }>;
  const columns = columnRows.map(({ name }) => name);
  if (columns.some((column) => !(column in mutation.newRow!))) {
    throw new Error("Privacy purge INSERT mutation row is incomplete");
  }
  const jsonArguments = columnRows.flatMap((column) => [
    `'${column.name.replaceAll("'", "''")}'`,
    column.type === "INTEGER" ? "CAST(? AS INTEGER)" :
      column.type === "REAL" ? "CAST(? AS REAL)" : "?",
  ]).join(", ");
  return String(connection.prepare(`
    SELECT tabhub_sha256_v1(json_object(${jsonArguments}))
  `).pluck().get(...columns.map((column) => mutation.newRow![column])));
}

function reconcilePrivacyPurgeActionWaitsAt(
  connection: Database.Database,
  intentKey: string,
  maxActions: number,
  at: string,
): { readonly intentKey: string; readonly processed: number; readonly remaining: number } {
  return runOwnedTransaction(
    connection,
    () => createLease("terminal", {}, []),
    () => {
      const intent = connection.prepare(`
        SELECT updated_at, action_quiescence_digest FROM privacy_purge_intents
        WHERE intent_key = ? AND status = 'waiting'
      `).get(intentKey) as {
        updated_at: string;
        action_quiescence_digest: string;
      } | undefined;
      if (intent === undefined) throw new Error("PURGE_SUBJECT_BUSY");
      assertPrivacyPurgeClockNotRegressed(at, intent.updated_at);
      const currentQuiescenceDigest = String(connection.prepare(`
        SELECT tabhub_sha256_v1(COALESCE((
          SELECT json_group_array(quiescence_snapshot_digest) FROM (
            SELECT quiescence_snapshot_digest
            FROM privacy_purge_intent_action_waits
            WHERE intent_key = ? ORDER BY ordinal
          )
        ), '[]'))
      `).pluck().get(intentKey));
      if (currentQuiescenceDigest !== intent.action_quiescence_digest) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const waits = connection.prepare(`
        SELECT wait.ordinal, wait.action_id, wait.row_digest,
          action.state, action.sequence_no, action.created_at,
          action.terminal_at, action.runtime_epoch, wait.deadline_at,
          wait.resolution_start_sequence_no,
          wait.resolution_start_event_digest, wait.resolution_started_at,
          wait.resolution_deadline_at, wait.quiescence_snapshot_digest,
          start_event.id AS resolution_event_id,
          start_event.action_id AS resolution_event_action_id,
          start_event.sequence_no AS resolution_event_sequence_no,
          start_event.from_state AS resolution_event_from_state,
          start_event.to_state AS resolution_event_to_state,
          start_event.outcome_code AS resolution_event_outcome_code,
          start_event.safe_details_json AS resolution_event_safe_details_json,
          start_event.occurred_at AS resolution_event_occurred_at,
          runtime.runtime_epoch AS current_runtime_epoch
        FROM privacy_purge_intent_action_waits AS wait
        JOIN live_acquisition_actions AS action ON action.id = wait.action_id
        LEFT JOIN live_acquisition_action_events AS start_event
          ON start_event.action_id = wait.action_id
          AND start_event.sequence_no = wait.resolution_start_sequence_no
        JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
        WHERE wait.intent_key = ? AND wait.terminal_state IS NULL
          AND (
            action.state IN (
              'planned', 'resolved', 'authorized', 'completed', 'blocked', 'ambiguous'
            )
            OR (action.state = 'resolution_started' AND (
              action.runtime_epoch < runtime.runtime_epoch
              OR (wait.resolution_deadline_at IS NOT NULL
                AND wait.resolution_deadline_at <= ?)
            ))
          )
        ORDER BY wait.ordinal, wait.action_id LIMIT ?
      `).all(intentKey, at, maxActions) as Array<{
        ordinal: number;
        action_id: number;
        row_digest: string;
        state: "planned" | "resolution_started" | "resolved" | "authorized" |
          "completed" | "blocked" | "ambiguous";
        sequence_no: number;
        created_at: string;
        terminal_at: string | null;
        runtime_epoch: number;
        deadline_at: string | null;
        resolution_start_sequence_no: number | null;
        resolution_start_event_digest: string | null;
        resolution_started_at: string | null;
        resolution_deadline_at: string | null;
        quiescence_snapshot_digest: string;
        resolution_event_id: number | null;
        resolution_event_action_id: number | null;
        resolution_event_sequence_no: number | null;
        resolution_event_from_state: string | null;
        resolution_event_to_state: string | null;
        resolution_event_outcome_code: string | null;
        resolution_event_safe_details_json: string | null;
        resolution_event_occurred_at: string | null;
        current_runtime_epoch: number;
      }>;
      for (const wait of waits) {
        if (wait.state !== "resolution_started") continue;
        const eventDigest = rowDigest({
          id: wait.resolution_event_id,
          actionId: wait.resolution_event_action_id,
          sequenceNo: wait.resolution_event_sequence_no,
          fromState: wait.resolution_event_from_state,
          toState: wait.resolution_event_to_state,
          outcomeCode: wait.resolution_event_outcome_code,
          safeDetailsJson: wait.resolution_event_safe_details_json,
          occurredAt: wait.resolution_event_occurred_at,
        });
        const snapshotDigest = rowDigest({
          intentKey,
          ordinal: wait.ordinal,
          rowDigest: wait.row_digest,
          resolutionStartSequenceNo: wait.resolution_start_sequence_no,
          resolutionStartEventDigest: wait.resolution_start_event_digest,
          resolutionStartedAt: wait.resolution_started_at,
          resolutionDeadlineAt: wait.resolution_deadline_at,
        });
        if (wait.resolution_event_action_id !== wait.action_id ||
            wait.resolution_event_sequence_no !== wait.resolution_start_sequence_no ||
            wait.resolution_event_from_state !== "planned" ||
            wait.resolution_event_to_state !== "resolution_started" ||
            wait.resolution_event_occurred_at !== wait.resolution_started_at ||
            eventDigest !== wait.resolution_start_event_digest ||
            snapshotDigest !== wait.quiescence_snapshot_digest) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
      }
      const authorizeOwnedMutation = (mutation: LiveAcquisitionOwnedMutation): void => {
        if (mutation.operation === "INSERT") {
          addExpected(connection, "drain_insert", [
            intentKey,
            mutation.tableName,
            mutation.newPkV1,
            mutationRowDigest(connection, mutation),
          ]);
        } else {
          addExpected(connection, "drain", [
            intentKey,
            mutation.tableName,
            mutation.operation,
            mutation.oldPkV1,
            mutation.newPkV1,
          ]);
        }
      };
      const actionLedger = createLiveAcquisitionActionLedger(connection, {
        clock: () => new Date(at),
        transactionBound: true,
        authorizeOwnedMutation,
      });
      const terminalEvent = connection.prepare(`
        SELECT event.id, event.action_id, event.sequence_no, event.from_state,
          event.to_state, event.outcome_code, event.safe_details_json,
          event.occurred_at
        FROM live_acquisition_action_events AS event
        WHERE event.action_id = ? AND event.to_state IN ('completed', 'blocked', 'ambiguous')
        ORDER BY event.sequence_no DESC LIMIT 1
      `);
      const updateWait = connection.prepare(`
        UPDATE privacy_purge_intent_action_waits
        SET terminal_state = @terminalState,
          terminal_sequence_no = @terminalSequenceNo,
          terminal_event_digest = @terminalEventDigest,
          terminal_proof_digest = @terminalProofDigest,
          terminal_at = @terminalAt
        WHERE intent_key = @intentKey AND ordinal = @ordinal
          AND terminal_state IS NULL
      `);
      for (const wait of waits) {
        if (!["completed", "blocked", "ambiguous"].includes(wait.state)) {
          const latestAt = String(connection.prepare(`
            SELECT occurred_at FROM live_acquisition_action_events
            WHERE action_id = ? ORDER BY sequence_no DESC LIMIT 1
          `).pluck().get(wait.action_id));
          assertPrivacyPurgeClockNotRegressed(at, wait.created_at);
          assertPrivacyPurgeClockNotRegressed(at, latestAt);
          if (wait.state === "resolution_started") {
            assertPrivacyPurgeClockNotRegressed(at, String(wait.resolution_started_at));
            actionLedger.block(wait.action_id, "DNS_RESULT_UNKNOWN", true);
          } else {
            actionLedger.block(wait.action_id, "CANCELLED");
          }
        }
        const event = terminalEvent.get(wait.action_id) as {
          id: number;
          action_id: number;
          sequence_no: number;
          from_state: string;
          to_state: "completed" | "blocked" | "ambiguous";
          outcome_code: string;
          safe_details_json: string;
          occurred_at: string;
        } | undefined;
        if (event === undefined) throw new Error("PURGE_INVARIANT_VIOLATION");
        const terminalEventDigest = rowDigest({
          id: event.id,
          actionId: event.action_id,
          sequenceNo: event.sequence_no,
          fromState: event.from_state,
          toState: event.to_state,
          outcomeCode: event.outcome_code,
          safeDetailsJson: event.safe_details_json,
          occurredAt: event.occurred_at,
        });
        const terminalProofDigest = rowDigest({
          intentKey,
          ordinal: wait.ordinal,
          rowDigest: wait.row_digest,
          terminalState: event.to_state,
          terminalSequenceNo: event.sequence_no,
          terminalEventDigest,
          terminalAt: event.occurred_at,
        });
        addExpected(connection, "action_terminal", [
          intentKey,
          wait.ordinal,
          wait.action_id,
          wait.row_digest,
          event.to_state,
          event.sequence_no,
          terminalEventDigest,
          event.occurred_at,
          terminalProofDigest,
        ]);
        const result = updateWait.run({
          intentKey,
          ordinal: wait.ordinal,
          terminalState: event.to_state,
          terminalSequenceNo: event.sequence_no,
          terminalEventDigest,
          terminalProofDigest,
          terminalAt: event.occurred_at,
        });
        if (result.changes !== 1) throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const remaining = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_action_waits
        WHERE intent_key = ? AND terminal_state IS NULL
      `).pluck().get(intentKey));
      return { intentKey, processed: waits.length, remaining };
    },
  );
}

interface ActionAbortRequestRow {
  intent_key: string;
  ordinal: number;
  action_id: number;
  consent_id: number;
  coordinator_job_id: number;
  attempt_id: number | null;
  attempt_no: number | null;
  lease_token_digest: string | null;
  execution_key_digest: string | null;
  checkpoint_digest: string | null;
  checkpoint_updated_at: string | null;
  action_sequence_no: number;
  action_runtime_epoch: number;
  observed_runtime_epoch: number;
  request_kind: "current_exact" | "prior_epoch";
  requested_at: string;
  request_digest: string;
}

function actionAbortRequestDigest(row: Omit<ActionAbortRequestRow, "request_digest">): string {
  return rowDigest({
    intentKey: row.intent_key,
    ordinal: row.ordinal,
    actionId: row.action_id,
    consentId: row.consent_id,
    coordinatorJobId: row.coordinator_job_id,
    attemptId: row.attempt_id,
    attemptNo: row.attempt_no,
    leaseTokenDigest: row.lease_token_digest,
    executionKeyDigest: row.execution_key_digest,
    checkpointDigest: row.checkpoint_digest,
    checkpointUpdatedAt: row.checkpoint_updated_at,
    actionSequenceNo: row.action_sequence_no,
    actionRuntimeEpoch: row.action_runtime_epoch,
    observedRuntimeEpoch: row.observed_runtime_epoch,
    requestKind: row.request_kind,
    requestedAt: row.requested_at,
  });
}

function trackedExecutionKeyDigest(request: Pick<TrackedC90AbortRequest,
  "jobId" | "attemptId" | "attemptNo" | "leaseTokenDigest">): string {
  return sha256(`tabhub:c90-tracked-execution:v1\0${JSON.stringify({
    jobId: request.jobId,
    attemptId: request.attemptId,
    attemptNo: request.attemptNo,
    leaseTokenDigest: request.leaseTokenDigest,
  })}`);
}

function trackedAbortResultDigest(
  request: ActionAbortRequestRow,
  value: TrackedC90AbortResult,
): string {
  const commonKeys = [
    "status", "actionId", "jobId", "attemptId", "attemptNo",
    "leaseTokenDigest", "executionKeyDigest", "abortRequestDigest",
    "signalled", "settled", "settlement",
  ];
  const record = exactPlainData(value,
    value.status === "acknowledged"
      ? [...commonKeys, "acknowledgementDigest"]
      : [...commonKeys, "terminalOutcome", "resultDigest"],
    "tracked C90 abort result");
  if (record.actionId !== request.action_id ||
      record.jobId !== request.coordinator_job_id ||
      record.attemptId !== request.attempt_id ||
      record.attemptNo !== request.attempt_no ||
      record.leaseTokenDigest !== request.lease_token_digest ||
      record.executionKeyDigest !== request.execution_key_digest ||
      record.signalled !== (value.status === "acknowledged") ||
      record.settled !== true ||
      (record.settlement !== "fulfilled" && record.settlement !== "rejected")) {
    throw new Error("PURGE_INVARIANT_VIOLATION");
  }
  if (value.status === "acknowledged") {
    if (record.abortRequestDigest !== request.request_digest) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    const { acknowledgementDigest, ...base } = record;
    const digest = sha256(
      `tabhub:c90-tracked-abort-ack:v1\0${JSON.stringify(base)}`,
    );
    if (acknowledgementDigest !== digest) {
      throw new Error("PURGE_INVARIANT_VIOLATION");
    }
    return digest;
  }
  if ((record.terminalOutcome !== "settled_without_abort" &&
      record.terminalOutcome !== "settled_after_external_abort") ||
      (record.terminalOutcome === "settled_without_abort"
        ? record.abortRequestDigest !== null
        : record.abortRequestDigest !== null &&
          record.abortRequestDigest !== request.request_digest)) {
    throw new Error("PURGE_INVARIANT_VIOLATION");
  }
  const { resultDigest, ...base } = record;
  const digest = sha256(
    `tabhub:c90-tracked-settled:v1\0${JSON.stringify(base)}`,
  );
  if (resultDigest !== digest) throw new Error("PURGE_INVARIANT_VIOLATION");
  return digest;
}

function phaseAPrivacyPurgeStartedActionAbort(
  connection: Database.Database,
  intentKey: string,
  ordinal: number,
  requestedAt: string,
): ActionAbortRequestRow {
  let request!: ActionAbortRequestRow;
  return runOwnedTransaction(connection, () => createLease("reconcile", {
    action_abort_request: [],
  }, []), () => {
    assertPrivacyPurgeActionQuiescence(connection, intentKey);
    const existing = connection.prepare(`
      SELECT * FROM privacy_purge_action_abort_requests
      WHERE intent_key = ? AND ordinal = ?
    `).get(intentKey, ordinal) as ActionAbortRequestRow | undefined;
    if (existing !== undefined) {
      if (actionAbortRequestDigest(existing) !== existing.request_digest) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      request = existing;
      return request;
    }
    const row = connection.prepare(`
      SELECT wait.action_id, action.consent_id, consent.coordinator_job_id,
        action.sequence_no, action.runtime_epoch AS action_runtime_epoch,
        runtime.runtime_epoch AS observed_runtime_epoch,
        job.status AS job_status,
        attempt.id AS attempt_id, attempt.attempt_no, attempt.lease_token,
        checkpoint.checkpoint_json, checkpoint.checkpoint_digest,
        checkpoint.updated_at AS checkpoint_updated_at
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_action_waits AS wait
        ON wait.intent_key = intent.intent_key AND wait.ordinal = ?
      JOIN live_acquisition_actions AS action ON action.id = wait.action_id
      JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
      JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
      LEFT JOIN ai_jobs AS job ON job.id = consent.coordinator_job_id
      LEFT JOIN ai_job_attempts AS attempt ON attempt.job_id = job.id
        AND attempt.outcome = 'running'
      LEFT JOIN live_acquisition_checkpoints AS checkpoint
        ON checkpoint.attempt_id = attempt.id
      WHERE intent.intent_key = ? AND intent.status = 'waiting'
        AND wait.state = 'started' AND wait.terminal_state IS NULL
        AND action.state = 'started'
      ORDER BY attempt.attempt_no DESC LIMIT 1
    `).get(ordinal, intentKey) as Row | undefined;
    if (row === undefined) throw new Error("PURGE_SUBJECT_BUSY");
    const priorEpoch = Number(row.action_runtime_epoch) < Number(row.observed_runtime_epoch);
    let abortIdentity: Pick<TrackedC90AbortRequest,
      "jobId" | "attemptId" | "attemptNo" | "leaseTokenDigest"> | null = null;
    let checkpointDigest: string | null = null;
    let checkpointUpdatedAt: string | null = null;
    let executionKeyDigest: string | null = null;
    if (!priorEpoch) {
      if (row.job_status !== "running" || !Number.isSafeInteger(row.attempt_id) ||
          !Number.isSafeInteger(row.attempt_no) || typeof row.lease_token !== "string" ||
          typeof row.checkpoint_json !== "string" ||
          typeof row.checkpoint_digest !== "string" ||
          typeof row.checkpoint_updated_at !== "string") {
        throw new Error("PURGE_SUBJECT_BUSY");
      }
      const checkpoint = JSON.parse(row.checkpoint_json) as {
        queue?: { activeActionIds?: unknown[] };
      };
      if (!checkpoint.queue?.activeActionIds?.includes(Number(row.action_id))) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      if (sha256(row.checkpoint_json) !== row.checkpoint_digest) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      abortIdentity = {
        jobId: Number(row.coordinator_job_id),
        attemptId: Number(row.attempt_id),
        attemptNo: Number(row.attempt_no),
        leaseTokenDigest: sha256(row.lease_token),
      };
      checkpointDigest = row.checkpoint_digest;
      checkpointUpdatedAt = row.checkpoint_updated_at;
      executionKeyDigest = trackedExecutionKeyDigest(abortIdentity);
    }
    const base: Omit<ActionAbortRequestRow, "request_digest"> = {
      intent_key: intentKey,
      ordinal,
      action_id: Number(row.action_id),
      consent_id: Number(row.consent_id),
      coordinator_job_id: Number(row.coordinator_job_id),
      attempt_id: abortIdentity?.attemptId ?? null,
      attempt_no: abortIdentity?.attemptNo ?? null,
      lease_token_digest: abortIdentity?.leaseTokenDigest ?? null,
      execution_key_digest: executionKeyDigest,
      checkpoint_digest: checkpointDigest,
      checkpoint_updated_at: checkpointUpdatedAt,
      action_sequence_no: Number(row.sequence_no),
      action_runtime_epoch: Number(row.action_runtime_epoch),
      observed_runtime_epoch: Number(row.observed_runtime_epoch),
      request_kind: priorEpoch ? "prior_epoch" : "current_exact",
      requested_at: requestedAt,
    };
    request = { ...base, request_digest: actionAbortRequestDigest(base) };
    stateFor(connection).activeLease!.expected.get("action_abort_request")!.add(
      exactKey([
        request.intent_key, request.ordinal, request.action_id,
        request.consent_id, request.coordinator_job_id, request.attempt_id,
        request.attempt_no, request.lease_token_digest,
        request.execution_key_digest, request.checkpoint_digest,
        request.checkpoint_updated_at, request.action_sequence_no,
        request.action_runtime_epoch, request.observed_runtime_epoch,
        request.request_kind, request.requested_at, request.request_digest,
      ]),
    );
    connection.prepare(`
      INSERT INTO privacy_purge_action_abort_requests (
        intent_key, ordinal, action_id, consent_id, coordinator_job_id,
        attempt_id, attempt_no, lease_token_digest, execution_key_digest,
        checkpoint_digest, checkpoint_updated_at, action_sequence_no,
        action_runtime_epoch, observed_runtime_epoch, request_kind,
        requested_at, request_digest
      ) VALUES (
        @intent_key, @ordinal, @action_id, @consent_id, @coordinator_job_id,
        @attempt_id, @attempt_no, @lease_token_digest, @execution_key_digest,
        @checkpoint_digest, @checkpoint_updated_at, @action_sequence_no,
        @action_runtime_epoch, @observed_runtime_epoch, @request_kind,
        @requested_at, @request_digest
      )
    `).run(request);
    return request;
  });
}

function terminalizePrivacyPurgeStartedActionAbort(
  connection: Database.Database,
  request: ActionAbortRequestRow,
  bridgeResult: TrackedC90AbortResult | null,
  receivedAt: string,
  failOnce: () => boolean,
): PrivacyPurgeStartedActionAbortResult {
  let output!: PrivacyPurgeStartedActionAbortResult;
  return runOwnedTransaction(
    connection,
    () => createLease("terminal", {
      drain: [], drain_insert: [], action_terminal: [], action_abort_receipt: [],
    }, []),
    () => {
      assertPrivacyPurgeActionQuiescence(connection, request.intent_key);
      const existingReceipt = connection.prepare(`
        SELECT outcome FROM privacy_purge_action_abort_receipts
        WHERE intent_key = ? AND ordinal = ?
      `).get(request.intent_key, request.ordinal) as {
        outcome: NonNullable<PrivacyPurgeStartedActionAbortResult["outcome"]>;
      } | undefined;
      if (existingReceipt !== undefined) {
        if (existingReceipt.outcome === undefined) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
        output = { intentKey: request.intent_key, ordinal: request.ordinal,
          status: "terminalized", outcome: existingReceipt.outcome };
        return output;
      }
      if (receivedAt < request.requested_at) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const action = connection.prepare(`
        SELECT action.state, action.sequence_no, action.runtime_epoch,
          runtime.runtime_epoch AS observed_runtime_epoch,
          job.status AS job_status, attempt.outcome AS attempt_outcome,
          attempt.attempt_no, attempt.lease_token,
          checkpoint.checkpoint_digest, checkpoint.updated_at AS checkpoint_updated_at
        FROM live_acquisition_actions AS action
        JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
        JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
        LEFT JOIN ai_jobs AS job ON job.id = consent.coordinator_job_id
        LEFT JOIN ai_job_attempts AS attempt ON attempt.id = ?
        LEFT JOIN live_acquisition_checkpoints AS checkpoint
          ON checkpoint.attempt_id = attempt.id
        WHERE action.id = ? AND action.consent_id = ?
          AND consent.coordinator_job_id = ?
      `).get(request.attempt_id, request.action_id, request.consent_id,
        request.coordinator_job_id) as Row | undefined;
      if (action === undefined) throw new Error("PURGE_INVARIANT_VIOLATION");
      const directBridgeDigest = bridgeResult === null
        ? null : trackedAbortResultDigest(request, bridgeResult);
      let outcome: NonNullable<PrivacyPurgeStartedActionAbortResult["outcome"]>;
      let bridgeStatus: "acknowledged" | "already_settled" |
        "durable_provenance" | "prior_epoch";
      if (request.request_kind === "prior_epoch") {
        if (Number(action.observed_runtime_epoch) <= request.action_runtime_epoch) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
        outcome = "prior_epoch_ambiguous";
        bridgeStatus = "prior_epoch";
      } else if (Number(action.observed_runtime_epoch) > request.action_runtime_epoch) {
        outcome = "prior_epoch_recovery";
        bridgeStatus = "prior_epoch";
      } else if (bridgeResult?.status === "acknowledged" ||
          (bridgeResult?.status === "already_settled" &&
            bridgeResult.terminalOutcome === "settled_after_external_abort" &&
            bridgeResult.abortRequestDigest === request.request_digest)) {
        if (action.job_status !== "running" || action.attempt_outcome !== "running" ||
            action.attempt_no !== request.attempt_no ||
            sha256(String(action.lease_token)) !== request.lease_token_digest ||
            action.checkpoint_digest !== request.checkpoint_digest ||
            action.checkpoint_updated_at !== request.checkpoint_updated_at ||
            action.runtime_epoch !== request.action_runtime_epoch ||
            action.observed_runtime_epoch !== request.observed_runtime_epoch) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
        outcome = "acknowledged";
        bridgeStatus = bridgeResult.status;
      } else if (bridgeResult?.status === "already_settled" &&
          bridgeResult.terminalOutcome === "settled_without_abort") {
        outcome = "response_wins";
        bridgeStatus = "already_settled";
      } else {
        const provenance = connection.prepare(`
          SELECT event_id, event_sequence_no FROM live_acquisition_action_abort_provenance
          WHERE request_digest = ? AND action_id = ? AND execution_key_digest = ?
        `).get(request.request_digest, request.action_id,
          request.execution_key_digest) as Row | undefined;
        if (provenance === undefined) {
          return { intentKey: request.intent_key, ordinal: request.ordinal,
            status: "pending" };
        }
        outcome = "acknowledged";
        bridgeStatus = "durable_provenance";
      }
      const lease = stateFor(connection).activeLease!;
      const authorizeOwnedMutation = (mutation: LiveAcquisitionOwnedMutation): void => {
        const bucket = mutation.operation === "INSERT" ? "drain_insert" : "drain";
        const parts = mutation.operation === "INSERT"
          ? [request.intent_key, mutation.tableName, mutation.newPkV1,
            mutationRowDigest(connection, mutation)]
          : [request.intent_key, mutation.tableName, mutation.operation,
            mutation.oldPkV1, mutation.newPkV1];
        const entries = lease.expected.get(bucket);
        if (entries === undefined) throw new Error("PURGE_INVARIANT_VIOLATION");
        entries.add(exactKey(parts));
      };
      if (outcome !== "response_wins" && action.state === "started") {
        const actionLedger = createLiveAcquisitionActionLedger(connection, {
          clock: () => new Date(receivedAt), transactionBound: true,
          authorizeOwnedMutation,
        });
        if (outcome === "prior_epoch_ambiguous" || outcome === "prior_epoch_recovery") {
          actionLedger.block(request.action_id, "CANCELLED", true);
        } else {
          actionLedger.blockForPrivacyPurgeAbort(request.action_id, {
            requestDigest: request.request_digest,
            executionKeyDigest: request.execution_key_digest!,
          });
        }
      }
      const event = connection.prepare(`
        SELECT id, action_id, sequence_no, from_state, to_state,
          outcome_code, safe_details_json, occurred_at
        FROM live_acquisition_action_events
        WHERE action_id = ? AND to_state IN ('completed', 'blocked', 'ambiguous')
        ORDER BY sequence_no DESC LIMIT 1
      `).get(request.action_id) as Row | undefined;
      if (event === undefined || (outcome === "response_wins" &&
          action.state === "started")) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      const terminalEventDigest = rowDigest({
        id: event.id, actionId: event.action_id, sequenceNo: event.sequence_no,
        fromState: event.from_state, toState: event.to_state,
        outcomeCode: event.outcome_code, safeDetailsJson: event.safe_details_json,
        occurredAt: event.occurred_at,
      });
      const currentProjection = connection.prepare(`
        SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
      `).get(request.action_id) as Row;
      if (currentProjection.state !== event.to_state ||
          currentProjection.sequence_no !== event.sequence_no ||
          currentProjection.terminal_at !== event.occurred_at) {
        throw new Error("PURGE_INVARIANT_VIOLATION");
      }
      if (outcome === "acknowledged") {
        const provenance = connection.prepare(`
          SELECT event_id, event_sequence_no FROM live_acquisition_action_abort_provenance
          WHERE request_digest = ? AND action_id = ? AND execution_key_digest = ?
        `).get(request.request_digest, request.action_id,
          request.execution_key_digest) as Row | undefined;
        if (provenance === undefined || provenance.event_id !== event.id ||
            provenance.event_sequence_no !== event.sequence_no) {
          throw new Error("PURGE_INVARIANT_VIOLATION");
        }
      }
      const bridgeResultDigest = directBridgeDigest ?? (bridgeStatus === "prior_epoch"
        ? sha256(`tabhub:c90-prior-epoch:v1\0${JSON.stringify({
          observedRuntimeEpoch: Number(action.observed_runtime_epoch),
        })}`)
        : sha256(`tabhub:c90-durable-abort-provenance:v1\0${JSON.stringify({
          requestDigest: request.request_digest, actionId: request.action_id,
          executionKeyDigest: request.execution_key_digest,
          terminalEventDigest,
        })}`));
      const bridgeFields = bridgeStatus === "prior_epoch" ? {
        bridgeStatus, bridgeActionId: null, bridgeJobId: null,
        bridgeAttemptId: null, bridgeAttemptNo: null,
        bridgeLeaseTokenDigest: null, bridgeExecutionKeyDigest: null,
        bridgeAbortRequestDigest: null, bridgeSignalled: 0, bridgeSettled: 0,
        bridgeSettlement: null, bridgeTerminalOutcome: null,
        recoveryRuntimeEpoch: Number(action.observed_runtime_epoch),
      } : bridgeStatus === "durable_provenance" ? {
        bridgeStatus, bridgeActionId: request.action_id,
        bridgeJobId: request.coordinator_job_id, bridgeAttemptId: request.attempt_id,
        bridgeAttemptNo: request.attempt_no,
        bridgeLeaseTokenDigest: request.lease_token_digest,
        bridgeExecutionKeyDigest: request.execution_key_digest,
        bridgeAbortRequestDigest: request.request_digest,
        bridgeSignalled: 1, bridgeSettled: 1, bridgeSettlement: null,
        bridgeTerminalOutcome: "settled_after_external_abort",
        recoveryRuntimeEpoch: null,
      } : {
        bridgeStatus, bridgeActionId: bridgeResult!.actionId,
        bridgeJobId: bridgeResult!.jobId, bridgeAttemptId: bridgeResult!.attemptId,
        bridgeAttemptNo: bridgeResult!.attemptNo,
        bridgeLeaseTokenDigest: bridgeResult!.leaseTokenDigest,
        bridgeExecutionKeyDigest: bridgeResult!.executionKeyDigest,
        bridgeAbortRequestDigest: bridgeResult!.abortRequestDigest,
        bridgeSignalled: bridgeResult!.signalled ? 1 : 0,
        bridgeSettled: bridgeResult!.settled ? 1 : 0,
        bridgeSettlement: bridgeResult!.settlement,
        bridgeTerminalOutcome: bridgeResult!.status === "already_settled"
          ? bridgeResult!.terminalOutcome : null,
        recoveryRuntimeEpoch: null,
      };
      const receiptBase = {
        intentKey: request.intent_key, ordinal: request.ordinal,
        requestDigest: request.request_digest, outcome,
        ...bridgeFields,
        bridgeResultDigest, terminalState: event.to_state,
        terminalSequenceNo: event.sequence_no,
        terminalEventDigest, terminalAt: event.occurred_at, receivedAt,
      };
      lease.expected.get("action_abort_receipt")!.add(exactKey([
        request.intent_key, request.ordinal, request.request_digest, outcome,
        bridgeFields.bridgeStatus, bridgeFields.bridgeActionId,
        bridgeFields.bridgeJobId, bridgeFields.bridgeAttemptId,
        bridgeFields.bridgeAttemptNo, bridgeFields.bridgeLeaseTokenDigest,
        bridgeFields.bridgeExecutionKeyDigest, bridgeFields.bridgeAbortRequestDigest,
        bridgeFields.bridgeSignalled, bridgeFields.bridgeSettled,
        bridgeFields.bridgeSettlement, bridgeFields.bridgeTerminalOutcome,
        bridgeFields.recoveryRuntimeEpoch,
        bridgeResultDigest, event.to_state, event.sequence_no,
        terminalEventDigest, event.occurred_at, rowDigest(receiptBase), receivedAt,
      ]));
      connection.prepare(`
        INSERT INTO privacy_purge_action_abort_receipts (
          intent_key, ordinal, request_digest, outcome, bridge_result_digest,
          bridge_status, bridge_action_id, bridge_job_id, bridge_attempt_id,
          bridge_attempt_no, bridge_lease_token_digest,
          bridge_execution_key_digest, bridge_abort_request_digest,
          bridge_signalled, bridge_settled, bridge_settlement,
          bridge_terminal_outcome, recovery_runtime_epoch,
          terminal_state, terminal_sequence_no, terminal_event_digest,
          terminal_at, receipt_digest, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.intent_key, request.ordinal, request.request_digest, outcome,
        bridgeResultDigest, bridgeFields.bridgeStatus, bridgeFields.bridgeActionId,
        bridgeFields.bridgeJobId, bridgeFields.bridgeAttemptId,
        bridgeFields.bridgeAttemptNo, bridgeFields.bridgeLeaseTokenDigest,
        bridgeFields.bridgeExecutionKeyDigest, bridgeFields.bridgeAbortRequestDigest,
        bridgeFields.bridgeSignalled, bridgeFields.bridgeSettled,
        bridgeFields.bridgeSettlement, bridgeFields.bridgeTerminalOutcome,
        bridgeFields.recoveryRuntimeEpoch,
        event.to_state, event.sequence_no,
        terminalEventDigest, event.occurred_at, rowDigest(receiptBase), receivedAt,
      );
      if (failOnce()) throw new Error("TEST_ONLY_ACTION_ABORT_PHASE_B_ROLLBACK");
      const terminalProofDigest = rowDigest({
        intentKey: request.intent_key, ordinal: request.ordinal,
        rowDigest: String(connection.prepare(`
          SELECT row_digest FROM privacy_purge_intent_action_waits
          WHERE intent_key = ? AND ordinal = ?
        `).pluck().get(request.intent_key, request.ordinal)),
        terminalState: event.to_state,
        terminalSequenceNo: event.sequence_no,
        terminalEventDigest,
        terminalAt: event.occurred_at,
      });
      const waitRowDigest = String(connection.prepare(`
        SELECT row_digest FROM privacy_purge_intent_action_waits
        WHERE intent_key = ? AND ordinal = ?
      `).pluck().get(request.intent_key, request.ordinal));
      lease.expected.get("action_terminal")!.add(exactKey([
        request.intent_key, request.ordinal, request.action_id, waitRowDigest,
        event.to_state, event.sequence_no, terminalEventDigest,
        event.occurred_at, terminalProofDigest,
      ]));
      const updated = connection.prepare(`
        UPDATE privacy_purge_intent_action_waits
        SET terminal_state = ?, terminal_sequence_no = ?,
          terminal_event_digest = ?, terminal_proof_digest = ?, terminal_at = ?
        WHERE intent_key = ? AND ordinal = ? AND terminal_state IS NULL
      `).run(event.to_state, event.sequence_no, terminalEventDigest,
        terminalProofDigest, event.occurred_at, request.intent_key, request.ordinal);
      if (updated.changes !== 1) throw new Error("PURGE_INVARIANT_VIOLATION");
      output = { intentKey: request.intent_key, ordinal: request.ordinal,
        status: "terminalized", outcome };
      return output;
    },
  );
}

/**
 * Owns the trusted transition clock for schema-26 privacy-purge intents.
 * Callers provide identities and targets, never durable timestamps.
 */
export function createPrivacyPurgeIntentStore(
  connection: Database.Database,
  options: PrivacyPurgeIntentStoreOptions = {},
): PrivacyPurgeIntentStore {
  const clock = options.clock ?? (() => new Date());
  const actionAbortResults = new Map<string, TrackedC90AbortResult>();
  const actionAbortInFlight = new Map<string, Promise<TrackedC90AbortResult>>();
  let failActionAbortPhaseB = options.testOnlyFailActionAbortPhaseBOnce === true;
  const abortOneStartedAction = async (
    canonicalIntentKey: string,
    ordinalValue: number,
  ): Promise<PrivacyPurgeStartedActionAbortResult> => {
    assertPrivacyPurgeActionQuiescence(connection, canonicalIntentKey);
    options.testOnlyBeforeActionAbortPhaseA?.();
    const requestedAt = samplePrivacyPurgeClock(clock);
    const request = phaseAPrivacyPurgeStartedActionAbort(
      connection, canonicalIntentKey, ordinalValue, requestedAt,
    );
    const existingReceipt = connection.prepare(`
      SELECT outcome FROM privacy_purge_action_abort_receipts
      WHERE intent_key = ? AND ordinal = ?
    `).get(canonicalIntentKey, ordinalValue) as {
      outcome: NonNullable<PrivacyPurgeStartedActionAbortResult["outcome"]>;
    } | undefined;
    if (existingReceipt !== undefined) {
      return { intentKey: canonicalIntentKey, ordinal: ordinalValue,
        status: "terminalized", outcome: existingReceipt.outcome };
    }
    let bridgeResult: TrackedC90AbortResult | null = null;
    const observedRuntimeEpoch = Number(connection.prepare(`
      SELECT runtime_epoch FROM live_acquisition_runtime_state WHERE singleton_id = 1
    `).pluck().get());
    if (request.request_kind === "current_exact" &&
        observedRuntimeEpoch === request.action_runtime_epoch) {
      bridgeResult = actionAbortResults.get(request.request_digest) ?? null;
      if (bridgeResult === null && options.trackedC90Executor !== undefined) {
        try {
          let inFlight = actionAbortInFlight.get(request.request_digest);
          if (inFlight === undefined) {
            inFlight = options.trackedC90Executor.abortAndWait({
              actionId: request.action_id, jobId: request.coordinator_job_id,
              attemptId: request.attempt_id!, attemptNo: request.attempt_no!,
              leaseTokenDigest: request.lease_token_digest!,
              executionKeyDigest: request.execution_key_digest!,
              abortRequestDigest: request.request_digest,
            });
            actionAbortInFlight.set(request.request_digest, inFlight);
          }
          bridgeResult = await inFlight;
        } catch (error) {
          actionAbortInFlight.delete(request.request_digest);
          if (!(error instanceof TrackedC90AbortError)) throw error;
        }
        actionAbortInFlight.delete(request.request_digest);
        if (bridgeResult !== null) {
          actionAbortResults.set(request.request_digest, bridgeResult);
        }
      }
    }
    assertPrivacyPurgeActionQuiescence(connection, canonicalIntentKey);
    const receivedAt = samplePrivacyPurgeClock(clock);
    const result = terminalizePrivacyPurgeStartedActionAbort(
      connection, request, bridgeResult, receivedAt, () => {
        if (!failActionAbortPhaseB) return false;
        failActionAbortPhaseB = false;
        return true;
      },
    );
    if (result.status === "terminalized") {
      actionAbortResults.delete(request.request_digest);
    }
    return result;
  };
  return Object.freeze({
    publishWaiting(input: PrivacyPurgeWaitingPublication) {
      const createdAt = samplePrivacyPurgeClock(clock);
      return publishPrivacyPurgeWaitingIntentAt(connection, input, createdAt);
    },
    reconcileActionWaits(
      intentKey: string,
      input: { readonly maxActions: number },
    ) {
      const maxActions = snapshotBoundedIntegerInput(
        input, "maxActions", 256, "maxActions",
      );
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const at = samplePrivacyPurgeClock(clock);
      return reconcilePrivacyPurgeActionWaitsAt(
        connection,
        canonicalIntentKey,
        maxActions,
        at,
      );
    },
    async abortStartedActionWait(
      intentKey: string,
      input: { readonly maxActions: number },
    ) {
      const maxActions = snapshotBoundedIntegerInput(
        input, "maxActions", 256, "maxActions",
      );
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const candidates = connection.prepare(`
        SELECT wait.ordinal
        FROM privacy_purge_intent_action_waits AS wait
        JOIN live_acquisition_actions AS action ON action.id = wait.action_id
        WHERE wait.intent_key = ? AND wait.state = 'started'
          AND wait.terminal_state IS NULL
          AND (action.state = 'started' OR EXISTS (
            SELECT 1 FROM privacy_purge_action_abort_requests AS request
            WHERE request.intent_key = wait.intent_key AND request.ordinal = wait.ordinal
          ))
        ORDER BY wait.ordinal, wait.action_id LIMIT ?
      `).all(canonicalIntentKey, maxActions) as Array<{ ordinal: number }>;
      const results: PrivacyPurgeStartedActionAbortResult[] = [];
      for (const candidate of candidates) {
        const result = await abortOneStartedAction(canonicalIntentKey, candidate.ordinal);
        results.push(result);
        if (result.status === "pending") break;
      }
      const remaining = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_action_waits
        WHERE intent_key = ? AND terminal_state IS NULL
      `).pluck().get(canonicalIntentKey));
      return { intentKey: canonicalIntentKey,
        processed: results.filter(({ status }) => status === "terminalized").length,
        remaining, results, ...(results.length === 1 ? results[0] : {}) };
    },
    reconcileJobWaits(
      intentKey: string,
      input: { readonly maxJobs: number },
    ) {
      const maxJobs = snapshotBoundedIntegerInput(
        input, "maxJobs", 100, "maxJobs",
      );
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      return reconcilePrivacyPurgeJobWaits(
        connection,
        canonicalIntentKey,
        maxJobs,
      );
    },
    terminalizeJobWaits(
      intentKey: string,
      input: { readonly maxJobs: number },
    ) {
      const maxJobs = snapshotBoundedIntegerInput(
        input, "maxJobs", 100, "maxJobs",
      );
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const at = samplePrivacyPurgeClock(clock);
      return terminalizePrivacyPurgeJobWaitsAt(
        connection,
        canonicalIntentKey,
        maxJobs,
        at,
      );
    },
    terminalizeResourceResearchJobWaits(
      intentKey: string,
      input: { readonly maxJobs: number },
    ) {
      const maxJobs = snapshotBoundedIntegerInput(
        input, "maxJobs", 256, "maxJobs",
      );
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const at = samplePrivacyPurgeClock(clock);
      return terminalizePrivacyPurgeResourceResearchJobWaitsAt(
        connection,
        canonicalIntentKey,
        maxJobs,
        at,
      );
    },
    reconcileWaiting(intentKey: string, input: PrivacyPurgeWaitingReconcileLimit) {
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const limit = snapshotReconcileLimit(input);
      const current = connection.prepare(`
        SELECT status, hold_code FROM privacy_purge_intents WHERE intent_key = ?
      `).get(canonicalIntentKey) as {
        status: string;
        hold_code: string | null;
      } | undefined;
      if (current === undefined) throw new Error("Privacy purge intent does not exist");
      if (current.status === "failed_hold" &&
          current.hold_code === "PROVIDER_USAGE_UNKNOWN") {
        return {
          intentKey: canonicalIntentKey,
          status: "failed_hold" as const,
          holdCode: "PROVIDER_USAGE_UNKNOWN" as const,
          inspectedJobs: 0,
          transitioned: false,
        };
      }
      if (current.status !== "waiting") {
        throw new Error("Privacy purge intent is not waiting");
      }
      const at = samplePrivacyPurgeClock(clock);
      return reconcilePrivacyPurgeWaitingIntentAt(
        connection,
        canonicalIntentKey,
        limit,
        at,
      );
    },
    repairFinalSettlements(
      intentKey: string,
      input: PrivacyPurgeWaitingReconcileLimit,
    ) {
      const canonicalIntentKey = canonicalHash(intentKey, "privacy purge intent key");
      const limit = snapshotReconcileLimit(input);
      if (options.finalSettlementVerifier === undefined) {
        return Promise.reject(new Error(
          "Privacy purge final settlement verifier is unavailable",
        ));
      }
      return repairPrivacyPurgeFinalSettlementsAt(
        connection,
        canonicalIntentKey,
        limit,
        options.finalSettlementVerifier,
        clock,
      );
    },
    freezeReady(intentKey: string) {
      const at = samplePrivacyPurgeClock(clock);
      return freezePrivacyPurgeIntentReadyAt(connection, intentKey, at);
    },
    linkReadyCommand(identity: PrivacyPurgeReadyCommandIdentity) {
      const createdAt = samplePrivacyPurgeClock(clock);
      return linkPrivacyPurgeReadyIntentCommandAt(
        connection,
        snapshotReadyCommandIdentity(identity, createdAt),
      );
    },
    executeCommitted(commandId: number) {
      const completedAt = samplePrivacyPurgeClock(clock);
      executePrivacyPurgeCommittedIntentAt(connection, commandId, completedAt);
    },
  });
}

// Future guarded-executor uses a separate synchronous autocommit invocation
// scope because executePrivacyPurgePlan owns BEGIN IMMEDIATE. It is intentionally
// not exported until the wrapper can derive every exact operation itself.
