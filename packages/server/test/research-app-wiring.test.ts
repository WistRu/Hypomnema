import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DurableJobId, DurableJobView } from "@tabhub/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerAiJobRoutes } from "../src/ai-job-routes.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import {
  personalAttentionFeatureFlagsOff,
  resolveEffectiveResearchFeature,
} from "../src/attention-feature-flags.js";
import type { LocalCapabilityService } from "../src/local-capability.js";
import { registerPriorityRoutes } from "../src/priority-routes.js";
import type { ResearchProvider } from "../src/research-provider.js";
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

async function localCookie(
  app: ReturnType<typeof createApp>,
  secret: string,
): Promise<string> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": secret },
  });
  expect(bootstrap.statusCode).toBe(204);
  return String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
}

function routeCapabilities(): LocalCapabilityService {
  return {
    authenticate(request) {
      return request.headers.authorization === "Bearer schema-23-local"
        ? { kind: "web" as const, installationId: null }
        : null;
    },
  } as LocalCapabilityService;
}

function priorityJob(
  id: DurableJobId,
  status: "queued" | "cancelled" = "queued",
): DurableJobView {
  return {
    id,
    kind: "priority_assessment",
    subject: { type: "collection", scope: "all" },
    status,
    attempts: 0,
    maxAttempts: 3,
    progress: { completed: 0, total: null, stage: status },
    canCancel: status === "queued",
    cancellationRequest: status === "cancelled"
      ? { requestedBy: "user", requestedAt: "2026-08-13T12:00:00.000Z" }
      : null,
    createdAt: "2026-08-13T12:00:00.000Z",
    startedAt: null,
    completedAt: status === "cancelled" ? "2026-08-13T12:00:00.000Z" : null,
    nextAttemptAt: status === "queued" ? "2026-08-13T12:00:00.000Z" : null,
    error: null,
    result: null,
  };
}

function seedLiveAcquisitionResource(databasePath: string, at: string): void {
  const database = openDatabase(databasePath, { migrationClock: () => new Date(at) });
  try {
    database.connection.exec(`
      INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed',
        'https://www.cloudflare.com/seed', '${at}', '${at}');
      INSERT INTO tabs (
        id, url, url_normalized, title, browser, status, importance, is_open,
        first_seen_at, last_seen_at, logical_page_id
      ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed',
        'Seed', 'chrome', 'inbox', 0, 1, '${at}', '${at}', 7001);
      INSERT INTO contents (tab_id, text, extracted_at, content_revision)
        VALUES (7001, 'captured seed evidence', '${at}', 1);
      INSERT INTO resources (id, resource_key, created_at)
        VALUES (7001, 'host:cloudflare.com', '${at}');
      INSERT INTO resource_events (
        id, resource_id, version, name, kind, access_class, lifecycle_state,
        created_by, creation_method, created_at
      ) VALUES (7001, 7001, 1, 'Cloudflare', 'website', 'public', 'active',
        'system', 'derived', '${at}');
      INSERT INTO resource_heads (resource_id, event_id) VALUES (7001, 7001);
      INSERT INTO logical_page_resource_assignments (
        id, logical_page_id, action, resource_id, provenance_class, assigned_by,
        assignment_method, source_fingerprint, created_at
      ) VALUES (7001, 7001, 'assigned', 7001, 'registrable_domain', 'system',
        'derived', 'app-live-seed', '${at}');
      INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (7001, 7001);
      INSERT INTO resource_resolution_events (
        id, logical_page_id, state, reason, resource_id, assignment_id,
        candidate_resource_ids_json, source_fingerprint, research_eligible,
        research_exclusion_reason, created_at
      ) VALUES (7001, 7001, 'matched', 'explicit_alias', 7001, 7001, '[]',
        'app-live-resolution', 1, NULL, '${at}');
      INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
        VALUES (7001, 7001);
      INSERT INTO resource_match_rules (
        id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
        priority, provenance_class, created_by, creation_method, created_at
      ) VALUES (7001, 'cloudflare-app-test', 1, 7001, 'cloudflare.com',
        'suffix_host', '/', 100, 'system_seed', 'system', 'derived', '${at}');
      INSERT INTO resource_match_rule_heads (rule_key, rule_id)
        VALUES ('cloudflare-app-test', 7001);
    `);
  } finally {
    database.close();
  }
}

