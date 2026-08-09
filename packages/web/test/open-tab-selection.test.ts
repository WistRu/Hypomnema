import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  closePreviewTargetsForSelection,
  extraExactCopyCandidates,
  extraExactCopyPlan,
  reconcileSelectionWithSnapshot,
  removeSucceededPhysicalTabs,
  tabsFromHostname,
  tabsInPhysicalOrder,
  tabsOlderThan,
  workspaceSelectionsForTabs,
} from "../src/open-tab-selection";

function tab(
  instanceId: number,
  url: string,
  options: Partial<TabInstance> = {},
): TabInstance {
  return {
    instanceId,
    canonicalTabId: instanceId,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    browserTabId: instanceId,
    url,
    urlNormalized: url,
    title: `Tab ${instanceId}`,
    browser: "chrome",
    windowId: 1,
    index: instanceId,
    faviconUrl: null,
    active: false,
    audible: false,
    discarded: false,
    muted: false,
    pinned: false,
    lastAccessed: instanceId * 100,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 1,
    ...options,
  };
}

describe("open-tab smart selection", () => {
  it("preserves all 2,001 selected physical occurrences for workspace saving", () => {
    const selected = Array.from({ length: 2_001 }, (_, index) =>
      tab(index + 1, `https://example.com/tab/${index + 1}`),
    );

    const selections = workspaceSelectionsForTabs(selected);

    expect(selections).toHaveLength(2_001);
    expect(selections.at(-1)).toMatchObject({
      browserTabId: 2_001,
      instanceId: 2_001,
    });
  });

  it("can select active copies after retaining pinned or newest keeper", () => {
    const exact = "https://example.com/watch?v=exact";
    const active = tab(1, exact, { active: true, lastAccessed: 10 });
    const pinned = tab(2, exact, { pinned: true, lastAccessed: 20 });
    const ordinary = tab(3, exact, { lastAccessed: 30 });
    const secondUrlNewest = tab(4, "https://example.com/other", { lastAccessed: 50 });
    const secondUrlOlder = tab(5, "https://example.com/other", { lastAccessed: 40 });

    expect(
      extraExactCopyCandidates([
        ordinary,
        pinned,
        active,
        secondUrlOlder,
        secondUrlNewest,
      ]).map(({ instanceId }) => instanceId),
    ).toEqual([1, 3, 5]);

    expect(
      extraExactCopyPlan([
        ordinary,
        pinned,
        active,
        secondUrlOlder,
        secondUrlNewest,
      ]).map(({ candidate, keeper }) => [candidate.instanceId, keeper.instanceId]),
    ).toEqual([
      [1, 2],
      [3, 2],
      [5, 4],
    ]);
  });

  it("does not group URL variants or copies from another installation", () => {
    const first = tab(1, "https://youtube.com/watch?v=one");
    const variant = tab(2, "https://youtube.com/watch?v=two");
    const anotherInstall = tab(3, first.url, {
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    });

    expect(extraExactCopyCandidates([first, variant, anotherInstall])).toEqual([]);
  });

  it("keeps the exact-copy keeper attached to the destructive close target", () => {
    const candidate = tab(1, "https://example.com/exact");
    expect(
      closePreviewTargetsForSelection(
        [
          {
            tab: candidate,
            target: {
              browser: candidate.browser,
              browserSessionId: candidate.browserSessionId,
              installationId: candidate.installationId,
              tabId: 101,
            },
          },
        ],
        new Map([
          [
            candidate.instanceId,
            { expectedUrl: candidate.url, tabId: 102 },
          ],
        ]),
      ),
    ).toEqual([
      {
        expectedUrl: candidate.url,
        keeper: { expectedUrl: candidate.url, tabId: 102 },
        tabId: 101,
      },
    ]);
  });

  it("removes only successfully closed tabs in the current physical scope", () => {
    const current = tab(1, "https://example.com/current", {
      browserTabId: 42,
    });
    const otherInstall = tab(2, "https://example.com/other", {
      browserTabId: 42,
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    });
    const selection = new Map([
      [current.instanceId, current],
      [otherInstall.instanceId, otherInstall],
    ]);

    expect(
      [...removeSucceededPhysicalTabs(selection, current, [42]).keys()],
    ).toEqual([otherInstall.instanceId]);
  });

  it("reconciles selected rows with a fresh unfiltered physical snapshot", () => {
    const stale = tab(1, "https://example.com/current", {
      index: 8,
      muted: false,
      windowId: 9,
    });
    const disappeared = tab(2, "https://example.com/closed");
    const fresh = { ...stale, index: 1, muted: true, windowId: 3 };

    const reconciled = reconcileSelectionWithSnapshot(
      new Map([
        [stale.instanceId, stale],
        [disappeared.instanceId, disappeared],
      ]),
      [fresh, tab(3, "https://example.com/not-selected")],
    );

    expect([...reconciled.values()]).toEqual([fresh]);
  });

  it("selects inactive unpinned tabs with known old access time", () => {
    const now = Date.UTC(2026, 7, 9);
    const old = tab(1, "https://old.example", {
      lastAccessed: now - 31 * 86_400_000,
    });
    const unknown = tab(2, "https://unknown.example", { lastAccessed: null });
    const protectedOld = tab(3, "https://pinned.example", {
      lastAccessed: now - 31 * 86_400_000,
      pinned: true,
    });

    expect(tabsOlderThan([old, unknown, protectedOld], 30, now)).toEqual([old]);
  });

  it("matches a hostname exactly without expanding to www or subdomains", () => {
    const bare = tab(1, "https://example.com/one");
    const www = tab(2, "https://www.example.com/two");
    const subdomain = tab(3, "https://docs.example.com/three");

    expect(tabsFromHostname([bare, www, subdomain], "WWW.EXAMPLE.COM")).toEqual([
      www,
    ]);
  });

  it("orders workspace tabs by their original browser window and position", () => {
    const laterWindow = tab(1, "https://example.com/later", {
      index: 0,
      windowId: 9,
    });
    const second = tab(2, "https://example.com/second", {
      index: 4,
      windowId: 3,
    });
    const first = tab(3, "https://example.com/first", {
      index: 1,
      windowId: 3,
    });

    expect(
      tabsInPhysicalOrder([laterWindow, second, first]).map(
        ({ instanceId }) => instanceId,
      ),
    ).toEqual([3, 2, 1]);
  });
});
