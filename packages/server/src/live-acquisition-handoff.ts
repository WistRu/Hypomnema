import { createHash } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  aiTaskSpecSchema,
  estimateResearchReservationV1,
  researchApprovedDraftSchema,
  researchCanonicalSha256PayloadV1,
  type ResearchApprovedDraftInput,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import type Database from "better-sqlite3";

import type { AiJobClaim } from "./ai-job-ledger.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import type { ResearchProvider, ResearchProviderQuote } from "./research-provider.js";
import { fingerprintResearchApproval, fingerprintResearchCorpus } from "./research-store.js";

interface HandoffOptions {
  readonly provider: ResearchProvider;
  readonly clock?: () => Date;
  /** Test-only deterministic rollback point; never invokes caller code in a transaction. */
  readonly faultPhase?: "after_supersede" | "after_final_run" |
    "after_sources" | "after_reservation";
}

interface HandoffCounters {
  readonly reservedPages: number;
  readonly visitedPages: number;
  readonly capturedPages: number;
  readonly blockedPages: number;
  readonly ambiguousPages: number;
  readonly robotsActions: number;
  readonly networkActions: number;
}

interface SourcePlan {
  readonly kind: "captured" | "live_acquisition";
  readonly logicalPageId: number;
  readonly logicalPageGenerationId: number | null;
  readonly captureManifestId: number | null;
  readonly depth: number | null;
  readonly captureSequence: number | null;
  readonly tabId: number | null;
  readonly capturedTabIdSnapshot: number | null;
  readonly contentRevision: number;
  readonly contentDigest: string;
  readonly extractedAt: string;
  readonly acquisitionMethod: string;
  readonly accessClass: string;
  readonly url: string;
  readonly title: string;
  readonly evidence: string;
  readonly chunkManifestJson: string;
  readonly receiptManifestJson: string;
  readonly handoffSourceReceiptId: number | null;
  readonly handoffSourceReceiptDigest: string | null;
}

interface HandoffPlan {
  readonly identityDigest: string;
  readonly snapshotDigest: string;
  readonly coordinatorRunId: number;
  readonly coordinatorRunGenerationId: number;
  readonly consentId: number;
  readonly resourceGenerationId: number;
  readonly historyEpochId: number;
  readonly runtimeEpoch: number;
  readonly expiresAt: string;
  readonly resourceId: number;
  readonly targetKey: string;
  readonly question: string;
  readonly questionDigest: string;
  readonly scopeJson: string;
  readonly parentReportId: number | null;
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number;
  readonly maxWallTimeMs: number;
  readonly approvalFingerprint: string;
  readonly corpusFingerprint: string;
  readonly submissionFingerprint: string;
  readonly sources: readonly SourcePlan[];
  readonly snapshots: readonly SnapshotPlan[];
  readonly finalJobId: number;
  readonly handoffId: number;
  readonly counters: HandoffCounters;
  readonly quoteDigest: string;
  readonly quote: Readonly<ResearchProviderQuote>;
  readonly providerInputDigest: string;
}

interface SnapshotPlan {
  readonly kind: "page_context" | "resource_context" | "activity" | "relation";
  readonly values: readonly (string | number)[];
  readonly snapshotDigest: string;
  readonly materialJson: string;
}

export interface LiveAcquisitionHandoff {
  completeClaim(claim: AiJobClaim): { readonly kind: "handoff"; readonly finalJobId: number } |
    { readonly kind: "no_eligible_source" };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createLiveAcquisitionHandoff(
  connection: Database.Database,
  options: HandoffOptions,
): LiveAcquisitionHandoff {
  const clock = options.clock ?? (() => new Date());

  function currentRulesetDigest(): string {
    const event = connection.prepare(`SELECT event.id, event.version
      FROM resource_ruleset_heads AS head JOIN resource_ruleset_events AS event
        ON event.id=head.ruleset_event_id WHERE head.scope='global'`).get() as
      { id: number; version: number } | undefined;
    if (event === undefined) throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE",
      "Live handoff ruleset is unavailable");
    const rules = connection.prepare(`SELECT rule.rule_key, rule.version,
      rule.host_pattern, rule.path_prefix, rule.priority, rule.enabled, rule.resource_id
      FROM resource_match_rule_heads AS head JOIN resource_match_rules AS rule
        ON rule.id=head.rule_id ORDER BY rule.rule_key`).all();
    return sha256(canonicalJson({ eventId: event.id, version: event.version, rules }));
  }

