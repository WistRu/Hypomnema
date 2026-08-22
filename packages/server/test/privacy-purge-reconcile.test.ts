import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installSchema26(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
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

function sequenceClock(values: readonly string[]) {
  let index = 0;
  return {
    clock: () => new Date(values[index++]!),
    calls: () => index,
  };
}

function fixture(beforeInstall?: (
  connection: ReturnType<typeof openDatabase>["connection"],
  live: ReturnType<typeof seedReceiptBackedLiveResearchRun>,
) => void) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "purge-reconcile-lease-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, {
      clock: () => new Date(PUBLISHED_AT),
    }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    "purge-reconcile-worker",
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
  ledger.recordAttemptRequest(claim, "provider-request-reconcile-1");

  beforeInstall?.(connection, live);
  installSchema26(connection);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const intentKey = sha256("purge-reconcile-intent");
  const publication = {
    intentKey,
    idempotencyKeyHash: sha256("purge-reconcile-idempotency"),
    requestFingerprint: sha256("purge-reconcile-request"),
    target: { kind: "run" as const, subjectGenerationId },
  };
  return { database, live, claim, intentKey, publication };
}

function addEarlierRunningUnboundPageJob(
  connection: ReturnType<typeof openDatabase>["connection"],
): number {
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "purge-reconcile-earlier-unbound-token",
    kindAvailable: (kind) => kind === "priority_assessment",
  });
  const submitted = ledger.submit({
    version: 1,
    kind: "priority_assessment",
    subject: { type: "page", logicalPageId: 7001 },
    ruleset: { rulesetId: 1, version: 1 },
    assessmentProvenance: { method: "rule" },
    inputFingerprint: "e".repeat(64),
    idempotencyKey: "purge-reconcile-earlier-unbound",
    stepBatchSize: 1,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget: {
      maxSteps: 10,
      maxTokens: 0,
      maxCostUsd: 0,
      maxWallTimeMs: 60_000,
    },
  });
  const jobId = Number(submitted.id.split(":")[1]);
  expect(ledger.claimNext(
    "priority_assessment",
    "purge-reconcile-earlier-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
  )?.id).toBe(jobId);
  return jobId;
}

