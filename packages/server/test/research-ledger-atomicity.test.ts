import { createHash } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  estimateResearchReservationV1,
  researchSelectionFingerprintPayload,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  createAiJobLedger,
  RESEARCH_STALE_GUARD_DOSSIER,
  type AiJobCheckpointInput,
  type AiJobClaim,
  type AiJobLedger,
} from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createResearchCorpusReader } from "../src/research-corpus.js";
import {
  buildCurrentResearchDraft,
  buildCurrentResearchProjection,
  createResearchStore,
  fingerprintResearchApproval,
  fingerprintResearchCorpus,
  researchParentAvailability,
} from "../src/research-store.js";
import { createResearchWorkflow } from "../src/research-workflow.js";
import { renderResearchReportText } from "../src/research-report-renderer.js";

const now = "2026-08-13T14:00:00.000Z";
const limits = {
  maxConcurrent: 1,
  maxAttemptsPerUtcDay: 10,
  maxCostUsdPerUtcDay: 2,
} as const;
const researchBudget = { maxSteps: 10, maxTokens: 1000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const c81Budget = { maxSteps: 10, maxTokens: 4_000, maxCostUsd: 1,
  maxWallTimeMs: 60_000 };

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dossier(summary: string) {
  return {
    executiveSummary: summary,
    valueForUser: summary,
    capabilities: [] as string[],
    limitations: [] as string[],
    risks: [] as string[],
    unknowns: [] as string[],
    nextSteps: [] as string[],
  };
}

function publicationProvenance(model: string, requestId: string | null = null) {
  return {
    provider: "test",
    model,
    promptVersion: "v1",
    pricingVersion: "test-v1",
    requestId,
    generatedAt: now,
    usage: checkpoint().usage,
  };
}

function bindPublicationAttempt(
  ledger: AiJobLedger,
  claim: AiJobClaim,
  model: string,
  requestId: string | null = null,
): void {
  ledger.bindAttemptProvider(claim, {
    provider: "test", model, promptVersion: "v1", pricingVersion: "test-v1",
  });
  if (requestId !== null) ledger.recordAttemptRequest(claim, requestId);
}

interface CheckpointDigests {
  readonly corpusDigest: string;
  readonly parentDigest: string | null;
  readonly providerInputDigest: string;
  readonly quoteDigest: string;
}

const researchCheckpointDigests: CheckpointDigests = {
  corpusDigest: "1".repeat(64),
  parentDigest: null,
  providerInputDigest: "2".repeat(64),
  quoteDigest: "3".repeat(64),
};

function claimedCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: 1, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function providerReadyCheckpoint(
  digests = researchCheckpointDigests,
): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: 1, stage: "provider_ready" },
    checkpoint: {
      version: 1, nextStep: 1, stage: "provider_ready", ...digests,
    },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function currentCheckpointDigests(
  connection: ReturnType<typeof openDatabase>["connection"],
  claim: AiJobClaim,
) {
  const corpus = createResearchCorpusReader(connection).readForJob(
    `resource_research:${claim.id}`,
  );
  return {
    ...researchCheckpointDigests,
    corpusDigest: corpus.corpusDigest,
    parentDigest: corpus.parent?.digest ?? null,
  };
}

function preparePublicationCheckpoints(
  ledger: AiJobLedger,
  claim: AiJobClaim,
  connection: ReturnType<typeof openDatabase>["connection"],
) {
  const digests = currentCheckpointDigests(connection, claim);
  ledger.checkpoint(claim, claimedCheckpoint());
  ledger.checkpoint(claim, providerReadyCheckpoint(digests));
  return digests;
}

function persistedCorpus(
  connection: ReturnType<typeof openDatabase>["connection"],
  runId = 1,
): string {
  return connection.prepare(`
    SELECT corpus_fingerprint FROM research_runs WHERE id = ?
  `).pluck().get(runId) as string;
}

