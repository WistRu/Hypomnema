import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DurableJobId, DurableJobView } from "@tabhub/shared";

import { registerAiJobRoutes } from "../src/ai-job-routes.js";
import { DurableAiJobError } from "../src/durable-ai-jobs.js";
import type { LocalCapabilityService } from "../src/local-capability.js";
import {
  registerResearchRoutes,
  type ResearchRouteReportCatalog,
} from "../src/research-routes.js";

const budget = {
  maxSteps: 3,
  maxTokens: 2_000,
  maxCostUsd: 0.5,
  maxWallTimeMs: 30_000,
};

function localCapabilities(): LocalCapabilityService {
  return {
    authenticate(request) {
      return request.headers.authorization === "Bearer local-test"
        ? { kind: "web" as const, installationId: null }
        : null;
    },
  } as LocalCapabilityService;
}

function unusedReports(): ResearchRouteReportCatalog {
  return {
    list() { throw new Error("Unexpected report list read"); },
    get() { throw new Error("Unexpected report detail read"); },
  };
}

const preflightRequest = {
  version: 1 as const,
  target: { type: "page" as const, logicalPageId: 1 },
  question: "What is useful?",
  includeShareableContext: true,
  maxIncludedSources: 100,
  parentReportId: null,
  budget,
  captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
};

const emptyPreflight = {
  version: 1 as const,
  target: preflightRequest.target,
  approvalFingerprint: null,
  corpusFingerprint: "a".repeat(64),
  coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
  approvedBudget: budget,
  acquisitionLevel: "captured_only" as const,
  manifest: [],
  snapshots: [],
  confirmationRequirements: {
    authenticatedOriginDigests: [],
    sensitiveOriginDigests: [],
  },
  confirmationDisplay: [],
  estimate: {
    estimateVersion: "research_estimate:v1" as const,
    estimateKind: "reservation_envelope" as const,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallTimeMs: 0,
  },
  requiresConfirmation: false,
  limitations: [],
};

function jobView(id: DurableJobId): DurableJobView {
  const [prefix] = id.split(":");
  const kind = prefix === "summary" ? "page_summary" : prefix;
  return {
    id,
    kind: kind as DurableJobView["kind"],
    subject: kind === "page_summary"
      ? { type: "page", logicalPageId: 1 }
      : kind === "priority_assessment"
        ? { type: "collection", scope: "all" }
        : { type: "resource", resourceId: 1 },
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    progress: { completed: 0, total: null, stage: "queued" },
    canCancel: kind !== "page_summary",
    cancellationRequest: null,
    createdAt: "2026-08-13T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    nextAttemptAt: "2026-08-13T12:00:00.000Z",
    error: null,
    result: null,
  } as DurableJobView;
}

