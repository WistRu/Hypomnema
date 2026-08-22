import { describe, expect, it } from "vitest";
import { estimateResearchReservationV1, liveAcquisitionEffectivePolicy,
  type LiveAcquisitionRunStatus } from "@tabhub/shared";

import { canonicalizeLiveAcquisitionOrigins, createLiveAcquisitionConsentDraft,
  createExactTabFallbackRequest, createLiveAcquisitionStartRequest,
  describeLiveAcquisitionFallback,
  isLiveAcquisitionConsentCurrent, liveAcquisitionPersistenceKeys,
  persistActiveLiveAcquisition, persistActivePrivacyPurge,
  persistLiveAcquisitionReviewSummary, projectLiveAcquisitionOutcomes,
  readActiveLiveAcquisition, readActivePrivacyPurge, readLiveAcquisitionReviewSummary } from
  "../src/live-acquisition-model.js";

const research = { version: 1 as const, target: { type: "resource" as const, resourceId: 7 },
  question: "Why?", includeShareableContext: false, maxIncludedSources: 10,
  parentReportId: null, budget: { maxSteps: 100, maxTokens: 20_000, maxCostUsd: 1,
    maxWallTimeMs: 420_000 }, captureIntent: { selectedTabIds: [3], knownFailures: [] },
  confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] } };
const request = { version: 1 as const, research,
  approvedOrigins: ["https://a.example", "https://b.example"],
  limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 } };
const estimate = estimateResearchReservationV1({ includedSources: 0, includedSourceBytes: 0,
  snapshotBytes: 0, questionBytes: 0, budget: research.budget });
