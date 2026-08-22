import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  researchReportDetailSchema,
  researchReportListResponseSchema,
  type ResearchReportDetail,
  type ResearchReportListQuery,
  type ResearchReportListResponse,
} from "@tabhub/shared";

import type { LocalCapabilityService } from "../src/local-capability.js";
import {
  registerResearchRoutes,
  type ResearchRouteReportCatalog,
} from "../src/research-routes.js";

const authenticatedHeaders = { authorization: "Bearer local-test" };
const timestamp = "2026-08-14T10:00:00.000Z";
const fingerprint = "a".repeat(64);
const contentDigest = "b".repeat(64);
const excerptHash = "c".repeat(64);

function localCapabilities(): LocalCapabilityService {
  return {
    authenticate(request) {
      return request.headers.authorization === "Bearer local-test"
        ? { kind: "web" as const, installationId: null }
        : null;
    },
  } as LocalCapabilityService;
}

function validListResponse(): ResearchReportListResponse {
  return researchReportListResponseSchema.parse({
    target: { type: "page", logicalPageId: 41 },
    head: {
      latestPublishedReportId: 9,
      currentFreshReportId: 9,
      lastSuccessfulReportId: 9,
    },
    latestRun: {
      runId: 12,
      jobId: "resource_research:15",
      status: "succeeded",
      parentReportId: null,
      reportId: 9,
      createdAt: timestamp,
    },
    items: [{
      id: 9,
      runId: 12,
      jobId: "resource_research:15",
      version: 1,
      parentReportId: null,
      publishStatus: "succeeded",
      reason: null,
      state: "fresh",
      coverage: {
        discovered: 1,
        captured: 1,
        eligible: 1,
        used: 1,
        missing: 0,
        failed: 0,
      },
      createdAt: timestamp,
      executiveSummary: "A concise resource assessment.",
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: true,
        isLastSuccessful: true,
      },
    }],
    nextBeforeVersion: null,
  });
}

function validDetail(): ResearchReportDetail {
  return researchReportDetailSchema.parse({
    id: 9,
    runId: 12,
    jobId: "resource_research:15",
    runStatus: "succeeded",
    target: { type: "page", logicalPageId: 41 },
    version: 1,
    parentReportId: null,
    publishStatus: "succeeded",
    reason: null,
    state: "fresh",
    coverage: {
      discovered: 1,
      captured: 1,
      eligible: 1,
      used: 1,
      missing: 0,
      failed: 0,
    },
    createdAt: timestamp,
    headFlags: {
      isLatestPublished: true,
      isCurrentFresh: true,
      isLastSuccessful: true,
    },
    dossier: {
      executiveSummary: "A concise resource assessment.",
      valueForUser: "It supports the active project decision.",
      capabilities: ["Explains the relevant workflow."],
      limitations: ["Only the captured page was assessed."],
      risks: ["The source can change after capture."],
      unknowns: ["Long-term maintenance is not established."],
      nextSteps: ["Compare the finding with the project requirements."],
    },
    reportText: "# Resource assessment\n\nA concise resource assessment.",
    provenance: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "resource-research:v1",
      pricingVersion: "test-pricing:v1",
      requestId: "request-123",
      generatedAt: timestamp,
      inputFingerprint: fingerprint,
      terminalAttemptId: 18,
      usage: {
        steps: 1,
        inputTokens: 120,
        outputTokens: 80,
        costUsd: 0.01,
        wallTimeMs: 400,
      },
    },
    claims: [{
      id: 21,
      ordinal: 1,
      claimDigest: fingerprint,
      claimText: "The resource explains the relevant workflow.",
      confidence: 0.9,
      isInference: false,
      rationaleDigest: null,
      rationale: null,
      evidence: [{
        id: 31,
        ordinal: 1,
        kind: "tab_content",
        sourceId: 7,
        sourceKind: "captured",
        acquisitionMethod: "captured",
        contentRevision: 3,
        contentDigest,
        state: "valid",
        stateReason: null,
        locatorDigest: fingerprint,
        locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 6 },
        excerptHash,
        excerpt: "Source",
        url: "https://example.test/resource",
        title: "Example resource",
      }],
    }],
  });
}

function createHarness(options: {
  readonly researchEnabled?: boolean;
  readonly list?: (query: ResearchReportListQuery) => unknown;
  readonly get?: (reportId: number) => unknown;
  readonly addUnexpectedParam?: boolean;
} = {}) {
  const app = Fastify({ logger: false });
  if (options.addUnexpectedParam === true) {
    app.addHook("preHandler", async (request) => {
      if (request.url === "/api/research/reports/9") {
        Object.assign(request.params as object, { unexpected: "rejected" });
      }
    });
  }

  const preflight = vi.fn(() => { throw new Error("read invoked preflight"); });
  const requestRun = vi.fn(() => { throw new Error("read invoked requestRun"); });
  const redact = vi.fn(() => { throw new Error("read invoked redact"); });
  const list = vi.fn((query: ResearchReportListQuery) =>
    options.list === undefined ? validListResponse() : options.list(query));
  const get = vi.fn((reportId: number) =>
    options.get === undefined ? validDetail() : options.get(reportId));
  const wake = vi.fn();
  const reports = { list, get } as ResearchRouteReportCatalog;

  registerResearchRoutes(app, {
    capabilities: localCapabilities(),
    researchEnabled: options.researchEnabled ?? false,
    workflow: { preflight, requestRun, redact },
    reports,
    scheduler: { wake },
  });

  return {
    app,
    reports: { list, get },
    workflow: { preflight, requestRun, redact },
    wake,
  };
}

