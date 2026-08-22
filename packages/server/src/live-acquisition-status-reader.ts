import { createHash } from "node:crypto";

import { liveAcquisitionEffectivePolicy, liveAcquisitionExactTabFallbackReasonSchema,
  liveAcquisitionRunStatusSchema,
  type LiveAcquisitionRunStatus } from "@tabhub/shared";
import type Database from "better-sqlite3";
import { activePrivacyPurgeOwnsResearchRunSql } from "./privacy-purge-fence-spec.js";

const unavailable = () => new Error("Live acquisition status unavailable");

export interface LiveAcquisitionStatusReader {
  read(jobId: string): LiveAcquisitionRunStatus | null;
}

function numericJobId(value: string): number | null {
  const match = /^resource_research:([1-9][0-9]*)$/.exec(value);
  const id = match === null ? NaN : Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareLiveAcquisitionStatusActions(
  left: LiveAcquisitionRunStatus["actions"][number],
  right: LiveAcquisitionRunStatus["actions"][number],
): number {
  if (left.kind !== right.kind) return left.kind === "robots" ? -1 : 1;
  if (left.kind === "robots") return Buffer.compare(Buffer.from(left.origin ?? "", "utf8"),
    Buffer.from(right.origin ?? "", "utf8")) || left.id - right.id;
  return (left.depth ?? 0) - (right.depth ?? 0) ||
    Buffer.compare(Buffer.from(left.exactUrl ?? "", "utf8"),
      Buffer.from(right.exactUrl ?? "", "utf8")) || left.id - right.id;
}

export function deriveLiveRunSuccess(input: {
  workflowOutcome: string | null;
  finalTerminal: boolean;
  finalConsistentSucceeded: boolean;
  usedLive: boolean;
}): boolean | null {
  if (input.workflowOutcome === null) return null;
  if (input.workflowOutcome !== "handoff") return false;
  if (!input.finalTerminal) return null;
  return input.finalConsistentSucceeded && input.usedLive;
}

export function projectExactTabFallback(value: string | null) {
  const parsed = liveAcquisitionExactTabFallbackReasonSchema.safeParse(value);
  return parsed.success
    ? { recommendedKind: "exact_tab_capture" as const, reason: parsed.data }
    : null;
}

export function assertLiveAcquisitionActionRowBound(rowCount: number): void {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 1_016) throw unavailable();
}

export function deriveLiveAcquisitionOutcome(input: {
  reportRedacted: boolean;
  purging: boolean;
  workflowOutcome: string | null;
  outcomeCode: string | null;
  finalTerminal: boolean;
  runLiveSuccess: boolean | null;
  mixed: boolean;
}): LiveAcquisitionRunStatus["acquisitionOutcome"] {
  if (input.reportRedacted) return "redacted";
  if (input.purging || input.outcomeCode === "PURGE_WAITING_FOR_ACTION") return "purging";
  if (input.outcomeCode === "SUBJECT_FORGOTTEN") return "redacted";
  if (input.workflowOutcome === null) return "running";
  if (input.outcomeCode === "WORKFLOW_CANCELLED") return "cancelled";
  if (["WORKFLOW_FAILED", "PROVIDER_UNAVAILABLE"].includes(input.outcomeCode ?? "")) {
    return "failed";
  }
  if (input.outcomeCode === "WORKFLOW_AMBIGUOUS" || input.workflowOutcome === "ambiguous") {
    return "ambiguous";
  }
  if (["NO_ELIGIBLE_SOURCE", "BUDGET_EXHAUSTED"].includes(input.outcomeCode ?? "") ||
      input.workflowOutcome === "captured_only") return "zero_usable";
  if (input.workflowOutcome === "handoff") {
    if (!input.finalTerminal) return "running";
    if (input.runLiveSuccess === true) return input.mixed ? "mixed" : "live_complete";
    return "zero_usable";
  }
  return "blocked";
}

