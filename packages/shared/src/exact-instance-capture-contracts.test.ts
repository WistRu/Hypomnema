import { describe, expect, it } from "vitest";

import {
  exactInstanceContentIngestSchema,
  exactCaptureMinProtocolVersion,
  exactSingleCloseMinProtocolVersion,
  hasCurrentSummaryResult,
  summarizeTabSchema,
  supportsExactCapture,
  supportsExactSingleClose,
  tabCommandRelayClientEnvelopeSchema,
  tabCommandRelayCommandSchema,
  tabCommandRelayCompatibleProtocolVersionSchema,
  tabCommandRelayPreviousProtocolVersion,
  tabCommandRelayProtocolVersion,
  tabCommandRelayResultSchema,
  tabInstanceSchema,
} from "./index.js";

const target = {
  instanceId: 17,
  tabId: 42,
  expectedUrl: "https://example.com/article",
  expectedInstanceRevision: 3,
  expectedFirstSeenAt: "2026-08-13T11:00:00.000Z",
} as const;

describe("exact-instance capture contracts", () => {
  it("requires one exact physical target and a navigation precondition", () => {
    expect(tabCommandRelayCommandSchema.parse({
      kind: "capture-tab-content",
      target,
    })).toEqual({ kind: "capture-tab-content", target });

    expect(tabCommandRelayCommandSchema.safeParse({
      kind: "capture-tab-content",
      target: { ...target, instanceId: undefined },
    }).success).toBe(false);
    expect(tabCommandRelayCommandSchema.safeParse({
      kind: "capture-tab-content",
      target: { ...target, expectedInstanceRevision: 0 },
    }).success).toBe(false);
  });

  it("exposes the physical instance revision that becomes the capture precondition", () => {
    const instance = tabInstanceSchema.parse({
      instanceId: 17,
      canonicalTabId: 7,
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      browserTabId: 42,
      instanceRevision: 3,
      url: target.expectedUrl,
      urlNormalized: target.expectedUrl,
      title: "Article",
      browser: "chrome",
      windowId: 1,
      index: 0,
      faviconUrl: null,
      active: true,
      audible: false,
      muted: false,
      discarded: false,
      pinned: false,
      lastAccessed: null,
      firstSeenAt: "2026-08-13T11:00:00.000Z",
      lastSeenAt: "2026-08-13T12:00:00.000Z",
      status: "inbox",
      importance: 0,
      summary: null,
      tagPaths: [],
      duplicateGroupSize: 1,
    });
    expect(instance.instanceRevision).toBe(target.expectedInstanceRevision);
  });

  it("carries a durable content-revision receipt or a typed recoverable failure", () => {
    const receipt = {
      canonicalTabId: 7,
      logicalPageId: 9,
      instanceId: target.instanceId,
      browserTabId: target.tabId,
      capturedUrl: target.expectedUrl,
      instanceRevision: target.expectedInstanceRevision,
      firstSeenAt: target.expectedFirstSeenAt,
      contentRevision: 4,
      extractedAt: "2026-08-13T12:00:00.000Z",
    };

    expect(tabCommandRelayResultSchema.parse({
      kind: "capture-tab-content",
      target,
      outcome: { status: "captured", receipt },
    })).toMatchObject({ outcome: { receipt, status: "captured" } });
    expect(tabCommandRelayResultSchema.parse({
      kind: "capture-tab-content",
      target,
      outcome: {
        status: "failed",
        failure: {
          code: "CAPTURE_TAB_NAVIGATED",
          message: "The selected tab navigated before capture completed.",
          recoverable: true,
          observedUrl: "https://example.com/other",
        },
      },
    })).toMatchObject({
      outcome: { failure: { code: "CAPTURE_TAB_NAVIGATED" } },
    });
  });

  it("requires the ingest payload to identify the same scope and observed document", () => {
    expect(exactInstanceContentIngestSchema.parse({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      commandRequestId: "323e4567-e89b-42d3-a456-426614174000",
      target,
      observedUrl: target.expectedUrl,
      text: "Captured text",
      htmlExcerpt: "<main>Captured text</main>",
    })).toMatchObject({ target, observedUrl: target.expectedUrl });
  });

  it("makes v5 current while retaining v4 and v3 parsing for old commands", () => {
    expect(tabCommandRelayProtocolVersion).toBe(5);
    expect(tabCommandRelayPreviousProtocolVersion).toBe(4);
    expect(tabCommandRelayCompatibleProtocolVersionSchema.safeParse(3).success).toBe(true);
    expect(tabCommandRelayCompatibleProtocolVersionSchema.safeParse(4).success).toBe(true);
    expect(tabCommandRelayCompatibleProtocolVersionSchema.safeParse(5).success).toBe(true);
    expect(tabCommandRelayClientEnvelopeSchema.safeParse({
      version: 4,
      type: "register",
      scope: {
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
      },
    }).success).toBe(false);
  });

  it("publishes semantic protocol capabilities that remain valid for later versions", () => {
    expect(exactSingleCloseMinProtocolVersion).toBe(4);
    expect(exactCaptureMinProtocolVersion).toBe(5);
    expect(supportsExactSingleClose(3)).toBe(false);
    expect(supportsExactSingleClose(4)).toBe(true);
    expect(supportsExactSingleClose(6)).toBe(true);
    expect(supportsExactCapture(4)).toBe(false);
    expect(supportsExactCapture(5)).toBe(true);
    expect(supportsExactCapture(6)).toBe(true);
  });

  it("allows summary requests to bind to an exact captured revision", () => {
    expect(summarizeTabSchema.parse({
      depth: "deep",
      expectedContentRevision: 8,
    })).toEqual({
      depth: "deep",
      expectedContentRevision: 8,
      requestedBy: "user",
    });
    expect(summarizeTabSchema.safeParse({
      depth: "deep",
      expectedContentRevision: 0,
    }).success).toBe(false);
  });

  it("exposes the W71 current-summary display invariant", () => {
    const job = {
      id: 1,
      tabId: 7,
      sourceContentRevision: 2,
      currentContentRevision: 2,
      contentRevisionMatches: true,
      depth: "deep" as const,
      status: "succeeded" as const,
      attempts: 1,
      maxAttempts: 3,
      createdAt: "2026-08-13T12:00:00.000Z",
      startedAt: "2026-08-13T12:00:01.000Z",
      completedAt: "2026-08-13T12:00:02.000Z",
      nextAttemptAt: null,
      error: null,
      result: {
        summary: "Current summary",
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      },
    };
    expect(hasCurrentSummaryResult(job)).toBe(true);
    expect(hasCurrentSummaryResult({ ...job, status: "running" })).toBe(false);
    expect(hasCurrentSummaryResult({
      ...job,
      currentContentRevision: 3,
      contentRevisionMatches: false,
    })).toBe(false);
    expect(hasCurrentSummaryResult({ ...job, result: null })).toBe(false);
  });
});
