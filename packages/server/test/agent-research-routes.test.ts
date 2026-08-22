import Fastify from "fastify";
import type { AgentResearchStartRequest, DurableJobRef } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { registerAgentResearchRoutes } from "../src/agent-research-routes.js";

const hash = "a".repeat(64);
const at = "2026-08-14T10:00:00.000Z";
const budget = { maxSteps: 3, maxTokens: 2_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };

const preflight = {
  version: 1 as const,
  target: { type: "page" as const, logicalPageId: 41 },
  approvalFingerprint: hash,
  corpusFingerprint: hash,
  coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
  approvedBudget: budget,
  acquisitionLevel: "captured_only" as const,
  manifest: [{
    sourceKind: "captured" as const,
    acquisitionMethod: "captured" as const,
    ordinal: 1,
    logicalPageId: 41,
    selectedTabId: 71,
    contentRevision: 3,
    contentDigest: hash,
    state: "captured" as const,
    exclusionReason: null,
    exclusionCategory: null,
    accessClass: "authenticated" as const,
    originDigest: hash,
    requiresConfirmation: true,
    failureCode: null,
    capturedChunkManifest: {
      version: "captured_text_chunks:v1" as const,
      byteStart: 0 as const,
      byteEnd: 5,
      chunkDigest: hash,
      truncated: false,
    },
  }],
  snapshots: [],
  confirmationRequirements: {
    authenticatedOriginDigests: [hash],
    sensitiveOriginDigests: [],
  },
  confirmationDisplay: [{
    accessClass: "authenticated" as const,
    originDigest: hash,
    origin: "https://private-canary.example",
  }],
  estimate: {
    estimateVersion: "research_estimate:v1" as const,
    estimateKind: "reservation_envelope" as const,
    calls: 1,
    inputTokens: 600,
    outputTokens: 1024,
    costUsd: 1,
    wallTimeMs: 60_000,
  },
  requiresConfirmation: true,
  limitations: [],
};

const detail = {
  id: 9,
  runId: 12,
  jobId: "resource_research:15" as const,
  runStatus: "succeeded" as const,
  target: { type: "page" as const, logicalPageId: 41 },
  version: 1,
  parentReportId: null,
  publishStatus: "succeeded" as const,
  state: "fresh" as const,
  reason: null,
  coverage: { discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0 },
  createdAt: at,
  headFlags: { isLatestPublished: true, isCurrentFresh: true, isLastSuccessful: true },
  dossier: {
    executiveSummary: "Agent-safe conclusion",
    valueForUser: "Useful",
    capabilities: [],
    limitations: [],
    risks: [],
    unknowns: [],
    nextSteps: [],
  },
  reportText: "# Agent-safe conclusion",
  provenance: {
    provider: "fixture",
    model: "fixture-model",
    promptVersion: "fixture-v1",
    pricingVersion: "fixture-price-v1",
    requestId: "fixture-request-1",
    generatedAt: at,
    usage: { steps: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.01, wallTimeMs: 50 },
    inputFingerprint: hash,
    terminalAttemptId: 8,
  },
  claims: [{
    id: 20,
    ordinal: 1,
    claimDigest: hash,
    claimText: "Safe claim",
    confidence: 0.9,
    isInference: false,
    rationaleDigest: null,
    rationale: null,
    evidence: [{
      id: 30,
      ordinal: 1,
      kind: "tab_content" as const,
      sourceId: 7,
      sourceKind: "captured" as const,
      acquisitionMethod: "captured" as const,
      contentRevision: 3,
      contentDigest: hash,
      state: "valid" as const,
      stateReason: null,
      locatorDigest: hash,
      locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 14 },
      excerptHash: hash,
      excerpt: "EXCERPT_CANARY",
      url: "https://URL-CANARY.example/private?token=secret",
      title: "TITLE_CANARY",
    }],
  }],
};

