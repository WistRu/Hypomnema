import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import {
  durableJobIdSchema,
  estimateResearchReservationV1,
  researchApprovedDraftSchema,
  researchCanonicalSha256PayloadV1,
  researchDossierSchema,
  researchSelectionFingerprintPayload,
  type DurableJobId,
  type ResearchApprovedDraft,
  type ResearchCoverage,
  type ResearchSnapshotDraft,
} from "@tabhub/shared";

import {
  fingerprintResearchApproval,
  fingerprintResearchCorpus,
} from "./research-store.js";

export type ResearchCorpusReaderErrorCode =
  | "RESEARCH_CORPUS_MISMATCH"
  | "RESEARCH_REDACTION_REQUIRED";

export class ResearchCorpusReaderError extends Error {
  constructor(
    readonly code: ResearchCorpusReaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchCorpusReaderError";
  }
}

interface ResearchCorpusSourceCommon {
  readonly sourceId: number;
  readonly ordinal: number;
  readonly includedOrder: number;
  readonly logicalPageId: number;
  readonly contentRevision: number;
  readonly contentDigest: string;
  readonly extractedAt: string;
  readonly accessClass: "public" | "authenticated" | "sensitive";
  readonly payload: {
    readonly trust: "untrusted_source_material";
    readonly url: string;
    readonly title: string;
    readonly evidenceMaterial: string;
    readonly chunkManifest: {
      readonly version: "captured_text_chunks:v1";
      readonly byteStart: 0;
      readonly byteEnd: number;
      readonly chunkDigest: string;
      readonly truncated: boolean;
    };
  };
}

export type ResearchCorpusSource = ResearchCorpusSourceCommon & (
  | {
      readonly sourceKind: "captured";
      readonly tabId: number;
      readonly acquisitionMethod: "captured" | "exact_capture";
    }
  | {
      readonly sourceKind: "live_acquisition";
      readonly tabId: null;
      readonly acquisitionMethod: "safe_public_http_v1";
      readonly handoffSourceReceiptId: number;
      readonly handoffSourceReceiptDigest: string;
    }
);

/** Materializes one schema-validated included source without requiring a tab for live input. */
export function materializeResearchCorpusSource(
  source: ResearchApprovedDraft["sources"][number],
  sourceId: number,
): ResearchCorpusSource | undefined {
  if (source.inclusionState !== "included" || source.payload === null ||
      (source.sourceKind === "captured" && source.tabId === null) ||
      source.contentDigest === null || source.extractedAt === null ||
      source.includedOrder === null) {
    return undefined;
  }
  const common = {
    sourceId,
    ordinal: source.ordinal,
    includedOrder: source.includedOrder,
    logicalPageId: source.logicalPageId,
    contentRevision: source.contentRevision,
    contentDigest: source.contentDigest,
    extractedAt: source.extractedAt,
    accessClass: source.accessClass,
    payload: { ...source.payload, trust: "untrusted_source_material" as const },
  };
  if (source.sourceKind === "live_acquisition") {
    return {
      ...common,
      sourceKind: source.sourceKind,
      tabId: null,
      acquisitionMethod: source.acquisitionMethod,
      handoffSourceReceiptId: source.handoffSourceReceiptId,
      handoffSourceReceiptDigest: source.handoffSourceReceiptDigest,
    };
  }
  return {
    ...common,
    sourceKind: source.sourceKind,
    tabId: source.tabId,
    acquisitionMethod: source.acquisitionMethod,
  };
}

export type ResearchCorpusSnapshot = ResearchSnapshotDraft & {
  readonly snapshotId: number;
};

export interface ResearchExecutionParent {
  readonly reportId: number;
  readonly reportVersion: number;
  readonly state: "fresh" | "stale";
  readonly reportText: string;
  readonly payloadDigest: string;
  readonly digest: string;
}

export interface ApprovedResearchCorpus {
  readonly version: 1;
  readonly jobId: DurableJobId;
  readonly runId: number;
  readonly target: ResearchApprovedDraft["target"];
  readonly selectionLogicalPageIds: readonly number[];
  readonly question: string;
  readonly scope: ResearchApprovedDraft["scope"];
  readonly parentReportId: number | null;
  readonly approvalFingerprint: string;
  readonly corpusFingerprint: string;
  readonly workflowRef: ResearchApprovedDraft["workflowRef"];
  readonly budget: ResearchApprovedDraft["budget"];
  readonly estimate: ResearchApprovedDraft["estimate"];
  readonly sources: readonly ResearchCorpusSource[];
  readonly snapshots: readonly ResearchCorpusSnapshot[];
  readonly parent: ResearchExecutionParent | null;
  readonly corpusDigest: string;
}

export interface ResearchCorpusAudit {
  readonly version: 1;
  readonly jobId: DurableJobId;
  readonly runId: number;
  readonly target: ResearchApprovedDraft["target"];
  readonly corpusFingerprint: string;
  readonly coverage: ResearchCoverage;
  readonly digest: string;
}

