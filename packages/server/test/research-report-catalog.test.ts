import { createHash } from "node:crypto";

import {
  estimateResearchReservationV1,
  projectAgentResearchReportDetail,
  researchCanonicalSha256PayloadV1,
  researchSelectionFingerprintPayload,
  type ResearchApprovalRequest,
  type ResearchApprovedDraft,
  type ResearchClaimDraft,
  type ResearchEvidenceDraft,
  type ResearchPublicationDraft,
  type ResearchTarget,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createAiJobLedger,
  type AiJobCheckpointInput,
  type AiJobLedger,
  type ResearchLedgerAdapter,
} from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createResearchCorpusReader } from "../src/research-corpus.js";
import {
  createResearchReportCatalog,
  ResearchReportCatalogError,
} from "../src/research-report-catalog.js";
import { renderResearchReportText } from "../src/research-report-renderer.js";
import {
  buildCurrentResearchDraft,
  createResearchStore,
  fingerprintResearchApproval,
  fingerprintResearchCorpus,
} from "../src/research-store.js";
import {
  liveResearchFixtureCompletedAt,
  liveResearchFixtureEvidence,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

const baseTime = "2026-08-14T12:00:00.000Z";
const budget = {
  maxSteps: 10,
  maxTokens: 4_000,
  maxCostUsd: 1,
  maxWallTimeMs: 60_000,
} as const;
const limits = {
  maxConcurrent: 1,
  maxAttemptsPerUtcDay: 10,
  maxCostUsdPerUtcDay: 2,
} as const;
const evidenceMaterial = "A界B research evidence";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

function dossier(summary: string) {
  return {
    executiveSummary: summary,
    valueForUser: `Value: ${summary}`,
    capabilities: ["Capability"],
    limitations: ["Limitation"],
    risks: [] as string[],
    unknowns: ["Unknown"],
    nextSteps: ["Next step"],
  };
}

const defaultCheckpointDigests = {
  corpusDigest: "1".repeat(64),
  parentDigest: null as string | null,
  providerInputDigest: "2".repeat(64),
  quoteDigest: "3".repeat(64),
};

function checkpoint(usage = {
  steps: 2,
  inputTokens: 20,
  outputTokens: 10,
  costUsd: 0.02,
  wallTimeMs: 200,
}, total: number | null = 1, digests = defaultCheckpointDigests): AiJobCheckpointInput {
  return {
    progress: { completed: 1, total, stage: "terminal_publication" },
    checkpoint: {
      version: 1,
      nextStep: 2,
      stage: "terminal_publication",
      ...digests,
      providerOutputDigest: "4".repeat(64),
    },
    usage,
  };
}

function providerReadyCheckpoint(
  total: number | null = 1,
  usage: AiJobCheckpointInput["usage"] = {
    steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
  },
  digests = defaultCheckpointDigests,
): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total, stage: "provider_ready" },
    checkpoint: {
      version: 1,
      nextStep: 1,
      stage: "provider_ready",
      ...digests,
    },
    usage,
  };
}

function claimedCheckpoint(total: number | null = 1): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function seedBase(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (41, 'https://openai.com/catalog/page', 'https://openai.com/catalog/page',
       'https://openai.com/catalog/page', '${baseTime}', '${baseTime}'),
      (42, 'https://openai.com/catalog/empty', 'https://openai.com/catalog/empty',
       'https://openai.com/catalog/empty', '${baseTime}', '${baseTime}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      71, 'https://openai.com/catalog/page', 'https://openai.com/catalog/page',
      'Immutable source title', 'chrome', 'inbox', 0, 1,
      '${baseTime}', '${baseTime}', 41
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (71, '${evidenceMaterial}', '${baseTime}', 3);
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (51, 'website:openai.com', '${baseTime}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (
      61, 51, 1, 'OpenAI', 'website', 'public', 'active',
      'user', 'manual', '${baseTime}'
    );
    INSERT INTO resource_heads (resource_id, event_id) VALUES (51, 61);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES (
      81, 41, 'assigned', 51, 'user_manual', 'user', 'manual',
      'catalog-assignment', '${baseTime}'
    );
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (41, 81);
  `);
}

function targetSubject(target: ResearchTarget): ResourceResearchTaskSpec["subject"] {
  return target.type === "page"
    ? { type: "page", logicalPageId: target.logicalPageId }
    : target.type === "resource"
      ? { type: "resource", resourceId: target.resourceId }
      : { type: "selection", fingerprint: target.fingerprint };
}

function approvedDraft(
  target: ResearchTarget,
  parentReportId: number | null,
  snapshots: ResearchApprovedDraft["snapshots"] = [],
): ResearchApprovedDraft {
  const question = "What matters?";
  const raw = {
    version: 1 as const,
    target,
    question,
    scope: {
      acquisitionLevel: "captured_only" as const,
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: [] as string[],
        sensitiveOriginDigests: [] as string[],
      },
    },
    parentReportId,
    approvalFingerprint: "0".repeat(64),
    corpusFingerprint: "0".repeat(64),
    workflowRef: { id: "catalog-fixture", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength(evidenceMaterial, "utf8"),
      snapshotBytes: snapshots.reduce((total, snapshot) =>
        total + Buffer.byteLength(canonicalJson(snapshot.material), "utf8"), 0),
      questionBytes: Buffer.byteLength(question, "utf8"),
      budget,
    }),
    sources: [{
      sourceKind: "captured" as const,
      ordinal: 1,
      logicalPageId: 41,
      tabId: 71,
      selectedTabId: 71,
      contentRevision: 3,
      contentDigest: digest(evidenceMaterial),
      extractedAt: baseTime,
      acquisitionMethod: "captured" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      handoffSourceReceiptId: null,
      handoffSourceReceiptDigest: null,
      payload: {
        url: "https://openai.com/catalog/page",
        title: "Immutable source title",
        evidenceMaterial,
        chunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: Buffer.byteLength(evidenceMaterial, "utf8"),
          chunkDigest: digest(evidenceMaterial),
          truncated: false,
        },
      },
    }],
    snapshots,
  };
  const withApproval = { ...raw, approvalFingerprint: fingerprintResearchApproval(raw) };
  return { ...withApproval, corpusFingerprint: fingerprintResearchCorpus(withApproval) };
}

function approvalRequest(draft: ResearchApprovedDraft) {
  return {
    version: draft.version,
    target: draft.target,
    question: draft.question,
    scope: draft.scope,
    parentReportId: draft.parentReportId,
    approvalFingerprint: draft.approvalFingerprint,
    workflowRef: draft.workflowRef,
    budget: draft.budget,
    estimate: draft.estimate,
    captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
  };
}

function buildApprovedCurrentDraft(
  connection: ReturnType<typeof openDatabase>["connection"],
  target: ResearchTarget,
  maxIncludedSources: number,
): ResearchApprovedDraft {
  const raw: ResearchApprovalRequest = {
    version: 1,
    target,
    question: "What matters?",
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: true,
      maxIncludedSources,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "catalog-current-fixture", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 0,
      includedSourceBytes: 0,
      snapshotBytes: 0,
      questionBytes: 0,
      budget,
    }),
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
  const initial = buildCurrentResearchDraft(connection, raw, { clock: () => new Date(baseTime) });
  return buildCurrentResearchDraft(connection, {
    ...raw,
    approvalFingerprint: fingerprintResearchApproval(initial),
  }, { clock: () => new Date(baseTime) });
}

function seedSecondPage(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      43, 'https://openai.com/catalog/related', 'https://openai.com/catalog/related',
      'https://openai.com/catalog/related', '${baseTime}', '${baseTime}'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      72, 'https://openai.com/catalog/related', 'https://openai.com/catalog/related',
      'Related immutable title', 'chrome', 'inbox', 0, 1,
      '${baseTime}', '${baseTime}', 43
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (72, 'related material', '${baseTime}', 1);
  `);
}

