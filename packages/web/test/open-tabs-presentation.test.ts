import type { TabInstance } from "@tabhub/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenTabRow } from "../src/OpenTabsView";

function youtubeTab(url: string): TabInstance {
  return {
    instanceId: 1,
    canonicalTabId: 1,
    installationId: "chrome-main",
    browserTabId: 101,
    url,
    urlNormalized: url,
    title: "A distinct YouTube video",
    browser: "chrome",
    windowId: 7,
    index: 2,
    faviconUrl: null,
    active: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 1,
  };
}

describe("open-tab presentation", () => {
  it("renders the exact raw URL instead of only the hostname", () => {
    const url = "https://www.youtube.com/watch?v=second-video";
    const markup = renderToStaticMarkup(
      createElement(OpenTabRow, {
        tab: youtubeTab(url),
        onSelectCanonicalTab: vi.fn(),
      }),
    );

    expect(markup).toContain(`>${url}</span>`);
  });
});
