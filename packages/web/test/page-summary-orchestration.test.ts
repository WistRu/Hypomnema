import type {
  ExactInstanceCaptureReceipt,
  SummaryEnqueueResponse,
  SummaryJob,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  bindCaptureReceipt,
  bindSummaryEnqueue,
  inspectSummaryJob,
  type CaptureSummaryOperation,
} from "../src/page-summary-orchestration";

const operation: CaptureSummaryOperation = {
  depth: "deep",
  operationId: 4,
  tabId: 7,
};

function receipt(
  overrides: Partial<ExactInstanceCaptureReceipt> = {},
): ExactInstanceCaptureReceipt {
  return {
    browserTabId: 41,
    canonicalTabId: 7,
    capturedUrl: "https://example.com/article",
    contentRevision: 9,
    extractedAt: "2026-08-13T12:01:00.000Z",
    firstSeenAt: "2026-08-13T12:00:00.000Z",
    instanceId: 11,
    instanceRevision: 3,
    logicalPageId: 17,
    ...overrides,
  };
}

function enqueue(
  overrides: Partial<SummaryEnqueueResponse> = {},
): SummaryEnqueueResponse {
  return {
    jobId: 31,
    sourceContentRevision: 9,
    status: "queued",
    ...overrides,
  };
}

function job(overrides: Partial<SummaryJob> = {}): SummaryJob {
  return {
    attempts: 1,
    completedAt: null,
    contentRevisionMatches: true,
    createdAt: "2026-08-13T12:01:01.000Z",
    currentContentRevision: 9,
    depth: "deep",
    error: null,
    id: 31,
    maxAttempts: 3,
    nextAttemptAt: null,
    result: null,
    sourceContentRevision: 9,
    startedAt: null,
    status: "queued",
    tabId: 7,
    ...overrides,
  };
}

describe("page summary capture orchestration", () => {
  it("binds an exact capture receipt and enqueue response to one immutable operation", () => {
    const captured = bindCaptureReceipt(operation, receipt());
    expect(captured).toEqual({
      kind: "bound",
      anchor: {
        depth: "deep",
        operationId: 4,
        sourceContentRevision: 9,
        tabId: 7,
      },
    });
    if (captured.kind !== "bound") throw new Error("expected bound capture");

    expect(bindSummaryEnqueue(captured.anchor, enqueue())).toEqual({
      kind: "bound",
      anchor: {
        depth: "deep",
        jobId: 31,
        operationId: 4,
        sourceContentRevision: 9,
        tabId: 7,
      },
    });
  });

  it("rejects a receipt for another canonical page before any summary can be queued", () => {
    expect(bindCaptureReceipt(operation, receipt({ canonicalTabId: 8 }))).toEqual({
      kind: "mismatch",
      reason: "capture-tab",
    });
  });

  it("rejects missing or divergent enqueue revisions", () => {
    const captured = bindCaptureReceipt(operation, receipt());
    if (captured.kind !== "bound") throw new Error("expected bound capture");

    expect(
      bindSummaryEnqueue(captured.anchor, enqueue({ sourceContentRevision: undefined })),
    ).toEqual({ kind: "mismatch", reason: "enqueue-revision" });
    expect(
      bindSummaryEnqueue(captured.anchor, enqueue({ sourceContentRevision: 10 })),
    ).toEqual({ kind: "mismatch", reason: "enqueue-revision" });
  });

  it("accepts only the anchored job id, tab, depth, and source revision", () => {
    const captured = bindCaptureReceipt(operation, receipt());
    if (captured.kind !== "bound") throw new Error("expected bound capture");
    const queued = bindSummaryEnqueue(captured.anchor, enqueue());
    if (queued.kind !== "bound") throw new Error("expected bound enqueue");

    expect(inspectSummaryJob(queued.anchor, job({ id: 32 }))).toEqual({
      kind: "mismatch",
      reason: "job-id",
    });
    expect(inspectSummaryJob(queued.anchor, job({ tabId: 8 }))).toEqual({
      kind: "mismatch",
      reason: "job-tab",
    });
    expect(inspectSummaryJob(queued.anchor, job({ depth: "short" }))).toEqual({
      kind: "mismatch",
      reason: "job-depth",
    });
    expect(
      inspectSummaryJob(queued.anchor, job({ sourceContentRevision: undefined })),
    ).toEqual({ kind: "mismatch", reason: "job-source-revision" });
    expect(
      inspectSummaryJob(queued.anchor, job({ sourceContentRevision: 10 })),
    ).toEqual({ kind: "mismatch", reason: "job-source-revision" });
  });

  it("never exposes a null, mismatched, or stale succeeded result", () => {
    const captured = bindCaptureReceipt(operation, receipt());
    if (captured.kind !== "bound") throw new Error("expected bound capture");
    const queued = bindSummaryEnqueue(captured.anchor, enqueue());
    if (queued.kind !== "bound") throw new Error("expected bound enqueue");

    expect(inspectSummaryJob(queued.anchor, job({ status: "succeeded" }))).toEqual({
      kind: "mismatch",
      reason: "job-current-result",
    });
    expect(
      inspectSummaryJob(
        queued.anchor,
        job({
          completedAt: "2026-08-13T12:02:00.000Z",
          contentRevisionMatches: false,
          currentContentRevision: 10,
          result: { model: "test", summary: "stale", usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 } },
          status: "succeeded",
        }),
      ),
    ).toEqual({ kind: "stale" });
    expect(
      inspectSummaryJob(
        queued.anchor,
        job({
          completedAt: "2026-08-13T12:02:00.000Z",
          result: { model: "test", summary: "current", usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 } },
          status: "succeeded",
        }),
      ),
    ).toEqual({
      kind: "current",
      result: { model: "test", summary: "current", usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 } },
    });
  });
});
