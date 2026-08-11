import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  planAddressedLibraryPhysicalClose,
  planLibraryPhysicalClose,
} from "../src/library-physical-actions";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

function tab(instanceId: number, overrides: Partial<TabInstance> = {}): TabInstance {
  const url = "https://example.com/exact";
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: SESSION_ID,
    browserTabId: 100 + instanceId,
    canonicalTabId: 1,
    discarded: false,
    duplicateGroupSize: 3,
    faviconUrl: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    importance: 0,
    index: instanceId,
    installationId: INSTALLATION_ID,
    instanceId,
    lastAccessed: instanceId * 1_000,
    lastSeenAt: "2026-08-11T00:00:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: `Tab ${instanceId}`,
    url,
    urlNormalized: url,
    windowId: 1,
    ...overrides,
  };
}

describe("Library physical close planning", () => {
  it("keeps one exact physical copy when every copy was selected", () => {
    const oldest = tab(1, { lastAccessed: 1_000 });
    const newest = tab(2, { active: true, lastAccessed: 3_000 });
    const middle = tab(3, { lastAccessed: 2_000 });
    const selection = new Map([
      [oldest.instanceId, oldest],
      [newest.instanceId, newest],
      [middle.instanceId, middle],
    ]);

    const plan = planLibraryPhysicalClose(selection, [oldest, newest, middle]);

    expect([...plan.selection.keys()]).toEqual([1, 3]);
    expect(plan.protectedSelectedCount).toBe(1);
    expect([...plan.keepers.entries()]).toEqual([
      [1, { expectedUrl: newest.url, tabId: newest.browserTabId }],
      [3, { expectedUrl: newest.url, tabId: newest.browserTabId }],
    ]);
  });

  it("uses an unselected exact copy as keeper without changing the selection", () => {
    const selected = tab(1, { active: true });
    const unselected = tab(2, { pinned: true });

    const plan = planLibraryPhysicalClose(
      new Map([[selected.instanceId, selected]]),
      [selected, unselected],
    );

    expect([...plan.selection.keys()]).toEqual([selected.instanceId]);
    expect(plan.protectedSelectedCount).toBe(0);
    expect(plan.keepers.get(selected.instanceId)).toEqual({
      expectedUrl: unselected.url,
      tabId: unselected.browserTabId,
    });
  });

  it("never borrows a keeper from another physical browser session", () => {
    const selected = tab(1);
    const staleSessionCopy = tab(2, {
      browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
    });

    const plan = planLibraryPhysicalClose(
      new Map([[selected.instanceId, selected]]),
      [selected, staleSessionCopy],
    );

    expect([...plan.selection.keys()]).toEqual([selected.instanceId]);
    expect(plan.keepers).toEqual(new Map());
    expect(plan.protectedSelectedCount).toBe(0);
  });

  it("partitions an exact selection into independently addressed browser profiles", () => {
    const chrome = tab(1, { url: "https://example.com/chrome" });
    const edge = tab(2, {
      browser: "edge",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
      url: "https://example.com/edge",
    });
    const scopes = [chrome, edge].map(
      ({ browser, browserSessionId, installationId }) => ({
        browser,
        browserSessionId: browserSessionId!,
        installationId,
      }),
    );

    const plan = planAddressedLibraryPhysicalClose(
      new Map([
        [chrome.instanceId, chrome],
        [edge.instanceId, edge],
      ]),
      [chrome, edge],
      scopes,
    );

    expect(plan.closeableCount).toBe(2);
    expect(plan.blockedSelectedCount).toBe(0);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.map(({ targets }) => targets[0]?.tabId)).toEqual([
      chrome.browserTabId,
      edge.browserTabId,
    ]);
  });

  it("keeps an exact physical copy inside every addressed profile batch", () => {
    const chromeKeeper = tab(1, { active: true });
    const chromeCandidate = tab(2);
    const edgeKeeper = tab(3, {
      active: true,
      browser: "edge",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
      url: "https://example.com/edge-exact",
    });
    const edgeCandidate = tab(4, {
      browser: "edge",
      browserSessionId: edgeKeeper.browserSessionId,
      installationId: edgeKeeper.installationId,
      url: edgeKeeper.url,
    });
    const snapshot = [
      chromeKeeper,
      chromeCandidate,
      edgeKeeper,
      edgeCandidate,
    ];
    const plan = planAddressedLibraryPhysicalClose(
      new Map([
        [chromeCandidate.instanceId, chromeCandidate],
        [edgeCandidate.instanceId, edgeCandidate],
      ]),
      snapshot,
      [chromeKeeper, edgeKeeper].map(
        ({ browser, browserSessionId, installationId }) => ({
          browser,
          browserSessionId: browserSessionId!,
          installationId,
        }),
      ),
    );

    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]?.targets[0]?.keeper).toEqual({
      expectedUrl: chromeKeeper.url,
      tabId: chromeKeeper.browserTabId,
    });
    expect(plan.batches[1]?.targets[0]?.keeper).toEqual({
      expectedUrl: edgeKeeper.url,
      tabId: edgeKeeper.browserTabId,
    });
  });

  it("excludes an offline profile without merging it into a connected batch", () => {
    const connected = tab(1, { url: "https://example.com/connected" });
    const offline = tab(2, {
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
      url: "https://example.com/offline",
    });

    const plan = planAddressedLibraryPhysicalClose(
      new Map([
        [connected.instanceId, connected],
        [offline.instanceId, offline],
      ]),
      [connected, offline],
      [
        {
          browser: connected.browser,
          browserSessionId: connected.browserSessionId!,
          installationId: connected.installationId,
        },
      ],
    );

    expect(plan.closeableCount).toBe(1);
    expect(plan.blockedSelectedCount).toBe(1);
    expect(plan.batches).toHaveLength(1);
  });
});
