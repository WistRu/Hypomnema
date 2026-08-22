import {
  type DurableJobView,
  type ResearchPreflight,
  type ResearchPreflightRequest,
  type ResearchRunApprovalRequest,
} from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelResearchJob,
  fetchLogicalPageResourceResolution,
  fetchResearchJob,
  fetchResearchLatestRun,
  fetchResourceOpenTabs,
  preflightResearch,
  resetLocalSessionBootstrapForTests,
  submitResearchRun,
} from "../src/api";

const fingerprint = "a".repeat(64);
const target = { type: "page" as const, logicalPageId: 7 };
const budget = { maxSteps: 4, maxTokens: 10_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const estimate = {
  estimateVersion: "research_estimate:v1" as const,
  estimateKind: "reservation_envelope" as const,
  calls: 1,
  inputTokens: 1_000,
  outputTokens: 1_024,
  costUsd: 1,
  wallTimeMs: 60_000,
};
const request: ResearchPreflightRequest = {
  version: 1,
  target,
  question: "What matters here?",
  includeShareableContext: true,
  maxIncludedSources: 10,
  parentReportId: null,
  budget,
  captureIntent: { selectedTabIds: [], knownFailures: [] },
  confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
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

describe("research REST client", () => {
  it("round-trips exact preflight and approval inputs", async () => {
    const preflight: ResearchPreflight = {
      version: 1,
      target,
      approvalFingerprint: fingerprint,
      corpusFingerprint: "b".repeat(64),
      coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
      approvedBudget: budget,
      acquisitionLevel: "captured_only",
      manifest: [{
        ordinal: 1,
        logicalPageId: 7,
        selectedTabId: 17,
        sourceKind: "captured",
        acquisitionMethod: "captured",
        contentRevision: 2,
        contentDigest: "c".repeat(64),
        state: "captured",
        exclusionReason: null,
        exclusionCategory: null,
        accessClass: "public",
        originDigest: "d".repeat(64),
        requiresConfirmation: false,
        failureCode: null,
        capturedChunkManifest: {
          version: "captured_text_chunks:v1", byteStart: 0, byteEnd: 10,
          chunkDigest: "e".repeat(64), truncated: false,
        },
      }],
      snapshots: [],
      confirmationRequirements: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      confirmationDisplay: [],
      estimate,
      requiresConfirmation: false,
      limitations: [],
    };
    const approval: ResearchRunApprovalRequest = {
      ...request,
      estimate,
      approvalFingerprint: fingerprint,
      idempotencyKey: "research:one",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(preflight))
      .mockResolvedValueOnce(response({ id: "resource_research:9", kind: "resource_research", status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightResearch(request)).resolves.toEqual(preflight);
    await expect(submitResearchRun(approval)).resolves.toMatchObject({ id: "resource_research:9" });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual(request);
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual(approval);
  });

  it("parses exact resource resolution without inferring it from a URL", async () => {
    const resolution = {
      logicalPageId: 7,
      candidateResourceIds: [4],
      sourceFingerprint: "resolution:one",
      resolvedAt: "2026-08-14T10:00:00.000Z",
      state: "resolved" as const,
      reason: "system_seed" as const,
      resource: {
        id: 4,
        resourceKey: "platform:youtube",
        name: "YouTube",
        kind: "platform" as const,
        accessClass: "public" as const,
        lifecycleState: "active" as const,
        mergedIntoResourceId: null,
        createdAt: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
      },
      researchEligible: true,
      researchExclusionReason: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(response(resolution));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLogicalPageResourceResolution(7)).resolves.toEqual(resolution);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/logical-pages/7/resource-resolution",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("accepts only normalized local origins whose class and digest exactly bind to requirements", async () => {
    const auth = "2".repeat(64);
    const valid = {
      version: 1,
      target,
      approvalFingerprint: null,
      corpusFingerprint: "b".repeat(64),
      coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
      approvedBudget: budget,
      acquisitionLevel: "captured_only",
      manifest: [],
      snapshots: [],
      confirmationRequirements: { authenticatedOriginDigests: [auth], sensitiveOriginDigests: [] },
      confirmationDisplay: [{
        accessClass: "authenticated",
        originDigest: auth,
        origin: "https://account.example",
      }],
      estimate,
      requiresConfirmation: true,
      limitations: [],
    };
    const wrongBinding = {
      ...valid,
      confirmationDisplay: [{
        accessClass: "sensitive",
        originDigest: auth,
        origin: "https://account.example",
      }],
    };
    const fullUrl = {
      ...valid,
      confirmationDisplay: [{
        accessClass: "authenticated",
        originDigest: auth,
        origin: "https://account.example/private/path?token=hidden",
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(valid))
      .mockResolvedValueOnce(response(wrongBinding))
      .mockResolvedValueOnce(response(fullUrl));
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightResearch(request)).resolves.toEqual(valid);
    await expect(preflightResearch(request)).rejects.toThrow(
      "TabHub returned mismatched research preflight data.",
    );
    await expect(preflightResearch(request)).rejects.toThrow(
      "TabHub returned mismatched research preflight data.",
    );
  });

  it("discovers only latest-run metadata, then reads and cancels the durable job", async () => {
    const job: DurableJobView = {
      id: "resource_research:9", kind: "resource_research",
      subject: target, status: "running", attempts: 1, maxAttempts: 3,
      progress: { completed: 1, total: 3, stage: "provider" }, canCancel: true,
      cancellationRequest: null, createdAt: "2026-08-14T10:00:00.000Z",
      startedAt: "2026-08-14T10:00:01.000Z", completedAt: null,
      nextAttemptAt: null, error: null, result: null,
    };
    const list = {
      target,
      head: { latestPublishedReportId: null, currentFreshReportId: null, lastSuccessfulReportId: null },
      latestRun: {
        runId: 1, jobId: job.id, status: "running", parentReportId: null,
        reportId: null, createdAt: job.createdAt,
      },
      items: [], nextBeforeVersion: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(list))
      .mockResolvedValueOnce(response(job))
      .mockResolvedValueOnce(response({ ...job, canCancel: false, cancellationRequest: {
        requestedBy: "user", requestedAt: "2026-08-14T10:00:02.000Z",
      } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResearchLatestRun(target)).resolves.toEqual(list.latestRun);
    await expect(fetchResearchJob(job.id)).resolves.toEqual(job);
    await expect(cancelResearchJob(job.id)).resolves.toMatchObject({ canCancel: false });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/local/session/bootstrap", "POST"],
      ["/api/research/reports?targetType=page&targetId=7&limit=1", "GET"],
      ["/api/ai/jobs/resource_research%3A9", "GET"],
      ["/api/ai/jobs/resource_research%3A9/cancel", "POST"],
    ]);
  });

  it("loads all open copies for a Resource independently of active Library filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      items: [], total: 0, logicalPageCount: 0,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResourceOpenTabs(7)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tab-instances/bulk?resource_id=7",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});