export function createLiveAcquisitionStatusReader(
  connection: Database.Database,
): LiveAcquisitionStatusReader {
  const schemaVersion = connection.pragma("user_version", { simple: true }) as number;
  const activeRunPurge = activePrivacyPurgeOwnsResearchRunSql("purge_run");
  const readSnapshot = connection.transaction((jobId: number) => {
    const owner = connection.prepare(`SELECT job.status coordinator_status, run.id run_id,
      run.target_resource_id resource_id, run_head.status coordinator_run_status,
      consent.id consent_id, consent.status consent_state,
      consent.created_at, consent.expires_at, consent.terminal_at, consent.limits_json,
      consent.coordinator_run_generation_id, consent.history_epoch_id,
      payload.approved_origins_json, outcome.outcome, outcome.outcome_code,
      handoff.final_run_id, final_job.id final_job_id, final_job.status final_status,
      final_job.result_type final_result_type, final_job.result_report_id final_result_report_id,
      final_run_head.status final_run_status, final_run_head.report_id final_run_report_id,
      report.id report_id, report.publish_status report_publish_status,
      report_head.state report_state
      FROM ai_jobs job JOIN research_runs run ON run.job_id=job.id
      JOIN research_run_heads run_head ON run_head.run_id=run.id
      JOIN live_acquisition_consents consent ON consent.coordinator_job_id=job.id
      JOIN live_acquisition_consent_payloads payload ON payload.consent_id=consent.id
      LEFT JOIN live_acquisition_workflow_outcomes outcome ON outcome.coordinator_job_id=job.id
      LEFT JOIN live_acquisition_handoffs handoff
        ON handoff.coordinator_run_generation_id=consent.coordinator_run_generation_id
        AND handoff.status='completed'
      LEFT JOIN research_runs final_run ON final_run.id=handoff.final_run_id
      LEFT JOIN ai_jobs final_job ON final_job.id=final_run.job_id
      LEFT JOIN research_run_heads final_run_head ON final_run_head.run_id=final_run.id
      LEFT JOIN research_reports report ON report.run_id=final_run.id
      LEFT JOIN research_report_heads report_head ON report_head.report_id=report.id
      WHERE job.id=? AND job.workflow_id='research_acquisition:c90:v1'
        AND job.workflow_version=1`).get(jobId) as Record<string, unknown> | undefined;
    if (owner === undefined) return null;
    let limits: Record<string, unknown>; let origins: string[];
    try {
      limits = JSON.parse(String(owner.limits_json)) as Record<string, unknown>;
      origins = JSON.parse(String(owner.approved_origins_json)) as string[];
    } catch { throw unavailable(); }
    if (!Array.isArray(origins) || origins.length < 1 || origins.some((value) => typeof value !== "string")) {
      throw unavailable();
    }
    const actionRows = connection.prepare(`SELECT action.id, action.action_kind, action.depth,
      action.state, action.created_at, action.terminal_at, action.canonical_origin_digest,
      event.outcome_code, event.safe_details_json,
      url.exact_url, manifest.id manifest_id, manifest.capture_sequence,
      manifest.content_digest, generation.logical_page_id, receipt.id receipt_id,
      receipt.final_run_id receipt_final_run_id, receipt.included_order,
      source.source_kind, source.acquisition_method, reservation.id reservation_id,
      EXISTS (SELECT 1 FROM live_acquisition_action_events started
        WHERE started.action_id=action.id AND started.to_state='started') had_started
      FROM live_acquisition_actions action
      LEFT JOIN live_acquisition_action_events event ON event.action_id=action.id
        AND event.sequence_no=action.sequence_no
      LEFT JOIN live_acquisition_url_payloads url ON url.action_id=action.id
      LEFT JOIN live_acquisition_capture_manifests manifest ON manifest.action_id=action.id
      LEFT JOIN privacy_subject_generations generation ON generation.id=manifest.logical_page_generation_id
      LEFT JOIN live_acquisition_source_receipts receipt ON receipt.capture_manifest_id=manifest.id
      LEFT JOIN research_sources source ON source.handoff_source_receipt_id=receipt.id
      LEFT JOIN live_acquisition_page_reservations reservation ON reservation.action_id=action.id
      WHERE action.consent_id=? ORDER BY action.id LIMIT 1017`).all(owner.consent_id) as
      Array<Record<string, unknown>>;
    assertLiveAcquisitionActionRowBound(actionRows.length);
    let purgeState: string | null = null;
    if (schemaVersion >= 26) {
      purgeState = connection.prepare(`SELECT 'active' WHERE EXISTS (
        SELECT 1 FROM research_runs purge_run
        WHERE purge_run.id IN (@coordinatorRunId, @finalRunId) AND (${activeRunPurge})
      ) OR EXISTS (
        SELECT 1 FROM privacy_purge_intents intent
        WHERE intent.status IN ('waiting','ready','committed','failed_hold')
          AND intent.target_kind='logical_page' AND (
            EXISTS (SELECT 1 FROM live_acquisition_actions purge_action
              JOIN live_acquisition_capture_manifests purge_manifest
                ON purge_manifest.action_id=purge_action.id
              JOIN privacy_subject_generations purge_page
                ON purge_page.id=purge_manifest.logical_page_generation_id
              WHERE purge_action.consent_id=@consentId
                AND purge_page.logical_page_id=intent.logical_page_id_snapshot)
            OR EXISTS (SELECT 1 FROM research_sources purge_source
              WHERE purge_source.run_id IN (@coordinatorRunId, @finalRunId)
                AND purge_source.logical_page_id=intent.logical_page_id_snapshot)
          )
      ) LIMIT 1`).pluck().get({ coordinatorRunId: owner.run_id,
          finalRunId: owner.final_run_id ?? -1, consentId: owner.consent_id }) as
        string | undefined ?? null;
    }
    const hideMaterial = purgeState !== null || owner.report_state === "redacted";
    const actions = actionRows.map((row) => {
      if (row.receipt_id !== null && (row.source_kind !== "live_acquisition" ||
          row.acquisition_method !== "safe_public_http_v1" ||
          row.receipt_final_run_id !== owner.final_run_id)) throw unavailable();
      const kind = String(row.action_kind) as "page" | "robots";
      const state = String(row.state) as LiveAcquisitionRunStatus["actions"][number]["state"];
      const outcomeCode = row.outcome_code === null ? null : String(row.outcome_code) as
        LiveAcquisitionRunStatus["actions"][number]["latestOutcome"];
      const fallback = projectExactTabFallback(outcomeCode);
      const exactUrl = hideMaterial || row.exact_url === null ? null : String(row.exact_url);
      const origin = kind === "page" && exactUrl !== null ? new URL(exactUrl).origin
        : kind === "robots" ? origins.find((value) => digest(value) === row.canonical_origin_digest) ?? null
          : null;
      const terminal = ["completed", "blocked", "ambiguous"].includes(state);
      const usable = kind === "robots" ? null : !terminal ? "pending" as const
        : state === "completed" && row.manifest_id !== null ? "usable" as const : "unusable" as const;
      return {
        id: Number(row.id), kind, depth: row.depth === null ? null : Number(row.depth), state,
        latestOutcome: outcomeCode, createdAt: String(row.created_at),
        terminalAt: row.terminal_at === null ? null : String(row.terminal_at), exactUrl,
        origin: hideMaterial ? null : origin,
        redacted: hideMaterial || (kind === "page" && row.exact_url === null),
        usability: usable, sourceUsable: usable === "pending" || usable === null ? null
          : usable === "usable",
        omissionReason: usable === "unusable" ? outcomeCode : null,
        fallback: kind === "page" && usable === "unusable" ? fallback : null,
        capture: hideMaterial || row.manifest_id === null ? null : { manifestId: Number(row.manifest_id),
          logicalPageId: Number(row.logical_page_id), captureSequence: Number(row.capture_sequence),
          contentDigest: String(row.content_digest) },
        finalInclusion: hideMaterial || row.receipt_id === null
          ? null : { sourceReceiptId: Number(row.receipt_id),
          finalRunId: Number(row.receipt_final_run_id), includedOrder: Number(row.included_order),
          sourceKind: "live_acquisition" as const, acquisitionMethod: "safe_public_http_v1" as const },
      };
    }).sort(compareLiveAcquisitionStatusActions);
    const counters = {
      reservedPages: actionRows.filter((row) => row.action_kind === "page" &&
        row.reservation_id !== null).length,
      visitedPages: actionRows.filter((row) => {
        if (row.action_kind !== "page") return false;
        if (row.state === "completed") return true;
        try {
          return ["blocked", "ambiguous"].includes(String(row.state)) &&
            JSON.parse(String(row.safe_details_json)).response_class === "success";
        } catch { throw unavailable(); }
      }).length,
      capturedPages: actionRows.filter((row) => row.action_kind === "page" && row.manifest_id !== null).length,
      blockedPages: actionRows.filter((row) => row.action_kind === "page" && row.state === "blocked").length,
      ambiguousPages: actionRows.filter((row) => row.action_kind === "page" && row.state === "ambiguous").length,
      robotsActions: actionRows.filter((row) => row.action_kind === "robots" &&
        Number(row.had_started) === 1).length,
      networkActions: actionRows.filter((row) => Number(row.had_started) === 1).length,
      plannedActions: actionRows.filter((row) => row.state === "planned").length,
      activeActions: actionRows.filter((row) =>
        !["planned", "completed", "blocked", "ambiguous"].includes(String(row.state))).length,
    };
    const hasAttempt = connection.prepare(`SELECT 1 FROM ai_job_attempts
      WHERE job_id=? LIMIT 1`).get(jobId) !== undefined;
    const checkpoint = connection.prepare(`SELECT checkpoint_json, checkpoint_digest
      FROM live_acquisition_checkpoints WHERE coordinator_job_id=?
      ORDER BY updated_at DESC, attempt_id DESC LIMIT 1`).get(jobId) as
      { checkpoint_json: string; checkpoint_digest: string } | undefined;
    if (checkpoint === undefined && (hasAttempt || actionRows.length > 0)) throw unavailable();
    if (checkpoint !== undefined) {
      if (digest(checkpoint.checkpoint_json) !== checkpoint.checkpoint_digest) throw unavailable();
      let value: Record<string, unknown>;
      try { value = JSON.parse(checkpoint.checkpoint_json) as Record<string, unknown>; }
      catch { throw unavailable(); }
      const persisted = value.counters as Record<string, unknown> | undefined;
      const queue = value.queue as Record<string, unknown> | undefined;
      const planned = queue?.plannedActionIds;
      const active = queue?.activeActionIds;
      const expectedPlanned = actionRows.filter((row) => row.state === "planned")
        .map((row) => Number(row.id));
      const expectedActive = actionRows.filter((row) =>
        !["planned", "completed", "blocked", "ambiguous"].includes(String(row.state)))
        .map((row) => Number(row.id));
      const expectedStage = expectedPlanned.length + expectedActive.length > 0 ? "acquiring"
        : actionRows.some((row) => row.state === "ambiguous") ? "ambiguous"
          : counters.capturedPages > 0 ? "ready_for_handoff" : "no_eligible_source";
      if (persisted === undefined || !Array.isArray(planned) || !Array.isArray(active) ||
          value.stage !== expectedStage || JSON.stringify(planned) !== JSON.stringify(expectedPlanned) ||
          JSON.stringify(active) !== JSON.stringify(expectedActive) ||
          Number(persisted.reservedPages) !== counters.reservedPages ||
          Number(persisted.visitedPages) !== counters.visitedPages ||
          Number(persisted.capturedPages) !== counters.capturedPages ||
          Number(persisted.blockedPages) !== counters.blockedPages ||
          Number(persisted.ambiguousPages) !== counters.ambiguousPages ||
          Number(persisted.robotsActions) !== counters.robotsActions ||
          Number(persisted.networkActions) !== counters.networkActions ||
          planned.length !== counters.plannedActions || active.length !== counters.activeActions) {
        throw unavailable();
      }
    }
    if (owner.coordinator_status !== owner.coordinator_run_status) throw unavailable();
    const coordinatorStatus = String(owner.coordinator_status) as LiveAcquisitionRunStatus["coordinator"]["status"];
    const finalStatus = owner.final_status === null ? null : String(owner.final_status) as
      NonNullable<LiveAcquisitionRunStatus["final"]>["status"];
    const finalTerminal = finalStatus !== null &&
      ["succeeded", "partial", "failed", "cancelled", "superseded"].includes(finalStatus);
    if (owner.final_run_id !== null && (owner.final_job_id === null ||
        owner.final_status !== owner.final_run_status ||
        (finalTerminal && owner.final_result_type === "research_report" &&
          (owner.report_id === null || owner.final_result_report_id !== owner.report_id ||
            owner.final_run_report_id !== owner.report_id)))) throw unavailable();
    const reportRedacted = owner.report_state === "redacted";
    const usedLive = owner.report_id === null ? false : connection.prepare(`SELECT 1
      FROM research_report_sources used JOIN research_sources source ON source.id=used.source_id
      JOIN live_acquisition_source_receipts receipt
        ON receipt.id=source.handoff_source_receipt_id AND receipt.final_run_id=source.run_id
      WHERE used.report_id=? AND source.source_kind='live_acquisition'
        AND source.acquisition_method='safe_public_http_v1' LIMIT 1`)
      .get(owner.report_id) !== undefined;
    const workflowOutcome = owner.outcome === null ? null : String(owner.outcome);
    const handoffComplete = workflowOutcome === "handoff" && owner.final_run_id !== null &&
      owner.final_job_id !== null;
    const runLiveSuccess = deriveLiveRunSuccess({ workflowOutcome, finalTerminal,
      finalConsistentSucceeded: handoffComplete && finalStatus === "succeeded" &&
        owner.final_run_status === "succeeded" && owner.final_result_type === "research_report" &&
        owner.final_result_report_id === owner.report_id && owner.final_run_report_id === owner.report_id &&
        owner.report_publish_status === "succeeded",
      usedLive });
    const acquisitionOutcome = deriveLiveAcquisitionOutcome({ reportRedacted,
      purging: purgeState !== null, workflowOutcome,
      outcomeCode: owner.outcome_code === null ? null : String(owner.outcome_code),
      finalTerminal, runLiveSuccess,
      mixed: counters.blockedPages > 0 || counters.ambiguousPages > 0 });
    const response = { version: 1 as const, jobId: `resource_research:${jobId}`,
      target: { type: "resource" as const, resourceId: Number(owner.resource_id) },
      coordinator: { runId: Number(owner.run_id), status: coordinatorStatus },
      final: owner.final_run_id === null ? null : { jobId: `resource_research:${Number(owner.final_job_id)}`,
        runId: Number(owner.final_run_id), status: finalStatus!,
        reportId: owner.report_id === null ? null : Number(owner.report_id) },
      consent: { state: String(owner.consent_state), createdAt: String(owner.created_at),
        expiresAt: String(owner.expires_at), terminalAt: owner.terminal_at === null ? null : String(owner.terminal_at),
        approvedOrigins: hideMaterial ? [] : origins, limits: { maxPages: Number(limits.max_pages),
          maxDepth: Number(limits.max_depth), durationMs: Number(limits.duration_ms),
          maxCostUsd: Number(limits.max_cost_usd), maxOrigins: Number(limits.max_origins),
          maxOutputTokens: Number(limits.max_output_tokens) },
        effectivePolicy: liveAcquisitionEffectivePolicy(Number(limits.max_pages), origins.length) },
      runLiveSuccess, workflowOutcome, workflowOutcomeCode: owner.outcome_code === null
        ? null : String(owner.outcome_code), acquisitionOutcome, counters, actions };
    const parsed = liveAcquisitionRunStatusSchema.safeParse(response);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  });
  return Object.freeze({ read(jobId: string) {
    const numeric = numericJobId(jobId); if (numeric === null) return null;
    try { return readSnapshot.deferred(numeric); } catch { throw unavailable(); }
  } });
}