describe("schema-24 research application composition", () => {
  it("keeps schema 23 disabled, requires schema 24, and defaults research off", () => {
    const optedIn = { ...personalAttentionFeatureFlagsOff, research: true };
    expect(resolveEffectiveResearchFeature(optedIn, 23)).toBe(false);
    expect(resolveEffectiveResearchFeature(optedIn, 24)).toBe(true);
    expect(resolveEffectiveResearchFeature(personalAttentionFeatureFlagsOff, 24))
      .toBe(false);
    expect(() => createApp({
      databasePath: ":memory:",
      liveAcquisitionMaxAttemptsPerUtcDay: 0,
    })).toThrow(/between 1 and 100/);
    expect(() => createApp({
      databasePath: ":memory:",
      liveAcquisitionMaxAttemptsPerUtcDay: 101,
    })).toThrow(/between 1 and 100/);
  });

  it("has one unified ledger/facade and one registration site for each shared route set", async () => {
    const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
    const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    const environmentExample = await readFile(
      new URL("../../../.env.example", import.meta.url),
      "utf8",
    );
    expect(source.match(/createResearchStore\(/g)).toHaveLength(1);
    expect(source.match(/createResearchReportCatalog\(/g)).toHaveLength(1);
    expect(source.match(/createResearchCorpusReader\(/g)).toHaveLength(1);
    expect(source.match(/createResearchWorker\(/g)).toHaveLength(1);
    expect(source.match(/createLiveAcquisitionActionLedger\(/g)).toHaveLength(1);
    expect(source.match(/createLiveAcquisitionWorkflow\(/g)).toHaveLength(1);
    expect(source.match(/createTrackedC90ClaimExecutor\(/g)).toHaveLength(1);
    expect(source.match(/executeC90DynamicActionPlan\(/g)).toHaveLength(1);
    expect(source.match(/selectC90NextPlannedActionId\(/g)).toHaveLength(1);
    expect(source.match(/createLiveAcquisitionHandoff\(/g)).toHaveLength(1);
    expect(source).not.toContain("Live acquisition handoff is not ready");
    expect(source).not.toContain("Live acquisition has no durable planned actions");
    expect(source).not.toContain("const actionIds = database.connection.prepare");
    expect(source.match(/createCompositeResourceResearchAdapter\(/g)).toHaveLength(1);
    expect(source.match(/createAiJobLedger\(/g)).toHaveLength(1);
    expect(source.match(/createDurableAiJobs\(/g)).toHaveLength(1);
    expect(source.match(/registerResearchRoutes\(/g)).toHaveLength(1);
    expect(source.match(/registerLiveAcquisitionRoutes\(/g)).toHaveLength(1);
    expect(source.match(/registerAgentResearchRoutes\(/g)).toHaveLength(1);
    expect(source.match(/registerAiJobRoutes\(/g)).toHaveLength(1);
    expect(mainSource.match(/createAnthropicResearchProvider\(/g)).toHaveLength(1);
    expect(mainSource).toMatch(/researchProvider/);
    for (const variable of [
      "ANTHROPIC_RESEARCH_MODEL",
      "ANTHROPIC_RESEARCH_PRICING_VERSION",
      "ANTHROPIC_RESEARCH_INPUT_USD_PER_MTOK",
      "ANTHROPIC_RESEARCH_OUTPUT_USD_PER_MTOK",
      "TABHUB_RESEARCH_MAX_OUTPUT_TOKENS",
      "TABHUB_RESEARCH_TIMEOUT_MS",
      "TABHUB_LIVE_ACQUISITION_MAX_ATTEMPTS_PER_UTC_DAY",
    ]) {
      expect(environmentExample).toContain(`${variable}=`);
    }
    expect(mainSource).toContain("TABHUB_LIVE_ACQUISITION_MAX_ATTEMPTS_PER_UTC_DAY");
    const priorityRegistration = source.slice(
      source.indexOf("registerPriorityRoutes(app"),
      source.indexOf("if (durableAiJobs"),
    );
    expect(priorityRegistration).not.toMatch(/\bjobs\s*:/);
    const priorityRoutes = await readFile(
      new URL("../src/priority-routes.ts", import.meta.url),
      "utf8",
    );
    expect(priorityRoutes).not.toMatch(/readonly jobs\??:/);
    expect(source).toMatch(/schemaVersion >= 25/);
    expect(source).toMatch(/startRuntimeStack\(/);
  });

  it("keeps schema 24 on the legacy C81 path with no live client or routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-schema24-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-schema24-secret";
    const liveAcquisitionClientFactory = vi.fn(() => {
      throw new Error("schema 24 must not construct the live client");
    });
    const provider: ResearchProvider = {
      metadata: { provider: "anthropic", model: "schema24", promptVersion: "p1",
        pricingVersion: "price1" },
      quote: () => ({ version: "research_provider_quote:v1", inputDigest: "a".repeat(64),
        calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01, wallTimeMs: 1_000 }),
      start: async () => { throw new Error("no schema-24 job was submitted"); },
    };
    const app = createApp({
      databasePath,
      maximumMigrationVersion: 24,
      featureFlags: { ...personalAttentionFeatureFlagsOff, research: true,
        resources: true, liveAcquisition: true },
      researchProvider: provider,
      liveAcquisitionClientFactory,
      localDevProxySecret: secret,
      logger: false,
    });
    try {
      const cookie = await localCookie(app, secret);
      const response = await app.inject({
        method: "POST",
        url: "/api/research/live/preflight",
        headers: { cookie, "sec-fetch-site": "same-origin" },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(liveAcquisitionClientFactory).not.toHaveBeenCalled();
      const reader = new Database(databasePath, { readonly: true });
      try {
        expect(reader.pragma("user_version", { simple: true })).toBe(24);
      } finally {
        reader.close();
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("constructs the schema-25 live client only for an effective writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-live-enabled-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-live-enabled-secret";
    const resolve = vi.fn(async () => { throw new Error("no live job was submitted"); });
    const request = vi.fn(async () => { throw new Error("no live job was submitted"); });
    const acquire = vi.fn(async () => { throw new Error("no live job was submitted"); });
    const liveAcquisitionClientFactory = vi.fn(() => ({ resolve, request, acquire }));
    const provider: ResearchProvider = {
      metadata: { provider: "anthropic", model: "schema25", promptVersion: "p1",
        pricingVersion: "price1" },
      quote: () => ({ version: "research_provider_quote:v1", inputDigest: "a".repeat(64),
        calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01, wallTimeMs: 1_000 }),
      start: async () => { throw new Error("no provider job was submitted"); },
    };
    const app = createApp({
      databasePath,
      featureFlags: { ...personalAttentionFeatureFlagsOff, research: true,
        resources: true, liveAcquisition: true },
      researchProvider: provider,
      liveAcquisitionClientFactory,
      localDevProxySecret: secret,
      logger: false,
    });
    try {
      const cookie = await localCookie(app, secret);
      const response = await app.inject({
        method: "POST",
        url: "/api/research/live/preflight",
        headers: { cookie, "sec-fetch-site": "same-origin" },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      expect(liveAcquisitionClientFactory).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs valid live preflight through 202 and begins the admitted robots-first plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-live-runtime-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const at = "2026-08-15T09:00:00.000Z";
    const secret = "research-live-runtime-secret";
    seedLiveAcquisitionResource(databasePath, at);
    const resolve = vi.fn(async () => { throw new Error("network must remain closed"); });
    const requestNetwork = vi.fn(async () => { throw new Error("network must remain closed"); });
    const acquire = vi.fn(async () => { throw new Error("network must remain closed"); });
    const quote = vi.fn(() => ({
      version: "research_provider_quote:v1" as const,
      inputDigest: "a".repeat(64),
      calls: 1 as const,
      inputTokens: 2_000,
      outputTokens: 8_192,
      costUsd: 0.25,
      wallTimeMs: 120_000,
    }));
    const providerStart = vi.fn(async () => {
      throw new Error("provider start must remain closed at approval");
    });
    const provider: ResearchProvider = {
      metadata: { provider: "anthropic", model: "schema25", promptVersion: "p1",
        pricingVersion: "price1" },
      quote,
      start: providerStart,
    };
    const app = createApp({
      databasePath,
      featureFlags: { ...personalAttentionFeatureFlagsOff, research: true,
        resources: true, liveAcquisition: true },
      researchProvider: provider,
      liveAcquisitionClientFactory: () => ({ resolve, request: requestNetwork, acquire }),
      liveAcquisitionMaxAttemptsPerUtcDay: 20,
      localDevProxySecret: secret,
      summaryWorkerPollMs: 60_000,
      clock: () => new Date(at),
      logger: false,
    });
    const reader = new Database(databasePath, { readonly: true });
    try {
      const cookie = await localCookie(app, secret);
      const headers = { cookie, "sec-fetch-site": "same-origin" };
      const preflightRequest = {
        version: 1,
        research: {
          version: 1,
          target: { type: "resource", resourceId: 7001 },
          question: "What should be researched?",
          includeShareableContext: false,
          maxIncludedSources: 10,
          parentReportId: null,
          budget: { maxSteps: 100, maxTokens: 20_000, maxCostUsd: 1,
            maxWallTimeMs: 420_000 },
          captureIntent: { selectedTabIds: [7001], knownFailures: [] },
          confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
        },
        approvedOrigins: ["https://www.cloudflare.com"],
        limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
      };
      const preflight = await app.inject({
        method: "POST",
        url: "/api/research/live/preflight",
        headers,
        payload: preflightRequest,
      });
      expect(preflight.statusCode).toBe(200);
      const approval = preflight.json() as {
        approvalFingerprint: string;
        researchApprovalFingerprint: string;
      };
      const attemptsBeforePost = Number(reader.prepare(`
        SELECT COUNT(*)
        FROM ai_job_attempts AS attempt
        JOIN ai_jobs AS job ON job.id = attempt.job_id
        WHERE job.workflow_id = 'research_acquisition:c90:v1'
          AND job.workflow_version = 1
      `).pluck().get());
      expect(attemptsBeforePost).toBe(0);
      const postStartedAt = Date.now();
      const started = await app.inject({
        method: "POST",
        url: "/api/research/live/runs",
        headers,
        payload: {
          version: 1,
          preflight: preflightRequest,
          approvalFingerprint: approval.approvalFingerprint,
          researchApprovalFingerprint: approval.researchApprovalFingerprint,
          idempotencyKey: "app-live-runtime-start",
        },
      });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({
        id: "resource_research:1",
        kind: "resource_research",
      });
      expect(quote).toHaveBeenCalledTimes(2);
      expect(providerStart).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenNthCalledWith(1, expect.objectContaining({
        url: "https://www.cloudflare.com/robots.txt",
      }));
      expect(resolve).toHaveBeenNthCalledWith(2, expect.objectContaining({
        url: "https://www.cloudflare.com/seed",
      }));
      expect(requestNetwork).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();

      let attempts = 0;
      for (let poll = 0; poll < 100 && attempts === 0; poll += 1) {
        attempts = Number(reader.prepare(`
          SELECT COUNT(*)
          FROM ai_job_attempts AS attempt
          JOIN ai_jobs AS job ON job.id = attempt.job_id
          WHERE job.workflow_id = 'research_acquisition:c90:v1'
            AND job.workflow_version = 1
        `).pluck().get());
        if (attempts === 0) {
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 10));
        }
      }
      expect(attempts).toBe(1);
      expect(Date.now() - postStartedAt).toBeLessThan(5_000);
      expect(providerStart).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      reader.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the schema-23 priority job route independent from research wiring", async () => {
    const app = Fastify();
    const get = vi.fn((id: DurableJobId) => priorityJob(id));
    const cancel = vi.fn((id: DurableJobId) => priorityJob(id, "cancelled"));
    registerPriorityRoutes(app, {
      reader: {
        read: vi.fn(),
        readBatch: vi.fn(() => []),
        reviewQueue: vi.fn(() => ({ items: [], nextCursor: null })),
      },
    });
    registerAiJobRoutes(app, {
      capabilities: routeCapabilities(),
      researchEnabled: false,
      jobs: { get, cancel },
    });

    try {
      await app.ready();
      const read = await app.inject({
        method: "GET",
        url: "/api/ai/jobs/priority_assessment:9",
      });
      expect(read.statusCode).toBe(200);
      expect(get).toHaveBeenCalledOnce();

      const cancelled = await app.inject({
        method: "POST",
        url: "/api/ai/jobs/priority_assessment:9/cancel",
        headers: { authorization: "Bearer schema-23-local" },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancel).toHaveBeenCalledWith("priority_assessment:9");

      const researchCancel = await app.inject({
        method: "POST",
        url: "/api/ai/jobs/resource_research:9/cancel",
        headers: { authorization: "Bearer schema-23-local" },
      });
      expect(researchCancel.statusCode).toBe(409);
      expect(researchCancel.json()).toEqual({
        error: "FEATURE_DISABLED",
        feature: "research",
      });
      expect(cancel).not.toHaveBeenCalledWith("resource_research:9");
    } finally {
      await app.close();
    }
  });

  it("registers flag-independent reads/redaction while disabled writers make zero writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-app-off-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-app-off-secret";
    const app = createApp({
      databasePath,
      featureFlags: personalAttentionFeatureFlagsOff,
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      migrationClock: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    try {
      const features = await app.inject({ method: "GET", url: "/api/features" });
      expect(features.statusCode).toBe(200);
      expect(features.json()).toMatchObject({ research: false });
      const cookie = await localCookie(app, secret);
      const headers = { cookie, "sec-fetch-site": "same-origin" };

      for (const request of [
        { method: "POST" as const, url: "/api/research/preflight", payload: {} },
        { method: "POST" as const, url: "/api/research/runs", payload: {} },
        { method: "POST" as const, url: "/api/ai/jobs/resource_research:1/cancel" },
      ]) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          error: "FEATURE_DISABLED",
          feature: "research",
        });
      }

      for (const request of [
        { method: "POST" as const, url: "/api/agent/research/start", payload: {} },
        { method: "POST" as const, url: "/api/agent/research/preflight", payload: {} },
        { method: "POST" as const, url: "/api/agent/research/runs", payload: {} },
        {
          method: "POST" as const,
          url: "/api/agent/ai/jobs/resource_research:1/cancel",
          payload: {},
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          error: "FEATURE_DISABLED",
          feature: "research",
        });
      }

      const reader = new Database(databasePath, { readonly: true });
      try {
        expect(reader.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
        expect(reader.prepare("SELECT COUNT(*) FROM research_runs").pluck().get()).toBe(0);
        expect(reader.prepare("SELECT COUNT(*) FROM ai_job_events").pluck().get()).toBe(0);
        expect(reader.prepare(
          "SELECT COUNT(*) FROM agent_research_command_receipts",
        ).pluck().get()).toBe(0);
        expect(reader.prepare("SELECT COUNT(*) FROM research_privacy_requests").pluck().get())
          .toBe(0);
      } finally {
        reader.close();
      }

      const missingHistory = await app.inject({
        method: "GET",
        url: "/api/ai/jobs/resource_research:1",
      });
      expect(missingHistory.statusCode).toBe(404);
      expect(missingHistory.json()).toEqual({ error: "JOB_NOT_FOUND" });

      const targetSeed = openDatabase(databasePath);
      try {
        targetSeed.connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url, created_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?)
        `).run(
          "https://openai.com/research-feature-off",
          "https://openai.com/research-feature-off",
          "https://openai.com/research-feature-off",
          "2026-08-13T12:00:00.000Z",
          "2026-08-13T12:00:00.000Z",
        );
      } finally {
        targetSeed.close();
      }
      const emptyReportHistory = await app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=1",
        headers,
      });
      expect(emptyReportHistory.statusCode).toBe(200);
      expect(emptyReportHistory.json()).toEqual({
        target: { type: "page", logicalPageId: 1 },
        head: {
          latestPublishedReportId: null,
          currentFreshReportId: null,
          lastSuccessfulReportId: null,
        },
        latestRun: null,
        items: [],
        nextBeforeVersion: null,
      });
      const emptyAgentReportHistory = await app.inject({
        method: "GET",
        url: "/api/agent/research/reports?targetType=page&targetId=1",
      });
      expect(emptyAgentReportHistory.statusCode).toBe(200);
      expect(emptyAgentReportHistory.json()).toEqual(emptyReportHistory.json());
      const missingReport = await app.inject({
        method: "GET", url: "/api/research/reports/1", headers,
      });
      expect(missingReport.statusCode).toBe(404);
      expect(missingReport.json()).toEqual({ error: "RESEARCH_REPORT_NOT_FOUND" });
      const missingAgentReport = await app.inject({
        method: "GET", url: "/api/agent/research/reports/1",
      });
      expect(missingAgentReport.statusCode).toBe(404);
      expect(missingAgentReport.json()).toEqual({ error: "RESEARCH_REPORT_NOT_FOUND" });
      const redaction = await app.inject({
        method: "POST",
        url: "/api/research/redactions",
        headers,
        payload: {
          target: { type: "target", target: { type: "page", logicalPageId: 1 } },
          reason: "Flag-independent privacy boundary",
          idempotencyKey: "research-app-off-redaction",
        },
      });
      expect(redaction.statusCode).toBe(200);
      expect(redaction.json()).toEqual({
        sources: 0,
        snapshots: 0,
        evidence: 0,
        reports: 0,
        runs: 0,
        cancelledJobs: 0,
      });

      const afterRedaction = new Database(databasePath, { readonly: true });
      try {
        expect(afterRedaction.prepare(
          "SELECT COUNT(*) FROM research_privacy_requests",
        ).pluck().get()).toBe(1);
      } finally {
        afterRedaction.close();
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps preflight and reads available but rejects run/refine before parsing or writing without a provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-app-no-provider-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-app-no-provider-secret";
    const app = createApp({
      databasePath,
      featureFlags: { ...personalAttentionFeatureFlagsOff, research: true },
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      migrationClock: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    try {
      const features = await app.inject({ method: "GET", url: "/api/features" });
      expect(features.statusCode).toBe(200);
      expect(features.json()).toMatchObject({ research: true });
      const cookie = await localCookie(app, secret);
      const headers = { cookie, "sec-fetch-site": "same-origin" };

      const preflight = await app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers,
        payload: {},
      });
      expect(preflight.statusCode).toBe(400);
      expect(preflight.json()).toMatchObject({ error: "VALIDATION_ERROR" });

      for (const request of [
        { method: "POST" as const, url: "/api/research/runs", payload: {} },
        {
          method: "POST" as const,
          url: "/api/research/reports/not-an-id/refine",
          payload: { parentReportId: 999 },
        },
      ]) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
      }

      const missingHistory = await app.inject({
        method: "GET",
        url: "/api/ai/jobs/resource_research:1",
      });
      expect(missingHistory.statusCode).toBe(404);
      expect(missingHistory.json()).toEqual({ error: "JOB_NOT_FOUND" });

      const reader = new Database(databasePath, { readonly: true });
      try {
        expect(reader.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
        expect(reader.prepare("SELECT COUNT(*) FROM research_runs").pluck().get()).toBe(0);
        expect(reader.prepare("SELECT COUNT(*) FROM ai_job_attempts").pluck().get()).toBe(0);
      } finally {
        reader.close();
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes one enabled research job through the common runtime and publishes its report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-app-runtime-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-app-runtime-secret";
    const start = vi.fn(async () => ({
      requestId: "research-app-runtime-request",
      async read() {
        return {
          version: 1 as const,
          dossier: {
            executiveSummary: "Runtime summary",
            valueForUser: "Runtime value",
            capabilities: ["Runtime capability"],
            limitations: [],
            risks: [],
            unknowns: [],
            nextSteps: ["Review the evidence"],
          },
          claims: [],
          usage: {
            steps: 1,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.001,
            wallTimeMs: 1,
          },
          stopReason: "complete" as const,
        };
      },
    }));
    const researchProvider: ResearchProvider = {
      metadata: Object.freeze({
        provider: "anthropic",
        model: "research-app-runtime-model",
        promptVersion: "research-app-runtime-prompt-v1",
        pricingVersion: "research-app-runtime-pricing-v1",
      }),
      quote() {
        return {
          version: "research_provider_quote:v1",
          inputDigest: "a".repeat(64),
          calls: 1,
          inputTokens: 10,
          outputTokens: 10,
          costUsd: 0.01,
          wallTimeMs: 1_000,
        };
      },
      start,
    };
    const liveAcquisitionClientFactory = vi.fn(() => {
      throw new Error("feature-off live client construction is forbidden");
    });
    const app = createApp({
      databasePath,
      featureFlags: { ...personalAttentionFeatureFlagsOff, research: true },
      researchProvider,
      liveAcquisitionClientFactory,
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      migrationClock: () => new Date("2026-08-13T12:00:00.000Z"),
      summaryWorkerPollMs: 10,
    });
    const seedDatabase = openDatabase(databasePath);
    const seed = seedDatabase.connection;
    try {
      seedReceiptBackedLiveResearchRun(seed);
      const url = "https://openai.com/research-app-runtime";
      seed.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        url,
        url,
        url,
        "2026-08-13T12:00:00.000Z",
        "2026-08-13T12:00:00.000Z",
      );
      seed.prepare(`
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, status, importance, is_open,
          first_seen_at, last_seen_at, logical_page_id
        ) VALUES (1, ?, ?, 'Runtime page', 'chrome', 'inbox', 0, 1, ?, ?, 1)
      `).run(
        url,
        url,
        "2026-08-13T12:00:00.000Z",
        "2026-08-13T12:00:00.000Z",
      );
      seed.prepare(`
        INSERT INTO contents (tab_id, text, extracted_at, content_revision)
        VALUES (1, 'Captured runtime material', ?, 1)
      `).run("2026-08-13T12:00:00.000Z");

      const cookie = await localCookie(app, secret);
      expect(liveAcquisitionClientFactory).not.toHaveBeenCalled();
      expect(seed.prepare("SELECT status FROM ai_jobs WHERE id = 7001").pluck().get())
        .toBe("superseded");
      expect(seed.prepare(`
        SELECT runtime_epoch || ':' || off_recovery_marker
        FROM live_acquisition_runtime_state WHERE singleton_id = 1
      `).pluck().get()).toBe("2:completed");
      expect(seed.prepare("SELECT COUNT(*) FROM ai_job_attempts WHERE job_id = 7001")
        .pluck().get()).toBe(0);
      const headers = { cookie, "sec-fetch-site": "same-origin" };
      const request = {
        version: 1,
        target: { type: "page", logicalPageId: 1 },
        question: "What is useful here?",
        includeShareableContext: false,
        maxIncludedSources: 100,
        parentReportId: null,
        budget: {
          maxSteps: 10,
          maxTokens: 10_000,
          maxCostUsd: 2,
          maxWallTimeMs: 60_000,
        },
        captureIntent: { selectedTabIds: [], knownFailures: [] },
        confirmedOrigins: {
          authenticatedOriginDigests: [],
          sensitiveOriginDigests: [],
        },
      };
      const preflight = await app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers,
        payload: request,
      });
      expect(preflight.statusCode, JSON.stringify(preflight.json())).toBe(200);
      const approval = preflight.json();
      const submitted = await app.inject({
        method: "POST",
        url: "/api/research/runs",
        headers,
        payload: {
          ...request,
          estimate: approval.estimate,
          approvalFingerprint: approval.approvalFingerprint,
          idempotencyKey: "research-app-runtime-run",
        },
      });
      expect(
        submitted.statusCode,
        JSON.stringify({ submitted: submitted.json(), preflight: approval }),
      ).toBe(202);
      const jobId = String(submitted.json().id);

      let job: ReturnType<typeof JSON.parse> | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await app.inject({ method: "GET", url: `/api/ai/jobs/${jobId}` });
        expect(response.statusCode).toBe(200);
        job = response.json();
        if (job.status !== "queued" && job.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({
        status: "succeeded",
        result: { type: "resource_research" },
      });
      expect(start).toHaveBeenCalledOnce();

      const report = await app.inject({
        method: "GET",
        url: `/api/research/reports/${String(job!.result.reportId)}`,
        headers,
      });
      expect(report.statusCode, JSON.stringify(report.json())).toBe(200);
      expect(report.json()).toMatchObject({
        publishStatus: "succeeded",
        reason: null,
        provenance: {
          provider: "anthropic",
          model: "research-app-runtime-model",
          promptVersion: "research-app-runtime-prompt-v1",
          pricingVersion: "research-app-runtime-pricing-v1",
          requestId: "research-app-runtime-request",
        },
      });
      const agentReport = await app.inject({
        method: "GET",
        url: `/api/agent/research/reports/${String(job!.result.reportId)}`,
      });
      expect(agentReport.statusCode, agentReport.body).toBe(200);
      expect(agentReport.json()).toMatchObject({
        id: job!.result.reportId,
        publishStatus: "succeeded",
        reportText: expect.stringContaining("Runtime summary"),
      });
      expect(agentReport.body).not.toContain("https://openai.com/research-app-runtime");
      expect(agentReport.body).not.toContain("Runtime page");
      expect(agentReport.body).not.toContain("Captured runtime material");
    } finally {
      seedDatabase.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