interface Harness {
  readonly database: ReturnType<typeof openDatabase>;
  readonly ledger: AiJobLedger;
  readonly research: ResearchLedgerAdapter;
  clock: Date;
  sequence: number;
}

function harness(): Harness {
  const database = openDatabase(":memory:", { migrationClock: () => new Date(baseTime) });
  seedBase(database.connection);
  const value = {
    database,
    clock: new Date(baseTime),
    sequence: 0,
    ledger: undefined as unknown as AiJobLedger,
    research: undefined as unknown as ResearchLedgerAdapter,
  };
  const research = createResearchStore(database.connection, { clock: () => value.clock });
  value.research = research;
  value.ledger = createAiJobLedger(database.connection, {
    clock: () => value.clock,
    token: () => `catalog-lease-token-${String(++value.sequence).padStart(4, "0")}`,
    kindAvailable: () => true,
    research,
  });
  return value;
}

function publish(
  value: Harness,
  target: ResearchTarget,
  options: {
    readonly draft?: ResearchApprovedDraft;
    readonly parentReportId?: number | null;
    readonly status?: "succeeded" | "partial";
    readonly summary?: string;
    readonly claims?: (
      sourceIds: readonly number[],
      runId: number,
    ) => readonly ResearchClaimDraft[];
    readonly snapshots?: ResearchApprovedDraft["snapshots"];
    readonly usage?: AiJobCheckpointInput["usage"];
    readonly coverage?: ResearchPublicationDraft["coverage"];
    readonly usedSourceOrdinals?: readonly number[];
  } = {},
): number {
  const draft = options.draft ?? approvedDraft(
    target, options.parentReportId ?? null, options.snapshots ?? [],
  );
  const idempotencyKey = `catalog-${++value.sequence}`;
  const task: ResourceResearchTaskSpec = {
    version: 1,
    kind: "resource_research",
    subject: targetSubject(target),
    workflowRef: draft.workflowRef,
    inputFingerprint: draft.approvalFingerprint,
    idempotencyKey,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget,
  };
  value.ledger.submitResearch(task, approvalRequest(draft));
  const claim = value.ledger.claimNext("resource_research", `worker-${value.sequence}`, limits)!;
  const corpus = createResearchCorpusReader(value.database.connection).readForJob(
    `resource_research:${claim.id}`,
  );
  const checkpointDigests = {
    ...defaultCheckpointDigests,
    corpusDigest: corpus.corpusDigest,
    parentDigest: corpus.parent?.digest ?? null,
  };
  const progressTotal = target.type === "selection" ? null : 1;
  value.ledger.checkpoint(claim, claimedCheckpoint(progressTotal));
  value.ledger.checkpoint(claim, providerReadyCheckpoint(
    progressTotal, undefined, checkpointDigests,
  ));
  value.ledger.bindAttemptProvider(claim, {
    provider: "fixture-provider",
    model: `fixture-model-${value.sequence}`,
    promptVersion: "fixture-v1",
    pricingVersion: "fixture-pricing-v1",
  });
  value.ledger.recordAttemptRequest(claim, `request-${value.sequence}`);
  const run = value.database.connection.prepare(`
    SELECT id, corpus_fingerprint FROM research_runs WHERE job_id = ?
  `).get(claim.id) as { id: number; corpus_fingerprint: string };
  const sourceIds = value.database.connection.prepare(`
    SELECT id FROM research_sources WHERE run_id = ? ORDER BY ordinal
  `).pluck().all(run.id) as number[];
  const usage = options.usage ?? checkpoint().usage;
  const claims = options.claims?.(sourceIds, run.id) ?? [{
    claim: "The immutable source contains evidence.",
    confidence: 0.9,
    isInference: false,
    rationale: null,
    evidence: [{
      kind: "tab_content" as const,
      sourceId: sourceIds[0]!,
      locator: {
        version: "utf8_range:v1" as const,
        byteStart: 1,
        byteEnd: 4,
      },
      excerptHash: digest(Buffer.from(evidenceMaterial, "utf8").subarray(1, 4)),
    }],
  }];
  const status = options.status ?? "succeeded";
  const result = value.ledger.completeResearch(
    claim, checkpoint(usage, progressTotal, checkpointDigests), {
    version: 1,
    status,
    reason: status === "succeeded" ? null : "budget_exhausted",
    corpusFingerprint: run.corpus_fingerprint,
    inputFingerprint: draft.approvalFingerprint,
    coverage: options.coverage ?? {
      discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0,
    },
    usedSourceIds: (options.usedSourceOrdinals ?? [1]).map((ordinal) =>
      sourceIds[ordinal - 1]!),
    provenance: {
      provider: "fixture-provider",
      model: `fixture-model-${value.sequence}`,
      promptVersion: "fixture-v1",
      pricingVersion: "fixture-pricing-v1",
      requestId: `request-${value.sequence}`,
      generatedAt: value.clock.toISOString(),
      usage,
    },
    dossier: dossier(options.summary ?? `Report ${value.sequence}`),
    claims: [...claims],
    },
  );
  expect(result.status).toBe(status);
  const outcome = result.result;
  if (outcome === null) throw new Error("Expected a published research report");
  return outcome.type === "resource_research" ? outcome.reportId : 0;
}

function failResearch(
  value: Harness,
  target: ResearchTarget,
  parentReportId: number | null,
): void {
  const draft = approvedDraft(target, parentReportId);
  const task: ResourceResearchTaskSpec = {
    version: 1,
    kind: "resource_research",
    subject: targetSubject(target),
    workflowRef: draft.workflowRef,
    inputFingerprint: draft.approvalFingerprint,
    idempotencyKey: `catalog-failed-${++value.sequence}`,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget,
  };
  value.ledger.submitResearch(task, approvalRequest(draft));
  const claim = value.ledger.claimNext(
    "resource_research", `failed-worker-${value.sequence}`, limits,
  )!;
  expect(value.ledger.fail(claim, claimedCheckpoint(target.type === "selection" ? null : 1), {
    code: "JOB_INPUT_UNAVAILABLE",
  }).status)
    .toBe("failed");
}

