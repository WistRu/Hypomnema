import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import {
  buildPrivacyPurgeDerivedSourceGuards,
  buildPrivacyPurgeExpectedViews,
  buildPrivacyPurgeMutationFences,
  buildPrivacyPurgeRootGuards,
} from "../src/privacy-purge-fence-spec.js";
import {
  adoptLegacy25PrivacyPurgeTerminals,
  createPrivacyPurgeIntentStore,
  installPrivacyPurgeIntentCapabilities,
} from "../src/privacy-purge-intent-capabilities.js";
import {
  buildCurrentResearchProjection,
  createResearchStore,
} from "../src/research-store.js";
import { projectResearchPreflight } from "../src/research-workflow.js";
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const PUBLISHED_AT = "2026-08-21T12:00:00.000Z";
const OVERDUE_AT = "2026-08-21T12:31:00.000Z";
const FINAL_AT = "2026-08-21T12:32:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installSchema26(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeIntentCapabilities(connection);
  connection.exec(readFileSync(
    new URL("../migrations/026_privacy_purge_intents.sql", import.meta.url),
    "utf8",
  ));
  for (const sql of buildPrivacyPurgeExpectedViews(connection)) connection.exec(sql);
  for (const fence of buildPrivacyPurgeMutationFences(connection)) connection.exec(fence.sql);
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) connection.exec(sql);
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

function addRequestBoundPageResearchJob(
  connection: ReturnType<typeof openDatabase>["connection"],
  draft: ReturnType<typeof seedReceiptBackedLiveResearchRun>["draft"],
): void {
  connection.prepare(`
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
      logical_page_id
    ) VALUES (7999, @url, @url, 'Final zero page source', 'chrome',
      @at, @at, 7001)
  `).run({ url: "https://www.cloudflare.com/live-research-source", at: PUBLISHED_AT });
  connection.prepare(`
    INSERT INTO contents (tab_id, text, content_revision, extracted_at)
    VALUES (7999, 'Final zero captured page evidence', 1, @at)
  `).run({ at: PUBLISHED_AT });
  const raw = {
    version: draft.version,
    target: { type: "page" as const, logicalPageId: 7001 },
    question: draft.question,
    scope: draft.scope,
    parentReportId: draft.parentReportId,
    approvalFingerprint: "0".repeat(64),
    workflowRef: draft.workflowRef,
    budget: draft.budget,
    estimate: draft.estimate,
    captureIntent: { selectedTabIds: [7999], knownFailures: [] },
  };
  const projected = projectResearchPreflight({
    version: 1,
    target: raw.target,
    question: raw.question,
    includeShareableContext: raw.scope.includeShareableContext,
    maxIncludedSources: raw.scope.maxIncludedSources,
    parentReportId: raw.parentReportId,
    budget: raw.budget,
    captureIntent: raw.captureIntent,
    confirmedOrigins: {
      authenticatedOriginDigests:
        raw.scope.privacyConfirmation.authenticatedOriginDigests,
      sensitiveOriginDigests:
        raw.scope.privacyConfirmation.sensitiveOriginDigests,
    },
  }, buildCurrentResearchProjection(connection, raw, {
    clock: () => new Date(PUBLISHED_AT),
  }));
  if (projected.approvalFingerprint === null) throw new Error("missing page approval");
  const pageDraft = {
    ...raw,
    approvalFingerprint: projected.approvalFingerprint,
    estimate: projected.estimate,
  };
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "purge-zero-page-research-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(PUBLISHED_AT) }),
  });
  const submitted = ledger.submitResearch({
    version: 1,
    kind: "resource_research",
    subject: { type: "page", logicalPageId: 7001 },
    workflowRef: pageDraft.workflowRef,
    inputFingerprint: pageDraft.approvalFingerprint,
    idempotencyKey: "purge-zero-page-research",
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget: pageDraft.budget,
  }, {
    version: pageDraft.version,
    target: pageDraft.target,
    question: pageDraft.question,
    scope: pageDraft.scope,
    parentReportId: pageDraft.parentReportId,
    approvalFingerprint: pageDraft.approvalFingerprint,
    workflowRef: pageDraft.workflowRef,
    budget: pageDraft.budget,
    estimate: pageDraft.estimate,
    captureIntent: pageDraft.captureIntent,
  });
  const jobId = Number(submitted.id.split(":")[1]);
  const workerId = "purge-zero-page-research-worker";
  const leaseToken = "purge-zero-page-research-token";
  const attemptId = Number(connection.prepare(`
    INSERT INTO ai_job_attempts (
      job_id, attempt_no, lease_token, worker_id, provider, model,
      prompt_version, pricing_version, provider_bound_at, request_id,
      request_bound_at, started_at, outcome
    ) VALUES (?, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'running')
  `).run(jobId, leaseToken, workerId, PUBLISHED_AT).lastInsertRowid);
  const leaseExpiresAt = String(connection.prepare(`
    SELECT lease_expires_at FROM ai_jobs WHERE id = ?
  `).pluck().get(jobId));
  const claim = {
    id: jobId,
    kind: "resource_research" as const,
    attemptId,
    attemptNo: 1,
    workerId,
    leaseToken,
    leaseExpiresAt,
  } as Parameters<typeof ledger.bindAttemptProvider>[0];
  ledger.bindAttemptProvider(claim, {
    provider: "openai", model: "gpt-5", promptVersion: "research-v1",
    pricingVersion: "pricing-v1",
  });
  ledger.recordAttemptRequest(claim, "provider-request-final-zero-page");
}

