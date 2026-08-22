import type {
  ResearchRefineApprovalRequest,
  ResearchReportDetail,
  ResearchReportListResponse,
} from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchResearchReport,
  fetchResearchReports,
  resetLocalSessionBootstrapForTests,
  submitResearchRefinement,
} from "../src/api";

const timestamp = "2026-08-14T10:00:00.000Z";
const fingerprint = "a".repeat(64);
const target = { type: "page" as const, logicalPageId: 7 };
const coverage = {
  discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0,
};

function listResponse(): ResearchReportListResponse {
  return {
    target,
    head: {
      latestPublishedReportId: 9,
      currentFreshReportId: 9,
      lastSuccessfulReportId: 9,
    },
    latestRun: {
      runId: 4,
      jobId: "resource_research:4",
      status: "succeeded",
      parentReportId: null,
      reportId: 9,
      createdAt: timestamp,
    },
    items: [{
      id: 9,
      runId: 4,
      jobId: "resource_research:4",
      version: 3,
      parentReportId: null,
      publishStatus: "succeeded",
      state: "fresh",
      reason: null,
      coverage,
      createdAt: timestamp,
      executiveSummary: "Useful source",
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: true,
        isLastSuccessful: true,
      },
    }],
    nextBeforeVersion: 3,
  };
}

function reportDetail(): ResearchReportDetail {
  return {
    id: 9,
    runId: 4,
    jobId: "resource_research:4",
    runStatus: "succeeded",
    target,
    version: 3,
    parentReportId: null,
    publishStatus: "succeeded",
    state: "fresh",
    reason: null,
    coverage,
    createdAt: timestamp,
    headFlags: {
      isLatestPublished: true,
      isCurrentFresh: true,
      isLastSuccessful: true,
    },
    dossier: {
      executiveSummary: "Useful source",
      valueForUser: "Helps evaluate the project",
      capabilities: ["Search"],
      limitations: ["Captured corpus only"],
      risks: ["May become stale"],
      unknowns: ["Pricing"],
      nextSteps: ["Compare alternatives"],
    },
    reportText: "# Report\n\nPlain text only.",
    provenance: {
      provider: "test",
      model: "test-model",
      promptVersion: "research:v1",
      pricingVersion: "test:1",
      requestId: "request-1",
      generatedAt: timestamp,
      usage: { steps: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.01, wallTimeMs: 100 },
      inputFingerprint: "c".repeat(64),
      terminalAttemptId: 1,
    },
    claims: [{
      id: 1,
      ordinal: 1,
      claimDigest: "d".repeat(64),
      claimText: "The page supports search.",
      confidence: 0.9,
      isInference: false,
      rationaleDigest: null,
      rationale: null,
      evidence: [{
        id: 1,
        ordinal: 1,
        kind: "tab_content",
        sourceId: 1,
        sourceKind: "captured",
        acquisitionMethod: "captured",
        contentRevision: 2,
        contentDigest: "e".repeat(64),
        state: "valid",
        stateReason: null,
        locatorDigest: "f".repeat(64),
        locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 10 },
        excerptHash: "1".repeat(64),
        excerpt: "Search UI",
        url: "https://example.test/search",
        title: "Example",
      }],
    }],
  };
}

const approval: ResearchRefineApprovalRequest = {
  version: 1,
  target,
  question: "What changed?",
  includeShareableContext: true,
  maxIncludedSources: 10,
  budget: { maxSteps: 4, maxTokens: 20_000, maxCostUsd: 1, maxWallTimeMs: 120_000 },
  estimate: {
    estimateVersion: "research_estimate:v1",
    estimateKind: "reservation_envelope",
    calls: 1,
    inputTokens: 100,
    outputTokens: 100,
    costUsd: 0.1,
    wallTimeMs: 10_000,
  },
  captureIntent: { selectedTabIds: [], knownFailures: [] },
  confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
  approvalFingerprint: fingerprint,
  idempotencyKey: "refine:stable",
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  resetLocalSessionBootstrapForTests();
  vi.unstubAllGlobals();
});

describe("research history REST client", () => {
  it("validates paginated list, exact detail identity, and parent-bound refine body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(listResponse()))
      .mockResolvedValueOnce(response(reportDetail()))
      .mockResolvedValueOnce(response({
        id: "resource_research:5", kind: "resource_research", status: "queued",
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResearchReports(target, { limit: 25, beforeVersion: 4 }))
      .resolves.toEqual(listResponse());
    await expect(fetchResearchReport(9, target)).resolves.toEqual(reportDetail());
    await expect(submitResearchRefinement(9, target, approval))
      .resolves.toMatchObject({ id: "resource_research:5" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/local/session/bootstrap",
      "/api/research/reports?targetType=page&targetId=7&limit=25&beforeVersion=4",
      "/api/research/reports/9",
      "/api/research/reports/9/refine",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3]![1]!.body as string)).toEqual(approval);
    expect(JSON.parse(fetchMock.mock.calls[3]![1]!.body as string)).not.toHaveProperty("parentReportId");
  });

  it("rejects mismatched list/detail identities and invalid pagination before fetch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ ...listResponse(), target: { type: "page", logicalPageId: 8 } }))
      .mockResolvedValueOnce(response({ ...reportDetail(), id: 10 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResearchReports(target, { limit: 25 }))
      .rejects.toThrow("mismatched research report history");
    await expect(fetchResearchReport(9, target))
      .rejects.toThrow("mismatched research report detail");
    await expect(fetchResearchReports(target, { limit: 101 }))
      .rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
