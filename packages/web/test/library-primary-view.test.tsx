// @vitest-environment jsdom

import type {
  TabInstance,
  TabListResponse,
  TagTreeResponse,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  closePhysical: vi.fn(),
  fetchLibraryOpenTabs: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
  runPhysical: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
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
  OpenTabsView: () => <section aria-label="Legacy open tabs" />,
}));

vi.mock("../src/use-canonical-tab-activation", () => ({
  useCanonicalTabActivation: () => ({
    busy: false,
    errorFor: () => undefined,
    errorForPhysical: () => undefined,
    isActivating: () => false,
    isActivatingPhysical: () => false,
    run: vi.fn(),
    runPhysical: mocks.runPhysical,
  }),
}));

vi.mock("../src/use-single-tab-close", () => ({
  useSingleTabClose: () => ({
    busy: false,
    closeCanonical: vi.fn(),
    closePhysical: mocks.closePhysical,
    errorForCanonical: () => undefined,
    errorForPhysical: () => undefined,
    isClosingCanonical: () => false,
    isClosingPhysical: () => false,
  }),
}));

const emptyTabs: TabListResponse = {
  items: [],
  page: 1,
  pageSize: 50,
  total: 0,
};
const emptyTopics: TagTreeResponse = { items: [] };
const installationId = "123e4567-e89b-42d3-a456-426614174000";
const browserSessionId = "223e4567-e89b-42d3-a456-426614174000";

function physicalTab(
  instanceId: number,
  canonicalTabId: number,
  title: string,
  windowId: number,
): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId,
    browserTabId: 100 + instanceId,
    canonicalTabId,
    discarded: false,
    duplicateGroupSize: canonicalTabId === 18 ? 2 : 1,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    foregroundTimeMs: 0,
    importance: 0,
    index: instanceId - 1,
    installationId,
    instanceId,
    lastAccessed: null,
    lastSeenAt: "2026-08-11T00:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title,
    url: `https://example.com/${canonicalTabId}?copy=${instanceId}`,
    urlNormalized: `https://example.com/${canonicalTabId}`,
    windowId,
  };
}

const physicalTabs = [
  physicalTab(1, 17, "Unique physical tab", 1),
  physicalTab(2, 18, "Duplicate copy A", 2),
  physicalTab(3, 18, "Duplicate copy B", 3),
];