function fixture(options: {
  twoRequestBoundWaits?: boolean;
  baselineCostUsd?: number;
} = {}) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "purge-zero-lease-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(PUBLISHED_AT) }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    "purge-zero-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    undefined,
    [{ id: "research_workflow:c81:v1", version: 1 }],
  )!;
  ledger.bindAttemptProvider(claim, {
    provider: "openai",
    model: "gpt-5",
    promptVersion: "research-v1",
    pricingVersion: "pricing-v1",
  });
  ledger.recordAttemptRequest(claim, "provider-request-final-zero-1");
  if (options.baselineCostUsd !== undefined) {
    ledger.checkpoint(claim, {
      progress: { completed: 0, total: 1, stage: "claimed" },
      checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
      usage: {
        steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
      },
    });
    ledger.checkpoint(claim, {
      progress: { completed: 0, total: 1, stage: "provider_ready" },
      checkpoint: {
        version: 1,
        nextStep: 1,
        stage: "provider_ready",
        corpusDigest: live.draft.corpusFingerprint,
        parentDigest: null,
        providerInputDigest: "2".repeat(64),
        quoteDigest: "3".repeat(64),
      },
      usage: {
        steps: 1,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: options.baselineCostUsd,
        wallTimeMs: 1,
      },
    });
  }
  if (options.twoRequestBoundWaits === true) {
    const priorityLedger = createAiJobLedger(connection, {
      clock: () => new Date(PUBLISHED_AT),
      token: () => "purge-zero-priority-token",
      kindAvailable: (kind) => kind === "priority_assessment",
    });
    const submitted = priorityLedger.submit({
      version: 1,
      kind: "priority_assessment",
      subject: { type: "page", logicalPageId: 7001 },
      ruleset: { rulesetId: 1, version: 1 },
      assessmentProvenance: {
        method: "model",
        model: { provider: "openai", name: "gpt-5", promptVersion: "priority-v1" },
      },
      inputFingerprint: "e".repeat(64),
      idempotencyKey: "purge-zero-priority",
      stepBatchSize: 1,
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget: {
        maxSteps: 10,
        maxTokens: 100,
        maxCostUsd: 1,
        maxWallTimeMs: 60_000,
      },
    });
    const priorityClaim = priorityLedger.claimNext(
      "priority_assessment",
      "purge-zero-priority-worker",
      { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    )!;
    expect(priorityClaim.id).toBe(Number(submitted.id.split(":")[1]));
    priorityLedger.bindAttemptProvider(priorityClaim, {
      provider: "openai",
      model: "gpt-5",
      promptVersion: "priority-v1",
      pricingVersion: "pricing-v1",
    });
    priorityLedger.recordAttemptRequest(priorityClaim, "provider-request-final-zero-2");
    addRequestBoundPageResearchJob(connection, live.draft);
  }
  installSchema26(connection);
  const runGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const pageGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = 7001 AND is_active = 1
  `).pluck().get());
  const historyEpochId = Number(connection.prepare(`
    SELECT id FROM research_history_epochs
    WHERE resource_id = 7001 AND is_active = 1
  `).pluck().get());
  const intentKey = sha256("purge-final-zero-intent");
  return {
    database,
    claim,
    intentKey,
    publication: {
      intentKey,
      idempotencyKeyHash: sha256("purge-final-zero-idempotency"),
      requestFingerprint: sha256("purge-final-zero-request"),
      target: options.twoRequestBoundWaits === true
        ? { kind: "logical_page" as const, subjectGenerationId: pageGenerationId }
        : { kind: "run" as const, subjectGenerationId: runGenerationId },
    },
  };
}

describe("schema026 irreversible FINAL provider settlement", () => {
  it("repairs a held wait with privacy-safe evidence and freezes it without a fake job terminal", async () => {
    const { database, claim, intentKey, publication } = fixture();
    try {
      const verifier = vi.fn(async (request: { requestId: string }) =>
        request.requestId.endsWith("-2")
          ? {
              status: "final_positive" as const,
              verifierVersion: "provider_final_usage:v1" as const,
              providerFinalAt: FINAL_AT,
              finalCostUsd: 0.2,
            }
          : {
              status: "final_zero" as const,
              verifierVersion: "provider_final_zero:v1" as const,
              providerFinalAt: FINAL_AT,
            });
      const clockValues = [
        PUBLISHED_AT, OVERDUE_AT, FINAL_AT, FINAL_AT, FINAL_AT, FINAL_AT,
      ];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(clockValues.shift()!),
        finalSettlementVerifier: { verifyFinalProviderUsage: verifier },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      const wait = database.connection.prepare(`
        SELECT ordinal, row_digest FROM privacy_purge_intent_job_waits
        WHERE intent_key = ?
      `).get(intentKey) as { ordinal: number; row_digest: string };
      expect(() => database.connection.prepare(`
        INSERT INTO privacy_purge_intent_final_settlements (
          intent_key, job_wait_ordinal, proof_generation, wait_row_digest,
          evidence_kind, verifier_version, final_cost_nanos,
          provider_final_at, recorded_at,
          evidence_digest
        ) VALUES (?, ?, 1, ?,
          'provider_request_final_additional_usage_zero:v1',
          'provider_final_zero:v1', 0, ?, ?, ?)
      `).run(
        intentKey, wait.ordinal, wait.row_digest, FINAL_AT, FINAL_AT, sha256("forged"),
      )).toThrow(/invalid privacy purge final settlement evidence/);
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({
          status: "waiting",
          transitioned: true,
          recordedEvidence: 1,
          settlementProofGeneration: 1,
        });
      expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
        requestId: "provider-request-final-zero-1",
      }));
      const columns = database.connection.pragma(
        "table_info(privacy_purge_intent_final_settlements)",
      ) as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        "job_id", "attempt_id", "request_id", "request_id_digest", "provider", "model",
      ]));
      expect(database.connection.prepare(`
        SELECT proof_generation, evidence_kind, verifier_version
        FROM privacy_purge_intent_final_settlements WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        proof_generation: 1,
        evidence_kind: "provider_request_final_additional_usage_zero:v1",
        verifier_version: "provider_final_zero:v1",
      });
      expect(database.connection.prepare(`
        SELECT status FROM ai_jobs WHERE id = ?
      `).pluck().get(claim.id)).toBe("running");
      expect(() => database.connection.prepare(`
        UPDATE ai_jobs SET updated_at = updated_at WHERE id = ?
      `).run(claim.id)).toThrow(/mutation fence|final zero settlement source is immutable/);
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({ transitioned: false, recordedEvidence: 0 });
      expect(store.freezeReady(intentKey)).toMatchObject({ status: "ready" });
      expect(database.connection.prepare(`
        SELECT provider_attempts, charged_cost_nanos, active_exposure_nanos
        FROM privacy_purge_budget_carryover_days WHERE budget_class = 'provider'
      `).get()).toEqual({
        provider_attempts: 1,
        charged_cost_nanos: 0,
        active_exposure_nanos: 0,
      });
      expect(() => database.connection.prepare(`
        UPDATE privacy_purge_intent_final_settlements
        SET recorded_at = recorded_at WHERE intent_key = ?
      `).run(intentKey)).toThrow(/immutable/);
      expect(() => database.connection.prepare(`
        DELETE FROM privacy_purge_intent_final_settlements WHERE intent_key = ?
      `).run(intentKey)).toThrow(/permanent/);
      const commandId = store.linkReadyCommand({
        idempotencyKeyHash: publication.idempotencyKeyHash,
        requestFingerprint: publication.requestFingerprint,
        targetKind: "run",
        subjectGenerationId: (publication.target as {
          subjectGenerationId: number;
        }).subjectGenerationId,
        historyEpochId: null,
      });
      store.executeCommitted(commandId);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs WHERE id = ?`)
        .pluck().get(claim.id)).toBe(0);
      expect(database.connection.prepare(`
        SELECT state FROM privacy_purge_budget_carryover_days
        WHERE budget_class = 'provider'
      `).pluck().get()).toBe("active");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
        WHERE intent_key = ?
      `).pluck().get(intentKey)).toBe(1);
      expect(database.connection.prepare(`
        SELECT receipt.outcome, intent.terminal_evidence_digest,
          receipt.result_digest
        FROM privacy_purge_intent_receipts AS receipt
        JOIN privacy_purge_intents AS intent ON intent.intent_key = receipt.intent_key
        WHERE receipt.intent_key = ?
      `).get(intentKey)).toEqual({
        outcome: "completed",
        terminal_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        result_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      database.close();
    }
  });

  it("carries an authoritative FINAL POSITIVE total without double counting", async () => {
    const { database, claim, intentKey, publication } = fixture({
      baselineCostUsd: 0.05,
    });
    try {
      const values = [
        PUBLISHED_AT, OVERDUE_AT, FINAL_AT, FINAL_AT, FINAL_AT, FINAL_AT,
      ];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => ({
            status: "final_positive",
            verifierVersion: "provider_final_usage:v1",
            providerFinalAt: FINAL_AT,
            finalCostUsd: 2.0000000001,
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({ status: "waiting", transitioned: true });
      expect(database.connection.prepare(`
        SELECT evidence_kind, verifier_version, final_cost_nanos
        FROM privacy_purge_intent_final_settlements WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        evidence_kind: "provider_request_final_usage_positive:v1",
        verifier_version: "provider_final_usage:v1",
        final_cost_nanos: 2000000001,
      });
      store.freezeReady(intentKey);
      expect(database.connection.prepare(`
        SELECT provider_attempts, charged_cost_nanos, active_exposure_nanos
        FROM privacy_purge_budget_carryover_days WHERE budget_class = 'provider'
      `).get()).toEqual({
        provider_attempts: 1,
        charged_cost_nanos: 2000000001,
        active_exposure_nanos: 0,
      });
      const commandId = store.linkReadyCommand({
        idempotencyKeyHash: publication.idempotencyKeyHash,
        requestFingerprint: publication.requestFingerprint,
        targetKind: "run",
        subjectGenerationId: (publication.target as {
          subjectGenerationId: number;
        }).subjectGenerationId,
        historyEpochId: null,
      });
      store.executeCommitted(commandId);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs WHERE id = ?`)
        .pluck().get(claim.id)).toBe(0);
      expect(database.connection.prepare(`
        SELECT charged_cost_nanos, state
        FROM privacy_purge_budget_carryover_days WHERE budget_class = 'provider'
      `).get()).toEqual({ charged_cost_nanos: 2000000001, state: "active" });
      const capAt = `${String(database.connection.prepare(`
        SELECT utc_date FROM privacy_purge_budget_carryover_days
        WHERE budget_class = 'provider'
      `).pluck().get())}T12:00:00.000Z`;
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9301, 'final-positive-cap.example', '${capAt}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9302, 'resource_research', 'resource', NULL, 9301, NULL, NULL,
          'resource:9301', 'user', 'manual', 'final-positive-cap-claim',
          '${"b".repeat(64)}', '${"c".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.1, 240000,
          '${capAt}', '${capAt}', '${capAt}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9303, 9302, 9301, 'resource:9301', '${"d".repeat(64)}', '{}',
          '${"c".repeat(64)}', '${"e".repeat(64)}', '${"b".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.1, 240000,
          '${capAt}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9301 AND is_active = 1
          )
        );
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9303, 1, 'queued', 'queued', NULL,
          'final-positive-cap-run-queued', '${capAt}'
        );
      `);
      const capLedger = createAiJobLedger(database.connection, {
        clock: () => new Date(capAt),
        token: () => "final-positive-cap-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(database.connection, {
          clock: () => new Date(capAt),
        }),
      });
      const capClaim = capLedger.claimNext(
        "resource_research",
        "final-positive-cap-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 0.1,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      );
      expect(capClaim).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it.each(["unknown"] as const)(
    "keeps %s provider settlement held without writing evidence",
    async (status) => {
      const { database, intentKey, publication } = fixture();
      try {
        const values = [PUBLISHED_AT, OVERDUE_AT];
        const store = createPrivacyPurgeIntentStore(database.connection, {
          clock: () => new Date(values.shift()!),
          finalSettlementVerifier: {
            verifyFinalProviderUsage: async () => ({ status }),
          },
        });
        store.publishWaiting(publication);
        store.reconcileWaiting(intentKey, { maxJobs: 1 });
        await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
          .resolves.toMatchObject({
            status: "failed_hold",
            transitioned: false,
            recordedEvidence: 0,
          });
        expect(database.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
        `).pluck().get()).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it("rejects a non-final/stale ZERO attestation before any durable mutation", async () => {
    const { database, intentKey, publication } = fixture();
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => ({
            status: "final_zero",
            verifierVersion: "provider_final_zero:v1",
            providerFinalAt: PUBLISHED_AT,
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .rejects.toThrow(/stale/);
      expect(database.connection.prepare(`
        SELECT status, settlement_proof_generation FROM privacy_purge_intents
        WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "failed_hold",
        settlement_proof_generation: 0,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["zero", {
      status: "final_zero", verifierVersion: "provider_final_zero:v1",
      providerFinalAt: FINAL_AT, extra: true,
    }],
    ["positive", {
      status: "final_positive", verifierVersion: "provider_final_usage:v1",
      providerFinalAt: FINAL_AT, finalCostUsd: 0.1, extra: true,
    }],
  ] as const)("rejects a non-exact %s result before the repair transaction", async (_kind, result) => {
    const { database, intentKey, publication } = fixture();
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => result as never,
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .rejects.toThrow(/verifier result/);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([
    ["bare positive", { status: "positive" }],
    ["zero positive cost", {
      status: "final_positive", verifierVersion: "provider_final_usage:v1",
      providerFinalAt: FINAL_AT, finalCostUsd: 0,
    }],
    ["negative positive cost", {
      status: "final_positive", verifierVersion: "provider_final_usage:v1",
      providerFinalAt: FINAL_AT, finalCostUsd: -0.01,
    }],
    ["non-finite positive cost", {
      status: "final_positive", verifierVersion: "provider_final_usage:v1",
      providerFinalAt: FINAL_AT, finalCostUsd: Number.NaN,
    }],
    ["stale positive", {
      status: "final_positive", verifierVersion: "provider_final_usage:v1",
      providerFinalAt: PUBLISHED_AT, finalCostUsd: 0.1,
    }],
  ] as const)("rejects %s evidence without durable mutation", async (_label, result) => {
    const { database, intentKey, publication } = fixture();
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => result as never,
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .rejects.toThrow();
      expect(database.connection.prepare(`
        SELECT status, settlement_proof_generation FROM privacy_purge_intents
        WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "failed_hold", settlement_proof_generation: 0,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rolls evidence and repair state back together after an injected failure", async () => {
    const { database, intentKey, publication } = fixture();
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => ({
            status: "final_positive",
            verifierVersion: "provider_final_usage:v1",
            providerFinalAt: FINAL_AT,
            finalCostUsd: 0.1,
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      database.connection.exec(`
        CREATE TEMP TRIGGER fail_zero_evidence_after_insert
        AFTER INSERT ON privacy_purge_intent_final_settlements
        BEGIN
          SELECT RAISE(ABORT, 'fixture zero repair failure');
        END;
      `);
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .rejects.toThrow("fixture zero repair failure");
      expect(database.connection.prepare(`
        SELECT status, repair_count, settlement_proof_generation
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "failed_hold",
        repair_count: 0,
        settlement_proof_generation: 0,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("accumulates a bounded two-wait generation and repairs only after complete coverage", async () => {
    const { database, intentKey, publication } = fixture({ twoRequestBoundWaits: true });
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT, FINAL_AT];
      const verifier = vi.fn(async (request: { requestId: string }) =>
        request.requestId.endsWith("-2")
          ? {
              status: "final_positive" as const,
              verifierVersion: "provider_final_usage:v1" as const,
              providerFinalAt: FINAL_AT,
              finalCostUsd: 0.2,
            }
          : {
              status: "final_zero" as const,
              verifierVersion: "provider_final_zero:v1" as const,
              providerFinalAt: FINAL_AT,
            });
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: { verifyFinalProviderUsage: verifier },
      });
      expect(store.publishWaiting(publication).jobWaitCount).toBe(2);
      store.reconcileWaiting(intentKey, { maxJobs: 2 });
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({
          status: "failed_hold",
          transitioned: false,
          recordedEvidence: 1,
          settlementProofGeneration: 0,
        });
      expect(database.connection.prepare(`
        SELECT status, settlement_proof_generation FROM privacy_purge_intents
        WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "failed_hold",
        settlement_proof_generation: 0,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
      `).pluck().get()).toBe(1);
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({
          status: "waiting",
          transitioned: true,
          recordedEvidence: 1,
          settlementProofGeneration: 1,
        });
      expect(database.connection.prepare(`
        SELECT job_wait_ordinal, evidence_kind
        FROM privacy_purge_intent_final_settlements
        ORDER BY job_wait_ordinal
      `).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          evidence_kind: "provider_request_final_additional_usage_zero:v1",
        }),
        expect.objectContaining({
          evidence_kind: "provider_request_final_usage_positive:v1",
        }),
      ]));
      await expect(store.repairFinalSettlements(intentKey, { maxJobs: 1 }))
        .resolves.toMatchObject({ transitioned: false, recordedEvidence: 0 });
      expect(verifier).toHaveBeenCalledTimes(2);
      expect(values).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("snapshots a changing repair maxJobs getter exactly once", async () => {
    const { database, intentKey, publication } = fixture();
    try {
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: async () => ({
            status: "final_zero",
            verifierVersion: "provider_final_zero:v1",
            providerFinalAt: FINAL_AT,
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 1 });
      let reads = 0;
      const input = {
        get maxJobs() {
          reads += 1;
          return reads === 1 ? 1 : 100;
        },
      };
      await expect(store.repairFinalSettlements(intentKey, input))
        .resolves.toMatchObject({ recordedEvidence: 1, transitioned: true });
      expect(reads).toBe(1);
    } finally {
      database.close();
    }
  });

  it("adopts identical evidence from two interleaved verifier completions", async () => {
    const { database, intentKey, publication } = fixture({ twoRequestBoundWaits: true });
    try {
      type FinalResult = {
        status: "final_zero";
        verifierVersion: "provider_final_zero:v1";
        providerFinalAt: string;
      };
      const pending: Array<(value: FinalResult) => void> = [];
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: () => new Promise<FinalResult>((resolve) => {
            pending.push(resolve);
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 2 });
      const first = store.repairFinalSettlements(intentKey, { maxJobs: 1 });
      const second = store.repairFinalSettlements(intentKey, { maxJobs: 1 });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      const result = {
        status: "final_zero" as const,
        verifierVersion: "provider_final_zero:v1" as const,
        providerFinalAt: FINAL_AT,
      };
      pending[0]!(result);
      await expect(first).resolves.toMatchObject({
        recordedEvidence: 1,
        status: "failed_hold",
        transitioned: false,
      });
      pending[1]!(result);
      await expect(second).resolves.toMatchObject({
        recordedEvidence: 0,
        status: "failed_hold",
        transitioned: false,
      });
      expect(Number(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
        WHERE intent_key = ? AND proof_generation = 1
      `).pluck().get(intentKey))).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fails closed on conflicting interleaved verifier evidence", async () => {
    const { database, intentKey, publication } = fixture({ twoRequestBoundWaits: true });
    try {
      type FinalResult = {
        status: "final_zero";
        verifierVersion: "provider_final_zero:v1";
        providerFinalAt: string;
      } | {
        status: "final_positive";
        verifierVersion: "provider_final_usage:v1";
        providerFinalAt: string;
        finalCostUsd: number;
      };
      const pending: Array<(value: FinalResult) => void> = [];
      const values = [PUBLISHED_AT, OVERDUE_AT, FINAL_AT, FINAL_AT];
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(values.shift()!),
        finalSettlementVerifier: {
          verifyFinalProviderUsage: () => new Promise<FinalResult>((resolve) => {
            pending.push(resolve);
          }),
        },
      });
      store.publishWaiting(publication);
      store.reconcileWaiting(intentKey, { maxJobs: 2 });
      const first = store.repairFinalSettlements(intentKey, { maxJobs: 1 });
      const conflicting = store.repairFinalSettlements(intentKey, { maxJobs: 1 });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[0]!({
        status: "final_zero",
        verifierVersion: "provider_final_zero:v1",
        providerFinalAt: FINAL_AT,
      });
      await expect(first).resolves.toMatchObject({ recordedEvidence: 1 });
      pending[1]!({
        status: "final_positive",
        verifierVersion: "provider_final_usage:v1",
        providerFinalAt: FINAL_AT,
        finalCostUsd: 0.1,
      });
      await expect(conflicting).rejects.toThrow(/conflicts with replay/);
      expect(Number(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_final_settlements
        WHERE intent_key = ? AND proof_generation = 1
      `).pluck().get(intentKey))).toBe(1);
    } finally {
      database.close();
    }
  });
});
