import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateResearchReservationV1, liveAcquisitionEffectivePolicy } from "@tabhub/shared";

import { ApiRequestError, fetchLiveAcquisitionStatus, fetchPrivacyPurgeStatus,
  preflightLiveAcquisition, resetLocalSessionBootstrapForTests, retryPrivacyPurge,
  startLiveAcquisition, startPrivacyPurge } from "../src/api.js";

const fingerprint = "a".repeat(64);
const research = { version: 1 as const, target: { type: "resource" as const, resourceId: 7 },
  question: "Research this resource", includeShareableContext: false, maxIncludedSources: 10,
  parentReportId: null, budget: { maxSteps: 100, maxTokens: 20_000, maxCostUsd: 1,
    maxWallTimeMs: 420_000 }, captureIntent: { selectedTabIds: [3], knownFailures: [] },
  confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] } };
const request = { version: 1 as const, research, approvedOrigins: ["https://example.com"],
  limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 } };
const estimate = estimateResearchReservationV1({ includedSources: 0, includedSourceBytes: 0,
  snapshotBytes: 0, questionBytes: 0, budget: research.budget });
const preflight = { version: 1 as const, target: research.target,
  approvedOrigins: request.approvedOrigins, limits: request.limits,
  researchApprovalFingerprint: fingerprint, approvalFingerprint: "b".repeat(64),
  expiresAt: "2026-08-21T12:05:00.000Z", provider: { provider: "p", model: "m",
    promptVersion: "v1", pricingVersion: "v1", maxOutputTokens: 8192 }, rulesetVersion: 1,
  rulesetGenerationDigest: "c".repeat(64), resourceGenerationDigest: "d".repeat(64),
  dailyStartsRemaining: 20, dailyStartsResetAt: "2026-08-22T00:00:00.000Z",
  effectivePolicy: liveAcquisitionEffectivePolicy(10, 1), capturedCorpus: {
    corpusFingerprint: "e".repeat(64), coverage: { discovered: 0, captured: 0, eligible: 0,
      used: 0, missing: 0, failed: 0 }, manifest: [], snapshots: [], estimate } };
const jobStatus = { version: 1 as const, jobId: "resource_research:9", target: research.target,
  coordinator: { runId: 9, status: "queued" as const }, final: null,
  consent: { state: "active" as const, createdAt: "2026-08-21T12:00:00.000Z",
    expiresAt: "2026-08-21T12:05:00.000Z", terminalAt: null,
    approvedOrigins: request.approvedOrigins, limits: { maxPages: 10, maxDepth: 1,
      durationMs: 300_000, maxCostUsd: 1, maxOrigins: 1, maxOutputTokens: 8192 },
    effectivePolicy: liveAcquisitionEffectivePolicy(10, 1) }, runLiveSuccess: null,
  workflowOutcome: null, workflowOutcomeCode: null, acquisitionOutcome: "running" as const,
  counters: { reservedPages: 0, visitedPages: 0, capturedPages: 0, blockedPages: 0,
    ambiguousPages: 0, robotsActions: 0, networkActions: 0, plannedActions: 0,
    activeActions: 0 }, actions: [] };
const purgeId = `purge_${"f".repeat(64)}`;
const purge = { version: 1 as const, purgeId,
  target: { kind: "resource_history" as const, resourceId: 7 }, state: "waiting" as const,
  progress: { completedSteps: 0, totalSteps: 3 }, holdReason: null, canRetry: false,
  timestamps: { createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z", completedAt: null }, result: null };

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => { resetLocalSessionBootstrapForTests(); vi.unstubAllGlobals(); });

describe("live acquisition and privacy purge REST clients", () => {
  it("uses local auth bootstrap, exact paths/bodies, status codes, and abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(preflight))
      .mockResolvedValueOnce(response({ id: "resource_research:9", kind: "resource_research",
        status: "queued" }, 202)).mockResolvedValueOnce(response(jobStatus))
      .mockResolvedValueOnce(response(purge, 202)).mockResolvedValueOnce(response(purge))
      .mockResolvedValueOnce(response(purge, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(preflightLiveAcquisition(request, signal)).resolves.toEqual(preflight);
    await expect(startLiveAcquisition({ version: 1, preflight: request,
      approvalFingerprint: preflight.approvalFingerprint,
      researchApprovalFingerprint: preflight.researchApprovalFingerprint,
      idempotencyKey: "live-1" }, signal)).resolves.toMatchObject({ id: "resource_research:9" });
    await expect(fetchLiveAcquisitionStatus("resource_research:9", signal)).resolves.toEqual(jobStatus);
    await expect(startPrivacyPurge({ version: 1, idempotencyKey: "purge-1",
      target: purge.target }, signal)).resolves.toEqual(purge);
    await expect(fetchPrivacyPurgeStatus(purgeId, signal)).resolves.toEqual(purge);
    await expect(retryPrivacyPurge(purgeId, signal)).resolves.toEqual(purge);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/local/session/bootstrap", "POST"], ["/api/research/live/preflight", "POST"],
      ["/api/research/live/runs", "POST"],
      ["/api/research/live/runs/resource_research%3A9", "GET"],
      ["/api/privacy/purges", "POST"], [`/api/privacy/purges/${purgeId}`, "GET"],
      [`/api/privacy/purges/${purgeId}/retry`, "POST"],
    ]);
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.signal === signal)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual(request);
  });

  it("preserves typed daily exhaustion and stable server error codes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ error: "JOB_BUDGET_EXHAUSTED", dailyStartsRemaining: 0,
        dailyStartsResetAt: "2026-08-22T00:00:00.000Z" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const error = await preflightLiveAcquisition(request).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: "JOB_BUDGET_EXHAUSTED", status: 429,
      liveAcquisitionBudget: { dailyStartsRemaining: 0,
        dailyStartsResetAt: "2026-08-22T00:00:00.000Z" } });

    resetLocalSessionBootstrapForTests();
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(
      response({ error: "FEATURE_DISABLED", feature: "liveAcquisition" }, 409));
    const disabled = await preflightLiveAcquisition(request).catch((value: unknown) => value);
    expect(disabled).toMatchObject({ code: "FEATURE_DISABLED", status: 409 });
  });

  it("fails closed on malformed or mismatched successful payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ ...preflight, approvedOrigins: ["https://other.example"] }))
      .mockResolvedValueOnce(response({ ...jobStatus, jobId: "resource_research:10" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(preflightLiveAcquisition(request)).rejects.toThrow("mismatched");
    await expect(fetchLiveAcquisitionStatus("resource_research:9")).rejects.toThrow("mismatched");
  });
});