  function readCounters(consentId: number, attemptId: number,
    requireCaptured = false): HandoffCounters {
    const row = connection.prepare(`SELECT
      COALESCE(SUM(CASE WHEN action.action_kind='page' AND reservation.id IS NOT NULL THEN 1 ELSE 0 END),0) reserved_pages,
      COALESCE(SUM(CASE WHEN action.action_kind='page' AND (action.state='completed' OR EXISTS (
        SELECT 1 FROM live_acquisition_action_events AS terminal_event
        WHERE terminal_event.action_id=action.id
          AND terminal_event.to_state IN ('blocked','ambiguous')
          AND json_extract(terminal_event.safe_details_json,'$.response_class')='success')) THEN 1 ELSE 0 END),0) visited_pages,
      COALESCE(SUM(CASE WHEN action.action_kind='page' AND action.state='completed' THEN 1 ELSE 0 END),0) captured_pages,
      COALESCE(SUM(CASE WHEN action.action_kind='page' AND action.state='blocked' THEN 1 ELSE 0 END),0) blocked_pages,
      COALESCE(SUM(CASE WHEN action.action_kind='page' AND action.state='ambiguous' THEN 1 ELSE 0 END),0) ambiguous_pages,
      COALESCE(SUM(CASE WHEN action.action_kind='robots' AND EXISTS (SELECT 1 FROM live_acquisition_action_events e WHERE e.action_id=action.id AND e.to_state='started') THEN 1 ELSE 0 END),0) robots_actions,
      COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM live_acquisition_action_events e WHERE e.action_id=action.id AND e.to_state='started') THEN 1 ELSE 0 END),0) network_actions,
      COALESCE(SUM(CASE WHEN action.state NOT IN ('completed','blocked','ambiguous') THEN 1 ELSE 0 END),0) pending_actions,
      COALESCE(SUM(CASE WHEN action.state='ambiguous' THEN 1 ELSE 0 END),0) ambiguous_actions,
      json_extract(consent.limits_json,'$.max_pages') max_pages,
      checkpoint.checkpoint_json
      FROM live_acquisition_consents consent
      LEFT JOIN live_acquisition_actions action ON action.consent_id=consent.id
      LEFT JOIN live_acquisition_page_reservations reservation ON reservation.action_id=action.id
      LEFT JOIN live_acquisition_checkpoints checkpoint ON checkpoint.attempt_id=?
      WHERE consent.id=? GROUP BY consent.id`).get(attemptId, consentId) as Record<string, unknown> | undefined;
    if (row === undefined || Number(row.pending_actions) !== 0 || Number(row.ambiguous_actions) !== 0) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Live handoff actions are not terminal");
    }
    const counters = { reservedPages: Number(row.reserved_pages), visitedPages: Number(row.visited_pages),
      capturedPages: Number(row.captured_pages), blockedPages: Number(row.blocked_pages),
      ambiguousPages: Number(row.ambiguous_pages), robotsActions: Number(row.robots_actions),
      networkActions: Number(row.network_actions) };
    const checkpoint = JSON.parse(String(row.checkpoint_json)) as {
      stage?: unknown; counters?: unknown; queue?: { plannedActionIds?: unknown[]; activeActionIds?: unknown[] };
    };
    const expectedStage = counters.capturedPages > 0 ? "ready_for_handoff" : "no_eligible_source";
    if ((requireCaptured && counters.capturedPages < 1) ||
        counters.capturedPages > counters.visitedPages ||
        counters.visitedPages > counters.reservedPages || counters.reservedPages > Number(row.max_pages) ||
        checkpoint.stage !== expectedStage || canonicalJson(checkpoint.counters) !== canonicalJson(counters) ||
        checkpoint.queue?.plannedActionIds?.length !== 0 || checkpoint.queue?.activeActionIds?.length !== 0) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Live handoff counters drifted");
    }
    return counters;
  }

  function currentSnapshotDigest(jobId: number): string {
    const owner = connection.prepare(`
      SELECT job.id, job.status, job.event_sequence, job.input_fingerprint,
        run.*, payload.question, consent.*, consent_payload.approved_origins_json,
        resource_generation.generation_token AS resource_generation_token,
        runtime.runtime_epoch AS current_runtime_epoch
      FROM ai_jobs AS job JOIN research_runs AS run ON run.job_id=job.id
      JOIN research_run_payloads AS payload ON payload.run_id=run.id
      JOIN live_acquisition_consents AS consent ON consent.coordinator_job_id=job.id
      JOIN live_acquisition_consent_payloads AS consent_payload ON consent_payload.consent_id=consent.id
      JOIN privacy_subject_generations AS resource_generation ON resource_generation.id=consent.resource_generation_id
      JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id=1
      WHERE job.id=?
    `).get(jobId);
    const seeds = connection.prepare(`
      SELECT source.*, head.state, payload.* FROM research_runs AS run
      JOIN research_sources AS source ON source.run_id=run.id
      JOIN research_source_heads AS head ON head.source_id=source.id
      LEFT JOIN research_source_payloads AS payload ON payload.source_id=source.id
      WHERE run.job_id=? ORDER BY source.ordinal
    `).all(jobId);
    const captures = connection.prepare(`
      SELECT action.id, action.state, action.resource_generation_id,
        action.history_epoch_id, action.runtime_epoch, manifest.*, url.exact_url,
        url.keyed_url_digest, body.body_digest, body.extracted_text,
        generation.logical_page_id, generation.generation_token,
        resolution.resource_id, resolution.source_fingerprint
      FROM live_acquisition_consents AS consent
      JOIN live_acquisition_actions AS action ON action.consent_id=consent.id
      LEFT JOIN live_acquisition_capture_manifests AS manifest ON manifest.action_id=action.id
      LEFT JOIN live_acquisition_url_payloads AS url ON url.action_id=action.id
      LEFT JOIN live_acquisition_body_payloads AS body ON body.action_id=action.id
      LEFT JOIN privacy_subject_generations AS generation ON generation.id=manifest.logical_page_generation_id
      LEFT JOIN resource_resolution_heads AS resolution_head ON resolution_head.logical_page_id=generation.logical_page_id
      LEFT JOIN resource_resolution_events AS resolution ON resolution.id=resolution_head.resolution_event_id
      WHERE consent.coordinator_job_id=? ORDER BY action.id
    `).all(jobId);
    const actionEvents = connection.prepare(`SELECT event.* FROM live_acquisition_consents consent
      JOIN live_acquisition_actions action ON action.consent_id=consent.id
      JOIN live_acquisition_action_events event ON event.action_id=action.id
      WHERE consent.coordinator_job_id=? ORDER BY action.id,event.sequence_no`).all(jobId);
    const reservations = connection.prepare(`SELECT reservation.* FROM live_acquisition_consents consent
      JOIN live_acquisition_page_reservations reservation ON reservation.consent_id=consent.id
      WHERE consent.coordinator_job_id=? ORDER BY reservation.reservation_sequence`).all(jobId);
    const checkpoints = connection.prepare(`SELECT checkpoint.* FROM live_acquisition_checkpoints checkpoint
      WHERE checkpoint.coordinator_job_id=? ORDER BY checkpoint.attempt_id`).all(jobId);
    const ruleset = connection.prepare(`
      SELECT event.id, event.version, rule.rule_key, rule.version AS rule_version,
        rule.host_pattern, rule.path_prefix, rule.priority, rule.enabled, rule.resource_id
      FROM resource_ruleset_heads AS head
      JOIN resource_ruleset_events AS event ON event.id=head.ruleset_event_id
      LEFT JOIN resource_match_rule_heads AS rule_head ON 1=1
      LEFT JOIN resource_match_rules AS rule ON rule.id=rule_head.rule_id
      WHERE head.scope='global' ORDER BY rule.rule_key
    `).all();
    const snapshots = ["page_context", "resource_context", "activity", "relation"]
      .flatMap((kind) => connection.prepare(`SELECT ? AS kind, snapshot.*,
        head.state, payload.material_json FROM research_${kind}_snapshots AS snapshot
        JOIN research_snapshot_heads AS head ON head.kind=? AND head.snapshot_id=snapshot.id
        JOIN research_snapshot_payloads AS payload ON payload.kind=? AND payload.snapshot_id=snapshot.id
        WHERE snapshot.run_id=? ORDER BY snapshot.id`).all(kind, kind, kind, jobId));
    const parent = connection.prepare(`
      SELECT report.id, report.version, report.target_key, head.state, payload.report_text
      FROM research_runs AS run
      LEFT JOIN research_reports AS report ON report.id=run.parent_report_id
      LEFT JOIN research_report_heads AS head ON head.report_id=report.id
      LEFT JOIN research_report_payloads AS payload ON payload.report_id=report.id
      WHERE run.job_id=?
    `).get(jobId);
    return sha256(canonicalJson({ owner, seeds, captures, actionEvents, reservations,
      checkpoints, ruleset, snapshots, parent }));
  }

  function precompute(claim: AiJobClaim): HandoffPlan {
    const providerMetadata = { ...options.provider.metadata };
    const snapshotDigest = currentSnapshotDigest(claim.id);
    const owner = connection.prepare(`
      SELECT job.id, run.id AS run_id, run.target_resource_id AS resource_id,
        run.target_key, run.question_digest, run.scope_json, run.parent_report_id,
        run.max_steps, job.max_tokens, job.max_cost_usd, job.max_wall_time_ms,
        payload.question, consent.id AS consent_id, consent.limits_json,
        consent.coordinator_run_generation_id, consent.resource_generation_id,
        consent.history_epoch_id, consent.runtime_epoch, consent.expires_at,
        json_extract(consent.limits_json, '$.max_output_tokens') AS max_output_tokens,
        resource_generation.generation_token AS resource_generation_digest
      FROM ai_jobs AS job
      JOIN research_runs AS run ON run.job_id = job.id
      JOIN research_run_payloads AS payload ON payload.run_id = run.id
      JOIN live_acquisition_consents AS consent ON consent.coordinator_job_id = job.id
      JOIN privacy_subject_generations AS resource_generation
        ON resource_generation.id=consent.resource_generation_id
      WHERE job.id = ? AND job.workflow_id = 'research_acquisition:c90:v1'
        AND job.workflow_version = 1
    `).get(claim.id) as {
      run_id: number; resource_id: number; target_key: string; question_digest: string;
      scope_json: string; parent_report_id: number | null; max_steps: number;
      max_tokens: number; max_cost_usd: number; max_wall_time_ms: number;
      question: string; consent_id: number; coordinator_run_generation_id: number;
      resource_generation_id: number; history_epoch_id: number; runtime_epoch: number;
      expires_at: string; max_output_tokens: number; limits_json: string;
      resource_generation_digest: string;
    } | undefined;
    if (owner === undefined) throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE",
      "Live acquisition handoff owner is unavailable");

    const counters = readCounters(owner.consent_id, claim.attemptId);
    const captured = connection.prepare(`
      SELECT source.logical_page_id, source.tab_id, source.captured_tab_id_snapshot,
        source.content_revision, source.content_digest, source.extracted_at,
        source.acquisition_method, source.access_class_snapshot,
        payload.url_snapshot, payload.title_snapshot, payload.evidence_material,
        payload.chunk_manifest_json
      FROM research_sources AS source
      JOIN research_source_heads AS head ON head.source_id = source.id AND head.state = 'valid'
      JOIN research_source_payloads AS payload ON payload.source_id = source.id
      JOIN privacy_subject_generations AS page_generation
        ON page_generation.subject_kind='logical_page'
        AND page_generation.logical_page_id=source.logical_page_id AND page_generation.is_active=1
      JOIN resource_resolution_heads AS resolution_head
        ON resolution_head.logical_page_id=source.logical_page_id
      JOIN resource_resolution_events AS resolution
        ON resolution.id=resolution_head.resolution_event_id
        AND resolution.logical_page_id=source.logical_page_id
      JOIN logical_page_resource_heads AS assignment_head
        ON assignment_head.logical_page_id=source.logical_page_id
      WHERE source.run_id = ? AND source.source_kind = 'captured'
        AND source.eligibility = 'eligible' AND source.inclusion_state = 'included'
        AND resolution.resource_id=? AND resolution.state IN ('matched','overridden')
        AND resolution.research_eligible=1 AND resolution.assignment_id=assignment_head.assignment_id
      ORDER BY source.ordinal
    `).all(owner.run_id, owner.resource_id) as Array<Record<string, unknown>>;
    const acquired = connection.prepare(`
      SELECT generation.logical_page_id, generation.id AS logical_page_generation_id,
        manifest.id AS capture_manifest_id, manifest.depth, manifest.capture_sequence,
        manifest.content_digest, manifest.created_at AS extracted_at,
        manifest.manifest_json, url.exact_url, body.extracted_text
      FROM live_acquisition_consents AS consent
      JOIN live_acquisition_actions AS action ON action.consent_id = consent.id
        AND action.state = 'completed' AND action.action_kind = 'page'
      JOIN live_acquisition_capture_manifests AS manifest ON manifest.action_id = action.id
      JOIN live_acquisition_body_payloads AS body ON body.action_id = action.id
      JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
      JOIN privacy_subject_generations AS generation
        ON generation.id = manifest.logical_page_generation_id
        AND generation.subject_kind = 'logical_page' AND generation.is_active = 1
      JOIN resource_resolution_heads AS resolution_head
        ON resolution_head.logical_page_id = generation.logical_page_id
      JOIN resource_resolution_events AS resolution ON resolution.id = resolution_head.resolution_event_id
        AND resolution.logical_page_id=generation.logical_page_id
        AND resolution.state IN ('matched','overridden') AND resolution.research_eligible=1
      JOIN logical_page_resource_heads AS assignment_head
        ON assignment_head.logical_page_id=generation.logical_page_id
        AND assignment_head.assignment_id=resolution.assignment_id
      JOIN privacy_subject_generations AS resource_generation
        ON resource_generation.id = action.resource_generation_id
        AND resource_generation.resource_id = resolution.resource_id
        AND resource_generation.is_active = 1
      WHERE consent.id = ? AND action.coordinator_run_generation_id = ?
        AND action.resource_generation_id = ? AND action.history_epoch_id = ?
      ORDER BY manifest.depth, manifest.capture_sequence, url.exact_url
      LIMIT 10000
    `).all(owner.consent_id, owner.coordinator_run_generation_id,
      owner.resource_generation_id, owner.history_epoch_id) as Array<Record<string, unknown>>;
    const snapshots: SnapshotPlan[] = [];
    const snapshotQueries = [{ kind: "page_context" as const,
      table: "research_page_context_snapshots",
      columns: ["context_entry_audit_id", "logical_page_audit_id", "context_entry_id"] },
    { kind: "resource_context" as const, table: "research_resource_context_snapshots",
      columns: ["context_entry_audit_id", "resource_audit_id", "context_entry_id"] },
    { kind: "activity" as const, table: "research_activity_snapshots",
      columns: ["logical_page_audit_id", "activity_date_audit", "logical_page_id", "activity_date"] },
    { kind: "relation" as const, table: "research_relation_snapshots",
      columns: ["relation_audit_id", "relation_id"] }];
    for (const spec of snapshotQueries) {
      const rows = (connection.prepare(`SELECT snapshot.*, payload.material_json
        FROM ${spec.table} AS snapshot
        JOIN research_snapshot_heads AS head ON head.kind=? AND head.snapshot_id=snapshot.id
          AND head.state='valid'
        JOIN research_snapshot_payloads AS payload ON payload.kind=? AND payload.snapshot_id=snapshot.id
        WHERE snapshot.run_id=? ORDER BY snapshot.id`).all(
          spec.kind, spec.kind, owner.run_id)) as Array<Record<string, unknown>>;
      for (const row of rows) snapshots.push({ kind: spec.kind,
        values: spec.columns.map((column) => row[column] as string | number),
        snapshotDigest: String(row.snapshot_digest), materialJson: String(row.material_json) });
    }

    let includedBytes = captured.reduce((total, row) =>
      total + Buffer.byteLength(String(row.evidence_material), "utf8"), 0);
    const sources: SourcePlan[] = captured.map((row) => ({
      kind: "captured", logicalPageId: Number(row.logical_page_id),
      logicalPageGenerationId: null, captureManifestId: null, depth: null,
      captureSequence: null, tabId: Number(row.tab_id),
      capturedTabIdSnapshot: Number(row.captured_tab_id_snapshot),
      contentRevision: Number(row.content_revision), contentDigest: String(row.content_digest),
      extractedAt: String(row.extracted_at), acquisitionMethod: String(row.acquisition_method),
      accessClass: String(row.access_class_snapshot), url: String(row.url_snapshot),
      title: String(row.title_snapshot ?? ""), evidence: String(row.evidence_material),
      chunkManifestJson: String(row.chunk_manifest_json), receiptManifestJson: "{}",
      handoffSourceReceiptId: null, handoffSourceReceiptDigest: null,
    }));
    for (const row of acquired.sort((left, right) =>
      Number(left.depth) - Number(right.depth) ||
      Number(left.capture_sequence) - Number(right.capture_sequence) ||
      byteCompare(String(left.exact_url), String(right.exact_url)))) {
      const evidence = String(row.extracted_text);
      const bytes = Buffer.byteLength(evidence, "utf8");
      if (sources.length >= 100 || includedBytes + bytes > 4_194_304) break;
      includedBytes += bytes;
      sources.push({
        kind: "live_acquisition", logicalPageId: Number(row.logical_page_id),
        logicalPageGenerationId: Number(row.logical_page_generation_id),
        captureManifestId: Number(row.capture_manifest_id), depth: Number(row.depth),
        captureSequence: Number(row.capture_sequence), tabId: null,
        capturedTabIdSnapshot: null, contentRevision: 1,
        contentDigest: String(row.content_digest), extractedAt: String(row.extracted_at),
        acquisitionMethod: "safe_public_http_v1", accessClass: "public",
        url: String(row.exact_url), title: String(row.exact_url), evidence,
        chunkManifestJson: canonicalJson({ version: "captured_text_chunks:v1",
          byteStart: 0, byteEnd: bytes, chunkDigest: sha256(evidence), truncated: false }),
        receiptManifestJson: String(row.manifest_json),
        handoffSourceReceiptId: null, handoffSourceReceiptDigest: null,
      });
    }
    const liveCount = sources.filter(({ kind }) => kind === "live_acquisition").length;
    if (liveCount === 0) throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE",
      counters.capturedPages > 0 ? "Live handoff acquired membership drifted" :
        "Live acquisition has no eligible terminal capture");
    const limits = JSON.parse(owner.limits_json) as Record<string, unknown>;
    if (sha256(providerMetadata.provider) !== limits.provider_digest ||
        sha256(providerMetadata.model) !== limits.model_digest ||
        sha256(providerMetadata.pricingVersion) !== limits.pricing_digest ||
        currentRulesetDigest() !== limits.ruleset_generation_digest ||
        owner.resource_generation_digest !== limits.resource_generation_digest ||
        limits.max_source_bytes !== 65_536 || limits.max_total_bytes !== 4_194_304) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE",
        "Live handoff provider identity drifted");
    }
    const finalJobId = Number(connection.prepare("SELECT COALESCE(MAX(id),0)+1 FROM ai_jobs")
      .pluck().get());
    const handoffId = Number(connection.prepare(
      "SELECT COALESCE(MAX(id),0)+1 FROM live_acquisition_handoffs").pluck().get());
    let nextReceiptId = Number(connection.prepare(
      "SELECT COALESCE(MAX(id),0)+1 FROM live_acquisition_source_receipts").pluck().get());
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      if (source.kind !== "live_acquisition") continue;
      const receiptDigest = sha256(canonicalJson({ handoffId, finalJobId,
        ordinal: index + 1, logicalPageId: source.logicalPageId,
        generationId: source.logicalPageGenerationId,
        captureManifestId: source.captureManifestId, depth: source.depth,
        captureSequence: source.captureSequence, contentDigest: source.contentDigest,
        extractedAt: source.extractedAt, manifest: source.receiptManifestJson }));
      sources[index] = { ...source, handoffSourceReceiptId: nextReceiptId,
        handoffSourceReceiptDigest: receiptDigest };
      nextReceiptId += 1;
    }
    const sourceDrafts = sources.map((source, index) => source.kind === "captured" ? {
      sourceKind: "captured" as const, ordinal: index + 1,
      logicalPageId: source.logicalPageId, tabId: source.tabId!,
      selectedTabId: source.capturedTabIdSnapshot, contentRevision: source.contentRevision,
      contentDigest: source.contentDigest, extractedAt: source.extractedAt,
      acquisitionMethod: source.acquisitionMethod as "captured" | "exact_capture",
      accessClass: source.accessClass as "public" | "authenticated" | "sensitive",
      eligibility: "eligible" as const, inclusionState: "included" as const,
      includedOrder: index + 1, payload: { url: source.url, title: source.title,
        evidenceMaterial: source.evidence, chunkManifest: JSON.parse(source.chunkManifestJson) },
    } : {
      sourceKind: "live_acquisition" as const, ordinal: index + 1,
      logicalPageId: source.logicalPageId, tabId: null, selectedTabId: null,
      contentRevision: 1 as const, contentDigest: source.contentDigest,
      extractedAt: source.extractedAt, acquisitionMethod: "safe_public_http_v1" as const,
      accessClass: "public" as const, eligibility: "eligible" as const,
      inclusionState: "included" as const, includedOrder: index + 1,
      handoffSourceReceiptId: source.handoffSourceReceiptId!,
      handoffSourceReceiptDigest: source.handoffSourceReceiptDigest!,
      payload: { url: source.url, title: source.title, evidenceMaterial: source.evidence,
        chunkManifest: JSON.parse(source.chunkManifestJson) },
    });
    const snapshotDrafts = snapshots.map((snapshot, index) => {
      const common = { kind: snapshot.kind, ordinal: index + 1,
        snapshotDigest: snapshot.snapshotDigest, material: JSON.parse(snapshot.materialJson) };
      return snapshot.kind === "page_context"
        ? { ...common, kind: snapshot.kind, contextEntryId: Number(snapshot.values[2]),
            logicalPageId: Number(snapshot.values[1]) }
        : snapshot.kind === "resource_context"
          ? { ...common, kind: snapshot.kind, contextEntryId: Number(snapshot.values[2]),
              resourceId: Number(snapshot.values[1]) }
          : snapshot.kind === "activity"
            ? { ...common, kind: snapshot.kind, logicalPageId: Number(snapshot.values[2]),
                activityDate: String(snapshot.values[3]) }
            : { ...common, kind: snapshot.kind, relationId: Number(snapshot.values[1]) };
    });
    const draftBase: Omit<ResearchApprovedDraftInput,
      "approvalFingerprint" | "corpusFingerprint"> = {
      version: 1, target: { type: "resource", resourceId: owner.resource_id },
      question: owner.question, scope: JSON.parse(owner.scope_json),
      parentReportId: owner.parent_report_id, workflowRef: {
        id: "research_workflow:c81:v1", version: 1 },
      budget: { maxSteps: owner.max_steps, maxTokens: owner.max_tokens,
        maxCostUsd: owner.max_cost_usd, maxWallTimeMs: owner.max_wall_time_ms },
      estimate: estimateResearchReservationV1({ includedSources: sourceDrafts.length,
        includedSourceBytes: sources.reduce((sum, source) =>
          sum + Buffer.byteLength(source.evidence, "utf8"), 0),
        snapshotBytes: snapshots.reduce((sum, snapshot) =>
          sum + Buffer.byteLength(snapshot.materialJson, "utf8"), 0),
        questionBytes: Buffer.byteLength(owner.question, "utf8"), budget: {
          maxSteps: owner.max_steps, maxTokens: owner.max_tokens,
          maxCostUsd: owner.max_cost_usd, maxWallTimeMs: owner.max_wall_time_ms } }),
      sources: sourceDrafts, snapshots: snapshotDrafts,
    };
    const approvalFingerprint = fingerprintResearchApproval(draftBase);
    const withApproval = { ...draftBase, approvalFingerprint };
    const corpusFingerprint = fingerprintResearchCorpus(withApproval);
    const draft = researchApprovedDraftSchema.parse({ ...withApproval, corpusFingerprint });
    const task = aiTaskSpecSchema.parse({ version: 1, kind: "resource_research",
      subject: draft.target, workflowRef: draft.workflowRef,
      inputFingerprint: approvalFingerprint, idempotencyKey: `live-handoff:${claim.id}`,
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0, budget: draft.budget }) as ResourceResearchTaskSpec;
    const { idempotencyKey: _idempotencyKey, ...taskBody } = task;
    const submissionFingerprint = sha256(canonicalJson({ task: taskBody, approvedDraft: draft }));
    const providerInput = {
      version: 1 as const,
      target: { type: "resource" as const, resourceId: owner.resource_id },
      question: owner.question,
      sources: sources.map((source, index) => ({ ordinal: index + 1,
        trust: "untrusted_source_material" as const, url: source.url,
        title: source.title, evidenceMaterial: source.evidence })),
      snapshots: snapshots.map((snapshot, index) => ({ ordinal: index + 1,
        kind: snapshot.kind, trust: "untrusted_source_material" as const,
        material: JSON.parse(snapshot.materialJson) })),
      parent: owner.parent_report_id === null ? null : (() => {
        const row = connection.prepare(`SELECT report.id, report.version, report.target_key,
          head.state, payload.report_text FROM research_reports AS report
          JOIN research_report_heads AS head ON head.report_id=report.id
          JOIN research_report_payloads AS payload ON payload.report_id=report.id
          WHERE report.id=?`).get(owner.parent_report_id) as {
            id: number; version: number; target_key: string; state: string; report_text: string;
          } | undefined;
        if (row === undefined || row.target_key !== owner.target_key ||
            !["fresh", "stale"].includes(row.state)) throw new DurableAiJobError(
          "JOB_INPUT_UNAVAILABLE", "Live handoff parent changed");
        return { reportId: row.id, reportVersion: row.version,
          trust: "untrusted_prior_report" as const, reportText: row.report_text };
      })(),
    };
    if (currentSnapshotDigest(claim.id) !== snapshotDigest) throw new DurableAiJobError(
      "JOB_INPUT_UNAVAILABLE", "Live handoff snapshot changed during assembly");
    const providerInputDigest = sha256(canonicalJson(providerInput));
    const quote = options.provider.quote(providerInput);
    if (Object.keys(quote).sort().join(",") !==
          "calls,costUsd,inputDigest,inputTokens,outputTokens,version,wallTimeMs" ||
        quote.version !== "research_provider_quote:v1" ||
        !/^[0-9a-f]{64}$/.test(quote.inputDigest) || quote.calls !== 1 ||
        !Number.isSafeInteger(quote.inputTokens) || quote.inputTokens < 0 ||
        !Number.isSafeInteger(quote.outputTokens) || quote.outputTokens < 0 ||
        quote.outputTokens > owner.max_output_tokens ||
        quote.inputTokens + quote.outputTokens > owner.max_tokens ||
        quote.calls + 2 > owner.max_steps ||
        typeof quote.costUsd !== "number" || !Number.isFinite(quote.costUsd) ||
        quote.costUsd < 0 || quote.costUsd > owner.max_cost_usd ||
        !Number.isSafeInteger(quote.wallTimeMs) || quote.wallTimeMs < 0 ||
        quote.wallTimeMs > owner.max_wall_time_ms) {
      throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Live handoff quote drifted");
    }
    if (currentSnapshotDigest(claim.id) !== snapshotDigest) throw new DurableAiJobError(
      "JOB_INPUT_UNAVAILABLE", "Live handoff snapshot changed during quote");
    const frozenQuote = Object.freeze({ ...quote });
    const quoteDigest = sha256(canonicalJson(frozenQuote));
    const planBase = { snapshotDigest,
      coordinatorRunId: owner.run_id,
      coordinatorRunGenerationId: owner.coordinator_run_generation_id,
      consentId: owner.consent_id, resourceGenerationId: owner.resource_generation_id,
      historyEpochId: owner.history_epoch_id, runtimeEpoch: owner.runtime_epoch,
      expiresAt: owner.expires_at, resourceId: owner.resource_id, targetKey: owner.target_key,
      question: owner.question, questionDigest: owner.question_digest, scopeJson: owner.scope_json,
      parentReportId: owner.parent_report_id, maxSteps: owner.max_steps,
      maxTokens: owner.max_tokens, maxOutputTokens: owner.max_output_tokens,
      maxCostUsd: owner.max_cost_usd,
      maxWallTimeMs: owner.max_wall_time_ms, approvalFingerprint, corpusFingerprint,
      submissionFingerprint, sources, snapshots, finalJobId, handoffId, counters,
      quoteDigest, quote: frozenQuote, providerInputDigest };
    return { ...planBase, identityDigest: sha256(canonicalJson(planBase)) };
  }

  function commit(claim: AiJobClaim, plan: HandoffPlan) {
    const at = clock().toISOString();
    const faultPhase = options.faultPhase;
    connection.exec("BEGIN IMMEDIATE");
    try {
      const replay = connection.prepare(`
        SELECT final_run.job_id FROM live_acquisition_handoffs AS handoff
        JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
        WHERE handoff.coordinator_run_generation_id = ? AND handoff.status = 'completed'
      `).pluck().get(plan.coordinatorRunGenerationId) as number | undefined;
      if (replay !== undefined) { connection.exec("COMMIT"); return replay; }
      const fence = connection.prepare(`
        SELECT 1 FROM ai_jobs AS job
        JOIN ai_job_attempts AS attempt ON attempt.id = ? AND attempt.job_id = job.id
          AND attempt.outcome = 'running'
        JOIN live_acquisition_consents AS consent ON consent.id = ?
        JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
        JOIN privacy_subject_generations AS resource_generation
          ON resource_generation.id = consent.resource_generation_id AND resource_generation.is_active = 1
        JOIN privacy_subject_generations AS run_generation
          ON run_generation.id = consent.coordinator_run_generation_id AND run_generation.is_active = 1
        JOIN research_history_epochs AS history ON history.id = consent.history_epoch_id AND history.is_active = 1
        WHERE job.id = ? AND job.status = 'running' AND job.lease_token = ?
          AND job.lease_expires_at > ? AND consent.status = 'active' AND consent.expires_at > ?
          AND consent.runtime_epoch = runtime.runtime_epoch AND consent.runtime_epoch = ?
          AND consent.coordinator_run_generation_id = ?
          AND consent.resource_generation_id = ? AND consent.history_epoch_id = ?
          AND NOT EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
            WHERE intent.status IN ('waiting','ready','committed') AND (
              intent.subject_generation_id IN (consent.resource_generation_id,
                consent.coordinator_run_generation_id) OR intent.history_epoch_id = consent.history_epoch_id))
      `).get(claim.attemptId, plan.consentId, claim.id, claim.leaseToken, at, at,
        plan.runtimeEpoch, plan.coordinatorRunGenerationId, plan.resourceGenerationId,
        plan.historyEpochId);
      const currentCounters = readCounters(plan.consentId, claim.attemptId, true);
      const quoteStillValid = sha256(canonicalJson(plan.quote)) === plan.quoteDigest &&
        plan.quote.version === "research_provider_quote:v1" && plan.quote.calls === 1 &&
        /^[0-9a-f]{64}$/.test(plan.quote.inputDigest) &&
        Number.isSafeInteger(plan.quote.inputTokens) && plan.quote.inputTokens >= 0 &&
        Number.isSafeInteger(plan.quote.outputTokens) && plan.quote.outputTokens >= 0 &&
        plan.quote.outputTokens <= plan.maxOutputTokens &&
        plan.quote.inputTokens + plan.quote.outputTokens <= plan.maxTokens &&
        plan.quote.calls + 2 <= plan.maxSteps && Number.isFinite(plan.quote.costUsd) &&
        plan.quote.costUsd >= 0 && plan.quote.costUsd <= plan.maxCostUsd &&
        Number.isSafeInteger(plan.quote.wallTimeMs) && plan.quote.wallTimeMs >= 0 &&
        plan.quote.wallTimeMs <= plan.maxWallTimeMs;
      if (fence === undefined || currentSnapshotDigest(claim.id) !== plan.snapshotDigest ||
          canonicalJson(currentCounters) !== canonicalJson(plan.counters) || !quoteStillValid) {
        throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE", "Live handoff CAS changed");
      }
      connection.prepare(`INSERT INTO ai_job_events (
        job_id, sequence_no, event_type, from_status, to_status, attempt_id, lease_token,
        occurred_at) SELECT id, event_sequence + 1, 'superseded', 'running', 'superseded',
        ?, ?, ? FROM ai_jobs WHERE id = ?
      `).run(claim.attemptId, claim.leaseToken, at, claim.id);
      if (faultPhase === "after_supersede") throw new Error("injected after_supersede");
      const finalJobId = plan.finalJobId;
      connection.prepare(`INSERT INTO ai_jobs (
        id, kind, subject_type, resource_id, subject_key, requested_by, request_method,
        idempotency_key, submission_fingerprint, input_fingerprint, workflow_id,
        workflow_version, scheduling_priority, progress_total, available_at, max_steps,
        max_tokens, max_cost_usd, max_wall_time_ms, created_at, updated_at)
        VALUES (?, 'resource_research', 'resource', ?, ?, 'user', 'manual', ?, ?, ?,
          'research_workflow:c81:v1', 1, 0, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(finalJobId, plan.resourceId, plan.targetKey, `live-handoff:${claim.id}`,
        plan.submissionFingerprint, plan.approvalFingerprint, at, plan.maxSteps,
        plan.maxTokens, plan.maxCostUsd, plan.maxWallTimeMs, at, at);
      connection.prepare(`INSERT INTO research_runs (
        id, job_id, target_resource_id, history_epoch_id, target_key, question_digest,
        scope_json, approval_fingerprint, corpus_fingerprint, submission_fingerprint,
        workflow_id, workflow_version, parent_report_id, max_steps, max_tokens,
        max_cost_usd, max_wall_time_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research_workflow:c81:v1', 1, ?, ?, ?, ?, ?, ?)
      `).run(finalJobId, finalJobId, plan.resourceId, plan.historyEpochId, plan.targetKey,
        plan.questionDigest, plan.scopeJson, plan.approvalFingerprint, plan.corpusFingerprint,
        plan.submissionFingerprint, plan.parentReportId, plan.maxSteps, plan.maxTokens,
        plan.maxCostUsd, plan.maxWallTimeMs, at);
      connection.prepare("INSERT INTO research_run_payloads VALUES (?, ?, ?)")
        .run(finalJobId, plan.question, plan.scopeJson);
      const handoffId = plan.handoffId;
      connection.prepare(`INSERT INTO live_acquisition_handoffs
        (id, coordinator_run_generation_id, final_run_id, status, created_at)
        VALUES (?, ?, ?, 'assembling', ?)`)
        .run(handoffId, plan.coordinatorRunGenerationId, finalJobId, at);
      if (faultPhase === "after_final_run") throw new Error("injected after_final_run");
      let liveReceiptOrdinal = 0;
      for (let index = 0; index < plan.sources.length; index += 1) {
        const source = plan.sources[index]!;
        const ordinal = index + 1;
        let receiptId: number | null = null;
        if (source.kind === "live_acquisition") {
          liveReceiptOrdinal += 1;
          const receiptDigest = source.handoffSourceReceiptDigest!;
          receiptId = source.handoffSourceReceiptId!;
          connection.prepare(`INSERT INTO live_acquisition_source_receipts (
            id, handoff_id, final_run_id, ordinal, logical_page_id, logical_page_generation_id,
            capture_manifest_id, depth, capture_sequence, inclusion_state, included_order,
            content_revision, content_digest, extracted_at, manifest_json, receipt_digest, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'included', ?, 1, ?, ?, ?, ?, ?)
          `).run(receiptId, handoffId, finalJobId, ordinal, source.logicalPageId,
            source.logicalPageGenerationId, source.captureManifestId, source.depth,
            source.captureSequence, ordinal, source.contentDigest, source.extractedAt,
            source.receiptManifestJson, receiptDigest, at);
        }
        const sourceId = Number(connection.prepare(`INSERT INTO research_sources (
          run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
          content_revision, content_digest, extracted_at, source_kind, acquisition_method,
          handoff_source_receipt_id, access_class_snapshot, eligibility, inclusion_state,
          included_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'eligible', 'included', ?, ?)
        `).run(finalJobId, ordinal, source.logicalPageId, source.tabId,
          source.capturedTabIdSnapshot, source.contentRevision, source.contentDigest,
          source.extractedAt, source.kind, source.acquisitionMethod, receiptId,
          source.accessClass, ordinal, at).lastInsertRowid);
        connection.prepare(`INSERT INTO research_source_state_events (
          source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at)
          VALUES (?, 1, 'accepted', 'valid', NULL, ?, ?)
        `).run(sourceId, `live-handoff:${claim.id}:source:${ordinal}`, at);
        connection.prepare(`INSERT INTO research_source_payloads (
          source_id, url_snapshot, title_snapshot, evidence_material,
          chunk_manifest_json, payload_digest) VALUES (?, ?, ?, ?, ?, ?)
        `).run(sourceId, source.url, source.title, source.evidence,
          source.chunkManifestJson, source.contentDigest);
      }
      if (faultPhase === "after_sources") throw new Error("injected after_sources");
      for (let index = 0; index < plan.snapshots.length; index += 1) {
        const snapshot = plan.snapshots[index]!;
        const placeholders = snapshot.kind === "activity" ? "?, ?, ?, ?, ?, ?, ?"
          : snapshot.kind === "relation" ? "?, ?, ?, ?, ?" : "?, ?, ?, ?, ?, ?";
        const columns = snapshot.kind === "page_context"
          ? "run_id, context_entry_audit_id, logical_page_audit_id, context_entry_id, snapshot_digest, created_at"
          : snapshot.kind === "resource_context"
            ? "run_id, context_entry_audit_id, resource_audit_id, context_entry_id, snapshot_digest, created_at"
            : snapshot.kind === "activity"
              ? "run_id, logical_page_audit_id, activity_date_audit, logical_page_id, activity_date, snapshot_digest, created_at"
              : "run_id, relation_audit_id, relation_id, snapshot_digest, created_at";
        const table = `research_${snapshot.kind}_snapshots`;
        const snapshotId = Number(connection.prepare(`INSERT INTO ${table} (${columns})
          VALUES (${placeholders})`).run(finalJobId, ...snapshot.values,
          snapshot.snapshotDigest, at).lastInsertRowid);
        connection.prepare(`INSERT INTO research_snapshot_state_events (
          kind, snapshot_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at)
          VALUES (?, ?, 1, 'accepted', 'valid', NULL, ?, ?)
        `).run(snapshot.kind, snapshotId,
          `live-handoff:${claim.id}:snapshot:${index + 1}`, at);
        connection.prepare(`INSERT INTO research_snapshot_payloads
          (kind, snapshot_id, material_json) VALUES (?, ?, ?)
        `).run(snapshot.kind, snapshotId, snapshot.materialJson);
      }
      connection.prepare(`INSERT INTO research_run_events (
        run_id, sequence_no, event_type, status, idempotency_key, occurred_at)
        VALUES (?, 1, 'queued', 'queued', ?, ?)
      `).run(finalJobId, `live-handoff:${claim.id}:queued`, at);
      connection.prepare(`INSERT INTO live_acquisition_provider_reservations (
        handoff_id, final_job_id, utc_date, reserved_usd, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(handoffId, finalJobId, at.slice(0, 10), plan.maxCostUsd, at);
      if (faultPhase === "after_reservation") throw new Error("injected after_reservation");
      const terminalDigest = sha256(canonicalJson({ handoffId, finalJobId,
        identityDigest: plan.identityDigest, sourceCount: plan.sources.length }));
      connection.prepare(`INSERT INTO live_acquisition_handoff_receipts
        (handoff_id, receipt_digest, completed_at) VALUES (?, ?, ?)
      `).run(handoffId, terminalDigest, at);
      connection.prepare(`INSERT INTO live_acquisition_workflow_outcomes (
        coordinator_job_id, coordinator_run_generation_id, outcome, outcome_code,
        safe_details_json, created_at) VALUES (?, ?, 'handoff', 'WORKFLOW_COMPLETED', ?, ?)
      `).run(claim.id, plan.coordinatorRunGenerationId,
        JSON.stringify({ outcome_class: "completed", attempt_count: claim.attemptNo }), at);
      connection.prepare(`UPDATE live_acquisition_consents SET status='consumed', terminal_at=?
        WHERE id=? AND status='active'`).run(at, plan.consentId);
      connection.exec("COMMIT");
      return finalJobId;
    } catch (error) {
      if (connection.inTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  function completeNoSource(claim: AiJobClaim): void {
    const at = clock().toISOString();
    connection.exec("BEGIN IMMEDIATE");
    try {
      const row = connection.prepare(`
        SELECT job.event_sequence, consent.id AS consent_id,
          consent.coordinator_run_generation_id
        FROM ai_jobs AS job
        JOIN ai_job_attempts AS attempt ON attempt.id=? AND attempt.job_id=job.id
          AND attempt.outcome='running'
        JOIN live_acquisition_consents AS consent ON consent.coordinator_job_id=job.id
        JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id=1
        JOIN privacy_subject_generations AS resource_generation
          ON resource_generation.id=consent.resource_generation_id AND resource_generation.is_active=1
        JOIN privacy_subject_generations AS run_generation
          ON run_generation.id=consent.coordinator_run_generation_id AND run_generation.is_active=1
        JOIN research_history_epochs AS history
          ON history.id=consent.history_epoch_id AND history.is_active=1
        WHERE job.id=? AND job.status='running' AND job.lease_token=?
          AND job.lease_expires_at>? AND consent.status='active' AND consent.expires_at>?
          AND consent.runtime_epoch=runtime.runtime_epoch
          AND NOT EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
            WHERE intent.status IN ('waiting','ready','committed') AND (
              intent.subject_generation_id IN (consent.resource_generation_id,
                consent.coordinator_run_generation_id) OR intent.history_epoch_id=consent.history_epoch_id))
          AND NOT EXISTS (SELECT 1 FROM live_acquisition_actions AS action
            WHERE action.consent_id=consent.id
              AND action.state NOT IN ('completed','blocked','ambiguous'))
          AND NOT EXISTS (SELECT 1 FROM live_acquisition_capture_manifests AS manifest
            JOIN live_acquisition_actions AS action ON action.id=manifest.action_id
            WHERE action.consent_id=consent.id AND action.state='completed')
      `).get(claim.attemptId, claim.id, claim.leaseToken, at, at) as {
        event_sequence: number; consent_id: number;
        coordinator_run_generation_id: number;
      } | undefined;
      if (row === undefined) throw new DurableAiJobError("JOB_INPUT_UNAVAILABLE",
        "Live no-source completion fence changed");
      connection.prepare(`INSERT INTO ai_job_events (
        job_id, sequence_no, event_type, from_status, to_status, attempt_id, lease_token,
        occurred_at) VALUES (?, ?, 'superseded', 'running', 'superseded', ?, ?, ?)
      `).run(claim.id, row.event_sequence + 1, claim.attemptId, claim.leaseToken, at);
      connection.prepare(`INSERT INTO live_acquisition_workflow_outcomes (
        coordinator_job_id, coordinator_run_generation_id, outcome, outcome_code,
        safe_details_json, created_at) VALUES (?, ?, 'captured_only',
        'NO_ELIGIBLE_SOURCE', ?, ?)
      `).run(claim.id, row.coordinator_run_generation_id,
        JSON.stringify({ outcome_class: "blocked", attempt_count: claim.attemptNo }), at);
      connection.prepare(`UPDATE live_acquisition_consents SET status='consumed', terminal_at=?
        WHERE id=? AND status='active'`).run(at, row.consent_id);
      connection.exec("COMMIT");
    } catch (error) {
      if (connection.inTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    completeClaim(claim) {
      const replay = connection.prepare(`
        SELECT final_run.job_id FROM live_acquisition_handoffs AS handoff
        JOIN privacy_subject_generations AS generation
          ON generation.id = handoff.coordinator_run_generation_id
        JOIN research_runs AS coordinator_run ON coordinator_run.id = generation.research_run_id
        JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
        JOIN live_acquisition_handoff_receipts AS terminal ON terminal.handoff_id = handoff.id
        WHERE coordinator_run.job_id = ? AND handoff.status = 'completed'
      `).pluck().get(claim.id) as number | undefined;
      if (replay !== undefined) return { kind: "handoff", finalJobId: replay };
      const noSourceReplay = connection.prepare(`
        SELECT 1 FROM live_acquisition_workflow_outcomes
        WHERE coordinator_job_id=? AND outcome='captured_only'
          AND outcome_code='NO_ELIGIBLE_SOURCE'
      `).get(claim.id);
      if (noSourceReplay !== undefined) return { kind: "no_eligible_source" };
      let plan: HandoffPlan;
      try {
        plan = precompute(claim);
      } catch (error) {
        if (error instanceof DurableAiJobError &&
            error.message === "Live acquisition has no eligible terminal capture") {
          completeNoSource(claim);
          return { kind: "no_eligible_source" };
        }
        throw error;
      }
      return { kind: "handoff", finalJobId: commit(claim, plan) };
    },
  };
}