const preflight = { version: 1 as const, target: research.target,
  approvedOrigins: request.approvedOrigins, limits: request.limits,
  researchApprovalFingerprint: "a".repeat(64), approvalFingerprint: "b".repeat(64),
  expiresAt: "2099-08-21T12:05:00.000Z", provider: { provider: "p", model: "m",
    promptVersion: "v1", pricingVersion: "v1", maxOutputTokens: 8192 }, rulesetVersion: 1,
  rulesetGenerationDigest: "c".repeat(64), resourceGenerationDigest: "d".repeat(64),
  dailyStartsRemaining: 20, dailyStartsResetAt: "2026-08-22T00:00:00.000Z",
  effectivePolicy: liveAcquisitionEffectivePolicy(10, 2), capturedCorpus: {
    corpusFingerprint: "e".repeat(64), coverage: { discovered: 0, captured: 0, eligible: 0,
      used: 0, missing: 0, failed: 0 }, manifest: [], snapshots: [], estimate } };

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("live acquisition web model", () => {
  it("canonicalizes, deduplicates, and UTF-8 sorts only server-compatible origins", () => {
    expect(canonicalizeLiveAcquisitionOrigins(["https://b.example", "https://a.example"]))
      .toEqual(["https://a.example", "https://b.example"]);
    for (const invalid of [[], ["https://a.example", "https://a.example"],
      ["https://Example.com"], ["https://example.com/"], ["https://example.com/path"],
      ["http://example.com"], ["https://user@example.com"], ["https://localhost"]]) {
      expect(() => canonicalizeLiveAcquisitionOrigins(invalid)).toThrow();
    }
  });

  it("keeps immutable consent tied to all returned server fingerprints and invalidates stale data", () => {
    const draft = createLiveAcquisitionConsentDraft(request, preflight);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.preflight.capturedCorpus)).toBe(true);
    expect(draft.preflight.effectivePolicy).toEqual(preflight.effectivePolicy);
    expect(createLiveAcquisitionStartRequest(draft, "live-start-1")).toMatchObject({
      approvalFingerprint: preflight.approvalFingerprint,
      researchApprovalFingerprint: preflight.researchApprovalFingerprint,
    });
    expect(isLiveAcquisitionConsentCurrent(draft, preflight,
      new Date("2099-08-21T12:04:59.999Z"))).toBe(true);
    expect(isLiveAcquisitionConsentCurrent(draft, { ...preflight, capturedCorpus: {
      ...preflight.capturedCorpus, corpusFingerprint: "f".repeat(64) } },
    new Date("2099-08-21T12:00:00.000Z"))).toBe(false);
    expect(isLiveAcquisitionConsentCurrent(draft, preflight,
      new Date("2099-08-21T12:05:00.000Z"))).toBe(false);
  });

  it("keeps acquisition outcome separate from final-report outcome and never hides fallback", () => {
    const status = ({ acquisitionOutcome: "mixed",
      final: { status: "succeeded", reportId: 42 } } as LiveAcquisitionRunStatus);
    expect(projectLiveAcquisitionOutcomes(status)).toEqual({ acquisition: "mixed",
      finalReport: { state: "published", reportId: 42 } });
    expect(describeLiveAcquisitionFallback({ recommendedKind: "exact_tab_capture",
      reason: "CHALLENGE_PAGE" })).toEqual({ kind: "exact_tab_capture",
      reason: "CHALLENGE_PAGE", category: "access_barrier",
      label: "liveFallback.CHALLENGE_PAGE" });
    expect(describeLiveAcquisitionFallback(null)).toBeNull();
  });

  it("binds exact-tab fallback to one non-redacted page action and fails closed otherwise", () => {
    const action = {
      id: 31, kind: "page", exactUrl: "https://example.com/private", origin: "https://example.com",
      redacted: false, fallback: { recommendedKind: "exact_tab_capture", reason: "AUTH_REQUIRED" },
    } as LiveAcquisitionRunStatus["actions"][number];
    expect(createExactTabFallbackRequest({ jobId: "resource_research:9",
      resourceId: 7, action })).toEqual({ version: 1, jobId: "resource_research:9",
      resourceId: 7, actionId: 31, exactUrl: "https://example.com/private",
      origin: "https://example.com", reason: "AUTH_REQUIRED" });
    expect(createExactTabFallbackRequest({ jobId: "resource_research:9", resourceId: 7,
      action: { ...action, exactUrl: null } })).toBeNull();
    expect(createExactTabFallbackRequest({ jobId: "resource_research:9", resourceId: 7,
      action: { ...action, redacted: true } })).toBeNull();
    expect(createExactTabFallbackRequest({ jobId: "resource_research:9", resourceId: 7,
      action: { ...action, kind: "robots" } })).toBeNull();
  });

  it("persists only stable non-sensitive active references and fails closed on extra fields", () => {
    const storage = new MemoryStorage();
    const purgeId = `purge_${"f".repeat(64)}`;
    persistActiveLiveAcquisition(storage, { jobId: "resource_research:9", resourceId: 7 });
    persistActivePrivacyPurge(storage, { purgeId, idempotencyKey: "purge-7" });
    expect(readActiveLiveAcquisition(storage)).toEqual({ jobId: "resource_research:9",
      resourceId: 7 });
    expect(readActivePrivacyPurge(storage)).toEqual({ purgeId, idempotencyKey: "purge-7" });
    const serialized = [...storage.values.values()].join("\n");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("body");
    storage.setItem(liveAcquisitionPersistenceKeys.activeJob,
      JSON.stringify({ jobId: "resource_research:9", resourceId: 7, url: "https://secret" }));
    expect(readActiveLiveAcquisition(storage)).toBeNull();
  });

  it("restores only a versioned target-bound safe review summary and expires it fail-closed", () => {
    const storage = new MemoryStorage();
    persistLiveAcquisitionReviewSummary(storage, 7, { ...preflight, provider: {
      ...preflight.provider, provider: "https://secret.example",
    } });
    const serialized = storage.getItem(liveAcquisitionPersistenceKeys.reviewSummary)!;
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("corpusFingerprint");
    expect(serialized).not.toContain("logicalPageId");
    expect(serialized).not.toContain("snapshot");
    expect(readLiveAcquisitionReviewSummary(storage, 7,
      new Date("2099-08-21T12:04:59.999Z"))).toMatchObject({
        version: 1, resourceId: 7, dailyStartsRemaining: 20,
        capturedCorpus: { coverage: preflight.capturedCorpus.coverage,
          estimate: preflight.capturedCorpus.estimate },
      });
    expect(readLiveAcquisitionReviewSummary(storage, 8,
      new Date("2099-08-21T12:00:00.000Z"))).toBeNull();
    expect(readLiveAcquisitionReviewSummary(storage, 7,
      new Date("2099-08-21T12:05:00.000Z"))).toBeNull();
    expect(storage.getItem(liveAcquisitionPersistenceKeys.reviewSummary)).toBeNull();

    storage.setItem(liveAcquisitionPersistenceKeys.reviewSummary,
      JSON.stringify({ version: 1, resourceId: 7, expiresAt: preflight.expiresAt,
        approvedOrigins: ["https://secret.example"] }));
    expect(readLiveAcquisitionReviewSummary(storage, 7,
      new Date("2099-08-21T12:00:00.000Z"))).toBeNull();
    expect(storage.getItem(liveAcquisitionPersistenceKeys.reviewSummary)).toBeNull();
  });
});