function addLaterRequestBoundPageResearchJob(
  connection: ReturnType<typeof openDatabase>["connection"],
  draft: ReturnType<typeof seedReceiptBackedLiveResearchRun>["draft"],
): number {
  connection.prepare(`
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
      logical_page_id
    ) VALUES (7999, @url, @url, 'Purge reconcile page source', 'chrome',
      @at, @at, 7001)
  `).run({ url: "https://www.cloudflare.com/live-research-source", at: PUBLISHED_AT });
  connection.prepare(`
    INSERT INTO contents (tab_id, text, content_revision, extracted_at)
    VALUES (7999, 'Purge reconcile captured page evidence', 1, @at)
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
  if (projected.approvalFingerprint === null) {
    throw new Error("Expected page research approval fingerprint");
  }
  const pageDraft = {
    ...raw,
    approvalFingerprint: projected.approvalFingerprint,
    estimate: projected.estimate,
  };
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "purge-reconcile-later-bound-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, {
      clock: () => new Date(PUBLISHED_AT),
    }),
  });
  const submitted = ledger.submitResearch({
    version: 1,
    kind: "resource_research",
    subject: { type: "page", logicalPageId: 7001 },
    workflowRef: pageDraft.workflowRef,
    inputFingerprint: pageDraft.approvalFingerprint,
    idempotencyKey: "purge-reconcile-later-bound-page-research",
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
  const workerId = "purge-reconcile-later-bound-worker";
  const leaseToken = "purge-reconcile-later-bound-token";
  const attemptId = Number(connection.prepare(`
    INSERT INTO ai_job_attempts (
      job_id, attempt_no, lease_token, worker_id, provider, model,
      prompt_version, pricing_version, provider_bound_at, request_id,
      request_bound_at, started_at, outcome
    ) VALUES (?, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'running')
  `).run(jobId, leaseToken, workerId, PUBLISHED_AT).lastInsertRowid);
  const claimedProjection = connection.prepare(`
    SELECT status, lease_expires_at FROM ai_jobs WHERE id = ?
  `).get(jobId) as { status: string; lease_expires_at: string | null };
  expect(claimedProjection.status).toBe("running");
  const leaseExpiresAt = claimedProjection.lease_expires_at!;
  const claim = {
    id: jobId,
    kind: "resource_research" as const,
    attemptId,
    attemptNo: 1,
    workerId,
    leaseToken,
    leaseExpiresAt,
  } as Parameters<typeof ledger.bindAttemptProvider>[0];
  expect(claim.id).toBe(jobId);
  ledger.bindAttemptProvider(claim, {
    provider: "openai",
    model: "gpt-5",
    promptVersion: "research-v1",
    pricingVersion: "pricing-v1",
  });
  ledger.recordAttemptRequest(claim, "provider-request-reconcile-page");
  return jobId;
}

describe("schema026 bounded privacy-purge reconcile", () => {
  it("atomically holds one overdue request-bound unknown-usage wait without side effects", () => {
    const { database, live, claim, intentKey, publication } = fixture();
    try {
      const sampled = sequenceClock([PUBLISHED_AT, OVERDUE_AT]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      expect(store.publishWaiting(publication).jobWaitCount).toBe(1);
      const waitBefore = database.connection.prepare(`
        SELECT * FROM privacy_purge_intent_job_waits WHERE intent_key = ?
      `).get(intentKey);
      expect(() => database.connection.prepare(`
        UPDATE privacy_purge_intents
        SET status = 'failed_hold', hold_code = 'PROVIDER_USAGE_UNKNOWN',
          updated_at = ?
        WHERE intent_key = ?
      `).run(OVERDUE_AT, intentKey)).toThrow("invalid privacy purge intent transition");

      expect(store.reconcileWaiting(intentKey, { maxJobs: 1 })).toEqual({
        intentKey,
        status: "failed_hold",
        holdCode: "PROVIDER_USAGE_UNKNOWN",
        inspectedJobs: 1,
        transitioned: true,
      });
      expect(sampled.calls()).toBe(2);
      expect(database.connection.prepare(`
        SELECT status, hold_code, updated_at, repair_count,
          settlement_proof_generation, settlement_evidence_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "failed_hold",
        hold_code: "PROVIDER_USAGE_UNKNOWN",
        updated_at: OVERDUE_AT,
        repair_count: 0,
        settlement_proof_generation: 0,
        settlement_evidence_digest: null,
      });
      expect(database.connection.prepare(`
        SELECT * FROM privacy_purge_intent_job_waits WHERE intent_key = ?
      `).get(intentKey)).toEqual(waitBefore);
      expect(database.connection.prepare(`
        SELECT status, cancellation_requested_by FROM ai_jobs WHERE id = ?
      `).get(claim.id)).toEqual({ status: "running", cancellation_requested_by: "user" });
      expect(database.connection.prepare(`
        SELECT outcome, request_id FROM ai_job_attempts WHERE id = ?
      `).get(claim.attemptId)).toEqual({
        outcome: "running",
        request_id: "provider-request-reconcile-1",
      });
      expect(database.connection.prepare(`
        SELECT status, consumed_usd FROM live_acquisition_provider_reservations
        WHERE final_job_id = ?
      `).get(claim.id)).toEqual({ status: "active", consumed_usd: 0 });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_sources WHERE id = ?
      `).pluck().get(live.sourceId)).toBe(1);
      for (const table of [
        "privacy_purge_budget_carryover_days",
        "privacy_purge_commands",
        "privacy_purge_results",
        "privacy_purge_intent_receipts",
        "privacy_purge_intent_execution_targets",
      ]) {
        expect(database.connection.prepare(`SELECT COUNT(*) FROM ${table}`)
          .pluck().get()).toBe(0);
      }

      expect(store.reconcileWaiting(intentKey, { maxJobs: 1 })).toEqual({
        intentKey,
        status: "failed_hold",
        holdCode: "PROVIDER_USAGE_UNKNOWN",
        inspectedJobs: 0,
        transitioned: false,
      });
      expect(sampled.calls()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("inspects at most the requested bound and leaves a pre-deadline wait waiting", () => {
    const { database, intentKey, publication } = fixture();
    try {
      const sampled = sequenceClock([
        PUBLISHED_AT,
        "2026-08-21T12:30:59.999Z",
      ]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      store.publishWaiting(publication);
      expect(store.reconcileWaiting(intentKey, { maxJobs: 1 })).toEqual({
        intentKey,
        status: "waiting",
        holdCode: null,
        inspectedJobs: 0,
        transitioned: false,
      });
      expect(sampled.calls()).toBe(2);
      expect(database.connection.prepare(`
        SELECT status, hold_code, updated_at FROM privacy_purge_intents
        WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "waiting",
        hold_code: null,
        updated_at: PUBLISHED_AT,
      });
    } finally {
      database.close();
    }
  });

  it("applies the bound after filtering so an earlier non-actionable wait cannot hide an overdue wait", () => {
    let earlierJobId = 0;
    let laterJobId = 0;
    const { database, intentKey } = fixture((connection, live) => {
      earlierJobId = addEarlierRunningUnboundPageJob(connection);
      laterJobId = addLaterRequestBoundPageResearchJob(connection, live.draft);
    });
    try {
      const logicalPageGenerationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 7001
          AND is_active = 1
      `).pluck().get());
      const sampled = sequenceClock([PUBLISHED_AT, OVERDUE_AT]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      const publication = {
        intentKey,
        idempotencyKeyHash: sha256("purge-reconcile-idempotency"),
        requestFingerprint: sha256("purge-reconcile-request"),
        target: {
          kind: "logical_page" as const,
          subjectGenerationId: logicalPageGenerationId,
        },
      };

      expect(store.publishWaiting(publication).jobWaitCount).toBe(2);
      expect(database.connection.prepare(`
        SELECT job_id, request_bound FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? ORDER BY ordinal
      `).all(intentKey)).toEqual([
        { job_id: earlierJobId, request_bound: 0 },
        { job_id: laterJobId, request_bound: 1 },
      ]);
      expect(store.reconcileWaiting(intentKey, { maxJobs: 1 })).toEqual({
        intentKey,
        status: "failed_hold",
        holdCode: "PROVIDER_USAGE_UNKNOWN",
        inspectedJobs: 1,
        transitioned: true,
      });
      expect(sampled.calls()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("validates the job bound before sampling the trusted clock", () => {
    const { database, intentKey } = fixture();
    try {
      const sampled = sequenceClock([OVERDUE_AT]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      for (const maxJobs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 101]) {
        expect(() => store.reconcileWaiting(intentKey, { maxJobs }))
          .toThrow(/maxJobs/);
      }
      expect(sampled.calls()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rolls back the exact transition and can retry after an injected failure", () => {
    const { database, intentKey, publication } = fixture();
    try {
      const sampled = sequenceClock([PUBLISHED_AT, OVERDUE_AT, OVERDUE_AT]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      store.publishWaiting(publication);
      database.connection.exec(`
        CREATE TEMP TRIGGER fail_reconcile_after_transition
        AFTER UPDATE ON privacy_purge_intents
        WHEN NEW.status = 'failed_hold'
        BEGIN
          SELECT RAISE(ABORT, 'fixture reconcile failure');
        END;
      `);
      expect(() => store.reconcileWaiting(intentKey, { maxJobs: 1 }))
        .toThrow("fixture reconcile failure");
      expect(database.connection.prepare(`
        SELECT status, hold_code, updated_at FROM privacy_purge_intents
        WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "waiting",
        hold_code: null,
        updated_at: PUBLISHED_AT,
      });
      database.connection.exec("DROP TRIGGER temp.fail_reconcile_after_transition");
      expect(store.reconcileWaiting(intentKey, { maxJobs: 1 })).toMatchObject({
        status: "failed_hold",
        transitioned: true,
      });
      expect(sampled.calls()).toBe(3);
    } finally {
      database.close();
    }
  });
});