const openTabs: TabListResponse = {
  items: [
    {
      browser: "chrome",
      closedAt: null,
      faviconUrl: null,
      firstSeenAt: "2026-08-11T00:00:00.000Z",
      id: 17,
      importance: 0,
      index: 0,
      isOpen: true,
      lastSeenAt: "2026-08-11T00:01:00.000Z",
      engagedTimeMs: 0,
      foregroundTimeMs: 0,
      openEngagedTimeMs: 0,
      openForegroundTimeMs: 0,
      openInstanceCount: 1,
      status: "inbox",
      summary: null,
      tagPaths: [],
      title: "Unique page",
      url: "https://example.com/17",
      urlNormalized: "https://example.com/17",
      windowId: 1,
    },
    {
      browser: "chrome",
      closedAt: null,
      faviconUrl: null,
      firstSeenAt: "2026-08-11T00:00:00.000Z",
      id: 18,
      importance: 0,
      index: 1,
      isOpen: true,
      lastSeenAt: "2026-08-11T00:01:00.000Z",
      engagedTimeMs: 0,
      foregroundTimeMs: 0,
      openEngagedTimeMs: 0,
      openForegroundTimeMs: 0,
      openInstanceCount: 2,
      status: "inbox",
      summary: null,
      tagPaths: [],
      title: "Duplicated page",
      url: "https://example.com/18",
      urlNormalized: "https://example.com/18",
      windowId: 2,
    },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Library as the primary workspace", () => {
  it("opens Library by default and exposes Graph as the only alternate view", () => {
    mocks.fetchTabs.mockResolvedValue(emptyTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Library" })).toBeTruthy();
    const viewSwitch = screen.getByRole("group", { name: "Workspace view" });
    expect(within(viewSwitch).getByRole("button", { name: "Library" })).toBeTruthy();
    expect(within(viewSwitch).getByRole("button", { name: "Graph" })).toBeTruthy();
    expect(within(viewSwitch).queryByRole("button", { name: "Open tabs" })).toBeNull();
    expect(screen.queryByLabelText("Legacy open tabs")).toBeNull();

    queryClient.clear();
  });

  it("discloses exact physical copies and switches selection to browser-tab mode", async () => {
    mocks.fetchTabs.mockResolvedValue(openTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(physicalTabs);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /^Switch to existing tab: Unique page \|/,
        }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Switch to existing tab: Unique page \|/,
      }),
    );
    expect(mocks.runPhysical).toHaveBeenCalledWith(physicalTabs[0]);

    const duplicatedRow = screen.getByText("Duplicated page").closest("tr");
    if (!duplicatedRow) throw new Error("Missing duplicated Library row");
    const tabCell = duplicatedRow.querySelector<HTMLElement>(
      'td[data-column="title"]',
    );
    const activityCell = duplicatedRow.querySelector<HTMLElement>(
      'td[data-column="activity"]',
    );
    if (!tabCell || !activityCell) throw new Error("Missing Library cells");
    const canonicalUrl = within(tabCell).getByText("https://example.com/18");
    expect(canonicalUrl.getAttribute("title")).toBe("https://example.com/18");
    expect(within(tabCell).queryByText("example.com | #18")).toBeNull();
    fireEvent.click(within(duplicatedRow).getByRole("button", { name: "Duplicated page" }));
    expect(within(tabCell).getByText("Duplicate copy A")).toBeTruthy();
    expect(within(tabCell).getByText("Duplicate copy B")).toBeTruthy();
    expect(within(activityCell).queryByText("Duplicate copy A")).toBeNull();
    expect(within(activityCell).queryByRole("button", { name: /^Close for/ })).toBeNull();
    fireEvent.click(
      within(tabCell).getByRole("button", {
        name: /^Close for Duplicate copy B \|/,
      }),
    );
    expect(mocks.closePhysical).toHaveBeenCalledWith(physicalTabs[2]);

    expect(
      screen.queryByRole("group", { name: "Library selection mode" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Pages" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browser tabs" })).toBeNull();
    const manageTabs = screen.getByRole("button", {
      name: "Manage browser tabs",
    });
    expect(screen.getByRole("region", { name: "Library pages" })).toBeTruthy();
    expect(manageTabs.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.queryByText("Select saved pages to organize status and topics."),
    ).toBeNull();
    fireEvent.click(manageTabs);
    expect(manageTabs.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Select and manage exact tabs in their owning browsers."),
    ).toBeTruthy();
    const filterBar = rendered.container.querySelector<HTMLElement>(".filter-bar");
    if (!filterBar) throw new Error("Missing Library filters");
    expect(
      within(filterBar).queryByRole("button", { name: "All filtered results" }),
    ).toBeNull();
    expect(
      within(duplicatedRow).getByRole("checkbox", {
        name: /^Select Duplicate copy A \|/,
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(duplicatedRow).getByRole("checkbox", {
        name: "Select browser tabs for Duplicated page",
      }),
    );
    const physicalToolbar = rendered.container.querySelector<HTMLElement>(
      ".open-tab-bulk-toolbar",
    );
    if (!physicalToolbar) throw new Error("Missing physical browser toolbar");
    expect(within(physicalToolbar).getByText("2 selected")).toBeTruthy();

    fireEvent.click(manageTabs);
    expect(manageTabs.getAttribute("aria-pressed")).toBe("false");
    expect(
      within(duplicatedRow).getByRole("checkbox", {
        name: "Select Duplicated page",
      }),
    ).toBeTruthy();
    expect(
      within(duplicatedRow).queryByRole("checkbox", {
        name: /^Select Duplicate copy A \|/,
      }),
    ).toBeNull();
    expect(
      rendered.container.querySelector(".open-tab-bulk-toolbar"),
    ).toBeNull();

    fireEvent.click(manageTabs);
    expect(manageTabs.getAttribute("aria-pressed")).toBe("true");
    const refreshedDuplicatedRow = screen.getByText("Duplicated page").closest("tr");
    if (!refreshedDuplicatedRow) throw new Error("Missing refreshed Library row");
    expect(
      (
        within(refreshedDuplicatedRow).getByRole("checkbox", {
          name: "Select browser tabs for Duplicated page",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      rendered.container.querySelector(".open-tab-bulk-toolbar"),
    ).toBeNull();

    const viewSwitch = screen.getByRole("group", { name: "Workspace view" });
    fireEvent.click(within(viewSwitch).getByRole("button", { name: "Graph" }));
    fireEvent.click(within(viewSwitch).getByRole("button", { name: "Library" }));
    expect(
      screen.getByRole("button", { name: "Manage browser tabs" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");

    queryClient.clear();
  });

  it("requests only canonical rows with multiple open physical copies", async () => {
    mocks.fetchTabs.mockResolvedValue(openTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(physicalTabs);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Multiple open copies" }),
    );

    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicatesOnly: true,
          openState: "open",
        }),
        expect.any(AbortSignal),
      );
    });

    queryClient.clear();
  });
});
