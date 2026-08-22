import type { SummaryJobResult } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import type {
  ClaimedSummaryJob,
  SummaryCatalog,
} from "../src/summary-catalog.js";
import type { SummaryProvider } from "../src/summary-provider.js";
import { createSummaryWorker } from "../src/summary-worker.js";

const claimedJob: ClaimedSummaryJob = {
  id: 1,
  tabId: 10,
  depth: "short",
  attempts: 1,
  maxAttempts: 3,
  attemptId: 100,
  requestedBy: "user",
  requestedModel: "test-model",
  sourceContentRevision: 1,
  title: "Queued page",
  url: "https://example.com/queued",
  text: "Captured page text",
};

describe("summary worker lifecycle", () => {
  it("aborts the active provider wait and claims no more work while stopping", async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const summarize = vi.fn(
      async (_input: Parameters<SummaryProvider["summarize"]>[0]) => {
        releaseStarted();
        return new Promise<SummaryJobResult>(() => undefined);
      },
    );
    const provider: SummaryProvider = {
      modelFor: () => "test-model",
      summarize,
    };
    const claimNext = vi
      .fn<SummaryCatalog["claimNext"]>()
      .mockReturnValueOnce(claimedJob)
      .mockReturnValueOnce({ ...claimedJob, id: 2, attemptId: 101 });
    const fail = vi.fn<SummaryCatalog["fail"]>();
    const catalog: SummaryCatalog = {
      enqueue: vi.fn<SummaryCatalog["enqueue"]>(),
      getJob: vi.fn<SummaryCatalog["getJob"]>(),
      recoverInterrupted: vi.fn<SummaryCatalog["recoverInterrupted"]>(),
      claimNext,
      complete: vi.fn<SummaryCatalog["complete"]>(),
      fail,
    };
    const worker = createSummaryWorker(catalog, provider, {
      dailyLimit: 100,
      baseRetryMs: 1,
      random: () => 0,
    });

    const draining = worker.drainAvailable();
    await started;
    await expect(worker.stop()).resolves.toBeUndefined();

    await expect(draining).resolves.toBe(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(
      claimedJob,
      "Summary worker stopped",
      expect.any(String),
    );
  });
});