function options(enabled = true) {
  const workflow = {
    preflight: vi.fn(() => preflight),
    replayAgentStart: vi.fn((_: AgentResearchStartRequest): DurableJobRef | undefined =>
      undefined),
    requestAgentStart: vi.fn(() => ({
      status: "confirmation_required" as const,
      confirmationRequirements: preflight.confirmationRequirements,
    })),
    requestAgentRun: vi.fn(() => ({
      id: "resource_research:15" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    })),
    cancelAgent: vi.fn(() => ({
      id: "resource_research:15" as const,
      kind: "resource_research" as const,
      subject: { type: "page" as const, logicalPageId: 41 },
      status: "cancelled" as const,
      attempts: 0,
      maxAttempts: 3,
      progress: { completed: 0, total: 1, stage: "cancelled" },
      canCancel: false,
      cancellationRequest: { requestedBy: "agent" as const, requestedAt: at },
      result: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      completedAt: at,
      nextAttemptAt: null,
    })),
  };
  const list = {
    target: detail.target,
    head: { latestPublishedReportId: 9, currentFreshReportId: 9, lastSuccessfulReportId: 9 },
    latestRun: {
      runId: 12, jobId: detail.jobId, status: "succeeded" as const,
      parentReportId: null, reportId: 9, createdAt: at,
    },
    items: [{
      id: 9, runId: 12, jobId: detail.jobId, version: 1, parentReportId: null,
      publishStatus: "succeeded" as const, state: "fresh" as const, reason: null,
      coverage: detail.coverage, createdAt: at, executiveSummary: "Agent-safe conclusion",
      headFlags: detail.headFlags,
    }],
    nextBeforeVersion: null,
  };
  return {
    researchEnabled: enabled,
    providerAvailable: true,
    workflow,
    reports: { list: vi.fn(() => list), get: vi.fn(() => detail) },
  };
}