function expectReadIsolation(harness: ReturnType<typeof createHarness>): void {
  expect(harness.workflow.preflight).not.toHaveBeenCalled();
  expect(harness.workflow.requestRun).not.toHaveBeenCalled();
  expect(harness.workflow.redact).not.toHaveBeenCalled();
  expect(harness.wake).not.toHaveBeenCalled();
}

describe("research report GET routes", () => {
  it("authenticates before malformed input validation or catalog access", async () => {
    const harness = createHarness();
    try {
      const list = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=041&unexpected=secret",
      });
      expect(list.statusCode).toBe(401);
      expect(list.json()).toEqual({
        error: "LOCAL_CAPABILITY_REQUIRED",
        message: "A valid local capability is required",
      });

      const detail = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/09",
      });
      expect(detail.statusCode).toBe(401);
      expect(harness.reports.list).not.toHaveBeenCalled();
      expect(harness.reports.get).not.toHaveBeenCalled();
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("strictly rejects unknown list query keys and malformed detail params", async () => {
    const harness = createHarness();
    try {
      const unknownQuery = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=41&unexpected=1",
        headers: authenticatedHeaders,
      });
      expect(unknownQuery.statusCode).toBe(400);
      expect(unknownQuery.json()).toMatchObject({ error: "VALIDATION_ERROR" });

      const malformedParams = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/9x",
        headers: authenticatedHeaders,
      });
      expect(malformedParams.statusCode).toBe(400);
      expect(malformedParams.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      expect(harness.reports.list).not.toHaveBeenCalled();
      expect(harness.reports.get).not.toHaveBeenCalled();
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("returns exact 400 validation errors for non-canonical decimal query and path values", async () => {
    const harness = createHarness();
    const urls = [
      "/api/research/reports?targetType=page&targetId=041",
      "/api/research/reports?targetType=page&targetId=1e2",
      "/api/research/reports?targetType=page&targetId=%2B41",
      "/api/research/reports?targetType=page&targetId=-41",
      "/api/research/reports?targetType=page&targetId=%2041",
      "/api/research/reports?targetType=page&targetId=41&limit=5.0",
      "/api/research/reports?targetType=page&targetId=41&beforeVersion=08",
      "/api/research/reports?targetType=page&targetId=9007199254740992",
      "/api/research/reports/09",
      "/api/research/reports/1e2",
      "/api/research/reports/%2B9",
      "/api/research/reports/-9",
      "/api/research/reports/%209",
      "/api/research/reports/9.0",
      "/api/research/reports/9007199254740992",
    ];
    try {
      for (const url of urls) {
        const response = await harness.app.inject({
          method: "GET",
          url,
          headers: authenticatedHeaders,
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.json()).toEqual({
          error: "VALIDATION_ERROR",
          issues: expect.any(Array),
        });
      }
      expect(harness.reports.list).not.toHaveBeenCalled();
      expect(harness.reports.get).not.toHaveBeenCalled();
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("strictly rejects unknown detail param keys", async () => {
    const harness = createHarness({ addUnexpectedParam: true });
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/9",
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      expect(harness.reports.get).not.toHaveBeenCalled();
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("keeps valid list and detail reads available while research writes are disabled", async () => {
    const harness = createHarness({ researchEnabled: false });
    try {
      const list = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=41",
        headers: authenticatedHeaders,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual(validListResponse());

      const detail = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/9",
        headers: authenticatedHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(validDetail());
      expect(harness.reports.get).toHaveBeenCalledWith(9);
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("passes the exact parsed list query with pagination defaults and overrides", async () => {
    const harness = createHarness();
    try {
      const defaulted = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=41",
        headers: authenticatedHeaders,
      });
      expect(defaulted.statusCode).toBe(200);
      expect(harness.reports.list).toHaveBeenNthCalledWith(1, {
        targetType: "page",
        targetId: 41,
        limit: 50,
      });

      const explicit = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=41&limit=25&beforeVersion=8",
        headers: authenticatedHeaders,
      });
      expect(explicit.statusCode).toBe(200);
      expect(harness.reports.list).toHaveBeenNthCalledWith(2, {
        targetType: "page",
        targetId: 41,
        limit: 25,
        beforeVersion: 8,
      });
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("returns a stable 404 for a missing report", async () => {
    const harness = createHarness({ get: () => undefined });
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/404",
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "RESEARCH_REPORT_NOT_FOUND" });
      expect(harness.reports.get).toHaveBeenCalledWith(404);
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("maps a missing report target to a stable 404", async () => {
    const harness = createHarness({
      list() {
        throw Object.assign(new Error("secret catalog target"), {
          code: "RESEARCH_TARGET_NOT_FOUND",
        });
      },
    });
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports?targetType=resource&targetId=7",
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "RESEARCH_TARGET_NOT_FOUND" });
      expect(response.body).not.toContain("secret catalog target");
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it.each([
    ["list", "secret corrupt list row"],
    ["detail", "secret corrupt detail row"],
  ] as const)("makes corrupt %s catalog responses opaque", async (kind, secret) => {
    const harness = createHarness(kind === "list"
      ? { list: () => ({ unexpected: secret }) }
      : { get: () => ({ unexpected: secret }) });
    try {
      const response = await harness.app.inject(kind === "list" ? {
        method: "GET",
        url: "/api/research/reports?targetType=page&targetId=41",
        headers: authenticatedHeaders,
      } : {
        method: "GET",
        url: "/api/research/reports/9",
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(response.body).not.toContain(secret);
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });

  it("makes unexpected catalog failures opaque", async () => {
    const secret = "secret database connection details";
    const harness = createHarness({
      get() { throw new Error(secret); },
    });
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/research/reports/9",
        headers: authenticatedHeaders,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
      expect(response.body).not.toContain(secret);
      expectReadIsolation(harness);
    } finally {
      await harness.app.close();
    }
  });
});