describe("research REST boundaries", () => {
  it("authenticates and feature-gates preflight before invoking the workflow", async () => {
    const preflight = vi.fn(() => emptyPreflight);
    const requestRun = vi.fn();
    const redact = vi.fn(() => ({
      sources: 0, snapshots: 0, evidence: 0, reports: 0, runs: 0, cancelledJobs: 0,
    }));
    const app = Fastify();
    registerResearchRoutes(app, {
      capabilities: localCapabilities(),
      researchEnabled: false,
      workflow: { preflight, requestRun, redact },
      reports: unusedReports(),
    });
    try {
      const unauthenticated = await app.inject({
        method: "POST", url: "/api/research/preflight", payload: preflightRequest,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toEqual({
        error: "LOCAL_CAPABILITY_REQUIRED",
        message: "A valid local capability is required",
      });

      const disabled = await app.inject({
        method: "POST", url: "/api/research/preflight",
        headers: { authorization: "Bearer local-test" }, payload: preflightRequest,
      });
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json()).toEqual({ error: "FEATURE_DISABLED", feature: "research" });
      expect(preflight).not.toHaveBeenCalled();

      const disabledRun = await app.inject({
        method: "POST", url: "/api/research/runs",
        headers: { authorization: "Bearer local-test" }, payload: { deliberately: "invalid" },
      });
      expect(disabledRun.statusCode).toBe(409);
      expect(disabledRun.json()).toEqual({ error: "FEATURE_DISABLED", feature: "research" });
      expect(requestRun).not.toHaveBeenCalled();

      const redaction = await app.inject({
        method: "POST", url: "/api/research/redactions",
        headers: { authorization: "Bearer local-test" }, payload: {
          target: { type: "target", target: { type: "page", logicalPageId: 1 } },
          reason: "Privacy remains available",
          idempotencyKey: "disabled-redaction-1",
        },
      });
      expect(redaction.statusCode).toBe(200);
      expect(redact).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("validates and delegates preflight, accepted runs, and the public redaction union", async () => {
    const preflight = vi.fn(() => ({ ...emptyPreflight,
      approvalFingerprint: "b".repeat(64) }));
    const requestRun = vi.fn(() => ({
      id: "resource_research:7" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    }));
    const redact = vi.fn(() => ({
      sources: 1, snapshots: 1, evidence: 2, reports: 1, runs: 1, cancelledJobs: 1,
    }));
    const wake = vi.fn();
    const app = Fastify();
    registerResearchRoutes(app, {
      capabilities: localCapabilities(), researchEnabled: true,
      providerAvailable: true,
      workflow: { preflight, requestRun, redact }, reports: unusedReports(), scheduler: { wake },
    });
    const headers = { authorization: "Bearer local-test" };
    try {
      const preflightResponse = await app.inject({
        method: "POST", url: "/api/research/preflight", headers,
        payload: preflightRequest,
      });
      expect(preflightResponse.statusCode).toBe(200);
      expect(preflightResponse.json()).not.toHaveProperty("capturedText");
      expect(preflight).toHaveBeenCalledWith({
        ...preflightRequest,
        confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      });

      const approval = {
        ...preflightRequest,
        confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
        estimate: emptyPreflight.estimate,
        approvalFingerprint: "b".repeat(64),
        idempotencyKey: "route-run-1",
      };
      const run = await app.inject({
        method: "POST", url: "/api/research/runs", headers, payload: approval,
      });
      expect(run.statusCode).toBe(202);
      expect(run.json()).toEqual({
        id: "resource_research:7", kind: "resource_research", status: "queued",
      });
      expect(requestRun).toHaveBeenCalledWith(approval);
      expect(wake).toHaveBeenCalledOnce();

      const redactionRequest = {
        target: { type: "source" as const, sourceId: 1 },
        reason: "User requested removal",
        idempotencyKey: "route-redaction-1",
      };
      const redaction = await app.inject({
        method: "POST", url: "/api/research/redactions", headers,
        payload: redactionRequest,
      });
      expect(redaction.statusCode).toBe(200);
      expect(redaction.json()).toMatchObject({ sources: 1, reports: 1, cancelledJobs: 1 });
      expect(redact).toHaveBeenCalledWith(redactionRequest);

      const directSnapshot = await app.inject({
        method: "POST", url: "/api/research/redactions", headers, payload: {
          target: { type: "snapshot", kind: "page_context", snapshotId: 1 },
          reason: "Must remain internal",
          idempotencyKey: "route-redaction-snapshot",
        },
      });
      expect(directSnapshot.statusCode).toBe(400);
      expect(redact).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("fails run and refine with provider-unavailable before validation or workflow writes", async () => {
    const preflight = vi.fn(() => emptyPreflight);
    const requestRun = vi.fn();
    const redact = vi.fn();
    const wake = vi.fn();
    const app = Fastify();
    registerResearchRoutes(app, {
      capabilities: localCapabilities(),
      researchEnabled: true,
      providerAvailable: false,
      workflow: { preflight, requestRun, redact },
      reports: unusedReports(),
      scheduler: { wake },
    });
    const headers = { authorization: "Bearer local-test" };
    try {
      for (const url of ["/api/research/runs", "/api/research/reports/not-an-id/refine"]) {
        const response = await app.inject({
          method: "POST", url, headers, payload: { deliberately: "invalid" },
        });
        expect(response.statusCode, url).toBe(503);
        expect(response.json()).toEqual({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
      }
      const preflightResponse = await app.inject({
        method: "POST", url: "/api/research/preflight", headers, payload: preflightRequest,
      });
      expect(preflightResponse.statusCode).toBe(200);
      expect(preflight).toHaveBeenCalledOnce();
      expect(requestRun).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("binds refine parent identity from the path and rejects caller-supplied parent IDs", async () => {
    const requestRun = vi.fn(() => ({
      id: "resource_research:8" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    }));
    const wake = vi.fn();
    const app = Fastify();
    registerResearchRoutes(app, {
      capabilities: localCapabilities(), researchEnabled: true, providerAvailable: true,
      workflow: { preflight: vi.fn(), requestRun, redact: vi.fn() },
      reports: unusedReports(), scheduler: { wake },
    });
    const headers = { authorization: "Bearer local-test" };
    const approval = {
      ...preflightRequest,
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      estimate: emptyPreflight.estimate,
      approvalFingerprint: "b".repeat(64),
      idempotencyKey: "route-refine-1",
    };
    const { parentReportId: _discarded, ...refineApproval } = approval;
    try {
      const accepted = await app.inject({
        method: "POST", url: "/api/research/reports/9/refine", headers,
        payload: refineApproval,
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toEqual({
        id: "resource_research:8", kind: "resource_research", status: "queued",
      });
      expect(requestRun).toHaveBeenCalledWith({ ...refineApproval, parentReportId: 9 });
      expect(wake).toHaveBeenCalledOnce();

      const rejected = await app.inject({
        method: "POST", url: "/api/research/reports/9/refine", headers,
        payload: { ...refineApproval, parentReportId: 10 },
      });
      expect(rejected.statusCode).toBe(400);
      expect(requestRun).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("registers one flag-independent job read and locally-authorized kind-gated cancel", async () => {
    const get = vi.fn((id: DurableJobId) => jobView(id));
    const cancel = vi.fn((id: DurableJobId) => jobView(id));
    const cancelResearch = vi.fn((id: DurableJobId) => jobView(id));
    let researchEnabled = false;
    const app = Fastify();
    registerAiJobRoutes(app, {
      capabilities: localCapabilities(),
      researchEnabled: () => researchEnabled,
      jobs: { get, cancel },
      researchWorkflow: { cancel: cancelResearch },
    });
    try {
      const read = await app.inject({ method: "GET", url: "/api/ai/jobs/priority_assessment:9" });
      expect(read.statusCode).toBe(200);
      expect(get).toHaveBeenCalledWith("priority_assessment:9");
      expect((await app.inject({ method: "GET", url: "/api/ai/jobs/9" })).statusCode)
        .toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/jobs/9" })).statusCode)
        .toBe(404);

      expect((await app.inject({ method: "POST",
        url: "/api/ai/jobs/priority_assessment:9/cancel" })).statusCode).toBe(401);
      const priorityCancel = await app.inject({ method: "POST",
        url: "/api/ai/jobs/priority_assessment:9/cancel",
        headers: { authorization: "Bearer local-test" } });
      expect(priorityCancel.statusCode).toBe(200);
      expect(cancel).toHaveBeenCalledWith("priority_assessment:9");

      const researchCancel = await app.inject({ method: "POST",
        url: "/api/ai/jobs/resource_research:7/cancel",
        headers: { authorization: "Bearer local-test" } });
      expect(researchCancel.statusCode).toBe(409);
      expect(researchCancel.json()).toEqual({
        error: "FEATURE_DISABLED", feature: "research",
      });
      expect(cancel).not.toHaveBeenCalledWith("resource_research:7");
      expect(cancelResearch).not.toHaveBeenCalled();

      researchEnabled = true;
      const enabledResearchCancel = await app.inject({ method: "POST",
        url: "/api/ai/jobs/resource_research:7/cancel",
        headers: { authorization: "Bearer local-test" } });
      expect(enabledResearchCancel.statusCode).toBe(200);
      expect(cancel).not.toHaveBeenCalledWith("resource_research:7");
      expect(cancelResearch).toHaveBeenCalledWith("resource_research:7");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["RESEARCH_TARGET_NOT_FOUND", 404],
    ["RESEARCH_PARENT_NOT_FOUND", 404],
    ["RESEARCH_SCOPE_TOO_LARGE", 413],
    ["RESEARCH_CAPTURE_REQUIRED", 422],
    ["RESEARCH_SELECTION_INVALID", 422],
    ["RESEARCH_PREFLIGHT_STALE", 409],
    ["IDEMPOTENCY_KEY_CONFLICT", 409],
    ["JOB_ACTIVE_CONFLICT", 409],
    ["RESEARCH_PARENT_UNAVAILABLE", 409],
    ["INVALID_JOB_INPUT", 400],
  ])("maps %s to HTTP %i without exposing dependency details", async (code, status) => {
    const app = Fastify();
    registerResearchRoutes(app, {
      capabilities: localCapabilities(), researchEnabled: true,
      providerAvailable: true,
      reports: unusedReports(),
      workflow: {
        preflight() { throw Object.assign(new Error("secret SQL and captured text"), { code }); },
        requestRun: vi.fn(), redact: vi.fn(),
      },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/api/research/preflight",
        headers: { authorization: "Bearer local-test" }, payload: preflightRequest,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("secret SQL");
      expect(response.json()).toMatchObject(status === 400
        ? { error: "VALIDATION_ERROR", code }
        : { error: code });
    } finally {
      await app.close();
    }
  });

  it("makes unexpected research and job failures opaque", async () => {
    const research = Fastify({ logger: false });
    registerResearchRoutes(research, {
      capabilities: localCapabilities(), researchEnabled: true,
      providerAvailable: true,
      reports: unusedReports(),
      workflow: {
        preflight() { throw new Error("secret research row"); },
        requestRun: vi.fn(), redact: vi.fn(),
      },
    });
    const jobs = Fastify({ logger: false });
    registerAiJobRoutes(jobs, {
      capabilities: localCapabilities(), researchEnabled: true,
      jobs: {
        get() { throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "secret job row"); },
        cancel: vi.fn(),
      },
    });
    try {
      const researchResponse = await research.inject({
        method: "POST", url: "/api/research/preflight",
        headers: { authorization: "Bearer local-test" }, payload: preflightRequest,
      });
      expect(researchResponse.statusCode).toBe(500);
      expect(researchResponse.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(researchResponse.body).not.toContain("secret research row");

      const jobResponse = await jobs.inject({
        method: "GET", url: "/api/ai/jobs/priority_assessment:1",
      });
      expect(jobResponse.statusCode).toBe(500);
      expect(jobResponse.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(jobResponse.body).not.toContain("secret job row");
    } finally {
      await research.close();
      await jobs.close();
    }
  });

  it("maps shared job not-found and cancellation conflicts without leaking messages", async () => {
    const app = Fastify();
    registerAiJobRoutes(app, {
      capabilities: localCapabilities(), researchEnabled: true,
      jobs: {
        get() { throw new DurableAiJobError("JOB_NOT_FOUND", "secret missing key"); },
        cancel() {
          throw new DurableAiJobError("JOB_NOT_CANCELLABLE", "secret current state");
        },
      },
    });
    try {
      const missing = await app.inject({
        method: "GET", url: "/api/ai/jobs/priority_assessment:88",
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "JOB_NOT_FOUND" });
      expect(missing.body).not.toContain("secret missing key");

      const conflict = await app.inject({
        method: "POST", url: "/api/ai/jobs/priority_assessment:88/cancel",
        headers: { authorization: "Bearer local-test" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: "JOB_NOT_CANCELLABLE" });
      expect(conflict.body).not.toContain("secret current state");
    } finally {
      await app.close();
    }
  });
});