export interface ResearchCorpusReader {
  readForJob(jobId: DurableJobId): ApprovedResearchCorpus;
  readAuditForJob(jobId: DurableJobId): ResearchCorpusAudit;
}

interface RunRow {
  readonly id: number;
  readonly target_key: string;
  readonly target_logical_page_id: number | null;
  readonly target_resource_id: number | null;
  readonly target_selection: number;
  readonly selection_fingerprint: string | null;
  readonly question_digest: string;
  readonly run_scope_json: string;
  readonly approval_fingerprint: string;
  readonly corpus_fingerprint: string;
  readonly workflow_id: string;
  readonly workflow_version: number;
  readonly parent_report_id: number | null;
  readonly max_steps: number;
  readonly max_tokens: number;
  readonly max_cost_usd: number;
  readonly max_wall_time_ms: number;
  readonly question: string | null;
  readonly payload_scope_json: string | null;
  readonly privacy_bound: number;
  readonly job_subject_key: string;
  readonly job_input_fingerprint: string;
  readonly job_workflow_id: string;
  readonly job_workflow_version: number;
  readonly job_max_steps: number;
  readonly job_max_tokens: number;
  readonly job_max_cost_usd: number;
  readonly job_max_wall_time_ms: number;
}

interface SourceRow {
  readonly id: number;
  readonly ordinal: number;
  readonly logical_page_id: number;
  readonly captured_tab_id_snapshot: number | null;
  readonly content_revision: number | null;
  readonly content_digest: string | null;
  readonly extracted_at: string | null;
  readonly source_kind: "captured" | "live_acquisition";
  readonly acquisition_method:
    | "inventory" | "captured" | "exact_capture" | "safe_public_http_v1";
  readonly handoff_source_receipt_id: number | null;
  readonly access_class_snapshot: "public" | "authenticated" | "sensitive";
  readonly eligibility: "eligible" | "privacy_excluded" | "format_excluded" |
    "size_excluded" | "not_captured";
  readonly inclusion_state: "included" | "excluded" | "missing" | "failed";
  readonly exclusion_reason: "source_limit" | "privacy" | "format" | "size" | null;
  readonly included_order: number | null;
  readonly failure_code: string | null;
  readonly head_state: "valid" | "invalid" | "redacted" | null;
  readonly url_snapshot: string | null;
  readonly title_snapshot: string | null;
  readonly evidence_material: string | null;
  readonly chunk_manifest_json: string | null;
  readonly payload_digest: string | null;
  readonly receipt_handoff_id: number | null;
  readonly receipt_final_run_id: number | null;
  readonly receipt_ordinal: number | null;
  readonly receipt_logical_page_id: number | null;
  readonly receipt_logical_page_generation_id: number | null;
  readonly receipt_inclusion_state: string | null;
  readonly receipt_included_order: number | null;
  readonly receipt_content_revision: number | null;
  readonly receipt_content_digest: string | null;
  readonly receipt_extracted_at: string | null;
  readonly receipt_digest: string | null;
  readonly handoff_status: string | null;
  readonly terminal_handoff_id: number | null;
  readonly page_generation_subject_kind: string | null;
  readonly page_generation_logical_page_id: number | null;
}

type SnapshotKind = "page_context" | "resource_context" | "activity" | "relation";

interface SnapshotRow {
  readonly kind: SnapshotKind;
  readonly id: number;
  readonly context_entry_id: number | null;
  readonly logical_page_id: number | null;
  readonly resource_id: number | null;
  readonly activity_date: string | null;
  readonly relation_id: number | null;
  readonly snapshot_digest: string;
  readonly accepted_event_id: number | null;
  readonly head_state: "valid" | "invalid" | "redacted" | null;
  readonly material_json: string | null;
}

interface ParentRow {
  readonly id: number;
  readonly target_key: string;
  readonly version: number;
  readonly publish_status: "succeeded" | "partial";
  readonly state: "fresh" | "stale" | "redacted" | "superseded" | null;
  readonly report_text: string | null;
  readonly structured_json: string | null;
  readonly payload_digest: string | null;
  readonly privacy_bound: number;
}

interface AuditRunRow {
  readonly id: number;
  readonly target_key: string;
  readonly target_logical_page_id: number | null;
  readonly target_resource_id: number | null;
  readonly target_selection: number;
  readonly selection_fingerprint: string | null;
  readonly corpus_fingerprint: string;
  readonly parent_report_id: number | null;
  readonly privacy_bound: number;
  readonly job_subject_key: string;
}

interface AuditSourceRow {
  readonly ordinal: number;
  readonly eligibility: SourceRow["eligibility"];
  readonly inclusion_state: SourceRow["inclusion_state"];
  readonly head_state: SourceRow["head_state"];
}

interface AuditStateRow {
  readonly state: "valid" | "invalid" | "redacted" | "fresh" | "stale" |
    "superseded" | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function mismatch(message: string): never {
  throw new ResearchCorpusReaderError("RESEARCH_CORPUS_MISMATCH", message);
}

function redacted(message: string): never {
  throw new ResearchCorpusReaderError("RESEARCH_REDACTION_REQUIRED", message);
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return mismatch(message);
  }
}

