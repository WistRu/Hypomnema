import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  estimateResearchReservationV1,
  type ResearchApprovalRequest,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import type { ResearchProviderInput, ResearchProviderQuote } from "../src/research-provider.js";
import { describe, expect, it, vi } from "vitest";

import { createAiJobLedger, type AiJobCheckpointInput } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createLiveAcquisitionWorkflow } from "../src/live-acquisition-workflow.js";
import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { createLiveAcquisitionMaterializer } from "../src/live-acquisition-materializer.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import {
  buildCurrentResearchProjection,
  createResearchStore,
} from "../src/research-store.js";
import { projectResearchPreflight } from "../src/research-workflow.js";

const at = "2026-08-15T09:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function seed(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed',
      'https://www.cloudflare.com/seed', '${at}', '${at}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed', 'Seed',
      'chrome', 'inbox', 0, 1, '${at}', '${at}', 7001);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
      VALUES (7001, 'captured seed evidence', '${at}', 1);
    INSERT INTO resources (id, resource_key, created_at)
      VALUES (7001, 'host:cloudflare.com', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (7001, 7001, 1, 'Example', 'website', 'public', 'active',
      'system', 'derived', '${at}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (7001, 7001);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES (7001, 7001, 'assigned', 7001, 'registrable_domain', 'system', 'derived',
      'seed', '${at}');
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      VALUES (7001, 7001);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      research_exclusion_reason, created_at
    ) VALUES (7001, 7001, 'matched', 'explicit_alias', 7001, 7001,
      '[]', 'seed-resolution', 1, NULL, '${at}');
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
      VALUES (7001, 7001);
    INSERT INTO resource_match_rules (
      id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (7001, 'cloudflare-test', 1, 7001, 'cloudflare.com', 'suffix_host', '/',
      100, 'system_seed', 'system', 'derived', '${at}');
    INSERT INTO resource_match_rule_heads (rule_key, rule_id)
      VALUES ('cloudflare-test', 7001);
  `);
}

const request = {
  version: 1 as const,
  research: {
    version: 1 as const,
    target: { type: "resource" as const, resourceId: 7001 },
    question: "What should be researched?",
    includeShareableContext: false,
    maxIncludedSources: 10,
    parentReportId: null,
    budget: { maxSteps: 100, maxTokens: 20_000, maxCostUsd: 1, maxWallTimeMs: 420_000 },
    captureIntent: { selectedTabIds: [7001], knownFailures: [] },
    confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
  },
  approvedOrigins: ["https://www.cloudflare.com"],
  limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
};

function createFixture(
  fault?: (point: string) => void,
  maxAttemptsPerUtcDay?: number,
  quoteResult?: (input: ResearchProviderInput) => ResearchProviderQuote,
) {
  const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
  seed(database.connection);
  const quote = vi.fn((input: ResearchProviderInput) => quoteResult?.(input) ?? ({
    version: "research_provider_quote:v1" as const,
    inputDigest: digest("provider-input"), calls: 1 as const,
    inputTokens: 2_000, outputTokens: 8_192, costUsd: 0.25, wallTimeMs: 120_000,
  }));
  const research = createResearchStore(database.connection, { clock: () => new Date(at) });
  const workflow = createLiveAcquisitionWorkflow({
    connection: database.connection,
    research,
    provider: {
      metadata: { provider: "anthropic", model: "test", promptVersion: "p1",
        pricingVersion: "price1" },
      quote,
    },
    clock: () => new Date(at),
    digestKey: () => Buffer.alloc(32, 7),
    ...(maxAttemptsPerUtcDay === undefined ? {} : { maxAttemptsPerUtcDay }),
    ...(fault === undefined ? {} : { fault }),
  });
  return { database, quote, research, workflow };
}

const parentBudget = {
  maxSteps: 10,
  maxTokens: 2_000,
  maxCostUsd: 1,
  maxWallTimeMs: 60_000,
};

function parentCheckpoint(
  stage: "claimed" | "provider_ready" | "terminal_publication",
): AiJobCheckpointInput {
  const nextStep = stage === "claimed" ? 0 : stage === "provider_ready" ? 1 : 2;
  return {
    progress: {
      completed: stage === "terminal_publication" ? 1 : 0,
      total: 1,
      stage,
    },
    checkpoint: stage === "claimed"
      ? { version: 1, nextStep, stage }
      : {
          version: 1,
          nextStep,
          stage,
          corpusDigest: "1".repeat(64),
          parentDigest: null,
          providerInputDigest: "2".repeat(64),
          quoteDigest: "3".repeat(64),
          ...(stage === "terminal_publication"
            ? { providerOutputDigest: "4".repeat(64) }
            : {}),
        },
    usage: stage === "terminal_publication"
      ? { steps: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.01, wallTimeMs: 100 }
      : { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function publishParent(
  connection: ReturnType<typeof openDatabase>["connection"],
  target: Extract<ResearchApprovalRequest["target"], { type: "resource" | "page" }> =
    request.research.target,
): number {
  const base: ResearchApprovalRequest = {
    version: 1,
    target,
    question: "Existing Resource research",
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: false,
      maxIncludedSources: 10,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "research_workflow:c81:v1", version: 1 },
    budget: parentBudget,
    estimate: estimateResearchReservationV1({
      includedSources: 0,
      includedSourceBytes: 0,
      snapshotBytes: 0,
      questionBytes: 0,
      budget: parentBudget,
    }),
    captureIntent: { selectedTabIds: [7001], knownFailures: [] },
  };
  const preflightRequest = {
    version: 1 as const,
    target,
    question: base.question,
    includeShareableContext: base.scope.includeShareableContext,
    maxIncludedSources: base.scope.maxIncludedSources,
    parentReportId: null,
    budget: parentBudget,
    captureIntent: base.captureIntent,
    confirmedOrigins: {
      authenticatedOriginDigests: [],
      sensitiveOriginDigests: [],
    },
  };
  const projected = projectResearchPreflight(
    preflightRequest,
    buildCurrentResearchProjection(connection, base, { clock: () => new Date(at) }),
  );
  if (projected.approvalFingerprint === null) {
    throw new Error("Expected parent approval fingerprint");
  }
  const approval = {
    ...base,
    approvalFingerprint: projected.approvalFingerprint,
    estimate: projected.estimate,
  };
  const task: ResourceResearchTaskSpec = {
    version: 1,
    kind: "resource_research",
    subject: target.type === "resource"
      ? { type: "resource", resourceId: target.resourceId }
      : { type: "page", logicalPageId: target.logicalPageId },
    workflowRef: approval.workflowRef,
    inputFingerprint: approval.approvalFingerprint,
    idempotencyKey: `parent-${target.type}`,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget: parentBudget,
  };
  const research = createResearchStore(connection, { clock: () => new Date(at) });
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(at),
    token: () => `parent-${target.type}-attempt-token-0001`,
    kindAvailable: () => true,
    research,
  });
  ledger.submitResearch(task, approval);
  const claim = ledger.claimNext("resource_research", `parent-${target.type}-worker`, {
    maxConcurrent: 1,
    maxAttemptsPerUtcDay: 10,
    maxCostUsdPerUtcDay: 2,
  }, undefined, [{ id: "research_workflow:c81:v1", version: 1 }])!;
  ledger.bindAttemptProvider(claim, {
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "fixture-v1",
    pricingVersion: "fixture-pricing-v1",
  });
  ledger.recordAttemptRequest(claim, `parent-${target.type}-request`);
  ledger.checkpoint(claim, parentCheckpoint("claimed"));
  ledger.checkpoint(claim, parentCheckpoint("provider_ready"));
  const run = connection.prepare(`
    SELECT corpus_fingerprint FROM research_runs WHERE job_id = ?
  `).get(claim.id) as { corpus_fingerprint: string };
  const completed = ledger.completeResearch(claim, parentCheckpoint("terminal_publication"), {
    version: 1,
    status: "succeeded",
    reason: null,
    corpusFingerprint: run.corpus_fingerprint,
    inputFingerprint: approval.approvalFingerprint,
    coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
    usedSourceIds: [],
    provenance: {
      provider: "fixture-provider",
      model: "fixture-model",
      promptVersion: "fixture-v1",
      pricingVersion: "fixture-pricing-v1",
      requestId: `parent-${target.type}-request`,
      generatedAt: at,
      usage: parentCheckpoint("terminal_publication").usage,
    },
    dossier: {
      executiveSummary: "Existing parent report",
      valueForUser: "Existing parent value",
      capabilities: [],
      limitations: [],
      risks: [],
      unknowns: [],
      nextSteps: [],
    },
    claims: [],
  });
  if (completed.result === null || completed.result.type !== "resource_research") {
    throw new Error("Expected parent research report");
  }
  return completed.result.reportId;
}

describe("live acquisition workflow", () => {
  it("commits one complete C90 submission and exact replay performs no mutable/provider read", () => {
    const { database, quote, workflow } = createFixture();
    try {
      const preflight = workflow.preflight(request);
      expect(preflight.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(preflight.researchApprovalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(preflight.dailyStartsResetAt).toBe("2026-08-16T00:00:00.000Z");
      const start = { version: 1 as const, preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "live-start-1" };
      const receipt = workflow.start(start);
      const quoteCallsAfterStart = quote.mock.calls.length;
      database.connection.prepare("UPDATE contents SET text = ? WHERE tab_id = 7001")
        .run("captured seed drift after committed receipt");
      expect(workflow.start(start)).toEqual(receipt);
      expect(quote).toHaveBeenCalledTimes(quoteCallsAfterStart);
      expect(receipt).toEqual({ id: "resource_research:1", kind: "resource_research",
        status: "queued" });

      const row = database.connection.prepare(`
        SELECT job.workflow_id, job.workflow_version, job.max_steps, job.max_tokens,
          job.max_cost_usd, job.max_wall_time_ms, run.history_epoch_id,
          history.id AS active_epoch_id, consent.runtime_epoch,
          length(key.digest_key) AS key_bytes
        FROM ai_jobs AS job JOIN research_runs AS run ON run.job_id = job.id
        JOIN research_history_epochs AS history
          ON history.resource_id = job.resource_id AND history.is_active = 1
        JOIN live_acquisition_consents AS consent ON consent.coordinator_job_id = job.id
        JOIN live_acquisition_digest_keys AS key ON key.consent_id = consent.id
      `).get() as Record<string, unknown>;
      expect(row).toMatchObject({ workflow_id: "research_acquisition:c90:v1",
        workflow_version: 1, max_steps: 100, max_tokens: 10_192,
        max_cost_usd: 1, max_wall_time_ms: 420_000, runtime_epoch: 1, key_bytes: 32 });
      expect(row.history_epoch_id).toBe(row.active_epoch_id);
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_job_attempts").pluck().get())
        .toBe(0);
      expect(database.connection.prepare("SELECT COUNT(*) FROM live_acquisition_checkpoints")
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_sources
        WHERE source_kind = 'captured' AND inclusion_state = 'included'
      `).pluck().get()).toBe(1);
      expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => workflow.start({ ...start, preflight: {
        ...request, approvedOrigins: ["https://www.example.com"],
      } })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      database.close();
    }
  });

  it("rolls every row back on an injected mid-start failure", () => {
    const { database, workflow } = createFixture((point) => {
      if (point === "after_research_submission") throw new Error("injected-start-fault");
    });
    try {
      const preflight = workflow.preflight(request);
      expect(() => workflow.start({ version: 1, preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "live-fault" })).toThrow("injected-start-fault");
      for (const table of ["ai_jobs", "research_runs", "research_sources",
        "live_acquisition_consents", "live_acquisition_consent_payloads",
        "live_acquisition_digest_keys"]) {
        expect(database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table)
          .toBe(0);
      }
    } finally {
      database.close();
    }
  });

  it("quotes one worst-case acquired source and preserves final C81 handoff capacity", () => {
    const { database, quote, workflow } = createFixture();
    try {
      workflow.preflight(request);
      const input = quote.mock.calls[0]![0];
      expect(input.sources).toHaveLength(2);
      expect(input.sources[0]).toMatchObject({
        ordinal: 1,
        trust: "untrusted_source_material",
        evidenceMaterial: "captured seed evidence",
      });
      expect(new TextEncoder().encode(input.sources[1]!.evidenceMaterial).byteLength)
        .toBe(65_536);
      expect(new TextEncoder().encode(input.sources[1]!.url).byteLength).toBe(8_192);
      expect(new TextEncoder().encode(input.sources[1]!.title).byteLength).toBe(8_192);
      expect(input.sources[1]).toMatchObject({
        ordinal: 2,
        trust: "untrusted_source_material",
      });
      expect(() => workflow.preflight({
        ...request,
        research: { ...request.research, maxIncludedSources: 1 },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
    } finally {
      database.close();
    }
  });

  it("quotes the insertion ordinal after excluded and missing rows at exact token and cost bounds", () => {
    const observedInputs: ResearchProviderInput[] = [];
    const fixture = createFixture(undefined, undefined, (input) => {
      observedInputs.push(input);
      const safeOrdinal = input.sources.at(-1)?.ordinal === 10;
      return {
        version: "research_provider_quote:v1",
        inputDigest: digest("ordinal-boundary-provider-input"),
        calls: 1,
        inputTokens: safeOrdinal ? 191_808 : 191_807,
        outputTokens: 8_192,
        costUsd: safeOrdinal ? 1 : 0.999_999,
        wallTimeMs: 120_000,
      };
    });
    try {
      for (let offset = 0; offset < 8; offset += 1) {
        const id = 7_100 + offset;
        const url = `https://www.cloudflare.com/sparse-${offset}`;
        fixture.database.connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, url, url, url, at, at);
        fixture.database.connection.prepare(`
          INSERT INTO tabs (
            id, url, url_normalized, title, browser, status, importance, is_open,
            first_seen_at, last_seen_at, logical_page_id
          ) VALUES (?, ?, ?, ?, 'chrome', 'inbox', 0, 1, ?, ?, ?)
        `).run(id, url, url, `Sparse ${offset}`, at, at, id);
        fixture.database.connection.prepare(`
          INSERT INTO logical_page_resource_assignments (
            id, logical_page_id, action, resource_id, provenance_class, assigned_by,
            assignment_method, source_fingerprint, created_at
          ) VALUES (?, ?, 'assigned', 7001, 'registrable_domain', 'system',
            'derived', ?, ?)
        `).run(id, id, `sparse-${offset}`, at);
        fixture.database.connection.prepare(`
          INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
          VALUES (?, ?)
        `).run(id, id);
        if (offset === 0) {
          fixture.database.connection.prepare(`
            INSERT INTO contents (tab_id, text, extracted_at, content_revision)
            VALUES (?, '', ?, 1)
          `).run(id, at);
        }
      }

      const preflight = fixture.workflow.preflight(request);
      expect(observedInputs[0]!.sources.at(-1)).toMatchObject({ ordinal: 10 });
      const receipt = fixture.workflow.start({
        version: 1,
        preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "live-safe-ordinal-boundary",
      });
      expect(receipt.status).toBe("queued");
      expect(observedInputs).toHaveLength(2);
      expect(observedInputs[1]!.sources.at(-1)).toMatchObject({ ordinal: 10 });
      expect(fixture.database.connection.prepare(`
        SELECT max_tokens, max_cost_usd FROM ai_jobs WHERE id = 1
      `).get()).toEqual({ max_tokens: 200_000, max_cost_usd: 1 });
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    ["version", { version: "wrong" }],
    ["inputDigest", { inputDigest: "not-a-digest" }],
    ["calls", { calls: 0 }],
    ["inputTokens", { inputTokens: -1 }],
    ["totalTokens", { inputTokens: 199_000 }],
    ["outputTokens", { outputTokens: 0 }],
    ["costUsd", { costUsd: Number.NaN }],
    ["consentCostUsd", { costUsd: 1.01 }],
    ["wallTimeMs", { wallTimeMs: 0 }],
    ["unknown field", { extra: true }],
  ] as const)("rejects a provider quote with an invalid %s field", (_label, mutation) => {
    const base = {
      version: "research_provider_quote:v1",
      inputDigest: digest("provider-input"),
      calls: 1,
      inputTokens: 2_000,
      outputTokens: 8_192,
      costUsd: 0.25,
      wallTimeMs: 120_000,
    };
    const fixture = createFixture(undefined, undefined, () => ({
      ...base,
      ...mutation,
    } as ResearchProviderQuote));
    try {
      expect(() => fixture.workflow.preflight(request)).toThrowError(
        expect.objectContaining({ code: "INVALID_JOB_INPUT" }),
      );
    } finally {
      fixture.database.close();
    }
  });

  it("quotes the actual same-Resource fresh or stale parent and rejects every other parent", () => {
    const { database, quote, workflow } = createFixture();
    try {
      const parentReportId = publishParent(database.connection);
      const stored = database.connection.prepare(`
        SELECT report.version, payload.report_text
        FROM research_reports AS report
        JOIN research_report_payloads AS payload ON payload.report_id = report.id
        WHERE report.id = ?
      `).get(parentReportId) as { version: number; report_text: string };
      const withParent = {
        ...request,
        research: { ...request.research, parentReportId },
      };
      workflow.preflight(withParent);
      expect(quote.mock.calls.at(-1)![0].parent).toEqual({
        reportId: parentReportId,
        reportVersion: stored.version,
        trust: "untrusted_prior_report",
        reportText: stored.report_text,
      });

      database.connection.prepare(`
        INSERT INTO research_report_state_events (
          report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (?, 2, 'stale', 'stale', 'source changed', 'live-parent-stale', ?)
      `).run(parentReportId, at);
      workflow.preflight(withParent);
      expect(quote.mock.calls.at(-1)![0].parent?.reportId).toBe(parentReportId);

      const pageParentId = publishParent(database.connection, {
        type: "page",
        logicalPageId: 7001,
      });
      expect(() => workflow.preflight({
        ...request,
        research: { ...request.research, parentReportId: pageParentId },
      })).toThrowError(expect.objectContaining({ code: "RESEARCH_PARENT_UNAVAILABLE" }));
      expect(() => workflow.preflight({
        ...request,
        research: { ...request.research, parentReportId: 999_999 },
      })).toThrowError(expect.objectContaining({ code: "RESEARCH_PARENT_NOT_FOUND" }));
    } finally {
      database.close();
    }
  });

  it("rejects an IP-literal origin through the closed policy before writes", () => {
    const { database, workflow } = createFixture();
    try {
      expect(() => workflow.preflight({
        ...request,
        approvedOrigins: ["https://127.0.0.1"],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      expect(database.connection.prepare("SELECT COUNT(*) FROM live_acquisition_actions")
        .pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("accepts a path-scoped origin from an included captured seed but rejects another origin", () => {
    const { database, workflow } = createFixture();
    try {
      database.connection.exec(`
        UPDATE logical_pages
        SET identity_key = 'https://www.cloudflare.com/docs/seed',
          url_normalized = 'https://www.cloudflare.com/docs/seed',
          representative_url = 'https://www.cloudflare.com/docs/seed'
        WHERE id = 7001;
        UPDATE tabs
        SET url = 'https://www.cloudflare.com/docs/seed',
          url_normalized = 'https://www.cloudflare.com/docs/seed'
        WHERE id = 7001;
        INSERT INTO resource_match_rules (
          id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
          priority, provenance_class, created_by, creation_method, supersedes_id, created_at
        ) VALUES (7002, 'cloudflare-test', 2, 7001, 'cloudflare.com', 'suffix_host',
          '/docs/', 100, 'user_alias', 'user', 'manual', 7001, '${at}');
        UPDATE resource_match_rule_heads SET rule_id = 7002
        WHERE rule_key = 'cloudflare-test';
      `);

      const preflight = workflow.preflight(request);
      expect(preflight).toMatchObject({
        approvedOrigins: ["https://www.cloudflare.com"],
      });
      expect(() => workflow.preflight({
        ...request,
        approvedOrigins: ["https://www.example.com"],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      const started = workflow.start({
        version: 1,
        preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "path-scoped-exact-seed",
      });
      const jobId = Number(started.id.split(":")[1]);
      const actionLedger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const catalog = createResourceCatalog(database.connection, () => new Date(at));
      createLiveAcquisitionMaterializer(database.connection, {
        actionLedger,
        previewResourceUrl: catalog.previewResourceUrl,
        clock: () => new Date(at),
      }).admitSeedOriginsForClaim(jobId);
      expect(database.connection.prepare(`
        SELECT url.exact_url
        FROM live_acquisition_actions AS action
        JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
        JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
        WHERE consent.coordinator_job_id = ? AND action.action_kind = 'page'
        ORDER BY action.id
      `).all(jobId)).toEqual([{ exact_url: "https://www.cloudflare.com/docs/seed" }]);
    } finally {
      database.close();
    }
  });

  it("rejects stale accepted Resource membership and counts immutable C90 attempts", () => {
    const stale = createFixture();
    try {
      stale.database.connection.exec(`
        INSERT INTO resource_resolution_events (
          id, logical_page_id, state, reason, candidate_resource_ids_json,
          source_fingerprint, research_eligible, research_exclusion_reason,
          supersedes_id, created_at
        ) VALUES (7002, 7001, 'ambiguous', 'authoritative_tie', '[7001]',
          'stale-resolution', 0, 'authoritative_tie', 7001, '${at}');
        UPDATE resource_resolution_heads SET resolution_event_id = 7002
        WHERE logical_page_id = 7001;
      `);
      expect(() => stale.workflow.preflight(request)).toThrowError(
        expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }),
      );
      expect(stale.database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);
    } finally {
      stale.database.close();
    }

    const capped = createFixture(undefined, 2);
    try {
      const preflight = capped.workflow.preflight(request);
      expect(preflight.dailyStartsRemaining).toBe(2);
      expect(preflight.dailyStartsResetAt).toBe("2026-08-16T00:00:00.000Z");
      const start = { version: 1 as const, preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "daily-cap-1" };
      const first = capped.workflow.start(start);
      expect(capped.workflow.start(start)).toEqual(first);
      expect(capped.workflow.preflight(request).dailyStartsRemaining).toBe(2);
      let ledgerNow = new Date(at);
      const ledger = createAiJobLedger(capped.database.connection, {
        clock: () => ledgerNow,
        token: (() => {
          let sequence = 0;
          return () => `live-daily-attempt-token-${String(++sequence).padStart(4, "0")}`;
        })(),
        kindAvailable: () => true,
        research: capped.research,
      });
      const claimLimits = {
        maxConcurrent: 1,
        maxAttemptsPerUtcDay: 100,
        maxCostUsdPerUtcDay: null,
      };
      const allowlist = [{ id: "research_acquisition:c90:v1", version: 1 }] as const;
      const firstClaim = ledger.claimNext(
        "resource_research", "live-daily-worker", claimLimits, undefined, allowlist,
      )!;
      expect(firstClaim).toMatchObject({ attemptNo: 1 });
      expect(capped.workflow.preflight(request).dailyStartsRemaining).toBe(1);
      ledger.fail(firstClaim, {
        progress: { completed: 0, total: 1, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      }, {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-15T09:00:01.000Z",
      });
      ledgerNow = new Date("2026-08-15T09:00:02.000Z");
      const secondClaim = ledger.claimNext(
        "resource_research", "live-daily-worker", claimLimits, undefined, allowlist,
      )!;
      expect(secondClaim).toMatchObject({ attemptNo: 2 });
      let exhausted: unknown;
      try {
        capped.workflow.preflight(request);
      } catch (error) {
        exhausted = error;
      }
      expect(exhausted).toMatchObject({
        code: "JOB_BUDGET_EXHAUSTED",
        dailyStartsRemaining: 0,
        dailyStartsResetAt: "2026-08-16T00:00:00.000Z",
      });
      expect(capped.workflow.start(start)).toMatchObject({
        id: first.id,
        kind: first.kind,
        status: "running",
      });
      expect(capped.database.connection.prepare("SELECT COUNT(*) FROM ai_job_attempts")
        .pluck().get()).toBe(2);
      expect(capped.database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(1);
    } finally {
      capped.database.close();
    }
  });

  it("binds the complete safe captured-corpus disclosure into live consent", () => {
    const { database, workflow } = createFixture();
    try {
      const approved = workflow.preflight(request);
      database.connection.prepare("UPDATE tabs SET title='Reed' WHERE id=7001").run();
      const changed = workflow.preflight(request);
      expect(changed.researchApprovalFingerprint).toBe(approved.researchApprovalFingerprint);
      expect(changed.capturedCorpus.corpusFingerprint)
        .not.toBe(approved.capturedCorpus.corpusFingerprint);
      expect(changed.approvalFingerprint).not.toBe(approved.approvalFingerprint);

      expect(() => workflow.start({
        version: 1,
        preflight: request,
        approvalFingerprint: approved.approvalFingerprint,
        researchApprovalFingerprint: approved.researchApprovalFingerprint,
        idempotencyKey: "captured-corpus-consent-stale",
      })).toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      expect(database.connection.prepare("SELECT COUNT(*) FROM live_acquisition_consents")
        .pluck().get()).toBe(0);
    } finally { database.close(); }
  });

  it("serializes two database writers with one durable job and receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-live-start-race-"));
    const path = join(directory, "tabhub.sqlite");
    const first = openDatabase(path, { migrationClock: () => new Date(at) });
    seed(first.connection);
    const quote = vi.fn(() => ({
      version: "research_provider_quote:v1" as const,
      inputDigest: digest("provider-input"), calls: 1 as const,
      inputTokens: 2_000, outputTokens: 8_192, costUsd: 0.25, wallTimeMs: 120_000,
    }));
    const preflightWorkflow = createLiveAcquisitionWorkflow({
      connection: first.connection,
      research: createResearchStore(first.connection, { clock: () => new Date(at) }),
      provider: { metadata: { provider: "anthropic", model: "test", promptVersion: "p1",
        pricingVersion: "price1" }, quote },
      clock: () => new Date(at),
      digestKey: () => Buffer.alloc(32, 7),
    });
    let barrier: Int32Array | undefined;
    const workers: Worker[] = [];
    try {
      const preflight = preflightWorkflow.preflight(request);
      const start = { version: 1 as const, preflight: request,
        approvalFingerprint: preflight.approvalFingerprint,
        researchApprovalFingerprint: preflight.researchApprovalFingerprint,
        idempotencyKey: "live-concurrent" };
      const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5);
      barrier = new Int32Array(shared);
      const spawn = (mode: "lock_owner" | "contender") => {
        const worker = new Worker(
          new URL("./support/live-acquisition-start-worker.mjs", import.meta.url),
          { workerData: { databasePath: path, request: start, mode, barrier: shared, at } },
        );
        workers.push(worker);
        return worker;
      };
      const outcome = (worker: Worker) => new Promise<{
        kind: "result";
        receipt: unknown;
        quoteCalls: number;
      }>((resolve, reject) => {
        worker.once("message", (message: { kind: string; message?: string }) => {
          if (message.kind === "error") reject(new Error(message.message));
          else resolve(message as { kind: "result"; receipt: unknown; quoteCalls: number });
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`start worker exited ${code}`));
        });
      });

      const contender = spawn("contender");
      const contenderOutcome = outcome(contender);
      expect(Atomics.wait(barrier, 2, 0, 30_000)).not.toBe("timed-out");
      expect(Atomics.load(barrier, 2)).toBe(1);
      const owner = spawn("lock_owner");
      const ownerOutcome = outcome(owner);
      expect(Atomics.wait(barrier, 0, 0, 30_000)).not.toBe("timed-out");
      expect(Atomics.load(barrier, 0)).toBe(1);
      Atomics.store(barrier, 3, 1);
      Atomics.notify(barrier, 3);
      expect(Atomics.wait(barrier, 4, 0, 30_000)).not.toBe("timed-out");
      let contenderSettled = false;
      void contenderOutcome.then(
        () => { contenderSettled = true; },
        () => { contenderSettled = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(contenderSettled).toBe(false);
      expect(first.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);

      Atomics.store(barrier, 1, 1);
      Atomics.notify(barrier, 1);
      const results = await Promise.all([ownerOutcome, contenderOutcome]);
      expect(results[0]!.receipt).toEqual(results[1]!.receipt);
      expect(results.map(({ quoteCalls }) => quoteCalls).sort()).toEqual([0, 1]);
      expect(first.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(1);
      expect(first.connection.prepare("SELECT COUNT(*) FROM ai_job_idempotency_receipts")
        .pluck().get()).toBe(1);
    } finally {
      if (barrier !== undefined) {
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
        Atomics.store(barrier, 3, 1);
        Atomics.notify(barrier, 3);
      }
      await Promise.allSettled(workers.map(async (worker) => worker.terminate()));
      first.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 75_000);
});