function publishPageContextReport(value: Harness): number {
  value.database.connection.exec(`
    INSERT INTO context_entries (
      id, logical_page_id, kind, body, actor, method, visibility, state,
      operation, revision, idempotency_key, created_at
    ) VALUES (
      501, 41, 'purpose', 'snapshot corruption fixture', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'catalog-snapshot-corruption', '${baseTime}'
    );
  `);
  const target = { type: "page" as const, logicalPageId: 41 };
  const draft = buildApprovedCurrentDraft(value.database.connection, target, 1);
  return publish(value, target, {
    draft,
    coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
    usedSourceOrdinals: [],
    claims: (_sourceIds, runId) => {
      const snapshot = value.database.connection.prepare(`
        SELECT snapshot.id, payload.material_json
        FROM research_page_context_snapshots AS snapshot
        JOIN research_snapshot_payloads AS payload
          ON payload.kind = 'page_context' AND payload.snapshot_id = snapshot.id
        WHERE snapshot.run_id = ? ORDER BY snapshot.id LIMIT 1
      `).get(runId) as { id: number; material_json: string };
      return [{
        claim: "Snapshot integrity must be verified.",
        confidence: 1,
        isInference: false,
        rationale: null,
        evidence: [{
          kind: "page_context",
          snapshotId: snapshot.id,
          locator: { version: "whole_snapshot:v1" },
          excerptHash: digest(snapshot.material_json),
        }],
      }];
    },
  });
}

function publishReceiptBackedLiveReport(
  connection: ReturnType<typeof openDatabase>["connection"],
): number {
  const fixture = seedReceiptBackedLiveResearchRun(connection);
  const terminalAt = new Date(liveResearchFixtureCompletedAt);
  let publishedReportId: number | null = null;
  const backingResearch = createResearchStore(connection, { clock: () => terminalAt });
  const research: ResearchLedgerAdapter = {
    ...backingResearch,
    publish(_jobId, draft) {
      if (publishedReportId === null) {
        throw new Error("Live report fixture was not assembled before completion");
      }
      return { reportId: publishedReportId, status: draft.status };
    },
  };
  const ledger = createAiJobLedger(connection, {
    clock: () => terminalAt,
    token: () => "live-report-lease-token-0001",
    kindAvailable: () => true,
    research,
  });
  const claim = ledger.claimNext(
    "resource_research",
    "live-report-worker",
    limits,
    undefined,
    [{ id: "research_workflow:c81:v1", version: 1 }],
  );
  if (claim === undefined) throw new Error("Expected the live research job to be claimable");
  const corpus = createResearchCorpusReader(connection).readForJob(
    `resource_research:${fixture.finalJobId}`,
  );
  const checkpointDigests = {
    ...defaultCheckpointDigests,
    corpusDigest: corpus.corpusDigest,
    parentDigest: null,
  };
  ledger.checkpoint(claim, claimedCheckpoint());
  ledger.checkpoint(claim, providerReadyCheckpoint(1, undefined, checkpointDigests));
  ledger.bindAttemptProvider(claim, {
    provider: "live-fixture-provider",
    model: "live-fixture-model",
    promptVersion: "live-fixture-v1",
    pricingVersion: "live-fixture-pricing-v1",
  });
  ledger.recordAttemptRequest(claim, "live-fixture-request");

  const usage = checkpoint().usage;
  const coverage = {
    discovered: 1,
    captured: 1,
    eligible: 1,
    used: 1,
    missing: 0,
    failed: 0,
  };
  const coverageJson = canonicalJson(coverage);
  const provenance = {
    provider: "live-fixture-provider",
    model: "live-fixture-model",
    promptVersion: "live-fixture-v1",
    pricingVersion: "live-fixture-pricing-v1",
    requestId: "live-fixture-request",
    generatedAt: liveResearchFixtureCompletedAt,
    usage,
  };
  const reportDossier = dossier("Receipt-backed live report");
  const locator = {
    version: "utf8_range:v1" as const,
    byteStart: 0,
    byteEnd: Buffer.byteLength(liveResearchFixtureEvidence, "utf8"),
  };
  const claimText = "The receipt-backed live source contains public evidence.";
  const claims: ResearchClaimDraft[] = [{
    claim: claimText,
    confidence: 1,
    isInference: false,
    rationale: null,
    evidence: [{
      kind: "tab_content",
      sourceId: fixture.sourceId,
      locator,
      excerptHash: digest(liveResearchFixtureEvidence),
    }],
  }];
  const reportText = renderResearchReportText(reportDossier, claims);
  const reportResult = connection.prepare(`
    INSERT INTO research_reports (
      run_id, target_resource_id, target_key, version, publish_status,
      coverage_json, coverage_fingerprint, provenance_json, input_fingerprint, created_at
    ) VALUES (?, ?, ?, 1, 'succeeded', ?, ?, ?, ?, ?)
  `).run(
    fixture.finalRunId,
    fixture.draft.target.type === "resource" ? fixture.draft.target.resourceId : 0,
    fixture.draft.target.type === "resource"
      ? `resource:${fixture.draft.target.resourceId}`
      : "invalid",
    coverageJson,
    digest(coverageJson),
    canonicalJson(provenance),
    fixture.draft.approvalFingerprint,
    liveResearchFixtureCompletedAt,
  );
  const reportId = Number(reportResult.lastInsertRowid);
  publishedReportId = reportId;
  connection.prepare(`
    INSERT INTO research_report_payloads (
      report_id, report_text, structured_json, payload_digest
    ) VALUES (?, ?, ?, ?)
  `).run(
    reportId,
    reportText,
    canonicalJson(reportDossier),
    digest(canonicalJson({ text: reportText, dossier: reportDossier })),
  );
  connection.prepare(`
    INSERT INTO research_report_sources (report_id, source_id, used_order)
    VALUES (?, ?, 1)
  `).run(reportId, fixture.sourceId);
  const claimResult = connection.prepare(`
    INSERT INTO research_claims (
      report_id, ordinal, claim_digest, confidence, is_inference, rationale_digest
    ) VALUES (?, 1, ?, 1, 0, NULL)
  `).run(reportId, digest(claimText));
  const claimId = Number(claimResult.lastInsertRowid);
  connection.prepare(`
    INSERT INTO research_claim_payloads (claim_id, claim_text, inference_rationale)
    VALUES (?, ?, NULL)
  `).run(claimId, claimText);
  const locatorJson = canonicalJson(locator);
  const evidenceResult = connection.prepare(`
    INSERT INTO research_claim_evidence (
      claim_id, report_id, run_id, ordinal, kind, source_id,
      locator_digest, excerpt_hash
    ) VALUES (?, ?, ?, 1, 'tab_content', ?, ?, ?)
  `).run(
    claimId,
    reportId,
    fixture.finalRunId,
    fixture.sourceId,
    digest(locatorJson),
    digest(liveResearchFixtureEvidence),
  );
  const evidenceId = Number(evidenceResult.lastInsertRowid);
  connection.prepare(`
    INSERT INTO research_evidence_payloads (evidence_id, locator_json)
    VALUES (?, ?)
  `).run(evidenceId, locatorJson);
  connection.prepare(`
    INSERT INTO research_evidence_state_events (
      evidence_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'accepted', 'valid', NULL, 'live-fixture-evidence', ?)
  `).run(evidenceId, liveResearchFixtureCompletedAt);
  connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'published', 'fresh', NULL, 'live-fixture-report', ?)
  `).run(reportId, liveResearchFixtureCompletedAt);
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, report_id, idempotency_key, occurred_at
    ) VALUES (?, 3, 'succeeded', 'succeeded', ?, 'live-fixture-run-published', ?)
  `).run(fixture.finalRunId, reportId, liveResearchFixtureCompletedAt);

  ledger.completeResearch(claim, checkpoint(usage, 1, checkpointDigests), {
    version: 1,
    status: "succeeded",
    reason: null,
    corpusFingerprint: fixture.draft.corpusFingerprint,
    inputFingerprint: fixture.draft.approvalFingerprint,
    coverage,
    usedSourceIds: [fixture.sourceId],
    provenance,
    dossier: reportDossier,
    claims,
  });
  return reportId;
}