function seedCapturedPage(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      41, 'https://research.openai.com/page', 'https://research.openai.com/page',
      'https://research.openai.com/page', '${now}', '${now}'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      71, 'https://research.openai.com/page', 'https://research.openai.com/page', 'Research page',
      'chrome', 'inbox', 0, 1, '${now}', '${now}', 41
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (71, 'captured evidence', '${now}', 3);
  `);
}

function task(budget = researchBudget): ResourceResearchTaskSpec {
  return {
    version: 1,
    kind: "resource_research",
    subject: { type: "page", logicalPageId: 41 },
    workflowRef: { id: "captured-only", version: 1 },
    inputFingerprint: approvedDraft(budget).approvalFingerprint,
    idempotencyKey: "research-page-41-v1",
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 10,
    budget,
  };
}

function approvedDraft(budget = researchBudget) {
  const question = "What is valuable?";
  const evidenceMaterial = "captured evidence";
  const draft = {
    version: 1 as const,
    target: { type: "page" as const, logicalPageId: 41 },
    question,
    scope: {
      acquisitionLevel: "captured_only" as const,
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    corpusFingerprint: "0".repeat(64),
    workflowRef: { id: "captured-only", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength(evidenceMaterial, "utf8"),
      snapshotBytes: 0,
      questionBytes: Buffer.byteLength(question, "utf8"),
      budget,
    }),
    sources: [{
      ordinal: 1,
      logicalPageId: 41,
      tabId: 71,
      contentRevision: 3,
      contentDigest: digest("captured evidence"),
      extractedAt: now,
      acquisitionMethod: "captured" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      payload: {
        url: "https://research.openai.com/page",
        title: "Research page",
        evidenceMaterial,
        chunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: Buffer.byteLength("captured evidence", "utf8"),
          chunkDigest: digest("captured evidence"),
          truncated: false,
        },
      },
    }],
  };
  const withApproval = { ...draft, approvalFingerprint: fingerprintResearchApproval(draft) };
  return { ...withApproval, corpusFingerprint: fingerprintResearchCorpus(withApproval) };
}

function approvalRequest(budget = researchBudget) {
  const draft = approvedDraft(budget);
  return {
    version: draft.version, target: draft.target, question: draft.question, scope: draft.scope,
    parentReportId: draft.parentReportId, approvalFingerprint: draft.approvalFingerprint,
    workflowRef: draft.workflowRef, budget: draft.budget, estimate: draft.estimate,
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
}

function checkpoint(digests = researchCheckpointDigests): AiJobCheckpointInput {
  return {
    progress: { completed: 1, total: 1, stage: "terminal_publication" },
    checkpoint: {
      version: 1, nextStep: 2, stage: "terminal_publication",
      ...digests,
      providerOutputDigest: "4".repeat(64),
    },
    usage: {
      steps: 1,
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.01,
      wallTimeMs: 100,
    },
  };
}

function c81Request(budget = c81Budget) {
  return {
    version: 1 as const,
    target: { type: "page" as const, logicalPageId: 41 },
    question: "What is valuable?",
    includeShareableContext: true,
    maxIncludedSources: 100,
    parentReportId: null,
    budget,
    captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
    confirmedOrigins: { authenticatedOriginDigests: [] as string[],
      sensitiveOriginDigests: [] as string[] },
  };
}

function createC81Harness(database: ReturnType<typeof openDatabase>) {
  const research = createResearchStore(database.connection, { clock: () => new Date(now) });
  const ledger = createAiJobLedger(database.connection, {
    clock: () => new Date(now), token: () => "c81-workflow-token-0001",
    kindAvailable: () => true, research,
  });
  return createResearchWorkflow({
    current: (request) => buildCurrentResearchProjection(database.connection, request,
      { clock: () => new Date(now) }),
    parentAvailability: (target, parentReportId) =>
      researchParentAvailability(database.connection, target, parentReportId),
    submitResearch: (task, approval) => ledger.submitResearch(task, approval),
    submitAgentResearch: (task, approval, command) =>
      ledger.submitAgentResearch(task, approval, command),
    cancelResearch: (jobId) => ledger.cancel(
      "resource_research",
      Number(jobId.slice("resource_research:".length)),
    ),
    cancelAgentResearch: (jobId, command) => ledger.cancelAgentResearch(
      Number(jobId.slice("resource_research:".length)),
      command,
    ),
    redactResearch: (request) => research.redactResearch(request),
  });
}

describe("schema-24 research ledger atomicity", () => {
  it("keeps C81 capture, budget, confirmation and stale guards atomic", () => {
    const assertNoWrites = (database: ReturnType<typeof openDatabase>) => {
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_idempotency_receipts
      `).pluck().get()).toBe(0);
    };

    const empty = openDatabase(":memory:");
    try {
      seedCapturedPage(empty.connection);
      empty.connection.prepare(`DELETE FROM contents WHERE tab_id = 71`).run();
      const workflow = createC81Harness(empty);
      const request = c81Request();
      const preflight = workflow.preflight(request);
      expect(preflight.coverage).toMatchObject({ discovered: 1, captured: 0, used: 0,
        missing: 1 });
      expect(() => workflow.requestRun({ ...request, estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!, idempotencyKey: "c81-empty" }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_CAPTURE_REQUIRED" }));
      assertNoWrites(empty);
    } finally {
      empty.close();
    }

    const insufficient = openDatabase(":memory:");
    try {
      seedCapturedPage(insufficient.connection);
      const workflow = createC81Harness(insufficient);
      const request = c81Request({ ...c81Budget, maxTokens: 1_000 });
      const preflight = workflow.preflight(request);
      expect(() => workflow.requestRun({ ...request, estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!, idempotencyKey: "c81-budget" }))
        .toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      assertNoWrites(insufficient);
    } finally {
      insufficient.close();
    }

    const stale = openDatabase(":memory:");
    try {
      seedCapturedPage(stale.connection);
      const workflow = createC81Harness(stale);
      const request = c81Request();
      const preflight = workflow.preflight(request);
      stale.connection.prepare(`
        UPDATE contents SET text = 'changed after approval', content_revision = 4 WHERE tab_id = 71
      `).run();
      expect(() => workflow.requestRun({ ...request, estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!, idempotencyKey: "c81-stale" }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
      assertNoWrites(stale);
    } finally {
      stale.close();
    }

    const staleOrigin = openDatabase(":memory:");
    try {
      seedCapturedPage(staleOrigin.connection);
      const workflow = createC81Harness(staleOrigin);
      const request = c81Request();
      const preflight = workflow.preflight(request);
      staleOrigin.connection.prepare(`
        UPDATE tabs SET url = 'https://example.com/page'
        WHERE id = 71
      `).run();
      expect(() => workflow.requestRun({ ...request, estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!, idempotencyKey: "c81-stale-origin" }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
      assertNoWrites(staleOrigin);
    } finally {
      staleOrigin.close();
    }

    const confirmation = openDatabase(":memory:");
    try {
      seedCapturedPage(confirmation.connection);
      confirmation.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
          VALUES (81, 'host:research.openai.com', '${now}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (
          82, 81, 1, 'Research', 'website', 'authenticated', 'active',
          'system', 'derived', '${now}'
        );
        INSERT INTO resource_heads (resource_id, event_id) VALUES (81, 82);
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (83, 41, 'assigned', 81, 'registrable_domain', 'system', 'derived',
          'c81-auth', '${now}');
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
          VALUES (41, 83);
      `);
      const workflow = createC81Harness(confirmation);
      const discoveryRequest = c81Request();
      const discovery = workflow.preflight(discoveryRequest);
      expect(discovery.approvalFingerprint).toBeNull();
      const confirmedRequest = { ...discoveryRequest,
        confirmedOrigins: discovery.confirmationRequirements };
      const approved = workflow.preflight(confirmedRequest);
      expect(approved.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(() => workflow.requestRun({ ...confirmedRequest,
        confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
        estimate: approved.estimate, approvalFingerprint: approved.approvalFingerprint!,
        idempotencyKey: "c81-confirmation-mismatch" }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
      assertNoWrites(confirmation);
    } finally {
      confirmation.close();
    }
  });

  it("replays an exact C81 approval before reading mutable corpus state", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const workflow = createC81Harness(database);
    try {
      const request = c81Request();
      const preflight = workflow.preflight(request);
      const approval = { ...request, estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!, idempotencyKey: "c81-replay" };
      const first = workflow.requestRun(approval);
      database.connection.prepare(`
        UPDATE contents SET text = 'changed after submit', content_revision = 4 WHERE tab_id = 71
      `).run();
      expect(workflow.requestRun(approval)).toEqual(first);
      expect(() => workflow.requestRun({ ...approval, idempotencyKey: "c81-new-key" }))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(1);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("atomically owns agent start replay, provenance and conflicts before corpus drift", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const workflow = createC81Harness(database);
    try {
      const request = c81Request();
      const preflight = workflow.preflight(request);
      const approval = {
        ...request,
        estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!,
        idempotencyKey: "agent-start-replay",
        authorizationRef: "user-authorized-agent-research",
      };
      const first = workflow.requestAgentRun(approval);
      expect(database.connection.prepare(`
        SELECT requested_by, request_method, authorization_ref, idempotency_key
        FROM ai_jobs
      `).get()).toEqual({
        requested_by: "agent",
        request_method: "on_behalf_of_user",
        authorization_ref: approval.authorizationRef,
        idempotency_key: expect.stringMatching(/^agent-research:[0-9a-f]{64}$/),
      });
      const receipt = database.connection.prepare(`
        SELECT operation, request_fingerprint, authorization_ref_hash, job_id
        FROM agent_research_command_receipts
      `).get() as Record<string, unknown>;
      expect(receipt).toMatchObject({
        operation: "start",
        request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        authorization_ref_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        job_id: 1,
      });
      expect(JSON.stringify(receipt)).not.toContain(approval.idempotencyKey);
      expect(JSON.stringify(receipt)).not.toContain(approval.authorizationRef);
      expect(() => database.connection.prepare(`
        UPDATE agent_research_command_receipts SET operation = 'cancel'
      `).run()).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        DELETE FROM agent_research_command_receipts
      `).run()).toThrow(/immutable/i);

      database.connection.prepare(`
        UPDATE contents SET text = 'drifted after agent submit', content_revision = 4
        WHERE tab_id = 71
      `).run();
      const beforeReplay = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(workflow.requestAgentRun(approval)).toEqual(first);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(beforeReplay);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM agent_research_command_receipts
      `).pluck().get()).toBe(1);

      expect(() => workflow.requestAgentRun({ ...approval, question: "Changed command" }))
        .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
      expect(() => workflow.requestAgentRun({
        ...approval,
        authorizationRef: "different-user-authorization",
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
      expect(() => workflow.cancelAgent(first.id, {
        idempotencyKey: approval.idempotencyKey,
        authorizationRef: approval.authorizationRef,
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      database.close();
    }
  });

  it("looks up an exact declarative agent start receipt without reading mutable corpus", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "c82d-replay-token-0001",
      kindAvailable: () => true, research,
    });
    const workflow = createResearchWorkflow({
      current: (request) => buildCurrentResearchProjection(database.connection, request,
        { clock: () => new Date(now) }),
      submitResearch: (task, approval) => ledger.submitResearch(task, approval),
      submitAgentResearch: (task, approval, command) =>
        ledger.submitAgentResearch(task, approval, command),
      cancelResearch: (jobId) => ledger.cancel(
        "resource_research", Number(jobId.slice("resource_research:".length)),
      ),
      redactResearch: (request) => research.redactResearch(request),
    });
    try {
      const preflightRequest = c81Request();
      const preflight = workflow.preflight(preflightRequest);
      const command = {
        ...preflightRequest,
        estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!,
        idempotencyKey: "agent-start-declarative-replay",
        authorizationRef: "user-authorized-declarative-replay",
      };
      const first = workflow.requestAgentRun(command);
      const { parentReportId: _parentReportId, captureIntent: _captureIntent,
        estimate: _estimate, approvalFingerprint: _approvalFingerprint,
        ...declarative } = command;
      database.connection.prepare(`
        UPDATE contents SET text = 'drifted before declarative replay', content_revision = 4
        WHERE tab_id = 71
      `).run();
      const beforeReplay = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(ledger.replayAgentResearchStart(declarative)).toEqual(first);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(beforeReplay);
      expect(() => ledger.replayAgentResearchStart({
        ...declarative, question: "Changed declarative command",
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
      expect(() => ledger.replayAgentResearchStart({
        ...declarative, authorizationRef: "different-authorization",
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      database.close();
    }
  });

  it("atomically owns agent cancel replay and rolls back a failed first receipt", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const workflow = createC81Harness(database);
    try {
      const request = c81Request();
      const preflight = workflow.preflight(request);
      const approval = {
        ...request,
        estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!,
        idempotencyKey: "agent-start-for-cancel",
        authorizationRef: "cancel-authorization",
      };
      const job = workflow.requestAgentRun(approval);
      const cancel = {
        idempotencyKey: "agent-cancel-replay",
        authorizationRef: "cancel-authorization",
      };
      const beforeFailedCancel = database.connection.prepare(`
        SELECT status, cancellation_requested_by, cancellation_requested_at, event_sequence
        FROM ai_jobs WHERE id = 1
      `).get();
      const beforeFailedEvents = database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      database.connection.exec(`
        CREATE TRIGGER test_fail_agent_cancel_receipt
        BEFORE INSERT ON agent_research_command_receipts
        WHEN NEW.operation = 'cancel'
        BEGIN SELECT RAISE(ABORT, 'fixture cancel receipt failure'); END;
      `);
      expect(() => workflow.cancelAgent(job.id, cancel)).toThrow(/fixture cancel receipt failure/);
      expect(database.connection.prepare(`
        SELECT status, cancellation_requested_by, cancellation_requested_at, event_sequence
        FROM ai_jobs WHERE id = 1
      `).get()).toEqual(beforeFailedCancel);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(beforeFailedEvents);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM agent_research_command_receipts WHERE operation = 'cancel'
      `).pluck().get()).toBe(0);
      database.connection.exec(`DROP TRIGGER test_fail_agent_cancel_receipt`);
      expect(workflow.cancelAgent(job.id, cancel)).toMatchObject({
        status: "cancelled",
        cancellationRequest: { requestedBy: "agent" },
      });
      const afterFirst = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(workflow.cancelAgent(job.id, cancel)).toMatchObject({ status: "cancelled" });
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(afterFirst);
      expect(database.connection.prepare(`
        SELECT operation, COUNT(*) AS count FROM agent_research_command_receipts
        GROUP BY operation ORDER BY operation
      `).all()).toEqual([
        { operation: "cancel", count: 1 },
        { operation: "start", count: 1 },
      ]);
      expect(database.connection.prepare(`
        SELECT event_type, cancellation_requested_by FROM ai_job_events
        WHERE event_type IN ('cancelled', 'cancel_requested')
      `).all()).toEqual([{ event_type: "cancelled", cancellation_requested_by: "agent" }]);
      expect(() => workflow.cancelAgent(job.id, {
        ...cancel,
        authorizationRef: "changed-cancel-authorization",
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      database.close();
    }

    const failed = openDatabase(":memory:");
    seedCapturedPage(failed.connection);
    const failedWorkflow = createC81Harness(failed);
    try {
      const request = c81Request();
      const preflight = failedWorkflow.preflight(request);
      failed.connection.exec(`
        CREATE TRIGGER test_fail_agent_research_receipt
        BEFORE INSERT ON agent_research_command_receipts
        BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END;
      `);
      expect(() => failedWorkflow.requestAgentRun({
        ...request,
        estimate: preflight.estimate,
        approvalFingerprint: preflight.approvalFingerprint!,
        idempotencyKey: "agent-start-must-rollback",
        authorizationRef: "rollback-authorization",
      })).toThrow(/fixture receipt failure/);
      expect(failed.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(0);
      expect(failed.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get()).toBe(0);
      expect(failed.connection.prepare(`
        SELECT COUNT(*) FROM agent_research_command_receipts
      `).pluck().get()).toBe(0);
    } finally {
      failed.close();
    }
  });
  it("atomically stores an exact valid 2048-code-unit multibyte browser title", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const title = "界".repeat(2048);
    database.connection.prepare(`UPDATE tabs SET title = ? WHERE id = 71`).run(title);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "multibyte-title-token",
      kindAvailable: () => true, research,
    });
    try {
      const base = approvalRequest();
      const initial = buildCurrentResearchDraft(database.connection, base,
        { clock: () => new Date(now) });
      const approvalFingerprint = fingerprintResearchApproval(initial);
      const request = { ...base, approvalFingerprint };
      expect(ledger.submitResearch({ ...task(), inputFingerprint: approvalFingerprint,
        idempotencyKey: "multibyte-title-submit" }, request)).toMatchObject({ status: "queued" });
      expect(database.connection.prepare(`
        SELECT title_snapshot FROM research_source_payloads
      `).pluck().get()).toBe(title);
      expect(database.connection.prepare(`
        SELECT length(CAST(title_snapshot AS BLOB)) FROM research_source_payloads
      `).pluck().get()).toBe(6144);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(1);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("replays an exact approval without rebuilding after captured content changes", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "exact-replay-token",
      kindAvailable: () => true, research,
    });
    try {
      const request = approvalRequest();
      const submitted = ledger.submitResearch(task(), request);
      database.connection.prepare(`
        UPDATE contents SET text = 'changed after approval', content_revision = 4 WHERE tab_id = 71
      `).run();
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(ledger.submitResearch(task(), request)).toEqual(submitted);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get())
        .toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects a stale approval before any SQL write", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "stale-approval-token",
      kindAvailable: () => true, research,
    });
    try {
      const request = approvalRequest();
      database.connection.prepare(`
        UPDATE contents SET text = 'changed before submit', content_revision = 4 WHERE tab_id = 71
      `).run();
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(() => ledger.submitResearch(task(), request)).toThrowError(
        expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }),
      );
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("enforces fixed schema-24 research claim limits despite malicious caller limits", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "fixed-limit-token",
      kindAvailable: () => true, research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      expect(ledger.claimNext("resource_research", "fixed-limit-worker", {
        maxConcurrent: 999, maxAttemptsPerUtcDay: 999, maxCostUsdPerUtcDay: null,
      })).toBeDefined();
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE started_at >= ?
      `).pluck().get("2026-08-13T00:00:00.000Z")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("allows refinement only from a non-redacted report with the same target", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "parent-target-token",
      kindAvailable: () => true, research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const claim = ledger.claimNext("resource_research", "parent-worker", limits)!;
      const checkpointDigests = preparePublicationCheckpoints(
        ledger, claim, database.connection,
      );
      bindPublicationAttempt(ledger, claim, "test");
      const sourceId = database.connection.prepare(`SELECT id FROM research_sources`).pluck()
        .get() as number;
      ledger.completeResearch(claim, checkpoint(checkpointDigests), {
        version: 1, status: "succeeded", reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: task().inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: publicationProvenance("test"),
        dossier: dossier("parent"),
        claims: [{
          claim: "The captured page contains evidence.", confidence: 1,
          isInference: false, rationale: null,
          evidence: [{
            kind: "tab_content", sourceId,
            locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 17 },
            excerptHash: digest("captured evidence"),
          }],
        }],
      });
      const sameTargetApproval = fingerprintResearchApproval({
        ...approvedDraft(), parentReportId: 1,
      });
      const sameRequest = {
        ...approvalRequest(), parentReportId: 1, approvalFingerprint: sameTargetApproval,
      };
      const sameTask = {
        ...task(), inputFingerprint: sameTargetApproval, idempotencyKey: "same-parent-target",
      };
      const sameRef = ledger.submitResearch(sameTask, sameRequest);
      expect(sameRef).toMatchObject({ status: "queued" });
      ledger.cancel("resource_research", Number(sameRef.id.split(":")[1]));

      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      const differentRequest = {
        ...sameRequest, target: { type: "selection" as const,
          logicalPageIds: [41], fingerprint: digest(researchSelectionFingerprintPayload([41])) },
      };
      const differentApproval = fingerprintResearchApproval({
        ...approvedDraft(), target: differentRequest.target, parentReportId: 1,
      });
      const differentTask = {
        ...task(), subject: { type: "selection" as const, fingerprint: differentRequest.target.fingerprint },
        inputFingerprint: differentApproval, idempotencyKey: "different-parent-target",
      };
      expect(() => ledger.submitResearch(differentTask, {
        ...differentRequest, approvalFingerprint: differentApproval,
      })).toThrowError(expect.objectContaining({ code: "RESEARCH_PARENT_UNAVAILABLE" }));
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });
  it("owns submit, publication, lifecycle and privacy in closed transactions", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now),
      token: () => "research-lease-token-0001",
      kindAvailable: () => true,
      research,
    });
    try {
      const submitted = ledger.submitResearch(task(), approvalRequest());
      expect(submitted).toMatchObject({ kind: "resource_research", status: "queued" });
      expect(database.connection.prepare(`
        SELECT job_id, target_key FROM research_runs
      `).get()).toEqual({ job_id: 1, target_key: "page:41" });
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("queued");
      expect(ledger.submitResearch(task(), approvalRequest())).toEqual(submitted);
      expect(() => ledger.submit(task())).toThrowError(expect.objectContaining({
        code: "INVALID_JOB_TRANSITION",
      }));

      const claim = ledger.claimNext("resource_research", "research-worker", limits)!;
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("running");
      const sourceId = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1
      `).pluck().get() as number;
      expect(() => ledger.complete(claim, checkpoint(), {
        status: "succeeded",
        result: { type: "resource_research", reportId: 777 },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      expect(() => database.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status,
          attempt_id, lease_token, result_type, result_report_id, occurred_at
        ) VALUES (?, 3, 'succeeded', 'running', 'succeeded', ?, ?,
          'research_report', 777, ?)
      `).run(1, claim.attemptId, claim.leaseToken, now))
        .toThrow(/owned publication/i);
      const checkpointDigests = preparePublicationCheckpoints(
        ledger, claim, database.connection,
      );
      bindPublicationAttempt(ledger, claim, "test-model");
      const publication = {
        version: 1 as const,
        status: "succeeded" as const,
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: task().inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: publicationProvenance("test-model"),
        dossier: dossier("Useful report"),
        claims: [{
          claim: "The captured page contains evidence.",
          confidence: 0.9,
          isInference: false,
          rationale: null,
          evidence: [{
            kind: "tab_content" as const,
            sourceId,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 17 },
            excerptHash: digest("captured evidence"),
          }],
        }],
      };
      database.connection.exec(`
        CREATE TRIGGER force_research_terminal_rollback
        BEFORE INSERT ON ai_job_events
        WHEN NEW.event_type = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'forced terminal rollback'); END;
      `);
      expect(() => ledger.completeResearch(claim, checkpoint(checkpointDigests), publication))
        .toThrow(/forced terminal rollback/i);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`)
        .pluck().get()).toBe(0);
      expect(ledger.get("resource_research", 1)?.status).toBe("running");
      database.connection.exec(`DROP TRIGGER force_research_terminal_rollback`);

      expect(ledger.completeResearch(
        claim, checkpoint(checkpointDigests), publication,
      )).toMatchObject({
        status: "succeeded",
        result: { type: "resource_research", reportId: 1 },
      });
      const reportPayload = database.connection.prepare(`
        SELECT report_text, structured_json, payload_digest
        FROM research_report_payloads WHERE report_id = 1
      `).get() as { report_text: string; structured_json: string; payload_digest: string };
      const expectedText = renderResearchReportText(publication.dossier, publication.claims);
      expect(reportPayload).toEqual({
        report_text: expectedText,
        structured_json: canonicalJson(publication.dossier),
        payload_digest: digest(canonicalJson({ text: expectedText, dossier: publication.dossier })),
      });
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("succeeded");
      expect(database.connection.prepare(`
        SELECT latest_published_report_id, current_fresh_report_id,
          last_successful_report_id FROM research_target_heads WHERE target_key = 'page:41'
      `).get()).toEqual({
        latest_published_report_id: 1,
        current_fresh_report_id: 1,
        last_successful_report_id: 1,
      });
      expect(() => database.connection.prepare(`
        UPDATE research_reports SET version = 2 WHERE id = 1
      `).run()).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        UPDATE research_runs SET question_digest = '${"d".repeat(64)}' WHERE id = 1
      `).run()).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        DELETE FROM research_report_state_events WHERE report_id = 1
      `).run()).toThrow(/append-only/i);
      expect(() => database.connection.prepare(`
        INSERT INTO research_claims (
          report_id, ordinal, claim_digest, confidence, is_inference,
          rationale_digest
        ) VALUES (1, 2, '${"a".repeat(64)}', 0.5, 1, '${"b".repeat(64)}')
      `).run()).toThrow(/published research report is immutable/i);
      expect(() => database.connection.prepare(`
        UPDATE research_target_heads SET current_fresh_report_id = NULL
        WHERE target_key = 'page:41'
      `).run()).toThrow(/trigger-owned/i);
      expect(() => database.connection.prepare(`
        DELETE FROM research_source_payloads WHERE source_id = ?
      `).run(sourceId)).toThrow(/redaction event/i);

      const evidenceId = database.connection.prepare(`
        SELECT id FROM research_claim_evidence WHERE source_id = ?
      `).pluck().get(sourceId) as number;
      database.connection.prepare(`
        INSERT INTO research_evidence_state_events (
          evidence_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (?, 2, 'invalidated', 'invalid', 'source changed', 'invalidate-evidence-1', ?)
      `).run(evidenceId, now);
      database.connection.prepare(`
        INSERT INTO research_source_state_events (
          source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (?, 2, 'invalidated', 'invalid', 'source changed', 'invalidate-source-1', ?)
      `).run(sourceId, now);

      expect(research.redactResearch({
        target: { type: "source", sourceId },
        reason: "User forgot captured evidence",
        idempotencyKey: "forget-source-1",
      })).toEqual({ sources: 1, snapshots: 0, evidence: 1, reports: 1,
        runs: 1, cancelledJobs: 0 });
      expect(research.redactResearch({
        target: { type: "source", sourceId },
        reason: "User forgot captured evidence",
        idempotencyKey: "forget-source-1",
      })).toEqual({ sources: 1, snapshots: 0, evidence: 1, reports: 1,
        runs: 1, cancelledJobs: 0 });
      expect(database.connection.prepare(`
        SELECT captured_tab_id_snapshot, tab_id FROM research_sources WHERE id = ?
      `).get(sourceId)).toEqual({ captured_tab_id_snapshot: 71, tab_id: null });
      expect(database.connection.prepare(`
        SELECT state FROM research_evidence_heads
      `).pluck().get()).toBe("redacted");
      expect(database.connection.prepare(`
        SELECT current_fresh_report_id, last_successful_report_id
        FROM research_target_heads WHERE target_key = 'page:41'
      `).get()).toEqual({ current_fresh_report_id: null, last_successful_report_id: 1 });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_report_payloads WHERE report_id = 1
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_run_payloads WHERE run_id = 1
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_claim_payloads AS payload
        JOIN research_claims AS claim ON claim.id = payload.claim_id WHERE claim.report_id = 1
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_evidence_payloads AS payload
        JOIN research_claim_evidence AS evidence ON evidence.id = payload.evidence_id
        WHERE evidence.report_id = 1
      `).pluck().get()).toBe(0);
      expect(() => database.connection.prepare(`
        INSERT INTO research_evidence_payloads (evidence_id, locator_json) VALUES (?, '{}')
      `).run(evidenceId)).toThrow(/cannot be restored/i);
      expect(() => database.connection.prepare(`
        INSERT INTO research_report_payloads (
          report_id, report_text, structured_json, payload_digest
        ) VALUES (1, 'restored', '{}', ?)
      `).run("b".repeat(64))).toThrow(/cannot be restored/i);
      expect(() => database.connection.prepare(`
        INSERT INTO research_source_payloads (
          source_id, url_snapshot, title_snapshot, evidence_material,
          chunk_manifest_json, payload_digest
        ) VALUES (?, 'https://r.test/restored', '', 'restored', '{}', ?)
      `).run(sourceId, "c".repeat(64)))
        .toThrow(/cannot be restored|invalid research source payload/i);
      database.connection.prepare(`DELETE FROM tabs WHERE id = 71`).run();
      expect(database.connection.prepare(`SELECT COUNT(*) FROM tabs WHERE id = 71`)
        .pluck().get()).toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("atomically rejects publication when an uncited approved source changes after final read", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now), token: () => "research-corpus-fence-token",
      kindAvailable: () => true, research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const claim = ledger.claimNext("resource_research", "corpus-fence-worker", limits)!;
      const corpus = createResearchCorpusReader(database.connection).readForJob(
        `resource_research:${claim.id}`,
      );
      const checkpointDigests = preparePublicationCheckpoints(
        ledger, claim, database.connection,
      );
      expect(checkpointDigests).toMatchObject({
        corpusDigest: corpus.corpusDigest,
        parentDigest: corpus.parent?.digest ?? null,
      });
      bindPublicationAttempt(ledger, claim, "test-model");

      database.connection.prepare(`
        UPDATE contents
        SET text = 'changed after final corpus read', content_revision = 4
        WHERE tab_id = 71
      `).run();
      expect(database.connection.prepare(`
        SELECT state FROM research_source_heads WHERE source_id = 1
      `).pluck().get()).toBe("invalid");

      const terminalCheckpoint = checkpoint(checkpointDigests);
      expect(() => ledger.completeResearch(claim, terminalCheckpoint, {
        version: 1 as const,
        status: "succeeded",
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: task().inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 0,
          missing: 0, failed: 0 },
        usedSourceIds: [],
        provenance: publicationProvenance("test-model"),
        dossier: dossier("No claims were supported by the captured material."),
        claims: [],
      })).toThrowError(expect.objectContaining({ code: "JOB_INPUT_UNAVAILABLE" }));

      expect(ledger.get("resource_research", claim.id)).toMatchObject({ status: "running" });
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("running");
    } finally {
      database.close();
    }
  });

  it("atomically permits only the material-free stale guard after final corpus invalidation", () => {
    let clock = new Date(now);
    let token = 0;
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => clock });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => clock,
      token: () => `research-stale-fence-${String(++token).padStart(4, "0")}`,
      kindAvailable: () => true,
      research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      for (let attempt = 1; attempt < 3; attempt += 1) {
        const claim = ledger.claimNext(
          "resource_research", `stale-fence-worker-${attempt}`, limits,
        )!;
        const retryAt = new Date(clock.getTime() + 1_000);
        expect(ledger.fail(claim, claimedCheckpoint(), {
          code: "JOB_INPUT_UNAVAILABLE",
          retryAt: retryAt.toISOString(),
        }).status).toBe("queued");
        clock = retryAt;
      }
      const claim = ledger.claimNext(
        "resource_research", "stale-fence-worker-3", limits,
      )!;
      const reader = createResearchCorpusReader(database.connection);
      database.connection.prepare(`
        UPDATE contents
        SET text = 'invalidated before stale guard', content_revision = 4
        WHERE tab_id = 71
      `).run();
      expect(() => reader.readForJob(`resource_research:${claim.id}`)).toThrowError(
        expect.objectContaining({ code: "RESEARCH_CORPUS_MISMATCH" }),
      );
      const audit = reader.readAuditForJob(`resource_research:${claim.id}`);
      const staleDigests = {
        ...researchCheckpointDigests,
        corpusDigest: audit.digest,
        parentDigest: null,
      };
      ledger.checkpoint(claim, providerReadyCheckpoint(staleDigests));
      ledger.bindAttemptProvider(claim, {
        provider: "tabhub",
        model: "research-stale-guard",
        promptVersion: "v1",
        pricingVersion: "tabhub-no-charge-v1",
      });
      const staleUsage = {
        steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
      };
      const terminal = checkpoint(staleDigests);
      const staleDraft = {
        version: 1 as const,
        status: "partial" as const,
        reason: "corpus_became_stale" as const,
        corpusFingerprint: audit.corpusFingerprint,
        inputFingerprint: task().inputFingerprint,
        coverage: audit.coverage,
        usedSourceIds: [],
        provenance: {
          provider: "tabhub",
          model: "research-stale-guard",
          promptVersion: "v1",
          pricingVersion: "tabhub-no-charge-v1",
          requestId: null,
          generatedAt: clock.toISOString(),
          usage: staleUsage,
        },
        dossier: RESEARCH_STALE_GUARD_DOSSIER,
        claims: [],
      };
      expect(() => ledger.completeResearch(claim, {
        ...terminal,
        usage: staleUsage,
      }, {
        ...staleDraft,
        dossier: dossier("Forged stale-guard conclusion"),
      })).toThrowError(expect.objectContaining({ code: "JOB_INPUT_UNAVAILABLE" }));
      const completed = ledger.completeResearch(claim, {
        ...terminal,
        usage: staleUsage,
      }, staleDraft);

      expect(completed).toMatchObject({
        status: "partial",
        result: { type: "resource_research", reportId: 1 },
      });
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("stale");
      expect(database.connection.prepare(`
        SELECT current_fresh_report_id, last_successful_report_id
        FROM research_target_heads WHERE target_key = 'page:41'
      `).get()).toEqual({ current_fresh_report_id: null, last_successful_report_id: null });
    } finally {
      database.close();
    }
  });

  it("rejects provenance diverging from terminal attempt and checkpoint", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now),
      token: () => "research-provenance-token-0001",
      kindAvailable: () => true,
      research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const claim = ledger.claimNext("resource_research", "provenance-worker", limits)!;
      const checkpointDigests = preparePublicationCheckpoints(
        ledger, claim, database.connection,
      );
      const sourceId = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1
      `).pluck().get() as number;
      const validPublication = {
        version: 1 as const,
        status: "succeeded" as const,
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: task().inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: publicationProvenance("provenance-model", "request-exact"),
        dossier: dossier("Provenance-bound report"),
        claims: [{
          claim: "The captured page contains evidence.", confidence: 1,
          isInference: false, rationale: null,
          evidence: [{
            kind: "tab_content" as const,
            sourceId,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 17 },
            excerptHash: digest("captured evidence"),
          }],
        }],
      };
      const durableState = () => ({
        job: database.connection.prepare(`
          SELECT status, event_sequence, spent_steps, spent_tokens,
            spent_cost_usd, spent_wall_time_ms
          FROM ai_jobs WHERE id = ?
        `).get(claim.id),
        attempt: database.connection.prepare(`
          SELECT outcome, pricing_version, input_tokens, output_tokens, cost_usd
          FROM ai_job_attempts WHERE id = ?
        `).get(claim.attemptId),
        progressEvents: database.connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = ? AND event_type = 'progress'
        `).pluck().get(claim.id),
        reports: database.connection.prepare(`SELECT COUNT(*) FROM research_reports`)
          .pluck().get(),
      });
      const unbound = durableState();
      expect(() => ledger.completeResearch(
        claim, checkpoint(checkpointDigests), validPublication,
      )).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(durableState()).toEqual(unbound);
      expect(() => ledger.bindAttemptProvider(claim, {
        provider: "test", model: "provenance-model", promptVersion: "v1",
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      bindPublicationAttempt(ledger, claim, "provenance-model", "request-exact");
      bindPublicationAttempt(ledger, claim, "provenance-model", "request-exact");
      expect(() => ledger.bindAttemptProvider(claim, {
        provider: "test", model: "provenance-model", promptVersion: "v1",
        pricingVersion: "other-pricing-v1",
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      const before = durableState();
      const provenance = validPublication.provenance;
      const inconsistentPublications = [
        { label: "provider", value: { ...provenance, provider: "other-provider" } },
        { label: "model", value: { ...provenance, model: "other-model" } },
        { label: "promptVersion", value: { ...provenance, promptVersion: "other-v1" } },
        { label: "pricingVersion", value: {
          ...provenance, pricingVersion: "other-pricing-v1",
        } },
        { label: "requestId", value: { ...provenance, requestId: "request-other" } },
        { label: "canonical generatedAt mismatch", value: {
          ...provenance, generatedAt: "2026-08-13T14:00:01.000Z",
        } },
        { label: "non-canonical generatedAt", value: {
          ...provenance, generatedAt: "2026-08-13T14:00:00Z",
        } },
        { label: "usage.steps", value: {
          ...provenance, usage: { ...provenance.usage, steps: 2 },
        } },
        { label: "usage.inputTokens", value: {
          ...provenance, usage: { ...provenance.usage, inputTokens: 21 },
        } },
        { label: "usage.outputTokens", value: {
          ...provenance, usage: { ...provenance.usage, outputTokens: 11 },
        } },
        { label: "usage.costUsd", value: {
          ...provenance, usage: { ...provenance.usage, costUsd: 0.02 },
        } },
        { label: "usage.wallTimeMs", value: {
          ...provenance, usage: { ...provenance.usage, wallTimeMs: 101 },
        } },
      ];
      for (const inconsistent of inconsistentPublications) {
        expect(
          () => ledger.completeResearch(claim, checkpoint(checkpointDigests), {
            ...validPublication,
            provenance: inconsistent.value,
          }),
          inconsistent.label,
        ).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
        expect(durableState(), inconsistent.label).toEqual(before);
      }

      expect(ledger.completeResearch(
        claim, checkpoint(checkpointDigests), validPublication,
      )).toMatchObject({
        status: "succeeded",
        result: { type: "resource_research", reportId: 1 },
      });
      expect(database.connection.prepare(`
        SELECT provenance_json FROM research_reports WHERE id = 1
      `).pluck().get()).toBe(canonicalJson(validPublication.provenance));
    } finally {
      database.close();
    }
  });

  it("persists only the closed monotonic research checkpoint union across retry", () => {
    let clock = new Date(now);
    let token = 0;
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => clock });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => clock,
      token: () => `research-checkpoint-${String(++token).padStart(4, "0")}`,
      kindAvailable: () => true,
      research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const first = ledger.claimNext("resource_research", "checkpoint-worker-1", limits)!;
      expect(first.checkpoint).toBeNull();
      expect(() => ledger.checkpoint(first, providerReadyCheckpoint())).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(() => ledger.checkpoint(first, {
        ...claimedCheckpoint(),
        checkpoint: { ...claimedCheckpoint().checkpoint, unknown: "x" },
      } as unknown as AiJobCheckpointInput)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(() => ledger.checkpoint(first, {
        ...claimedCheckpoint(),
        checkpoint: { ...claimedCheckpoint().checkpoint, padding: "x".repeat(2_100) },
      } as unknown as AiJobCheckpointInput)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(ledger.checkpoint(first, claimedCheckpoint()).status).toBe("running");
      expect(ledger.refresh(first).checkpoint).toEqual(claimedCheckpoint().checkpoint);
      expect(() => ledger.checkpoint(first, {
        ...providerReadyCheckpoint(),
        progress: { completed: 0, total: 1, stage: "claimed" },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.checkpoint(first, {
        ...providerReadyCheckpoint(),
        checkpoint: {
          ...providerReadyCheckpoint().checkpoint,
          corpusDigest: "not-a-digest",
        },
      } as unknown as AiJobCheckpointInput)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(ledger.checkpoint(first, providerReadyCheckpoint()).status).toBe("running");
      expect(ledger.refresh(first).checkpoint).toEqual(providerReadyCheckpoint().checkpoint);

      clock = new Date("2026-08-13T14:00:01.000Z");
      expect(ledger.fail(first, providerReadyCheckpoint(), {
        code: "JOB_INPUT_UNAVAILABLE", retryAt: clock.toISOString(),
      }).status).toBe("queued");
      const second = ledger.claimNext(
        "resource_research", "checkpoint-worker-2", limits,
      )!;
      expect(ledger.refresh(second).checkpoint).toEqual(providerReadyCheckpoint().checkpoint);
      expect(() => ledger.checkpoint(second, claimedCheckpoint())).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(() => ledger.checkpoint(second, {
        ...providerReadyCheckpoint(),
        checkpoint: {
          ...providerReadyCheckpoint().checkpoint,
          quoteDigest: "5".repeat(64),
        },
      } as unknown as AiJobCheckpointInput)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(ledger.checkpoint(second, {
        ...checkpoint(),
        usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      }).status).toBe("running");
      expect(ledger.refresh(second).checkpoint).toEqual(checkpoint().checkpoint);
      expect(database.connection.prepare(`
        SELECT length(CAST(checkpoint_json AS BLOB)) FROM ai_jobs WHERE id = ?
      `).pluck().get(second.id)).toBeLessThanOrEqual(2_048);
    } finally {
      database.close();
    }
  });

  it("treats a zero research cost budget as exhausted on fail and recovery", () => {
    const zeroCostBudget = { ...researchBudget, maxCostUsd: 0 };

    const failedDatabase = openDatabase(":memory:");
    seedCapturedPage(failedDatabase.connection);
    const failedResearch = createResearchStore(failedDatabase.connection, {
      clock: () => new Date(now),
    });
    const failedLedger = createAiJobLedger(failedDatabase.connection, {
      clock: () => new Date(now),
      token: () => "research-zero-fail-token",
      kindAvailable: () => true,
      research: failedResearch,
    });
    try {
      failedLedger.submitResearch(task(zeroCostBudget), approvalRequest(zeroCostBudget));
      const claim = failedLedger.claimNext(
        "resource_research", "zero-cost-fail-worker", limits,
      )!;
      expect(failedLedger.fail(claim, claimedCheckpoint(), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-13T14:00:01.000Z",
      })).toMatchObject({ status: "failed", error: { code: "JOB_INPUT_UNAVAILABLE" } });
    } finally {
      failedDatabase.close();
    }

    let recoveryClock = new Date(now);
    const recoveredDatabase = openDatabase(":memory:");
    seedCapturedPage(recoveredDatabase.connection);
    const recoveredResearch = createResearchStore(recoveredDatabase.connection, {
      clock: () => recoveryClock,
    });
    const recoveredLedger = createAiJobLedger(recoveredDatabase.connection, {
      clock: () => recoveryClock,
      token: () => "research-zero-recovery-token",
      kindAvailable: () => true,
      research: recoveredResearch,
    });
    try {
      recoveredLedger.submitResearch(task(zeroCostBudget), approvalRequest(zeroCostBudget));
      const claim = recoveredLedger.claimNext(
        "resource_research", "zero-cost-recovery-worker", limits,
      )!;
      recoveryClock = new Date("2026-08-13T14:01:01.000Z");
      expect(recoveredLedger.recoverInterrupted()).toBe(1);
      expect(recoveredLedger.get("resource_research", claim.id)).toMatchObject({
        status: "failed",
        error: { code: "JOB_BUDGET_EXHAUSTED" },
      });
    } finally {
      recoveredDatabase.close();
    }
  });

  it("redacts reports whose cited source changes or is forgotten", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now),
      token: () => "research-no-claim-token-0001",
      kindAvailable: () => true,
      research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const claim = ledger.claimNext("resource_research", "no-claim-worker", limits)!;
      const checkpointDigests = preparePublicationCheckpoints(
        ledger, claim, database.connection,
      );
      bindPublicationAttempt(ledger, claim, "test-model");
      const sourceId = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1
      `).pluck().get() as number;
      ledger.completeResearch(claim, checkpoint(checkpointDigests), {
        version: 1,
        status: "succeeded",
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: task().inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: publicationProvenance("test-model"),
        dossier: dossier("Evidence-backed report"),
        claims: [{
          claim: "The captured page contains evidence.", confidence: 1,
          isInference: false, rationale: null,
          evidence: [{
            kind: "tab_content", sourceId,
            locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 17 },
            excerptHash: digest("captured evidence"),
          }],
        }],
      });
      expect(database.connection.prepare(`
        SELECT current_fresh_report_id FROM research_target_heads WHERE target_key = 'page:41'
      `).pluck().get()).toBe(1);
      database.connection.prepare(`
        UPDATE contents SET text = 'post-publication change', content_revision = 4 WHERE tab_id = 71
      `).run();
      expect(database.connection.prepare(`
        SELECT state FROM research_source_heads WHERE source_id = ?
      `).pluck().get(sourceId)).toBe("invalid");
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("stale");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_report_payloads WHERE report_id = 1
      `).pluck().get()).toBe(1);

      expect(research.redactResearch({
        target: { type: "source", sourceId },
        reason: "User forgot a used source",
        idempotencyKey: "forget-no-claim-source",
      })).toEqual({ sources: 1, snapshots: 0, evidence: 1, reports: 1,
        runs: 1, cancelledJobs: 0 });
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("redacted");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_report_payloads WHERE report_id = 1
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT current_fresh_report_id FROM research_target_heads WHERE target_key = 'page:41'
      `).pluck().get()).toBeNull();
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back invalid approved corpora before leaving a job or receipt", () => {
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(now) });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(now),
      token: () => "research-lease-token-0002",
      kindAvailable: () => true,
      research,
    });
    try {
      const unconfirmed = {
        ...approvalRequest(),
        scope: {
          ...approvalRequest().scope,
          privacyConfirmation: {
            ...approvalRequest().scope.privacyConfirmation,
            confirmed: false,
          },
        },
      } as unknown as ReturnType<typeof approvalRequest>;
      expect(() => ledger.submitResearch(task(), unconfirmed)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_idempotency_receipts
      `).pluck().get()).toBe(0);

      const invalid = { ...approvalRequest(), approvalFingerprint: "f".repeat(64) };
      expect(() => ledger.submitResearch(task(), invalid)).toThrowError(
        expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }),
      );
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_idempotency_receipts
      `).pluck().get()).toBe(0);

      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          42, 'https://research.openai.com/missing', 'https://research.openai.com/missing',
          'https://research.openai.com/missing', '${now}', '${now}'
        )
      `);
      const noncanonicalFingerprint = digest(researchSelectionFingerprintPayload([41]));
      const selectionTask = {
        ...task(),
        subject: { type: "selection" as const, fingerprint: noncanonicalFingerprint },
        idempotencyKey: "invalid-selection-fingerprint",
      };
      const pageDraft = approvalRequest();
      const selectionDraft = {
        ...pageDraft,
        target: {
          type: "selection" as const,
          logicalPageIds: [42, 41],
          fingerprint: noncanonicalFingerprint,
        },
        captureIntent: { selectedTabIds: [71], knownFailures: [] },
      };
      expect(() => ledger.submitResearch(selectionTask, selectionDraft))
        .toThrowError(expect.objectContaining({ code: "RESEARCH_SELECTION_INVALID" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get())
        .toBe(0);
    } finally {
      database.close();
    }
  });

  it("projects retry and cancellation into append-only run lifecycle", () => {
    let clock = new Date(now);
    let token = 0;
    const database = openDatabase(":memory:");
    seedCapturedPage(database.connection);
    const research = createResearchStore(database.connection, { clock: () => clock });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => clock,
      token: () => `research-lifecycle-${String(++token).padStart(4, "0")}`,
      kindAvailable: () => true,
      research,
    });
    try {
      ledger.submitResearch(task(), approvalRequest());
      const firstClaim = ledger.claimNext("resource_research", "lifecycle-worker", limits)!;
      clock = new Date("2026-08-13T14:00:01.000Z");
      expect(ledger.fail(firstClaim, claimedCheckpoint(), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: clock.toISOString(),
      }).status).toBe("queued");
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("queued");
      const secondClaim = ledger.claimNext(
        "resource_research", "lifecycle-worker-2", limits,
      )!;
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("running");
      ledger.cancel("resource_research", secondClaim.id, "user");
      expect(ledger.checkpoint(secondClaim, claimedCheckpoint()).status).toBe("cancelled");
      expect(database.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = 1
      `).pluck().get()).toBe("cancelled");
      expect(database.connection.prepare(`
        SELECT status FROM research_run_events WHERE run_id = 1 ORDER BY sequence_no
      `).pluck().all()).toEqual(["queued", "running", "queued", "running", "cancelled"]);
    } finally {
      database.close();
    }
  });
});
