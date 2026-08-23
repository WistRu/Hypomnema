// @vitest-environment jsdom

import type { TabListResponse, TagTreeResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { unavailableExtensionBridge } from "./support/extension-bridge-stub";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  fetchFeatureFlags: vi.fn(),
  fetchLibraryOpenTabs: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchFeatureFlags: mocks.fetchFeatureFlags,
  fetchLibraryOpenTabs: mocks.fetchLibraryOpenTabs,
  fetchTabs: mocks.fetchTabs,
  fetchTagTree: mocks.fetchTagTree,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 82,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * 82,
        index,
        key: index,
        size: 82,
        start: index * 82,
      })),
    measureElement: () => undefined,
    scrollToOffset: () => undefined,
  }),
}));

vi.mock("../src/OpenTabsView", () => ({
  OpenTabsView: () => <section aria-label="Open tabs" />,
}));

vi.mock("../src/use-canonical-tab-activation", () => ({
  useCanonicalTabActivation: () => ({
    busy: false,
    errorFor: () => undefined,
    errorForPhysical: () => undefined,
    isActivating: () => false,
    isActivatingPhysical: () => false,
    run: vi.fn(),
    runPhysical: vi.fn(),
  }),
}));

vi.mock("../src/use-single-tab-close", () => ({
  useSingleTabClose: () => ({
    busy: false,
    closeCanonical: vi.fn(),
    closePhysical: vi.fn(),
    errorForCanonical: () => undefined,
    errorForPhysical: () => undefined,
    isClosingCanonical: () => false,
    isClosingPhysical: () => false,
  }),
}));
vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => unavailableExtensionBridge(),
}));

const topics: TagTreeResponse = { items: [] };
const tabs: TabListResponse = {
  items: [
    {
      id: 17,
      browser: "chrome",
      closedAt: null,
      faviconUrl: null,
      firstSeenAt: "2026-08-10T00:00:00.000Z",
      importance: 0,
      index: 0,
      isOpen: true,
      lastSeenAt: "2026-08-10T00:01:00.000Z",
      engagedTimeMs: 45_000,
      foregroundTimeMs: 125_000,
      openEngagedTimeMs: 12_000,
      openForegroundTimeMs: 61_000,
      openInstanceCount: 1,
      status: "inbox",
      summary: null,
      tagPaths: [],
      title: "Tracked tab",
      url: "https://example.com/tracked",
      urlNormalized: "https://example.com/tracked",
      windowId: 1,
    },
    {
      id: 18,
      browser: "chrome",
      closedAt: "2026-08-10T00:05:00.000Z",
      faviconUrl: null,
      firstSeenAt: "2026-08-10T00:00:00.000Z",
      importance: 0,
      index: null,
      isOpen: false,
      lastSeenAt: "2026-08-10T00:05:00.000Z",
      engagedTimeMs: 8_000,
      foregroundTimeMs: 33_000,
      openEngagedTimeMs: 0,
      openForegroundTimeMs: 0,
      openInstanceCount: 0,
      status: "inbox",
      summary: null,
      tagPaths: [],
      title: "Closed tab",
      url: "https://example.com/closed",
      urlNormalized: "https://example.com/closed",
      windowId: null,
    },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Library activity", () => {
  it("shows lifetime page activity for open and closed Library rows", () => {
    class ResizeObserverStub {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    mocks.fetchFeatureFlags.mockResolvedValue({
      context: false,
      logicalImportance: false,
    });
    mocks.fetchTabs.mockResolvedValue(tabs);
    mocks.fetchTagTree.mockResolvedValue(topics);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(
      [
        "tabs",
        {
          browser: "all",
          duplicatesOnly: false,
          importance: "all",
          openState: "all",
          page: 1,
          q: "",
          status: "all",
          tag: "",
        },
      ],
      tabs,
    );
    queryClient.setQueryData(
      [
        "tab-instances",
        "library",
        {
          browser: "all",
          duplicatesOnly: false,
          importance: "all",
          openState: "all",
          q: "",
          status: "all",
          tag: "",
        },
      ],
      [
        {
          active: false,
          audible: false,
          browser: "chrome",
          browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
          browserTabId: 17,
          canonicalTabId: 17,
          discarded: false,
          duplicateGroupSize: 1,
          engagedTimeMs: 12_000,
          faviconUrl: null,
          firstSeenAt: "2026-08-10T00:00:00.000Z",
          foregroundTimeMs: 61_000,
          importance: 0,
          index: 0,
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          instanceId: 1,
          lastAccessed: null,
          lastSeenAt: "2026-08-10T00:01:00.000Z",
          muted: false,
          pinned: false,
          status: "inbox",
          summary: null,
          tagPaths: [],
          title: "Tracked tab",
          url: "https://example.com/tracked",
          urlNormalized: "https://example.com/tracked",
          windowId: 1,
        },
      ],
    );
    queryClient.setQueryData(["tags"], topics);

    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(within(rendered.container).getByRole("button", { name: "Library" }));

    expect(within(rendered.container).getByRole("columnheader", {
      name: "Activity",
    })).toBeTruthy();
    const trackedRow = within(rendered.container)
      .getByRole("button", { name: /^Switch to existing tab: Tracked tab \|/ })
      .closest("tr");
    if (!trackedRow) throw new Error("Missing tracked Library row");
    const trackedTabCell = trackedRow.querySelector<HTMLElement>(
      'td[data-column="title"]',
    );
    const trackedActivityCell = trackedRow.querySelector<HTMLElement>(
      'td[data-column="activity"]',
    );
    if (!trackedTabCell || !trackedActivityCell) {
      throw new Error("Missing tracked Library cells");
    }
    expect(within(trackedActivityCell).getByText("On screen")).toBeTruthy();
    expect(within(trackedActivityCell).getByText("2m 5s")).toBeTruthy();
    expect(within(trackedActivityCell).getByText("Active use")).toBeTruthy();
    expect(within(trackedActivityCell).getByText("45s")).toBeTruthy();
    expect(
      within(trackedTabCell).getByRole("button", {
        name: /^Close for Tracked tab \|/,
      }),
    ).toBeTruthy();
    expect(
      within(trackedActivityCell).queryByRole("button", {
        name: /^Close for/,
      }),
    ).toBeNull();
    expect(
      within(trackedRow).getByText("How activity is measured").closest("summary"),
    ).toBeTruthy();
    expect(
      within(trackedRow).getByText(
        "Selected while its browser window was in the foreground and the computer was active.",
      ),
    ).toBeTruthy();

    const closedRow = within(rendered.container).getByText("Closed tab").closest("tr");
    if (!closedRow) throw new Error("Missing closed Library row");
    const closedActivityCell = closedRow.querySelector<HTMLElement>(
      'td[data-column="activity"]',
    );
    if (!closedActivityCell) throw new Error("Missing closed activity cell");
    expect(within(closedActivityCell).getByText("On screen")).toBeTruthy();
    expect(within(closedActivityCell).getByText("33s")).toBeTruthy();
    expect(within(closedActivityCell).getByText("Active use")).toBeTruthy();
    expect(within(closedActivityCell).getByText("8s")).toBeTruthy();
    queryClient.clear();
  });
});