type Connection = ReturnType<typeof openDatabase>["connection"];

const dependentCorruptionCases: ReadonlyArray<readonly [
  string,
  (connection: Connection, reportId: number) => void,
]> = [
  ["coverage", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_reports_immutable_update");
    connection.prepare("UPDATE research_reports SET coverage_json = '{}' WHERE id = ?")
      .run(reportId);
  }],
  ["provenance", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_reports_immutable_update");
    connection.prepare("UPDATE research_reports SET provenance_json = '{}' WHERE id = ?")
      .run(reportId);
  }],
  ["dossier", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_report_payloads_immutable_update");
    connection.prepare("UPDATE research_report_payloads SET structured_json = '{}' WHERE report_id = ?")
      .run(reportId);
  }],
  ["claim", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_claim_payloads_immutable_update");
    connection.prepare(`
      UPDATE research_claim_payloads SET claim_text = 'tampered claim'
      WHERE claim_id = (SELECT id FROM research_claims WHERE report_id = ? LIMIT 1)
    `).run(reportId);
  }],
  ["locator", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_evidence_payloads_immutable_update");
    connection.prepare(`
      UPDATE research_evidence_payloads
      SET locator_json = '{"byteEnd":4,"byteStart":0,"version":"utf8_range:v1"}'
      WHERE evidence_id = (
        SELECT id FROM research_claim_evidence WHERE report_id = ? LIMIT 1)
    `).run(reportId);
  }],
  ["excerpt hash", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_claim_evidence_immutable_update");
    connection.prepare(`
      UPDATE research_claim_evidence SET excerpt_hash = '${"f".repeat(64)}'
      WHERE report_id = ?
    `).run(reportId);
  }],
  ["report head", (connection, reportId) => {
    connection.pragma("foreign_keys = OFF");
    connection.exec(`
      DROP TRIGGER research_report_state_events_immutable_delete;
      DROP TRIGGER privacy_purge26_research_report_state_events_delete_fence;
    `);
    connection.prepare("DELETE FROM research_report_state_events WHERE report_id = ?")
      .run(reportId);
  }],
  ["evidence head", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_evidence_state_events_immutable_delete");
    connection.prepare(`
      DELETE FROM research_evidence_state_events WHERE evidence_id IN (
        SELECT id FROM research_claim_evidence WHERE report_id = ?)
    `).run(reportId);
  }],
  ["source head", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_source_state_events_immutable_delete");
    connection.prepare(`
      DELETE FROM research_source_state_events WHERE source_id IN (
        SELECT source.id FROM research_sources AS source
        JOIN research_reports AS report ON report.run_id = source.run_id
        WHERE report.id = ?)
    `).run(reportId);
  }],
  ["target head", (connection) => {
    connection.exec(`
      DROP TRIGGER research_target_heads_no_delete;
      DELETE FROM research_target_heads WHERE target_key = 'page:41';
    `);
  }],
  ["report payload", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_report_payloads_redaction_guard");
    connection.prepare("DELETE FROM research_report_payloads WHERE report_id = ?").run(reportId);
  }],
  ["evidence payload", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_evidence_payloads_redaction_guard");
    connection.prepare(`
      DELETE FROM research_evidence_payloads WHERE evidence_id IN (
        SELECT id FROM research_claim_evidence WHERE report_id = ?)
    `).run(reportId);
  }],
  ["source payload", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_source_payloads_redaction_guard");
    connection.prepare(`
      DELETE FROM research_source_payloads WHERE source_id IN (
        SELECT source.id FROM research_sources AS source
        JOIN research_reports AS report ON report.run_id = source.run_id
        WHERE report.id = ?)
    `).run(reportId);
  }],
];

const invalidRangeCases: ReadonlyArray<readonly [string, { readonly byteStart: number; readonly byteEnd: number }]> = [
  ["split UTF-8 code point", { byteStart: 1, byteEnd: 2 }],
  ["out-of-range byte end", { byteStart: 1, byteEnd: 100 }],
];

const snapshotCorruptionCases: ReadonlyArray<readonly [
  string,
  (connection: Connection, reportId: number) => void,
]> = [
  ["snapshot head", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_snapshot_state_events_immutable_delete");
    connection.prepare(`
      DELETE FROM research_snapshot_state_events WHERE kind = 'page_context'
        AND snapshot_id IN (
          SELECT snapshot.id FROM research_page_context_snapshots AS snapshot
          JOIN research_reports AS report ON report.run_id = snapshot.run_id
          WHERE report.id = ?)
    `).run(reportId);
  }],
  ["snapshot payload", (connection, reportId) => {
    connection.exec("DROP TRIGGER research_snapshot_payloads_redaction_guard");
    connection.prepare(`
      DELETE FROM research_snapshot_payloads WHERE kind = 'page_context'
        AND snapshot_id IN (
          SELECT snapshot.id FROM research_page_context_snapshots AS snapshot
          JOIN research_reports AS report ON report.run_id = snapshot.run_id
          WHERE report.id = ?)
    `).run(reportId);
  }],
];

