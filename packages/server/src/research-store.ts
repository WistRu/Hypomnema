import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import {
  estimateResearchReservationV1,
  researchEstimateFitsBudgetV1,
  researchApprovalFingerprintPayloadV1,
  researchApprovedDraftSchema,
  researchApprovalRequestSchema,
  researchCanonicalSha256PayloadV1,
  researchCapturedTextChunkManifestSchema,
  researchContentDigestPayloadV1,
  researchPublicationDraftSchema,
  researchPrivacyRequestSchema,
  researchSelectionFingerprintPayload,
  type ResearchApprovedDraft,
  type ResearchApprovedDraftInput,
  type ResearchApprovalRequest,
  type ResearchCoverage,
  type ResearchEvidenceDraft,
  type ResearchPublicationDraft,
  type ResearchPrivacyRequest,
  type ResearchSnapshotDraft,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";

import {
  DurableAiJobError,
} from "./durable-ai-jobs.js";
import type {
  ResearchLedgerAdapter,
} from "./ai-job-ledger.js";
import { renderResearchReportText } from "./research-report-renderer.js";
import { classifyResourceUrlForResearch } from "./resource-catalog.js";
import {
  projectResearchPreflight,
  type ResearchCurrentProjection,
} from "./research-workflow.js";

const MAX_CORPUS_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_MATERIAL_BYTES = 65_536;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

type ResearchExactExclusionReason = ResearchCurrentProjection["sources"][number]["exclusionReason"];
type ResearchExactExclusionCategory =
  ResearchCurrentProjection["sources"][number]["exclusionCategory"];

interface ResearchDraftBuildOptions {
  readonly collectAccessConfirmations?: boolean;
  readonly sourceDetails?: Array<ResearchCurrentProjection["sources"][number]>;
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contentDigestV1(value: string): string {
  return createHash("sha256").update(researchContentDigestPayloadV1(value)).digest("hex");
}

export function fingerprintResearchCorpus(
  value: Omit<ResearchApprovedDraftInput, "corpusFingerprint"> & {
    readonly corpusFingerprint?: string;
  },
): string {
  const { corpusFingerprint: _corpusFingerprint, ...manifest } = value;
  return sha256(canonicalJson({
    version: 1,
    target: manifest.target,
    sources: manifest.sources.map((source) => {
      const {
        exclusionReason,
        sourceKind,
        selectedTabId,
        handoffSourceReceiptId,
        handoffSourceReceiptDigest,
        ...legacyIdentity
      } = source as typeof source & {
        readonly exclusionReason?: string | null;
      };
      const sourceIdentity = sourceKind === "live_acquisition"
        ? {
            ...legacyIdentity,
            sourceKind,
            selectedTabId,
            handoffSourceReceiptId,
            handoffSourceReceiptDigest,
          }
        : legacyIdentity;
      return {
      ...sourceIdentity,
      ...(exclusionReason === undefined || exclusionReason === null ? {} : { exclusionReason }),
      payload: source.payload === null ? null : (() => {
        const { evidenceMaterial, ...metadata } = source.payload;
        return { ...metadata, evidenceMaterialDigest: sha256(evidenceMaterial) };
      })(),
    }; }),
    ...(manifest.snapshots === undefined || manifest.snapshots.length === 0 ? {} : {
      snapshots: manifest.snapshots.map((snapshot) => {
        const { material, ...identity } = snapshot;
        return { ...identity, materialDigest: sha256(canonicalJson(material)) };
      }),
    }),
  }));
}

export function fingerprintResearchApproval(
  value: Omit<ResearchApprovedDraftInput, "approvalFingerprint" | "corpusFingerprint"> & {
    readonly approvalFingerprint?: string;
    readonly corpusFingerprint?: string;
  },
): string {
  return createHash("sha256").update(researchApprovalFingerprintPayloadV1(value)).digest("hex");
}

function submissionFingerprint(
  task: ResourceResearchTaskSpec,
  draft: ResearchApprovedDraft,
): string {
  const { idempotencyKey: _idempotencyKey, ...taskBody } = task;
  return sha256(canonicalJson({ task: taskBody, approvedDraft: draft }));
}

function targetKey(target: ResearchApprovedDraft["target"]): string {
  switch (target.type) {
    case "page": return `page:${target.logicalPageId}`;
    case "resource": return `resource:${target.resourceId}`;
    case "selection": return `selection:${target.fingerprint}`;
  }
}

function assertTargetMatchesTask(
  task: ResourceResearchTaskSpec,
  draft: ResearchApprovedDraft,
): void {
  const expected = task.subject.type === "page"
    ? `page:${task.subject.logicalPageId}`
    : task.subject.type === "resource"
      ? `resource:${task.subject.resourceId}`
      : `selection:${task.subject.fingerprint}`;
  if (targetKey(draft.target) !== expected ||
      task.inputFingerprint !== draft.approvalFingerprint ||
      task.workflowRef.id !== draft.workflowRef.id ||
      task.workflowRef.version !== draft.workflowRef.version ||
      canonicalJson(task.budget) !== canonicalJson(draft.budget)) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Research approval does not match task");
  }
  if (draft.target.type === "selection") {
    const expectedFingerprint = sha256(
      researchSelectionFingerprintPayload(draft.target.logicalPageIds),
    );
    if (draft.target.fingerprint !== expectedFingerprint) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research selection fingerprint");
    }
    const sourcePages = draft.sources.map((source) => source.logicalPageId).sort((a, b) => a - b);
    const selectionPages = [...draft.target.logicalPageIds].sort((a, b) => a - b);
    if (canonicalJson(sourcePages) !== canonicalJson(selectionPages)) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Selection corpus does not match target");
    }
  }
  if (draft.target.type === "page" &&
      (draft.sources.length !== 1 ||
        draft.sources[0]?.logicalPageId !== draft.target.logicalPageId)) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Page research must contain its exact page");
  }
  if (fingerprintResearchCorpus(draft) !== draft.corpusFingerprint) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Research corpus fingerprint mismatch");
  }
}

interface CurrentContentRow {
  logical_page_id: number;
  url: string;
  title: string | null;
  content_revision: number | null;
  text: string | null;
  extracted_at: string | null;
}

interface ManifestCandidateRow extends CurrentContentRow {
  ordinal: number;
  tab_id: number | null;
  resource_id: number | null;
  access_class: "public" | "authenticated" | "sensitive" | null;
}

interface SourceRow {
  id: number;
  run_id: number;
  ordinal: number;
  logical_page_id: number;
  tab_id: number | null;
  captured_tab_id_snapshot: number | null;
  content_revision: number | null;
  content_digest: string | null;
  extracted_at: string | null;
  source_kind: "captured" | "live_acquisition";
  acquisition_method: "inventory" | "captured" | "exact_capture" | "safe_public_http_v1";
  handoff_source_receipt_id: number | null;
  access_class_snapshot: "public" | "authenticated" | "sensitive";
  inclusion_state: "included" | "excluded" | "missing" | "failed";
  eligibility: "eligible" | "privacy_excluded" | "format_excluded" |
    "size_excluded" | "not_captured";
  included_order: number | null;
}

export interface ResearchPublicationSourceIdentity {
  readonly sourceId: number;
  readonly runId: number;
  readonly ordinal: number;
  readonly logicalPageId: number;
  readonly tabId: number | null;
  readonly capturedTabIdSnapshot: number | null;
  readonly contentRevision: number | null;
  readonly contentDigest: string | null;
  readonly extractedAt: string | null;
  readonly sourceKind: "captured" | "live_acquisition";
  readonly acquisitionMethod:
    | "inventory" | "captured" | "exact_capture" | "safe_public_http_v1";
  readonly handoffSourceReceiptId: number | null;
  readonly accessClass: "public" | "authenticated" | "sensitive";
  readonly eligibility: "eligible" | "privacy_excluded" | "format_excluded" |
    "size_excluded" | "not_captured";
  readonly inclusionState: "included" | "excluded" | "missing" | "failed";
  readonly includedOrder: number | null;
}

export interface ResearchPublicationCapturedIdentity {
  readonly logicalPageId: number;
  readonly contentRevision: number;
  readonly contentDigest: string;
}

export interface ResearchPublicationLiveIdentity {
  readonly kind: "live_acquisition";
  readonly handoffSourceReceiptId: number;
  readonly receiptDigest: string;
  readonly finalRunId: number;
  readonly ordinal: number;
  readonly logicalPageId: number;
  readonly logicalPageGenerationId: number;
  readonly logicalPageGenerationToken: string;
  readonly targetGenerationLogicalPageId: number;
  readonly contentRevision: 1;
  readonly contentDigest: string;
  readonly extractedAt: string;
  readonly payloadDigest: string;
  readonly inclusionState: "included";
  readonly includedOrder: number;
  readonly targetGenerationActive: true;
  readonly handoffStatus: "completed";
  readonly handoffCompletedAt: string;
  readonly terminalCompletedAt: string;
  readonly handoffTerminal: true;
}

/**
 * C81 publication gate. Captured sources bind to current tab content. C90a
 * persists and reconstructs live-source provenance, but C90b owns publication
 * validation and therefore live publication remains fail-closed here.
 */
export function assertResearchPublicationSourceIdentity(
  source: ResearchPublicationSourceIdentity,
  identity: ResearchPublicationCapturedIdentity | ResearchPublicationLiveIdentity | undefined,
): void {
  if (source.inclusionState !== "included" || source.eligibility !== "eligible" ||
      source.contentRevision === null || source.contentDigest === null ||
      source.extractedAt === null || source.includedOrder === null) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Used source is outside approved corpus");
  }
  if (source.sourceKind === "live_acquisition") {
    if (source.tabId !== null || source.capturedTabIdSnapshot !== null ||
        source.acquisitionMethod !== "safe_public_http_v1" ||
        source.handoffSourceReceiptId === null || identity === undefined ||
        !("kind" in identity) || identity.kind !== "live_acquisition" ||
        identity.handoffSourceReceiptId !== source.handoffSourceReceiptId ||
        identity.finalRunId !== source.runId || identity.ordinal !== source.ordinal ||
        identity.logicalPageId !== source.logicalPageId ||
        identity.targetGenerationLogicalPageId !== source.logicalPageId ||
        !Number.isSafeInteger(identity.logicalPageGenerationId) ||
        identity.logicalPageGenerationId <= 0 ||
        !/^[0-9a-f]{64}$/u.test(identity.logicalPageGenerationToken) ||
        identity.contentRevision !== source.contentRevision ||
        identity.contentDigest !== source.contentDigest ||
        identity.extractedAt !== source.extractedAt ||
        identity.payloadDigest !== source.contentDigest ||
        identity.inclusionState !== source.inclusionState ||
        identity.includedOrder !== source.includedOrder ||
        identity.targetGenerationActive !== true || identity.handoffTerminal !== true ||
        identity.handoffStatus !== "completed" ||
        identity.handoffCompletedAt !== identity.terminalCompletedAt ||
        !/^[0-9a-f]{64}$/u.test(identity.receiptDigest)) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Used live research source changed");
    }
    return;
  }
  if ((source.acquisitionMethod !== "captured" &&
        source.acquisitionMethod !== "exact_capture") ||
      source.handoffSourceReceiptId !== null || source.tabId === null ||
      source.capturedTabIdSnapshot !== source.tabId || identity === undefined ||
      identity.logicalPageId !== source.logicalPageId ||
      identity.contentRevision !== source.contentRevision ||
      identity.contentDigest !== source.contentDigest) {
    throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Used research source changed");
  }
}

interface SourcePayloadRow {
  evidence_material: string;
  chunk_manifest_json: string;
  payload_digest: string;
}

interface SnapshotIdentityRow {
  run_id: number;
  snapshot_digest: string;
}

interface SnapshotPayloadRow {
  material_json: string;
}

