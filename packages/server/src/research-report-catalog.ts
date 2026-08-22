import { createHash } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  researchCanonicalSha256PayloadV1,
  researchCapturedTextChunkManifestSchema,
  researchCoverageSchema,
  researchDossierSchema,
  researchPublicationReasonSchema,
  researchPublicationProvenanceSchema,
  researchReportDetailSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  researchSelectionFingerprintPayload,
  researchUtf8RangeLocatorSchema,
  researchWholeSnapshotLocatorSchema,
  type ResearchClaimDraft,
  type ResearchCoverage,
  type ResearchLatestRun,
  type ResearchPublicationReason,
  type ResearchReportDetail,
  type ResearchReportHead,
  type ResearchReportListQuery,
  type ResearchReportListResponse,
  type ResearchTarget,
} from "@tabhub/shared";
import type Database from "better-sqlite3";

import { renderResearchReportText } from "./research-report-renderer.js";

export type ResearchReportCatalogErrorCode =
  | "RESEARCH_TARGET_NOT_FOUND"
  | "RESEARCH_REPORT_STORAGE_CORRUPT";

export class ResearchReportCatalogError extends Error {
  constructor(
    readonly code: ResearchReportCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchReportCatalogError";
  }
}

export interface ResearchReportCatalog {
  list(query: ResearchReportListQuery): ResearchReportListResponse;
  get(reportId: number): ResearchReportDetail | undefined;
}

interface ParseResult<T> {
  readonly success: boolean;
  readonly data?: T;
}

interface Parser<T> {
  safeParse(value: unknown): ParseResult<T>;
}

interface LatestRunRow {
  target_exists: number;
  run_id: number | null;
  job_id: number | null;
  target_logical_page_id: number | null;
  target_resource_id: number | null;
  target_selection: number | null;
  selection_fingerprint: string | null;
  target_key: string | null;
  parent_report_id: number | null;
  run_created_at: string | null;
  run_status: string | null;
  run_report_id: number | null;
  job_kind: string | null;
  job_subject_type: string | null;
  job_logical_page_id: number | null;
  job_resource_id: number | null;
  job_selection_fingerprint: string | null;
  job_subject_key: string | null;
  job_status: string | null;
  job_result_type: string | null;
  job_result_report_id: number | null;
  result_report_run_id: number | null;
  result_report_target_key: string | null;
}

interface SelectionPageRow {
  logical_page_id: number;
  selection_order: number;
}

interface DetailSelectionPageRow extends SelectionPageRow {
  report_id: number;
}

interface HeadRow {
  latest_published_report_id: number | null;
  current_fresh_report_id: number | null;
  last_successful_report_id: number | null;
  event_id: number | null;
  report_count: number;
  newest_report_id: number | null;
  latest_target_key: string | null;
  current_target_key: string | null;
  current_publish_status: string | null;
  current_state: string | null;
  successful_target_key: string | null;
  successful_publish_status: string | null;
  event_target_key: string | null;
}

interface SummaryRow {
  id: number;
  run_id: number;
  version: number;
  parent_report_id: number | null;
  publish_status: string;
  coverage_json: string;
  coverage_fingerprint: string;
  created_at: string;
  target_key: string;
  report_state: string | null;
  publication_reason: string | null;
  job_id: number | null;
  job_kind: string | null;
  job_subject_key: string | null;
  run_target_key: string | null;
  run_parent_report_id: number | null;
  report_text: string | null;
  structured_json: string | null;
  payload_digest: string | null;
  report_payload_present: number;
}

interface DetailRootRow {
  id: number;
  run_id: number;
  target_logical_page_id: number | null;
  target_resource_id: number | null;
  selection_fingerprint: string | null;
  target_key: string;
  version: number;
  parent_report_id: number | null;
  publish_status: string;
  coverage_json: string;
  coverage_fingerprint: string;
  provenance_json: string;
  input_fingerprint: string;
  created_at: string;
  report_state: string | null;
  publication_reason: string | null;
  run_job_id: number | null;
  run_target_logical_page_id: number | null;
  run_target_resource_id: number | null;
  run_target_selection: number | null;
  run_selection_fingerprint: string | null;
  run_target_key: string | null;
  run_approval_fingerprint: string | null;
  run_parent_report_id: number | null;
  run_status: string | null;
  run_report_id: number | null;
  job_kind: string | null;
  job_subject_type: string | null;
  job_logical_page_id: number | null;
  job_resource_id: number | null;
  job_selection_fingerprint: string | null;
  job_subject_key: string | null;
  job_input_fingerprint: string | null;
  job_status: string | null;
  job_result_type: string | null;
  job_result_report_id: number | null;
  page_exists: number;
  resource_exists: number;
  latest_published_report_id: number | null;
  current_fresh_report_id: number | null;
  last_successful_report_id: number | null;
  report_text: string | null;
  structured_json: string | null;
  payload_digest: string | null;
  report_payload_present: number;
  terminal_event_id: number | null;
  terminal_sequence_no: number | null;
  terminal_event_type: string | null;
  terminal_attempt_id: number | null;
  terminal_occurred_at: string | null;
  progress_event_id: number | null;
  spent_steps: number | null;
  spent_input_tokens: number | null;
  spent_output_tokens: number | null;
  spent_cost_usd: number | null;
  spent_wall_time_ms: number | null;
  attempt_job_id: number | null;
  attempt_outcome: string | null;
  attempt_provider: string | null;
  attempt_model: string | null;
  attempt_prompt_version: string | null;
  attempt_pricing_version: string | null;
  attempt_request_id: string | null;
  attempt_completed_at: string | null;
}

interface SourceRow {
  report_id: number;
  id: number;
  ordinal: number;
  logical_page_id: number;
  source_kind: "captured" | "live_acquisition";
  acquisition_method: "inventory" | "captured" | "exact_capture" | "safe_public_http_v1";
  captured_tab_id_snapshot: number | null;
  content_revision: number | null;
  content_digest: string | null;
  access_class_snapshot: string;
  eligibility: string;
  inclusion_state: string;
  included_order: number | null;
  source_state: string | null;
  used_order: number | null;
  url_snapshot: string | null;
  title_snapshot: string | null;
  evidence_material: string | null;
  chunk_manifest_json: string | null;
  source_payload_digest: string | null;
}

interface ClaimRow {
  report_id: number;
  id: number;
  ordinal: number;
  claim_digest: string;
  confidence: number;
  is_inference: number;
  rationale_digest: string | null;
  claim_text: string | null;
  inference_rationale: string | null;
  claim_payload_present: number;
}