describe("ResearchReportCatalog", () => {
  it("preserves live-source provenance in local and agent report detail", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(baseTime) });
    try {
      const reportId = publishReceiptBackedLiveReport(database.connection);

      const local = createResearchReportCatalog(database.connection).get(reportId);
      expect(local?.claims[0]?.evidence[0]).toMatchObject({
        kind: "tab_content",
        sourceKind: "live_acquisition",
        acquisitionMethod: "safe_public_http_v1",
        excerpt: liveResearchFixtureEvidence,
      });
      if (local === undefined) throw new Error("Expected local live report detail");
      expect(projectAgentResearchReportDetail(local).claims[0]?.evidence[0]).toMatchObject({
        kind: "tab_content",
        sourceKind: "live_acquisition",
        acquisitionMethod: "safe_public_http_v1",
      });
      expect(database.connection.prepare("SELECT COUNT(*) FROM tabs").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("lists existing empty targets and rejects missing targets without writes", () => {
    const value = harness();
    try {
      const catalog = createResearchReportCatalog(value.database.connection);
      const before = value.database.connection.prepare("SELECT total_changes()").pluck().get();
      expect(catalog.list({ targetType: "page", targetId: 42, limit: 50 })).toEqual({
        target: { type: "page", logicalPageId: 42 },
        head: {
          latestPublishedReportId: null,
          currentFreshReportId: null,
          lastSuccessfulReportId: null,
        },
        latestRun: null,
        items: [],
        nextBeforeVersion: null,
      });
      expect(catalog.list({ targetType: "resource", targetId: 51, limit: 50 })).toEqual({
        target: { type: "resource", resourceId: 51 },
        head: {
          latestPublishedReportId: null,
          currentFreshReportId: null,
          lastSuccessfulReportId: null,
        },
        latestRun: null,
        items: [],
        nextBeforeVersion: null,
      });
      expect(() => catalog.list({ targetType: "page", targetId: 999, limit: 50 }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_TARGET_NOT_FOUND" }));
      expect(catalog.get(999)).toBeUndefined();
      expect(value.database.connection.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    } finally {
      value.database.close();
    }
  });

  it("returns validated page detail with exact UTF-8 bytes and immutable source metadata", () => {
    const value = harness();
    try {
      const reportId = publish(value, { type: "page", logicalPageId: 41 }, {
        summary: "Page summary",
      });
      value.database.connection.prepare(`
        UPDATE tabs SET url = 'https://attacker.invalid/current', title = 'Changed live title'
        WHERE id = 71
      `).run();
      const catalog = createResearchReportCatalog(value.database.connection);
      const before = value.database.connection.prepare("SELECT total_changes()").pluck().get();
      const list = catalog.list({ targetType: "page", targetId: 41, limit: 50 });
      expect(list).toMatchObject({
        target: { type: "page", logicalPageId: 41 },
        head: {
          latestPublishedReportId: reportId,
          currentFreshReportId: reportId,
          lastSuccessfulReportId: reportId,
        },
        latestRun: { status: "succeeded", reportId },
        items: [{ id: reportId, executiveSummary: "Page summary" }],
      });
      const detail = catalog.get(reportId)!;
      expect(detail).toMatchObject({
        id: reportId,
        runStatus: "succeeded",
        target: { type: "page", logicalPageId: 41 },
        dossier: { executiveSummary: "Page summary" },
        provenance: {
          provider: "fixture-provider",
          pricingVersion: "fixture-pricing-v1",
          terminalAttemptId: 1,
          usage: checkpoint().usage,
        },
        claims: [{
          claimDigest: digest("The immutable source contains evidence."),
          rationaleDigest: null,
          evidence: [{
            kind: "tab_content",
            sourceKind: "captured",
            acquisitionMethod: "captured",
            locatorDigest: digest(canonicalJson({
              version: "utf8_range:v1", byteStart: 1, byteEnd: 4,
            })),
            excerpt: "界",
            url: "https://openai.com/catalog/page",
            title: "Immutable source title",
          }],
        }],
      });
      expect(value.database.connection.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    } finally {
      value.database.close();
    }
  });

  it("reconstructs selection targets and keeps archived Resource history readable", () => {
    const value = harness();
    try {
      const selectionFingerprint = digest(researchSelectionFingerprintPayload([41]));
      const selectionReport = publish(value, {
        type: "selection",
        logicalPageIds: [41],
        fingerprint: selectionFingerprint,
      });
      value.clock = new Date("2026-08-14T12:00:01.000Z");
      const resourceReport = publish(value, { type: "resource", resourceId: 51 });
      value.database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (52, 'website:openai-target.com', '2026-08-14T12:00:02.000Z');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (
          63, 52, 1, 'Merge target', 'website', 'public', 'active',
          'user', 'manual', '2026-08-14T12:00:02.000Z'
        );
        INSERT INTO resource_heads (resource_id, event_id) VALUES (52, 63);
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          merged_into_resource_id, created_by, creation_method, supersedes_id, created_at
        ) VALUES (
          62, 51, 2, 'OpenAI merged', 'website', 'public', 'merged', 52,
          'user', 'manual', 61, '2026-08-14T12:00:02.000Z'
        );
        UPDATE resource_heads SET event_id = 62 WHERE resource_id = 51;
      `);
      const catalog = createResearchReportCatalog(value.database.connection);
      expect(catalog.list({
        targetType: "selection", targetId: selectionFingerprint, limit: 50,
      }).target).toEqual({
        type: "selection", logicalPageIds: [41], fingerprint: selectionFingerprint,
      });
      expect(catalog.get(selectionReport)?.target).toEqual({
        type: "selection", logicalPageIds: [41], fingerprint: selectionFingerprint,
      });
      expect(catalog.list({ targetType: "resource", targetId: 51, limit: 50 }))
        .toMatchObject({ items: [{ id: resourceReport }] });
      expect(catalog.get(resourceReport)?.target).toEqual({ type: "resource", resourceId: 51 });
    } finally {
      value.database.close();
    }
  });

  it("returns head-aware history, a failed latest run, and strict version cursors", () => {
    const value = harness();
    try {
      const target = { type: "page" as const, logicalPageId: 41 };
      const first = publish(value, target, { summary: "First success" });
      value.clock = new Date("2026-08-14T12:00:01.000Z");
      const second = publish(value, target, {
        parentReportId: first,
        status: "partial",
        summary: "Second partial",
      });
      value.clock = new Date("2026-08-14T12:00:02.000Z");
      failResearch(value, target, second);

      const catalog = createResearchReportCatalog(value.database.connection);
      const firstPage = catalog.list({ targetType: "page", targetId: 41, limit: 1 });
      expect(firstPage).toMatchObject({
        head: {
          latestPublishedReportId: second,
          currentFreshReportId: first,
          lastSuccessfulReportId: first,
        },
        latestRun: { status: "failed", parentReportId: second, reportId: null },
        items: [{
          id: second,
          version: 2,
          publishStatus: "partial",
          reason: "budget_exhausted",
        }],
        nextBeforeVersion: 2,
      });
      const secondPage = catalog.list({
        targetType: "page", targetId: 41, limit: 1, beforeVersion: 2,
      });
      expect(secondPage.items).toMatchObject([
        { id: first, version: 1, publishStatus: "succeeded", reason: null },
      ]);
      expect(secondPage.nextBeforeVersion).toBeNull();
      expect(catalog.get(second)).toMatchObject({
        publishStatus: "partial",
        reason: "budget_exhausted",
      });
      expect(catalog.get(first)).toMatchObject({
        publishStatus: "succeeded",
        reason: null,
      });
    } finally {
      value.database.close();
    }
  });

  it("fails list and detail closed when the immutable publication reason contradicts status", () => {
    const value = harness();
    try {
      const target = { type: "page" as const, logicalPageId: 41 };
      const reportId = publish(value, target, { status: "partial" });
      value.database.connection.exec(
        "DROP TRIGGER research_report_state_events_immutable_update",
      );
      value.database.connection.prepare(`
        UPDATE research_report_state_events SET reason = NULL
        WHERE report_id = ? AND sequence_no = 1
      `).run(reportId);
      const catalog = createResearchReportCatalog(value.database.connection);
      expect(() => catalog.get(reportId)).toThrowError(expect.objectContaining({
        code: "RESEARCH_REPORT_STORAGE_CORRUPT",
      }));
      expect(() => catalog.list({ targetType: "page", targetId: 41, limit: 50 }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_REPORT_STORAGE_CORRUPT" }));
    } finally {
      value.database.close();
    }
  });

  it("attributes a retried publication to the exact terminal attempt and cumulative usage", () => {
    const value = harness();
    try {
      const target = { type: "page" as const, logicalPageId: 41 };
      const draft = approvedDraft(target, null);
      const task: ResourceResearchTaskSpec = {
        version: 1,
        kind: "resource_research",
        subject: targetSubject(target),
        workflowRef: draft.workflowRef,
        inputFingerprint: draft.approvalFingerprint,
        idempotencyKey: "catalog-retry",
        provenance: { requestedBy: "user", requestMethod: "manual" },
        schedulingPriority: 0,
        budget,
      };
      value.ledger.submitResearch(task, approvalRequest(draft));
      const first = value.ledger.claimNext("resource_research", "retry-one", limits)!;
      value.ledger.checkpoint(first, claimedCheckpoint());
      value.ledger.checkpoint(first, providerReadyCheckpoint());
      value.ledger.bindAttemptProvider(first, {
        provider: "discarded-provider", model: "discarded-model", promptVersion: "discarded-v1",
        pricingVersion: "discarded-pricing-v1",
      });
      value.ledger.recordAttemptRequest(first, "discarded-request");
      const firstUsage = {
        steps: 1, inputTokens: 11, outputTokens: 5, costUsd: 0.01, wallTimeMs: 100,
      };
      expect(value.ledger.fail(first, providerReadyCheckpoint(1, firstUsage), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-14T12:00:01.000Z",
      }).status).toBe("queued");

      value.clock = new Date("2026-08-14T12:00:01.000Z");
      const terminal = value.ledger.claimNext("resource_research", "retry-two", limits)!;
      value.ledger.bindAttemptProvider(terminal, {
        provider: "terminal-provider", model: "terminal-model", promptVersion: "terminal-v2",
        pricingVersion: "terminal-pricing-v1",
      });
      value.ledger.recordAttemptRequest(terminal, "terminal-request");
      const run = value.database.connection.prepare(`
        SELECT id, corpus_fingerprint FROM research_runs WHERE job_id = ?
      `).get(terminal.id) as { id: number; corpus_fingerprint: string };
      const sourceId = value.database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = ? ORDER BY ordinal LIMIT 1
      `).pluck().get(run.id) as number;
      const secondUsage = {
        steps: 2, inputTokens: 20, outputTokens: 10, costUsd: 0.02, wallTimeMs: 200,
      };
      const cumulativeUsage = {
        steps: 3, inputTokens: 31, outputTokens: 15, costUsd: 0.03, wallTimeMs: 300,
      };
      const completed = value.ledger.completeResearch(terminal, checkpoint(secondUsage), {
        version: 1,
        status: "succeeded",
        reason: null,
        corpusFingerprint: run.corpus_fingerprint,
        inputFingerprint: draft.approvalFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: {
          provider: "terminal-provider",
          model: "terminal-model",
          promptVersion: "terminal-v2",
          pricingVersion: "terminal-pricing-v1",
          requestId: "terminal-request",
          generatedAt: value.clock.toISOString(),
          usage: cumulativeUsage,
        },
        dossier: dossier("Retry report"),
        claims: [{
          claim: "Retry evidence",
          confidence: 1,
          isInference: false,
          rationale: null,
          evidence: [{
            kind: "tab_content",
            sourceId,
            locator: { version: "utf8_range:v1", byteStart: 1, byteEnd: 4 },
            excerptHash: digest(Buffer.from(evidenceMaterial, "utf8").subarray(1, 4)),
          }],
        }],
      });
      const outcome = completed.result;
      if (outcome === null) throw new Error("Expected a published research report");
      const reportId = outcome.type === "resource_research" ? outcome.reportId : 0;
      expect(createResearchReportCatalog(value.database.connection).get(reportId)?.provenance)
        .toMatchObject({
           provider: "terminal-provider",
           model: "terminal-model",
           promptVersion: "terminal-v2",
           pricingVersion: "terminal-pricing-v1",
           requestId: "terminal-request",
          terminalAttemptId: terminal.attemptId,
          usage: cumulativeUsage,
        });
    } finally {
      value.database.close();
    }
  });

  it("uses fixed query counts for high-fanout detail reads", () => {
    const value = harness();
    const originalPrepare = value.database.connection.prepare.bind(value.database.connection);
    const prepareSpy = vi.spyOn(value.database.connection, "prepare");
    let executions = 0;
    prepareSpy.mockImplementation(((source: string) => {
      const statement = originalPrepare(source);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get" || property === "all") {
            const execute = target[property].bind(target) as (...parameters: unknown[]) => unknown;
            return (...parameters: unknown[]) => {
              executions += 1;
              return execute(...parameters);
            };
          }
          const member = Reflect.get(target, property, target) as unknown;
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }) as typeof value.database.connection.prepare);
    try {
      prepareSpy.mockRestore();
      const reportId = publish(value, { type: "page", logicalPageId: 41 }, {
        claims: ([sourceId]) => Array.from({ length: 30 }, (_, index) => ({
          claim: `Claim ${index + 1}`,
          confidence: 0.9,
          isInference: false,
          rationale: null,
          evidence: [{
            kind: "tab_content" as const,
            sourceId: sourceId!,
            locator: { version: "utf8_range:v1" as const, byteStart: 1, byteEnd: 4 },
            excerptHash: digest(Buffer.from(evidenceMaterial, "utf8").subarray(1, 4)),
          }],
        })),
      });
      value.clock = new Date("2026-08-14T12:00:01.000Z");
      publish(value, { type: "page", logicalPageId: 41 }, { parentReportId: reportId });
      const countingPrepare = vi.spyOn(value.database.connection, "prepare");
      countingPrepare.mockImplementation(((source: string) => {
        const statement = originalPrepare(source);
        return new Proxy(statement, {
          get(target, property) {
            if (property === "get" || property === "all") {
              const execute = target[property].bind(target) as (...parameters: unknown[]) => unknown;
              return (...parameters: unknown[]) => {
                executions += 1;
                return execute(...parameters);
              };
            }
            const member = Reflect.get(target, property, target) as unknown;
            return typeof member === "function" ? member.bind(target) : member;
          },
        });
      }) as typeof value.database.connection.prepare);
      const catalog = createResearchReportCatalog(value.database.connection);
      executions = 0;
      expect(catalog.get(reportId)?.claims).toHaveLength(30);
      expect(executions).toBe(6);
      executions = 0;
      expect(catalog.list({ targetType: "page", targetId: 41, limit: 50 }).items).toHaveLength(2);
      expect(executions).toBe(9);
      countingPrepare.mockRestore();
    } finally {
      prepareSpy.mockRestore();
      value.database.close();
    }
  });

  it("fails closed when a dependent canonical digest is corrupt", () => {
    const value = harness();
    try {
      const reportId = publish(value, { type: "page", logicalPageId: 41 });
      value.database.connection.exec(`
        DROP TRIGGER research_report_payloads_immutable_update;
        UPDATE research_report_payloads SET payload_digest = '${"f".repeat(64)}'
        WHERE report_id = ${reportId};
      `);
      const catalog = createResearchReportCatalog(value.database.connection);
      for (const read of [
        () => catalog.list({ targetType: "page" as const, targetId: 41, limit: 50 }),
        () => catalog.get(reportId),
      ]) {
        expect(read).toThrowError(expect.objectContaining({
          code: "RESEARCH_REPORT_STORAGE_CORRUPT",
        } satisfies Partial<ResearchReportCatalogError>));
      }
    } finally {
      value.database.close();
    }
  });

  it("accepts an exact 64-KiB truncated source beside a payload-free excluded source", () => {
    const value = harness();
    try {
      seedSecondPage(value.database.connection);
      const fullMaterial = `${"a".repeat(65_536)}tail`;
      value.database.connection.prepare(`
        UPDATE contents SET text = ?, content_revision = 4 WHERE tab_id = 71
      `).run(fullMaterial);
      const logicalPageIds = [41, 43];
      const target = {
        type: "selection" as const,
        logicalPageIds,
        fingerprint: digest(researchSelectionFingerprintPayload(logicalPageIds)),
      };
      const draft = buildApprovedCurrentDraft(value.database.connection, target, 1);
      expect(draft.sources.map((source) => source.inclusionState))
        .toEqual(["included", "excluded"]);
      expect(draft.sources[0]?.payload?.chunkManifest).toMatchObject({
        byteStart: 0,
        byteEnd: 65_536,
        truncated: true,
      });
      expect(draft.sources[1]?.payload).toBeNull();
      const reportId = publish(value, target, {
        draft,
        coverage: {
          discovered: 2, captured: 2, eligible: 2, used: 1, missing: 0, failed: 0,
        },
        claims: ([sourceId]) => [{
          claim: "The captured boundary is byte exact.",
          confidence: 1,
          isInference: false,
          rationale: null,
          evidence: [{
            kind: "tab_content",
            sourceId: sourceId!,
            locator: {
              version: "utf8_range:v1", byteStart: 65_530, byteEnd: 65_536,
            },
            excerptHash: digest("aaaaaa"),
          }],
        }],
      });
      const detail = createResearchReportCatalog(value.database.connection).get(reportId)!;
      expect(detail.coverage).toEqual({
        discovered: 2, captured: 2, eligible: 2, used: 1, missing: 0, failed: 0,
      });
      expect(detail.claims[0]?.evidence[0]).toMatchObject({
        kind: "tab_content",
        excerpt: "aaaaaa",
        contentRevision: 4,
        contentDigest: digest(fullMaterial),
      });
    } finally {
      value.database.close();
    }
  });

  it("masks unrelated surviving source and snapshot payloads when the report is redacted", () => {
    const value = harness();
    try {
      seedSecondPage(value.database.connection);
      value.database.connection.exec(`
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility, state,
          operation, revision, idempotency_key, created_at
        ) VALUES (
          301, 41, 'purpose', 'unrelated surviving snapshot secret', 'user', 'manual',
          'share_with_ai', 'active', 'append', 1, 'catalog-context', '${baseTime}'
        );
      `);
      const logicalPageIds = [41, 43];
      const target = {
        type: "selection" as const,
        logicalPageIds,
        fingerprint: digest(researchSelectionFingerprintPayload(logicalPageIds)),
      };
      const draft = buildApprovedCurrentDraft(value.database.connection, target, 2);
      expect(draft.sources).toHaveLength(2);
      expect((draft.snapshots ?? []).some((snapshot) => snapshot.kind === "page_context"))
        .toBe(true);
      const reportId = publish(value, target, {
        draft,
        coverage: {
          discovered: 2, captured: 2, eligible: 2, used: 1, missing: 0, failed: 0,
        },
        claims: ([sourceId], runId) => {
          const snapshot = value.database.connection.prepare(`
            SELECT snapshot.id, payload.material_json
            FROM research_page_context_snapshots AS snapshot
            JOIN research_snapshot_payloads AS payload
              ON payload.kind = 'page_context' AND payload.snapshot_id = snapshot.id
            WHERE snapshot.run_id = ? ORDER BY snapshot.id LIMIT 1
          `).get(runId) as { id: number; material_json: string };
          return [{
            claim: "Report material must disappear as one unit.",
            confidence: 1,
            isInference: false,
            rationale: null,
            evidence: [{
              kind: "tab_content",
              sourceId: sourceId!,
              locator: { version: "utf8_range:v1", byteStart: 1, byteEnd: 4 },
              excerptHash: digest(Buffer.from(evidenceMaterial, "utf8").subarray(1, 4)),
            }, {
              kind: "page_context",
              snapshotId: snapshot.id,
              locator: { version: "whole_snapshot:v1" },
              excerptHash: digest(snapshot.material_json),
            }],
          }];
        },
      });
      const identities = value.database.connection.prepare(`
        SELECT id FROM research_sources
        WHERE run_id = (SELECT run_id FROM research_reports WHERE id = ?)
        ORDER BY ordinal
      `).pluck().all(reportId) as number[];
      const catalog = createResearchReportCatalog(value.database.connection);
      const beforeRedaction = catalog.get(reportId)!;
      expect(value.research.redactResearch({
        target: { type: "source", sourceId: identities[0]! },
        reason: "Forget the cited source",
        idempotencyKey: "catalog-source-redaction",
      })).toMatchObject({ sources: 1, reports: 1 });
      expect(value.database.connection.prepare(`
        SELECT COUNT(*) FROM research_source_payloads WHERE source_id = ?
      `).pluck().get(identities[1]!)).toBe(1);
      expect(value.database.connection.prepare(`
        SELECT COUNT(*) FROM research_snapshot_payloads
      `).pluck().get()).toBeGreaterThan(0);

      const detail = catalog.get(reportId)!;
      expect(detail).toMatchObject({ state: "redacted", dossier: null, reportText: null });
      expect(detail.claims).toHaveLength(1);
      expect(detail.claims[0]).toMatchObject({
        claimDigest: beforeRedaction.claims[0]!.claimDigest,
        claimText: null,
        rationaleDigest: beforeRedaction.claims[0]!.rationaleDigest,
        rationale: null,
      });
      for (const [index, evidence] of detail.claims[0]!.evidence.entries()) {
        expect(evidence).toMatchObject({ state: "redacted", locator: null, excerpt: null });
        expect(evidence.locatorDigest)
          .toBe(beforeRedaction.claims[0]!.evidence[index]!.locatorDigest);
        if (evidence.kind === "tab_content") {
          expect(evidence).toMatchObject({ url: null, title: null });
        }
      }
    } finally {
      value.database.close();
    }
  });

  it("validates and projects canonical evidence for every snapshot kind", () => {
    const value = harness();
    try {
      seedSecondPage(value.database.connection);
      value.database.connection.exec(`
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility, state,
          operation, revision, idempotency_key, created_at
        ) VALUES (
          401, 41, 'purpose', 'page context evidence', 'user', 'manual',
          'share_with_ai', 'active', 'append', 1, 'catalog-all-page', '${baseTime}'
        );
        INSERT INTO resource_context_entries (
          id, resource_id, kind, body, actor, method, visibility, state,
          operation, revision, idempotency_key, created_at
        ) VALUES (
          402, 51, 'project', 'resource context evidence', 'user', 'manual',
          'share_with_ai', 'active', 'append', 1, 'catalog-all-resource', '${baseTime}'
        );
        INSERT INTO logical_page_activity_daily (
          logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
        ) VALUES (41, '2026-08-14', 2000, 1000, '${baseTime}');
        INSERT INTO relations (from_entity_id, to_entity_id, kind, note, created_by)
          SELECT first.id, second.id, 'related', 'relation evidence', 'user'
          FROM knowledge_entities AS first, knowledge_entities AS second
          WHERE first.tab_id = 71 AND second.tab_id = 72;
      `);
      const logicalPageIds = [41, 43];
      const target = {
        type: "selection" as const,
        logicalPageIds,
        fingerprint: digest(researchSelectionFingerprintPayload(logicalPageIds)),
      };
      const draft = buildApprovedCurrentDraft(value.database.connection, target, 2);
      expect((draft.snapshots ?? []).map((snapshot) => snapshot.kind).sort()).toEqual([
        "activity", "page_context", "relation", "resource_context",
      ]);
      const reportId = publish(value, target, {
        draft,
        coverage: {
          discovered: 2, captured: 2, eligible: 2, used: 0, missing: 0, failed: 0,
        },
        usedSourceOrdinals: [],
        claims: (_sourceIds, runId) => {
          const snapshots = value.database.connection.prepare(`
            SELECT head.kind, head.snapshot_id, payload.material_json
            FROM research_snapshot_heads AS head
            JOIN research_snapshot_payloads AS payload
              ON payload.kind = head.kind AND payload.snapshot_id = head.snapshot_id
            WHERE CASE head.kind
              WHEN 'page_context' THEN EXISTS (
                SELECT 1 FROM research_page_context_snapshots s
                WHERE s.id = head.snapshot_id AND s.run_id = @runId)
              WHEN 'resource_context' THEN EXISTS (
                SELECT 1 FROM research_resource_context_snapshots s
                WHERE s.id = head.snapshot_id AND s.run_id = @runId)
              WHEN 'activity' THEN EXISTS (
                SELECT 1 FROM research_activity_snapshots s
                WHERE s.id = head.snapshot_id AND s.run_id = @runId)
              WHEN 'relation' THEN EXISTS (
                SELECT 1 FROM research_relation_snapshots s
                WHERE s.id = head.snapshot_id AND s.run_id = @runId)
            END
            ORDER BY head.kind, head.snapshot_id
          `).all({ runId }) as Array<{
            kind: "page_context" | "resource_context" | "activity" | "relation";
            snapshot_id: number;
            material_json: string;
          }>;
          const evidence: ResearchEvidenceDraft[] = snapshots.map((snapshot) => ({
            kind: snapshot.kind,
            snapshotId: snapshot.snapshot_id,
            locator: { version: "whole_snapshot:v1" },
            excerptHash: digest(snapshot.material_json),
          }));
          return [{
            claim: "All immutable snapshot classes contribute evidence.",
            confidence: 1,
            isInference: false,
            rationale: null,
            evidence,
          }];
        },
      });
      const evidence = createResearchReportCatalog(value.database.connection)
        .get(reportId)!.claims[0]!.evidence;
      expect(evidence.map((item) => item.kind).sort()).toEqual([
        "activity", "page_context", "relation", "resource_context",
      ]);
      expect(evidence.every((item) => item.locator?.version === "whole_snapshot:v1" &&
        item.excerpt !== null && digest(item.excerpt) === item.excerptHash)).toBe(true);
    } finally {
      value.database.close();
    }
  });

  it.each(dependentCorruptionCases)(
    "fails closed for corrupt %s storage",
    (_label, mutate) => {
      const value = harness();
      try {
        const reportId = publish(value, { type: "page", logicalPageId: 41 });
        mutate(value.database.connection, reportId);
        const catalog = createResearchReportCatalog(value.database.connection);
        for (const read of [
          () => catalog.get(reportId),
          () => catalog.list({ targetType: "page" as const, targetId: 41, limit: 50 }),
        ]) {
          expect(read).toThrowError(expect.objectContaining({
            code: "RESEARCH_REPORT_STORAGE_CORRUPT",
          } satisfies Partial<ResearchReportCatalogError>));
        }
      } finally {
        value.database.close();
      }
    },
  );

  it.each(invalidRangeCases)("rejects a %s locator during read", (_label, range) => {
    const value = harness();
    try {
      const reportId = publish(value, { type: "page", logicalPageId: 41 });
      const locator = canonicalJson({ version: "utf8_range:v1", ...range });
      value.database.connection.exec(`
        DROP TRIGGER research_evidence_payloads_immutable_update;
        DROP TRIGGER research_claim_evidence_immutable_update;
      `);
      value.database.connection.prepare(`
        UPDATE research_evidence_payloads SET locator_json = ?
        WHERE evidence_id = (
          SELECT id FROM research_claim_evidence WHERE report_id = ? LIMIT 1)
      `).run(locator, reportId);
      value.database.connection.prepare(`
        UPDATE research_claim_evidence SET locator_digest = ?
        WHERE report_id = ?
      `).run(digest(locator), reportId);
      const catalog = createResearchReportCatalog(value.database.connection);
      for (const read of [
        () => catalog.get(reportId),
        () => catalog.list({ targetType: "page" as const, targetId: 41, limit: 50 }),
      ]) {
        expect(read).toThrowError(expect.objectContaining({
          code: "RESEARCH_REPORT_STORAGE_CORRUPT",
        } satisfies Partial<ResearchReportCatalogError>));
      }
    } finally {
      value.database.close();
    }
  });

  it.each(snapshotCorruptionCases)(
    "fails closed for corrupt %s storage in detail and list",
    (_label, mutate) => {
      const value = harness();
      try {
        const reportId = publishPageContextReport(value);
        mutate(value.database.connection, reportId);
        const catalog = createResearchReportCatalog(value.database.connection);
        for (const read of [
          () => catalog.get(reportId),
          () => catalog.list({ targetType: "page" as const, targetId: 41, limit: 50 }),
        ]) {
          expect(read).toThrowError(expect.objectContaining({
            code: "RESEARCH_REPORT_STORAGE_CORRUPT",
          } satisfies Partial<ResearchReportCatalogError>));
        }
      } finally {
        value.database.close();
      }
    },
  );

  it("validates every returned history item, not only the newest report", () => {
    const value = harness();
    try {
      const target = { type: "page" as const, logicalPageId: 41 };
      const older = publish(value, target);
      value.clock = new Date("2026-08-14T12:00:01.000Z");
      publish(value, target, { parentReportId: older });
      value.database.connection.exec("DROP TRIGGER research_claim_payloads_immutable_update");
      value.database.connection.prepare(`
        UPDATE research_claim_payloads SET claim_text = 'corrupt older claim'
        WHERE claim_id = (SELECT id FROM research_claims WHERE report_id = ? LIMIT 1)
      `).run(older);
      expect(() => createResearchReportCatalog(value.database.connection).list({
        targetType: "page", targetId: 41, limit: 50,
      })).toThrowError(expect.objectContaining({
        code: "RESEARCH_REPORT_STORAGE_CORRUPT",
      } satisfies Partial<ResearchReportCatalogError>));
    } finally {
      value.database.close();
    }
  });
});
