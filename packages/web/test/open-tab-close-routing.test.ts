import type { TabCommandScope, TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { addressedCloseSelection } from "../src/open-tab-close-routing";

const scope: TabCommandScope = {
  browser: "yandex",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const url = "https://example.com/exact";

function tab(instanceId: number, overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    instanceId,
    canonicalTabId: instanceId,
    installationId: scope.installationId,
    browserSessionId: scope.browserSessionId,
    browserTabId: instanceId + 100,
    url,
    urlNormalized: url,
    title: `Tab ${instanceId}`,
    browser: scope.browser,
    windowId: 1,
    index: instanceId,
    faviconUrl: null,
    active: false,
    audible: false,
    muted: false,
    discarded: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: "medium",
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 3,
    ...overrides,
  };
}

describe("addressed close selection", () => {
  it("routes one selected duplicate group to its owning live extension", () => {
    const selected = new Map([
      [2, tab(2)],
      [3, tab(3)],
    ]);
    const keepers = new Map([
      [2, { expectedUrl: url, tabId: 101 }],
      [3, { expectedUrl: url, tabId: 101 }],
    ]);

    expect(addressedCloseSelection(selected, keepers, [scope])).toEqual({
      scope,
      targets: [
        {
          expectedUrl: url,
          keeper: { expectedUrl: url, tabId: 101 },
          tabId: 102,
        },
        {
          expectedUrl: url,
          keeper: { expectedUrl: url, tabId: 101 },
          tabId: 103,
        },
      ],
    });
  });

  it("fails closed for mixed sessions, offline owners, or a selected keeper", () => {
    const candidate = tab(2);
    const otherSession = tab(3, {
      browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
    });
    expect(
      addressedCloseSelection(
        new Map([
          [2, candidate],
          [3, otherSession],
        ]),
        new Map(),
        [scope],
      ),
    ).toBeNull();
    expect(
      addressedCloseSelection(new Map([[2, candidate]]), new Map(), []),
    ).toBeNull();
    expect(
      addressedCloseSelection(
        new Map([
          [1, tab(1)],
          [2, candidate],
        ]),
        new Map([[2, { expectedUrl: url, tabId: 101 }]]),
        [scope],
      ),
    ).toBeNull();
  });
});
