import { describe, expect, it } from "vitest";

import {
  liveAcquisitionBudgetExhaustedSchema,
  liveAcquisitionEffectivePolicy,
  liveAcquisitionExactTabFallbackReasonSchema,
  liveAcquisitionStatusActionsSchema,
  liveAcquisitionPreflightSchema,
  liveAcquisitionPreflightRequestSchema,
  liveAcquisitionStartRequestSchema,
} from "./live-acquisition-contracts.js";
import { estimateResearchReservationV1 } from "./research-contracts.js";

const research = {
  version: 1 as const,
  target: { type: "resource" as const, resourceId: 7 },
  question: "What changed?",
  includeShareableContext: true,
  maxIncludedSources: 10,
  parentReportId: null,
  budget: { maxSteps: 100, maxTokens: 10_000, maxCostUsd: 1, maxWallTimeMs: 420_000 },
  captureIntent: { selectedTabIds: [3], knownFailures: [] },
  confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
};

const preflight = {
  version: 1 as const,
  research,
  approvedOrigins: ["https://example.com"],
  limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
};

describe("live acquisition contracts", () => {
  it("accepts only a strict Resource preflight with canonical public HTTPS origins", () => {
    expect(liveAcquisitionPreflightRequestSchema.parse(preflight)).toEqual(preflight);
    expect(liveAcquisitionPreflightRequestSchema.safeParse({
      ...preflight,
      research: { ...research, target: { type: "page", logicalPageId: 7 } },
    }).success).toBe(false);
    expect(liveAcquisitionPreflightRequestSchema.safeParse({
      ...preflight,
      approvedOrigins: ["http://example.com"],
    }).success).toBe(false);
    expect(liveAcquisitionPreflightRequestSchema.safeParse({
      ...preflight,
      extra: true,
    }).success).toBe(false);
  });

  it("enforces consent bounds and an immutable idempotent start envelope", () => {
    for (const limits of [
      { ...preflight.limits, maxPages: 0 },
      { ...preflight.limits, maxPages: 51 },
      { ...preflight.limits, maxDepth: 4 },
      { ...preflight.limits, durationMs: 29_999 },
      { ...preflight.limits, durationMs: 900_001 },
      { ...preflight.limits, maxCostUsd: 0 },
      { ...preflight.limits, maxCostUsd: 2.01 },
    ]) {
      expect(liveAcquisitionPreflightRequestSchema.safeParse({ ...preflight, limits }).success)
        .toBe(false);
    }

    const start = {
      version: 1 as const,
      preflight,
      approvalFingerprint: "a".repeat(64),
      researchApprovalFingerprint: "b".repeat(64),
      idempotencyKey: "live-resource-7",
    };
    expect(liveAcquisitionStartRequestSchema.parse(start)).toEqual(start);
    expect(liveAcquisitionStartRequestSchema.safeParse({
      ...start,
      preflight: { ...preflight, approvedOrigins: ["https://example.com/"] },
    }).success).toBe(false);
    expect(liveAcquisitionStartRequestSchema.safeParse({ ...start, idempotencyKey: " x " }).success)
      .toBe(false);
  });

  it("makes the daily-start UTC reset boundary explicit in every preflight", () => {
    const response = {
      version: 1 as const,
      target: research.target,
      approvedOrigins: preflight.approvedOrigins,
      limits: preflight.limits,
      researchApprovalFingerprint: "a".repeat(64),
      approvalFingerprint: "b".repeat(64),
      expiresAt: "2026-08-15T09:05:00.000Z",
      provider: {
        provider: "anthropic",
        model: "test",
        promptVersion: "p1",
        pricingVersion: "price1",
        maxOutputTokens: 8_192,
      },
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
          questionBytes: 0, budget: research.budget,
        }) },
    };
    expect(liveAcquisitionPreflightSchema.parse(response)).toEqual(response);
    expect(liveAcquisitionPreflightSchema.safeParse({ ...response,
      capturedCorpus: { ...response.capturedCorpus, privatePayload: "forbidden" } }).success)
      .toBe(false);
    const { dailyStartsResetAt: _omitted, ...withoutReset } = response;
    expect(liveAcquisitionPreflightSchema.safeParse(withoutReset).success).toBe(false);
  });

  it("limits exact-tab fallback to the frozen actionable outcome set", () => {
    expect(liveAcquisitionExactTabFallbackReasonSchema.parse("CHALLENGE_PAGE"))
      .toBe("CHALLENGE_PAGE");
    for (const forbidden of ["CANCELLED", "BUDGET_EXHAUSTED", "LIVE_ACQUISITION_DISABLED",
      "CONSENT_EXPIRED_IN_FLIGHT", "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
      "RUNTIME_RESTARTED_BEFORE_REQUEST"]) {
      expect(liveAcquisitionExactTabFallbackReasonSchema.safeParse(forbidden).success).toBe(false);
    }
  });

  it("admits the exact 1000-page plus 16-robots action bound", () => {
    const action = { id: 1, kind: "page" as const, depth: 0, state: "planned" as const,
      latestOutcome: null, createdAt: "2026-08-15T09:00:00.000Z", terminalAt: null,
      exactUrl: "https://example.com/", origin: "https://example.com", redacted: false,
      usability: "pending" as const, sourceUsable: null, omissionReason: null, fallback: null,
      capture: null, finalInclusion: null };
    expect(liveAcquisitionStatusActionsSchema.safeParse(
      Array.from({ length: 1_016 }, (_, index) => ({ ...action, id: index + 1 }))).success)
      .toBe(true);
    expect(liveAcquisitionStatusActionsSchema.safeParse(
      Array.from({ length: 1_017 }, (_, index) => ({ ...action, id: index + 1 }))).success)
      .toBe(false);
  });

  it("projects immutable effective server policy and the closed network-action cap", () => {
    expect(liveAcquisitionEffectivePolicy(10, 3)).toMatchObject({
      egress: "local_tabhub_server", method: "GET", sendsCookies: false,
      sendsCredentials: false, followsRedirects: false, robotsRequired: true,
      maxNetworkActions: 13,
    });
    expect(() => liveAcquisitionEffectivePolicy(50, 17)).toThrow();
  });

  it("freezes the exact daily-attempt exhaustion response", () => {
    const response = {
      error: "JOB_BUDGET_EXHAUSTED" as const,
      dailyStartsRemaining: 0 as const,
      dailyStartsResetAt: "2026-08-16T00:00:00.000Z",
    };
    expect(liveAcquisitionBudgetExhaustedSchema.parse(response)).toEqual(response);
    expect(liveAcquisitionBudgetExhaustedSchema.safeParse({
      ...response,
      dailyStartsRemaining: 1,
    }).success).toBe(false);
    expect(liveAcquisitionBudgetExhaustedSchema.safeParse({ ...response, extra: true }).success)
      .toBe(false);
  });
});