interface EvidenceRow {
  id: number;
  claim_id: number;
  report_id: number;
  run_id: number;
  ordinal: number;
  kind: string;
  source_id: number | null;
  snapshot_id: number | null;
  locator_digest: string;
  excerpt_hash: string;
  evidence_state: string | null;
  evidence_reason: string | null;
  locator_json: string | null;
  evidence_payload_present: number;
  snapshot_run_id: number | null;
  snapshot_digest: string | null;
  snapshot_state: string | null;
  material_json: string | null;
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function validatePublicationReason(
  publishStatus: string,
  rawReason: string | null,
): ResearchPublicationReason | null {
  if (publishStatus === "succeeded") {
    if (rawReason !== null) return corrupt("Successful research report has a partial reason");
    return null;
  }
  if (publishStatus !== "partial") {
    return corrupt("Research report has an invalid publication status");
  }
  const parsed = researchPublicationReasonSchema.safeParse(rawReason);
  if (!parsed.success) return corrupt("Partial research report has no valid reason");
  return parsed.data;
}

function corrupt(message = "Research report storage is corrupt"): never {
  throw new ResearchReportCatalogError("RESEARCH_REPORT_STORAGE_CORRUPT", message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCanonicalJson<T>(raw: unknown, parser: Parser<T>, label: string): T {
  if (typeof raw !== "string") return corrupt(`Missing ${label}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return corrupt(`Invalid ${label}`);
  }
  const parsed = parser.safeParse(decoded);
  if (!parsed.success || parsed.data === undefined || canonicalJson(parsed.data) !== raw) {
    return corrupt(`Non-canonical ${label}`);
  }
  return parsed.data;
}

function parseCanonicalObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "string") return corrupt(`Missing ${label}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return corrupt(`Invalid ${label}`);
  }
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object" ||
      canonicalJson(decoded) !== raw) {
    return corrupt(`Non-canonical ${label}`);
  }
  return decoded as Record<string, unknown>;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function targetKey(query: ResearchReportListQuery): string {
  return query.targetType === "selection"
    ? `selection:${query.targetId}`
    : `${query.targetType}:${query.targetId}`;
}

function reconstructTarget(
  row: Pick<LatestRunRow, "target_logical_page_id" | "target_resource_id" |
    "target_selection" | "selection_fingerprint" | "target_key">,
  selectionRows: readonly SelectionPageRow[],
): ResearchTarget {
  if (row.target_logical_page_id !== null && row.target_resource_id === null &&
      row.target_selection === 0 && row.selection_fingerprint === null &&
      row.target_key === `page:${row.target_logical_page_id}`) {
    if (selectionRows.length !== 0) return corrupt("Page run has selection members");
    return { type: "page", logicalPageId: row.target_logical_page_id };
  }
  if (row.target_logical_page_id === null && row.target_resource_id !== null &&
      row.target_selection === 0 && row.selection_fingerprint === null &&
      row.target_key === `resource:${row.target_resource_id}`) {
    if (selectionRows.length !== 0) return corrupt("Resource run has selection members");
    return { type: "resource", resourceId: row.target_resource_id };
  }
  if (row.target_logical_page_id === null && row.target_resource_id === null &&
      row.target_selection === 1 && row.selection_fingerprint !== null &&
      row.target_key === `selection:${row.selection_fingerprint}`) {
    if (selectionRows.length === 0 || selectionRows.some((entry, index) =>
        entry.selection_order !== index + 1) ||
        new Set(selectionRows.map((entry) => entry.logical_page_id)).size !==
          selectionRows.length) {
      return corrupt("Selection membership is invalid");
    }
    const logicalPageIds = selectionRows.map((entry) => entry.logical_page_id);
    const fingerprint = sha256(researchSelectionFingerprintPayload(logicalPageIds));
    if (fingerprint !== row.selection_fingerprint) {
      return corrupt("Selection fingerprint does not match membership");
    }
    return { type: "selection", logicalPageIds, fingerprint };
  }
  return corrupt("Research target identity is invalid");
}

function validateHead(row: HeadRow, key: string): ResearchReportHead {
  if (!Number.isSafeInteger(row.report_count) || row.report_count < 0) {
    return corrupt("Report count is invalid");
  }
  const hasHead = row.event_id !== null;
  if (row.report_count === 0) {
    if (hasHead || row.latest_published_report_id !== null ||
        row.current_fresh_report_id !== null || row.last_successful_report_id !== null ||
        row.newest_report_id !== null) {
      return corrupt("Empty report history has a target head");
    }
  } else {
    if (!hasHead || row.latest_published_report_id === null ||
        row.latest_published_report_id !== row.newest_report_id ||
        row.latest_target_key !== key || row.event_target_key !== key) {
      return corrupt("Research target head is inconsistent");
    }
    if (row.current_fresh_report_id !== null &&
        (row.current_target_key !== key || row.current_publish_status !== "succeeded" ||
          row.current_state !== "fresh")) {
      return corrupt("Current-fresh research head is inconsistent");
    }
    if (row.last_successful_report_id !== null &&
        (row.successful_target_key !== key || row.successful_publish_status !== "succeeded")) {
      return corrupt("Last-successful research head is inconsistent");
    }
  }
  return {
    latestPublishedReportId: row.latest_published_report_id,
    currentFreshReportId: row.current_fresh_report_id,
    lastSuccessfulReportId: row.last_successful_report_id,
  };
}

function validateLatestRun(row: LatestRunRow, key: string): ResearchLatestRun | null {
  if (row.run_id === null) return null;
  if (row.job_id === null || row.target_key !== key || row.run_status === null ||
      row.job_kind !== "resource_research" || row.job_subject_key !== key ||
      row.job_status !== row.run_status) {
    return corrupt("Latest research run is inconsistent with its job");
  }
  const published = row.run_status === "succeeded" || row.run_status === "partial";
  if (published !== (row.run_report_id !== null) || row.job_result_report_id !== row.run_report_id ||
      (published ? row.job_result_type !== "research_report" :
        row.job_result_type !== null || row.job_result_report_id !== null) ||
      (published && (row.result_report_run_id !== row.run_id ||
        row.result_report_target_key !== key))) {
    return corrupt("Latest research run report identity is inconsistent");
  }
  if (row.target_logical_page_id !== row.job_logical_page_id ||
      row.target_resource_id !== row.job_resource_id ||
      row.selection_fingerprint !== row.job_selection_fingerprint ||
      (row.target_logical_page_id !== null && row.job_subject_type !== "page") ||
      (row.target_resource_id !== null && row.job_subject_type !== "resource") ||
      (row.target_selection === 1 && row.job_subject_type !== "selection")) {
    return corrupt("Latest research run target differs from its job");
  }
  return {
    runId: row.run_id,
    jobId: `resource_research:${row.job_id}`,
    status: row.run_status as ResearchLatestRun["status"],
    parentReportId: row.parent_report_id,
    reportId: row.run_report_id,
    createdAt: row.run_created_at!,
  };
}

export function createResearchReportCatalog(
  connection: Database.Database,
): ResearchReportCatalog {
  const supportsLiveAcquisition =
    (connection.pragma("user_version", { simple: true }) as number) >= 25;
  const sourceProvenanceProjection = supportsLiveAcquisition
    ? "source.source_kind, source.acquisition_method"
    : "'captured' AS source_kind, source.acquisition_method";
  const selectLatestRun = connection.prepare(`
    WITH latest AS (
      SELECT * FROM research_runs WHERE target_key = @targetKey
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    SELECT
      CASE @targetType
        WHEN 'page' THEN EXISTS(SELECT 1 FROM logical_pages WHERE id = @numericTargetId)
        WHEN 'resource' THEN EXISTS(SELECT 1 FROM resources WHERE id = @numericTargetId)
        ELSE EXISTS(SELECT 1 FROM research_runs WHERE target_key = @targetKey)
      END AS target_exists,
      run.id AS run_id, run.job_id, run.target_logical_page_id,
      run.target_resource_id, run.target_selection, run.selection_fingerprint,
      run.target_key, run.parent_report_id, run.created_at AS run_created_at,
      run_head.status AS run_status, run_head.report_id AS run_report_id,
      job.kind AS job_kind, job.subject_type AS job_subject_type,
      job.logical_page_id AS job_logical_page_id, job.resource_id AS job_resource_id,
      job.selection_fingerprint AS job_selection_fingerprint,
      job.subject_key AS job_subject_key, job.status AS job_status,
      job.result_type AS job_result_type, job.result_report_id AS job_result_report_id,
      result_report.run_id AS result_report_run_id,
      result_report.target_key AS result_report_target_key
    FROM (SELECT 1) AS singleton
    LEFT JOIN latest AS run ON 1 = 1
    LEFT JOIN research_run_heads AS run_head ON run_head.run_id = run.id
    LEFT JOIN ai_jobs AS job ON job.id = run.job_id
    LEFT JOIN research_reports AS result_report ON result_report.id = job.result_report_id
  `);
  const selectSelectionPages = connection.prepare(`
    SELECT logical_page_id, selection_order
    FROM research_run_selection_pages WHERE run_id = ? ORDER BY selection_order
  `);
  const selectHead = connection.prepare(`
    SELECT head.latest_published_report_id, head.current_fresh_report_id,
      head.last_successful_report_id, head.event_id,
      (SELECT COUNT(*) FROM research_reports WHERE target_key = @targetKey) AS report_count,
      (SELECT id FROM research_reports WHERE target_key = @targetKey
        ORDER BY version DESC LIMIT 1) AS newest_report_id,
      latest.target_key AS latest_target_key,
      current.target_key AS current_target_key,
      current.publish_status AS current_publish_status,
      current_state.state AS current_state,
      successful.target_key AS successful_target_key,
      successful.publish_status AS successful_publish_status,
      event_report.target_key AS event_target_key
    FROM (SELECT 1) AS singleton
    LEFT JOIN research_target_heads AS head ON head.target_key = @targetKey
    LEFT JOIN research_reports AS latest ON latest.id = head.latest_published_report_id
    LEFT JOIN research_reports AS current ON current.id = head.current_fresh_report_id
    LEFT JOIN research_report_heads AS current_state ON current_state.report_id = current.id
    LEFT JOIN research_reports AS successful ON successful.id = head.last_successful_report_id
    LEFT JOIN research_report_state_events AS event ON event.id = head.event_id
    LEFT JOIN research_reports AS event_report ON event_report.id = event.report_id
  `);
  const selectSummaries = connection.prepare(`
    SELECT report.id, report.run_id, report.version, report.parent_report_id,
      report.publish_status, report.coverage_json, report.coverage_fingerprint,
      report.created_at, report.target_key, report_head.state AS report_state,
      published_event.reason AS publication_reason,
      run.job_id, run.target_key AS run_target_key,
      run.parent_report_id AS run_parent_report_id,
      job.kind AS job_kind, job.subject_key AS job_subject_key,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.report_text END
        AS report_text,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.structured_json END
        AS structured_json,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.payload_digest END
        AS payload_digest,
      payload.report_id IS NOT NULL AS report_payload_present
    FROM research_reports AS report
    LEFT JOIN research_report_heads AS report_head ON report_head.report_id = report.id
    LEFT JOIN research_report_state_events AS published_event
      ON published_event.report_id = report.id
      AND published_event.sequence_no = 1
      AND published_event.event_type = 'published'
    LEFT JOIN research_runs AS run ON run.id = report.run_id
    LEFT JOIN ai_jobs AS job ON job.id = run.job_id
    LEFT JOIN research_report_payloads AS payload ON payload.report_id = report.id
    WHERE report.target_key = @targetKey
      AND (@beforeVersion IS NULL OR report.version < @beforeVersion)
    ORDER BY report.version DESC LIMIT @probeLimit
  `);
  const selectDetailRoot = connection.prepare(`
    SELECT report.id, report.run_id, report.target_logical_page_id,
      report.target_resource_id, report.selection_fingerprint, report.target_key,
      report.version, report.parent_report_id, report.publish_status,
      report.coverage_json, report.coverage_fingerprint, report.provenance_json,
      report.input_fingerprint, report.created_at,
      report_head.state AS report_state,
      published_event.reason AS publication_reason,
      run.job_id AS run_job_id,
      run.target_logical_page_id AS run_target_logical_page_id,
      run.target_resource_id AS run_target_resource_id,
      run.target_selection AS run_target_selection,
      run.selection_fingerprint AS run_selection_fingerprint,
      run.target_key AS run_target_key,
      run.approval_fingerprint AS run_approval_fingerprint,
      run.parent_report_id AS run_parent_report_id,
      run_head.status AS run_status, run_head.report_id AS run_report_id,
      job.kind AS job_kind, job.subject_type AS job_subject_type,
      job.logical_page_id AS job_logical_page_id, job.resource_id AS job_resource_id,
      job.selection_fingerprint AS job_selection_fingerprint,
      job.subject_key AS job_subject_key, job.input_fingerprint AS job_input_fingerprint,
      job.status AS job_status, job.result_type AS job_result_type,
      job.result_report_id AS job_result_report_id,
      EXISTS(SELECT 1 FROM logical_pages WHERE id = report.target_logical_page_id) AS page_exists,
      EXISTS(SELECT 1 FROM resources WHERE id = report.target_resource_id) AS resource_exists,
      target_head.latest_published_report_id, target_head.current_fresh_report_id,
      target_head.last_successful_report_id,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.report_text END
        AS report_text,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.structured_json END
        AS structured_json,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.payload_digest END
        AS payload_digest,
      payload.report_id IS NOT NULL AS report_payload_present,
      terminal.id AS terminal_event_id, terminal.sequence_no AS terminal_sequence_no,
      terminal.event_type AS terminal_event_type,
      terminal.attempt_id AS terminal_attempt_id,
      terminal.occurred_at AS terminal_occurred_at,
      progress.id AS progress_event_id, progress.spent_steps,
      progress.spent_input_tokens, progress.spent_output_tokens,
      progress.spent_cost_usd, progress.spent_wall_time_ms,
      attempt.job_id AS attempt_job_id, attempt.outcome AS attempt_outcome,
      attempt.provider AS attempt_provider, attempt.model AS attempt_model,
      attempt.prompt_version AS attempt_prompt_version,
      attempt.pricing_version AS attempt_pricing_version,
      attempt.request_id AS attempt_request_id,
      attempt.completed_at AS attempt_completed_at
    FROM research_reports AS report
    LEFT JOIN research_report_heads AS report_head ON report_head.report_id = report.id
    LEFT JOIN research_report_state_events AS published_event
      ON published_event.report_id = report.id
      AND published_event.sequence_no = 1
      AND published_event.event_type = 'published'
    LEFT JOIN research_runs AS run ON run.id = report.run_id
    LEFT JOIN research_run_heads AS run_head ON run_head.run_id = run.id
    LEFT JOIN ai_jobs AS job ON job.id = run.job_id
    LEFT JOIN research_target_heads AS target_head ON target_head.target_key = report.target_key
    LEFT JOIN research_report_payloads AS payload ON payload.report_id = report.id
    LEFT JOIN ai_job_events AS terminal
      ON terminal.job_id = job.id
      AND terminal.result_type = 'research_report'
      AND terminal.result_report_id = report.id
      AND terminal.event_type IN ('succeeded', 'partial')
    LEFT JOIN ai_job_events AS progress
      ON progress.job_id = terminal.job_id
      AND progress.sequence_no = terminal.sequence_no - 1
      AND progress.event_type = 'progress'
      AND progress.attempt_id = terminal.attempt_id
      AND progress.occurred_at = terminal.occurred_at
    LEFT JOIN ai_job_attempts AS attempt
      ON attempt.id = terminal.attempt_id AND attempt.job_id = terminal.job_id
    WHERE report.id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(@reportIds)
    )
    ORDER BY report.id
  `);
  const selectDetailSelectionPages = connection.prepare(`
    SELECT report.id AS report_id, selection.logical_page_id, selection.selection_order
    FROM research_reports AS report
    JOIN research_run_selection_pages AS selection ON selection.run_id = report.run_id
    WHERE report.id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(@reportIds)
    )
    ORDER BY report.id, selection.selection_order
  `);
  const selectSources = connection.prepare(`
    SELECT report.id AS report_id, source.id, source.ordinal, source.logical_page_id,
      ${sourceProvenanceProjection},
      source.captured_tab_id_snapshot, source.content_revision, source.content_digest,
      source.access_class_snapshot, source.eligibility, source.inclusion_state,
      source.included_order, source_head.state AS source_state,
      used.used_order,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.url_snapshot END
        AS url_snapshot,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.title_snapshot END
        AS title_snapshot,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.evidence_material END
        AS evidence_material,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.chunk_manifest_json END
        AS chunk_manifest_json,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.payload_digest END
        AS source_payload_digest
    FROM research_reports AS report
    JOIN research_sources AS source ON source.run_id = report.run_id
    LEFT JOIN research_report_heads AS report_head ON report_head.report_id = report.id
    LEFT JOIN research_source_heads AS source_head ON source_head.source_id = source.id
    LEFT JOIN research_report_sources AS used
      ON used.report_id = report.id AND used.source_id = source.id
    LEFT JOIN research_source_payloads AS payload ON payload.source_id = source.id
    WHERE report.id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(@reportIds)
    )
    ORDER BY report.id, source.ordinal
  `);
  const selectClaims = connection.prepare(`
    SELECT claim.report_id, claim.id, claim.ordinal, claim.claim_digest, claim.confidence,
      claim.is_inference, claim.rationale_digest,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.claim_text END
        AS claim_text,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE payload.inference_rationale END
        AS inference_rationale,
      payload.claim_id IS NOT NULL AS claim_payload_present
    FROM research_claims AS claim
    LEFT JOIN research_report_heads AS report_head ON report_head.report_id = claim.report_id
    LEFT JOIN research_claim_payloads AS payload ON payload.claim_id = claim.id
    WHERE claim.report_id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(@reportIds)
    )
    ORDER BY claim.report_id, claim.ordinal
  `);
  const selectEvidence = connection.prepare(`
    SELECT evidence.id, evidence.claim_id, evidence.report_id, evidence.run_id,
      evidence.ordinal, evidence.kind, evidence.source_id,
      COALESCE(evidence.page_context_snapshot_id,
        evidence.resource_context_snapshot_id, evidence.activity_snapshot_id,
        evidence.relation_snapshot_id) AS snapshot_id,
      evidence.locator_digest, evidence.excerpt_hash,
      evidence_head.state AS evidence_state,
      evidence_event.reason AS evidence_reason,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE evidence_payload.locator_json END
        AS locator_json,
      evidence_payload.evidence_id IS NOT NULL AS evidence_payload_present,
      COALESCE(page_snapshot.run_id, resource_snapshot.run_id,
        activity_snapshot.run_id, relation_snapshot.run_id) AS snapshot_run_id,
      COALESCE(page_snapshot.snapshot_digest, resource_snapshot.snapshot_digest,
        activity_snapshot.snapshot_digest, relation_snapshot.snapshot_digest) AS snapshot_digest,
      snapshot_head.state AS snapshot_state,
      CASE WHEN report_head.state = 'redacted' THEN NULL ELSE snapshot_payload.material_json END
        AS material_json
    FROM research_claim_evidence AS evidence
    JOIN research_claims AS claim
      ON claim.id = evidence.claim_id AND claim.report_id = evidence.report_id
    LEFT JOIN research_report_heads AS report_head ON report_head.report_id = evidence.report_id
    LEFT JOIN research_evidence_heads AS evidence_head
      ON evidence_head.evidence_id = evidence.id
    LEFT JOIN research_evidence_state_events AS evidence_event
      ON evidence_event.id = evidence_head.event_id
    LEFT JOIN research_evidence_payloads AS evidence_payload
      ON evidence_payload.evidence_id = evidence.id
    LEFT JOIN research_page_context_snapshots AS page_snapshot
      ON evidence.kind = 'page_context'
      AND page_snapshot.id = evidence.page_context_snapshot_id
      AND page_snapshot.run_id = evidence.run_id
    LEFT JOIN research_resource_context_snapshots AS resource_snapshot
      ON evidence.kind = 'resource_context'
      AND resource_snapshot.id = evidence.resource_context_snapshot_id
      AND resource_snapshot.run_id = evidence.run_id
    LEFT JOIN research_activity_snapshots AS activity_snapshot
      ON evidence.kind = 'activity'
      AND activity_snapshot.id = evidence.activity_snapshot_id
      AND activity_snapshot.run_id = evidence.run_id
    LEFT JOIN research_relation_snapshots AS relation_snapshot
      ON evidence.kind = 'relation'
      AND relation_snapshot.id = evidence.relation_snapshot_id
      AND relation_snapshot.run_id = evidence.run_id
    LEFT JOIN research_snapshot_heads AS snapshot_head
      ON snapshot_head.kind = evidence.kind
      AND snapshot_head.snapshot_id = COALESCE(evidence.page_context_snapshot_id,
        evidence.resource_context_snapshot_id, evidence.activity_snapshot_id,
        evidence.relation_snapshot_id)
    LEFT JOIN research_snapshot_payloads AS snapshot_payload
      ON snapshot_payload.kind = evidence.kind
      AND snapshot_payload.snapshot_id = COALESCE(evidence.page_context_snapshot_id,
        evidence.resource_context_snapshot_id, evidence.activity_snapshot_id,
        evidence.relation_snapshot_id)
    WHERE evidence.report_id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(@reportIds)
    )
    ORDER BY evidence.report_id, claim.ordinal, evidence.ordinal
  `);

  function selectionRows(runId: number | null): SelectionPageRow[] {
    return selectSelectionPages.all(runId ?? 0) as SelectionPageRow[];
  }

  function headFor(key: string): ResearchReportHead {
    const row = selectHead.get({ targetKey: key }) as HeadRow | undefined;
    if (row === undefined) return corrupt("Missing target-head projection");
    return validateHead(row, key);
  }

  function list(queryValue: ResearchReportListQuery): ResearchReportListResponse {
    const parsed = researchReportListQuerySchema.safeParse(queryValue);
    if (!parsed.success || parsed.data === undefined) {
      return corrupt("Invalid parsed research report list query");
    }
    const query = parsed.data;
    const key = targetKey(query);
    const latestRow = selectLatestRun.get({
      targetKey: key,
      targetType: query.targetType,
      numericTargetId: query.targetType === "selection" ? null : query.targetId,
    }) as LatestRunRow | undefined;
    if (latestRow === undefined) return corrupt("Missing latest-run projection");
    if (latestRow.target_exists !== 1) {
      throw new ResearchReportCatalogError("RESEARCH_TARGET_NOT_FOUND", "Research target not found");
    }
    const selections = selectionRows(latestRow.run_id);
    const target: ResearchTarget = latestRow.run_id === null
      ? query.targetType === "page"
        ? { type: "page", logicalPageId: query.targetId }
        : query.targetType === "resource"
          ? { type: "resource", resourceId: query.targetId }
          : corrupt("Selection target has no run")
      : reconstructTarget(latestRow, selections);
    if (target.type !== query.targetType ||
        (target.type === "page" && target.logicalPageId !== query.targetId) ||
        (target.type === "resource" && target.resourceId !== query.targetId) ||
        (target.type === "selection" && target.fingerprint !== query.targetId)) {
      return corrupt("List target does not match its latest run");
    }
    const latestRun = validateLatestRun(latestRow, key);
    const head = headFor(key);
    const rows = selectSummaries.all({
      targetKey: key,
      beforeVersion: query.beforeVersion ?? null,
      probeLimit: query.limit + 1,
    }) as SummaryRow[];
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const validatedDetails = loadValidatedReports(
      selected.map((row) => row.id),
      new Map([[key, head]]),
    );
    const items = selected.map((row, index) => {
      const detail = validatedDetails[index];
      if (detail === undefined || detail.id !== row.id || detail.runId !== row.run_id ||
          detail.version !== row.version || detail.parentReportId !== row.parent_report_id ||
          detail.publishStatus !== row.publish_status || detail.state !== row.report_state ||
          detail.createdAt !== row.created_at || !exactJsonEqual(detail.coverage,
            parseCanonicalJson(row.coverage_json, researchCoverageSchema, "report coverage"))) {
        return corrupt("Research report summary differs from validated detail");
      }
      if (row.target_key !== key || row.report_state === null || row.job_id === null ||
          row.job_kind !== "resource_research" || row.job_subject_key !== key ||
          row.run_target_key !== key || row.run_parent_report_id !== row.parent_report_id ||
          (index > 0 && selected[index - 1]!.version <= row.version)) {
        return corrupt("Research report summary identity is inconsistent");
      }
      const coverage = detail.coverage;
      if (sha256(row.coverage_json) !== row.coverage_fingerprint) {
        return corrupt("Research report coverage digest is invalid");
      }
      const redacted = row.report_state === "redacted";
      let executiveSummary: string | null = null;
      if (redacted) {
        if (row.report_payload_present === 1) {
          return corrupt("Redacted report retained its report payload");
        }
      } else {
        const dossier = parseCanonicalJson(
          row.structured_json, researchDossierSchema, "report dossier",
        );
        if (row.report_text === null || row.payload_digest === null ||
            sha256(canonicalJson({ text: row.report_text, dossier })) !== row.payload_digest) {
          return corrupt("Research report payload digest is invalid");
        }
        executiveSummary = dossier.executiveSummary;
        if (detail.dossier === null ||
            detail.dossier.executiveSummary !== executiveSummary) {
          return corrupt("Research report summary dossier differs from detail");
        }
      }
      return {
        id: row.id,
        runId: row.run_id,
        jobId: `resource_research:${row.job_id}`,
        version: row.version,
        parentReportId: row.parent_report_id,
        publishStatus: row.publish_status,
        reason: validatePublicationReason(row.publish_status, row.publication_reason),
        state: row.report_state,
        coverage,
        createdAt: row.created_at,
        executiveSummary,
        headFlags: {
          isLatestPublished: head.latestPublishedReportId === row.id,
          isCurrentFresh: head.currentFreshReportId === row.id,
          isLastSuccessful: head.lastSuccessfulReportId === row.id,
        },
      };
    });
    const response = {
      target,
      head,
      latestRun,
      items,
      nextBeforeVersion: hasMore ? selected.at(-1)?.version ?? null : null,
    };
    const valid = researchReportListResponseSchema.safeParse(response);
    if (!valid.success || valid.data === undefined) {
      return corrupt("Research report list response is invalid");
    }
    return valid.data;
  }

  function validateDetailProjection(
    row: DetailRootRow,
    selections: readonly SelectionPageRow[],
    sources: readonly SourceRow[],
    claimRows: readonly ClaimRow[],
    evidenceRows: readonly EvidenceRow[],
    head: ResearchReportHead,
  ): ResearchReportDetail {
    const target = reconstructTarget({
      target_logical_page_id: row.target_logical_page_id,
      target_resource_id: row.target_resource_id,
      target_selection: row.selection_fingerprint === null ? 0 : 1,
      selection_fingerprint: row.selection_fingerprint,
      target_key: row.target_key,
    }, selections);
    const runTarget = reconstructTarget({
      target_logical_page_id: row.run_target_logical_page_id,
      target_resource_id: row.run_target_resource_id,
      target_selection: row.run_target_selection,
      selection_fingerprint: row.run_selection_fingerprint,
      target_key: row.run_target_key,
    }, selections);
    if (!exactJsonEqual(target, runTarget) ||
        (target.type === "page" && row.page_exists !== 1) ||
        (target.type === "resource" && row.resource_exists !== 1)) {
      return corrupt("Research report target is missing or inconsistent");
    }
    if (row.report_state === null || row.run_job_id === null ||
        row.run_target_key !== row.target_key ||
        row.run_approval_fingerprint !== row.input_fingerprint ||
        row.run_parent_report_id !== row.parent_report_id ||
        row.run_status !== row.publish_status || row.run_report_id !== row.id ||
        row.job_kind !== "resource_research" || row.job_subject_key !== row.target_key ||
        row.job_input_fingerprint !== row.input_fingerprint ||
        row.job_status !== row.publish_status || row.job_result_type !== "research_report" ||
        row.job_result_report_id !== row.id ||
        row.job_logical_page_id !== row.target_logical_page_id ||
        row.job_resource_id !== row.target_resource_id ||
        row.job_selection_fingerprint !== row.selection_fingerprint ||
        (target.type === "page" && row.job_subject_type !== "page") ||
        (target.type === "resource" && row.job_subject_type !== "resource") ||
        (target.type === "selection" && row.job_subject_type !== "selection")) {
      return corrupt("Research report run/job identity is inconsistent");
    }
    if (row.terminal_event_id === null || row.terminal_attempt_id === null ||
        row.progress_event_id === null || row.attempt_job_id !== row.run_job_id ||
        row.terminal_event_type !== row.publish_status ||
        row.terminal_occurred_at !== row.created_at ||
        row.attempt_outcome !== row.publish_status ||
        row.attempt_completed_at !== row.created_at ||
        row.attempt_provider === null || row.attempt_model === null ||
        row.attempt_prompt_version === null || row.attempt_pricing_version === null ||
        row.spent_steps === null || row.spent_input_tokens === null ||
        row.spent_output_tokens === null || row.spent_cost_usd === null ||
        row.spent_wall_time_ms === null) {
      return corrupt("Research report terminal attempt chain is incomplete");
    }
    const coverage = parseCanonicalJson(
      row.coverage_json, researchCoverageSchema, "report coverage",
    );
    if (sha256(row.coverage_json) !== row.coverage_fingerprint) {
      return corrupt("Research report coverage digest is invalid");
    }
    const storedProvenance = parseCanonicalJson(
      row.provenance_json, researchPublicationProvenanceSchema, "report provenance",
    );
    const cumulativeUsage = {
      steps: row.spent_steps,
      inputTokens: row.spent_input_tokens,
      outputTokens: row.spent_output_tokens,
      costUsd: row.spent_cost_usd,
      wallTimeMs: row.spent_wall_time_ms,
    };
    if (storedProvenance.provider !== row.attempt_provider ||
        storedProvenance.model !== row.attempt_model ||
        storedProvenance.promptVersion !== row.attempt_prompt_version ||
        storedProvenance.pricingVersion !== row.attempt_pricing_version ||
        storedProvenance.requestId !== row.attempt_request_id ||
        storedProvenance.generatedAt !== row.created_at ||
        !exactJsonEqual(storedProvenance.usage, cumulativeUsage)) {
      return corrupt("Research report provenance differs from its terminal attempt");
    }
    const redacted = row.report_state === "redacted";
    if (sources.some((source, index) => source.report_id !== row.id ||
        source.ordinal !== index + 1 ||
        source.source_state === null)) {
      return corrupt("Research source manifest is incomplete");
    }
    const used = sources.filter((source) => source.used_order !== null)
      .sort((left, right) => left.used_order! - right.used_order!);
    if (used.some((source, index) => source.used_order !== index + 1 ||
        source.inclusion_state !== "included" ||
        (index > 0 && used[index - 1]!.id >= source.id))) {
      return corrupt("Research report source order is inconsistent");
    }
    const derivedCoverage: ResearchCoverage = {
      discovered: sources.length,
      captured: sources.filter((source) =>
        source.inclusion_state === "included" || source.inclusion_state === "excluded").length,
      eligible: sources.filter((source) => source.eligibility === "eligible").length,
      used: used.length,
      missing: sources.filter((source) => source.inclusion_state === "missing").length,
      failed: sources.filter((source) => source.inclusion_state === "failed").length,
    };
    if (!exactJsonEqual(coverage, derivedCoverage)) {
      return corrupt("Research report coverage differs from its corpus");
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    if (!redacted) {
      for (const source of sources) {
        const hasCapturedMaterial = source.inclusion_state === "included";
        if (!hasCapturedMaterial) {
          if (source.url_snapshot !== null || source.title_snapshot !== null ||
              source.evidence_material !== null || source.chunk_manifest_json !== null ||
              source.source_payload_digest !== null) {
            return corrupt("Uncaptured research source has payload material");
          }
          continue;
        }
        const sourceIdentityIsInvalid = source.source_kind === "live_acquisition"
          ? source.captured_tab_id_snapshot !== null ||
            source.acquisition_method !== "safe_public_http_v1"
          : source.captured_tab_id_snapshot === null ||
            source.acquisition_method === "safe_public_http_v1";
        if (sourceIdentityIsInvalid || source.content_revision === null ||
            source.content_digest === null || source.url_snapshot === null ||
            source.title_snapshot === null || source.evidence_material === null ||
            source.source_payload_digest === null) {
          return corrupt("Included research source payload is incomplete");
        }
        const chunk = parseCanonicalJson(
          source.chunk_manifest_json,
          researchCapturedTextChunkManifestSchema,
          "source chunk manifest",
        );
        const materialBytes = Buffer.from(source.evidence_material, "utf8");
        if (chunk.byteEnd !== materialBytes.byteLength ||
            chunk.chunkDigest !== sha256(materialBytes) ||
            source.source_payload_digest !== sha256(materialBytes)) {
          return corrupt("Captured research source digest is invalid");
        }
      }
    }
    const evidenceSourceIds = [...new Set(evidenceRows
      .filter((evidence) => evidence.kind === "tab_content")
      .map((evidence) => evidence.source_id))]
      .sort((left, right) => (left ?? 0) - (right ?? 0));
    if (evidenceSourceIds.some((sourceId) => sourceId === null) ||
        !exactJsonEqual(evidenceSourceIds, used.map((source) => source.id))) {
      return corrupt("Research report used-source identity differs from evidence");
    }
    const evidenceByClaim = new Map<number, EvidenceRow[]>();
    for (const evidence of evidenceRows) {
      if (evidence.report_id !== row.id || evidence.run_id !== row.run_id ||
          evidence.evidence_state === null) {
        return corrupt("Research evidence identity is inconsistent");
      }
      const values = evidenceByClaim.get(evidence.claim_id) ?? [];
      values.push(evidence);
      evidenceByClaim.set(evidence.claim_id, values);
    }
    const claims = claimRows.map((claim, claimIndex) => {
      if (claim.report_id !== row.id || claim.ordinal !== claimIndex + 1 ||
          ![0, 1].includes(claim.is_inference)) {
        return corrupt("Research claim ordering is invalid");
      }
      if (redacted) {
        if (claim.claim_payload_present === 1) {
          return corrupt("Redacted report retained claim material");
        }
      } else {
        if (claim.claim_text === null || sha256(claim.claim_text) !== claim.claim_digest ||
            (claim.is_inference === 1) !== (claim.inference_rationale !== null) ||
            (claim.inference_rationale === null
              ? claim.rationale_digest !== null
              : sha256(claim.inference_rationale) !== claim.rationale_digest)) {
          return corrupt("Research claim digest is invalid");
        }
      }
      const claimEvidence = evidenceByClaim.get(claim.id) ?? [];
      const evidence = claimEvidence.map((entry, evidenceIndex) => {
        if (entry.ordinal !== evidenceIndex + 1) {
          return corrupt("Research evidence ordering is invalid");
        }
        if (redacted) {
          if (entry.evidence_state !== "redacted" || entry.evidence_payload_present === 1) {
            return corrupt("Redacted report retained evidence material");
          }
          if (entry.kind === "tab_content") {
            const source = entry.source_id === null ? undefined : sourceById.get(entry.source_id);
            if (source === undefined || source.content_revision === null ||
                source.content_digest === null) {
              return corrupt("Redacted tab evidence lost audit identity");
            }
            return {
              id: entry.id, ordinal: entry.ordinal, kind: "tab_content" as const,
              sourceId: source.id, contentRevision: source.content_revision,
              contentDigest: source.content_digest, sourceKind: source.source_kind,
              acquisitionMethod: source.acquisition_method, state: "redacted" as const,
              stateReason: entry.evidence_reason, locator: null,
              locatorDigest: entry.locator_digest, excerptHash: entry.excerpt_hash,
              excerpt: null, url: null, title: null,
            };
          }
          if (entry.snapshot_id === null) {
            return corrupt("Redacted snapshot evidence lost audit identity");
          }
          return {
            id: entry.id, ordinal: entry.ordinal,
            kind: entry.kind as "page_context" | "resource_context" | "activity" | "relation",
            snapshotId: entry.snapshot_id, state: "redacted" as const,
            stateReason: entry.evidence_reason, locator: null,
            locatorDigest: entry.locator_digest, excerptHash: entry.excerpt_hash, excerpt: null,
          };
        }
        if (entry.evidence_state === "redacted" || entry.locator_json === null) {
          return corrupt("Non-redacted report has unavailable evidence material");
        }
        if (entry.kind === "tab_content") {
          const source = entry.source_id === null ? undefined : sourceById.get(entry.source_id);
          if (source === undefined || source.used_order === null ||
              source.content_revision === null || source.content_digest === null ||
              source.evidence_material === null || source.url_snapshot === null ||
              source.title_snapshot === null || source.source_state === "redacted") {
            return corrupt("Tab evidence source is outside the immutable report corpus");
          }
          const locator = parseCanonicalJson(
            entry.locator_json, researchUtf8RangeLocatorSchema, "tab evidence locator",
          );
          if (sha256(entry.locator_json) !== entry.locator_digest) {
            return corrupt("Tab evidence locator digest is invalid");
          }
          const bytes = Buffer.from(source.evidence_material, "utf8");
          if (locator.byteStart < 0 || locator.byteEnd > bytes.byteLength ||
              locator.byteEnd <= locator.byteStart) {
            return corrupt("Tab evidence byte range is invalid");
          }
          const excerptBytes = bytes.subarray(locator.byteStart, locator.byteEnd);
          let excerpt: string;
          try {
            excerpt = fatalUtf8Decoder.decode(excerptBytes);
          } catch {
            return corrupt("Tab evidence range splits UTF-8 data");
          }
          if (excerpt.length === 0 || sha256(excerptBytes) !== entry.excerpt_hash) {
            return corrupt("Tab evidence excerpt digest is invalid");
          }
          return {
            id: entry.id, ordinal: entry.ordinal, kind: "tab_content" as const,
            sourceId: source.id, contentRevision: source.content_revision,
            contentDigest: source.content_digest, sourceKind: source.source_kind,
            acquisitionMethod: source.acquisition_method,
            state: entry.evidence_state as "valid" | "invalid",
            stateReason: entry.evidence_reason, locator,
            locatorDigest: entry.locator_digest, excerptHash: entry.excerpt_hash,
            excerpt, url: source.url_snapshot, title: source.title_snapshot,
          };
        }
        if (!["page_context", "resource_context", "activity", "relation"].includes(entry.kind) ||
            entry.snapshot_id === null || entry.snapshot_run_id !== row.run_id ||
            entry.snapshot_digest === null || entry.snapshot_state === null ||
            entry.snapshot_state === "redacted" || entry.material_json === null) {
          return corrupt("Snapshot evidence identity is incomplete");
        }
        const locator = parseCanonicalJson(
          entry.locator_json, researchWholeSnapshotLocatorSchema, "snapshot evidence locator",
        );
        if (sha256(entry.locator_json) !== entry.locator_digest) {
          return corrupt("Snapshot evidence locator digest is invalid");
        }
        parseCanonicalObject(entry.material_json, "snapshot material");
        const materialBytes = Buffer.from(entry.material_json, "utf8");
        if (sha256(materialBytes) !== entry.snapshot_digest ||
            sha256(materialBytes) !== entry.excerpt_hash) {
          return corrupt("Snapshot evidence digest is invalid");
        }
        return {
          id: entry.id, ordinal: entry.ordinal,
          kind: entry.kind as "page_context" | "resource_context" | "activity" | "relation",
          snapshotId: entry.snapshot_id,
          state: entry.evidence_state as "valid" | "invalid",
          stateReason: entry.evidence_reason, locator,
          locatorDigest: entry.locator_digest, excerptHash: entry.excerpt_hash,
          excerpt: entry.material_json,
        };
      });
      if (!redacted && claim.is_inference === 0 && evidence.length === 0) {
        return corrupt("Non-inference research claim has no evidence");
      }
      return {
        id: claim.id,
        ordinal: claim.ordinal,
        claimDigest: claim.claim_digest,
        claimText: redacted ? null : claim.claim_text,
        confidence: claim.confidence,
        isInference: claim.is_inference === 1,
        rationaleDigest: claim.rationale_digest,
        rationale: redacted ? null : claim.inference_rationale,
        evidence,
      };
    });
    const evidenceClaimIds = new Set(claimRows.map((claim) => claim.id));
    if (evidenceRows.some((evidence) => !evidenceClaimIds.has(evidence.claim_id))) {
      return corrupt("Research evidence references an unknown claim");
    }
    let dossier = null;
    let reportText: string | null = null;
    if (redacted) {
      if (row.report_payload_present === 1) {
        return corrupt("Redacted report retained its report payload");
      }
    } else {
      dossier = parseCanonicalJson(row.structured_json, researchDossierSchema, "report dossier");
      if (row.report_text === null || row.payload_digest === null) {
        return corrupt("Non-redacted report payload is missing");
      }
      const renderClaims: ResearchClaimDraft[] = claims.map((claim) => ({
        claim: claim.claimText!, confidence: claim.confidence, isInference: claim.isInference,
        rationale: claim.rationale,
        evidence: claim.evidence.map((evidence) => evidence.kind === "tab_content"
          ? { kind: "tab_content" as const, sourceId: evidence.sourceId,
              locator: evidence.locator!, excerptHash: evidence.excerptHash }
          : { kind: evidence.kind, snapshotId: evidence.snapshotId,
              locator: evidence.locator!, excerptHash: evidence.excerptHash }),
      }));
      const rendered = renderResearchReportText(dossier, renderClaims);
      if (rendered !== row.report_text ||
          sha256(canonicalJson({ text: row.report_text, dossier })) !== row.payload_digest) {
        return corrupt("Research report deterministic rendering is invalid");
      }
      reportText = row.report_text;
    }
    const detail = {
      id: row.id,
      runId: row.run_id,
      jobId: `resource_research:${row.run_job_id}`,
      runStatus: row.run_status,
      target,
      version: row.version,
      parentReportId: row.parent_report_id,
      publishStatus: row.publish_status,
      reason: validatePublicationReason(row.publish_status, row.publication_reason),
      state: row.report_state,
      coverage,
      createdAt: row.created_at,
      headFlags: {
        isLatestPublished: head.latestPublishedReportId === row.id,
        isCurrentFresh: head.currentFreshReportId === row.id,
        isLastSuccessful: head.lastSuccessfulReportId === row.id,
      },
      dossier,
      reportText,
      provenance: {
        ...storedProvenance,
        inputFingerprint: row.input_fingerprint,
        terminalAttemptId: row.terminal_attempt_id,
      },
      claims,
    };
    const valid = researchReportDetailSchema.safeParse(detail);
    if (!valid.success || valid.data === undefined) {
      return corrupt("Research report detail response is invalid");
    }
    return valid.data;
  }

  function groupByReport<T extends { readonly report_id: number }>(
    rows: readonly T[],
  ): ReadonlyMap<number, readonly T[]> {
    const grouped = new Map<number, T[]>();
    for (const row of rows) {
      const values = grouped.get(row.report_id) ?? [];
      values.push(row);
      grouped.set(row.report_id, values);
    }
    return grouped;
  }

  function loadValidatedReports(
    reportIds: readonly number[],
    knownHeads: ReadonlyMap<string, ResearchReportHead> = new Map(),
    allowMissingSingle = false,
  ): readonly ResearchReportDetail[] {
    const uniqueIds = [...new Set(reportIds)];
    if (uniqueIds.length !== reportIds.length || uniqueIds.some((id) =>
      !Number.isSafeInteger(id) || id < 1)) {
      return corrupt("Invalid report validation set");
    }
    const parameters = { reportIds: JSON.stringify(uniqueIds) };
    const roots = selectDetailRoot.all(parameters) as DetailRootRow[];
    const detailSelections = selectDetailSelectionPages.all(parameters) as
      DetailSelectionPageRow[];
    const sources = selectSources.all(parameters) as SourceRow[];
    const claims = selectClaims.all(parameters) as ClaimRow[];
    const evidence = selectEvidence.all(parameters) as EvidenceRow[];
    const selectionByReport = groupByReport(detailSelections);
    const sourcesByReport = groupByReport(sources);
    const claimsByReport = groupByReport(claims);
    const evidenceByReport = groupByReport(evidence);
    if (allowMissingSingle && uniqueIds.length === 1 && roots.length === 0) return [];
    if (roots.length !== uniqueIds.length ||
        new Set(roots.map((root) => root.id)).size !== roots.length ||
        roots.some((root) => !uniqueIds.includes(root.id))) {
      return corrupt("Research report validation roots are incomplete");
    }
    const detailsById = new Map(roots.map((root) => {
      const head = knownHeads.get(root.target_key) ?? headFor(root.target_key);
      const detail = validateDetailProjection(
        root,
        selectionByReport.get(root.id) ?? [],
        sourcesByReport.get(root.id) ?? [],
        claimsByReport.get(root.id) ?? [],
        evidenceByReport.get(root.id) ?? [],
        head,
      );
      return [root.id, detail] as const;
    }));
    return reportIds.map((reportId) => {
      const detail = detailsById.get(reportId);
      return detail ?? corrupt("Research report validation result is missing");
    });
  }

  function get(reportId: number): ResearchReportDetail | undefined {
    if (!Number.isSafeInteger(reportId) || reportId < 1) {
      return corrupt("Invalid parsed research report ID");
    }
    return loadValidatedReports([reportId], new Map(), true)[0];
  }

  return Object.freeze({ list, get });
}
