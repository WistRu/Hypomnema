import type { TabDetailResponse, TabInstance } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { TabDrawer } from "../src/TabDrawer";
import { openConfirmedClosedUrl } from "../src/use-canonical-tab-activation";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tabDetail(isOpen: boolean): TabDetailResponse {
  return {
    id: 17,
    browser: "chrome",
    closedAt: isOpen ? null : "2026-08-09T00:30:00.000Z",
    content: null,
    customFields: {},
    faviconUrl: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    importance: 0,
    index: isOpen ? 2 : null,
    isOpen,
    lastSeenAt: "2026-08-09T00:15:00.000Z",
    links: [],
    engagedTimeMs: 83_000,
    foregroundTimeMs: 754_000,
    openEngagedTimeMs: isOpen ? 17_000 : 0,
    openForegroundTimeMs: isOpen ? 361_000 : 0,
    openInstanceCount: isOpen ? 2 : 0,
    status: "inbox",
    summary: null,
    tagPaths: [],
    tags: [],
    title: "Existing tab",
    url: "https://example.com/existing",
    urlNormalized: "https://example.com/existing",
    windowId: isOpen ? 7 : null,
  };
}

function renderDrawer(
  tab: TabDetailResponse,
  activationError?: string,
  instances: TabInstance[] = [],
  contextEnabled = true,
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["features"], {
    context: contextEnabled,
    logicalImportance: false,
  });
  queryClient.setQueryData(["tab", tab.id], tab);
  queryClient.setQueryData(["links", tab.id], { items: [] });
  queryClient.setQueryData(
    ["tab-instances", { canonicalTabId: tab.id }],
    instances,
  );
  queryClient.setQueryData(["tags"], {
    items: [
      {
        id: 2,
        name: "Работа",
        path: "Работа",
        color: "#3b82f6",
        tabCount: 3,
        children: [
          {
            id: 5,
            name: "ИИ",
            path: "Работа/ИИ",
            color: "#8b5cf6",
            tabCount: 2,
            children: [],
          },
        ],
      },
    ],
  });

  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={queryClient}>
        <TabDrawer
          activationError={activationError}
          tabId={tab.id}
          onBrowserAction={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("tab drawer browser action", () => {
  it("shows current-session activity separately for every open physical copy", () => {
    const common = {
      active: false,
      audible: false,
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      canonicalTabId: 17,
      discarded: false,
      duplicateGroupSize: 2,
      faviconUrl: null,
      firstSeenAt: "2026-08-09T00:00:00.000Z",
      importance: 0 as const,
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      lastAccessed: null,
      lastSeenAt: "2026-08-09T00:15:00.000Z",
      muted: false,
      pinned: false,
      status: "inbox" as const,
      summary: null,
      tagPaths: [],
      url: "https://example.com/existing",
      urlNormalized: "https://example.com/existing",
    };
    const instances: TabInstance[] = [
      {
        ...common,
        browserTabId: 101,
        engagedTimeMs: 12_000,
        foregroundTimeMs: 61_000,
        index: 2,
        instanceId: 1,
        title: "First copy",
        windowId: 7,
      },
      {
        ...common,
        browserTabId: 202,
        engagedTimeMs: 5_000,
        foregroundTimeMs: 300_000,
        index: 4,
        instanceId: 2,
        title: "Second copy",
        windowId: 8,
      },
    ];

    const markup = renderDrawer(tabDetail(true), undefined, instances);

    expect(markup).toContain("Open copies");
    expect(markup).toContain("2 open copies");
    expect(markup).toContain("First copy");
    expect(markup).toContain("Window 7 | position 3 | tab 101");
    expect(markup).toContain("1m 1s");
    expect(markup).toContain("12s");
    expect(markup).toContain("Second copy");
    expect(markup).toContain("Window 8 | position 5 | tab 202");
    expect(markup).toContain("5m");
    expect(markup).toContain("5s");
    expect(markup.match(/Only this open tab/g)).toHaveLength(2);
    expect(markup).toContain(
      'aria-label="Use exact context for First copy in Chrome, window 7, tab 101"',
    );
    expect(markup).toContain(
      'aria-label="Use exact context for Second copy in Chrome, window 8, tab 202"',
    );
  });

  it("hides exact-context copy actions when personal context is disabled", () => {
    const common = {
      active: false,
      audible: false,
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      browserTabId: 101,
      canonicalTabId: 17,
      discarded: false,
      duplicateGroupSize: 1,
      engagedTimeMs: 0,
      faviconUrl: null,
      firstSeenAt: "2026-08-09T00:00:00.000Z",
      foregroundTimeMs: 0,
      importance: 0 as const,
      index: 2,
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      instanceId: 1,
      lastAccessed: null,
      lastSeenAt: "2026-08-09T00:15:00.000Z",
      muted: false,
      pinned: false,
      status: "inbox" as const,
      summary: null,
      tagPaths: [],
      title: "First copy",
      url: "https://example.com/existing",
      urlNormalized: "https://example.com/existing",
      windowId: 7,
    } satisfies TabInstance;

    const markup = renderDrawer(tabDetail(true), undefined, [common], false);

    expect(markup).not.toContain("Only this open tab");
    expect(markup).not.toContain("Use exact context for First copy");
  });

  it("shows lifetime page activity even when no physical copy is open", () => {
    const markup = renderDrawer(tabDetail(false));

    expect(markup).toContain("Page activity");
    expect(markup).toContain("12m 34s");
    expect(markup).toContain("1m 23s");
    expect(markup).toContain("No open copies in the current browser session.");
    expect(markup).not.toContain(">0s<");
  });

  it("offers existing topics when assigning the tab", () => {
    const markup = renderDrawer(tabDetail(true));

    expect(markup).toContain('<option value="Работа"></option>');
    expect(markup).toContain('<option value="Работа/ИИ"></option>');
  });

  it("shows the default topic without a removal action", () => {
    const tab = tabDetail(true);
    tab.tags = [
      {
        id: 6,
        name: "Без темы",
        path: "Без темы",
        color: "#64748b",
        assignedBy: "agent",
      },
    ];
    tab.tagPaths = ["Без темы"];

    const markup = renderDrawer(tab);

    expect(markup).toContain("No topic");
    expect(markup).not.toContain("Remove Без темы");
  });

  it("switches to an already-open tab instead of linking to a new copy", () => {
    const markup = renderDrawer(tabDetail(true));

    expect(markup).toContain(">Switch to open tab</button>");
    expect(markup).not.toContain('target="_blank"');
  });

  it("does not fall back to a URL link when the open copy is unreachable", () => {
    const markup = renderDrawer(
      tabDetail(true),
      "This tab's browser profile is not connected.",
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("browser profile is not connected");
    expect(markup).not.toContain('href="https://example.com/existing"');
  });

  it("requires click-time confirmation before opening a closed record URL", () => {
    const markup = renderDrawer(tabDetail(false));

    expect(markup).toContain(">Open in browser</button>");
    expect(markup).not.toContain('target="_blank"');
    expect(markup).not.toContain('href="https://example.com/existing"');
    expect(markup).not.toContain("Switch to open tab");
  });
});

describe("confirmed-closed URL opening", () => {
  it("reports a popup block instead of silently succeeding", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });

    expect(() =>
      openConfirmedClosedUrl("https://example.com/confirmed-closed"),
    ).toThrow("The tab is closed, but the browser blocked opening it");
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  });

  it("severs the opener before navigating a confirmed-closed tab", () => {
    const replace = vi.fn();
    const opened = { location: { replace }, opener: {} };
    vi.stubGlobal("window", { open: vi.fn(() => opened) });

    openConfirmedClosedUrl("https://example.com/confirmed-closed");

    expect(opened.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith(
      "https://example.com/confirmed-closed",
    );
  });
});
