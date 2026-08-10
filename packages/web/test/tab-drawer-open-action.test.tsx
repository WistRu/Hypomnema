import type { TabDetailResponse } from "@tabhub/shared";
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
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["tab", tab.id], tab);
  queryClient.setQueryData(["links", tab.id], { items: [] });

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
