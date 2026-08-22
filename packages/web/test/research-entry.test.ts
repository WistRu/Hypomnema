import type { TabCommandRelayResult, TabInstance } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  captureResearchCopies,
  createResearchSelectionTarget,
  mapCanonicalTabsToResearchTarget,
  type ResearchCaptureSelection,
} from "../src/research-entry";

const now = "2026-08-14T10:00:00.000Z";

function instance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: true,
    audible: false,
    browser: "chrome",
    browserSessionId: "session-a",
    browserTabId: 41,
    canonicalTabId: 7,
    discarded: false,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: now,
    foregroundTimeMs: 0,
    index: 0,
    installationId: "installation-a",
    instanceId: 71,
    instanceRevision: 3,
    lastSeenAt: now,
    muted: false,
    pinned: false,
    status: "complete",
    title: "Captured page",
    url: "https://example.com/page",
    windowId: 2,
    ...overrides,
  };
}

describe("research entry helpers", () => {
  it("creates a canonical selection target whose fingerprint binds sorted logical pages", async () => {
    const target = await createResearchSelectionTarget([9, 2, 5, 9]);

    expect(target).toEqual({
      type: "selection",
      logicalPageIds: [2, 5, 9],
      fingerprint: "6acd0e582c821ea7ba4aac76ab30424a719ec71df479c421508b30a664d4c570",
    });
  });

  it("rejects empty and oversized selections before creating a fingerprint", async () => {
    await expect(createResearchSelectionTarget([])).rejects.toThrow(
      "Research selection must contain 1..100 logical pages",
    );
    await expect(
      createResearchSelectionTarget(Array.from({ length: 101 }, (_, index) => index + 1)),
    ).rejects.toThrow("Research selection must contain 1..100 logical pages");
  });

  it("maps every physical tab with bounded concurrency before logical-page dedupe and cap", async () => {
    const physicalIds = Array.from({ length: 101 }, (_, index) => index + 1);
    let inFlight = 0;
    let maximumInFlight = 0;
    const seen: number[] = [];
    const target = await mapCanonicalTabsToResearchTarget(physicalIds, async (id) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      seen.push(id);
      inFlight -= 1;
      return 501;
    });

    expect(seen.sort((left, right) => left - right)).toEqual(physicalIds);
    expect(maximumInFlight).toBeLessThanOrEqual(8);
    expect(target).toMatchObject({ type: "selection", logicalPageIds: [501] });
  });

  it("runs one existing exact-capture command per chosen copy and records recoverable failures", async () => {
    const first = instance();
    const second = instance({
      browserTabId: 42,
      canonicalTabId: 8,
      instanceId: 72,
      url: "https://example.org/second",
    });
    const selections: ResearchCaptureSelection[] = [
      {
        logicalPageId: 101,
        copy: {
          kind: "selectable",
          instance: first,
          scope: {
            browser: "chrome",
            browserSessionId: "session-a",
            installationId: "installation-a",
          },
          selectionKey: "first",
          target: {
            expectedFirstSeenAt: now,
            expectedInstanceRevision: 3,
            expectedUrl: first.url,
            instanceId: 71,
            tabId: 41,
          },
        },
      },
      {
        logicalPageId: 102,
        copy: {
          kind: "selectable",
          instance: second,
          scope: {
            browser: "chrome",
            browserSessionId: "session-a",
            installationId: "installation-a",
          },
          selectionKey: "second",
          target: {
            expectedFirstSeenAt: now,
            expectedInstanceRevision: 3,
            expectedUrl: second.url,
            instanceId: 72,
            tabId: 42,
          },
        },
      },
    ];
    const execute = vi.fn(async (request): Promise<TabCommandRelayResult> => {
      expect(request.command.kind).toBe("capture-tab-content");
      if (request.command.kind !== "capture-tab-content") throw new Error("unexpected");
      const captured = request.command.target.tabId === 41;
      return {
        kind: "capture-tab-content",
        target: request.command.target,
        outcome: captured
          ? {
              status: "captured",
              receipt: {
                browserTabId: 41,
                canonicalTabId: 7,
                capturedUrl: first.url,
                contentRevision: 4,
                extractedAt: now,
                firstSeenAt: now,
                instanceId: 71,
                instanceRevision: 3,
              },
            }
          : {
              status: "failed",
              failure: { code: "TAB_NAVIGATED", message: "copy changed" },
            },
      };
    });

    await expect(captureResearchCopies(selections, execute)).resolves.toEqual({
      captureIntent: {
        selectedTabIds: [7, 8],
        knownFailures: [{ logicalPageId: 102, tabId: 8, failureCode: "TAB_NAVIGATED" }],
      },
      outcomes: [
        { logicalPageId: 101, tabId: 7, status: "captured" },
        { failureCode: "TAB_NAVIGATED", logicalPageId: 102, tabId: 8, status: "failed" },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([request]) => request.command.kind === "capture-tab-content"))
      .toBe(true);
  });

  it("rejects duplicate logical pages and oversized capture batches before dispatch", async () => {
    const current = instance();
    const selection: ResearchCaptureSelection = {
      logicalPageId: 101,
      copy: {
        kind: "selectable",
        instance: current,
        scope: { browser: "chrome", browserSessionId: "session-a", installationId: "installation-a" },
        selectionKey: "current",
        target: {
          expectedFirstSeenAt: now, expectedInstanceRevision: 3,
          expectedUrl: current.url, instanceId: 71, tabId: 41,
        },
      },
    };
    const execute = vi.fn();

    await expect(captureResearchCopies([selection, selection], execute)).rejects.toThrow(
      "Research capture requires one exact copy per logical page",
    );
    await expect(
      captureResearchCopies(
        Array.from({ length: 101 }, (_, index) => ({ ...selection, logicalPageId: index + 1 })),
        execute,
      ),
    ).rejects.toThrow("Research capture supports at most 100 logical pages");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["SCOPE_OFFLINE", "TAB_NAVIGATED", "TAB_NOT_FOUND", "EXTENSION_PROTOCOL_UNSUPPORTED"])(
    "surfaces %s as one recoverable per-copy result without retry",
    async (code) => {
      const current = instance();
      const selection: ResearchCaptureSelection = {
        logicalPageId: 101,
        copy: {
          kind: "selectable",
          instance: current,
          scope: { browser: "chrome", browserSessionId: "session-a", installationId: "installation-a" },
          selectionKey: "current",
          target: {
            expectedFirstSeenAt: now, expectedInstanceRevision: 3,
            expectedUrl: current.url, instanceId: 71, tabId: 41,
          },
        },
      };
      const execute = vi.fn().mockRejectedValue(Object.assign(new Error("recoverable"), { code }));

      await expect(captureResearchCopies([selection], execute)).resolves.toMatchObject({
        outcomes: [{ logicalPageId: 101, tabId: 7, status: "failed", failureCode: code }],
        captureIntent: {
          selectedTabIds: [7],
          knownFailures: [{ logicalPageId: 101, tabId: 7, failureCode: code }],
        },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});