interface RunRow {
  id: number;
  job_id: number;
  target_key: string;
  target_logical_page_id: number | null;
  target_resource_id: number | null;
  selection_fingerprint: string | null;
  parent_report_id: number | null;
  corpus_fingerprint: string;
  approval_fingerprint: string;
  submission_fingerprint: string;
}

export interface ResearchStoreOptions {
  readonly clock?: () => Date;
}

export type ResearchBoundaryErrorCode =
  | "RESEARCH_TARGET_NOT_FOUND"
  | "RESEARCH_SELECTION_INVALID"
  | "RESEARCH_PARENT_NOT_FOUND"
  | "RESEARCH_PARENT_UNAVAILABLE";

export class ResearchBoundaryError extends Error {
  constructor(
    readonly code: ResearchBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchBoundaryError";
  }
}

export type ResearchParentAvailability = "available" | "not_found" | "unavailable";

/** Read-only parent predicate shared by C81 preflight and the transactional submit guard. */
export function researchParentAvailability(
  connection: Database.Database,
  target: ResearchApprovalRequest["target"],
  parentReportId: number,
): ResearchParentAvailability {
  const row = connection.prepare(`
    SELECT report.target_key, head.state
    FROM research_reports AS report
    JOIN research_report_heads AS head ON head.report_id = report.id
    WHERE report.id = ?
  `).get(parentReportId) as { target_key: string; state: string } | undefined;
  if (row === undefined) return "not_found";
  if (row.target_key !== targetKey(target) || row.state === "redacted" ||
      row.state === "superseded") return "unavailable";
  return "available";
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
} {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) {
    return { text: value, byteLength: encoder.encode(value).byteLength, truncated: false };
  }
  let text = "";
  let byteLength = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (byteLength + bytes > maximumBytes) break;
    text += character;
    byteLength += bytes;
  }
  return { text, byteLength, truncated: true };
}

function fitSnapshotTextMaterial(
  value: string,
  material: (text: string, truncated: boolean) => Record<string, unknown>,
): Record<string, unknown> {
  const full = material(value, false);
  if (researchCanonicalSha256PayloadV1(full).byteLength <= MAX_SNAPSHOT_MATERIAL_BYTES) {
    return full;
  }

  const codePoints = Array.from(value);
  let lower = 0;
  let upper = codePoints.length;
  let fitted = material("", true);
  if (researchCanonicalSha256PayloadV1(fitted).byteLength > MAX_SNAPSHOT_MATERIAL_BYTES) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Snapshot metadata exceeds 64 KiB");
  }
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = material(codePoints.slice(0, middle).join(""), true);
    if (researchCanonicalSha256PayloadV1(candidate).byteLength <= MAX_SNAPSHOT_MATERIAL_BYTES) {
      fitted = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return fitted;
}

function privacyChildEventKey(
  parentIdempotencyKey: string,
  childType: "source" | "snapshot" | "evidence" | "report",
  childKey: string,
): string {
  return `privacy-event:v1:${sha256(canonicalJson({
    parentIdempotencyKey,
    child: { type: childType, key: childKey },
  }))}`;
}