describe("agent research HTTP boundary", () => {
  it("returns a write-free typed start confirmation over the no-cookie agent route", async () => {
    const app = Fastify();
    const dependencies = options();
    const wake = vi.fn();
    registerAgentResearchRoutes(app, { ...dependencies, scheduler: { wake } });
    const payload = {
      version: 1,
      target: preflight.target,
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      budget,
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      idempotencyKey: "agent-start-confirmation",
      authorizationRef: "user-instruction:agent-start-confirmation",
    };
    try {
      const response = await app.inject({
        method: "POST", url: "/api/agent/research/start", payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "confirmation_required",
        confirmationRequirements: preflight.confirmationRequirements,
      });
      expect(dependencies.workflow.replayAgentStart).toHaveBeenCalledWith(payload);
      expect(dependencies.workflow.requestAgentStart).toHaveBeenCalledWith(payload);
      expect(dependencies.workflow.requestAgentRun).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns an exact durable replay before provider availability but rejects a new start", async () => {
    const app = Fastify();
    const dependencies = options();
    const replay = {
      id: "resource_research:15" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    };
    dependencies.providerAvailable = false;
    dependencies.workflow.replayAgentStart.mockImplementation((request) =>
      request.idempotencyKey === "existing-start" ? replay : undefined);
    const wake = vi.fn();
    registerAgentResearchRoutes(app, { ...dependencies, scheduler: { wake } });
    const payload = {
      version: 1,
      target: preflight.target,
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      budget,
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      authorizationRef: "user-instruction:agent-start",
    };
    try {
      const exactReplay = await app.inject({
        method: "POST", url: "/api/agent/research/start",
        payload: { ...payload, idempotencyKey: "existing-start" },
      });
      expect(exactReplay.statusCode).toBe(202);
      expect(exactReplay.json()).toEqual(replay);
      expect(dependencies.workflow.requestAgentStart).not.toHaveBeenCalled();
      expect(wake).toHaveBeenCalledOnce();

      const newStart = await app.inject({
        method: "POST", url: "/api/agent/research/start",
        payload: { ...payload, idempotencyKey: "new-start" },
      });
      expect(newStart.statusCode).toBe(503);
      expect(newStart.json()).toEqual({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
      expect(dependencies.workflow.requestAgentStart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { parentReportId: null },
    { captureIntent: { selectedTabIds: [], knownFailures: [] } },
    { estimate: preflight.estimate },
    { approvalFingerprint: hash },
    { provenance: { requestedBy: "agent", requestMethod: "on_behalf_of_user" } },
  ])("rejects forbidden start-or-replay field %# before workflow invocation", async (field) => {
    const app = Fastify();
    const dependencies = options();
    registerAgentResearchRoutes(app, dependencies);
    try {
      const response = await app.inject({
        method: "POST", url: "/api/agent/research/start",
        payload: {
          version: 1,
          target: preflight.target,
          question: "What matters?",
          includeShareableContext: true,
          maxIncludedSources: 100,
          budget,
          confirmedOrigins: {
            authenticatedOriginDigests: [], sensitiveOriginDigests: [],
          },
          idempotencyKey: "agent-start-forbidden",
          authorizationRef: "user-instruction:agent-start-forbidden",
          ...field,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      expect(dependencies.workflow.replayAgentStart).not.toHaveBeenCalled();
      expect(dependencies.workflow.requestAgentStart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires no local capability and structurally omits local preflight/report material", async () => {
    const app = Fastify();
    const dependencies = options();
    registerAgentResearchRoutes(app, dependencies);
    try {
      const request = {
        version: 1,
        target: preflight.target,
        question: "What matters?",
        includeShareableContext: true,
        maxIncludedSources: 100,
        parentReportId: null,
        budget,
        captureIntent: { selectedTabIds: [], knownFailures: [] },
        confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      };
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/research/preflight",
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        manifest: [{ originDigest: hash, accessClass: "authenticated" }],
        requiresConfirmation: true,
      });
      expect(response.body).not.toContain("private-canary.example");

      const report = await app.inject({
        method: "GET",
        url: "/api/agent/research/reports/9",
      });
      expect(report.statusCode).toBe(200);
      expect(report.json()).toMatchObject({
        reportText: "# Agent-safe conclusion",
        claims: [{ evidence: [{
          sourceKind: "captured",
          acquisitionMethod: "captured",
          locatorDigest: hash,
          contentDigest: hash,
        }] }],
      });
      for (const canary of ["URL-CANARY", "TITLE_CANARY", "EXCERPT_CANARY", "byteStart"]) {
        expect(report.body).not.toContain(canary);
      }
    } finally {
      await app.close();
    }
  });

  it("fixes strict agent run/cancel inputs and disables writers before dependencies", async () => {
    const app = Fastify();
    const dependencies = options(false);
    registerAgentResearchRoutes(app, dependencies);
    try {
      const start = await app.inject({
        method: "POST",
        url: "/api/agent/research/start",
        payload: {},
      });
      expect(start.statusCode).toBe(409);
      expect(start.json()).toEqual({ error: "FEATURE_DISABLED", feature: "research" });
      expect(dependencies.workflow.replayAgentStart).not.toHaveBeenCalled();
      expect(dependencies.workflow.requestAgentStart).not.toHaveBeenCalled();
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/agent/research/runs",
        payload: {
          version: 1,
          target: preflight.target,
          question: "What matters?",
          includeShareableContext: true,
          maxIncludedSources: 100,
          parentReportId: null,
          budget,
          estimate: preflight.estimate,
          captureIntent: { selectedTabIds: [], knownFailures: [] },
          confirmedOrigins: { authenticatedOriginDigests: [hash], sensitiveOriginDigests: [] },
          approvalFingerprint: hash,
          idempotencyKey: "agent-run",
          authorizationRef: "user-approval",
          actor: "agent",
        },
      });
      expect(forbidden.statusCode).toBe(409);
      expect(dependencies.workflow.requestAgentRun).not.toHaveBeenCalled();
      const cancel = await app.inject({
        method: "POST",
        url: "/api/agent/ai/jobs/resource_research:15/cancel",
        payload: { idempotencyKey: "cancel", authorizationRef: "user-approval" },
      });
      expect(cancel.statusCode).toBe(409);
      expect(dependencies.workflow.cancelAgent).not.toHaveBeenCalled();
      const readable = await app.inject({
        method: "GET",
        url: "/api/agent/research/reports/9",
      });
      expect(readable.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
