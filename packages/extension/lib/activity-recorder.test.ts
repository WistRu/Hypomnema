import { describe, expect, it, vi } from "vitest";

import { createActivityRecorder } from "./activity-recorder";

const scope = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};

describe("activity recorder", () => {
  it("restores a checkpoint and persists the next interval with one retry-safe ID", async () => {
    const persist = vi.fn(async () => undefined);
    const recorder = createActivityRecorder({
      load: async () => ({
        ...scope,
        sequence: 7,
        tracker: {
          engagedUntil: 70_000,
          lastObservedAt: 10_000,
          machineActive: true,
          target: {
            browserTabId: 42,
            url: "https://example.com/article",
          },
        },
      }),
      persist,
      randomUUID: () => "323e4567-e89b-42d3-a456-426614174000",
    });

    await recorder.observe(scope, {
      at: 20_000,
      machineActive: true,
      target: {
        browserTabId: 42,
        url: "https://example.com/article",
      },
    });

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, sequence: 8 }),
      expect.objectContaining({
        id: "323e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
        browserTabId: 42,
        sequence: 8,
        foregroundMs: 10_000,
        engagedMs: 10_000,
      }),
    );
  });

  it("keeps the stream sequence when the configured browser label changes", async () => {
    const persist = vi.fn(async () => undefined);
    const recorder = createActivityRecorder({
      load: async () => ({
        ...scope,
        sequence: 7,
        tracker: {
          engagedUntil: 0,
          lastObservedAt: 10_000,
          machineActive: true,
          target: {
            browserTabId: 42,
            url: "https://example.com/article",
          },
        },
      }),
      persist,
      randomUUID: () => "423e4567-e89b-42d3-a456-426614174000",
    });
    const relabelledScope = { ...scope, browser: "edge" as const };

    await recorder.observe(relabelledScope, {
      at: 20_000,
      machineActive: true,
      target: {
        browserTabId: 42,
        url: "https://example.com/article",
      },
    });
    await recorder.observe(relabelledScope, {
      at: 30_000,
      machineActive: true,
      target: {
        browserTabId: 42,
        url: "https://example.com/article",
      },
    });

    expect(persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...relabelledScope, sequence: 8 }),
      expect.objectContaining({ browser: "edge", sequence: 8 }),
    );
  });
});
