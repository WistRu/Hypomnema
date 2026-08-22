import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import {
  agentResearchCancelCommandFingerprintPayloadV1,
  agentResearchStartCommandFingerprintPayloadV1,
  agentResearchStartRequestFingerprintPayloadV1,
  agentResearchStartRequestSchema,
  aiTaskSpecSchema,
  durableJobViewSchema,
  researchApprovedDraftSchema,
  researchApprovalRequestSchema,
  researchPublicationDraftSchema,
  type DurableJobId,
  type DurableJobRef,
  type DurableJobView,
  type AgentResearchStartRequest,
  type PriorityAssessmentTaskSpec,
  type ResearchApprovedDraft,
  type ResearchApprovalRequest,
  type ResearchPublicationDraft,
  type ResearchPrivacyRequest,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";

import {
  DurableAiJobError,
  type AgentResearchCommand,
  type DurableAiJobErrorCode,
  type NewAiJobAdapter,
  type NewAiTaskSpec,
} from "./durable-ai-jobs.js";
import type { AiJobScheduleLimit } from "./ai-job-scheduling.js";
import {
  normalizeAiJobClaimBoundary,
  prepareAiJobRuntimeClaimBoundary,
  type AiJobClaimBoundary,
} from "./ai-job-runtime-state.js";
import {
  createResearchCorpusReader,
  type ResearchCorpusReader,
} from "./research-corpus.js";
import { LIVE_ACQUISITION_WORKFLOW } from "./live-acquisition-foundation.js";

export const AI_JOB_LEASE_MS = 60_000;
export const AI_JOB_RENEW_EVERY_MS = 20_000;
export const RESEARCH_STALE_GUARD_METADATA = Object.freeze({
  provider: "tabhub",
  model: "research-stale-guard",
  promptVersion: "v1",
  pricingVersion: "tabhub-no-charge-v1",
});
export const RESEARCH_STALE_GUARD_DOSSIER = Object.freeze({
  executiveSummary: "The approved research corpus changed before analysis completed.",
  valueForUser: "No model-generated conclusion is available.",
  capabilities: [] as string[],
  limitations: ["The approved corpus is no longer immutable for this run."],
  risks: [] as string[],
  unknowns: ["corpus_became_stale"],
  nextSteps: ["Run a new research preflight and approve the refreshed corpus."],
});

export interface AiJobLedgerOptions {
  readonly clock?: () => Date;
  readonly kindAvailable: (kind: NewAiTaskSpec["kind"]) => boolean;
  readonly token?: () => string;
  readonly guards?: Readonly<Record<string, AiJobGuardDefinition>>;
  readonly research?: ResearchLedgerAdapter;
  /** `null` explicitly disables automatic reader construction. */
  readonly researchCorpusReader?: ResearchCorpusReader | null;
  readonly transactionBound?: boolean;
  readonly authorizeOwnedMutation?: (mutation: AiJobOwnedMutation) => void;
}

export interface AiJobOwnedMutation {
  readonly tableName: "ai_job_events" | "ai_job_attempts" | "ai_jobs";
  readonly operation: "INSERT" | "UPDATE";
  readonly oldPkV1: string;
  readonly newPkV1: string;
  readonly newRow?: Readonly<Record<string, unknown>>;
}

export interface AiJobExpiredCancellation {
  readonly id: number;
  readonly kind: NewAiTaskSpec["kind"];
  readonly attemptId: number;
  readonly attemptNo: number;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface ResearchLedgerAdapter {
  readonly connection: Database.Database;
  prepareSubmission(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
  ): ResearchApprovedDraft;
  assertSubmission(
    jobId: number,
    task: ResourceResearchTaskSpec,
    draft: ResearchApprovedDraft,
  ): void;
  insertSubmission(
    jobId: number,
    task: ResourceResearchTaskSpec,
    draft: ResearchApprovedDraft,
    occurredAt: string,
  ): { readonly runId: number; readonly corpusFingerprint: string };
  publish(
    jobId: number,
    draft: ResearchPublicationDraft,
    occurredAt: string,
  ): { readonly reportId: number; readonly status: "succeeded" | "partial" };
  redactResearch(input: ResearchPrivacyRequest): {
    readonly sources: number;
    readonly snapshots: number;
    readonly evidence: number;
    readonly reports: number;
    readonly runs: number;
    readonly cancelledJobs: number;
  };
}

export interface AiJobClaim {
  readonly id: number;
  readonly kind: NewAiTaskSpec["kind"];
  readonly attemptId: number;
  readonly attemptNo: number;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly task: NewAiTaskSpec;
  readonly inputFingerprint: string;
  readonly createdAt: string;
  readonly progress: {
    readonly completed: number;
    readonly total: number | null;
    readonly stage: string;
  };
  readonly checkpoint:
    | AiJobPriorityCheckpoint
    | AiJobResearchCheckpoint
    | AiJobLegacyResearchCheckpoint
    | null;
  readonly usage: {
    readonly steps: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly wallTimeMs: number;
  };
}

export interface AiJobPriorityCheckpoint {
  readonly version: 1;
  readonly nextOffset: number;
}

export interface AiJobLegacyResearchCheckpoint {
  readonly version: 1;
  readonly nextStep: number;
}

export type AiJobResearchCheckpoint =
  | {
      readonly version: 1;
      readonly nextStep: 0;
      readonly stage: "claimed";
    }
  | {
      readonly version: 1;
      readonly nextStep: 1;
      readonly stage: "provider_ready";
      readonly corpusDigest: string;
      readonly parentDigest: string | null;
      readonly providerInputDigest: string;
      readonly quoteDigest: string;
    }
  | {
      readonly version: 1;
      readonly nextStep: 2;
      readonly stage: "terminal_publication";
      readonly corpusDigest: string;
      readonly parentDigest: string | null;
      readonly providerInputDigest: string;
      readonly quoteDigest: string;
      readonly providerOutputDigest: string;
    };

export interface AiJobAttemptMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly pricingVersion?: string;
}

export interface AiJobRenewedLease extends AiJobClaim {
  readonly leaseExpiresAt: string;
}

export interface AiJobFailure {
  readonly code: Exclude<DurableAiJobErrorCode,
    | "INVALID_JOB_ID"
    | "INVALID_JOB_INPUT"
    | "JOB_NOT_FOUND"
    | "JOB_NOT_CANCELLABLE"
    | "JOB_ACTIVE_CONFLICT"
    | "JOB_KIND_UNAVAILABLE"
    | "RESEARCH_CAPTURE_REQUIRED"
    | "RESEARCH_PREFLIGHT_STALE"
    | "IDEMPOTENCY_KEY_CONFLICT"
    | "JOB_STORAGE_CORRUPT">;
  readonly retryAt?: string;
}

export interface AiJobCheckpointInput {
  readonly progress: {
    readonly completed: number;
    readonly total: number | null;
    readonly stage: string;
  };
  readonly checkpoint:
    | AiJobPriorityCheckpoint
    | AiJobResearchCheckpoint
    | AiJobLegacyResearchCheckpoint;
  readonly usage: {
    readonly steps: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly wallTimeMs: number;
  };
}

export type AiJobCompletion =
  | {
      readonly status: "succeeded";
      readonly result: {
        readonly type: "priority_assessment";
        readonly outputFingerprint: string;
      };
    }
  | {
      readonly status: "succeeded";
      readonly result: {
        readonly type: "resource_research";
        readonly reportId: number;
      };
    }
  | {
      readonly status: "partial";
      readonly diagnostic: { readonly code: "JOB_BUDGET_EXHAUSTED" };
      readonly result: {
        readonly type: "priority_assessment";
        readonly outputFingerprint: string;
      };
    }
  | {
      readonly status: "partial";
      readonly diagnostic: { readonly code: "JOB_BUDGET_EXHAUSTED" };
      readonly result: {
        readonly type: "resource_research";
        readonly reportId: number;
      };
    };

export type AiJobResearchCompletion = Extract<
  AiJobCompletion,
  { readonly result: { readonly type: "resource_research" } }
>;

export type AiJobPriorityCompletion = Extract<
  AiJobCompletion,
  {
    readonly status: "succeeded";
    readonly result: { readonly type: "priority_assessment" };
  }
>;

export type AiJobGuardParameter = string | number | null;

export interface AiJobReadGuard {
  readonly guardId: string;
  readonly args: readonly AiJobGuardParameter[];
  readonly expectedFingerprint: string;
}

export interface AiJobGuardDefinition {
  readonly sql: string;
  readonly parameters: readonly AiJobGuardParameterType[];
  readonly usage: { readonly stepsPerRow: 1 };
}

export type AiJobGuardParameterType =
  | "positive_safe_integer"
  | "fingerprint"
  | "bounded_text"
  | "nullable_bounded_text";

export interface AiJobGuardedCompletion {
  readonly checkpoint: AiJobCheckpointInput;
  readonly guard: AiJobReadGuard;
  readonly completion: AiJobPriorityCompletion;
  readonly onMismatch?: {
    readonly terminalPartial: {
      readonly version: 1;
      readonly initialDenominator: number;
      /** Ledger-verified guarded mismatches, not caller-declared work. */
      readonly maxCycles?: 3 | 4;
    };
  };
}

export const aiJobGuardMaximumRows = 10_000;
export const aiJobGuardMaximumBytes = 4 * 1024 * 1024;

export interface AiJobPartialCompletionInput {
  readonly checkpoint: AiJobCheckpointInput;
  readonly manifest: {
    readonly version: 1;
    readonly initialDenominator: number;
    readonly observedDenominator: number;
  };
}

export interface AiJobGuardLimitCompletionInput {
  readonly checkpoint: AiJobCheckpointInput;
  readonly guard: {
    readonly guardId: string;
    readonly args: readonly AiJobGuardParameter[];
  };
  readonly initialDenominator: number;
  readonly maxCycles: 4;
}

interface AiJobRow {
  id: number;
  kind: NewAiTaskSpec["kind"];
  subject_type: "page" | "resource" | "collection" | "selection";
  logical_page_id: number | null;
  resource_id: number | null;
  collection_scope: "all" | null;
  selection_fingerprint: string | null;
  subject_key: string;
  requested_by: "user" | "agent" | "system";
  request_method: "manual" | "on_behalf_of_user" | "scheduled";
  authorization_ref: string | null;
  idempotency_key: string;
  submission_fingerprint: string;
  input_fingerprint: string;
  ruleset_id: number | null;
  ruleset_version: number | null;
  assessment_method: "rule" | "model" | null;
  assessment_model_provider: string | null;
  assessment_model_name: string | null;
  assessment_prompt_version: string | null;
  workflow_id: string | null;
  workflow_version: number | null;
  step_batch_size: number | null;
  scheduling_priority: number;
  status: DurableJobView["status"];
  attempts: number;
  max_attempts: number;
  available_at: string;
  progress_completed: number;
  progress_total: number | null;
  progress_stage: string;
  checkpoint_json: string | null;
  spent_steps: number;
  max_steps: number;
  spent_tokens: number;
  max_tokens: number;
  spent_cost_usd: number;
  max_cost_usd: number;
  spent_wall_time_ms: number;
  max_wall_time_ms: number;
  cancellation_requested_by: "user" | "agent" | null;
  cancellation_requested_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  result_type: "priority_output" | "research_report" | null;
  result_output_fingerprint: string | null;
  result_report_id: number | null;
  error_code: Exclude<DurableAiJobErrorCode,
    | "INVALID_JOB_ID"
    | "JOB_NOT_FOUND"
    | "JOB_NOT_CANCELLABLE"
    | "JOB_ACTIVE_CONFLICT"
    | "JOB_KIND_UNAVAILABLE"
    | "RESEARCH_CAPTURE_REQUIRED"
    | "IDEMPOTENCY_KEY_CONFLICT"> | null;
  error_message: string | null;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface IdempotencyRow {
  id: number;
  kind: NewAiTaskSpec["kind"];
  submission_fingerprint: string;
}

interface AgentResearchCommandReceiptRow {
  operation: "start" | "cancel";
  request_fingerprint: string;
  authorization_ref_hash: string;
  job_id: number;
  created_at: string;
}

interface AttemptProjectionRow {
  id: number;
  attempt_no: number;
  lease_token: string;
  worker_id: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  pricing_version?: string | null;
  provider_bound_at: string | null;
  request_id: string | null;
  request_bound_at: string | null;
  started_at: string;
  completed_at: string | null;
  outcome: "running" | "succeeded" | "partial" | "failed" | "cancelled" |
    "interrupted" | "superseded";
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error_code: string | null;
  error_message: string | null;
}

interface ActiveRow {
  id: number;
  kind: NewAiTaskSpec["kind"];
  input_fingerprint: string;
  submission_fingerprint: string;
  status: "queued" | "running";
  updated_at: string;
  lease_token: string | null;
  event_sequence: number;
  attempt_id: number | null;
}

interface ExpiredRow extends AiJobRow {
  attempt_id: number | null;
}

interface OwnedAiJobGuardDefinition {
  readonly statement: Database.Statement;
  readonly parameters: readonly AiJobGuardParameterType[];
  readonly stepsPerRow: 1;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Cannot canonicalize non-finite number");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Cannot canonicalize undefined");
  return encoded;
}

function fingerprint(value: unknown): { json: string; hash: string } {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > 65_536) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "AI job input exceeds 64 KiB");
  }
  return {
    json,
    hash: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function domainHash(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}\0`, "utf8").update(value, "utf8").digest("hex");
}

function agentResearchKeyHash(value: string): string {
  return domainHash("tabhub:agent-research-command-key:v1", value);
}

function agentResearchAuthorizationHash(value: string): string {
  return domainHash("tabhub:agent-research-authorization:v1", value);
}

function sha256Payload(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock is invalid");
  }
  return date.toISOString();
}

function subjectKey(task: NewAiTaskSpec): string {
  switch (task.subject.type) {
    case "page": return `page:${task.subject.logicalPageId}`;
    case "resource": return `resource:${task.subject.resourceId}`;
    case "collection": return "collection:all";
    case "selection": return `selection:${task.subject.fingerprint}`;
  }
}

function subjectFromRow(row: AiJobRow): NewAiTaskSpec["subject"] {
  const subject = row.subject_type === "page" && isSafeCount(row.logical_page_id, 1)
    ? { type: "page" as const, logicalPageId: row.logical_page_id }
    : row.subject_type === "resource" && isSafeCount(row.resource_id, 1)
      ? { type: "resource" as const, resourceId: row.resource_id }
      : row.subject_type === "collection" && row.collection_scope === "all"
        ? { type: "collection" as const, scope: "all" as const }
        : row.subject_type === "selection" && row.selection_fingerprint !== null
          ? { type: "selection" as const, fingerprint: row.selection_fingerprint }
          : corrupt();
  if (subjectKey({ subject } as NewAiTaskSpec) !== row.subject_key) return corrupt();
  return subject;
}

function ref(row: Pick<AiJobRow, "id" | "kind" | "status">): DurableJobRef {
  return {
    id: `${row.kind}:${row.id}`,
    kind: row.kind,
    status: row.status,
  };
}

function corrupt(message = "Stored AI job is invalid"): never {
  throw new DurableAiJobError("JOB_STORAGE_CORRUPT", message);
}

function parseResearchCheckpoint(value: unknown): AiJobResearchCheckpoint | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const exactKeys = (keys: readonly string[]): boolean => {
    const actual = Object.keys(record).sort();
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
  };
  if (record.version !== 1 || ![0, 1, 2].includes(record.nextStep as number)) {
    return undefined;
  }
  if (record.nextStep === 0) {
    return exactKeys(["nextStep", "stage", "version"]) && record.stage === "claimed"
      ? record as unknown as AiJobResearchCheckpoint : undefined;
  }
  const digest = (candidate: unknown): boolean =>
    typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate);
  const commonDigests = digest(record.corpusDigest) &&
    (record.parentDigest === null || digest(record.parentDigest)) &&
    digest(record.providerInputDigest) && digest(record.quoteDigest);
  if (!commonDigests) return undefined;
  if (record.nextStep === 1) {
    return exactKeys([
      "corpusDigest", "nextStep", "parentDigest", "providerInputDigest",
      "quoteDigest", "stage", "version",
    ]) && record.stage === "provider_ready"
      ? record as unknown as AiJobResearchCheckpoint : undefined;
  }
  return exactKeys([
    "corpusDigest", "nextStep", "parentDigest", "providerInputDigest",
    "providerOutputDigest", "quoteDigest", "stage", "version",
  ]) && record.stage === "terminal_publication" && digest(record.providerOutputDigest)
    ? record as unknown as AiJobResearchCheckpoint : undefined;
}

function checkpointFromRow(
  row: Pick<AiJobRow, "kind" | "checkpoint_json">,
  strictResearchCheckpoint: boolean,
): AiJobPriorityCheckpoint | AiJobResearchCheckpoint | AiJobLegacyResearchCheckpoint | null {
  if (row.checkpoint_json === null) return null;
  try {
    const parsed = JSON.parse(row.checkpoint_json) as unknown;
    if (canonicalJson(parsed) !== row.checkpoint_json) {
      return corrupt("Stored AI job checkpoint is invalid");
    }
    if (row.kind === "resource_research" && strictResearchCheckpoint) {
      const checkpoint = parseResearchCheckpoint(parsed);
      if (checkpoint === undefined ||
          Buffer.byteLength(row.checkpoint_json, "utf8") > 2_048) {
        return corrupt("Stored research checkpoint is invalid");
      }
      return checkpoint;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return corrupt("Stored AI job checkpoint is invalid");
    }
    const record = parsed as Record<string, unknown>;
    const checkpointKey = row.kind === "priority_assessment" ? "nextOffset" : "nextStep";
    if (Object.keys(record).sort().join(",") !== `${checkpointKey},version` ||
        record.version !== 1 || !isSafeCount(record[checkpointKey])) {
      return corrupt("Stored AI job checkpoint is invalid");
    }
    return row.kind === "priority_assessment"
      ? { version: 1, nextOffset: record.nextOffset as number }
      : { version: 1, nextStep: record.nextStep as number };
  } catch (error) {
    if (error instanceof DurableAiJobError) throw error;
    return corrupt("Stored AI job checkpoint is invalid");
  }
}

function isSafeCount(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isBoundedTrimmed(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim() === value &&
    Buffer.byteLength(value, "utf8") >= minimum &&
    Buffer.byteLength(value, "utf8") <= maximum;
}

export function fingerprintAiJobGuardProjection(
  columns: readonly Readonly<Record<string, unknown>>[],
  rows: readonly (readonly AiJobGuardParameter[])[],
): string {
  return createHash("sha256").update(canonicalJson({ columns, rows }), "utf8")
    .digest("hex");
}

type AiJobGuardExecution =
  | {
      readonly kind: "projection";
      readonly fingerprint: string;
      readonly matches: boolean;
      readonly rowCount: number;
    }
  | {
      readonly kind: "overflow";
      readonly guardLimit: {
        readonly kind: "rows" | "bytes";
        readonly limit: number;
        readonly observed: number;
        readonly rowCount: number;
      };
      readonly rowCount: number;
    };

function executeReadGuard(
  connection: Database.Database,
  definitions: Readonly<Record<string, OwnedAiJobGuardDefinition>>,
  guard: AiJobReadGuard | {
    readonly guardId: string;
    readonly args: readonly AiJobGuardParameter[];
  },
): AiJobGuardExecution {
  const hasExpected = "expectedFingerprint" in guard;
  if (guard === null || typeof guard !== "object" || Array.isArray(guard) ||
      Object.keys(guard).sort().join(",") !==
        (hasExpected ? "args,expectedFingerprint,guardId" : "args,guardId") ||
      !isBoundedTrimmed(guard.guardId, 1, 128) || !Array.isArray(guard.args) ||
      guard.args.length > 100 ||
      guard.args.some((value) => value !== null &&
        (typeof value !== "string" && typeof value !== "number" ||
          typeof value === "string" && Buffer.byteLength(value, "utf8") > 4096 ||
          typeof value === "number" && (!Number.isFinite(value) ||
            !Number.isSafeInteger(value)))) ||
      hasExpected && !/^[0-9a-f]{64}$/.test(guard.expectedFingerprint)) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job read guard");
  }
  const definition = definitions[guard.guardId];
  if (definition === undefined || !Array.isArray(definition.parameters) ||
      definition.parameters.length !== guard.args.length) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job read guard");
  }
  const args = guard.args;
  if (args.some((value, index) => {
    const type = definition.parameters[index];
    return type === "positive_safe_integer"
      ? !isSafeCount(value, 1)
      : type === "fingerprint"
        ? typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)
        : type === "bounded_text"
          ? !isBoundedTrimmed(value, 1, 4096)
          : type === "nullable_bounded_text"
            ? value !== null && !isBoundedTrimmed(value, 1, 4096)
            : true;
  })) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job read guard args");
  }
  const statement = definition.statement;
  if (statement.database !== connection || !statement.readonly || !statement.reader ||
      statement.busy) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job read guard");
  }
  const columns = statement.columns().map((column) => ({
    name: column.name,
    column: column.column,
    table: column.table,
    database: column.database,
    type: column.type,
  }));
  const rows: AiJobGuardParameter[][] = [];
  let projectionBytes = Buffer.byteLength(
    `{"columns":${canonicalJson(columns)},"rows":[]}`,
    "utf8",
  );
  try {
    const iterator = statement.raw(true).iterate(...args);
    for (const row of iterator as Iterable<unknown[]>) {
      if (row.length !== columns.length ||
          row.some((value) => value !== null && typeof value !== "string" &&
            typeof value !== "number" || typeof value === "number" &&
            (!Number.isFinite(value) || !Number.isSafeInteger(value)))) {
        throw new DurableAiJobError(
          "INVALID_JOB_TRANSITION",
          "AI job read guard result invalid",
        );
      }
      const rowCount = rows.length + 1;
      if (rowCount > aiJobGuardMaximumRows) {
        return {
          kind: "overflow",
          guardLimit: {
            kind: "rows",
            limit: aiJobGuardMaximumRows,
            observed: rowCount,
            rowCount,
          },
          rowCount,
        };
      }
      projectionBytes += Buffer.byteLength(canonicalJson(row), "utf8") +
        (rows.length === 0 ? 0 : 1);
      if (projectionBytes > aiJobGuardMaximumBytes) {
        return {
          kind: "overflow",
          guardLimit: {
            kind: "bytes",
            limit: aiJobGuardMaximumBytes,
            observed: projectionBytes,
            rowCount,
          },
          rowCount,
        };
      }
      rows.push(row as AiJobGuardParameter[]);
    }
  } catch {
    throw new DurableAiJobError("INVALID_JOB_TRANSITION", "AI job read guard failed");
  }
  let projectionJson: string;
  try {
    projectionJson = canonicalJson({ columns, rows });
  } catch {
    throw new DurableAiJobError("INVALID_JOB_TRANSITION", "AI job read guard overflow");
  }
  if (Buffer.byteLength(projectionJson, "utf8") > aiJobGuardMaximumBytes) {
    throw new DurableAiJobError("INVALID_JOB_TRANSITION", "AI job read guard overflow");
  }
  const projectionHash = createHash("sha256").update(projectionJson, "utf8").digest("hex");
  return {
    kind: "projection",
    fingerprint: projectionHash,
    matches: hasExpected && projectionHash === guard.expectedFingerprint,
    rowCount: rows.length,
  };
}

function validateStoredRow(row: AiJobRow): void {
  const active = row.status === "queued" || row.status === "running";
  const terminal = !active;
  const leaseComplete = row.lease_owner !== null && row.lease_token !== null &&
    row.lease_expires_at !== null;
  const cancellationComplete = row.cancellation_requested_by !== null &&
    row.cancellation_requested_at !== null;
  const resultComplete = row.result_type !== null;
  const errorComplete = row.error_code !== null && row.error_message !== null;
  if (!isSafeCount(row.id, 1) || !/^[0-9a-f]{64}$/.test(row.input_fingerprint) ||
      !/^[0-9a-f]{64}$/.test(row.submission_fingerprint) ||
      !isSafeCount(row.attempts) || !isSafeCount(row.max_attempts, 1) ||
      row.max_attempts > 100 || row.attempts > row.max_attempts ||
      !isSafeCount(row.progress_completed) ||
      row.progress_total !== null && (!isSafeCount(row.progress_total) ||
        row.progress_completed > row.progress_total) ||
      !isBoundedTrimmed(row.progress_stage, 1, 128) ||
      !isSafeCount(row.spent_steps) || !isSafeCount(row.max_steps, 1) ||
      row.spent_steps > row.max_steps ||
      !isSafeCount(row.spent_tokens) || !isSafeCount(row.max_tokens) ||
      row.spent_tokens > row.max_tokens ||
      typeof row.spent_cost_usd !== "number" || !Number.isFinite(row.spent_cost_usd) ||
      row.spent_cost_usd < 0 || row.spent_cost_usd > 1e308 ||
      typeof row.max_cost_usd !== "number" || !Number.isFinite(row.max_cost_usd) ||
      row.max_cost_usd < 0 || row.max_cost_usd > 1e308 ||
      row.spent_cost_usd > row.max_cost_usd ||
      !isSafeCount(row.spent_wall_time_ms) || !isSafeCount(row.max_wall_time_ms, 1) ||
      row.spent_wall_time_ms > row.max_wall_time_ms ||
      !isSafeCount(row.event_sequence, 1) ||
      !isCanonicalTimestamp(row.created_at) || !isCanonicalTimestamp(row.updated_at) ||
      !isCanonicalTimestamp(row.available_at) || row.updated_at < row.created_at ||
      row.available_at < row.created_at ||
      row.started_at !== null && (!isCanonicalTimestamp(row.started_at) ||
        row.started_at < row.created_at) ||
      row.completed_at !== null && (!isCanonicalTimestamp(row.completed_at) ||
        row.completed_at < row.created_at ||
        row.completed_at > row.updated_at ||
        row.started_at !== null && row.completed_at < row.started_at) ||
      row.lease_owner !== null && !isBoundedTrimmed(row.lease_owner, 1, 200) ||
      row.lease_token !== null && !isBoundedTrimmed(row.lease_token, 16, 200) ||
      row.lease_expires_at !== null && !isCanonicalTimestamp(row.lease_expires_at) ||
      row.lease_expires_at !== null && row.lease_expires_at <= row.updated_at ||
      row.status === "running" && (!leaseComplete || row.started_at === null ||
        row.completed_at !== null) ||
      row.status !== "running" && (row.lease_owner !== null || row.lease_token !== null ||
        row.lease_expires_at !== null) ||
      active && row.completed_at !== null || terminal && row.completed_at === null ||
      (row.cancellation_requested_by === null) !== (row.cancellation_requested_at === null) ||
      cancellationComplete && row.status !== "running" && row.status !== "cancelled" ||
      row.cancellation_requested_at !== null &&
        (!isCanonicalTimestamp(row.cancellation_requested_at) ||
          row.cancellation_requested_at < row.created_at ||
          row.cancellation_requested_at > row.updated_at) ||
      (row.error_code === null) !== (row.error_message === null) ||
      errorComplete && !["queued", "failed", "partial"].includes(row.status) ||
      row.error_message !== null && !isBoundedTrimmed(row.error_message, 1, 1024) ||
      resultComplete !== (row.result_output_fingerprint !== null || row.result_report_id !== null) ||
      row.status !== "succeeded" && row.status !== "partial" && resultComplete ||
      (row.status === "succeeded" || row.status === "partial") && !resultComplete ||
      row.status === "succeeded" && errorComplete ||
      row.status === "partial" && row.error_code !== "JOB_BUDGET_EXHAUSTED" ||
      row.status === "failed" && !errorComplete ||
      (row.status === "cancelled" || row.status === "superseded") && errorComplete ||
      row.attempts === 0 && row.started_at !== null ||
      row.attempts > 0 && row.started_at === null) {
    corrupt();
  }
}

function mapRow(row: AiJobRow, strictResearchCheckpoint: boolean): DurableJobView {
  validateStoredRow(row);
  taskFromRow(row);
  checkpointFromRow(row, strictResearchCheckpoint);
  const subject = subjectFromRow(row);
  const result = row.result_type === null
    ? null
    : row.result_type === "priority_output" && row.result_output_fingerprint !== null
      ? { type: "priority_assessment" as const,
          outputFingerprint: row.result_output_fingerprint }
      : row.result_type === "research_report" && isSafeCount(row.result_report_id, 1)
        ? { type: "resource_research" as const, reportId: row.result_report_id }
        : corrupt();
  const error = row.error_code === null && row.error_message === null
    ? null
    : row.error_code !== null && row.error_message !== null
      ? { type: "durable" as const, code: row.error_code, message: row.error_message }
      : corrupt();
  const view: DurableJobView = {
    id: `${row.kind}:${row.id}`,
    kind: row.kind,
    subject,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: {
      completed: row.progress_completed,
      total: row.progress_total,
      stage: row.progress_stage,
    },
    canCancel: (row.status === "queued" || row.status === "running")
      && row.cancellation_requested_at === null,
    cancellationRequest: row.cancellation_requested_at === null
      ? null
      : row.cancellation_requested_by === null
        ? corrupt()
        : {
          requestedBy: row.cancellation_requested_by,
          requestedAt: row.cancellation_requested_at,
        },
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextAttemptAt: row.status === "queued" ? row.available_at : null,
    error,
    result,
  };
  const parsed = durableJobViewSchema.safeParse(view);
  if (!parsed.success) return corrupt();
  return parsed.data;
}

function taskFromRow(row: AiJobRow): NewAiTaskSpec {
  const subject = subjectFromRow(row);
  const provenance = row.requested_by === "agent"
    ? {
        requestedBy: row.requested_by,
        requestMethod: row.request_method,
        authorizationRef: row.authorization_ref,
      }
    : { requestedBy: row.requested_by, requestMethod: row.request_method };
  const common = {
    version: 1 as const,
    kind: row.kind,
    subject,
    inputFingerprint: row.input_fingerprint,
    idempotencyKey: row.idempotency_key,
    provenance,
    schedulingPriority: row.scheduling_priority,
    budget: {
      maxSteps: row.max_steps,
      maxTokens: row.max_tokens,
      maxCostUsd: row.max_cost_usd,
      maxWallTimeMs: row.max_wall_time_ms,
    },
  };
  const candidate: unknown = row.kind === "priority_assessment"
    ? {
        ...common,
        ruleset: { rulesetId: row.ruleset_id, version: row.ruleset_version },
        assessmentProvenance: row.assessment_method === "rule"
          ? { method: "rule" }
          : {
              method: row.assessment_method,
              model: {
                provider: row.assessment_model_provider,
                name: row.assessment_model_name,
                promptVersion: row.assessment_prompt_version,
              },
            },
        stepBatchSize: row.step_batch_size,
      }
    : {
        ...common,
        workflowRef: { id: row.workflow_id, version: row.workflow_version },
      };
  const parsed = aiTaskSpecSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind === "page_summary") return corrupt();
  const { idempotencyKey: _idempotencyKey, ...submissionPayload } = parsed.data;
  if (row.kind !== "resource_research" &&
      fingerprint(submissionPayload).hash !== row.submission_fingerprint) return corrupt();
  return parsed.data;
}

function executionStateFromRow(
  row: AiJobRow,
  tokenUsage: { readonly inputTokens: number; readonly outputTokens: number },
  strictResearchCheckpoint: boolean,
): Pick<AiJobClaim,
  "task" | "inputFingerprint" | "createdAt" | "progress" | "checkpoint" | "usage"> {
  mapRow(row, strictResearchCheckpoint);
  const task = taskFromRow(row);
  const checkpoint = checkpointFromRow(row, strictResearchCheckpoint);
  if (!isSafeCount(row.spent_steps) || !isSafeCount(row.spent_tokens) ||
      !isSafeCount(row.spent_wall_time_ms) || typeof row.spent_cost_usd !== "number" ||
      !Number.isFinite(row.spent_cost_usd) || row.spent_cost_usd < 0) return corrupt();
  return {
    task,
    inputFingerprint: task.inputFingerprint,
    createdAt: row.created_at,
    progress: {
      completed: row.progress_completed,
      total: row.progress_total,
      stage: row.progress_stage,
    },
    checkpoint,
    usage: {
      steps: row.spent_steps,
      ...tokenUsage,
      costUsd: row.spent_cost_usd,
      wallTimeMs: row.spent_wall_time_ms,
    },
  };
}

function normalizeNewTask(value: unknown): NewAiTaskSpec {
  const parsed = aiTaskSpecSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind === "page_summary") {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid new AI job input");
  }
  return parsed.data;
}

function subjectColumns(task: NewAiTaskSpec): {
  subjectType: NewAiTaskSpec["subject"]["type"];
  logicalPageId: number | null;
  resourceId: number | null;
  collectionScope: "all" | null;
  selectionFingerprint: string | null;
} {
  return {
    subjectType: task.subject.type,
    logicalPageId: task.subject.type === "page" ? task.subject.logicalPageId : null,
    resourceId: task.subject.type === "resource" ? task.subject.resourceId : null,
    collectionScope: task.subject.type === "collection" ? "all" : null,
    selectionFingerprint: task.subject.type === "selection"
      ? task.subject.fingerprint : null,
  };
}

export interface AiJobLedger extends NewAiJobAdapter {
  replayAgentResearchStart(
    request: AgentResearchStartRequest,
  ): DurableJobRef | undefined;
  submitResearch(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
  ): DurableJobRef;
  submitAgentResearch(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
    command: AgentResearchCommand,
  ): DurableJobRef;
  cancelAgentResearch(id: number, command: AgentResearchCommand): DurableJobView;
  claimNext(
    kind: NewAiTaskSpec["kind"],
    workerId: string,
    limits: AiJobScheduleLimit,
    claimBoundary?: AiJobClaimBoundary,
    workflowAllowlist?: AiJobWorkflowAllowlist,
  ): AiJobClaim | undefined;
  renew(claim: AiJobClaim): AiJobRenewedLease | undefined;
  /**
   * Re-read the ledger-owned execution envelope without writing. The current
   * lease is validated before cumulative progress/checkpoint/usage is exposed,
   * so consumers never need to inspect physical ledger tables.
   */
  refresh(claim: AiJobClaim): AiJobClaim;
  checkpoint(claim: AiJobClaim, input: AiJobCheckpointInput): DurableJobView;
  completeIf(
    claim: AiJobClaim,
    input: AiJobGuardedCompletion,
  ): { readonly completed: boolean; readonly view: DurableJobView };
  completePartialIfGuardLimit(
    claim: AiJobClaim,
    input: AiJobGuardLimitCompletionInput,
  ): { readonly completed: boolean; readonly view: DurableJobView };
  completePartial(
    claim: AiJobClaim,
    input: AiJobPartialCompletionInput,
  ): DurableJobView;
  bindAttemptProvider(claim: AiJobClaim, metadata: AiJobAttemptMetadata): void;
  recordAttemptRequest(claim: AiJobClaim, requestId: string): void;
  complete(
    claim: AiJobClaim,
    checkpoint: AiJobCheckpointInput,
    completion: AiJobResearchCompletion,
  ): DurableJobView;
  completeResearch(
    claim: AiJobClaim,
    checkpoint: AiJobCheckpointInput,
    draft: ResearchPublicationDraft,
  ): DurableJobView;
  fail(
    claim: AiJobClaim,
    checkpoint: AiJobCheckpointInput,
    failure: AiJobFailure,
  ): DurableJobView;
  recoverInterrupted(workflowAllowlist?: AiJobWorkflowAllowlist): number;
  settleExpiredCancellation(input: AiJobExpiredCancellation): DurableJobView;
}

export interface AiJobWorkflowRef {
  readonly id: string;
  readonly version: number;
}

export type AiJobWorkflowAllowlist = readonly [
  AiJobWorkflowRef,
  ...AiJobWorkflowRef[],
];

interface NormalizedAiJobWorkflowAllowlist {
  readonly entries: AiJobWorkflowAllowlist;
  readonly json: string;
}

export function createAiJobLedger(
  connection: Database.Database,
  options: AiJobLedgerOptions,
): AiJobLedger {
  const runtimeClaimBoundary = prepareAiJobRuntimeClaimBoundary(connection);
  const clock = options.clock ?? (() => new Date());
  const research = options.research;
  const schemaVersion = connection.pragma("user_version", { simple: true }) as number;
  const schemaRequiresResearchAdapter = schemaVersion >= 24;
  const schemaHasLiveProviderReservations = schemaVersion >= 25;
  const schemaHasPrivacyPurgeBudgetCarryover = schemaVersion >= 26;
  const researchCorpusReader = options.researchCorpusReader === null
    ? undefined
    : options.researchCorpusReader ??
      (research === undefined ? undefined : createResearchCorpusReader(connection));
  if (research !== undefined && research.connection !== connection) {
    throw new DurableAiJobError(
      "INVALID_JOB_INPUT",
      "Research adapter must own the AI ledger connection",
    );
  }
  const guards = Object.freeze(Object.fromEntries(Object.entries(options.guards ?? {}).map(
    ([id, definition]) => {
      if (!isBoundedTrimmed(id, 1, 128) || definition === null ||
          typeof definition !== "object" || Array.isArray(definition) ||
          Object.keys(definition).sort().join(",") !== "parameters,sql,usage" ||
          !isBoundedTrimmed(definition.sql, 1, 16_384) ||
          !Array.isArray(definition.parameters) || definition.parameters.length > 100 ||
          definition.parameters.some((value) => ![
            "positive_safe_integer", "fingerprint", "bounded_text",
            "nullable_bounded_text",
          ].includes(value)) || definition.usage === null ||
          typeof definition.usage !== "object" || Array.isArray(definition.usage) ||
          Object.keys(definition.usage).join(",") !== "stepsPerRow" ||
          definition.usage.stepsPerRow !== 1) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job guard registry");
      }
      let statement: Database.Statement;
      try {
        statement = connection.prepare(definition.sql);
      } catch {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job guard registry");
      }
      if (statement.database !== connection || !statement.readonly || !statement.reader ||
          statement.busy || /^\s*PRAGMA\b/i.test(definition.sql)) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job guard registry");
      }
      return [id, Object.freeze({
        statement,
        parameters: Object.freeze([...definition.parameters]),
        stepsPerRow: definition.usage.stepsPerRow,
      })];
    },
  )));
  const selectIdempotency = connection.prepare(`
    SELECT job_id AS id, kind, submission_fingerprint
    FROM ai_job_idempotency_receipts WHERE idempotency_key = ?
  `);
  const insertIdempotencyReceipt = connection.prepare(`
    INSERT INTO ai_job_idempotency_receipts (
      idempotency_key, submission_fingerprint, job_id, kind, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectAgentResearchCommandReceipt = schemaRequiresResearchAdapter
    ? connection.prepare(`
        SELECT operation, request_fingerprint, authorization_ref_hash, job_id, created_at
        FROM agent_research_command_receipts WHERE idempotency_key_hash = ?
      `)
    : undefined;
  const insertAgentResearchCommandReceipt = schemaRequiresResearchAdapter
    ? connection.prepare(`
        INSERT INTO agent_research_command_receipts (
          idempotency_key_hash, operation, request_fingerprint,
          authorization_ref_hash, job_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
    : undefined;
  const selectActive = connection.prepare(`
    SELECT ai_jobs.id, ai_jobs.kind, ai_jobs.input_fingerprint,
      ai_jobs.submission_fingerprint, ai_jobs.status, ai_jobs.updated_at,
      ai_jobs.lease_token, ai_jobs.event_sequence,
      (SELECT id FROM ai_job_attempts
        WHERE job_id = ai_jobs.id AND outcome = 'running' LIMIT 1) AS attempt_id
    FROM ai_jobs
    WHERE kind = ? AND subject_key = ? AND status IN ('queued', 'running')
    LIMIT 1
  `);
  const selectRow = connection.prepare(`SELECT * FROM ai_jobs WHERE kind = ? AND id = ?`);
  const selectPage = connection.prepare(`SELECT 1 FROM logical_pages WHERE id = ?`);
  const selectActiveResource = connection.prepare(`
    SELECT 1 FROM resource_heads
    JOIN resource_events ON resource_events.id = resource_heads.event_id
      AND resource_events.resource_id = resource_heads.resource_id
    WHERE resource_heads.resource_id = ? AND resource_events.lifecycle_state = 'active'
  `);
  const workflowMembership = (jobAlias: string): string => `
    (@workflowAllowlistJson IS NULL OR EXISTS (
      SELECT 1 FROM json_each(@workflowAllowlistJson) AS allowed_workflow
      WHERE json_extract(allowed_workflow.value, '$[0]') = ${jobAlias}.workflow_id
        AND json_extract(allowed_workflow.value, '$[1]') = ${jobAlias}.workflow_version
    ))
  `;
  const insertJob = connection.prepare(`
    INSERT INTO ai_jobs (
      kind, subject_type, logical_page_id, resource_id, collection_scope,
      selection_fingerprint, subject_key,
      requested_by, request_method, authorization_ref,
      idempotency_key, submission_fingerprint, input_fingerprint,
      ruleset_id, ruleset_version, assessment_method,
      assessment_model_provider, assessment_model_name, assessment_prompt_version,
      workflow_id, workflow_version, step_batch_size, scheduling_priority,
      progress_total, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      available_at, created_at, updated_at
    ) VALUES (
      @kind, @subjectType, @logicalPageId, @resourceId, @collectionScope,
      @selectionFingerprint, @subjectKey,
      @requestedBy, @requestMethod, @authorizationRef,
      @idempotencyKey, @submissionFingerprint, @inputFingerprint,
      @rulesetId, @rulesetVersion, @assessmentMethod,
      @assessmentModelProvider, @assessmentModelName, @assessmentPromptVersion,
      @workflowId, @workflowVersion, @stepBatchSize, @schedulingPriority,
      @progressTotal, @maxSteps, @maxTokens, @maxCostUsd, @maxWallTimeMs,
      @availableAt, @createdAt, @updatedAt
    )
  `);
  const insertEvent = connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, attempt_id,
      lease_token, cancellation_requested_by, error_code, available_at,
      occurred_at
    ) VALUES (
      @jobId, @sequenceNo, @eventType, @fromStatus, @toStatus, @attemptId,
      @leaseToken, @cancellationRequestedBy, @errorCode, @availableAt,
      @occurredAt
    )
  `);
  const insertExpiredCancellationEvent = connection.prepare(`
    INSERT INTO ai_job_events (
      id, job_id, sequence_no, event_type, from_status, to_status,
      attempt_id, lease_token, occurred_at
    ) VALUES (
      @id, @jobId, @sequenceNo, 'cancelled', 'running', 'cancelled',
      @attemptId, @leaseToken, @occurredAt
    )
  `);
  const selectNext = connection.prepare(`
    SELECT candidate.id FROM ai_jobs AS candidate
    WHERE candidate.kind = @kind AND candidate.status = 'queued'
      AND candidate.available_at <= @now
      AND ${workflowMembership("candidate")}
    ORDER BY candidate.scheduling_priority DESC, candidate.available_at ASC,
      candidate.created_at ASC, candidate.id ASC
    LIMIT 1
  `);
  const selectClaimUsage = connection.prepare(schemaHasLiveProviderReservations ? `
    WITH matching_jobs AS (
      SELECT job.* FROM ai_jobs AS job
      WHERE job.kind = @kind AND ${workflowMembership("job")}
    ), attributed_attempts AS (
      SELECT attempt.id, attempt.job_id, attempt.outcome, attempt.provider,
        attempt.provider_bound_at, attempt.started_at, attempt.cost_usd,
        job.workflow_id, job.workflow_version,
        COALESCE(adoption.utc_date, substr(attempt.provider_bound_at, 1, 10))
          AS provider_utc_date
      FROM ai_job_attempts AS attempt
      JOIN matching_jobs AS job ON job.id = attempt.job_id
      LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
        ON adoption.attempt_id = attempt.id AND adoption.final_job_id = attempt.job_id
    )
    SELECT
      (SELECT COUNT(*) FROM matching_jobs WHERE status = 'running') AS running,
      (SELECT COUNT(*) FROM attributed_attempts AS attempt
        WHERE (
          attempt.workflow_id = @liveWorkflowId
          AND attempt.workflow_version = @liveWorkflowVersion
          AND attempt.started_at >= @dayStart AND attempt.started_at < @dayEnd
        ) OR (
          NOT (attempt.workflow_id IS @liveWorkflowId
            AND attempt.workflow_version IS @liveWorkflowVersion)
          AND attempt.provider IS NOT NULL
          AND attempt.provider_utc_date = @utcDate
        ))${schemaHasPrivacyPurgeBudgetCarryover ? ` + (
        SELECT COALESCE(SUM(carryover.coordinator_starts), 0)
        FROM privacy_purge_active_budget_carryover AS carryover
        WHERE @kind = 'resource_research'
          AND carryover.utc_date = @utcDate
          AND carryover.budget_class = 'c90_coordinator'
          AND carryover.job_kind = @kind
          AND carryover.workflow_id = @liveWorkflowId
          AND carryover.workflow_version = @liveWorkflowVersion
          AND (@workflowAllowlistJson IS NULL OR EXISTS (
            SELECT 1 FROM json_each(@workflowAllowlistJson) AS allowed_workflow
            WHERE json_extract(allowed_workflow.value, '$[0]') = @liveWorkflowId
              AND json_extract(allowed_workflow.value, '$[1]') = @liveWorkflowVersion
          ))
      ) + (
        SELECT COALESCE(SUM(carryover.provider_attempts), 0)
        FROM privacy_purge_active_budget_carryover AS carryover
        WHERE carryover.utc_date = @utcDate
          AND carryover.budget_class = 'provider'
          AND carryover.job_kind = @kind
          AND (@workflowAllowlistJson IS NULL OR EXISTS (
            SELECT 1 FROM json_each(@workflowAllowlistJson) AS allowed_workflow
            WHERE json_extract(allowed_workflow.value, '$[0]') = carryover.workflow_id
              AND json_extract(allowed_workflow.value, '$[1]') = carryover.workflow_version
          ))
      )` : ""} AS attempts_utc_day,
      (
        SELECT COALESCE(SUM(event.delta_cost_usd), 0)
        FROM ai_job_events AS event
        JOIN matching_jobs AS job ON job.id = event.job_id
        WHERE event.event_type = 'progress'
          AND event.occurred_at >= @dayStart AND event.occurred_at < @dayEnd
          AND (@kind <> 'resource_research' OR (
            job.workflow_id = @liveWorkflowId
            AND job.workflow_version = @liveWorkflowVersion
          ))
      ) + (
        SELECT COALESCE(SUM(attempt.cost_usd), 0)
        FROM attributed_attempts AS attempt
        WHERE @kind = 'resource_research'
          AND NOT (attempt.workflow_id IS @liveWorkflowId
            AND attempt.workflow_version IS @liveWorkflowVersion)
          AND attempt.provider IS NOT NULL
          AND attempt.provider_utc_date = @utcDate
      )${schemaHasPrivacyPurgeBudgetCarryover ? ` + (
        SELECT COALESCE(SUM(carryover.charged_cost_nanos), 0) / 1000000000.0
        FROM privacy_purge_active_budget_carryover AS carryover
        WHERE carryover.utc_date = @utcDate
          AND carryover.budget_class = 'provider'
          AND carryover.job_kind = @kind
          AND (@workflowAllowlistJson IS NULL OR EXISTS (
            SELECT 1 FROM json_each(@workflowAllowlistJson) AS allowed_workflow
            WHERE json_extract(allowed_workflow.value, '$[0]') = carryover.workflow_id
              AND json_extract(allowed_workflow.value, '$[1]') = carryover.workflow_version
          ))
      )` : ""} AS cost_usd_utc_day,
      (
        SELECT COALESCE(SUM(reservation.reserved_usd - reservation.consumed_usd), 0)
        FROM live_acquisition_provider_reservations AS reservation
        JOIN matching_jobs AS job ON job.id = reservation.final_job_id
        WHERE reservation.status = 'active' AND reservation.utc_date = @utcDate
      ) + (
        SELECT COALESCE(SUM(job.max_cost_usd - job.spent_cost_usd), 0)
        FROM matching_jobs AS job
        JOIN attributed_attempts AS attempt
          ON attempt.job_id = job.id AND attempt.outcome = 'running'
        WHERE job.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM live_acquisition_provider_reservations AS reservation
            WHERE reservation.final_job_id = job.id AND reservation.status = 'active'
          )
          AND (attempt.provider IS NULL OR attempt.provider_utc_date = @utcDate)
      )${schemaHasPrivacyPurgeBudgetCarryover ? ` + (
        SELECT COALESCE(SUM(carryover.active_exposure_nanos), 0) / 1000000000.0
        FROM privacy_purge_active_budget_carryover AS carryover
        WHERE carryover.utc_date = @utcDate
          AND carryover.budget_class = 'provider'
          AND carryover.job_kind = @kind
          AND (@workflowAllowlistJson IS NULL OR EXISTS (
            SELECT 1 FROM json_each(@workflowAllowlistJson) AS allowed_workflow
            WHERE json_extract(allowed_workflow.value, '$[0]') = carryover.workflow_id
              AND json_extract(allowed_workflow.value, '$[1]') = carryover.workflow_version
          ))
      )` : ""} AS running_cost_reservation
  ` : `
    SELECT
      (SELECT COUNT(*) FROM ai_jobs AS running_job
        WHERE running_job.kind = @kind AND running_job.status = 'running'
          AND ${workflowMembership("running_job")}) AS running,
      (SELECT COUNT(*) FROM ai_job_attempts
        JOIN ai_jobs AS attempted_job ON attempted_job.id = ai_job_attempts.job_id
        WHERE attempted_job.kind = @kind
          AND ${workflowMembership("attempted_job")}
          AND ai_job_attempts.started_at >= @dayStart
          AND ai_job_attempts.started_at < @dayEnd) AS attempts_utc_day,
      (SELECT COALESCE(SUM(cost_delta), 0) FROM (
        SELECT ai_jobs.id AS job_id, kind, workflow_id, workflow_version,
          occurred_at, delta_cost_usd AS cost_delta
        FROM ai_job_events
        JOIN ai_jobs ON ai_jobs.id = ai_job_events.job_id
        WHERE event_type = 'progress'
      ) AS cost_job WHERE cost_job.kind = @kind
        AND ${workflowMembership("cost_job")}
        AND occurred_at >= @dayStart
        AND occurred_at < @dayEnd) AS cost_usd_utc_day,
      (SELECT COALESCE(SUM(max_cost_usd - spent_cost_usd), 0)
        FROM ai_jobs AS reserved_job
        WHERE reserved_job.kind = @kind AND reserved_job.status = 'running'
          AND ${workflowMembership("reserved_job")}) AS running_cost_reservation
  `);
  const selectSchema26ProviderBindUsage = schemaHasPrivacyPurgeBudgetCarryover
    ? connection.prepare(`
      WITH attributed_attempts AS (
        SELECT attempt.id, attempt.cost_usd,
          COALESCE(adoption.utc_date, substr(attempt.provider_bound_at, 1, 10))
            AS provider_utc_date
        FROM ai_job_attempts AS attempt
        JOIN ai_jobs AS job ON job.id = attempt.job_id
        LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
          ON adoption.attempt_id = attempt.id
          AND adoption.final_job_id = attempt.job_id
        WHERE job.kind = 'resource_research'
          AND NOT (job.workflow_id IS @liveWorkflowId
            AND job.workflow_version IS @liveWorkflowVersion)
          AND attempt.provider IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*) FROM attributed_attempts
          WHERE provider_utc_date = @utcDate) +
        (SELECT TOTAL(provider_attempts)
          FROM privacy_purge_active_budget_carryover
          WHERE utc_date = @utcDate AND budget_class = 'provider')
          AS provider_attempts,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM attributed_attempts
          WHERE provider_utc_date = @utcDate) +
        (SELECT COALESCE(SUM(reserved_usd - consumed_usd), 0)
          FROM live_acquisition_provider_reservations
          WHERE status = 'active' AND utc_date = @utcDate) +
        (SELECT COALESCE(SUM(job.max_cost_usd - job.spent_cost_usd), 0)
          FROM ai_jobs AS job
          JOIN ai_job_attempts AS attempt
            ON attempt.job_id = job.id AND attempt.outcome = 'running'
          LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
            ON adoption.attempt_id = attempt.id AND adoption.final_job_id = job.id
          WHERE job.kind = 'resource_research' AND job.status = 'running'
            AND NOT (job.workflow_id IS @liveWorkflowId
              AND job.workflow_version IS @liveWorkflowVersion)
            AND NOT EXISTS (
              SELECT 1 FROM live_acquisition_provider_reservations AS reservation
              WHERE reservation.final_job_id = job.id
                AND reservation.status = 'active'
            )
            AND (attempt.provider IS NULL OR COALESCE(
              adoption.utc_date, substr(attempt.provider_bound_at, 1, 10)
            ) = @utcDate)) +
        (SELECT (
            TOTAL(charged_cost_nanos) + TOTAL(active_exposure_nanos)
          ) / 1000000000.0
          FROM privacy_purge_active_budget_carryover
          WHERE utc_date = @utcDate AND budget_class = 'provider')
          AS provider_cost_and_outstanding,
        (SELECT COALESCE(MAX(legacy25_day_block), 0)
          FROM privacy_purge_active_budget_carryover
          WHERE utc_date = @utcDate) AS legacy25_day_block
    `)
    : undefined;
  const selectReadyToDefer = connection.prepare(`
    SELECT deferred_job.id, deferred_job.status, deferred_job.event_sequence,
      deferred_job.updated_at
    FROM ai_jobs AS deferred_job
    WHERE deferred_job.kind = @kind AND deferred_job.status = 'queued'
      AND deferred_job.available_at <= @now
      AND ${workflowMembership("deferred_job")}
    ORDER BY deferred_job.id
  `);
  const insertAttempt = schemaRequiresResearchAdapter
    ? connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, provider, model,
          prompt_version, pricing_version, provider_bound_at, request_id,
          request_bound_at, started_at, outcome
        )
        SELECT @jobId, @attemptNo, @leaseToken, @workerId, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, @startedAt, 'running'
        FROM ai_jobs AS claim_candidate
        WHERE claim_candidate.id = @jobId
          AND claim_candidate.kind = @kind
          AND claim_candidate.status = 'queued'
          AND claim_candidate.cancellation_requested_at IS NULL
          AND claim_candidate.available_at <= @startedAt
          AND claim_candidate.attempts < claim_candidate.max_attempts
          AND @attemptNo = claim_candidate.attempts + 1
          AND @startedAt >= claim_candidate.updated_at
          AND claim_candidate.spent_steps < claim_candidate.max_steps
          AND (claim_candidate.max_tokens = 0 OR
            claim_candidate.spent_tokens < claim_candidate.max_tokens)
          AND (claim_candidate.max_cost_usd = 0 OR
            claim_candidate.spent_cost_usd < claim_candidate.max_cost_usd)
          AND claim_candidate.spent_wall_time_ms < claim_candidate.max_wall_time_ms
          AND ${workflowMembership("claim_candidate")}
      `)
    : connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, provider, model,
          prompt_version, provider_bound_at, request_id, request_bound_at,
          started_at, outcome
        )
        SELECT @jobId, @attemptNo, @leaseToken, @workerId, NULL, NULL, NULL,
          NULL, NULL, NULL, @startedAt, 'running'
        FROM ai_jobs AS claim_candidate
        WHERE claim_candidate.id = @jobId
          AND claim_candidate.kind = @kind
          AND claim_candidate.status = 'queued'
          AND claim_candidate.cancellation_requested_at IS NULL
          AND claim_candidate.available_at <= @startedAt
          AND claim_candidate.attempts < claim_candidate.max_attempts
          AND @attemptNo = claim_candidate.attempts + 1
          AND @startedAt >= claim_candidate.updated_at
          AND claim_candidate.spent_steps < claim_candidate.max_steps
          AND (claim_candidate.max_tokens = 0 OR
            claim_candidate.spent_tokens < claim_candidate.max_tokens)
          AND (claim_candidate.max_cost_usd = 0 OR
            claim_candidate.spent_cost_usd < claim_candidate.max_cost_usd)
          AND claim_candidate.spent_wall_time_ms < claim_candidate.max_wall_time_ms
          AND ${workflowMembership("claim_candidate")}
      `);
  const selectAttemptId = connection.prepare(`
    SELECT id FROM ai_job_attempts WHERE job_id = ? AND attempt_no = ?
  `);
  const selectLiveFinalProviderReservation = schemaHasLiveProviderReservations
    ? connection.prepare(`
        SELECT handoff.id AS handoff_id, handoff.status AS handoff_status,
          receipt.handoff_id AS receipt_handoff_id,
          reservation.id AS reservation_id, reservation.utc_date,
          reservation.reserved_usd, reservation.consumed_usd,
          reservation.status AS reservation_status,
          attempt.provider AS attempt_provider,
          adoption.attempt_id AS adopted_attempt_id
        FROM research_runs AS run
        JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
        LEFT JOIN live_acquisition_handoff_receipts AS receipt
          ON receipt.handoff_id = handoff.id
        LEFT JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.handoff_id = handoff.id
          AND reservation.final_job_id = run.job_id
        JOIN ai_job_attempts AS attempt
          ON attempt.id = @attemptId AND attempt.job_id = run.job_id
        LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
          ON adoption.attempt_id = attempt.id
          AND adoption.final_job_id = run.job_id
        WHERE run.job_id = @jobId
      `)
    : undefined;
  const insertLiveProviderReservationAdoption = schemaHasLiveProviderReservations
    ? connection.prepare(`
        INSERT INTO live_acquisition_provider_reservation_adoptions (
          attempt_id, reservation_id, final_job_id, utc_date, adopted_at
        ) VALUES (@attemptId, @reservationId, @jobId, @utcDate, @adoptedAt)
      `)
    : undefined;
  const selectLiveProviderReservationForClaim = schemaHasLiveProviderReservations
    ? connection.prepare(`
        SELECT reservation.id, reservation.utc_date, reservation.reserved_usd,
          reservation.consumed_usd, reservation.status
        FROM research_runs AS run
        JOIN live_acquisition_handoffs AS handoff ON handoff.final_run_id = run.id
        JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.handoff_id = handoff.id
          AND reservation.final_job_id = run.job_id
        WHERE run.job_id = ?
      `)
    : undefined;
  const rolloverLiveProviderReservation = schemaHasLiveProviderReservations
    ? connection.prepare(`
        UPDATE live_acquisition_provider_reservations
        SET utc_date = @utcDate
        WHERE id = @reservationId AND final_job_id = @jobId
          AND status = 'active' AND utc_date = @previousUtcDate
      `)
    : undefined;
  const selectClaimAttempt = connection.prepare(`
    SELECT attempt_no, worker_id, lease_token, outcome
    FROM ai_job_attempts WHERE id = ? AND job_id = ?
  `);
  const selectResearchPublicationProvenance = schemaRequiresResearchAdapter
    ? connection.prepare(`
    SELECT
      attempts.provider,
      attempts.model,
      attempts.prompt_version,
      attempts.pricing_version,
      attempts.request_id,
      events.occurred_at,
      events.spent_steps,
      events.spent_input_tokens,
      events.spent_output_tokens,
      events.spent_cost_usd,
      events.spent_wall_time_ms
    FROM ai_job_attempts AS attempts
    JOIN ai_job_events AS events
      ON events.job_id = attempts.job_id AND events.attempt_id = attempts.id
    WHERE attempts.id = ? AND attempts.job_id = ? AND attempts.outcome = 'running'
      AND events.sequence_no = ? AND events.event_type = 'progress'
      AND events.lease_token = ?
      `)
    : undefined;
  const selectAttempts = connection.prepare(`
    SELECT * FROM ai_job_attempts WHERE job_id = ? ORDER BY attempt_no
  `);
  const selectTokenUsage = connection.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM ai_job_attempts WHERE job_id = ?
  `);
  const selectGuardCycleCount = connection.prepare(`
    SELECT COUNT(*)
    FROM ai_job_events
    WHERE job_id = ? AND event_type = 'progress'
      AND progress_stage GLOB 'ledger:guard-cycle:[0-9]*'
      AND delta_steps > 0
  `).pluck();
  const insertProgressEvent = connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, attempt_id,
      lease_token, progress_completed, progress_total, progress_stage,
      checkpoint_json, spent_steps, spent_tokens, spent_cost_usd,
      spent_input_tokens, spent_output_tokens, spent_wall_time_ms,
      delta_input_tokens, delta_output_tokens, delta_cost_usd,
      delta_steps, delta_wall_time_ms,
      lease_owner, lease_expires_at, occurred_at
    ) VALUES (
      @jobId, @sequenceNo, 'progress', 'running', 'running', @attemptId,
      @leaseToken, @progressCompleted, @progressTotal, @progressStage,
      @checkpointJson, @spentSteps, @spentTokens, @spentCostUsd,
      @spentInputTokens, @spentOutputTokens, @spentWallTimeMs,
      @deltaInputTokens, @deltaOutputTokens, @deltaCostUsd,
      @deltaSteps, @deltaWallTimeMs,
      @leaseOwner, @leaseExpiresAt, @occurredAt
    )
  `);
  const insertCompletionEvent = connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, attempt_id,
      lease_token, result_type, result_output_fingerprint, result_report_id,
      error_code, occurred_at
    ) VALUES (
      @jobId, @sequenceNo, @eventType, 'running', @eventType, @attemptId,
      @leaseToken, @resultType, @resultOutputFingerprint, @resultReportId,
      @errorCode, @occurredAt
    )
  `);
  const selectResearchRunOwnership = schemaRequiresResearchAdapter
    ? connection.prepare(`
        SELECT 1 FROM research_runs
        WHERE job_id = ? AND approval_fingerprint = ? AND corpus_fingerprint = ?
      `)
    : undefined;
  const selectBoundResearchRun = schemaRequiresResearchAdapter
    ? connection.prepare(`SELECT 1 FROM research_runs WHERE job_id = ?`)
    : undefined;
  const selectExpired = connection.prepare(`
    SELECT expired_job.*,
      (SELECT id FROM ai_job_attempts
        WHERE job_id = expired_job.id AND outcome = 'running' LIMIT 1) AS attempt_id
    FROM ai_jobs AS expired_job
    WHERE expired_job.status = 'running' AND expired_job.lease_expires_at <= @now
      AND ${workflowMembership("expired_job")}
    ORDER BY expired_job.lease_expires_at, expired_job.id
  `);

  function read(kind: NewAiTaskSpec["kind"], id: number): AiJobRow | undefined {
    return selectRow.get(kind, id) as AiJobRow | undefined;
  }

  function assertKindMutationAvailable(kind: NewAiTaskSpec["kind"]): void {
    if (!options.kindAvailable(kind)) {
      throw new DurableAiJobError("JOB_KIND_UNAVAILABLE", "This AI job kind is unavailable");
    }
  }

  function validateAttempts(row: AiJobRow): AttemptProjectionRow[] {
    const attempts = selectAttempts.all(row.id) as AttemptProjectionRow[];
    const running = attempts.filter((attempt) => attempt.outcome === "running");
    const pricingRequired = schemaRequiresResearchAdapter &&
      row.kind === "resource_research" &&
      selectBoundResearchRun?.get(row.id) !== undefined;
    if (attempts.length !== row.attempts ||
        attempts.some((attempt, index) => !isSafeCount(attempt.id, 1) ||
          attempt.attempt_no !== index + 1 ||
          !isBoundedTrimmed(attempt.lease_token, 16, 200) ||
          !isBoundedTrimmed(attempt.worker_id, 1, 200) ||
          !isCanonicalTimestamp(attempt.started_at) ||
          attempt.started_at < row.created_at ||
          attempt.completed_at !== null && (!isCanonicalTimestamp(attempt.completed_at) ||
            attempt.completed_at < attempt.started_at) ||
          (attempt.outcome === "running") !== (attempt.completed_at === null) ||
          !isSafeCount(attempt.input_tokens) || !isSafeCount(attempt.output_tokens) ||
          typeof attempt.cost_usd !== "number" || !Number.isFinite(attempt.cost_usd) ||
          attempt.cost_usd < 0 || attempt.cost_usd > 1e308 ||
          (attempt.error_code === null) !== (attempt.error_message === null) ||
          attempt.error_code !== null && !new Set([
            "INVALID_JOB_INPUT", "JOB_SUBJECT_NOT_FOUND", "JOB_INPUT_UNAVAILABLE",
            "JOB_BUDGET_EXHAUSTED", "JOB_LEASE_LOST", "JOB_CLOCK_REGRESSION",
            "INVALID_JOB_TRANSITION", "JOB_STORAGE_CORRUPT",
          ]).has(attempt.error_code) ||
          attempt.outcome === "failed" && attempt.error_code === null ||
          attempt.outcome === "partial" &&
            attempt.error_code !== "JOB_BUDGET_EXHAUSTED" ||
          ["running", "succeeded", "cancelled", "superseded"]
            .includes(attempt.outcome) && attempt.error_code !== null ||
          (attempt.provider === null) !== (attempt.model === null) ||
          (attempt.provider === null) !== (attempt.prompt_version === null) ||
          (attempt.provider === null) !== (attempt.provider_bound_at === null) ||
          schemaRequiresResearchAdapter &&
            attempt.provider === null && attempt.pricing_version !== null ||
          pricingRequired &&
            attempt.provider !== null && attempt.pricing_version === null ||
          (attempt.request_id === null) !== (attempt.request_bound_at === null) ||
          attempt.provider !== null && !isBoundedTrimmed(attempt.provider, 1, 128) ||
          attempt.model !== null && !isBoundedTrimmed(attempt.model, 1, 200) ||
          attempt.prompt_version !== null &&
            !isBoundedTrimmed(attempt.prompt_version, 1, 128) ||
          schemaRequiresResearchAdapter && attempt.pricing_version !== null &&
            !isBoundedTrimmed(attempt.pricing_version, 1, 128) ||
          attempt.provider_bound_at !== null &&
            (!isCanonicalTimestamp(attempt.provider_bound_at) ||
              attempt.provider_bound_at < attempt.started_at) ||
          attempt.request_id !== null &&
            !isBoundedTrimmed(attempt.request_id, 1, 256) ||
          attempt.request_bound_at !== null &&
            (!isCanonicalTimestamp(attempt.request_bound_at) ||
              attempt.provider_bound_at === null ||
              attempt.request_bound_at < attempt.provider_bound_at)) ||
        row.status === "running" && (running.length !== 1 ||
          running[0]!.lease_token !== row.lease_token ||
          running[0]!.worker_id !== row.lease_owner) ||
        row.status !== "running" && running.length !== 0) {
      corrupt("Stored AI job attempts are invalid");
    }
    const inputTokens = attempts.reduce((sum, attempt) => sum + attempt.input_tokens, 0);
    const outputTokens = attempts.reduce((sum, attempt) => sum + attempt.output_tokens, 0);
    const costUsd = attempts.reduce((sum, attempt) => sum + attempt.cost_usd, 0);
    if (!isSafeCount(inputTokens) || !isSafeCount(outputTokens) ||
        inputTokens + outputTokens !== row.spent_tokens ||
        !Number.isFinite(costUsd) || Math.abs(costUsd - row.spent_cost_usd) > 1e-12) {
      corrupt("Stored AI job attempt accounting is invalid");
    }
    return attempts;
  }

  function validateProjection(row: AiJobRow): DurableJobView {
    const strictResearchCheckpoint = schemaRequiresResearchAdapter &&
      row.kind === "resource_research" && selectBoundResearchRun?.get(row.id) !== undefined;
    const view = mapRow(row, strictResearchCheckpoint);
    if (strictResearchCheckpoint && row.checkpoint_json !== null) {
      const checkpoint = checkpointFromRow(row, true);
      if (checkpoint === null || !("nextStep" in checkpoint) || !("stage" in checkpoint) ||
          row.progress_stage !== checkpoint.stage ||
          row.progress_total !== (row.subject_type === "page" ||
            row.subject_type === "resource" ? 1 : null) ||
          row.progress_completed !== (checkpoint.nextStep === 2 ? 1 : 0)) {
        return corrupt("Stored research checkpoint projection is invalid");
      }
    }
    const attempts = validateAttempts(row);
    if (row.kind === "priority_assessment" &&
        (row.status === "succeeded" || row.status === "partial")) {
      const attempt = attempts.find((candidate) => candidate.outcome === row.status);
      if (attempt === undefined) return corrupt("Terminal priority attempt is missing");
      const unbound = attempt.provider === null && attempt.model === null &&
        attempt.prompt_version === null && attempt.provider_bound_at === null;
      const exactModel = row.assessment_method === "model" &&
        attempt.provider === row.assessment_model_provider &&
        attempt.model === row.assessment_model_name &&
        attempt.prompt_version === row.assessment_prompt_version &&
        attempt.provider_bound_at !== null;
      if (row.assessment_method === "rule" ? !unbound
        : row.status === "succeeded" ? !exactModel
          : !unbound && !exactModel) {
        return corrupt("Terminal priority attempt provenance is invalid");
      }
    }
    return view;
  }

  function ensureSubject(task: NewAiTaskSpec): void {
    if (task.subject.type === "page" &&
        selectPage.get(task.subject.logicalPageId) === undefined) {
      throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Job subject not found");
    }
    if (task.subject.type === "resource" &&
        selectActiveResource.get(task.subject.resourceId) === undefined) {
      throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Job subject not found");
    }
  }

  function mutationFloor(row: AiJobRow): string {
    const attemptFloor = connection.prepare(`
      SELECT MAX(COALESCE(request_bound_at, provider_bound_at, started_at))
      FROM ai_job_attempts WHERE job_id = ?
    `).pluck().get(row.id);
    if (attemptFloor !== null && attemptFloor !== undefined &&
        !isCanonicalTimestamp(attemptFloor)) {
      return corrupt("Stored AI job attempt clock is invalid");
    }
    return typeof attemptFloor === "string" && attemptFloor > row.updated_at
      ? attemptFloor : row.updated_at;
  }

  function checkedNow(row: AiJobRow): string {
    validateProjection(row);
    const now = canonicalTimestamp(clock());
    if (now < mutationFloor(row)) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    return now;
  }

  function hasRetryBudget(row: AiJobRow): boolean {
    const strictResearchBudget = schemaRequiresResearchAdapter &&
      row.kind === "resource_research";
    return row.attempts < row.max_attempts &&
      row.spent_steps < row.max_steps &&
      (strictResearchBudget
        ? row.spent_tokens < row.max_tokens
        : row.max_tokens === 0 || row.spent_tokens < row.max_tokens) &&
      (strictResearchBudget
        ? row.spent_cost_usd < row.max_cost_usd
        : row.max_cost_usd === 0 || row.spent_cost_usd < row.max_cost_usd) &&
      row.spent_wall_time_ms < row.max_wall_time_ms;
  }

  function assertLease(row: AiJobRow, claim: AiJobClaim, now: string): void {
    const attempt = selectClaimAttempt.get(claim.attemptId, row.id) as {
      attempt_no: number;
      worker_id: string;
      lease_token: string;
      outcome: string;
    } | undefined;
    if (row.status !== "running" || row.lease_owner !== claim.workerId ||
        row.lease_token !== claim.leaseToken || row.lease_expires_at === null ||
        row.lease_expires_at <= now || attempt === undefined ||
        attempt.attempt_no !== claim.attemptNo || attempt.worker_id !== claim.workerId ||
        attempt.lease_token !== claim.leaseToken || attempt.outcome !== "running") {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
  }

  function assertResearchPublicationProvenance(
    row: AiJobRow,
    claim: AiJobClaim,
    draft: ResearchPublicationDraft,
    occurredAt: string,
  ): void {
    const provenance = selectResearchPublicationProvenance?.get(
      claim.attemptId,
      row.id,
      row.event_sequence,
      claim.leaseToken,
    ) as {
      provider: string | null;
      model: string | null;
      prompt_version: string | null;
      pricing_version: string | null;
      request_id: string | null;
      occurred_at: string;
      spent_steps: number;
      spent_input_tokens: number;
      spent_output_tokens: number;
      spent_cost_usd: number;
      spent_wall_time_ms: number;
    } | undefined;
    const usage = draft.provenance.usage;
    if (provenance === undefined ||
        draft.provenance.provider !== provenance.provider ||
        draft.provenance.model !== provenance.model ||
        draft.provenance.promptVersion !== provenance.prompt_version ||
        draft.provenance.pricingVersion !== provenance.pricing_version ||
        draft.provenance.requestId !== provenance.request_id ||
        draft.provenance.generatedAt !== occurredAt ||
        draft.provenance.generatedAt !== provenance.occurred_at ||
        usage.steps !== provenance.spent_steps ||
        usage.inputTokens !== provenance.spent_input_tokens ||
        usage.outputTokens !== provenance.spent_output_tokens ||
        usage.costUsd !== provenance.spent_cost_usd ||
        usage.wallTimeMs !== provenance.spent_wall_time_ms) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Research publication provenance does not match terminal execution",
      );
    }
  }

  function normalizeWorkerId(value: unknown): string {
    if (typeof value !== "string" || value.trim() !== value ||
        Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 200) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job worker ID");
    }
    return value;
  }

  function normalizeClaimLimits(value: AiJobScheduleLimit): AiJobScheduleLimit {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "maxAttemptsPerUtcDay,maxConcurrent,maxCostUsdPerUtcDay" ||
        !isSafeCount(value.maxConcurrent) ||
        !isSafeCount(value.maxAttemptsPerUtcDay) ||
        (value.maxCostUsdPerUtcDay !== null &&
          (typeof value.maxCostUsdPerUtcDay !== "number" ||
            !Number.isFinite(value.maxCostUsdPerUtcDay) ||
            value.maxCostUsdPerUtcDay < 0 || value.maxCostUsdPerUtcDay > 1e308))) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job claim limits");
    }
    return value;
  }

  function normalizeWorkflowAllowlist(
    value: AiJobWorkflowAllowlist | undefined,
  ): NormalizedAiJobWorkflowAllowlist | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job workflow allowlist");
    }
    const entries = value.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
          Object.keys(entry).sort().join(",") !== "id,version" ||
          typeof entry.id !== "string" || entry.id.trim() !== entry.id ||
          Buffer.byteLength(entry.id, "utf8") < 1 ||
          Buffer.byteLength(entry.id, "utf8") > 128 ||
          !Number.isSafeInteger(entry.version) || entry.version <= 0) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job workflow allowlist");
      }
      return Object.freeze({ id: entry.id, version: entry.version });
    }).sort((left, right) => left.id < right.id ? -1
      : left.id > right.id ? 1
        : left.version - right.version);
    if (entries.some((entry, index) => index > 0 &&
        entry.id === entries[index - 1]!.id &&
        entry.version === entries[index - 1]!.version)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job workflow allowlist");
    }
    const normalizedEntries = Object.freeze(entries) as unknown as AiJobWorkflowAllowlist;
    return Object.freeze({
      entries: normalizedEntries,
      json: JSON.stringify(entries.map(({ id, version }) => [id, version])),
    });
  }

  function isLiveAcquisitionWorkflow(
    value: AiJobWorkflowRef | undefined,
  ): boolean {
    return value?.id === LIVE_ACQUISITION_WORKFLOW.id &&
      value.version === LIVE_ACQUISITION_WORKFLOW.version;
  }

  function normalizeAttemptMetadata(
    value: AiJobAttemptMetadata | undefined,
  ): AiJobAttemptMetadata | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI attempt metadata");
    }
    const metadataKeys = Object.keys(value).sort().join(",");
    if (metadataKeys !== "model,promptVersion,provider" &&
          metadataKeys !== "model,pricingVersion,promptVersion,provider" ||
        typeof value.provider !== "string" || value.provider.trim() !== value.provider ||
        Buffer.byteLength(value.provider, "utf8") < 1 ||
        Buffer.byteLength(value.provider, "utf8") > 128 ||
        typeof value.model !== "string" || value.model.trim() !== value.model ||
        Buffer.byteLength(value.model, "utf8") < 1 ||
        Buffer.byteLength(value.model, "utf8") > 200 ||
        typeof value.promptVersion !== "string" ||
        value.promptVersion.trim() !== value.promptVersion ||
        Buffer.byteLength(value.promptVersion, "utf8") < 1 ||
        Buffer.byteLength(value.promptVersion, "utf8") > 128 ||
        value.pricingVersion !== undefined && (
          typeof value.pricingVersion !== "string" ||
          value.pricingVersion.trim() !== value.pricingVersion ||
          Buffer.byteLength(value.pricingVersion, "utf8") < 1 ||
          Buffer.byteLength(value.pricingVersion, "utf8") > 128
        )) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI attempt metadata");
    }
    return value;
  }

  function utcDayBounds(now: Date): { start: string; end: string } {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function normalizeCheckpoint(
    kind: NewAiTaskSpec["kind"],
    value: AiJobCheckpointInput,
    row: AiJobRow,
    allowInternalStage = false,
  ): {
    progressCompleted: number;
    progressTotal: number | null;
    progressStage: string;
    checkpointJson: string;
    spentSteps: number;
    spentTokens: number;
    spentInputTokens: number;
    spentOutputTokens: number;
    deltaInputTokens: number;
    deltaOutputTokens: number;
    deltaCostUsd: number;
    deltaSteps: number;
    deltaWallTimeMs: number;
    spentCostUsd: number;
    spentWallTimeMs: number;
  } {
    const exactKeys = (object: object, keys: readonly string[]): boolean => {
      const actual = Object.keys(object).sort();
      return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
    };
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        !exactKeys(value, ["checkpoint", "progress", "usage"])) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job checkpoint");
    }
    const { progress, checkpoint, usage } = value;
    if (progress === null || typeof progress !== "object" || Array.isArray(progress) ||
        !exactKeys(progress, ["completed", "stage", "total"]) ||
        !isSafeCount(progress.completed) || progress.completed < row.progress_completed ||
        (progress.total !== null && (!isSafeCount(progress.total) ||
          progress.completed > progress.total)) ||
        row.progress_total !== null && progress.total !== row.progress_total ||
        typeof progress.stage !== "string" || progress.stage.trim() !== progress.stage ||
        !allowInternalStage && progress.stage.startsWith("ledger:") ||
        Buffer.byteLength(progress.stage, "utf8") < 1 ||
        Buffer.byteLength(progress.stage, "utf8") > 128) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job progress");
    }
    if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job checkpoint");
    }
    let checkpointJson: string;
    if (kind === "priority_assessment" || !schemaRequiresResearchAdapter) {
      const checkpointKey = kind === "priority_assessment" ? "nextOffset" : "nextStep";
      if (!exactKeys(checkpoint, [checkpointKey, "version"]) || checkpoint.version !== 1 ||
          !isSafeCount((checkpoint as unknown as Record<string, unknown>)[checkpointKey])) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job checkpoint");
      }
      checkpointJson = canonicalJson(checkpoint);
      if (Buffer.byteLength(checkpointJson, "utf8") > 65_536) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "AI job checkpoint exceeds 64 KiB");
      }
    } else {
      const researchCheckpoint = parseResearchCheckpoint(checkpoint);
      if (researchCheckpoint === undefined ||
          progress.stage !== researchCheckpoint.stage ||
          progress.total !== row.progress_total ||
          progress.completed !== (researchCheckpoint.nextStep === 2 ? 1 : 0)) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research checkpoint");
      }
      checkpointJson = canonicalJson(researchCheckpoint);
      if (Buffer.byteLength(checkpointJson, "utf8") > 2_048) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research checkpoint exceeds 2 KiB");
      }
      const previous = checkpointFromRow(row, true);
      if (previous !== null && "nextStep" in previous && (
        researchCheckpoint.nextStep < previous.nextStep ||
        researchCheckpoint.nextStep > previous.nextStep + 1 ||
        researchCheckpoint.nextStep === previous.nextStep &&
          checkpointJson !== row.checkpoint_json
      ) || previous === null && researchCheckpoint.nextStep !== 0) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research checkpoint transition");
      }
    }
    if (usage === null || typeof usage !== "object" || Array.isArray(usage) ||
        !exactKeys(usage, [
          "costUsd", "inputTokens", "outputTokens", "steps", "wallTimeMs",
        ]) ||
        !isSafeCount(usage.steps) || !isSafeCount(usage.inputTokens) ||
        !isSafeCount(usage.outputTokens) ||
        !isSafeCount(usage.wallTimeMs) || typeof usage.costUsd !== "number" ||
        !Number.isFinite(usage.costUsd) || usage.costUsd < 0 || usage.costUsd > 1e308) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job usage");
    }
    const tokenUsage = selectTokenUsage.get(row.id) as {
      input_tokens: number;
      output_tokens: number;
    };
    if (!isSafeCount(tokenUsage.input_tokens) || !isSafeCount(tokenUsage.output_tokens) ||
        tokenUsage.input_tokens + tokenUsage.output_tokens !== row.spent_tokens) {
      return corrupt("Stored AI job token accounting is invalid");
    }
    const spentSteps = row.spent_steps + usage.steps;
    const spentInputTokens = tokenUsage.input_tokens + usage.inputTokens;
    const spentOutputTokens = tokenUsage.output_tokens + usage.outputTokens;
    const spentTokens = spentInputTokens + spentOutputTokens;
    const spentCostUsd = row.spent_cost_usd + usage.costUsd;
    const spentWallTimeMs = row.spent_wall_time_ms + usage.wallTimeMs;
    if (!isSafeCount(spentSteps) || !isSafeCount(spentTokens) ||
        !Number.isFinite(spentCostUsd) || !isSafeCount(spentWallTimeMs) ||
        spentSteps > row.max_steps || spentTokens > row.max_tokens ||
        spentCostUsd > row.max_cost_usd || spentWallTimeMs > row.max_wall_time_ms) {
      throw new DurableAiJobError("JOB_BUDGET_EXHAUSTED", "AI job budget exhausted");
    }
    return {
      progressCompleted: progress.completed,
      progressTotal: progress.total,
      progressStage: progress.stage,
      checkpointJson,
      spentSteps,
      spentTokens,
      spentInputTokens,
      spentOutputTokens,
      deltaInputTokens: usage.inputTokens,
      deltaOutputTokens: usage.outputTokens,
      deltaCostUsd: spentCostUsd - row.spent_cost_usd,
      deltaSteps: usage.steps,
      deltaWallTimeMs: usage.wallTimeMs,
      spentCostUsd,
      spentWallTimeMs,
    };
  }

  const submitTransaction = connection.transaction((
    task: NewAiTaskSpec,
    approvalRequest?: ResearchApprovalRequest,
  ): DurableJobRef => {
    if (task.kind === "resource_research" && schemaRequiresResearchAdapter &&
        approvalRequest === undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Schema-24 research requires an approved corpus submission",
      );
    }
    if (approvalRequest !== undefined && (task.kind !== "resource_research" ||
        research === undefined)) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Research submission adapter is unavailable",
      );
    }
    const { idempotencyKey: _idempotencyKey, ...submissionPayload } = task;
    const submission = fingerprint(approvalRequest === undefined
      ? submissionPayload : { task: submissionPayload, approvalRequest });
    const existingIdempotency = selectIdempotency.get(task.idempotencyKey) as
      IdempotencyRow | undefined;
    if (existingIdempotency !== undefined) {
      if (existingIdempotency.submission_fingerprint !== submission.hash) {
        throw new DurableAiJobError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Idempotency key belongs to a different submission",
        );
      }
      const row = read(existingIdempotency.kind, existingIdempotency.id);
      if (row === undefined) return corrupt();
      validateProjection(row);
      // Exact idempotency replay deliberately does not rebuild mutable corpus state.
      return ref(row);
    }

    // Rebuild and validate mutable captured state before the first SQL write.
    const preparedResearchDraft = task.kind === "resource_research" &&
      approvalRequest !== undefined
      ? research!.prepareSubmission(task, approvalRequest)
      : undefined;
    ensureSubject(task);
    const key = subjectKey(task);
    const active = selectActive.get(task.kind, key) as ActiveRow | undefined;
    const activeRow = active === undefined ? undefined : read(active.kind, active.id);
    if (active !== undefined && activeRow === undefined) return corrupt();
    if (activeRow !== undefined) validateProjection(activeRow);
    if (active !== undefined && active.input_fingerprint === task.inputFingerprint &&
        (task.kind === "priority_assessment" ||
          active.submission_fingerprint === submission.hash)) {
      const row = activeRow!;
      if (task.kind === "resource_research" && preparedResearchDraft !== undefined) {
        research!.assertSubmission(row.id, task, preparedResearchDraft);
      }
      insertIdempotencyReceipt.run(
        task.idempotencyKey, submission.hash, row.id, row.kind, checkedNow(row),
      );
      return ref(row);
    }
    if (active !== undefined && task.kind === "resource_research") {
      if (active.input_fingerprint === task.inputFingerprint) {
        throw new DurableAiJobError(
          "JOB_ACTIVE_CONFLICT",
          "A different research job is already active for this subject",
        );
      }
      throw new DurableAiJobError(
        "JOB_ACTIVE_CONFLICT",
        "A research job is already active for this subject",
      );
    }

    const now = canonicalTimestamp(clock());
    if (active !== undefined) {
      if (now < mutationFloor(activeRow!)) {
        throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
      }
      insertEvent.run({
        jobId: active.id,
        sequenceNo: active.event_sequence + 1,
        eventType: "superseded",
        fromStatus: active.status,
        toStatus: "superseded",
        attemptId: active.status === "running" ? active.attempt_id : null,
        leaseToken: active.lease_token,
        cancellationRequestedBy: null,
        errorCode: null,
        availableAt: null,
        occurredAt: now,
      });
    }

    const columns = subjectColumns(task);
    const provenance = task.provenance;
    const result = insertJob.run({
      kind: task.kind,
      ...columns,
      subjectKey: key,
      requestedBy: provenance.requestedBy,
      requestMethod: provenance.requestMethod,
      authorizationRef: provenance.requestedBy === "agent"
        ? provenance.authorizationRef : null,
      idempotencyKey: task.idempotencyKey,
      submissionFingerprint: submission.hash,
      inputFingerprint: task.inputFingerprint,
      rulesetId: task.kind === "priority_assessment" ? task.ruleset.rulesetId : null,
      rulesetVersion: task.kind === "priority_assessment" ? task.ruleset.version : null,
      assessmentMethod: task.kind === "priority_assessment"
        ? task.assessmentProvenance.method : null,
      assessmentModelProvider: task.kind === "priority_assessment" &&
        task.assessmentProvenance.method === "model"
        ? task.assessmentProvenance.model.provider : null,
      assessmentModelName: task.kind === "priority_assessment" &&
        task.assessmentProvenance.method === "model"
        ? task.assessmentProvenance.model.name : null,
      assessmentPromptVersion: task.kind === "priority_assessment" &&
        task.assessmentProvenance.method === "model"
        ? task.assessmentProvenance.model.promptVersion : null,
      workflowId: task.kind === "resource_research" ? task.workflowRef.id : null,
      workflowVersion: task.kind === "resource_research"
        ? task.workflowRef.version : null,
      stepBatchSize: task.kind === "priority_assessment" ? task.stepBatchSize : null,
      schedulingPriority: task.schedulingPriority,
      progressTotal: task.subject.type === "page" || task.subject.type === "resource"
        ? 1 : null,
      maxSteps: task.budget.maxSteps,
      maxTokens: task.budget.maxTokens,
      maxCostUsd: task.budget.maxCostUsd,
      maxWallTimeMs: task.budget.maxWallTimeMs,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const id = Number(result.lastInsertRowid);
    const row = read(task.kind, id);
    if (row === undefined) return corrupt();
    if (task.kind === "resource_research" && preparedResearchDraft !== undefined) {
      research!.insertSubmission(id, task, preparedResearchDraft, now);
    }
    validateProjection(row);
    return ref(row);
  });

  const cancelTransaction = connection.transaction((
    kind: NewAiTaskSpec["kind"],
    id: number,
    requestedBy: "user" | "agent",
  ): DurableJobView => {
    const row = read(kind, id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
    }
    const current = validateProjection(row);
    if (row.status === "cancelled" || row.cancellation_requested_at !== null) {
      return current;
    }
    if (row.status !== "queued" && row.status !== "running") {
      throw new DurableAiJobError("JOB_NOT_CANCELLABLE", "AI job cannot be cancelled");
    }
    const now = checkedNow(row);
    insertEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      eventType: row.status === "queued" ? "cancelled" : "cancel_requested",
      fromStatus: row.status,
      toStatus: row.status === "queued" ? "cancelled" : "running",
      attemptId: null,
      leaseToken: null,
      cancellationRequestedBy: requestedBy,
      errorCode: null,
      availableAt: null,
      occurredAt: now,
    });
    const updated = read(kind, id);
    return updated === undefined ? corrupt() : validateProjection(updated);
  });

  const normalizeAgentCommand = (command: AgentResearchCommand) => {
    if (command === null || typeof command !== "object" ||
        !isBoundedTrimmed(command.idempotencyKey, 1, 200) ||
        !isBoundedTrimmed(command.authorizationRef, 1, 256)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research command");
    }
    return {
      keyHash: agentResearchKeyHash(command.idempotencyKey),
      authorizationHash: agentResearchAuthorizationHash(command.authorizationRef),
    };
  };

  const readAgentCommandReplay = (
    keyHash: string,
    operation: "start" | "cancel",
    requestFingerprint: string,
    authorizationHash: string,
  ): AiJobRow | undefined => {
    const receipt = selectAgentResearchCommandReceipt?.get(keyHash) as
      AgentResearchCommandReceiptRow | undefined;
    if (receipt === undefined) return undefined;
    if (receipt.operation !== operation ||
        receipt.request_fingerprint !== requestFingerprint ||
        receipt.authorization_ref_hash !== authorizationHash) {
      throw new DurableAiJobError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "Agent research idempotency key belongs to a different command",
      );
    }
    const row = read("resource_research", receipt.job_id);
    if (row === undefined || row.requested_by !== "agent" ||
        row.request_method !== "on_behalf_of_user" || row.authorization_ref === null) {
      return corrupt("Stored agent research receipt is invalid");
    }
    validateProjection(row);
    return row;
  };

  const submitAgentResearchTransaction = connection.transaction((
    task: ResourceResearchTaskSpec,
    approvalRequest: ResearchApprovalRequest,
    command: AgentResearchCommand,
  ): DurableJobRef => {
    if (selectAgentResearchCommandReceipt === undefined ||
        insertAgentResearchCommandReceipt === undefined ||
        task.provenance.requestedBy !== "agent" ||
        task.provenance.requestMethod !== "on_behalf_of_user" ||
        task.provenance.authorizationRef !== command.authorizationRef ||
        task.idempotencyKey !== command.idempotencyKey) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research submission");
    }
    const normalized = normalizeAgentCommand(command);
    const requestFingerprint = sha256Payload(agentResearchStartCommandFingerprintPayloadV1({
      version: 1,
      target: approvalRequest.target,
      question: approvalRequest.question,
      includeShareableContext: approvalRequest.scope.includeShareableContext,
      maxIncludedSources: approvalRequest.scope.maxIncludedSources,
      parentReportId: approvalRequest.parentReportId,
      budget: approvalRequest.budget,
      estimate: approvalRequest.estimate,
      captureIntent: approvalRequest.captureIntent,
      confirmedOrigins: {
        authenticatedOriginDigests:
          approvalRequest.scope.privacyConfirmation.authenticatedOriginDigests,
        sensitiveOriginDigests:
          approvalRequest.scope.privacyConfirmation.sensitiveOriginDigests,
      },
      approvalFingerprint: task.inputFingerprint,
      idempotencyKey: command.idempotencyKey,
      authorizationRef: command.authorizationRef,
    }));
    const replay = readAgentCommandReplay(
      normalized.keyHash,
      "start",
      requestFingerprint,
      normalized.authorizationHash,
    );
    if (replay !== undefined) return ref(replay);

    const persistedTask: ResourceResearchTaskSpec = {
      ...task,
      idempotencyKey: `agent-research:${normalized.keyHash}`,
    };
    const result = submitTransaction(persistedTask, approvalRequest);
    const id = Number(result.id.slice("resource_research:".length));
    const row = read("resource_research", id);
    if (row === undefined || row.requested_by !== "agent" ||
        row.request_method !== "on_behalf_of_user" ||
        row.authorization_ref !== command.authorizationRef) {
      return corrupt("Agent research submission lost provenance ownership");
    }
    insertAgentResearchCommandReceipt.run(
      normalized.keyHash,
      "start",
      requestFingerprint,
      normalized.authorizationHash,
      row.id,
      row.created_at,
    );
    return result;
  });

  const replayAgentResearchStart = (
    requestValue: AgentResearchStartRequest,
  ): DurableJobRef | undefined => {
    if (selectAgentResearchCommandReceipt === undefined) {
      throw new DurableAiJobError("JOB_KIND_UNAVAILABLE", "Agent research is unavailable");
    }
    const parsed = agentResearchStartRequestSchema.safeParse(requestValue);
    if (!parsed.success) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research start command");
    }
    const normalized = normalizeAgentCommand(parsed.data);
    const requestFingerprint = sha256Payload(
      agentResearchStartRequestFingerprintPayloadV1(parsed.data),
    );
    const replay = readAgentCommandReplay(
      normalized.keyHash,
      "start",
      requestFingerprint,
      normalized.authorizationHash,
    );
    return replay === undefined ? undefined : ref(replay);
  };

  const cancelAgentResearchTransaction = connection.transaction((
    id: number,
    command: AgentResearchCommand,
  ): DurableJobView => {
    if (selectAgentResearchCommandReceipt === undefined ||
        insertAgentResearchCommandReceipt === undefined) {
      throw new DurableAiJobError("JOB_KIND_UNAVAILABLE", "Agent research is unavailable");
    }
    const normalized = normalizeAgentCommand(command);
    const jobId = `resource_research:${id}`;
    const requestFingerprint = sha256Payload(
      agentResearchCancelCommandFingerprintPayloadV1(jobId),
    );
    const replay = readAgentCommandReplay(
      normalized.keyHash,
      "cancel",
      requestFingerprint,
      normalized.authorizationHash,
    );
    if (replay !== undefined) return validateProjection(replay);

    const row = read("resource_research", id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
    }
    if (row.requested_by !== "agent" || row.request_method !== "on_behalf_of_user" ||
        row.authorization_ref === null) {
      throw new DurableAiJobError("JOB_NOT_CANCELLABLE", "Research job is not agent-owned");
    }
    const view = cancelTransaction("resource_research", id, "agent");
    const updated = read("resource_research", id);
    if (updated === undefined) return corrupt();
    insertAgentResearchCommandReceipt.run(
      normalized.keyHash,
      "cancel",
      requestFingerprint,
      normalized.authorizationHash,
      updated.id,
      updated.updated_at,
    );
    return view;
  });

  const claimTransaction = connection.transaction((
    kind: NewAiTaskSpec["kind"],
    workerId: string,
    limits: AiJobScheduleLimit,
    claimBoundary?: AiJobClaimBoundary,
    workflowAllowlistValue?: AiJobWorkflowAllowlist,
  ): AiJobClaim | undefined => {
    const normalizedClaimBoundary = normalizeAiJobClaimBoundary(claimBoundary);
    const workflowAllowlist = normalizeWorkflowAllowlist(workflowAllowlistValue);
    if (workflowAllowlist !== undefined && kind !== "resource_research") {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "AI job workflow allowlists require resource research",
      );
    }
    const workflowParameters = {
      workflowAllowlistJson: workflowAllowlist?.json ?? null,
    };
    const nowDate = clock();
    const now = canonicalTimestamp(nowDate);
    const day = utcDayBounds(nowDate);
    const usage = selectClaimUsage.get({
      kind,
      ...workflowParameters,
      dayStart: day.start,
      dayEnd: day.end,
      ...(schemaHasLiveProviderReservations ? {
        utcDate: day.start.slice(0, 10),
        liveWorkflowId: LIVE_ACQUISITION_WORKFLOW.id,
        liveWorkflowVersion: LIVE_ACQUISITION_WORKFLOW.version,
      } : {}),
    }) as {
      running: number;
      attempts_utc_day: number;
      cost_usd_utc_day: number;
      running_cost_reservation: number;
    };
    if (!isSafeCount(usage.running) || !isSafeCount(usage.attempts_utc_day) ||
        typeof usage.cost_usd_utc_day !== "number" ||
        !Number.isFinite(usage.cost_usd_utc_day) || usage.cost_usd_utc_day < 0 ||
        typeof usage.running_cost_reservation !== "number" ||
        !Number.isFinite(usage.running_cost_reservation) ||
        usage.running_cost_reservation < 0) {
      return corrupt("Stored AI job usage is invalid");
    }
    const dailyBlocked = usage.attempts_utc_day >= limits.maxAttemptsPerUtcDay ||
      (limits.maxCostUsdPerUtcDay !== null &&
        usage.cost_usd_utc_day > limits.maxCostUsdPerUtcDay);
    if (dailyBlocked) {
      const readyIds = selectReadyToDefer.all({
        kind,
        now,
        ...workflowParameters,
      }) as Array<{ id: number }>;
      const ready = readyIds.map(({ id }) => {
        const candidate = read(kind, id);
        if (candidate === undefined) return corrupt();
        validateProjection(candidate);
        return candidate;
      });
      if (ready.some((job) => now < mutationFloor(job))) {
        throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
      }
      for (const job of ready) {
        insertEvent.run({
          jobId: job.id,
          sequenceNo: job.event_sequence + 1,
          eventType: "deferred",
          fromStatus: job.status,
          toStatus: job.status,
          attemptId: null,
          leaseToken: null,
          cancellationRequestedBy: null,
          errorCode: null,
          availableAt: day.end,
          occurredAt: now,
        });
      }
      return undefined;
    }
    if (usage.running >= limits.maxConcurrent) return undefined;
    const next = selectNext.get({
      kind,
      now,
      ...workflowParameters,
    }) as { id: number } | undefined;
    if (next === undefined) return undefined;
    const row = read(kind, next.id);
    if (row === undefined) return corrupt();
    if (kind === "resource_research" && schemaRequiresResearchAdapter) {
      const hasBoundResearchRun = selectBoundResearchRun?.get(next.id) !== undefined;
      const candidateWorkflow = row.workflow_id === null || row.workflow_version === null
        ? undefined
        : { id: row.workflow_id, version: row.workflow_version };
      if (isLiveAcquisitionWorkflow(candidateWorkflow) && !hasBoundResearchRun) {
        throw new DurableAiJobError(
          "INVALID_JOB_TRANSITION",
          "Live acquisition claim requires its bound coordinator run",
        );
      }
      if (!isLiveAcquisitionWorkflow(candidateWorkflow) &&
          (research === undefined || !hasBoundResearchRun)) {
        throw new DurableAiJobError(
          "INVALID_JOB_TRANSITION",
          "Schema-24 research claim requires its bound corpus adapter",
        );
      }
    }
    validateProjection(row);
    if (now < mutationFloor(row)) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    const liveCandidateReservation = kind === "resource_research"
      ? selectLiveProviderReservationForClaim?.get(row.id) as {
          id: number;
          utc_date: string;
          reserved_usd: number;
          consumed_usd: number;
          status: "active" | "released" | "consumed";
        } | undefined
      : undefined;
    let candidateCostReservation = row.max_cost_usd - row.spent_cost_usd;
    let reservationRollover: {
      readonly reservationId: number;
      readonly previousUtcDate: string;
    } | undefined;
    if (liveCandidateReservation?.status === "active") {
      candidateCostReservation = liveCandidateReservation.utc_date === day.start.slice(0, 10)
        ? 0
        : liveCandidateReservation.reserved_usd - liveCandidateReservation.consumed_usd;
      if (liveCandidateReservation.utc_date !== day.start.slice(0, 10)) {
        reservationRollover = {
          reservationId: liveCandidateReservation.id,
          previousUtcDate: liveCandidateReservation.utc_date,
        };
      }
    }
    if (!Number.isFinite(candidateCostReservation) || candidateCostReservation < 0) {
      return corrupt("Stored AI job budget is invalid");
    }
    if (limits.maxCostUsdPerUtcDay !== null &&
        usage.cost_usd_utc_day + usage.running_cost_reservation +
          candidateCostReservation > limits.maxCostUsdPerUtcDay) {
      insertEvent.run({
        jobId: row.id,
        sequenceNo: row.event_sequence + 1,
        eventType: "deferred",
        fromStatus: row.status,
        toStatus: row.status,
        attemptId: null,
        leaseToken: null,
        cancellationRequestedBy: null,
        errorCode: null,
        availableAt: day.end,
        occurredAt: now,
      });
      return undefined;
    }
    if (reservationRollover !== undefined) {
      const rolled = rolloverLiveProviderReservation?.run({
        reservationId: reservationRollover.reservationId,
        jobId: row.id,
        previousUtcDate: reservationRollover.previousUtcDate,
        utcDate: day.start.slice(0, 10),
      });
      if (rolled?.changes !== 1) {
        throw new DurableAiJobError(
          "INVALID_JOB_TRANSITION",
          "Live acquisition provider reservation rollover is unavailable",
        );
      }
    }
    const leaseToken = options.token?.() ?? createHash("sha256")
      .update(`${workerId}:${now}:${row.id}:${Math.random()}`)
      .digest("hex");
    if (typeof leaseToken !== "string" || leaseToken.trim() !== leaseToken ||
        Buffer.byteLength(leaseToken, "utf8") < 16 ||
        Buffer.byteLength(leaseToken, "utf8") > 200) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job lease token");
    }
    const leaseExpiresAt = canonicalTimestamp(
      new Date(nowDate.getTime() + AI_JOB_LEASE_MS),
    );
    const attemptNo = row.attempts + 1;
    const insertedAttempt = insertAttempt.run({
      jobId: row.id,
      attemptNo,
      leaseToken,
      workerId,
      startedAt: now,
      kind,
      ...workflowParameters,
    });
    if (insertedAttempt.changes !== 1) return undefined;
    runtimeClaimBoundary.advance(normalizedClaimBoundary, now);
    const attempt = selectAttemptId.get(row.id, attemptNo) as { id: number } | undefined;
    if (attempt === undefined) return corrupt();
    const claimedRow = read(kind, row.id);
    if (claimedRow === undefined) return corrupt();
    validateProjection(claimedRow);
    const tokenUsage = selectTokenUsage.get(row.id) as {
      input_tokens: number;
      output_tokens: number;
    };
    if (!isSafeCount(tokenUsage.input_tokens) || !isSafeCount(tokenUsage.output_tokens)) {
      return corrupt("Stored AI job token accounting is invalid");
    }
    return {
      id: row.id,
      kind,
      attemptId: attempt.id,
      attemptNo,
      workerId,
      leaseToken,
      leaseExpiresAt,
      ...executionStateFromRow(claimedRow, {
        inputTokens: tokenUsage.input_tokens,
        outputTokens: tokenUsage.output_tokens,
      }, schemaRequiresResearchAdapter),
    };
  });

  function persistCheckpoint(
    row: AiJobRow,
    claim: AiJobClaim,
    input: AiJobCheckpointInput,
    now: string,
    allowInternalStage = false,
  ): AiJobRow {
    const checkpoint = normalizeCheckpoint(claim.kind, input, row, allowInternalStage);
    insertProgressEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      leaseOwner: claim.workerId,
      leaseExpiresAt: canonicalTimestamp(new Date(
        new Date(now).getTime() + AI_JOB_LEASE_MS,
      )),
      ...checkpoint,
      occurredAt: now,
    });
    const progressed = read(claim.kind, claim.id);
    if (progressed === undefined) return corrupt();
    validateProjection(progressed);
    return progressed;
  }

  const checkpointTransaction = connection.transaction((
    claim: AiJobClaim,
    input: AiJobCheckpointInput,
  ): DurableJobView => {
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(row);
    assertLease(row, claim, now);
    const progressed = persistCheckpoint(row, claim, input, now);
    if (row.cancellation_requested_at !== null) {
      insertEvent.run({
        jobId: row.id,
        sequenceNo: progressed.event_sequence + 1,
        eventType: "cancelled",
        fromStatus: "running",
        toStatus: "cancelled",
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        cancellationRequestedBy: null,
        errorCode: null,
        availableAt: null,
        occurredAt: now,
      });
    }
    const updated = read(claim.kind, claim.id);
    return updated === undefined ? corrupt() : validateProjection(updated);
  });

  const recordAttemptRequestTransaction = connection.transaction((
    claim: AiJobClaim,
    requestId: string,
  ): void => {
    if (typeof requestId !== "string" || requestId.trim() !== requestId ||
        Buffer.byteLength(requestId, "utf8") < 1 ||
        Buffer.byteLength(requestId, "utf8") > 256) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI attempt request ID");
    }
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(row);
    assertLease(row, claim, now);
    const attemptMetadata = connection.prepare(`
      SELECT provider, model, prompt_version FROM ai_job_attempts
      WHERE id = ? AND job_id = ?
    `).get(claim.attemptId, claim.id) as {
      provider: string | null; model: string | null; prompt_version: string | null;
    } | undefined;
    if (attemptMetadata === undefined || attemptMetadata.provider === null ||
        attemptMetadata.model === null || attemptMetadata.prompt_version === null) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Attempt provider must be bound before request",
      );
    }
    const result = connection.prepare(`
      UPDATE ai_job_attempts SET request_id = ?, request_bound_at = ?
      WHERE id = ? AND job_id = ? AND outcome = 'running' AND request_id IS NULL
    `).run(requestId, now, claim.attemptId, claim.id);
    if (result.changes !== 1) {
      const existing = connection.prepare(`
        SELECT request_id FROM ai_job_attempts WHERE id = ? AND job_id = ?
      `).pluck().get(claim.attemptId, claim.id);
      if (existing === requestId) return;
      throw new DurableAiJobError("INVALID_JOB_TRANSITION", "Attempt request is already bound");
    }
  });

  const bindAttemptProviderTransaction = connection.transaction((
    claim: AiJobClaim,
    value: AiJobAttemptMetadata,
  ): void => {
    const metadata = normalizeAttemptMetadata(value);
    if (metadata === undefined) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Attempt metadata is required");
    }
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(row);
    assertLease(row, claim, now);
    if (row.cancellation_requested_at !== null) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Attempt provider cannot be bound after cancellation",
      );
    }
    const task = taskFromRow(row);
    if (schemaHasLiveProviderReservations && task.kind === "resource_research" &&
        isLiveAcquisitionWorkflow(task.workflowRef)) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Live acquisition coordinator attempts cannot bind a provider",
      );
    }
    if (!schemaRequiresResearchAdapter && metadata.pricingVersion !== undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Attempt pricing is unavailable before schema 24",
      );
    }
    if (schemaRequiresResearchAdapter && task.kind === "resource_research" &&
        metadata.pricingVersion === undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Research attempt pricing version is required",
      );
    }
    if (schemaHasPrivacyPurgeBudgetCarryover &&
        task.kind === "resource_research" &&
        !isLiveAcquisitionWorkflow(task.workflowRef)) {
      const usage = selectSchema26ProviderBindUsage!.get({
        utcDate: now.slice(0, 10),
        liveWorkflowId: LIVE_ACQUISITION_WORKFLOW.id,
        liveWorkflowVersion: LIVE_ACQUISITION_WORKFLOW.version,
      }) as {
        provider_attempts: number;
        provider_cost_and_outstanding: number;
        legacy25_day_block: number;
      };
      if (!isSafeCount(usage.provider_attempts) ||
          typeof usage.provider_cost_and_outstanding !== "number" ||
          !Number.isFinite(usage.provider_cost_and_outstanding) ||
          usage.provider_cost_and_outstanding < 0 ||
          usage.legacy25_day_block !== 0 ||
          usage.provider_attempts >= 10 ||
          usage.provider_cost_and_outstanding > 2) {
        throw new DurableAiJobError(
          "JOB_BUDGET_EXHAUSTED",
          "Provider daily budget is exhausted",
        );
      }
    }
    if (task.kind === "priority_assessment" && (
      task.assessmentProvenance.method !== "model" ||
      metadata.provider !== task.assessmentProvenance.model.provider ||
      metadata.model !== task.assessmentProvenance.model.name ||
      metadata.promptVersion !== task.assessmentProvenance.model.promptVersion
    )) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Attempt provider does not match assessment provenance",
      );
    }
    if (schemaHasLiveProviderReservations && task.kind === "resource_research") {
      const finalReservation = selectLiveFinalProviderReservation?.get({
        attemptId: claim.attemptId,
        jobId: claim.id,
      }) as {
        handoff_id: number;
        handoff_status: "assembling" | "completed";
        receipt_handoff_id: number | null;
        reservation_id: number | null;
        utc_date: string | null;
        reserved_usd: number | null;
        consumed_usd: number | null;
        reservation_status: "active" | "released" | "consumed" | null;
        attempt_provider: string | null;
        adopted_attempt_id: number | null;
      } | undefined;
      if (finalReservation !== undefined) {
        if (finalReservation.handoff_status !== "completed" ||
            finalReservation.receipt_handoff_id !== finalReservation.handoff_id ||
            finalReservation.reservation_id === null ||
            finalReservation.utc_date === null ||
            finalReservation.reservation_status !== "active" ||
            finalReservation.reserved_usd === null ||
            finalReservation.consumed_usd === null ||
            !Number.isFinite(finalReservation.reserved_usd) ||
            !Number.isFinite(finalReservation.consumed_usd) ||
            finalReservation.reserved_usd < finalReservation.consumed_usd ||
            Math.abs(finalReservation.reserved_usd - row.max_cost_usd) > 1e-12 ||
            Math.abs(finalReservation.consumed_usd - row.spent_cost_usd) > 1e-12 ||
            Math.abs(
              finalReservation.reserved_usd - finalReservation.consumed_usd -
                (row.max_cost_usd - row.spent_cost_usd),
            ) > 1e-12) {
          throw new DurableAiJobError(
            "INVALID_JOB_TRANSITION",
            "Live acquisition final provider reservation is unavailable",
          );
        }
        if (finalReservation.adopted_attempt_id === null) {
          if (finalReservation.attempt_provider !== null) {
            throw new DurableAiJobError(
              "INVALID_JOB_TRANSITION",
              "Live acquisition provider reservation adoption is invalid",
            );
          }
          let adoptionUtcDate = finalReservation.utc_date;
          if (adoptionUtcDate !== now.slice(0, 10)) {
            const rolled = rolloverLiveProviderReservation?.run({
              reservationId: finalReservation.reservation_id,
              jobId: claim.id,
              previousUtcDate: adoptionUtcDate,
              utcDate: now.slice(0, 10),
            });
            if (rolled?.changes !== 1) {
              throw new DurableAiJobError(
                "INVALID_JOB_TRANSITION",
                "Live acquisition provider reservation rollover is unavailable",
              );
            }
            adoptionUtcDate = now.slice(0, 10);
          }
          insertLiveProviderReservationAdoption?.run({
            attemptId: claim.attemptId,
            reservationId: finalReservation.reservation_id,
            jobId: claim.id,
            utcDate: adoptionUtcDate,
            adoptedAt: now,
          });
        }
      }
    }
    const result = schemaRequiresResearchAdapter
      ? connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = ?, model = ?, prompt_version = ?, pricing_version = ?,
            provider_bound_at = ?
          WHERE id = ? AND job_id = ? AND outcome = 'running'
            AND provider IS NULL AND model IS NULL AND prompt_version IS NULL
            AND pricing_version IS NULL
        `).run(
          metadata.provider,
          metadata.model,
          metadata.promptVersion,
          metadata.pricingVersion ?? null,
          now,
          claim.attemptId,
          claim.id,
        )
      : connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = ?, model = ?, prompt_version = ?, provider_bound_at = ?
          WHERE id = ? AND job_id = ? AND outcome = 'running'
            AND provider IS NULL AND model IS NULL AND prompt_version IS NULL
        `).run(
          metadata.provider,
          metadata.model,
          metadata.promptVersion,
          now,
          claim.attemptId,
          claim.id,
        );
    if (result.changes !== 1) {
      const existing = connection.prepare(schemaRequiresResearchAdapter ? `
        SELECT provider, model, prompt_version, pricing_version
        FROM ai_job_attempts WHERE id = ? AND job_id = ?
      ` : `
        SELECT provider, model, prompt_version
        FROM ai_job_attempts WHERE id = ? AND job_id = ?
      `).get(claim.attemptId, claim.id);
      const expected = {
        provider: metadata.provider,
        model: metadata.model,
        prompt_version: metadata.promptVersion,
        ...(schemaRequiresResearchAdapter
          ? { pricing_version: metadata.pricingVersion ?? null } : {}),
      };
      if (JSON.stringify(existing) === JSON.stringify(expected)) return;
      throw new DurableAiJobError("INVALID_JOB_TRANSITION", "Attempt provider is already bound");
    }
  });

  function completionProjection(
    claim: AiJobClaim,
    completion: AiJobCompletion,
  ): {
    readonly resultType: "priority_output" | "research_report";
    readonly resultOutputFingerprint: string | null;
    readonly resultReportId: number | null;
    readonly errorCode: "JOB_BUDGET_EXHAUSTED" | null;
  } {
    if (completion === null || typeof completion !== "object" ||
        Array.isArray(completion) ||
        (completion.status !== "succeeded" && completion.status !== "partial")) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job completion");
    }
    if (completion.result === null || typeof completion.result !== "object" ||
        Array.isArray(completion.result)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job result");
    }
    const priorityResult = claim.kind === "priority_assessment" &&
      completion.result.type === "priority_assessment" &&
      Object.keys(completion.result).sort().join(",") === "outputFingerprint,type" &&
      /^[0-9a-f]{64}$/.test(completion.result.outputFingerprint);
    const researchResult = claim.kind === "resource_research" &&
      completion.result.type === "resource_research" &&
      Object.keys(completion.result).sort().join(",") === "reportId,type" &&
      isSafeCount(completion.result.reportId, 1);
    if (!priorityResult && !researchResult) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job result");
    }
    const keys = Object.keys(completion).sort().join(",");
    if (completion.status === "succeeded" && keys !== "result,status" ||
        completion.status === "partial" && (
          keys !== "diagnostic,result,status" ||
          completion.diagnostic?.code !== "JOB_BUDGET_EXHAUSTED" ||
          Object.keys(completion.diagnostic).join(",") !== "code"
        )) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job diagnostic");
    }
    return {
      resultType: priorityResult ? "priority_output" : "research_report",
      resultOutputFingerprint: priorityResult
        ? (completion.result as { outputFingerprint: string }).outputFingerprint : null,
      resultReportId: researchResult
        ? (completion.result as { reportId: number }).reportId : null,
      errorCode: completion.status === "partial" ? "JOB_BUDGET_EXHAUSTED" : null,
    };
  }

  function cancellableCompletionRow(
    claim: AiJobClaim,
    now: string,
  ): AiJobRow | undefined {
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    assertLease(row, claim, now);
    if (row.cancellation_requested_at === null) return row;
    cancelRunningAtCheckpoint(row, claim, now);
    return undefined;
  }

  function completeInTransaction(
    claim: AiJobClaim,
    checkpointInput: AiJobCheckpointInput,
    completion: AiJobCompletion,
  ): { readonly completed: boolean; readonly view: DurableJobView } {
    const initial = read(claim.kind, claim.id);
    if (initial === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(initial);
    assertLease(initial, claim, now);
    const result = completionProjection(claim, completion);
    const row = persistCheckpoint(initial, claim, checkpointInput, now);
    if (row.cancellation_requested_at !== null) {
      cancelRunningAtCheckpoint(row, claim, now);
      const cancelled = read(claim.kind, claim.id);
      return {
        completed: false,
        view: cancelled === undefined ? corrupt() : validateProjection(cancelled),
      };
    }
    insertCompletionEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      eventType: completion.status,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      ...result,
      occurredAt: now,
    });
    const updated = read(claim.kind, claim.id);
    return {
      completed: true,
      view: updated === undefined ? corrupt() : validateProjection(updated),
    };
  }

  const completeTransaction = connection.transaction((
    claim: AiJobClaim,
    checkpoint: AiJobCheckpointInput,
    completion: AiJobResearchCompletion,
  ): DurableJobView => {
    if (claim.kind !== "resource_research") {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Priority publication requires guarded completion",
      );
    }
    if (schemaRequiresResearchAdapter) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Schema-24 research requires ledger-owned publication",
      );
    }
    return completeInTransaction(claim, checkpoint, completion).view;
  });

  const completeResearchTransaction = connection.transaction((
    claim: AiJobClaim,
    checkpointInput: AiJobCheckpointInput,
    draft: ResearchPublicationDraft,
  ): DurableJobView => {
    if (claim.kind !== "resource_research" || research === undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Research publication adapter is unavailable",
      );
    }
    const terminalCheckpoint = parseResearchCheckpoint(checkpointInput.checkpoint);
    if (terminalCheckpoint === undefined || terminalCheckpoint.nextStep !== 2) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Research publication requires its terminal checkpoint",
      );
    }
    const initial = read(claim.kind, claim.id);
    if (initial === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(initial);
    assertLease(initial, claim, now);
    const row = persistCheckpoint(initial, claim, checkpointInput, now);
    if (row.cancellation_requested_at !== null) {
      cancelRunningAtCheckpoint(row, claim, now);
      const cancelled = read(claim.kind, claim.id);
      return cancelled === undefined ? corrupt() : validateProjection(cancelled);
    }
    if (researchCorpusReader === undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Research corpus publication fence is unavailable",
      );
    }
    const auditOnlyStaleGuard = claim.attemptNo >= 3 && draft.status === "partial" &&
      draft.reason === "corpus_became_stale" && draft.usedSourceIds.length === 0 &&
      draft.claims.length === 0 && draft.coverage.used === 0 &&
      draft.provenance.provider === RESEARCH_STALE_GUARD_METADATA.provider &&
      draft.provenance.model === RESEARCH_STALE_GUARD_METADATA.model &&
      draft.provenance.promptVersion === RESEARCH_STALE_GUARD_METADATA.promptVersion &&
      draft.provenance.pricingVersion === RESEARCH_STALE_GUARD_METADATA.pricingVersion &&
      draft.provenance.requestId === null &&
      canonicalJson(draft.dossier) === canonicalJson(RESEARCH_STALE_GUARD_DOSSIER);
    if (auditOnlyStaleGuard) {
      let audit: ReturnType<ResearchCorpusReader["readAuditForJob"]>;
      try {
        audit = researchCorpusReader.readAuditForJob(
          `resource_research:${row.id}` as DurableJobId,
        );
      } catch {
        throw new DurableAiJobError(
          "JOB_INPUT_UNAVAILABLE",
          "Approved research audit corpus is unavailable for stale publication",
        );
      }
      if (audit.corpusFingerprint !== draft.corpusFingerprint ||
          canonicalJson(audit.coverage) !== canonicalJson(draft.coverage)) {
        throw new DurableAiJobError(
          "INVALID_JOB_INPUT",
          "Research stale publication does not match its audit corpus",
        );
      }
    } else {
      let currentCorpus: ReturnType<ResearchCorpusReader["readForJob"]>;
      try {
        currentCorpus = researchCorpusReader.readForJob(
          `resource_research:${row.id}` as DurableJobId,
        );
      } catch {
        throw new DurableAiJobError(
          "JOB_INPUT_UNAVAILABLE",
          "Approved research corpus changed before publication",
        );
      }
      if ((currentCorpus.parent?.digest ?? null) !== terminalCheckpoint.parentDigest) {
        throw new DurableAiJobError(
          "JOB_INPUT_UNAVAILABLE",
          "Approved research corpus changed before publication",
        );
      }
    }
    assertResearchPublicationProvenance(row, claim, draft, now);
    const publication = research.publish(row.id, draft, now);
    if (publication.status !== draft.status) {
      return corrupt("Research publisher returned an invalid status");
    }
    if (selectResearchRunOwnership?.get(
      row.id,
      draft.inputFingerprint,
      draft.corpusFingerprint,
    ) === undefined) {
      return corrupt("Research publisher lost run/corpus ownership");
    }
    const completion: AiJobResearchCompletion = draft.status === "succeeded"
      ? {
          status: "succeeded",
          result: { type: "resource_research", reportId: publication.reportId },
        }
      : {
          status: "partial",
          diagnostic: { code: "JOB_BUDGET_EXHAUSTED" },
          result: { type: "resource_research", reportId: publication.reportId },
        };
    insertCompletionEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      eventType: completion.status,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      ...completionProjection(claim, completion),
      occurredAt: now,
    });
    const completed = read(claim.kind, claim.id);
    return completed === undefined ? corrupt() : validateProjection(completed);
  });

  interface PriorityPartialManifest {
    readonly version: 1;
    readonly initialDenominator: number;
    readonly observedDenominator: number;
    readonly guardLimit?: {
      readonly kind: "rows" | "bytes";
      readonly limit: number;
      readonly observed: number;
      readonly rowCount: number;
    };
    readonly fixpointLimit?: {
      readonly maxCycles: 3 | 4;
      readonly observedCycles: number;
    };
  }

  function normalizePartialManifest(value: unknown): PriorityPartialManifest {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "initialDenominator,observedDenominator,version") {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial manifest");
    }
    const manifest = value as Record<string, unknown>;
    if (manifest.version !== 1 || !isSafeCount(manifest.initialDenominator) ||
        !isSafeCount(manifest.observedDenominator)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial manifest");
    }
    return {
      version: 1,
      initialDenominator: manifest.initialDenominator,
      observedDenominator: manifest.observedDenominator,
    };
  }

  function partialProjection(
    row: AiJobRow,
    manifest: PriorityPartialManifest,
  ): ReturnType<typeof completionProjection> {
    const task = taskFromRow(row);
    if (task.kind !== "priority_assessment" || row.checkpoint_json === null) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Only checkpointed priority jobs can publish a partial result",
      );
    }
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(row.checkpoint_json);
    } catch {
      return corrupt("Stored AI job checkpoint is invalid");
    }
    const outputFingerprint = fingerprint({
      version: 1,
      coverage: false,
      status: "partial",
      diagnostic: { code: "JOB_BUDGET_EXHAUSTED" },
      subject: task.subject,
      ruleset: task.ruleset,
      initialDenominator: manifest.initialDenominator,
      observedDenominator: manifest.observedDenominator,
      ...(manifest.guardLimit === undefined ? {} : { guardLimit: manifest.guardLimit }),
      ...(manifest.fixpointLimit === undefined ? {} : {
        fixpointLimit: manifest.fixpointLimit,
      }),
      completedSteps: row.spent_steps,
      progress: {
        completed: row.progress_completed,
        total: row.progress_total,
        stage: row.progress_stage,
      },
      checkpoint,
    }).hash;
    return {
      resultType: "priority_output",
      resultOutputFingerprint: outputFingerprint,
      resultReportId: null,
      errorCode: "JOB_BUDGET_EXHAUSTED",
    };
  }

  function isPartialEligible(
    row: AiJobRow,
    manifest: PriorityPartialManifest,
  ): boolean {
    if ((row.subject_type === "page" || row.subject_type === "resource") &&
        (manifest.initialDenominator !== 1 ||
          ![0, 1].includes(manifest.observedDenominator))) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial manifest");
    }
    if (manifest.guardLimit !== undefined) {
      if (row.subject_type !== "collection" || manifest.observedDenominator === 0 ||
          manifest.guardLimit.rowCount !== manifest.observedDenominator) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial guard limit");
      }
      return true;
    }
    if (manifest.fixpointLimit !== undefined) {
      const expectedCycles = row.subject_type === "collection" ? 4 : 3;
      if (manifest.fixpointLimit.maxCycles !== expectedCycles ||
          manifest.fixpointLimit.observedCycles < expectedCycles) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial fixpoint limit");
      }
      return true;
    }
    const remainingSteps = row.max_steps - row.spent_steps;
    const remainingWallTimeMs = row.max_wall_time_ms - row.spent_wall_time_ms;
    return manifest.observedDenominator > 0 &&
      remainingSteps < manifest.observedDenominator || remainingWallTimeMs === 0;
  }

  function assertPartialEligible(
    row: AiJobRow,
    manifest: PriorityPartialManifest,
  ): void {
    if (!isPartialEligible(row, manifest)) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "AI job has sufficient budget for guarded completion",
      );
    }
  }

  function publishPartial(
    row: AiJobRow,
    claim: AiJobClaim,
    manifest: PriorityPartialManifest,
    now: string,
  ): DurableJobView {
    insertCompletionEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      eventType: "partial",
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      ...partialProjection(row, manifest),
      occurredAt: now,
    });
    const completed = read(claim.kind, claim.id);
    return completed === undefined ? corrupt() : validateProjection(completed);
  }

  function augmentGuardCheckpoint(
    checkpoint: AiJobCheckpointInput,
    rowCount: number,
    elapsedMs: number,
  ): AiJobCheckpointInput {
    const steps = checkpoint.usage.steps + rowCount;
    const wallTimeMs = checkpoint.usage.wallTimeMs + elapsedMs;
    if (!isSafeCount(steps) || !isSafeCount(wallTimeMs)) {
      throw new DurableAiJobError("JOB_BUDGET_EXHAUSTED", "AI job budget exhausted");
    }
    return {
      ...checkpoint,
      usage: { ...checkpoint.usage, steps, wallTimeMs },
    };
  }

  const completePartialTransaction = connection.transaction((
    claim: AiJobClaim,
    input: AiJobPartialCompletionInput,
  ): DurableJobView => {
    if (claim.kind !== "priority_assessment" || input === null ||
        typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "checkpoint,manifest") {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid partial completion");
    }
    const manifest = normalizePartialManifest(input.manifest);
    const initial = read(claim.kind, claim.id);
    if (initial === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(initial);
    assertLease(initial, claim, now);
    const progressed = persistCheckpoint(initial, claim, input.checkpoint, now);
    if (progressed.cancellation_requested_at !== null) {
      cancelRunningAtCheckpoint(progressed, claim, now);
      const cancelled = read(claim.kind, claim.id);
      return cancelled === undefined ? corrupt() : validateProjection(cancelled);
    }
    assertPartialEligible(progressed, manifest);
    return publishPartial(progressed, claim, manifest, now);
  });

  const completeIfTransaction = connection.transaction((
    claim: AiJobClaim,
    input: AiJobGuardedCompletion,
  ): { readonly completed: boolean; readonly view: DurableJobView } => {
    if (claim.kind !== "priority_assessment" || input === null ||
        typeof input !== "object" || Array.isArray(input) ||
        !["checkpoint,completion,guard", "checkpoint,completion,guard,onMismatch"]
          .includes(Object.keys(input).sort().join(","))) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid guarded completion");
    }
    let onMismatch: {
      readonly version: 1;
      readonly initialDenominator: number;
      readonly maxCycles?: 3 | 4;
    } | undefined;
    if (input.onMismatch !== undefined) {
      if (input.onMismatch === null || typeof input.onMismatch !== "object" ||
          Array.isArray(input.onMismatch) ||
          Object.keys(input.onMismatch).join(",") !== "terminalPartial" ||
          input.onMismatch.terminalPartial === null ||
          typeof input.onMismatch.terminalPartial !== "object" ||
          Array.isArray(input.onMismatch.terminalPartial) ||
          ![
            "initialDenominator,version",
            "initialDenominator,maxCycles,version",
          ].includes(Object.keys(input.onMismatch.terminalPartial).sort().join(","))) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid guard mismatch policy");
      }
      const value = input.onMismatch.terminalPartial;
      if (value.version !== 1 || !isSafeCount(value.initialDenominator) ||
          value.maxCycles !== undefined && value.maxCycles !== 3 && value.maxCycles !== 4) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid guard mismatch policy");
      }
      onMismatch = value;
    }
    const initial = read(claim.kind, claim.id);
    if (initial === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    if (onMismatch?.maxCycles !== undefined &&
        onMismatch.maxCycles !== (initial.subject_type === "collection" ? 4 : 3)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid guard mismatch cycle limit");
    }
    const now = checkedNow(initial);
    assertLease(initial, claim, now);
    const result = completionProjection(claim, input.completion);
    if (input.completion.status !== "succeeded") {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Guarded completion can only publish success",
      );
    }
    if (input.completion.result.outputFingerprint !== input.guard.expectedFingerprint) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Guarded result fingerprint does not match expected projection",
      );
    }
    normalizeCheckpoint(claim.kind, input.checkpoint, initial, true);
    if (initial.cancellation_requested_at !== null) {
      const progressed = persistCheckpoint(initial, claim, input.checkpoint, now, true);
      cancelRunningAtCheckpoint(progressed, claim, now);
      const cancelled = read(claim.kind, claim.id);
      return {
        completed: false,
        view: cancelled === undefined ? corrupt() : validateProjection(cancelled),
      };
    }
    const guardResult = executeReadGuard(connection, guards, input.guard);
    if (guardResult.kind === "overflow") {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "AI job read guard exceeds the guarded-completion envelope",
      );
    }
    const finalNow = canonicalTimestamp(clock());
    if (finalNow < now) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    const current = read(claim.kind, claim.id);
    if (current === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    assertLease(current, claim, finalNow);
    const elapsedMs = new Date(finalNow).getTime() - new Date(now).getTime();
    if (!isSafeCount(elapsedMs)) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    let chargedCheckpoint = augmentGuardCheckpoint(
      input.checkpoint,
      guardResult.rowCount,
      elapsedMs,
    );
    let guardCycleCount = 0;
    if (!guardResult.matches) {
      const priorGuardCycleCount = selectGuardCycleCount.get(claim.id);
      if (!isSafeCount(priorGuardCycleCount)) return corrupt("Stored guard cycle count is invalid");
      guardCycleCount = priorGuardCycleCount + 1;
      if (!isSafeCount(guardCycleCount, 1)) return corrupt("Stored guard cycle count is invalid");
      chargedCheckpoint = {
        ...chargedCheckpoint,
        progress: {
          ...chargedCheckpoint.progress,
          stage: `ledger:guard-cycle:${guardCycleCount}`,
        },
        checkpoint: { version: 1, nextOffset: 0 },
      };
    }
    const progressed = persistCheckpoint(
      current,
      claim,
      chargedCheckpoint,
      finalNow,
      true,
    );
    if (!guardResult.matches && onMismatch === undefined) {
      return { completed: false, view: validateProjection(progressed) };
    }
    if (!guardResult.matches) {
      const manifest = {
        version: 1 as const,
        initialDenominator: onMismatch!.initialDenominator,
        observedDenominator: guardResult.rowCount,
        ...(onMismatch!.maxCycles !== undefined &&
          guardCycleCount >= onMismatch!.maxCycles
          ? { fixpointLimit: {
              maxCycles: onMismatch!.maxCycles,
              observedCycles: guardCycleCount,
            } }
          : {}),
      };
      if (!isPartialEligible(progressed, manifest)) {
        return { completed: false, view: validateProjection(progressed) };
      }
      return {
        completed: true,
        view: publishPartial(progressed, claim, manifest, finalNow),
      };
    }
    insertCompletionEvent.run({
      jobId: progressed.id,
      sequenceNo: progressed.event_sequence + 1,
      eventType: input.completion.status,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      ...result,
      occurredAt: finalNow,
    });
    const completed = read(claim.kind, claim.id);
    return {
      completed: true,
      view: completed === undefined ? corrupt() : validateProjection(completed),
    };
  });

  const completePartialIfGuardLimitTransaction = connection.transaction((
    claim: AiJobClaim,
    input: AiJobGuardLimitCompletionInput,
  ): { readonly completed: boolean; readonly view: DurableJobView } => {
    if (claim.kind !== "priority_assessment" || input === null ||
        typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "checkpoint,guard,initialDenominator,maxCycles" ||
        !isSafeCount(input.initialDenominator) || input.maxCycles !== 4) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid guard-limit completion");
    }
    const initial = read(claim.kind, claim.id);
    if (initial === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(initial);
    assertLease(initial, claim, now);
    if (initial.subject_type !== "collection") {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Only collection jobs can publish a guard-limit partial",
      );
    }
    normalizeCheckpoint(claim.kind, input.checkpoint, initial, true);
    if (initial.cancellation_requested_at !== null) {
      const progressed = persistCheckpoint(initial, claim, input.checkpoint, now, true);
      cancelRunningAtCheckpoint(progressed, claim, now);
      const cancelled = read(claim.kind, claim.id);
      return {
        completed: false,
        view: cancelled === undefined ? corrupt() : validateProjection(cancelled),
      };
    }
    const guardResult = executeReadGuard(connection, guards, input.guard);
    const finalNow = canonicalTimestamp(clock());
    if (finalNow < now) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    const current = read(claim.kind, claim.id);
    if (current === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    assertLease(current, claim, finalNow);
    const elapsedMs = new Date(finalNow).getTime() - new Date(now).getTime();
    if (!isSafeCount(elapsedMs)) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    let chargedCheckpoint = augmentGuardCheckpoint(
      input.checkpoint,
      guardResult.rowCount,
      elapsedMs,
    );
    const priorGuardCycleCount = selectGuardCycleCount.get(claim.id);
    if (!isSafeCount(priorGuardCycleCount)) return corrupt("Stored guard cycle count is invalid");
    const guardCycleCount = priorGuardCycleCount + 1;
    if (!isSafeCount(guardCycleCount, 1)) return corrupt("Stored guard cycle count is invalid");
    chargedCheckpoint = {
      ...chargedCheckpoint,
      progress: {
        ...chargedCheckpoint.progress,
        stage: guardResult.kind === "overflow"
          ? `ledger:guard-limit:${guardResult.guardLimit.kind}`
          : `ledger:guard-cycle:${guardCycleCount}`,
      },
      checkpoint: { version: 1, nextOffset: 0 },
    };
    const progressed = persistCheckpoint(current, claim, chargedCheckpoint, finalNow, true);
    if (guardResult.kind !== "overflow") {
      if (guardCycleCount >= input.maxCycles) {
        return {
          completed: true,
          view: publishPartial(progressed, claim, {
            version: 1,
            initialDenominator: input.initialDenominator,
            observedDenominator: guardResult.rowCount,
            fixpointLimit: {
              maxCycles: input.maxCycles,
              observedCycles: guardCycleCount,
            },
          }, finalNow),
        };
      }
      return { completed: false, view: validateProjection(progressed) };
    }
    const manifest: PriorityPartialManifest = {
      version: 1,
      initialDenominator: input.initialDenominator,
      observedDenominator: guardResult.guardLimit.rowCount,
      guardLimit: guardResult.guardLimit,
    };
    return {
      completed: true,
      view: publishPartial(progressed, claim, manifest, finalNow),
    };
  });

  function cancelRunningAtCheckpoint(
    row: AiJobRow,
    claim: AiJobClaim,
    now: string,
  ): void {
    insertEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      eventType: "cancelled",
      fromStatus: "running",
      toStatus: "cancelled",
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      cancellationRequestedBy: null,
      errorCode: null,
      availableAt: null,
      occurredAt: now,
    });
  }

  const renewTransaction = connection.transaction((
    claim: AiJobClaim,
  ): AiJobRenewedLease | undefined => {
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(row);
    assertLease(row, claim, now);
    if (row.cancellation_requested_at !== null) {
      return undefined;
    }
    const leaseExpiresAt = canonicalTimestamp(
      new Date(new Date(now).getTime() + AI_JOB_LEASE_MS),
    );
    insertProgressEvent.run({
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      leaseOwner: claim.workerId,
      leaseExpiresAt,
      progressCompleted: row.progress_completed,
      progressTotal: row.progress_total,
      progressStage: row.progress_stage,
      checkpointJson: row.checkpoint_json,
      spentSteps: row.spent_steps,
      spentTokens: row.spent_tokens,
      spentInputTokens: (selectTokenUsage.get(row.id) as { input_tokens: number }).input_tokens,
      spentOutputTokens: (selectTokenUsage.get(row.id) as { output_tokens: number }).output_tokens,
      deltaInputTokens: 0,
      deltaOutputTokens: 0,
      deltaCostUsd: 0,
      deltaSteps: 0,
      deltaWallTimeMs: 0,
      spentCostUsd: row.spent_cost_usd,
      spentWallTimeMs: row.spent_wall_time_ms,
      occurredAt: now,
    });
    return { ...claim, leaseExpiresAt };
  });

  const failTransaction = connection.transaction((
    claim: AiJobClaim,
    checkpointInput: AiJobCheckpointInput,
    failure: AiJobFailure,
  ): DurableJobView => {
    if (failure === null || typeof failure !== "object" || Array.isArray(failure) ||
        Object.keys(failure).some((key) => key !== "code" && key !== "retryAt") ||
        typeof failure.code !== "string" || !new Set<string>([
          "JOB_SUBJECT_NOT_FOUND",
          "JOB_INPUT_UNAVAILABLE",
          "JOB_BUDGET_EXHAUSTED",
          "JOB_LEASE_LOST",
          "JOB_CLOCK_REGRESSION",
          "INVALID_JOB_TRANSITION",
        ]).has(failure.code)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job failure");
    }
    const row = read(claim.kind, claim.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const now = checkedNow(row);
    assertLease(row, claim, now);
    const progressed = persistCheckpoint(row, claim, checkpointInput, now);
    if (progressed.cancellation_requested_at !== null) {
      cancelRunningAtCheckpoint(progressed, claim, now);
    } else {
      const retryAt = failure.retryAt;
      const retryable = retryAt !== undefined && hasRetryBudget(progressed);
      let normalizedRetryAt: string | null = null;
      if (retryAt !== undefined) {
        if (!isCanonicalTimestamp(retryAt) || retryAt < now) {
          throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job retry time");
        }
        normalizedRetryAt = retryAt;
      }
      insertEvent.run({
        jobId: progressed.id,
        sequenceNo: progressed.event_sequence + 1,
        eventType: retryable ? "retry_scheduled" : "failed",
        fromStatus: "running",
        toStatus: retryable ? "queued" : "failed",
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        cancellationRequestedBy: null,
        errorCode: failure.code,
        availableAt: retryable ? normalizedRetryAt : null,
        occurredAt: now,
      });
    }
    const updated = read(claim.kind, claim.id);
    return updated === undefined ? corrupt() : validateProjection(updated);
  });

  const recoverTransaction = connection.transaction((
    workflowAllowlistValue?: AiJobWorkflowAllowlist,
  ): number => {
    const workflowAllowlist = normalizeWorkflowAllowlist(workflowAllowlistValue);
    const now = canonicalTimestamp(clock());
    const rows = (selectExpired.all({
      now,
      workflowAllowlistJson: workflowAllowlist?.json ?? null,
    }) as ExpiredRow[])
      .filter((row) => options.kindAvailable(row.kind));
    for (const row of rows) validateProjection(row);
    for (const row of rows) {
      if (row.attempt_id === null || row.lease_token === null) return corrupt();
      if (now < mutationFloor(row)) {
        throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
      }
      const cancelled = row.cancellation_requested_at !== null;
      const retryable = !cancelled && hasRetryBudget(row);
      insertEvent.run({
        jobId: row.id,
        sequenceNo: row.event_sequence + 1,
        eventType: cancelled ? "cancelled" : retryable ? "recovered" : "failed",
        fromStatus: "running",
        toStatus: cancelled ? "cancelled" : retryable ? "queued" : "failed",
        attemptId: row.attempt_id,
        leaseToken: row.lease_token,
        cancellationRequestedBy: null,
        errorCode: cancelled || retryable ? null : "JOB_BUDGET_EXHAUSTED",
        availableAt: retryable ? now : null,
        occurredAt: now,
      });
    }
    return rows.length;
  });

  function integerPk(value: number): string {
    const text = String(value);
    return `pk:v1|1|i:${text.length}:${text}`;
  }

  function settleExpiredCancellation(
    input: AiJobExpiredCancellation,
  ): DurableJobView {
    if (options.transactionBound !== true || !connection.inTransaction ||
        options.authorizeOwnedMutation === undefined) {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Expired cancellation requires a transaction-bound AI ledger",
      );
    }
    const row = read(input.kind, input.id);
    if (row === undefined) {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    validateProjection(row);
    const now = canonicalTimestamp(clock());
    if (now < mutationFloor(row)) {
      throw new DurableAiJobError("JOB_CLOCK_REGRESSION", "Job clock regressed");
    }
    const attempt = selectClaimAttempt.get(input.attemptId, row.id) as {
      attempt_no: number;
      worker_id: string;
      lease_token: string;
      outcome: string;
    } | undefined;
    if (row.status !== "running" || row.cancellation_requested_at === null ||
        row.lease_owner !== input.workerId || row.lease_token !== input.leaseToken ||
        row.lease_expires_at !== input.leaseExpiresAt ||
        row.lease_expires_at === null || row.lease_expires_at > now ||
        attempt === undefined || attempt.attempt_no !== input.attemptNo ||
        attempt.worker_id !== input.workerId ||
        attempt.lease_token !== input.leaseToken || attempt.outcome !== "running") {
      throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
    }
    const eventId = Number(connection.prepare(`
      SELECT COALESCE(MAX(id), 0) + 1 FROM ai_job_events
    `).pluck().get());
    const eventRow = {
      id: eventId,
      job_id: row.id,
      sequence_no: row.event_sequence + 1,
      event_type: "cancelled",
      from_status: "running",
      to_status: "cancelled",
      attempt_id: input.attemptId,
      lease_owner: null,
      lease_token: input.leaseToken,
      lease_expires_at: null,
      progress_completed: null,
      progress_total: null,
      progress_stage: null,
      checkpoint_json: null,
      cancellation_requested_by: null,
      result_type: null,
      result_output_fingerprint: null,
      result_report_id: null,
      error_code: null,
      available_at: null,
      spent_steps: null,
      spent_tokens: null,
      spent_input_tokens: null,
      spent_output_tokens: null,
      delta_input_tokens: null,
      delta_output_tokens: null,
      delta_cost_usd: null,
      delta_steps: null,
      delta_wall_time_ms: null,
      spent_cost_usd: null,
      spent_wall_time_ms: null,
      occurred_at: now,
    } as const;
    options.authorizeOwnedMutation({
      tableName: "ai_job_attempts",
      operation: "UPDATE",
      oldPkV1: integerPk(input.attemptId),
      newPkV1: integerPk(input.attemptId),
    });
    options.authorizeOwnedMutation({
      tableName: "ai_jobs",
      operation: "UPDATE",
      oldPkV1: integerPk(row.id),
      newPkV1: integerPk(row.id),
    });
    options.authorizeOwnedMutation({
      tableName: "ai_job_events",
      operation: "INSERT",
      oldPkV1: "",
      newPkV1: integerPk(eventId),
      newRow: eventRow,
    });
    insertExpiredCancellationEvent.run({
      id: eventId,
      jobId: row.id,
      sequenceNo: row.event_sequence + 1,
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      occurredAt: now,
    });
    const terminal = read(input.kind, input.id);
    if (terminal === undefined || terminal.status !== "cancelled") {
      return corrupt("Expired cancellation did not settle the AI job");
    }
    return validateProjection(terminal);
  }

  return {
    replayAgentResearchStart,

    submit(value) {
      const task = normalizeNewTask(value);
      if (!options.kindAvailable(task.kind)) {
        throw new DurableAiJobError(
          "JOB_KIND_UNAVAILABLE",
          "This AI job kind is unavailable",
        );
      }
      return submitTransaction.immediate(task);
    },

    submitResearch(value, approvalRequestValue) {
      const task = normalizeNewTask(value);
      const approved = researchApprovalRequestSchema.safeParse(approvalRequestValue);
      if (task.kind !== "resource_research" || !approved.success) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research submission");
      }
      if (!options.kindAvailable(task.kind)) {
        throw new DurableAiJobError(
          "JOB_KIND_UNAVAILABLE",
          "This AI job kind is unavailable",
        );
      }
      return submitTransaction.immediate(task, approved.data);
    },

    submitAgentResearch(value, approvalRequestValue, command) {
      const task = normalizeNewTask(value);
      const approved = researchApprovalRequestSchema.safeParse(approvalRequestValue);
      if (task.kind !== "resource_research" || !approved.success) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research submission");
      }
      if (!options.kindAvailable(task.kind)) {
        throw new DurableAiJobError(
          "JOB_KIND_UNAVAILABLE",
          "This AI job kind is unavailable",
        );
      }
      return submitAgentResearchTransaction.immediate(task, approved.data, command);
    },

    get(kind, id) {
      if (kind !== "priority_assessment" && kind !== "resource_research") {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job kind");
      }
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      const row = read(kind, id);
      return row === undefined ? undefined : validateProjection(row);
    },

    cancel(kind, id, requestedBy = "user") {
      if (kind !== "priority_assessment" && kind !== "resource_research" ||
          requestedBy !== "user" && requestedBy !== "agent") {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job cancellation");
      }
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
      }
      assertKindMutationAvailable(kind);
      return cancelTransaction.immediate(kind, id, requestedBy);
    },

    cancelAgentResearch(id, command) {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
      }
      assertKindMutationAvailable("resource_research");
      return cancelAgentResearchTransaction.immediate(id, command);
    },

    claimNext(kind, workerId, limits, claimBoundary, workflowAllowlistValue) {
      if (kind !== "priority_assessment" && kind !== "resource_research") {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job kind");
      }
      assertKindMutationAvailable(kind);
      const workflowAllowlist = normalizeWorkflowAllowlist(workflowAllowlistValue);
      const liveAcquisitionOnly = workflowAllowlist?.entries.length === 1 &&
        isLiveAcquisitionWorkflow(workflowAllowlist.entries[0]);
      const claimLimits = kind === "resource_research" && schemaRequiresResearchAdapter &&
          !liveAcquisitionOnly
        ? { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 }
        : normalizeClaimLimits(limits);
      return claimTransaction.immediate(
        kind,
        normalizeWorkerId(workerId),
        claimLimits,
        claimBoundary,
        workflowAllowlist?.entries,
      );
    },

    checkpoint(claim, input) {
      assertKindMutationAvailable(claim.kind);
      return checkpointTransaction.immediate(claim, input);
    },

    renew(claim) {
      assertKindMutationAvailable(claim.kind);
      return renewTransaction.immediate(claim);
    },

    refresh(claim) {
      const row = read(claim.kind, claim.id);
      if (row === undefined) {
        throw new DurableAiJobError("JOB_LEASE_LOST", "AI job lease was lost");
      }
      const now = checkedNow(row);
      assertLease(row, claim, now);
      const tokenUsage = selectTokenUsage.get(row.id) as {
        input_tokens: number;
        output_tokens: number;
      };
      if (!isSafeCount(tokenUsage.input_tokens) || !isSafeCount(tokenUsage.output_tokens) ||
          row.lease_expires_at === null) {
        return corrupt("Stored AI job execution state is invalid");
      }
      return {
        id: claim.id,
        kind: claim.kind,
        attemptId: claim.attemptId,
        attemptNo: claim.attemptNo,
        workerId: claim.workerId,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: row.lease_expires_at,
        ...executionStateFromRow(row, {
          inputTokens: tokenUsage.input_tokens,
          outputTokens: tokenUsage.output_tokens,
        }, schemaRequiresResearchAdapter),
      };
    },

    complete(claim, checkpoint, completion) {
      assertKindMutationAvailable(claim.kind);
      return completeTransaction.immediate(claim, checkpoint, completion);
    },

    completeResearch(claim, checkpoint, draftValue) {
      assertKindMutationAvailable(claim.kind);
      const draft = researchPublicationDraftSchema.safeParse(draftValue);
      if (!draft.success) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research publication");
      }
      return completeResearchTransaction.immediate(claim, checkpoint, draft.data);
    },

    completeIf(claim, input) {
      assertKindMutationAvailable(claim.kind);
      return completeIfTransaction.immediate(claim, input);
    },

    completePartialIfGuardLimit(claim, input) {
      assertKindMutationAvailable(claim.kind);
      return completePartialIfGuardLimitTransaction.immediate(claim, input);
    },

    completePartial(claim, input) {
      assertKindMutationAvailable(claim.kind);
      return completePartialTransaction.immediate(claim, input);
    },

    bindAttemptProvider(claim, metadata) {
      assertKindMutationAvailable(claim.kind);
      bindAttemptProviderTransaction.immediate(claim, metadata);
    },

    recordAttemptRequest(claim, requestId) {
      assertKindMutationAvailable(claim.kind);
      recordAttemptRequestTransaction.immediate(claim, requestId);
    },

    fail(claim, checkpoint, failure) {
      assertKindMutationAvailable(claim.kind);
      return failTransaction.immediate(claim, checkpoint, failure);
    },

    recoverInterrupted(workflowAllowlist) {
      return recoverTransaction.immediate(workflowAllowlist);
    },

    settleExpiredCancellation(input) {
      return settleExpiredCancellation(input);
    },
  };
}

export type AiJobSubmission = PriorityAssessmentTaskSpec | ResourceResearchTaskSpec;
