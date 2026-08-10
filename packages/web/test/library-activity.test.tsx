// @vitest-environment jsdom

import type { TabListResponse, TagTreeResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
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
    isActivating: () => false,
    run: vi.fn(),
  }),
}));

vi.mock("../src/use-single-tab-close", () => ({
  useSingleTabClose: () => ({
    busy: false,
    closeCanonical: vi.fn(),
    errorForCanonical: () => undefined,
    isClosingCanonical: () => false,
  }),
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
  it("shows combined current-copy activity without presenting closed tabs as zero time", () => {
    class ResizeObserverStub {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
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
      name: "Open-tab activity",
    })).toBeTruthy();
    const trackedRow = within(rendered.container).getByText("Tracked tab").closest("tr");
    if (!trackedRow) throw new Error("Missing tracked Library row");
    expect(within(trackedRow).getByText("On screen")).toBeTruthy();
    expect(within(trackedRow).getByText("1m 1s")).toBeTruthy();
    expect(within(trackedRow).getByText("Active use")).toBeTruthy();
    expect(within(trackedRow).getByText("12s")).toBeTruthy();
    expect(within(trackedRow).getByText("1 open copy")).toBeTruthy();
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
    expect(within(closedRow).getByText("No open copies")).toBeTruthy();
    expect(within(closedRow).queryByText("0s")).toBeNull();
    queryClient.clear();
  });
});