function parseJobId(value: DurableJobId): number {
  const parsed = durableJobIdSchema.safeParse(value);
  if (!parsed.success || !parsed.data.startsWith("resource_research:")) {
    return mismatch("Research corpus requires a resource-research durable job ID");
  }
  return Number(parsed.data.slice("resource_research:".length));
}

export function createResearchCorpusReader(
  connection: Database.Database,
): ResearchCorpusReader {
  const schemaVersion = connection.pragma("user_version", {
    simple: true,
  }) as number;
  const selectRun = connection.prepare(`
    SELECT run.id, run.target_key, run.target_logical_page_id, run.target_resource_id,
      run.target_selection, run.selection_fingerprint, run.question_digest,
      run.scope_json AS run_scope_json, run.approval_fingerprint,
      run.corpus_fingerprint, run.workflow_id, run.workflow_version,
      run.parent_report_id, run.max_steps, run.max_tokens, run.max_cost_usd,
      run.max_wall_time_ms, payload.question,
      payload.scope_json AS payload_scope_json,
      EXISTS (
        SELECT 1 FROM research_privacy_run_bindings AS privacy
        WHERE privacy.run_id = run.id
      ) AS privacy_bound,
      job.subject_key AS job_subject_key,
      job.input_fingerprint AS job_input_fingerprint,
      job.workflow_id AS job_workflow_id,
      job.workflow_version AS job_workflow_version,
      job.max_steps AS job_max_steps, job.max_tokens AS job_max_tokens,
      job.max_cost_usd AS job_max_cost_usd,
      job.max_wall_time_ms AS job_max_wall_time_ms
    FROM research_runs AS run
    JOIN ai_jobs AS job ON job.id = run.job_id AND job.kind = 'resource_research'
    LEFT JOIN research_run_payloads AS payload ON payload.run_id = run.id
    WHERE run.job_id = ?
  `);
  const selectSelection = connection.prepare(`
    SELECT logical_page_id
    FROM research_run_selection_pages
    WHERE run_id = ?
    ORDER BY selection_order
  `);
  const selectSources = connection.prepare(schemaVersion >= 25 ? `
    SELECT source.id, source.ordinal, source.logical_page_id,
      source.captured_tab_id_snapshot, source.content_revision,
      source.content_digest, source.extracted_at, source.source_kind,
      source.acquisition_method, source.handoff_source_receipt_id,
      source.access_class_snapshot, source.eligibility, source.inclusion_state,
      source.exclusion_reason, source.included_order, source.failure_code,
      head.state AS head_state, payload.url_snapshot, payload.title_snapshot,
      payload.evidence_material, payload.chunk_manifest_json, payload.payload_digest,
      receipt.handoff_id AS receipt_handoff_id,
      receipt.final_run_id AS receipt_final_run_id,
      receipt.ordinal AS receipt_ordinal,
      receipt.logical_page_id AS receipt_logical_page_id,
      receipt.logical_page_generation_id AS receipt_logical_page_generation_id,
      receipt.inclusion_state AS receipt_inclusion_state,
      receipt.included_order AS receipt_included_order,
      receipt.content_revision AS receipt_content_revision,
      receipt.content_digest AS receipt_content_digest,
      receipt.extracted_at AS receipt_extracted_at,
      receipt.receipt_digest,
      handoff.status AS handoff_status,
      terminal.handoff_id AS terminal_handoff_id,
      page_generation.subject_kind AS page_generation_subject_kind,
      page_generation.logical_page_id AS page_generation_logical_page_id
    FROM research_sources AS source
    LEFT JOIN research_source_heads AS head ON head.source_id = source.id
    LEFT JOIN research_source_payloads AS payload ON payload.source_id = source.id
    LEFT JOIN live_acquisition_source_receipts AS receipt
      ON receipt.id = source.handoff_source_receipt_id
    LEFT JOIN live_acquisition_handoffs AS handoff ON handoff.id = receipt.handoff_id
    LEFT JOIN live_acquisition_handoff_receipts AS terminal
      ON terminal.handoff_id = receipt.handoff_id
    LEFT JOIN privacy_subject_generations AS page_generation
      ON page_generation.id = receipt.logical_page_generation_id
    WHERE source.run_id = ?
    ORDER BY source.ordinal
  ` : `
    SELECT source.id, source.ordinal, source.logical_page_id,
      source.captured_tab_id_snapshot, source.content_revision,
      source.content_digest, source.extracted_at, 'captured' AS source_kind,
      source.acquisition_method, NULL AS handoff_source_receipt_id,
      source.access_class_snapshot, source.eligibility, source.inclusion_state,
      source.exclusion_reason, source.included_order, source.failure_code,
      head.state AS head_state, payload.url_snapshot, payload.title_snapshot,
      payload.evidence_material, payload.chunk_manifest_json, payload.payload_digest,
      NULL AS receipt_handoff_id,
      NULL AS receipt_final_run_id,
      NULL AS receipt_ordinal,
      NULL AS receipt_logical_page_id,
      NULL AS receipt_logical_page_generation_id,
      NULL AS receipt_inclusion_state,
      NULL AS receipt_included_order,
      NULL AS receipt_content_revision,
      NULL AS receipt_content_digest,
      NULL AS receipt_extracted_at,
      NULL AS receipt_digest,
      NULL AS handoff_status,
      NULL AS terminal_handoff_id,
      NULL AS page_generation_subject_kind,
      NULL AS page_generation_logical_page_id
    FROM research_sources AS source
    LEFT JOIN research_source_heads AS head ON head.source_id = source.id
    LEFT JOIN research_source_payloads AS payload ON payload.source_id = source.id
    WHERE source.run_id = ?
    ORDER BY source.ordinal
  `);
  // C80 inserts each immutable accepted event in approved snapshot order. Its
  // global event id is therefore the persisted cross-table ordinal seam.
  const selectSnapshots = connection.prepare(`
    SELECT snapshot.kind, snapshot.id, snapshot.context_entry_id,
      snapshot.logical_page_id, snapshot.resource_id, snapshot.activity_date,
      snapshot.relation_id, snapshot.snapshot_digest,
      accepted.id AS accepted_event_id, head.state AS head_state,
      payload.material_json
    FROM (
      SELECT 'page_context' AS kind, id, context_entry_audit_id AS context_entry_id,
        logical_page_audit_id AS logical_page_id, NULL AS resource_id,
        NULL AS activity_date, NULL AS relation_id, snapshot_digest
      FROM research_page_context_snapshots WHERE run_id = @runId
      UNION ALL
      SELECT 'resource_context', id, context_entry_audit_id, NULL,
        resource_audit_id, NULL, NULL, snapshot_digest
      FROM research_resource_context_snapshots WHERE run_id = @runId
      UNION ALL
      SELECT 'activity', id, NULL, logical_page_audit_id, NULL,
        activity_date_audit, NULL, snapshot_digest
      FROM research_activity_snapshots WHERE run_id = @runId
      UNION ALL
      SELECT 'relation', id, NULL, NULL, NULL, NULL,
        relation_audit_id, snapshot_digest
      FROM research_relation_snapshots WHERE run_id = @runId
    ) AS snapshot
    LEFT JOIN research_snapshot_state_events AS accepted
      ON accepted.kind = snapshot.kind AND accepted.snapshot_id = snapshot.id
      AND accepted.sequence_no = 1 AND accepted.event_type = 'accepted'
    LEFT JOIN research_snapshot_heads AS head
      ON head.kind = snapshot.kind AND head.snapshot_id = snapshot.id
    LEFT JOIN research_snapshot_payloads AS payload
      ON payload.kind = snapshot.kind AND payload.snapshot_id = snapshot.id
    ORDER BY accepted.id, snapshot.kind, snapshot.id
  `);
  const selectParent = connection.prepare(`
    SELECT report.id, report.target_key, report.version, report.publish_status,
      head.state, payload.report_text, payload.structured_json, payload.payload_digest,
      EXISTS (
        SELECT 1 FROM research_privacy_run_bindings AS privacy
        WHERE privacy.run_id = report.run_id
      ) AS privacy_bound
    FROM research_reports AS report
    LEFT JOIN research_report_heads AS head ON head.report_id = report.id
    LEFT JOIN research_report_payloads AS payload ON payload.report_id = report.id
    WHERE report.id = ?
  `);
  const selectAuditRun = connection.prepare(`
    SELECT run.id, run.target_key, run.target_logical_page_id, run.target_resource_id,
      run.target_selection, run.selection_fingerprint, run.corpus_fingerprint,
      run.parent_report_id,
      EXISTS (
        SELECT 1 FROM research_privacy_run_bindings AS privacy
        WHERE privacy.run_id = run.id
      ) AS privacy_bound,
      job.subject_key AS job_subject_key
    FROM research_runs AS run
    JOIN ai_jobs AS job ON job.id = run.job_id AND job.kind = 'resource_research'
    WHERE run.job_id = ?
  `);
  const selectAuditSources = connection.prepare(`
    SELECT source.ordinal, source.eligibility, source.inclusion_state,
      head.state AS head_state
    FROM research_sources AS source
    LEFT JOIN research_source_heads AS head ON head.source_id = source.id
    WHERE source.run_id = ?
    ORDER BY source.ordinal
  `);
  const selectAuditSnapshotStates = connection.prepare(`
    SELECT head.state
    FROM (
      SELECT 'page_context' AS kind, id FROM research_page_context_snapshots
        WHERE run_id = @runId
      UNION ALL
      SELECT 'resource_context', id FROM research_resource_context_snapshots
        WHERE run_id = @runId
      UNION ALL
      SELECT 'activity', id FROM research_activity_snapshots WHERE run_id = @runId
      UNION ALL
      SELECT 'relation', id FROM research_relation_snapshots WHERE run_id = @runId
    ) AS snapshot
    LEFT JOIN research_snapshot_heads AS head
      ON head.kind = snapshot.kind AND head.snapshot_id = snapshot.id
  `);
  const selectAuditReportStates = connection.prepare(`
    SELECT head.state
    FROM research_reports AS report
    LEFT JOIN research_report_heads AS head ON head.report_id = report.id
    WHERE report.run_id = @runId OR report.id = @parentReportId
    ORDER BY report.id
  `);

  function readParentProjection(run: Pick<RunRow,
  "parent_report_id" | "target_key">): ResearchExecutionParent | null {
    if (run.parent_report_id === null) return null;
    const parent = selectParent.get(run.parent_report_id) as ParentRow | undefined;
    if (parent === undefined) return mismatch("Research parent report does not exist");
    if (parent.privacy_bound === 1 || parent.state === "redacted") {
      return redacted("Research parent report was redacted");
    }
    if (parent.target_key !== run.target_key) {
      return mismatch("Research parent target does not match the run target");
    }
    if (parent.state === null || parent.state === "superseded" ||
        !((parent.publish_status === "succeeded" &&
            (parent.state === "fresh" || parent.state === "stale")) ||
          (parent.publish_status === "partial" && parent.state === "stale"))) {
      return mismatch("Research parent report is unavailable for execution");
    }
    if (parent.report_text === null || parent.structured_json === null ||
        parent.payload_digest === null) {
      return mismatch("Research parent report payload is missing");
    }
    const parsedDossier = researchDossierSchema.safeParse(parseJson(
      parent.structured_json, "Research parent dossier is invalid",
    ));
    if (!parsedDossier.success || canonicalJson(parsedDossier.data) !== parent.structured_json ||
        sha256(canonicalJson({
          text: parent.report_text,
          dossier: parsedDossier.data,
        })) !== parent.payload_digest) {
      return mismatch("Research parent report payload digest does not match");
    }
    const projection = {
      reportId: parent.id,
      reportVersion: parent.version,
      state: parent.state,
      reportText: parent.report_text,
      payloadDigest: parent.payload_digest,
    } as const;
    return { ...projection, digest: sha256(canonicalJson(projection)) };
  }

  const readForJobTransaction = connection.transaction((rawJobId: DurableJobId) => {
      const jobId = parseJobId(rawJobId);
      const run = selectRun.get(jobId) as RunRow | undefined;
      if (run === undefined) return mismatch("Approved research run does not exist");
      if (run.privacy_bound === 1) {
        return redacted("Research run is fenced by the privacy lifecycle");
      }
      if (run.question === null || run.payload_scope_json === null) {
        return mismatch("Approved research run payload is missing");
      }
      const selectionLogicalPageIds = (selectSelection.all(run.id) as
        Array<{ logical_page_id: number }>).map((row) => row.logical_page_id);
      const targetBranches = Number(run.target_logical_page_id !== null) +
        Number(run.target_resource_id !== null) + Number(run.target_selection === 1);
      if (targetBranches !== 1 || (run.target_selection !== 0 && run.target_selection !== 1)) {
        return mismatch("Research run target identity is invalid");
      }
      const target: ResearchApprovedDraft["target"] = run.target_logical_page_id !== null
        ? { type: "page", logicalPageId: run.target_logical_page_id }
        : run.target_resource_id !== null
          ? { type: "resource", resourceId: run.target_resource_id }
          : {
              type: "selection",
              logicalPageIds: selectionLogicalPageIds,
              fingerprint: run.selection_fingerprint ?? mismatch(
                "Research selection fingerprint is missing",
              ),
            };
      if (run.target_selection === 1) {
        const expected = sha256(researchSelectionFingerprintPayload(selectionLogicalPageIds));
        if (run.selection_fingerprint !== expected) {
          return mismatch("Research selection fingerprint does not match its pages");
        }
      } else if (selectionLogicalPageIds.length !== 0) {
        return mismatch("Non-selection research run contains selection pages");
      }
      const expectedTargetKey = target.type === "page" ? `page:${target.logicalPageId}`
        : target.type === "resource" ? `resource:${target.resourceId}`
          : `selection:${target.fingerprint}`;
      if (run.target_key !== expectedTargetKey || run.job_subject_key !== expectedTargetKey ||
          run.job_input_fingerprint !== run.approval_fingerprint ||
          run.job_workflow_id !== run.workflow_id ||
          run.job_workflow_version !== run.workflow_version ||
          run.job_max_steps !== run.max_steps || run.job_max_tokens !== run.max_tokens ||
          run.job_max_cost_usd !== run.max_cost_usd ||
          run.job_max_wall_time_ms !== run.max_wall_time_ms) {
        return mismatch("Research run does not match its durable job identity");
      }
      if (sha256(run.question) !== run.question_digest ||
          canonicalJson(parseJson(run.run_scope_json, "Research scope is invalid")) !==
            canonicalJson(parseJson(run.payload_scope_json, "Research payload scope is invalid"))) {
        return mismatch("Research run payload identity does not match its manifest");
      }

      const sourceRows = selectSources.all(run.id) as SourceRow[];
      const sourceIds = new Map<number, number>();
      const approvedSources: ResearchApprovedDraft["sources"] = sourceRows.map((source) => {
        sourceIds.set(source.ordinal, source.id);
        if (source.head_state === "redacted") {
          return redacted(`Research source ${source.id} was redacted`);
        }
        if (source.head_state !== "valid") {
          return mismatch(`Research source ${source.id} is not valid`);
        }
        const common = {
          sourceKind: source.source_kind,
          ordinal: source.ordinal,
          logicalPageId: source.logical_page_id,
          tabId: source.captured_tab_id_snapshot,
          selectedTabId: source.captured_tab_id_snapshot,
          contentRevision: source.content_revision,
          contentDigest: source.content_digest,
          extractedAt: source.extracted_at,
          acquisitionMethod: source.acquisition_method,
          accessClass: source.access_class_snapshot,
          eligibility: source.eligibility,
          inclusionState: source.inclusion_state,
          includedOrder: source.included_order,
          handoffSourceReceiptId: source.handoff_source_receipt_id,
          handoffSourceReceiptDigest: source.receipt_digest,
        };
        if (source.source_kind === "captured") {
          if (source.handoff_source_receipt_id !== null || source.receipt_digest !== null) {
            return mismatch(`Captured research source ${source.id} has a live receipt`);
          }
        } else if (source.handoff_source_receipt_id === null ||
            source.receipt_handoff_id === null || source.receipt_final_run_id !== run.id ||
            source.receipt_ordinal !== source.ordinal ||
            source.receipt_logical_page_id !== source.logical_page_id ||
            source.receipt_inclusion_state !== source.inclusion_state ||
            source.receipt_included_order !== source.included_order ||
            source.receipt_content_revision !== source.content_revision ||
            source.receipt_content_digest !== source.content_digest ||
            source.receipt_extracted_at !== source.extracted_at ||
            source.receipt_digest === null || source.handoff_status !== "completed" ||
            source.terminal_handoff_id !== source.receipt_handoff_id ||
            source.page_generation_subject_kind !== "logical_page" ||
            source.page_generation_logical_page_id !== source.logical_page_id) {
          return mismatch(`Live research source ${source.id} receipt is incomplete`);
        }
        if (source.inclusion_state === "included") {
          if (source.url_snapshot === null || source.title_snapshot === null ||
              source.evidence_material === null || source.chunk_manifest_json === null ||
              source.payload_digest === null) {
            return mismatch(`Research source ${source.id} payload is missing`);
          }
          if (source.payload_digest !== sha256(source.evidence_material)) {
            return mismatch(`Research source ${source.id} payload digest does not match`);
          }
          return {
            ...common,
            eligibility: "eligible",
            inclusionState: "included",
            payload: {
              url: source.url_snapshot,
              title: source.title_snapshot,
              evidenceMaterial: source.evidence_material,
              chunkManifest: parseJson(
                source.chunk_manifest_json,
                `Research source ${source.id} chunk manifest is invalid`,
              ),
            },
          } as ResearchApprovedDraft["sources"][number];
        }
        if (source.url_snapshot !== null || source.title_snapshot !== null ||
            source.evidence_material !== null || source.chunk_manifest_json !== null ||
            source.payload_digest !== null) {
          return mismatch(`Non-included research source ${source.id} has a payload`);
        }
        if (source.inclusion_state === "excluded") {
          return {
            ...common,
            inclusionState: "excluded",
            exclusionReason: source.exclusion_reason,
            payload: null,
          } as ResearchApprovedDraft["sources"][number];
        }
        return {
          ...common,
          contentRevision: null,
          contentDigest: null,
          extractedAt: null,
          eligibility: "not_captured",
          inclusionState: source.inclusion_state,
          failureCode: source.failure_code,
          includedOrder: null,
          payload: null,
        } as ResearchApprovedDraft["sources"][number];
      });
      const snapshotRows = selectSnapshots.all({ runId: run.id }) as SnapshotRow[];
      const snapshotIds = new Map<number, number>();
      const approvedSnapshots: ResearchSnapshotDraft[] = snapshotRows.map((snapshot, index) => {
        const ordinal = index + 1;
        snapshotIds.set(ordinal, snapshot.id);
        if (snapshot.accepted_event_id === null || snapshot.head_state === null) {
          return mismatch(`Research ${snapshot.kind} snapshot ${snapshot.id} has no state`);
        }
        if (snapshot.head_state === "redacted") {
          return redacted(`Research ${snapshot.kind} snapshot ${snapshot.id} was redacted`);
        }
        if (snapshot.head_state !== "valid") {
          return mismatch(`Research ${snapshot.kind} snapshot ${snapshot.id} is not valid`);
        }
        if (snapshot.material_json === null) {
          return mismatch(`Research ${snapshot.kind} snapshot ${snapshot.id} payload is missing`);
        }
        const material = parseJson(
          snapshot.material_json,
          `Research ${snapshot.kind} snapshot ${snapshot.id} payload is invalid`,
        );
        if (material === null || Array.isArray(material) || typeof material !== "object" ||
            sha256(canonicalJson(material)) !== snapshot.snapshot_digest) {
          return mismatch(`Research ${snapshot.kind} snapshot ${snapshot.id} digest does not match`);
        }
        const materialRecord = material as Record<string, unknown>;
        switch (snapshot.kind) {
          case "page_context":
            if (snapshot.context_entry_id === null || snapshot.logical_page_id === null) {
              return mismatch(`Research page-context snapshot ${snapshot.id} identity is invalid`);
            }
            return {
              kind: "page_context", ordinal, snapshotDigest: snapshot.snapshot_digest,
              contextEntryId: snapshot.context_entry_id,
              logicalPageId: snapshot.logical_page_id, material: materialRecord,
            };
          case "resource_context":
            if (snapshot.context_entry_id === null || snapshot.resource_id === null) {
              return mismatch(`Research resource-context snapshot ${snapshot.id} identity is invalid`);
            }
            return {
              kind: "resource_context", ordinal, snapshotDigest: snapshot.snapshot_digest,
              contextEntryId: snapshot.context_entry_id,
              resourceId: snapshot.resource_id, material: materialRecord,
            };
          case "activity":
            if (snapshot.logical_page_id === null || snapshot.activity_date === null) {
              return mismatch(`Research activity snapshot ${snapshot.id} identity is invalid`);
            }
            return {
              kind: "activity", ordinal, snapshotDigest: snapshot.snapshot_digest,
              logicalPageId: snapshot.logical_page_id,
              activityDate: snapshot.activity_date, material: materialRecord,
            };
          case "relation":
            if (snapshot.relation_id === null) {
              return mismatch(`Research relation snapshot ${snapshot.id} identity is invalid`);
            }
            return {
              kind: "relation", ordinal, snapshotDigest: snapshot.snapshot_digest,
              relationId: snapshot.relation_id, material: materialRecord,
            };
        }
      });
      const scope = parseJson(run.payload_scope_json, "Research payload scope is invalid");
      const storedDraft = researchApprovedDraftSchema.safeParse({
        version: 1 as const,
        target,
        question: run.question,
        scope,
        parentReportId: run.parent_report_id,
        approvalFingerprint: run.approval_fingerprint,
        corpusFingerprint: run.corpus_fingerprint,
        workflowRef: { id: run.workflow_id, version: run.workflow_version },
        budget: {
          maxSteps: run.max_steps,
          maxTokens: run.max_tokens,
          maxCostUsd: run.max_cost_usd,
          maxWallTimeMs: run.max_wall_time_ms,
        },
        estimate: estimateResearchReservationV1({
          includedSources: approvedSources.filter((source) =>
            source.inclusionState === "included").length,
          includedSourceBytes: approvedSources.reduce((total, source) => total +
            (source.inclusionState === "included" && source.payload !== null
              ? new TextEncoder().encode(source.payload.evidenceMaterial).byteLength
              : 0), 0),
          snapshotBytes: approvedSnapshots.reduce((total, snapshot) => total +
            researchCanonicalSha256PayloadV1(snapshot.material).byteLength, 0),
          questionBytes: new TextEncoder().encode(run.question).byteLength,
          budget: {
            maxSteps: run.max_steps,
            maxTokens: run.max_tokens,
            maxCostUsd: run.max_cost_usd,
            maxWallTimeMs: run.max_wall_time_ms,
          },
        }),
        sources: approvedSources,
        snapshots: approvedSnapshots,
      });
      if (!storedDraft.success) return mismatch("Stored research corpus violates its schema");
      const c81Approval = run.workflow_id === "research_workflow:c81:v1" &&
        run.workflow_version === 1;
      if ((!c81Approval &&
            fingerprintResearchApproval(storedDraft.data) !== run.approval_fingerprint) ||
          fingerprintResearchCorpus(storedDraft.data) !== run.corpus_fingerprint) {
        return mismatch("Stored research corpus fingerprint does not match");
      }

      const sources = storedDraft.data.sources.flatMap((source): ResearchCorpusSource[] => {
        const sourceId = sourceIds.get(source.ordinal) ??
          mismatch("Research source identity is missing");
        const materialized = materializeResearchCorpusSource(source, sourceId);
        return materialized === undefined ? [] : [materialized];
      }).sort((left, right) => left.includedOrder - right.includedOrder);

      const material = {
        version: 1 as const,
        jobId: rawJobId,
        runId: run.id,
        target: storedDraft.data.target,
        selectionLogicalPageIds,
        question: storedDraft.data.question,
        scope: storedDraft.data.scope,
        parentReportId: storedDraft.data.parentReportId,
        approvalFingerprint: storedDraft.data.approvalFingerprint,
        corpusFingerprint: storedDraft.data.corpusFingerprint,
        workflowRef: storedDraft.data.workflowRef,
        budget: storedDraft.data.budget,
        estimate: storedDraft.data.estimate,
        sources,
        snapshots: storedDraft.data.snapshots?.map((snapshot) => ({
          ...snapshot,
          snapshotId: snapshotIds.get(snapshot.ordinal) ?? mismatch(
            "Research snapshot identity is missing",
          ),
        })) ?? [],
      };
      const parent = readParentProjection(run);
      return {
        ...material,
        parent,
        corpusDigest: sha256(canonicalJson(material)),
      };
  });

  const readAuditForJobTransaction = connection.transaction((rawJobId: DurableJobId) => {
    const jobId = parseJobId(rawJobId);
    const run = selectAuditRun.get(jobId) as AuditRunRow | undefined;
    if (run === undefined) return mismatch("Approved research run does not exist");
    if (run.privacy_bound === 1) {
      return redacted("Research run is fenced by the privacy lifecycle");
    }
    const selectionLogicalPageIds = (selectSelection.all(run.id) as
      Array<{ logical_page_id: number }>).map((row) => row.logical_page_id);
    const targetBranches = Number(run.target_logical_page_id !== null) +
      Number(run.target_resource_id !== null) + Number(run.target_selection === 1);
    if (targetBranches !== 1 || (run.target_selection !== 0 && run.target_selection !== 1)) {
      return mismatch("Research audit target identity is invalid");
    }
    const target: ResearchApprovedDraft["target"] = run.target_logical_page_id !== null
      ? { type: "page", logicalPageId: run.target_logical_page_id }
      : run.target_resource_id !== null
        ? { type: "resource", resourceId: run.target_resource_id }
        : {
            type: "selection",
            logicalPageIds: selectionLogicalPageIds,
            fingerprint: run.selection_fingerprint ?? mismatch(
              "Research audit selection fingerprint is missing",
            ),
          };
    if (run.target_selection === 1) {
      const expected = sha256(researchSelectionFingerprintPayload(selectionLogicalPageIds));
      if (run.selection_fingerprint !== expected) {
        return mismatch("Research audit selection fingerprint does not match its pages");
      }
    } else if (selectionLogicalPageIds.length !== 0) {
      return mismatch("Non-selection research audit contains selection pages");
    }
    const expectedTargetKey = target.type === "page" ? `page:${target.logicalPageId}`
      : target.type === "resource" ? `resource:${target.resourceId}`
        : `selection:${target.fingerprint}`;
    if (run.target_key !== expectedTargetKey || run.job_subject_key !== expectedTargetKey) {
      return mismatch("Research audit does not match its durable job target");
    }
    if (!isDigest(run.corpus_fingerprint)) {
      return mismatch("Research audit corpus fingerprint is invalid");
    }

    const sources = selectAuditSources.all(run.id) as AuditSourceRow[];
    if (sources.some((source, index) => source.ordinal !== index + 1 ||
        source.head_state === null)) {
      return mismatch("Research audit source manifest is incomplete");
    }
    if (sources.some((source) => source.head_state === "redacted")) {
      return redacted("Research audit contains a redacted source");
    }
    const snapshotStates = selectAuditSnapshotStates.all({ runId: run.id }) as AuditStateRow[];
    if (snapshotStates.some((snapshot) => snapshot.state === null)) {
      return mismatch("Research audit snapshot manifest is incomplete");
    }
    if (snapshotStates.some((snapshot) => snapshot.state === "redacted")) {
      return redacted("Research audit contains a redacted snapshot");
    }
    const reportStates = selectAuditReportStates.all({
      runId: run.id,
      parentReportId: run.parent_report_id,
    }) as AuditStateRow[];
    if (reportStates.some((report) => report.state === null)) {
      return mismatch("Research audit report state is incomplete");
    }
    if (reportStates.some((report) => report.state === "redacted")) {
      return redacted("Research audit contains a redacted report");
    }

    const coverage: ResearchCoverage = {
      discovered: sources.length,
      captured: sources.filter((source) => source.inclusion_state === "included" ||
        source.inclusion_state === "excluded").length,
      eligible: sources.filter((source) => source.eligibility === "eligible").length,
      used: 0,
      missing: sources.filter((source) => source.inclusion_state === "missing").length,
      failed: sources.filter((source) => source.inclusion_state === "failed").length,
    };
    const audit = {
      version: 1 as const,
      jobId: rawJobId,
      runId: run.id,
      target,
      corpusFingerprint: run.corpus_fingerprint,
      coverage,
    };
    return { ...audit, digest: sha256(canonicalJson(audit)) };
  });

  return {
    readForJob(rawJobId) {
      // Corpus material and privacy redaction share one SQLite writer boundary.
      // An IMMEDIATE transaction prevents a completed redaction from racing a
      // stale WAL reader that could otherwise materialize deleted payload.
      return readForJobTransaction.immediate(rawJobId);
    },
    readAuditForJob(rawJobId) {
      return readAuditForJobTransaction.immediate(rawJobId);
    },
  };
}