function createCurrentResearchDraftBuilder(
  connection: Database.Database,
  clock: () => Date,
  buildOptions: ResearchDraftBuildOptions = {},
): (request: ResearchApprovalRequest) => ResearchApprovedDraft {
  const selectPage = connection.prepare(`SELECT id FROM logical_pages WHERE id = ?`);
  const selectSelectionPages = connection.prepare(`
    SELECT id FROM logical_pages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id
  `);
  const selectResource = connection.prepare(`
    SELECT events.access_class
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events ON events.id = heads.event_id
      AND events.resource_id = resources.id
    WHERE resources.id = ? AND events.lifecycle_state = 'active'
  `);
  const selectResourceMembers = connection.prepare(`
    SELECT assignments.logical_page_id AS id
    FROM logical_page_resource_heads AS heads
    JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = heads.assignment_id
      AND assignments.logical_page_id = heads.logical_page_id
    WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    ORDER BY assignments.logical_page_id
    LIMIT 10001
  `);
  const candidateColumns = `
    scope.ordinal, scope.logical_page_id, tabs.id AS tab_id, tabs.url, tabs.title,
    contents.content_revision, contents.text, contents.extracted_at,
    assignments.resource_id, resource_events.access_class`;
  const candidateJoins = `
    LEFT JOIN logical_page_resource_heads AS assignment_heads
      ON assignment_heads.logical_page_id = scope.logical_page_id
    LEFT JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = assignment_heads.assignment_id
      AND assignments.logical_page_id = scope.logical_page_id
      AND assignments.action = 'assigned'
    LEFT JOIN resource_heads ON resource_heads.resource_id = assignments.resource_id
    LEFT JOIN resource_events ON resource_events.id = resource_heads.event_id
      AND resource_events.resource_id = assignments.resource_id`;
  const selectDefaultCandidates = connection.prepare(`
    WITH scope AS (
      SELECT CAST(key AS INTEGER) + 1 AS ordinal, CAST(value AS INTEGER) AS logical_page_id
      FROM json_each(?)
    ), candidates AS (
      SELECT ${candidateColumns}, ROW_NUMBER() OVER (
        PARTITION BY scope.logical_page_id
        ORDER BY
          CASE WHEN contents.text IS NOT NULL AND contents.content_revision IS NOT NULL
            AND contents.extracted_at IS NOT NULL THEN 0 ELSE 1 END,
          contents.content_revision DESC, contents.extracted_at DESC, tabs.id DESC
      ) AS candidate_rank
      FROM scope
      LEFT JOIN tabs ON tabs.logical_page_id = scope.logical_page_id
      LEFT JOIN contents ON contents.tab_id = tabs.id
      ${candidateJoins}
    )
    SELECT ordinal, logical_page_id, tab_id, url, title, content_revision, text,
      extracted_at, resource_id, access_class
    FROM candidates WHERE candidate_rank = 1 ORDER BY ordinal
  `);
  const selectExplicitTabs = connection.prepare(`
    WITH requested AS (
      SELECT CAST(value AS INTEGER) AS tab_id FROM json_each(?)
    ), scope AS (
      SELECT tabs.logical_page_id AS ordinal, tabs.logical_page_id
      FROM requested JOIN tabs ON tabs.id = requested.tab_id
    )
    SELECT ${candidateColumns}
    FROM requested
    JOIN tabs ON tabs.id = requested.tab_id
    JOIN scope ON scope.logical_page_id = tabs.logical_page_id
    LEFT JOIN contents ON contents.tab_id = tabs.id
    ${candidateJoins}
    ORDER BY tabs.id
  `);
  const selectPageContexts = connection.prepare(`
    WITH scope AS (SELECT CAST(value AS INTEGER) AS logical_page_id FROM json_each(?))
    SELECT entries.id, entries.logical_page_id, entries.kind, entries.body,
      entries.actor, entries.method, entries.stale_at, entries.created_at,
      (SELECT reviews.verdict FROM context_entry_reviews AS reviews
       WHERE reviews.context_entry_id = entries.id
         AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
           WHERE newer_review.supersedes_id = reviews.id)
       LIMIT 1) AS review_verdict
    FROM context_entries AS entries
    JOIN scope ON scope.logical_page_id = entries.logical_page_id
    WHERE entries.visibility = 'share_with_ai' AND entries.state = 'active'
      AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(?))
      AND NOT EXISTS (SELECT 1 FROM context_entries AS newer
        WHERE newer.supersedes_id = entries.id AND newer.visibility = 'share_with_ai')
      AND (entries.actor = 'user' OR (entries.actor = 'agent' AND EXISTS (
        SELECT 1 FROM context_entry_reviews AS reviews
        WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id = reviews.id))))
    ORDER BY entries.logical_page_id, entries.revision, entries.id LIMIT ?
  `);
  const selectResourceContexts = connection.prepare(`
    WITH scope AS (SELECT CAST(value AS INTEGER) AS resource_id FROM json_each(?))
    SELECT entries.id, entries.resource_id, entries.kind, entries.body,
      entries.actor, entries.method, entries.stale_at, entries.created_at,
      (SELECT reviews.verdict FROM resource_context_entry_reviews AS reviews
       WHERE reviews.context_entry_id = entries.id
         AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
           WHERE newer_review.supersedes_id = reviews.id)
       LIMIT 1) AS review_verdict
    FROM resource_context_entries AS entries
    JOIN scope ON scope.resource_id = entries.resource_id
    WHERE entries.visibility = 'share_with_ai' AND entries.state = 'active'
      AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(?))
      AND NOT EXISTS (SELECT 1 FROM resource_context_entries AS newer
        WHERE newer.supersedes_id = entries.id AND newer.visibility = 'share_with_ai')
      AND (entries.actor = 'user' OR (entries.actor = 'agent' AND EXISTS (
        SELECT 1 FROM resource_context_entry_reviews AS reviews
        WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
            WHERE newer_review.supersedes_id = reviews.id))))
    ORDER BY entries.resource_id, entries.revision, entries.id LIMIT ?
  `);
  const selectActivity = connection.prepare(`
    WITH scope AS (SELECT CAST(value AS INTEGER) AS logical_page_id FROM json_each(?))
    SELECT activity.logical_page_id, activity.activity_date, activity.foreground_ms,
      activity.engaged_ms, activity.updated_at
    FROM logical_page_activity_daily AS activity
    JOIN scope ON scope.logical_page_id = activity.logical_page_id
    ORDER BY activity.logical_page_id, activity.activity_date DESC LIMIT ?
  `);
  const selectRelations = connection.prepare(`
    WITH scope AS (SELECT CAST(value AS INTEGER) AS logical_page_id FROM json_each(?)),
    scoped_entities AS (
      SELECT DISTINCT entities.id
      FROM scope JOIN tabs ON tabs.logical_page_id = scope.logical_page_id
      JOIN knowledge_entities AS entities ON entities.kind = 'tab' AND entities.tab_id = tabs.id
    )
    SELECT DISTINCT relations.id, relations.kind, relations.note, relations.created_by,
      source.kind AS from_kind, source.tab_id AS from_tab_id, source.topic_id AS from_topic_id,
      source_tabs.logical_page_id AS from_logical_page_id,
      target.kind AS to_kind, target.tab_id AS to_tab_id, target.topic_id AS to_topic_id,
      target_tabs.logical_page_id AS to_logical_page_id
    FROM relations
    JOIN knowledge_entities AS source ON source.id = relations.from_entity_id
    JOIN knowledge_entities AS target ON target.id = relations.to_entity_id
    LEFT JOIN tabs AS source_tabs ON source_tabs.id = source.tab_id
    LEFT JOIN tabs AS target_tabs ON target_tabs.id = target.tab_id
    WHERE relations.from_entity_id IN (SELECT id FROM scoped_entities)
       OR relations.to_entity_id IN (SELECT id FROM scoped_entities)
    ORDER BY relations.id LIMIT ?
  `);

  const invalid = (message: string): never => {
    throw new DurableAiJobError("INVALID_JOB_INPUT", message);
  };
  const targetNotFound = (message: string): never => {
    throw new ResearchBoundaryError("RESEARCH_TARGET_NOT_FOUND", message);
  };
  const selectionInvalid = (message: string): never => {
    throw new ResearchBoundaryError("RESEARCH_SELECTION_INVALID", message);
  };
  const scopeTooLarge = (message: string): never => {
    throw new DurableAiJobError("RESEARCH_SCOPE_TOO_LARGE", message);
  };
  const originDigest = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return sha256(parsed.origin.toLowerCase());
    } catch {
      return null;
    }
  };
  const originDisplay = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.origin.toLowerCase();
    } catch {
      return null;
    }
  };

  return (rawRequest): ResearchApprovedDraft => {
    const parsed = researchApprovalRequestSchema.safeParse(rawRequest);
    if (!parsed.success) return invalid("Invalid declarative research approval request");
    const request: ResearchApprovalRequest = parsed.data;
    let pageIds: number[];
    if (request.target.type === "page") {
      if (selectPage.get(request.target.logicalPageId) === undefined) {
        targetNotFound("Research page target does not exist");
      }
      pageIds = [request.target.logicalPageId];
    } else if (request.target.type === "selection") {
      const expected = sha256(researchSelectionFingerprintPayload(request.target.logicalPageIds));
      if (expected !== request.target.fingerprint) {
        selectionInvalid("Research selection fingerprint is invalid");
      }
      const found = (selectSelectionPages.all(JSON.stringify(request.target.logicalPageIds)) as
        Array<{ id: number }>).map((row) => row.id);
      if (found.length !== request.target.logicalPageIds.length) {
        selectionInvalid("Research selection contains a missing logical page");
      }
      pageIds = [...request.target.logicalPageIds];
    } else {
      if (selectResource.get(request.target.resourceId) === undefined) {
        targetNotFound("Research resource target does not exist or is not current");
      }
      const members = selectResourceMembers.all(request.target.resourceId) as Array<{ id: number }>;
      if (members.length > 10_000) scopeTooLarge("Research resource scope exceeds 10,000 pages");
      pageIds = members.map((row) => row.id);
    }
    if (pageIds.length > 10_000) scopeTooLarge("Research scope exceeds 10,000 pages");
    const pageSet = new Set(pageIds);
    const requestedTabIds = [...new Set([
      ...request.captureIntent.selectedTabIds,
      ...request.captureIntent.knownFailures.map((failure) => failure.tabId),
    ])];
    const explicitRows = requestedTabIds.length === 0 ? []
      : selectExplicitTabs.all(JSON.stringify(requestedTabIds)) as ManifestCandidateRow[];
    if (explicitRows.length !== requestedTabIds.length) {
      selectionInvalid("Selected research tab does not exist");
    }
    const explicitByTab = new Map(explicitRows.map((row) => [row.tab_id!, row]));
    const selectedByPage = new Map<number, ManifestCandidateRow>();
    for (const tabId of request.captureIntent.selectedTabIds) {
      const row = explicitByTab.get(tabId)!;
      if (!pageSet.has(row.logical_page_id)) {
        selectionInvalid("Selected research tab is outside target scope");
      }
      if (selectedByPage.has(row.logical_page_id)) {
        selectionInvalid("Only one exact tab may be selected per page");
      }
      selectedByPage.set(row.logical_page_id, row);
    }
    const failureByPage = new Map<number, ResearchApprovalRequest["captureIntent"]["knownFailures"][number]>();
    for (const failure of request.captureIntent.knownFailures) {
      const row = explicitByTab.get(failure.tabId)!;
      if (row.logical_page_id !== failure.logicalPageId || !pageSet.has(failure.logicalPageId)) {
        selectionInvalid("Known capture failure is outside target scope");
      }
      const selected = selectedByPage.get(failure.logicalPageId);
      if (selected !== undefined && selected.tab_id !== failure.tabId) {
        selectionInvalid("Selected tab and capture failure disagree for a page");
      }
      failureByPage.set(failure.logicalPageId, failure);
    }
    const defaultRows = selectDefaultCandidates.all(JSON.stringify(pageIds)) as ManifestCandidateRow[];
    const defaultByPage = new Map(defaultRows.map((row) => [row.logical_page_id, row]));
    let candidates = pageIds.map((logicalPageId, index) => {
      const candidate = selectedByPage.get(logicalPageId) ??
        (failureByPage.has(logicalPageId)
          ? explicitByTab.get(failureByPage.get(logicalPageId)!.tabId)
          : defaultByPage.get(logicalPageId));
      const chosen = candidate ?? invalid(`No inventory row for logical page ${logicalPageId}`);
      return { ...chosen, ordinal: index + 1 };
    });
    if (request.target.type === "resource") {
      candidates = candidates.sort((left, right) => {
        if (left.extracted_at !== right.extracted_at) {
          if (left.extracted_at === null) return 1;
          if (right.extracted_at === null) return -1;
          return right.extracted_at.localeCompare(left.extracted_at);
        }
        return left.logical_page_id - right.logical_page_id ||
          (left.tab_id ?? Number.MAX_SAFE_INTEGER) - (right.tab_id ?? Number.MAX_SAFE_INTEGER);
      }).map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));
    }
    let included = 0;
    let corpusBytes = 0;
    let corpusCapReached = false;
    const sources: ResearchApprovedDraft["sources"] = candidates.map((candidate) => {
      const failure = failureByPage.get(candidate.logical_page_id);
      const accessClass = candidate.access_class ?? "public";
      const acquisitionMethod = selectedByPage.has(candidate.logical_page_id) || failure !== undefined
        ? "exact_capture" as const : "captured" as const;
      const capturedSourceIdentity = {
        sourceKind: "captured" as const,
        selectedTabId: selectedByPage.get(candidate.logical_page_id)?.tab_id ?? null,
        handoffSourceReceiptId: null,
        handoffSourceReceiptDigest: null,
      };
      const record = <Source extends ResearchApprovedDraft["sources"][number]>(
        source: Source,
        exclusionReason: ResearchExactExclusionReason,
        exclusionCategory: ResearchExactExclusionCategory,
        sourceOriginDigest: string | null,
        sourceOriginDisplay: string | null,
        confirmationRequired: boolean,
      ): Source => {
        buildOptions.sourceDetails?.push({
          ordinal: candidate.ordinal,
          exclusionReason,
          exclusionCategory,
          originDigest: sourceOriginDigest,
          originDisplay: sourceOriginDisplay,
          confirmationRequired,
        });
        return source;
      };
      if (failure !== undefined) {
        return record({
          ...capturedSourceIdentity,
          selectedTabId: failure.tabId,
          ordinal: candidate.ordinal, logicalPageId: candidate.logical_page_id,
          tabId: failure.tabId, contentRevision: null, contentDigest: null, extractedAt: null,
          acquisitionMethod: "exact_capture" as const, accessClass,
          eligibility: "not_captured" as const,
          inclusionState: "failed" as const, failureCode: failure.failureCode,
          includedOrder: null, payload: null,
        }, null, null, originDigest(candidate.url), originDisplay(candidate.url), false);
      }
      if (candidate.tab_id === null || candidate.text === null ||
          candidate.content_revision === null || candidate.extracted_at === null) {
        if (selectedByPage.has(candidate.logical_page_id)) {
          selectionInvalid(
            "Explicit selected tab without captured content requires a known capture failure",
          );
        }
        return record({
          ...capturedSourceIdentity,
          ordinal: candidate.ordinal, logicalPageId: candidate.logical_page_id,
          tabId: null, contentRevision: null, contentDigest: null, extractedAt: null,
          acquisitionMethod: selectedByPage.has(candidate.logical_page_id)
            ? "exact_capture" as const : "inventory" as const,
          accessClass, eligibility: "not_captured" as const,
          inclusionState: "missing" as const,
          failureCode: null, includedOrder: null, payload: null,
        }, null, null, originDigest(candidate.url), originDisplay(candidate.url), false);
      }
      const authenticated = accessClass === "authenticated";
      const sensitive = accessClass === "sensitive";
      const digest = originDigest(candidate.url);
      const urlClassification = classifyResourceUrlForResearch(candidate.url);
      const evidence = truncateUtf8(candidate.text, 65_536);
      const confirmationRequired = urlClassification.kind === "eligible" && digest !== null &&
        (authenticated || sensitive);
      const privacyExcluded = !buildOptions.collectAccessConfirmations && confirmationRequired &&
        ((authenticated && !request.scope.privacyConfirmation.authenticatedOriginDigests
          .includes(digest)) ||
         (sensitive && !request.scope.privacyConfirmation.sensitiveOriginDigests.includes(digest)));
      const exactReason: ResearchExactExclusionReason =
        urlClassification.kind === "excluded" ? urlClassification.reason
          : evidence.byteLength === 0 ? "empty_captured_text" : null;
      const exactCategory: ResearchExactExclusionCategory =
        urlClassification.kind === "excluded" ? urlClassification.category
          : evidence.byteLength === 0 ? "size" : null;
      const eligibility = urlClassification.kind === "excluded" &&
          urlClassification.category === "privacy"
          ? "privacy_excluded" as const
          : urlClassification.kind === "excluded" ? "format_excluded" as const
            : evidence.byteLength === 0 ? "size_excluded" as const
              : privacyExcluded ? "privacy_excluded" as const : "eligible" as const;
      if (eligibility !== "eligible") {
        return record({
          ...capturedSourceIdentity,
          ordinal: candidate.ordinal, logicalPageId: candidate.logical_page_id,
          tabId: candidate.tab_id, contentRevision: candidate.content_revision,
          contentDigest: contentDigestV1(candidate.text), extractedAt: candidate.extracted_at,
          acquisitionMethod, accessClass, eligibility,
          inclusionState: "excluded" as const,
          exclusionReason: eligibility === "privacy_excluded" ? "privacy" as const
            : eligibility === "format_excluded" ? "format" as const : "size" as const,
          includedOrder: null, payload: null,
        }, exactReason, exactCategory, digest, originDisplay(candidate.url), false);
      }
      const sourceLimitReached = included >= request.scope.maxIncludedSources;
      if (!sourceLimitReached && !corpusCapReached &&
          corpusBytes + evidence.byteLength > MAX_CORPUS_BYTES) {
        corpusCapReached = true;
      }
      const corpusLimitReached = corpusCapReached;
      if (sourceLimitReached || corpusLimitReached) {
        return record({
          ...capturedSourceIdentity,
          ordinal: candidate.ordinal, logicalPageId: candidate.logical_page_id,
          tabId: candidate.tab_id, contentRevision: candidate.content_revision,
          contentDigest: contentDigestV1(candidate.text), extractedAt: candidate.extracted_at,
          acquisitionMethod, accessClass, eligibility: "eligible" as const,
          inclusionState: "excluded" as const, exclusionReason: "source_limit" as const,
          includedOrder: null, payload: null,
        }, sourceLimitReached ? "source_limit" : "corpus_byte_limit", "limit", digest,
        originDisplay(candidate.url), false);
      }
      included += 1;
      corpusBytes += evidence.byteLength;
      return record({
        ...capturedSourceIdentity,
        ordinal: candidate.ordinal, logicalPageId: candidate.logical_page_id,
        tabId: candidate.tab_id, contentRevision: candidate.content_revision,
        contentDigest: contentDigestV1(candidate.text), extractedAt: candidate.extracted_at,
        acquisitionMethod, accessClass, eligibility: "eligible" as const,
        inclusionState: "included" as const, includedOrder: included,
        payload: {
          url: candidate.url, title: candidate.title ?? "", evidenceMaterial: evidence.text,
          chunkManifest: { version: "captured_text_chunks:v1" as const,
            byteStart: 0 as const, byteEnd: evidence.byteLength,
          chunkDigest: sha256(evidence.text), truncated: evidence.truncated },
        },
      }, null, null, digest, originDisplay(candidate.url), confirmationRequired);
    });
    const snapshots: ResearchSnapshotDraft[] = [];
    type SnapshotIdentity =
      | { readonly kind: "page_context"; readonly contextEntryId: number;
          readonly logicalPageId: number }
      | { readonly kind: "resource_context"; readonly contextEntryId: number;
          readonly resourceId: number }
      | { readonly kind: "activity"; readonly logicalPageId: number;
          readonly activityDate: string }
      | { readonly kind: "relation"; readonly relationId: number };
    const addSnapshot = (identity: SnapshotIdentity,
      material: Record<string, unknown>) => {
      if (snapshots.length >= 100) return;
      snapshots.push({ ...identity, ordinal: snapshots.length + 1,
        snapshotDigest: sha256(canonicalJson(material)), material } as ResearchSnapshotDraft);
    };
    if (request.scope.includeShareableContext) {
      const anchor = clock().toISOString();
      const pageJson = JSON.stringify(pageIds);
      const contextRows = selectPageContexts.all(pageJson, anchor, 100) as Array<Record<string, unknown>>;
      for (const row of contextRows) {
        const material = fitSnapshotTextMaterial(String(row.body), (body, bodyTruncated) => ({
          kind: row.kind, body, bodyTruncated,
          actor: row.actor, method: row.method, staleAt: row.stale_at,
          createdAt: row.created_at, reviewVerdict: row.review_verdict,
        }));
        addSnapshot({ kind: "page_context", contextEntryId: Number(row.id),
          logicalPageId: Number(row.logical_page_id) }, material);
      }
      const resourceIds = [...new Set(request.target.type === "resource"
        ? [request.target.resourceId]
        : candidates.map((candidate) => candidate.resource_id)
          .filter((id): id is number => id !== null))].sort((a, b) => a - b);
      if (snapshots.length < 100 && resourceIds.length > 0) {
        const rows = selectResourceContexts.all(JSON.stringify(resourceIds), anchor,
          100 - snapshots.length) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const material = fitSnapshotTextMaterial(String(row.body), (body, bodyTruncated) => ({
            kind: row.kind, body, bodyTruncated,
            actor: row.actor, method: row.method, staleAt: row.stale_at,
            createdAt: row.created_at, reviewVerdict: row.review_verdict,
          }));
          addSnapshot({ kind: "resource_context", contextEntryId: Number(row.id),
            resourceId: Number(row.resource_id) }, material);
        }
      }
      if (snapshots.length < 100) {
        const rows = selectActivity.all(pageJson, 100 - snapshots.length) as
          Array<Record<string, unknown>>;
        for (const row of rows) addSnapshot({ kind: "activity",
          logicalPageId: Number(row.logical_page_id), activityDate: String(row.activity_date) }, {
          foregroundMs: row.foreground_ms, engagedMs: row.engaged_ms, updatedAt: row.updated_at,
        });
      }
      if (snapshots.length < 100) {
        const rows = selectRelations.all(pageJson, 100 - snapshots.length) as
          Array<Record<string, unknown>>;
        for (const row of rows) {
          const makeMaterial = (note: string | null, noteTruncated: boolean) => ({
            relationKind: row.kind, note, noteTruncated, createdBy: row.created_by,
            from: { kind: row.from_kind, tabId: row.from_tab_id,
              topicId: row.from_topic_id, logicalPageId: row.from_logical_page_id },
            to: { kind: row.to_kind, tabId: row.to_tab_id,
              topicId: row.to_topic_id, logicalPageId: row.to_logical_page_id },
          });
          const material = row.note === null ? makeMaterial(null, false)
            : fitSnapshotTextMaterial(String(row.note), (note, truncated) =>
                makeMaterial(note, truncated));
          addSnapshot({ kind: "relation", relationId: Number(row.id) }, material);
        }
      }
    }
    const sourceByOrdinal = new Map(sources.map((source) => [source.ordinal, source]));
    const requiredAuthenticatedOrigins = [...new Set((buildOptions.sourceDetails ?? [])
      .filter((source) => source.confirmationRequired &&
        sourceByOrdinal.get(source.ordinal)?.accessClass === "authenticated")
      .map((source) => source.originDigest!))].sort();
    const requiredSensitiveOrigins = [...new Set((buildOptions.sourceDetails ?? [])
      .filter((source) => source.confirmationRequired &&
        sourceByOrdinal.get(source.ordinal)?.accessClass === "sensitive")
      .map((source) => source.originDigest!))].sort();
    const scope = buildOptions.collectAccessConfirmations ? {
      ...request.scope,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: requiredAuthenticatedOrigins,
        sensitiveOriginDigests: requiredSensitiveOrigins,
      },
    } : request.scope;
    const estimate = estimateResearchReservationV1({
      includedSources: included,
      includedSourceBytes: corpusBytes,
      snapshotBytes: snapshots.reduce((total, snapshot) =>
        total + researchCanonicalSha256PayloadV1(snapshot.material).byteLength, 0),
      questionBytes: new TextEncoder().encode(request.question).byteLength,
      budget: request.budget,
    });
    const base = {
      version: 1 as const, target: request.target, question: request.question,
      scope, parentReportId: request.parentReportId,
      approvalFingerprint: request.approvalFingerprint, corpusFingerprint: "0".repeat(64),
      workflowRef: request.workflowRef, budget: request.budget, estimate, sources,
      ...(snapshots.length === 0 ? {} : { snapshots }),
    };
    const approved = { ...base, corpusFingerprint: fingerprintResearchCorpus(base) };
    const valid = researchApprovedDraftSchema.safeParse(approved);
    if (!valid.success) return invalid("Current research manifest violates the approved schema");
    return valid.data;
  };
}

