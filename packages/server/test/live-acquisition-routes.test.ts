import Fastify from "fastify";
import { estimateResearchReservationV1, liveAcquisitionEffectivePolicy } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import type { LocalCapabilityService } from "../src/local-capability.js";
import { registerLiveAcquisitionRoutes } from "../src/live-acquisition-routes.js";

const capabilities = {
  authenticate(request: { headers: Record<string, unknown> }) {
    return request.headers.authorization === "Bearer local"
      ? { kind: "web" as const, installationId: null }
      : null;
  },
} as LocalCapabilityService;

const validPreflight = {
  version: 1 as const,
  research: {
    version: 1 as const,
    target: { type: "resource" as const, resourceId: 7 },
    question: "Research this Resource",
    includeShareableContext: false,
    maxIncludedSources: 10,
    parentReportId: null,
    budget: { maxSteps: 100, maxTokens: 10_000, maxCostUsd: 1, maxWallTimeMs: 420_000 },
    captureIntent: { selectedTabIds: [3], knownFailures: [] },
    confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
  },
  approvedOrigins: ["https://www.cloudflare.com"],
  limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
};

describe("live acquisition routes", () => {
  it("authenticates and gates both endpoints before parsing bodies", async () => {
    const app = Fastify();
    const workflow = { preflight: vi.fn(), start: vi.fn() };
    registerLiveAcquisitionRoutes(app, {
      capabilities,
      enabled: false,
      workflow: workflow as never,
    });
    try {
      const unauthorized = await app.inject({ method: "POST",
        url: "/api/research/live/preflight", payload: {} });
      expect(unauthorized.statusCode).toBe(401);
      const disabled = await app.inject({ method: "POST", url: "/api/research/live/runs",
        headers: { authorization: "Bearer local" }, payload: {} });
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json()).toEqual({ error: "FEATURE_DISABLED", feature: "liveAcquisition" });
      expect(workflow.preflight).not.toHaveBeenCalled();
      expect(workflow.start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns strict preflight and wakes exactly once after a committed 202 start", async () => {
    const app = Fastify();
    const response = {
      version: 1 as const,
      target: validPreflight.research.target,
      approvedOrigins: validPreflight.approvedOrigins,
      limits: validPreflight.limits,
      researchApprovalFingerprint: "a".repeat(64),
      approvalFingerprint: "b".repeat(64),
      expiresAt: "2026-08-15T09:05:00.000Z",
      provider: { provider: "anthropic", model: "test", promptVersion: "p1",
        pricingVersion: "price1", maxOutputTokens: 8_192 },
      rulesetVersion: 1,
      rulesetGenerationDigest: "c".repeat(64),
      resourceGenerationDigest: "d".repeat(64),
      dailyStartsRemaining: 20,
      dailyStartsResetAt: "2026-08-16T00:00:00.000Z",
      effectivePolicy: liveAcquisitionEffectivePolicy(10, 1),
      capturedCorpus: { corpusFingerprint: "e".repeat(64),
        coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
        manifest: [], snapshots: [], estimate: estimateResearchReservationV1({
          includedSources: 0, includedSourceBytes: 0, snapshotBytes: 0,
          questionBytes: 0, budget: validPreflight.research.budget,
        }) },
    };
    const workflow = {
      preflight: vi.fn(() => response),
      start: vi.fn(() => ({ id: "resource_research:9" as const,
        kind: "resource_research" as const, status: "queued" as const })),
    };
    const scheduler = { wake: vi.fn() };
    registerLiveAcquisitionRoutes(app, { capabilities, enabled: true, workflow, scheduler });
    try {
      const preflight = await app.inject({ method: "POST",
        url: "/api/research/live/preflight", headers: { authorization: "Bearer local" },
        payload: validPreflight });
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json()).toEqual(response);

      const startPayload = { version: 1, preflight: validPreflight,
        approvalFingerprint: response.approvalFingerprint,
        researchApprovalFingerprint: response.researchApprovalFingerprint,
        idempotencyKey: "live-route-1" };
      const start = await app.inject({ method: "POST", url: "/api/research/live/runs",
        headers: { authorization: "Bearer local" }, payload: startPayload });
      expect(start.statusCode).toBe(202);
      expect(start.json()).toEqual({ id: "resource_research:9", kind: "resource_research",
        status: "queued" });
      expect(workflow.start).toHaveBeenCalledWith(startPayload);
      expect(scheduler.wake).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("keeps authenticated historical reads available while the writer is disabled", async () => {
    const app = Fastify();
    const status = {
      version: 1 as const, jobId: "resource_research:9", target: { type: "resource" as const,
        resourceId: 7 }, coordinator: { runId: 4, status: "superseded" as const }, final: null,
      consent: { state: "consumed" as const, createdAt: "2026-08-15T09:00:00.000Z",
        expiresAt: "2026-08-15T09:05:00.000Z", terminalAt: "2026-08-15T09:01:00.000Z",
        approvedOrigins: ["https://www.cloudflare.com"], limits: { maxPages: 10, maxDepth: 1,
          durationMs: 300_000, maxCostUsd: 1, maxOrigins: 1, maxOutputTokens: 8192 },
        effectivePolicy: liveAcquisitionEffectivePolicy(10, 1) }, runLiveSuccess: false,
      workflowOutcome: "captured_only" as const,
      workflowOutcomeCode: "NO_ELIGIBLE_SOURCE" as const,
      acquisitionOutcome: "zero_usable" as const, counters: { reservedPages: 0, visitedPages: 0,
        capturedPages: 0, blockedPages: 0, ambiguousPages: 0, robotsActions: 0,
        networkActions: 0, plannedActions: 0, activeActions: 0 }, actions: [],
    };
    registerLiveAcquisitionRoutes(app, { capabilities, enabled: false,
      statusReader: { read: vi.fn(() => status) } });
    try {
      const unauthenticated = await app.inject({ method: "GET",
        url: "/api/research/live/runs/resource_research:9" });
      expect(unauthenticated.statusCode).toBe(401);
      const response = await app.inject({ method: "GET",
        url: "/api/research/live/runs/resource_research:9",
        headers: { authorization: "Bearer local" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(status);
    } finally { await app.close(); }
  });

  it("does not wake when atomic start fails", async () => {
    const app = Fastify();
    const error = Object.assign(new Error("stale"), { code: "RESEARCH_PREFLIGHT_STALE" });
    const scheduler = { wake: vi.fn() };
    registerLiveAcquisitionRoutes(app, {
      capabilities,
      enabled: true,
      workflow: { preflight: vi.fn(), start: vi.fn(() => { throw error; }) },
      scheduler,
    });
    try {
      const result = await app.inject({ method: "POST", url: "/api/research/live/runs",
        headers: { authorization: "Bearer local" }, payload: { version: 1,
          preflight: validPreflight, approvalFingerprint: "a".repeat(64),
          researchApprovalFingerprint: "b".repeat(64), idempotencyKey: "stale" } });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual({ error: "RESEARCH_PREFLIGHT_STALE" });
      expect(scheduler.wake).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps daily-start exhaustion to one stable typed 429 response", async () => {
    const app = Fastify();
    const exhausted = Object.assign(new Error("exhausted"), {
      code: "JOB_BUDGET_EXHAUSTED",
      dailyStartsRemaining: 0,
      dailyStartsResetAt: "2026-08-16T00:00:00.000Z",
    });
    registerLiveAcquisitionRoutes(app, {
      capabilities,
      enabled: true,
      workflow: {
        preflight: vi.fn(() => { throw exhausted; }),
        start: vi.fn(() => { throw exhausted; }),
      },
    });
    try {
      for (const [url, payload] of [
        ["/api/research/live/preflight", validPreflight],
        ["/api/research/live/runs", {
          version: 1,
          preflight: validPreflight,
          approvalFingerprint: "a".repeat(64),
          researchApprovalFingerprint: "b".repeat(64),
          idempotencyKey: "daily-exhausted",
        }],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer local" },
          payload,
        });
        expect(response.statusCode).toBe(429);
        expect(response.json()).toEqual({
          error: "JOB_BUDGET_EXHAUSTED",
          dailyStartsRemaining: 0,
          dailyStartsResetAt: "2026-08-16T00:00:00.000Z",
        });
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    ["RESEARCH_PARENT_NOT_FOUND", 404],
    ["RESEARCH_PARENT_UNAVAILABLE", 409],
  ] as const)("maps %s to its stable typed client response", async (code, statusCode) => {
    const app = Fastify();
    registerLiveAcquisitionRoutes(app, {
      capabilities,
      enabled: true,
      workflow: {
        preflight: vi.fn(() => { throw Object.assign(new Error(code), { code }); }),
        start: vi.fn(),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/research/live/preflight",
        headers: { authorization: "Bearer local" },
        payload: validPreflight,
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ error: code });
    } finally {
      await app.close();
    }
  });
});
