import { describe, expect, it } from "vitest";

import { createActivityTracker } from "./activity-tracker";

describe("tab activity tracker", () => {
  it("separates foreground time from time after a recent interaction", () => {
    const tracker = createActivityTracker();
    const target = {
      browserTabId: 42,
      url: "https://example.com/article",
    };

    expect(
      tracker.observe({ at: 0, machineActive: true, target }),
    ).toBeUndefined();

    expect(
      tracker.observe({
        at: 10_000,
        interaction: true,
        machineActive: true,
        target,
      }),
    ).toEqual({
      browserTabId: 42,
      engagedMs: 0,
      endedAt: 10_000,
      foregroundMs: 10_000,
      startedAt: 0,
      url: "https://example.com/article",
    });

    expect(
      tracker.observe({ at: 20_000, machineActive: true, target }),
    ).toEqual({
      browserTabId: 42,
      engagedMs: 10_000,
      endedAt: 20_000,
      foregroundMs: 10_000,
      startedAt: 10_000,
      url: "https://example.com/article",
    });
  });

  it("resumes the current interval after an MV3 worker restart", () => {
    const target = {
      browserTabId: 42,
      url: "https://example.com/article",
    };
    const firstWorker = createActivityTracker();
    firstWorker.observe({ at: 0, machineActive: true, target });
    firstWorker.observe({
      at: 10_000,
      interaction: true,
      machineActive: true,
      target,
    });

    const nextWorker = createActivityTracker(firstWorker.checkpoint());

    expect(
      nextWorker.observe({ at: 20_000, machineActive: true, target }),
    ).toMatchObject({
      browserTabId: 42,
      engagedMs: 10_000,
      foregroundMs: 10_000,
    });
  });

  it("attributes a tab switch to the old tab and starts the new tab disengaged", () => {
    const first = {
      browserTabId: 42,
      url: "https://example.com/first",
    };
    const second = {
      browserTabId: 43,
      url: "https://example.com/second",
    };
    const tracker = createActivityTracker();
    tracker.observe({
      at: 0,
      interaction: true,
      machineActive: true,
      target: first,
    });

    expect(
      tracker.observe({ at: 10_000, machineActive: true, target: second }),
    ).toMatchObject({
      browserTabId: 42,
      engagedMs: 10_000,
      foregroundMs: 10_000,
    });
    expect(
      tracker.observe({ at: 20_000, machineActive: true, target: second }),
    ).toMatchObject({
      browserTabId: 43,
      engagedMs: 0,
      foregroundMs: 10_000,
    });
  });

  it("credits no time across a delayed observation gap", () => {
    const target = {
      browserTabId: 42,
      url: "https://example.com/article",
    };
    const tracker = createActivityTracker();
    tracker.observe({ at: 0, machineActive: true, target });

    expect(
      tracker.observe({ at: 3_600_000, machineActive: true, target }),
    ).toBeUndefined();
    expect(
      tracker.observe({ at: 3_610_000, machineActive: true, target }),
    ).toMatchObject({
      foregroundMs: 10_000,
      startedAt: 3_600_000,
    });
  });
});