export function buildCurrentResearchDraft(
  connection: Database.Database,
  request: ResearchApprovalRequest,
  options: ResearchStoreOptions = {},
): ResearchApprovedDraft {
  return createCurrentResearchDraftBuilder(
    connection,
    options.clock ?? (() => new Date()),
  )(request);
}

/**
 * Read-only C81 projection. It deliberately collects authenticated/sensitive
 * origins instead of treating absent confirmation as an exclusion; approval is
 * checked later by the workflow and rebuilt inside the ledger transaction.
 */
export function buildCurrentResearchProjection(
  connection: Database.Database,
  request: ResearchApprovalRequest,
  options: ResearchStoreOptions = {},
): ResearchCurrentProjection {
  const sources: Array<ResearchCurrentProjection["sources"][number]> = [];
  const draft = createCurrentResearchDraftBuilder(
    connection,
    options.clock ?? (() => new Date()),
    { collectAccessConfirmations: true, sourceDetails: sources },
  )(request);
  return { draft, sources };
}

export function createResearchStore(
  connection: Database.Database,
  options: ResearchStoreOptions = {},
): ResearchLedgerAdapter {
  const clock = options.clock ?? (() => new Date());
  const supportsLiveAcquisition =
    (connection.pragma("user_version", { simple: true }) as number) >= 25;
  const buildCurrentDraft = createCurrentResearchDraftBuilder(connection, clock);
  const selectCurrentContent = connection.prepare(`
    SELECT tabs.logical_page_id, tabs.url, tabs.title,
      contents.content_revision, contents.text, contents.extracted_at
    FROM tabs LEFT JOIN contents ON contents.tab_id = tabs.id
    WHERE tabs.id = ?
  `);
  const insertRun = connection.prepare(supportsLiveAcquisition ? `
    INSERT INTO research_runs (
      job_id, target_logical_page_id, target_resource_id, target_selection,
      selection_fingerprint, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, parent_report_id,
      max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at,
      history_epoch_id
    ) VALUES (
      @jobId, @targetLogicalPageId, @targetResourceId, @targetSelection,
      @selectionFingerprint, @targetKey, @questionDigest, @scopeJson,
      @approvalFingerprint, @corpusFingerprint, @submissionFingerprint,
      @workflowId, @workflowVersion, @parentReportId,
      @maxSteps, @maxTokens, @maxCostUsd, @maxWallTimeMs, @createdAt,
      CASE WHEN @targetResourceId IS NULL THEN NULL ELSE (
        SELECT history.id FROM research_history_epochs AS history
        WHERE history.resource_id = @targetResourceId AND history.is_active = 1
      ) END
    )
  ` : `
    INSERT INTO research_runs (
      job_id, target_logical_page_id, target_resource_id, target_selection,
      selection_fingerprint, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, parent_report_id,
      max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at
    ) VALUES (
      @jobId, @targetLogicalPageId, @targetResourceId, @targetSelection,
      @selectionFingerprint, @targetKey, @questionDigest, @scopeJson,
      @approvalFingerprint, @corpusFingerprint, @submissionFingerprint,
      @workflowId, @workflowVersion, @parentReportId,
      @maxSteps, @maxTokens, @maxCostUsd, @maxWallTimeMs, @createdAt
    )
  `);
  const insertRunPayload = connection.prepare(`
    INSERT INTO research_run_payloads (run_id, question, scope_json) VALUES (?, ?, ?)
  `);
  const insertSelection = connection.prepare(`
    INSERT INTO research_run_selection_pages (run_id, logical_page_id, selection_order)
    VALUES (?, ?, ?)
  `);
  const insertSource = connection.prepare(`
    INSERT INTO research_sources (
      run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
      content_revision, content_digest,
      extracted_at, acquisition_method, access_class_snapshot,
      eligibility, inclusion_state, exclusion_reason,
      included_order, failure_code, created_at
    ) VALUES (
      @runId, @ordinal, @logicalPageId, @tabId, @capturedTabIdSnapshot,
      @contentRevision, @contentDigest,
      @extractedAt, @acquisitionMethod, @accessClass,
      @eligibility, @inclusionState, @exclusionReason,
      @includedOrder, @failureCode, @createdAt
    )
  `);
  const insertSourcePayload = connection.prepare(`
    INSERT INTO research_source_payloads (
      source_id, url_snapshot, title_snapshot, evidence_material,
      chunk_manifest_json, payload_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSnapshot = Object.freeze({
    page_context: connection.prepare(`
      INSERT INTO research_page_context_snapshots (
        run_id, context_entry_audit_id, logical_page_audit_id, context_entry_id,
        snapshot_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    resource_context: connection.prepare(`
      INSERT INTO research_resource_context_snapshots (
        run_id, context_entry_audit_id, resource_audit_id, context_entry_id,
        snapshot_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    activity: connection.prepare(`
      INSERT INTO research_activity_snapshots (
        run_id, logical_page_audit_id, activity_date_audit, logical_page_id,
        activity_date, snapshot_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    relation: connection.prepare(`
      INSERT INTO research_relation_snapshots (
        run_id, relation_audit_id, relation_id, snapshot_digest, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `),
  });
  const insertSnapshotEvent = connection.prepare(`
    INSERT INTO research_snapshot_state_events (
      kind, snapshot_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, ?, 1, 'accepted', 'valid', NULL, ?, ?)
  `);
  const insertSnapshotPayload = connection.prepare(`
    INSERT INTO research_snapshot_payloads (kind, snapshot_id, material_json)
    VALUES (?, ?, ?)
  `);
  const insertSourceEvent = connection.prepare(`
    INSERT INTO research_source_state_events (
      source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'accepted', 'valid', NULL, ?, ?)
  `);
  const insertRunEvent = connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, report_id, idempotency_key, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRunEventSequence = connection.prepare(`
    SELECT COALESCE(MAX(sequence_no), 0) + 1
    FROM research_run_events WHERE run_id = ?
  `);
  const selectRun = connection.prepare(`SELECT * FROM research_runs WHERE job_id = ?`);
  const selectParentReport = connection.prepare(`
    SELECT report.target_key, head.state
    FROM research_reports AS report
    JOIN research_report_heads AS head ON head.report_id = report.id
    WHERE report.id = ?
  `);
  const selectRunSources = supportsLiveAcquisition
    ? connection.prepare(`
        SELECT id, run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
          content_revision, content_digest, extracted_at, source_kind, acquisition_method,
          handoff_source_receipt_id, access_class_snapshot, inclusion_state, eligibility,
          included_order
        FROM research_sources WHERE run_id = ? ORDER BY ordinal
      `)
    : connection.prepare(`
        SELECT id, run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
          content_revision, content_digest, extracted_at, 'captured' AS source_kind,
          acquisition_method, NULL AS handoff_source_receipt_id,
          access_class_snapshot, inclusion_state, eligibility, included_order
        FROM research_sources WHERE run_id = ? ORDER BY ordinal
      `);
  const selectLivePublicationIdentity = !supportsLiveAcquisition
    ? undefined
    : connection.prepare(`
        SELECT receipt.id AS handoff_source_receipt_id,
          receipt.receipt_digest, receipt.final_run_id, receipt.ordinal,
          receipt.logical_page_id, receipt.logical_page_generation_id,
          receipt.content_revision, receipt.content_digest, receipt.extracted_at,
          receipt.inclusion_state, receipt.included_order, payload.payload_digest,
          generation.generation_token,
          generation.logical_page_id AS target_generation_logical_page_id,
          generation.is_active AS target_generation_active,
          handoff.status AS handoff_status, handoff.completed_at AS handoff_completed_at,
          terminal.completed_at AS terminal_completed_at,
          CASE WHEN terminal.handoff_id IS NULL THEN 0 ELSE 1 END AS handoff_terminal
        FROM research_sources AS source
        JOIN live_acquisition_source_receipts AS receipt
          ON receipt.id = source.handoff_source_receipt_id
        JOIN live_acquisition_handoffs AS handoff ON handoff.id = receipt.handoff_id
        JOIN privacy_subject_generations AS generation
          ON generation.id = receipt.logical_page_generation_id
        JOIN research_source_payloads AS payload ON payload.source_id = source.id
        JOIN live_acquisition_handoff_receipts AS terminal
          ON terminal.handoff_id = receipt.handoff_id
        WHERE source.id = ? AND receipt.final_run_id = source.run_id
      `);
  const selectSourcePayload = connection.prepare(`
    SELECT payload.evidence_material, payload.chunk_manifest_json, payload.payload_digest
    FROM research_source_payloads AS payload
    JOIN research_source_heads AS head ON head.source_id = payload.source_id
    WHERE payload.source_id = ? AND head.state = 'valid'
  `);
  const selectSnapshotPayload = connection.prepare(`
    SELECT payload.material_json FROM research_snapshot_payloads AS payload
    JOIN research_snapshot_heads AS head
      ON head.kind = payload.kind AND head.snapshot_id = payload.snapshot_id
    WHERE payload.kind = ? AND payload.snapshot_id = ? AND head.state = 'valid'
  `);
  const selectSnapshotRun = Object.freeze({
    page_context: connection.prepare(`SELECT run_id, snapshot_digest FROM research_page_context_snapshots WHERE id = ?`),
    resource_context: connection.prepare(`SELECT run_id, snapshot_digest FROM research_resource_context_snapshots WHERE id = ?`),
    activity: connection.prepare(`SELECT run_id, snapshot_digest FROM research_activity_snapshots WHERE id = ?`),
    relation: connection.prepare(`SELECT run_id, snapshot_digest FROM research_relation_snapshots WHERE id = ?`),
  });
  const insertReport = connection.prepare(`
    INSERT INTO research_reports (
      run_id, target_logical_page_id, target_resource_id, selection_fingerprint,
      target_key, version, parent_report_id, publish_status, coverage_json,
      coverage_fingerprint, provenance_json, input_fingerprint, created_at
    ) VALUES (
      @runId, @targetLogicalPageId, @targetResourceId, @selectionFingerprint,
      @targetKey, @version, @parentReportId, @publishStatus, @coverageJson,
      @coverageFingerprint, @provenanceJson, @inputFingerprint, @createdAt
    )
  `);
  const selectNextReportVersion = connection.prepare(`
    SELECT COALESCE(MAX(version), 0) + 1 FROM research_reports WHERE target_key = ?
  `);
  const insertReportPayload = connection.prepare(`
    INSERT INTO research_report_payloads (
      report_id, report_text, structured_json, payload_digest
    ) VALUES (?, ?, ?, ?)
  `);
  const insertReportSource = connection.prepare(`
    INSERT INTO research_report_sources (report_id, source_id, used_order)
    VALUES (?, ?, ?)
  `);
  const insertClaim = connection.prepare(`
    INSERT INTO research_claims (
      report_id, ordinal, claim_digest, confidence, is_inference, rationale_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertClaimPayload = connection.prepare(`
    INSERT INTO research_claim_payloads (claim_id, claim_text, inference_rationale)
    VALUES (?, ?, ?)
  `);
  const insertEvidence = connection.prepare(`
    INSERT INTO research_claim_evidence (
      claim_id, report_id, run_id, ordinal, kind, source_id, page_context_snapshot_id,
      resource_context_snapshot_id, activity_snapshot_id, relation_snapshot_id,
      locator_digest, excerpt_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvidencePayload = connection.prepare(`
    INSERT INTO research_evidence_payloads (evidence_id, locator_json) VALUES (?, ?)
  `);
  const insertEvidenceEvent = connection.prepare(`
    INSERT INTO research_evidence_state_events (
      evidence_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'accepted', 'valid', NULL, ?, ?)
  `);
  const insertReportEvent = connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'published', ?, ?, ?, ?)
  `);
  const selectRedactionReceipt = connection.prepare(`
    SELECT request_fingerprint, result_json
    FROM research_redaction_receipts WHERE idempotency_key = ?
  `);
  const selectSourceForRedaction = connection.prepare(`
    SELECT source.id, source.run_id, head.state
    FROM research_sources AS source
    JOIN research_source_heads AS head ON head.source_id = source.id
    WHERE source.id = ?
  `);
  const selectReportsUsingSource = connection.prepare(`
    SELECT report_id
    FROM research_report_sources
    WHERE source_id = ? ORDER BY report_id
  `);
  const selectSourceEventSequence = connection.prepare(`
    SELECT COALESCE(MAX(sequence_no), 0) + 1
    FROM research_source_state_events WHERE source_id = ?
  `);
  const selectEvidenceEventSequence = connection.prepare(`
    SELECT COALESCE(MAX(sequence_no), 0) + 1
    FROM research_evidence_state_events WHERE evidence_id = ?
  `);
  const selectReportEventSequence = connection.prepare(`
    SELECT COALESCE(MAX(sequence_no), 0) + 1
    FROM research_report_state_events WHERE report_id = ?
  `);
  const selectReportHead = connection.prepare(`
    SELECT state FROM research_report_heads WHERE report_id = ?
  `);
  const insertRedactedSourceEvent = connection.prepare(`
    INSERT INTO research_source_state_events (
      source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, ?, 'redacted', 'redacted', ?, ?, ?)
  `);
  const insertRedactedEvidenceEvent = connection.prepare(`
    INSERT INTO research_evidence_state_events (
      evidence_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, ?, 'redacted', 'redacted', ?, ?, ?)
  `);
  const insertRedactedReportEvent = connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, ?, 'redacted', 'redacted', ?, ?, ?)
  `);
  const deleteSourcePayload = connection.prepare(`
    DELETE FROM research_source_payloads WHERE source_id = ?
  `);
  const deleteReportPayload = connection.prepare(`
    DELETE FROM research_report_payloads WHERE report_id = ?
  `);
  const deleteEvidencePayload = connection.prepare(`
    DELETE FROM research_evidence_payloads WHERE evidence_id = ?
  `);
  const deleteClaimPayloads = connection.prepare(`
    DELETE FROM research_claim_payloads
    WHERE claim_id IN (SELECT id FROM research_claims WHERE report_id = ?)
  `);
  const clearLiveSourceTab = connection.prepare(`
    UPDATE research_sources SET tab_id = NULL WHERE id = ? AND tab_id IS NOT NULL
  `);
  const insertRedactionReceipt = connection.prepare(`
    INSERT INTO research_redaction_receipts (
      idempotency_key, request_fingerprint, target_type, target_key, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPrivacyRequest = connection.prepare(`
    INSERT INTO research_privacy_requests (
      idempotency_key, request_fingerprint, target_type, target_key, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPrivacyRunBinding = connection.prepare(`
    INSERT INTO research_privacy_run_bindings (idempotency_key, run_id) VALUES (?, ?)
  `);
  const insertPrivacyEventBinding = connection.prepare(`
    INSERT INTO research_privacy_event_bindings (
      event_key, idempotency_key, child_type, child_key
    ) VALUES (?, ?, ?, ?)
  `);
  const selectResearchRunIds = {
    logical_page: connection.prepare(`
      SELECT DISTINCT run.id
      FROM research_runs AS run
      LEFT JOIN research_sources AS source ON source.run_id = run.id
      LEFT JOIN research_run_selection_pages AS selected ON selected.run_id = run.id
      WHERE run.target_logical_page_id = ? OR source.logical_page_id = ?
        OR selected.logical_page_id = ?
      ORDER BY run.id
    `),
    target: connection.prepare(`
      SELECT id FROM research_runs WHERE target_key = ? ORDER BY id
    `),
  } as const;
  const selectCurrentResearchResourceExists = connection.prepare(`
    SELECT 1
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events ON events.id = heads.event_id
      AND events.resource_id = resources.id
    WHERE resources.id = ? AND events.lifecycle_state = 'active'
  `);
  const selectResearchSelectionPages = connection.prepare(`
    SELECT id FROM logical_pages
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY id
  `);
  const selectSourceIdentity = connection.prepare(`
    SELECT id, run_id FROM research_sources WHERE id = ?
  `);
  const selectReportIdentity = connection.prepare(`
    SELECT id, run_id FROM research_reports WHERE id = ?
  `);
  const selectSnapshotIdentity = {
    page_context: connection.prepare(`SELECT id, run_id FROM research_page_context_snapshots WHERE id = ?`),
    resource_context: connection.prepare(`SELECT id, run_id FROM research_resource_context_snapshots WHERE id = ?`),
    activity: connection.prepare(`SELECT id, run_id FROM research_activity_snapshots WHERE id = ?`),
    relation: connection.prepare(`SELECT id, run_id FROM research_relation_snapshots WHERE id = ?`),
  } as const;
  const selectSourcesForRuns = connection.prepare(`
    SELECT id FROM research_sources WHERE run_id = ? ORDER BY id
  `);
  const selectReportsForRuns = connection.prepare(`
    SELECT id FROM research_reports WHERE run_id = ? ORDER BY id
  `);
  const selectSnapshotsForRuns = connection.prepare(`
    SELECT 'page_context' AS kind, id FROM research_page_context_snapshots WHERE run_id = ?
    UNION ALL SELECT 'resource_context', id FROM research_resource_context_snapshots WHERE run_id = ?
    UNION ALL SELECT 'activity', id FROM research_activity_snapshots WHERE run_id = ?
    UNION ALL SELECT 'relation', id FROM research_relation_snapshots WHERE run_id = ?
    ORDER BY kind, id
  `);
  const selectReportsUsingSnapshot = connection.prepare(`
    SELECT DISTINCT report_id FROM research_claim_evidence
    WHERE (? = 'page_context' AND page_context_snapshot_id = ?)
      OR (? = 'resource_context' AND resource_context_snapshot_id = ?)
      OR (? = 'activity' AND activity_snapshot_id = ?)
      OR (? = 'relation' AND relation_snapshot_id = ?)
    ORDER BY report_id
  `);
  const selectEvidenceForPrivacy = connection.prepare(`
    SELECT DISTINCT evidence.id, evidence.report_id, head.state
    FROM research_claim_evidence AS evidence
    JOIN research_evidence_heads AS head ON head.evidence_id = evidence.id
    WHERE evidence.report_id = @reportId
      OR evidence.source_id = @sourceId
      OR (@snapshotKind = 'page_context'
        AND evidence.page_context_snapshot_id = @snapshotId)
      OR (@snapshotKind = 'resource_context'
        AND evidence.resource_context_snapshot_id = @snapshotId)
      OR (@snapshotKind = 'activity' AND evidence.activity_snapshot_id = @snapshotId)
      OR (@snapshotKind = 'relation' AND evidence.relation_snapshot_id = @snapshotId)
    ORDER BY evidence.id
  `);
  const selectSnapshotHead = connection.prepare(`
    SELECT state FROM research_snapshot_heads WHERE kind = ? AND snapshot_id = ?
  `);
  const selectSnapshotEventSequence = connection.prepare(`
    SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM research_snapshot_state_events
    WHERE kind = ? AND snapshot_id = ?
  `);
  const insertRedactedSnapshotEvent = connection.prepare(`
    INSERT INTO research_snapshot_state_events (
      kind, snapshot_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, ?, ?, 'redacted', 'redacted', ?, ?, ?)
  `);
  const deleteSnapshotPayload = connection.prepare(`
    DELETE FROM research_snapshot_payloads WHERE kind = ? AND snapshot_id = ?
  `);
  const clearSnapshotLive = {
    page_context: connection.prepare(`UPDATE research_page_context_snapshots SET context_entry_id = NULL WHERE id = ? AND context_entry_id IS NOT NULL`),
    resource_context: connection.prepare(`UPDATE research_resource_context_snapshots SET context_entry_id = NULL WHERE id = ? AND context_entry_id IS NOT NULL`),
    activity: connection.prepare(`UPDATE research_activity_snapshots SET logical_page_id = NULL, activity_date = NULL WHERE id = ? AND logical_page_id IS NOT NULL`),
    relation: connection.prepare(`UPDATE research_relation_snapshots SET relation_id = NULL WHERE id = ? AND relation_id IS NOT NULL`),
  } as const;
  const selectActiveJobsForRuns = connection.prepare(`
    SELECT job.id, job.status, job.event_sequence, job.updated_at
    FROM ai_jobs AS job JOIN research_runs AS run ON run.job_id = job.id
    WHERE run.id = ? AND job.status IN ('queued', 'running')
      AND job.cancellation_requested_at IS NULL
    ORDER BY job.id
  `);
  const insertPrivacyCancellation = connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status,
      cancellation_requested_by, occurred_at
    ) VALUES (@jobId, @sequenceNo, @eventType, @fromStatus, @toStatus, 'user', @occurredAt)
  `);
  const deleteRunPayloadById = connection.prepare(`
    DELETE FROM research_run_payloads WHERE run_id = ?
  `);
  const selectLogicalPageExists = connection.prepare(`SELECT 1 FROM logical_pages WHERE id = ?`);

  function parseApproved(value: unknown): ResearchApprovedDraft {
    const parsed = researchApprovedDraftSchema.safeParse(value);
    if (!parsed.success) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid approved research draft");
    }
    return parsed.data;
  }

  function parsePublication(value: unknown): ResearchPublicationDraft {
    const parsed = researchPublicationDraftSchema.safeParse(value);
    if (!parsed.success) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research publication draft");
    }
    return parsed.data;
  }

  function assertCapturedSource(source: ResearchApprovedDraft["sources"][number]): void {
    if (source.inclusionState === "missing" || source.inclusionState === "failed") return;
    const current = selectCurrentContent.get(source.tabId) as CurrentContentRow | undefined;
    if (current === undefined || current.logical_page_id !== source.logicalPageId ||
        current.content_revision !== source.contentRevision || current.text === null ||
        current.extracted_at !== source.extractedAt ||
        contentDigestV1(current.text) !== source.contentDigest ||
        source.payload !== null && (current.url !== source.payload.url ||
          (current.title ?? "") !== source.payload.title)) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Captured research source changed");
    }
  }

  function assertEvidence(
    evidence: ResearchEvidenceDraft,
    runId: number,
    sources: ReadonlyMap<number, SourceRow>,
    sourcePayloads: Map<number, SourcePayloadRow | undefined>,
    snapshotIdentities: Map<string, SnapshotIdentityRow | undefined>,
    snapshotPayloads: Map<string, SnapshotPayloadRow | undefined>,
  ): void {
    if (evidence.kind === "tab_content") {
      const source = sources.get(evidence.sourceId);
      if (!sourcePayloads.has(evidence.sourceId)) {
        sourcePayloads.set(
          evidence.sourceId,
          selectSourcePayload.get(evidence.sourceId) as SourcePayloadRow | undefined,
        );
      }
      const payload = sourcePayloads.get(evidence.sourceId);
      let chunkManifest: unknown;
      if (payload !== undefined) {
        try {
          chunkManifest = JSON.parse(payload.chunk_manifest_json);
        } catch {
          chunkManifest = undefined;
        }
      }
      const parsedChunkManifest = researchCapturedTextChunkManifestSchema.safeParse(chunkManifest);
      if (source?.run_id !== runId || source.inclusion_state !== "included" ||
          payload === undefined || !parsedChunkManifest.success ||
          canonicalJson(parsedChunkManifest.data) !== payload.chunk_manifest_json ||
          parsedChunkManifest.data.byteEnd !== Buffer.byteLength(payload.evidence_material, "utf8") ||
          parsedChunkManifest.data.chunkDigest !== sha256(payload.evidence_material) ||
          sha256(payload.evidence_material) !== payload.payload_digest ||
          parsedChunkManifest.data.byteStart !== 0) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research evidence is unavailable");
      }
      const bytes = Buffer.from(payload.evidence_material, "utf8");
      const { byteStart, byteEnd } = evidence.locator;
      if (byteStart >= byteEnd || byteEnd > bytes.byteLength) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research evidence range is invalid");
      }
      const excerptBytes = bytes.subarray(byteStart, byteEnd);
      try {
        const excerpt = fatalUtf8Decoder.decode(excerptBytes);
        if (excerpt.length === 0 ||
            createHash("sha256").update(excerptBytes).digest("hex") !== evidence.excerptHash) {
          throw new DurableAiJobError("INVALID_JOB_INPUT", "Research evidence hash is invalid");
        }
      } catch (error) {
        if (error instanceof DurableAiJobError) throw error;
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research evidence UTF-8 range is invalid");
      }
      return;
    }
    const snapshotKey = `${evidence.kind}:${evidence.snapshotId}`;
    if (!snapshotIdentities.has(snapshotKey)) {
      snapshotIdentities.set(
        snapshotKey,
        selectSnapshotRun[evidence.kind].get(evidence.snapshotId) as
          SnapshotIdentityRow | undefined,
      );
      snapshotPayloads.set(
        snapshotKey,
        selectSnapshotPayload.get(evidence.kind, evidence.snapshotId) as
          SnapshotPayloadRow | undefined,
      );
    }
    const snapshot = snapshotIdentities.get(snapshotKey);
    const payload = snapshotPayloads.get(snapshotKey);
    if (snapshot?.run_id !== runId || payload === undefined) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Research evidence is unavailable");
    }
    let parsedMaterial: unknown;
    try {
      parsedMaterial = JSON.parse(payload.material_json);
    } catch {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Research snapshot material is invalid");
    }
    if (canonicalJson(parsedMaterial) !== payload.material_json ||
        sha256(payload.material_json) !== snapshot.snapshot_digest ||
        sha256(payload.material_json) !== evidence.excerptHash) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Research snapshot evidence is invalid");
    }
  }

  type SnapshotKind = "page_context" | "resource_context" | "activity" | "relation";
  type PrivacyResult = {
    readonly sources: number;
    readonly snapshots: number;
    readonly evidence: number;
    readonly reports: number;
    readonly runs: number;
    readonly cancelledJobs: number;
  };

  const redactResearchTransaction = connection.transaction((rawInput: ResearchPrivacyRequest):
  PrivacyResult => {
    const parsed = researchPrivacyRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research privacy request");
    }
    const input = parsed.data;
    const requestFingerprint = sha256(canonicalJson(input));
    const receipt = selectRedactionReceipt.get(input.idempotencyKey) as
      { request_fingerprint: string; result_json: string } | undefined;
    if (receipt !== undefined) {
      if (receipt.request_fingerprint !== requestFingerprint) {
        throw new DurableAiJobError(
          "IDEMPOTENCY_KEY_CONFLICT", "Research privacy key belongs to another request",
        );
      }
      return JSON.parse(receipt.result_json) as PrivacyResult;
    }

    const runIds = new Set<number>();
    const sourceIds = new Set<number>();
    const snapshots = new Map<string, { readonly kind: SnapshotKind; readonly id: number }>();
    const reportIds = new Set<number>();
    let privacyTargetType: ResearchPrivacyRequest["target"]["type"];
    let privacyTargetKey: string;

    const addRun = (id: number): void => { runIds.add(id); };
    const addSnapshot = (kind: SnapshotKind, id: number): void => {
      snapshots.set(`${kind}:${id}`, { kind, id });
    };
    switch (input.target.type) {
      case "source": {
        privacyTargetType = "source";
        privacyTargetKey = String(input.target.sourceId);
        const row = selectSourceIdentity.get(input.target.sourceId) as
          { id: number; run_id: number } | undefined;
        if (row === undefined) {
          throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Research source does not exist");
        }
        addRun(row.run_id);
        sourceIds.add(row.id);
        for (const item of selectReportsUsingSource.all(row.id) as Array<{ report_id: number }>) {
          reportIds.add(item.report_id);
        }
        break;
      }
      case "snapshot": {
        privacyTargetType = "snapshot";
        privacyTargetKey = `${input.target.kind}:${input.target.snapshotId}`;
        const row = selectSnapshotIdentity[input.target.kind].get(input.target.snapshotId) as
          { id: number; run_id: number } | undefined;
        if (row === undefined) {
          throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Research snapshot does not exist");
        }
        addRun(row.run_id);
        addSnapshot(input.target.kind, row.id);
        for (const item of selectReportsUsingSnapshot.all(
          input.target.kind, row.id, input.target.kind, row.id,
          input.target.kind, row.id, input.target.kind, row.id,
        ) as Array<{ report_id: number }>) reportIds.add(item.report_id);
        break;
      }
      case "report": {
        privacyTargetType = "report";
        privacyTargetKey = String(input.target.reportId);
        const row = selectReportIdentity.get(input.target.reportId) as
          { id: number; run_id: number } | undefined;
        if (row === undefined) {
          throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Research report does not exist");
        }
        addRun(row.run_id);
        reportIds.add(row.id);
        for (const source of selectSourcesForRuns.all(row.run_id) as Array<{ id: number }>) {
          sourceIds.add(source.id);
        }
        for (const snapshot of selectSnapshotsForRuns.all(
          row.run_id, row.run_id, row.run_id, row.run_id,
        ) as Array<{ kind: SnapshotKind; id: number }>) addSnapshot(snapshot.kind, snapshot.id);
        break;
      }
      case "logical_page": {
        privacyTargetType = "logical_page";
        privacyTargetKey = String(input.target.logicalPageId);
        if (selectLogicalPageExists.get(input.target.logicalPageId) === undefined) {
          throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Logical page does not exist");
        }
        for (const row of selectResearchRunIds.logical_page.all(
          input.target.logicalPageId, input.target.logicalPageId, input.target.logicalPageId,
        ) as Array<{ id: number }>) addRun(row.id);
        break;
      }
      case "target": {
        privacyTargetType = "target";
        privacyTargetKey = targetKey(input.target.target);
        const targetRuns = selectResearchRunIds.target.all(privacyTargetKey) as
          Array<{ id: number }>;
        const target = input.target.target;
        if (target.type === "selection") {
          const expected = sha256(researchSelectionFingerprintPayload(target.logicalPageIds));
          const found = selectResearchSelectionPages.all(
            JSON.stringify(target.logicalPageIds),
          ) as Array<{ id: number }>;
          if (expected !== target.fingerprint || found.length !== target.logicalPageIds.length) {
            throw new ResearchBoundaryError(
              "RESEARCH_SELECTION_INVALID", "Research selection target is invalid",
            );
          }
        }
        if (targetRuns.length === 0) {
          const targetExists = target.type === "page"
            ? selectLogicalPageExists.get(target.logicalPageId) !== undefined
            : target.type === "resource"
              ? selectCurrentResearchResourceExists.get(target.resourceId) !== undefined
              : true;
          if (!targetExists) {
            throw new ResearchBoundaryError(
              "RESEARCH_TARGET_NOT_FOUND", "Research target does not exist",
            );
          }
        }
        for (const row of targetRuns) {
          addRun(row.id);
        }
        break;
      }
    }

    if (input.target.type === "logical_page" || input.target.type === "target") {
      for (const runId of runIds) {
        for (const row of selectSourcesForRuns.all(runId) as Array<{ id: number }>) {
          sourceIds.add(row.id);
        }
        for (const row of selectReportsForRuns.all(runId) as Array<{ id: number }>) {
          reportIds.add(row.id);
        }
        for (const row of selectSnapshotsForRuns.all(
          runId, runId, runId, runId,
        ) as Array<{ kind: SnapshotKind; id: number }>) addSnapshot(row.kind, row.id);
      }
    }

    const occurredAt = clock().toISOString();
    insertPrivacyRequest.run(
      input.idempotencyKey, requestFingerprint, privacyTargetType, privacyTargetKey,
      input.reason, occurredAt,
    );
    for (const runId of [...runIds].sort((left, right) => left - right)) {
      insertPrivacyRunBinding.run(input.idempotencyKey, runId);
    }
    const bindPrivacyEvent = (
      childType: "source" | "snapshot" | "evidence" | "report",
      childKey: string,
    ): string => {
      const eventKey = privacyChildEventKey(input.idempotencyKey, childType, childKey);
      insertPrivacyEventBinding.run(eventKey, input.idempotencyKey, childType, childKey);
      return eventKey;
    };

    let cancelledJobs = 0;
    for (const runId of runIds) {
      for (const job of selectActiveJobsForRuns.all(runId) as Array<{
        id: number;
        status: "queued" | "running";
        event_sequence: number;
        updated_at: string;
      }>) {
        const eventAt = occurredAt < job.updated_at ? job.updated_at : occurredAt;
        insertPrivacyCancellation.run({
          jobId: job.id,
          sequenceNo: job.event_sequence + 1,
          eventType: job.status === "queued" ? "cancelled" : "cancel_requested",
          fromStatus: job.status,
          toStatus: job.status === "queued" ? "cancelled" : "running",
          occurredAt: eventAt,
        });
        cancelledJobs += 1;
      }
    }

    const evidenceRows = new Map<number, {
      readonly id: number;
      readonly report_id: number;
      readonly state: "valid" | "invalid" | "redacted";
    }>();
    const collectEvidence = (parameters: {
      readonly reportId: number | null;
      readonly sourceId: number | null;
      readonly snapshotKind: SnapshotKind | null;
      readonly snapshotId: number | null;
    }): void => {
      for (const row of selectEvidenceForPrivacy.all(parameters) as Array<{
        id: number;
        report_id: number;
        state: "valid" | "invalid" | "redacted";
      }>) {
        evidenceRows.set(row.id, row);
        reportIds.add(row.report_id);
      }
    };
    for (const reportId of reportIds) collectEvidence({
      reportId, sourceId: null, snapshotKind: null, snapshotId: null,
    });
    for (const sourceId of sourceIds) collectEvidence({
      reportId: null, sourceId, snapshotKind: null, snapshotId: null,
    });
    for (const snapshot of snapshots.values()) collectEvidence({
      reportId: null, sourceId: null,
      snapshotKind: snapshot.kind, snapshotId: snapshot.id,
    });
    for (const evidence of evidenceRows.values()) {
      if (evidence.state !== "redacted") {
        const eventKey = bindPrivacyEvent("evidence", String(evidence.id));
        insertRedactedEvidenceEvent.run(
          evidence.id,
          selectEvidenceEventSequence.pluck().get(evidence.id),
          input.reason,
          eventKey,
          occurredAt,
        );
      }
      deleteEvidencePayload.run(evidence.id);
    }
    for (const reportId of [...reportIds].sort((left, right) => left - right)) {
      const head = selectReportHead.get(reportId) as { state: string } | undefined;
      if (head?.state !== "redacted") {
        const eventKey = bindPrivacyEvent("report", String(reportId));
        insertRedactedReportEvent.run(
          reportId,
          selectReportEventSequence.pluck().get(reportId),
          input.reason,
          eventKey,
          occurredAt,
        );
      }
    }
    for (const snapshot of snapshots.values()) {
      const head = selectSnapshotHead.get(snapshot.kind, snapshot.id) as
        { state: string } | undefined;
      if (head?.state !== "redacted") {
        const childKey = `${snapshot.kind}:${snapshot.id}`;
        const eventKey = bindPrivacyEvent("snapshot", childKey);
        insertRedactedSnapshotEvent.run(
          snapshot.kind,
          snapshot.id,
          selectSnapshotEventSequence.pluck().get(snapshot.kind, snapshot.id),
          input.reason,
          eventKey,
          occurredAt,
        );
      }
      deleteSnapshotPayload.run(snapshot.kind, snapshot.id);
      clearSnapshotLive[snapshot.kind].run(snapshot.id);
    }
    for (const sourceId of [...sourceIds].sort((left, right) => left - right)) {
      const source = selectSourceForRedaction.get(sourceId) as
        { state: "valid" | "invalid" | "redacted" } | undefined;
      if (source?.state !== "redacted") {
        const eventKey = bindPrivacyEvent("source", String(sourceId));
        insertRedactedSourceEvent.run(
          sourceId,
          selectSourceEventSequence.pluck().get(sourceId),
          input.reason,
          eventKey,
          occurredAt,
        );
      }
      deleteSourcePayload.run(sourceId);
      clearLiveSourceTab.run(sourceId);
    }
    for (const reportId of reportIds) {
      deleteReportPayload.run(reportId);
      deleteClaimPayloads.run(reportId);
    }
    for (const runId of runIds) deleteRunPayloadById.run(runId);
    const result: PrivacyResult = {
      sources: sourceIds.size,
      snapshots: snapshots.size,
      evidence: evidenceRows.size,
      reports: reportIds.size,
      runs: runIds.size,
      cancelledJobs,
    };
    insertRedactionReceipt.run(
      input.idempotencyKey, requestFingerprint, privacyTargetType, privacyTargetKey,
      canonicalJson(result), occurredAt,
    );
    return result;
  });

  const adapter: ResearchLedgerAdapter = {
    connection,

    prepareSubmission(task, requestValue) {
      const request = requestValue as ResearchApprovalRequest;
      if (task.workflowRef.id !== request.workflowRef.id ||
          task.workflowRef.version !== request.workflowRef.version ||
          canonicalJson(task.budget) !== canonicalJson(request.budget)) {
        throw new DurableAiJobError(
          "RESEARCH_PREFLIGHT_STALE",
          "Research approval fingerprint is stale",
        );
      }
      if (request.parentReportId !== null) {
        const parent = selectParentReport.get(request.parentReportId) as
          { target_key: string; state: string } | undefined;
        if (parent === undefined) {
          throw new ResearchBoundaryError(
            "RESEARCH_PARENT_NOT_FOUND", "Parent research report does not exist",
          );
        }
        if (parent.target_key !== targetKey(request.target) ||
            parent.state === "redacted" || parent.state === "superseded") {
          throw new ResearchBoundaryError(
            "RESEARCH_PARENT_UNAVAILABLE",
            "Parent research report is unavailable for this target",
          );
        }
      }
      const c81 = request.workflowRef.id === "research_workflow:c81:v1" &&
        request.workflowRef.version === 1;
      const currentProjection = c81
        ? buildCurrentResearchProjection(connection, request, { clock })
        : null;
      const prepared = currentProjection?.draft ?? buildCurrentDraft(request);
      if (c81) {
        const currentPreflight = projectResearchPreflight({
          version: 1,
          target: request.target,
          question: request.question,
          includeShareableContext: request.scope.includeShareableContext,
          maxIncludedSources: request.scope.maxIncludedSources,
          parentReportId: request.parentReportId,
          budget: request.budget,
          captureIntent: request.captureIntent,
          confirmedOrigins: {
            authenticatedOriginDigests:
              request.scope.privacyConfirmation.authenticatedOriginDigests,
            sensitiveOriginDigests:
              request.scope.privacyConfirmation.sensitiveOriginDigests,
          },
        }, currentProjection!);
        if (canonicalJson(request.scope.privacyConfirmation) !==
            canonicalJson(prepared.scope.privacyConfirmation) ||
            canonicalJson(request.estimate) !== canonicalJson(prepared.estimate) ||
            currentPreflight.approvalFingerprint !== request.approvalFingerprint) {
          throw new DurableAiJobError(
            "RESEARCH_PREFLIGHT_STALE", "Research approval fingerprint is stale",
          );
        }
        if (!researchEstimateFitsBudgetV1(prepared.estimate, prepared.budget)) {
          throw new DurableAiJobError(
            "INVALID_JOB_INPUT", "Research estimate exceeds the approved budget",
          );
        }
        if (!prepared.sources.some((source) => source.inclusionState === "included")) {
          throw new DurableAiJobError(
            "RESEARCH_CAPTURE_REQUIRED", "Research requires at least one captured source",
          );
        }
      }
      const computedApproval = c81
        ? request.approvalFingerprint
        : fingerprintResearchApproval(prepared);
      if (computedApproval !== request.approvalFingerprint ||
          computedApproval !== task.inputFingerprint) {
        throw new DurableAiJobError(
          "RESEARCH_PREFLIGHT_STALE", "Research approval fingerprint is stale",
        );
      }
      return prepared;
    },

    assertSubmission(jobId, task, rawDraft) {
      const draft = parseApproved(rawDraft);
      assertTargetMatchesTask(task, draft);
      const run = selectRun.get(jobId) as RunRow | undefined;
      if (run === undefined || run.submission_fingerprint !== submissionFingerprint(task, draft) ||
          run.corpus_fingerprint !== draft.corpusFingerprint ||
          run.approval_fingerprint !== draft.approvalFingerprint) {
        throw new DurableAiJobError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Idempotent research submission has different approved corpus",
        );
      }
    },

    insertSubmission(jobId, task, rawDraft, occurredAt) {
      const draft = parseApproved(rawDraft);
      assertTargetMatchesTask(task, draft);
      for (const source of draft.sources) assertCapturedSource(source);
      const sourceBytes = draft.sources.reduce((sum, source) => sum +
        Buffer.byteLength(source.payload?.evidenceMaterial ?? "", "utf8"), 0);
      if (sourceBytes > MAX_CORPUS_BYTES) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research corpus exceeds 4 MiB");
      }
      const result = insertRun.run({
        jobId,
        targetLogicalPageId: draft.target.type === "page" ? draft.target.logicalPageId : null,
        targetResourceId: draft.target.type === "resource" ? draft.target.resourceId : null,
        targetSelection: draft.target.type === "selection" ? 1 : 0,
        selectionFingerprint: draft.target.type === "selection" ? draft.target.fingerprint : null,
        targetKey: targetKey(draft.target),
        questionDigest: sha256(draft.question),
        scopeJson: canonicalJson(draft.scope),
        approvalFingerprint: draft.approvalFingerprint,
        corpusFingerprint: draft.corpusFingerprint,
        submissionFingerprint: submissionFingerprint(task, draft),
        workflowId: draft.workflowRef.id,
        workflowVersion: draft.workflowRef.version,
        parentReportId: draft.parentReportId,
        maxSteps: draft.budget.maxSteps,
        maxTokens: draft.budget.maxTokens,
        maxCostUsd: draft.budget.maxCostUsd,
        maxWallTimeMs: draft.budget.maxWallTimeMs,
        createdAt: occurredAt,
      });
      const runId = Number(result.lastInsertRowid);
      insertRunPayload.run(runId, draft.question, canonicalJson(draft.scope));
      if (draft.target.type === "selection") {
        draft.target.logicalPageIds.forEach((pageId, index) => {
          insertSelection.run(runId, pageId, index + 1);
        });
      }
      for (const source of draft.sources) {
        const sourceResult = insertSource.run({
          runId,
          ordinal: source.ordinal,
          logicalPageId: source.logicalPageId,
          tabId: source.tabId,
          capturedTabIdSnapshot: source.tabId,
          contentRevision: source.contentRevision,
          contentDigest: source.contentDigest,
          extractedAt: source.extractedAt,
          acquisitionMethod: source.acquisitionMethod,
          accessClass: source.accessClass,
          eligibility: source.eligibility,
          inclusionState: source.inclusionState,
          exclusionReason: "exclusionReason" in source ? source.exclusionReason : null,
          includedOrder: source.includedOrder,
          failureCode: "failureCode" in source ? source.failureCode : null,
          createdAt: occurredAt,
        });
        const sourceId = Number(sourceResult.lastInsertRowid);
        insertSourceEvent.run(sourceId, `submit:${jobId}:source:${source.ordinal}`, occurredAt);
        if (source.payload !== null) {
          insertSourcePayload.run(
            sourceId,
            source.payload.url,
            source.payload.title,
            source.payload.evidenceMaterial,
            canonicalJson(source.payload.chunkManifest),
            sha256(source.payload.evidenceMaterial),
          );
        }
      }
      for (const snapshot of draft.snapshots ?? []) {
        const materialJson = canonicalJson(snapshot.material);
        if (sha256(materialJson) !== snapshot.snapshotDigest) {
          throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Snapshot digest mismatch");
        }
        const snapshotResult = snapshot.kind === "page_context"
          ? insertSnapshot.page_context.run(runId, snapshot.contextEntryId,
              snapshot.logicalPageId, snapshot.contextEntryId, snapshot.snapshotDigest, occurredAt)
          : snapshot.kind === "resource_context"
            ? insertSnapshot.resource_context.run(runId, snapshot.contextEntryId,
                snapshot.resourceId, snapshot.contextEntryId, snapshot.snapshotDigest, occurredAt)
            : snapshot.kind === "activity"
              ? insertSnapshot.activity.run(runId, snapshot.logicalPageId,
                  snapshot.activityDate, snapshot.logicalPageId, snapshot.activityDate,
                  snapshot.snapshotDigest, occurredAt)
              : insertSnapshot.relation.run(runId, snapshot.relationId,
                  snapshot.relationId, snapshot.snapshotDigest, occurredAt);
        const snapshotId = Number(snapshotResult.lastInsertRowid);
        insertSnapshotEvent.run(snapshot.kind, snapshotId,
          `submit:${jobId}:snapshot:${snapshot.ordinal}`, occurredAt);
        insertSnapshotPayload.run(snapshot.kind, snapshotId, materialJson);
      }
      insertRunEvent.run(runId, 1, "queued", "queued", null, `submit:${jobId}`, occurredAt);
      return { runId, corpusFingerprint: draft.corpusFingerprint };
    },

    publish(jobId, rawDraft, occurredAt) {
      const draft = parsePublication(rawDraft);
      const run = selectRun.get(jobId) as RunRow | undefined;
      if (run === undefined || run.corpus_fingerprint !== draft.corpusFingerprint ||
          run.approval_fingerprint !== draft.inputFingerprint) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research run/corpus mismatch");
      }
      const sourceRows = selectRunSources.all(run.id) as SourceRow[];
      const sources = new Map(sourceRows.map((source) => [source.id, source]));
      for (const sourceId of draft.usedSourceIds) {
        const source = sources.get(sourceId);
        if (source === undefined) {
          throw new DurableAiJobError("INVALID_JOB_INPUT", "Used source is outside approved corpus");
        }
        const publicationSource: ResearchPublicationSourceIdentity = {
          sourceId: source.id,
          runId: source.run_id,
          ordinal: source.ordinal,
          logicalPageId: source.logical_page_id,
          tabId: source.tab_id,
          capturedTabIdSnapshot: source.captured_tab_id_snapshot,
          contentRevision: source.content_revision,
          contentDigest: source.content_digest,
          extractedAt: source.extracted_at,
          sourceKind: source.source_kind,
          acquisitionMethod: source.acquisition_method,
          handoffSourceReceiptId: source.handoff_source_receipt_id,
          accessClass: source.access_class_snapshot,
          eligibility: source.eligibility,
          inclusionState: source.inclusion_state,
          includedOrder: source.included_order,
        };
        if (source.source_kind === "live_acquisition") {
          const identity = selectLivePublicationIdentity?.get(source.id) as {
            handoff_source_receipt_id: number;
            receipt_digest: string;
            final_run_id: number;
            ordinal: number;
            logical_page_id: number;
            logical_page_generation_id: number;
            generation_token: string;
            target_generation_logical_page_id: number | null;
            content_revision: number;
            content_digest: string;
            extracted_at: string;
            inclusion_state: string;
            included_order: number | null;
            payload_digest: string;
            target_generation_active: number;
            handoff_status: string;
            handoff_completed_at: string | null;
            terminal_completed_at: string;
            handoff_terminal: number;
          } | undefined;
          assertResearchPublicationSourceIdentity(publicationSource,
            identity === undefined || identity.content_revision !== 1 ||
                identity.target_generation_active !== 1 || identity.handoff_terminal !== 1 ||
                identity.inclusion_state !== "included" || identity.included_order === null ||
                identity.handoff_status !== "completed" ||
                identity.handoff_completed_at === null ||
                identity.target_generation_logical_page_id === null
              ? undefined
              : {
                  kind: "live_acquisition",
                  handoffSourceReceiptId: identity.handoff_source_receipt_id,
                  receiptDigest: identity.receipt_digest,
                  finalRunId: identity.final_run_id,
                  ordinal: identity.ordinal,
                  logicalPageId: identity.logical_page_id,
                  logicalPageGenerationId: identity.logical_page_generation_id,
                  logicalPageGenerationToken: identity.generation_token,
                  targetGenerationLogicalPageId: identity.target_generation_logical_page_id,
                  contentRevision: 1,
                  contentDigest: identity.content_digest,
                  extractedAt: identity.extracted_at,
                  payloadDigest: identity.payload_digest,
                  inclusionState: "included",
                  includedOrder: identity.included_order,
                  targetGenerationActive: true,
                  handoffStatus: "completed",
                  handoffCompletedAt: identity.handoff_completed_at,
                  terminalCompletedAt: identity.terminal_completed_at,
                  handoffTerminal: true,
                });
        } else {
          const current = source.tab_id === null ? undefined :
            selectCurrentContent.get(source.tab_id) as CurrentContentRow | undefined;
          assertResearchPublicationSourceIdentity(publicationSource,
            current === undefined || current.text === null || current.content_revision === null
              ? undefined
              : {
                  logicalPageId: current.logical_page_id,
                  contentRevision: current.content_revision,
                  contentDigest: contentDigestV1(current.text),
                });
        }
      }
      const coverage: ResearchCoverage = {
        discovered: sourceRows.length,
        captured: sourceRows.filter((source) =>
          source.inclusion_state === "included" || source.inclusion_state === "excluded").length,
        eligible: sourceRows.filter((source) => source.eligibility === "eligible").length,
        used: draft.usedSourceIds.length,
        missing: sourceRows.filter((source) => source.inclusion_state === "missing").length,
        failed: sourceRows.filter((source) => source.inclusion_state === "failed").length,
      };
      if (canonicalJson(coverage) !== canonicalJson(draft.coverage)) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Research coverage does not match corpus");
      }
      const evidenceSourceIds = new Set<number>();
      const sourcePayloads = new Map<number, SourcePayloadRow | undefined>();
      const snapshotIdentities = new Map<string, SnapshotIdentityRow | undefined>();
      const snapshotPayloads = new Map<string, SnapshotPayloadRow | undefined>();
      for (const claim of draft.claims) {
        for (const evidence of claim.evidence) {
          assertEvidence(
            evidence,
            run.id,
            sources,
            sourcePayloads,
            snapshotIdentities,
            snapshotPayloads,
          );
          if (evidence.kind === "tab_content") evidenceSourceIds.add(evidence.sourceId);
        }
      }
      const derivedUsedSourceIds = [...evidenceSourceIds].sort((left, right) => left - right);
      if (canonicalJson(derivedUsedSourceIds) !== canonicalJson(draft.usedSourceIds)) {
        throw new DurableAiJobError(
          "INVALID_JOB_INPUT", "Used research sources do not match evidence",
        );
      }
      const version = selectNextReportVersion.pluck().get(run.target_key) as number;
      const coverageJson = canonicalJson(coverage);
      const reportResult = insertReport.run({
        runId: run.id,
        targetLogicalPageId: run.target_logical_page_id,
        targetResourceId: run.target_resource_id,
        selectionFingerprint: run.selection_fingerprint,
        targetKey: run.target_key,
        version,
        parentReportId: run.parent_report_id,
        publishStatus: draft.status,
        coverageJson,
        coverageFingerprint: sha256(coverageJson),
        provenanceJson: canonicalJson(draft.provenance),
        inputFingerprint: draft.inputFingerprint,
        createdAt: occurredAt,
      });
      const reportId = Number(reportResult.lastInsertRowid);
      const reportText = renderResearchReportText(draft.dossier, draft.claims);
      const structuredJson = canonicalJson(draft.dossier);
      insertReportPayload.run(
        reportId,
        reportText,
        structuredJson,
        sha256(canonicalJson({ text: reportText, dossier: draft.dossier })),
      );
      draft.usedSourceIds.forEach((sourceId, index) => {
        insertReportSource.run(reportId, sourceId, index + 1);
      });
      draft.claims.forEach((claim, claimIndex) => {
        const claimResult = insertClaim.run(
          reportId,
          claimIndex + 1,
          sha256(claim.claim),
          claim.confidence,
          claim.isInference ? 1 : 0,
          claim.rationale === null ? null : sha256(claim.rationale),
        );
        const claimId = Number(claimResult.lastInsertRowid);
        insertClaimPayload.run(claimId, claim.claim, claim.rationale);
        claim.evidence.forEach((evidence, evidenceIndex) => {
          const evidenceResult = insertEvidence.run(
            claimId,
            reportId,
            run.id,
            evidenceIndex + 1,
            evidence.kind,
            evidence.kind === "tab_content" ? evidence.sourceId : null,
            evidence.kind === "page_context" ? evidence.snapshotId : null,
            evidence.kind === "resource_context" ? evidence.snapshotId : null,
            evidence.kind === "activity" ? evidence.snapshotId : null,
            evidence.kind === "relation" ? evidence.snapshotId : null,
            sha256(canonicalJson(evidence.locator)),
            evidence.excerptHash,
          );
          const evidenceId = Number(evidenceResult.lastInsertRowid);
          insertEvidencePayload.run(evidenceId, canonicalJson(evidence.locator));
          insertEvidenceEvent.run(
            evidenceId,
            `publish:${reportId}:evidence:${claimIndex + 1}:${evidenceIndex + 1}`,
            occurredAt,
          );
        });
      });
      insertReportEvent.run(
        reportId,
        draft.status === "succeeded" ? "fresh" : "stale",
        draft.reason,
        `publish:${reportId}`,
        occurredAt,
      );
      insertRunEvent.run(
        run.id,
        selectRunEventSequence.pluck().get(run.id),
        draft.status,
        draft.status,
        reportId,
        `publish:${jobId}`,
        occurredAt,
      );
      return { reportId, status: draft.status };
    },

    redactResearch(input) {
      return redactResearchTransaction.immediate(input);
    },
  };
  return Object.freeze(adapter);
}
