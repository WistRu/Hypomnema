import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import {
  canonicalJsonV1 as canonicalJson,
  estimateResearchReservationV1,
  researchApprovedDraftSchema,
  type ResearchApprovedDraft,
} from "@tabhub/shared";

import {
  fingerprintResearchApproval,
  fingerprintResearchCorpus,
} from "../src/research-store.js";

export const liveResearchFixtureAt = "2026-08-14T12:00:00.000Z";
export const liveResearchFixtureCompletedAt = "2026-08-14T12:00:01.000Z";
export const liveResearchFixtureEvidence = "receipt-backed public live evidence";

export interface ReceiptBackedLiveResearchFixture {
  readonly coordinatorJobId: number;
  readonly finalJobId: number;
  readonly finalRunId: number;
  readonly sourceId: number;
  readonly sourceReceiptId: number;
  readonly sourceReceiptDigest: string;
  readonly handoffId: number;
  readonly draft: ResearchApprovedDraft;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Builds the smallest schema-25 directed-handoff graph accepted by the live
 * acquisition storage invariants. The final source deliberately has no tab.
 */
export function seedReceiptBackedLiveResearchRun(
  connection: Database.Database,
  options: { readonly overlappingPathResource?: boolean } = {},
): ReceiptBackedLiveResearchFixture {
  const coordinatorJobId = 7_001;
  const finalJobId = 7_002;
  const finalRunId = 7_002;
  const sourceId = 7_002;
  const sourceReceiptId = 1;
  const handoffId = 1;
  const logicalPageId = 7_001;
  const resourceId = 7_001;
  const sourceUrl = "https://www.cloudflare.com/live-research-source";
  const sourceReceiptDigest = "6".repeat(64);
  const contentDigest = sha256(liveResearchFixtureEvidence);
  const chunkManifest = {
    version: "captured_text_chunks:v1" as const,
    byteStart: 0 as const,
    byteEnd: Buffer.byteLength(liveResearchFixtureEvidence, "utf8"),
    chunkDigest: contentDigest,
    truncated: false,
  };
  const question = "What does the live source establish?";
  const scope = {
    acquisitionLevel: "captured_only" as const,
    includeShareableContext: false,
    maxIncludedSources: 100,
    privacyConfirmation: {
      confirmed: true as const,
      authenticatedOriginDigests: [] as string[],
      sensitiveOriginDigests: [] as string[],
    },
  };
  const budget = {
    maxSteps: 10,
    maxTokens: 2_000,
    maxCostUsd: 1,
    maxWallTimeMs: 60_000,
  };
  const draftInput = {
    version: 1 as const,
    target: { type: "resource" as const, resourceId },
    question,
    scope,
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    corpusFingerprint: "0".repeat(64),
    workflowRef: { id: "research_workflow:c81:v1", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength(liveResearchFixtureEvidence, "utf8"),
      snapshotBytes: 0,
      questionBytes: Buffer.byteLength(question, "utf8"),
      budget,
    }),
    sources: [{
      sourceKind: "live_acquisition" as const,
      ordinal: 1,
      logicalPageId,
      tabId: null,
      selectedTabId: null,
      contentRevision: 1 as const,
      contentDigest,
      extractedAt: liveResearchFixtureAt,
      acquisitionMethod: "safe_public_http_v1" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      handoffSourceReceiptId: sourceReceiptId,
      handoffSourceReceiptDigest: sourceReceiptDigest,
      payload: {
        url: sourceUrl,
        title: "Live research source",
        evidenceMaterial: liveResearchFixtureEvidence,
        chunkManifest,
      },
    }],
    snapshots: [],
  };
  const approvalFingerprint = fingerprintResearchApproval(draftInput);
  const withApproval = { ...draftInput, approvalFingerprint };
  const draft = researchApprovedDraftSchema.parse({
    ...withApproval,
    corpusFingerprint: fingerprintResearchCorpus(withApproval),
  });
  const submissionFingerprint = "a".repeat(64);

  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      ${logicalPageId}, '${sourceUrl}',
      '${sourceUrl}', '${sourceUrl}',
      '${liveResearchFixtureAt}', '${liveResearchFixtureAt}'
    );
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (${resourceId}, 'host:example.com', '${liveResearchFixtureAt}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (
      ${resourceId}, ${resourceId}, 1, 'Live fixture', 'website', 'public', 'active',
      'system', 'derived', '${liveResearchFixtureAt}'
    );
    INSERT INTO resource_heads (resource_id, event_id)
    VALUES (${resourceId}, ${resourceId});
    INSERT INTO resource_match_rules (
      id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (
      77001, 'live-fixture-cloudflare', 1, ${resourceId}, 'cloudflare.com',
      'suffix_host', '/', 100, 'system_seed', 'system', 'derived',
      '${liveResearchFixtureAt}'
    );
    INSERT INTO resource_match_rule_heads (rule_key, rule_id)
    VALUES ('live-fixture-cloudflare', 77001);
  `);
  if (options.overlappingPathResource === true) {
    connection.exec(`
      INSERT INTO resources (id, resource_key, created_at)
      VALUES (77002, 'path:www.cloudflare.com/foreign/', '${liveResearchFixtureAt}');
      INSERT INTO resource_events (
        id, resource_id, version, name, kind, access_class, lifecycle_state,
        created_by, creation_method, created_at
      ) VALUES (
        77002, 77002, 1, 'Foreign path fixture', 'website', 'public', 'active',
        'system', 'derived', '${liveResearchFixtureAt}'
      );
      INSERT INTO resource_heads (resource_id, event_id) VALUES (77002, 77002);
      INSERT INTO resource_match_rules (
        id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
        priority, provenance_class, created_by, creation_method, created_at
      ) VALUES (
        77002, 'live-fixture-cloudflare-foreign', 1, 77002,
        'www.cloudflare.com', 'exact_host', '/foreign/', 200,
        'system_seed', 'system', 'derived', '${liveResearchFixtureAt}'
      );
      INSERT INTO resource_match_rule_heads (rule_key, rule_id)
      VALUES ('live-fixture-cloudflare-foreign', 77002);
    `);
  }

  const insertJob = connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      progress_total, available_at, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, updated_at
    ) VALUES (
      @id, 'resource_research', 'resource', @resourceId, @subjectKey,
      'user', 'manual', @idempotencyKey, @submissionFingerprint,
      @inputFingerprint, @workflowId, 1, 0, 1, @at,
      10, 2000, 1, 60000, @at, @at
    )
  `);
  const insertRun = connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_resource_id, history_epoch_id, target_key,
      question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at
    ) VALUES (
      @id, @id, @resourceId,
      (SELECT id FROM research_history_epochs
       WHERE resource_id = @resourceId AND is_active = 1),
      @subjectKey, @questionDigest, @scopeJson,
      @approvalFingerprint, @corpusFingerprint, @submissionFingerprint,
      @workflowId, 1, 10, 2000, 1, 60000, @at
    )
  `);

  insertJob.run({
    id: coordinatorJobId,
    resourceId,
    subjectKey: `resource:${resourceId}`,
    idempotencyKey: "live-fixture-coordinator",
    submissionFingerprint,
    inputFingerprint: "b".repeat(64),
    workflowId: "research_acquisition:c90:v1",
    at: liveResearchFixtureAt,
  });
  insertRun.run({
    id: coordinatorJobId,
    resourceId,
    subjectKey: `resource:${resourceId}`,
    questionDigest: "c".repeat(64),
    scopeJson: "{}",
    approvalFingerprint: "b".repeat(64),
    corpusFingerprint: "d".repeat(64),
    submissionFingerprint,
    workflowId: "research_acquisition:c90:v1",
    at: liveResearchFixtureAt,
  });
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', 'live-fixture-coordinator-queued', ?)
  `).run(coordinatorJobId, liveResearchFixtureAt);

  const ownership = connection.prepare(`
    SELECT
      (SELECT id FROM privacy_subject_generations
       WHERE subject_kind = 'resource' AND resource_id = ? AND is_active = 1)
        AS resource_generation_id,
      (SELECT id FROM research_history_epochs
       WHERE resource_id = ? AND is_active = 1) AS history_epoch_id,
      (SELECT id FROM privacy_subject_generations
       WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1)
        AS coordinator_run_generation_id,
      (SELECT runtime_epoch FROM live_acquisition_runtime_state WHERE singleton_id = 1)
        AS runtime_epoch
  `).get(resourceId, resourceId, coordinatorJobId) as {
    resource_generation_id: number;
    history_epoch_id: number;
    coordinator_run_generation_id: number;
    runtime_epoch: number;
  };
  const ruleset = connection.prepare(`
    SELECT event.id, event.version
    FROM resource_ruleset_heads AS head
    JOIN resource_ruleset_events AS event ON event.id = head.ruleset_event_id
    WHERE head.scope = 'global'
  `).get() as { id: number; version: number };
  const rules = connection.prepare(`
    SELECT rule.rule_key, rule.version, rule.host_pattern, rule.path_prefix,
      rule.priority, rule.enabled, rule.resource_id
    FROM resource_match_rule_heads AS head
    JOIN resource_match_rules AS rule ON rule.id = head.rule_id
    ORDER BY rule.rule_key
  `).all();
  const rulesetGenerationDigest = sha256(canonicalJson({
    eventId: ruleset.id,
    version: ruleset.version,
    rules,
  }));
  const resourceGenerationDigest = connection.prepare(`
    SELECT generation_token FROM privacy_subject_generations WHERE id = ?
  `).pluck().get(ownership.resource_generation_id) as string;
  const limitsJson = canonicalJson({
    max_pages: 10,
    max_depth: 3,
    duration_ms: 300_000,
    max_cost_usd: 1,
    max_origins: 1,
    max_output_tokens: 2_000,
    provider_digest: "1".repeat(64),
    model_digest: "2".repeat(64),
    pricing_digest: "3".repeat(64),
    ruleset_generation_digest: rulesetGenerationDigest,
    resource_generation_digest: resourceGenerationDigest,
    max_source_bytes: 65_536,
    max_total_bytes: 4_194_304,
    dns_timeout_ms: 3_000,
    connect_timeout_ms: 5_000,
    headers_timeout_ms: 8_000,
    body_idle_timeout_ms: 3_000,
    request_timeout_ms: 15_000,
    max_header_bytes: 16_384,
  });
  connection.prepare(`
    INSERT INTO live_acquisition_consents (
      id, resource_generation_id, history_epoch_id, coordinator_job_id,
      coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
      origin_set_digest, limits_json, status, created_at, expires_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    ownership.resource_generation_id,
    ownership.history_epoch_id,
    coordinatorJobId,
    ownership.coordinator_run_generation_id,
    ownership.runtime_epoch,
    "7".repeat(64),
    "8".repeat(64),
    limitsJson,
    liveResearchFixtureAt,
    "2026-08-14T12:05:00.000Z",
  );
  connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, occurred_at
    ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
  `).run(coordinatorJobId, liveResearchFixtureAt);

  insertJob.run({
    id: finalJobId,
    resourceId,
    subjectKey: `resource:${resourceId}`,
    idempotencyKey: "live-fixture-final",
    submissionFingerprint,
    inputFingerprint: draft.approvalFingerprint,
    workflowId: draft.workflowRef.id,
    at: liveResearchFixtureAt,
  });
  insertRun.run({
    id: finalRunId,
    resourceId,
    subjectKey: `resource:${resourceId}`,
    questionDigest: sha256(question),
    scopeJson: canonicalJson(scope),
    approvalFingerprint: draft.approvalFingerprint,
    corpusFingerprint: draft.corpusFingerprint,
    submissionFingerprint,
    workflowId: draft.workflowRef.id,
    at: liveResearchFixtureAt,
  });
  connection.prepare(`
    INSERT INTO research_run_payloads (run_id, question, scope_json)
    VALUES (?, ?, ?)
  `).run(finalRunId, question, canonicalJson(scope));
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', 'live-fixture-final-queued', ?)
  `).run(finalRunId, liveResearchFixtureAt);

  connection.prepare(`
    INSERT INTO live_acquisition_handoffs (
      id, coordinator_run_generation_id, final_run_id, status, created_at
    ) VALUES (?, ?, ?, 'assembling', ?)
  `).run(handoffId, ownership.coordinator_run_generation_id, finalRunId, liveResearchFixtureAt);
  const pageGenerationId = connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = ? AND is_active = 1
  `).pluck().get(logicalPageId) as number;
  const actionId = 7_001;
  const assignmentId = 7_001;
  const resolutionId = 7_001;
  const captureManifestId = 1;
  const urlDigest = sha256(`live-fixture-url:${actionId}`);
  connection.prepare(`
    INSERT INTO live_acquisition_consent_payloads (
      consent_id, approved_origins_json
    ) VALUES (1, '["https://www.cloudflare.com"]')
  `).run();
  connection.prepare(`
    INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
    VALUES (1, zeroblob(32))
  `).run();
  connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class,
      assigned_by, assignment_method, source_fingerprint, created_at
    ) VALUES (?, ?, 'assigned', ?, 'user_manual', 'user', 'manual',
      'live-fixture-capture-assignment', ?)
  `).run(assignmentId, logicalPageId, resourceId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (?, ?)
  `).run(logicalPageId, assignmentId);
  connection.prepare(`
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      created_at
    ) VALUES (?, ?, 'matched', 'user_manual', ?, ?, ?,
      'live-fixture-capture-resolution', 1, ?)
  `).run(
    resolutionId,
    logicalPageId,
    resourceId,
    assignmentId,
    JSON.stringify([resourceId]),
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (?, ?)
  `).run(logicalPageId, resolutionId);
  connection.prepare(`
    INSERT INTO live_acquisition_actions (
      id, consent_id, coordinator_run_generation_id, resource_generation_id,
      history_epoch_id, runtime_epoch, action_kind, depth,
      discovered_from_action_id, canonical_fetch_url_fingerprint,
      canonical_origin_digest, action_key_digest, state, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, 'page', 0, NULL, ?, NULL, ?, 'planned', ?)
  `).run(
    actionId,
    ownership.coordinator_run_generation_id,
    ownership.resource_generation_id,
    ownership.history_epoch_id,
    ownership.runtime_epoch,
    sha256(draft.sources[0]!.payload!.url),
    sha256(`live-fixture-action:${actionId}`),
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO live_acquisition_url_payloads (
      action_id, exact_url, keyed_url_digest
    ) VALUES (?, ?, ?)
  `).run(actionId, draft.sources[0]!.payload!.url, urlDigest);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 1, 'planned', 'planned', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  const reservationId = Number(connection.prepare(`
    INSERT INTO live_acquisition_page_reservations (
      consent_id, action_id, reservation_sequence, reserved_at
    ) VALUES (1, ?, 1, ?)
  `).run(actionId, liveResearchFixtureAt).lastInsertRowid);
  connection.prepare(`
    INSERT INTO live_acquisition_dns_payloads (
      action_id, answers_json, selected_ipv4, resolved_at
    ) VALUES (?, '["203.0.113.1"]', '203.0.113.1', ?)
  `).run(actionId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 3, 'resolution_started', 'resolved', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_action_authorizations (
      action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
      authorized_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-14T12:05:00.000Z')
  `).run(actionId, ownership.runtime_epoch, "a".repeat(64), "b".repeat(64),
    liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 4, 'resolved', 'authorized', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 5, 'authorized', 'started', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_body_payloads (
      action_id, raw_body, extracted_text, body_digest,
      response_metadata_json, acquired_at
    ) VALUES (?, ?, ?, ?, '{}', ?)
  `).run(
    actionId,
    Buffer.from(liveResearchFixtureEvidence, "utf8"),
    liveResearchFixtureEvidence,
    contentDigest,
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO live_acquisition_capture_manifests (
      id, consent_id, logical_page_generation_id, action_id, reservation_id,
      depth, capture_sequence, url_digest, content_digest, manifest_json,
      created_at
    ) VALUES (?, 1, ?, ?, ?, 0, 1, ?, ?, '{}', ?)
  `).run(
    captureManifestId,
    pageGenerationId,
    actionId,
    reservationId,
    urlDigest,
    contentDigest,
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 6, 'started', 'completed', 'FETCH_COMPLETED', '{}', ?)
  `).run(actionId, liveResearchFixtureCompletedAt);
  connection.prepare(`
    INSERT INTO live_acquisition_source_receipts (
      id, handoff_id, final_run_id, ordinal, logical_page_id,
      logical_page_generation_id, capture_manifest_id, depth, capture_sequence,
      inclusion_state, included_order,
      content_revision, content_digest, extracted_at, manifest_json,
      receipt_digest, created_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 0, 1, 'included', 1, 1, ?, ?, '{}', ?, ?)
  `).run(
    sourceReceiptId,
    handoffId,
    finalRunId,
    logicalPageId,
    pageGenerationId,
    captureManifestId,
    contentDigest,
    liveResearchFixtureAt,
    sourceReceiptDigest,
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO research_sources (
      id, run_id, ordinal, logical_page_id, content_revision, content_digest,
      extracted_at, source_kind, acquisition_method, handoff_source_receipt_id,
      access_class_snapshot, eligibility, inclusion_state, included_order, created_at
    ) VALUES (
      ?, ?, 1, ?, 1, ?, ?, 'live_acquisition', 'safe_public_http_v1', ?,
      'public', 'eligible', 'included', 1, ?
    )
  `).run(
    sourceId,
    finalRunId,
    logicalPageId,
    contentDigest,
    liveResearchFixtureAt,
    sourceReceiptId,
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO research_source_state_events (
      source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'accepted', 'valid', NULL, 'live-fixture-source-accepted', ?)
  `).run(sourceId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO research_source_payloads (
      source_id, url_snapshot, title_snapshot, evidence_material,
      chunk_manifest_json, payload_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sourceId,
    draft.sources[0]!.payload!.url,
    draft.sources[0]!.payload!.title,
    liveResearchFixtureEvidence,
    canonicalJson(chunkManifest),
    contentDigest,
  );
  connection.prepare(`
    INSERT INTO live_acquisition_provider_reservations (
      id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
    ) VALUES (1, ?, ?, '2026-08-14', 1, 'active', ?)
  `).run(handoffId, finalJobId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_handoff_receipts (
      handoff_id, receipt_digest, completed_at
    ) VALUES (?, ?, ?)
  `).run(handoffId, "9".repeat(64), liveResearchFixtureCompletedAt);

  return {
    coordinatorJobId,
    finalJobId,
    finalRunId,
    sourceId,
    sourceReceiptId,
    sourceReceiptDigest,
    handoffId,
    draft,
  };
}
