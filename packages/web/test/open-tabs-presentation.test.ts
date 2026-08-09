import type { TabInstance } from "@tabhub/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenTabRow } from "../src/OpenTabsView";
import type { TabActivationAvailability } from "../src/open-tab-activation";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

const ready: TabActivationAvailability = {
  kind: "ready",
  target: {
    browser: "chrome",
    browserSessionId: BROWSER_SESSION_ID,
    installationId: INSTALLATION_ID,
    tabId: 101,
  },
};

function youtubeTab(url: string): TabInstance {
  return {
    instanceId: 1,
    canonicalTabId: 1,
    installationId: INSTALLATION_ID,
    browserSessionId: BROWSER_SESSION_ID,
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
        activation: ready,
        tab: youtubeTab(url),
        onActivateTab: vi.fn(),
        onSelectCanonicalTab: vi.fn(),
      }),
    );

    expect(markup).toContain(`>${url}</span>`);
  });

  it("makes switching the primary action and never opens a new copy", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabRow, {
        activation: ready,
        tab: youtubeTab("https://www.youtube.com/watch?v=existing-video"),
        onActivateTab: vi.fn(),
        onSelectCanonicalTab: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-label="Switch to existing tab: A distinct YouTube video"');
    expect(markup).toContain(">Details</button>");
    expect(markup).not.toContain('target="_blank"');
    expect(markup).not.toContain(">Open<");
  });

  it("shows why a row from another installation cannot be switched", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabRow, {
        activation: {
          kind: "other-installation",
          message: "Open TabHub in the browser profile that owns this tab to switch to it.",
        },
        tab: youtubeTab("https://www.youtube.com/watch?v=remote-video"),
        onActivateTab: vi.fn(),
        onSelectCanonicalTab: vi.fn(),
      }),
    );

    expect(markup).not.toContain("Switch to existing tab:");
    expect(markup).toContain("Other installation");
    expect(markup).toContain("browser profile that owns this tab");
  });

  it("disables every switch while another activation is still in progress", () => {
    const markup = renderToStaticMarkup(
      createElement(OpenTabRow, {
        activation: ready,
        activationInProgress: true,
        tab: youtubeTab("https://example.com/second-click"),
        onActivateTab: vi.fn(),
        onSelectCanonicalTab: vi.fn(),
      }),
    );

    expect(markup).toContain(
      'disabled="" title="Switch to this existing browser tab"',
    );
  });
});
