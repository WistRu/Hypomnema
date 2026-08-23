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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { unavailableExtensionBridge } from "./support/extension-bridge-stub";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  closePhysical: vi.fn(),
  fetchAllLibraryTabIds: vi.fn(),
  fetchFeatureFlags: vi.fn(),
  fetchLibraryOpenTabs: vi.fn(),
  fetchRetentionReview: vi.fn(),
  fetchLocalResourceContext: vi.fn(),
  fetchResourceDetail: vi.fn(),
  fetchResources: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
  runPhysical: vi.fn(),
  setUserImportance: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchFeatureFlags: mocks.fetchFeatureFlags,
  fetchAllLibraryTabIds: mocks.fetchAllLibraryTabIds,
  fetchLibraryOpenTabs: mocks.fetchLibraryOpenTabs,
  fetchRetentionReview: mocks.fetchRetentionReview,
  fetchLocalResourceContext: mocks.fetchLocalResourceContext,
  fetchResourceDetail: mocks.fetchResourceDetail,
  fetchResources: mocks.fetchResources,
  fetchTabs: mocks.fetchTabs,
  fetchTagTree: mocks.fetchTagTree,
  setUserImportance: mocks.setUserImportance,
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
vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => unavailableExtensionBridge(),
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

beforeEach(() => {
  window.history.replaceState({}, "", "/app/");
  mocks.fetchFeatureFlags.mockResolvedValue({
    context: false,
    logicalImportance: false,
  });
  mocks.fetchResources.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });
  mocks.fetchAllLibraryTabIds.mockResolvedValue(
    Object.assign([17, 18], { logicalPageCount: 2 }),
  );
  mocks.setUserImportance.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Library as the primary workspace", () => {
  it("shows the protected one-line context preview only when context is enabled", async () => {
    const contextTabs = {
      ...openTabs,
      items: openTabs.items.map((tab, index) => ({
        ...tab,
        contextPreview:
          index === 0
            ? {
                actor: "user" as const,
                body: "Compare the browser implementations before choosing one",
                entryId: 41,
                entryKind: "next_action" as const,
              }
            : null,
      })),
    };
    mocks.fetchFeatureFlags.mockResolvedValue({
      context: true,
      logicalImportance: false,
    });
    mocks.fetchTabs.mockResolvedValue(contextTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(physicalTabs);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );

    const preview = await screen.findByText(
      "Compare the browser implementations before choosing one",
    );
    expect(preview.classList.contains("library-context-preview-copy")).toBe(true);
    expect(
      view.container.querySelector(".library-context-indicator"),
    ).toBeTruthy();
    expect(
      screen.getByRole("note", {
        name: "Personal context: Compare the browser implementations before choosing one",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.any(AbortSignal),
        "local",
      ),
    );
    expect(mocks.fetchLibraryOpenTabs).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(AbortSignal),
      "local",
    );

    queryClient.clear();
  });

  it("keeps context previews hidden and uses the public list when context is off", async () => {
    mocks.fetchTabs.mockResolvedValue({
      ...openTabs,
      items: openTabs.items.map((tab) => ({
        ...tab,
        contextPreview: {
          actor: "user" as const,
          body: "must stay hidden",
          entryId: 42,
          entryKind: "purpose" as const,
        },
      })),
    });
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(physicalTabs);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <App />
        </I18nProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Unique page");
    expect(view.container.querySelector(".library-context-preview")).toBeNull();
    expect(screen.queryByText("must stay hidden")).toBeNull();
    expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(mocks.fetchLibraryOpenTabs).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(AbortSignal),
      "public",
    );

    queryClient.clear();
  });

  it("opens Library by default and exposes Graph as the only alternate view", () => {
    mocks.fetchTabs.mockResolvedValue(emptyTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchRetentionReview.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
    });
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

    const collectionSwitch = screen.getByRole("group", {
      name: "Library collection",
    });
    expect(within(collectionSwitch).getByRole("button", { name: "All pages" })).toBeTruthy();
    fireEvent.click(
      within(collectionSwitch).getByRole("button", { name: "To review" }),
    );
    expect(screen.getByRole("heading", { name: "Pages suggested for review" })).toBeTruthy();

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

  it("rates cross-browser physical copies of one logical page once without changing browser actions", async () => {
    const personalizedTabs: TabListResponse = {
      ...openTabs,
      items: openTabs.items.map((item) => ({
        ...item,
        logicalPageId: item.id === 18 ? 801 : 800,
      })),
    };
    const crossBrowserCopies = [
      { ...physicalTabs[1]!, browser: "chrome" as const },
      { ...physicalTabs[2]!, browser: "edge" as const,
        installationId: "323e4567-e89b-42d3-a456-426614174000" },
    ];
    mocks.fetchFeatureFlags.mockResolvedValue({
      context: false,
      logicalImportance: true,
      priorityPersonalization: true,
      priorityReaders: false,
      priorityShadow: false,
    });
    mocks.fetchTabs.mockResolvedValue(personalizedTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(crossBrowserCopies);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(<QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en"><App /></I18nProvider>
    </QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Manage browser tabs" }));
    const row = screen.getByText("Duplicated page").closest("tr");
    if (row === null) throw new Error("Missing duplicated logical row");
    fireEvent.click(within(row).getByRole("checkbox", {
      name: "Select browser tabs for Duplicated page",
    }));

    const rating = await screen.findByRole("group", {
      name: "Set importance for selected logical pages",
    });
    expect(screen.getByText("1 logical pages")).toBeTruthy();
    fireEvent.click(within(rating).getByRole("button", {
      name: "Set importance to 3 of 3",
    }));
    // The mutation having been called says nothing about the view having re-rendered
    // without the rating group; waiting for the disappearance is what the assertion
    // means. The negative assertions below stay synchronous on purpose — waiting for
    // something never to happen passes on the first tick and proves nothing.
    await waitFor(() => {
      expect(mocks.setUserImportance).toHaveBeenCalledWith([18], 3);
      expect(screen.queryByRole("group", {
        name: "Set importance for selected logical pages",
      })).toBeNull();
    });
    expect(mocks.setUserImportance).toHaveBeenCalledTimes(1);
    expect(mocks.runPhysical).not.toHaveBeenCalled();
    expect(mocks.closePhysical).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("uses the exact all-filtered logical count for canonical bulk importance", async () => {
    const personalizedTabs: TabListResponse = {
      ...openTabs,
      items: openTabs.items.map((item) => ({
        ...item,
        logicalPageId: 900,
      })),
    };
    mocks.fetchFeatureFlags.mockResolvedValue({
      context: false,
      logicalImportance: true,
      priorityPersonalization: true,
      priorityReaders: false,
      priorityShadow: false,
    });
    mocks.fetchTabs.mockResolvedValue(personalizedTabs);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    mocks.fetchLibraryOpenTabs.mockResolvedValue(physicalTabs);
    mocks.fetchAllLibraryTabIds.mockResolvedValue(
      Object.assign([17, 18], { logicalPageCount: 1 }),
    );
    const queryClient = new QueryClient({ defaultOptions: {
      mutations: { retry: false }, queries: { retry: false },
    } });
    render(<QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en"><App /></I18nProvider>
    </QueryClientProvider>);

    fireEvent.click(await screen.findByRole("radio", { name: "Needs review" }));
    await waitFor(() => expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ needsReview: true }),
      expect.any(AbortSignal),
    ));
    const allFiltered = screen.getByRole<HTMLButtonElement>("button", {
      name: "All filtered results",
    });
    await waitFor(() => expect(allFiltered.disabled).toBe(false));
    fireEvent.click(allFiltered);
    await waitFor(() => expect(mocks.fetchAllLibraryTabIds).toHaveBeenCalled());
    expect(await screen.findByText("1 logical pages")).toBeTruthy();
    const rating = screen.getByRole("group", {
      name: "Set importance for selected logical pages",
    });
    fireEvent.click(within(rating).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mocks.setUserImportance).toHaveBeenCalledWith([17, 18], 0));
    expect(mocks.fetchAllLibraryTabIds).toHaveBeenCalledWith(
      expect.objectContaining({ needsReview: true }),
      undefined,
      "public",
    );
    expect(mocks.fetchAllLibraryTabIds.mock.calls[0]?.[0])
      .not.toHaveProperty("priorityMode");
    queryClient.clear();
  });

  it("keeps Topic and Resource as orthogonal Library facets with URL-backed resource history", async () => {
    const resource = {
      resource: {
        id: 7,
        resourceKey: "platform:youtube",
        name: "YouTube",
        kind: "platform" as const,
        accessClass: "public" as const,
        lifecycleState: "active" as const,
        mergedIntoResourceId: null,
        createdAt: "2026-08-12T10:00:00.000Z",
        updatedAt: "2026-08-12T10:00:00.000Z",
      },
      version: 2,
      preference: { userEvaluation: null, provenance: null, updatedAt: "2026-08-12T10:00:00.000Z" },
      counts: { logicalPageCount: 4, browserPageCount: 6, physicalOpenCopyCount: 2 },
      allTimeActivity: { window: "all" as const, onScreenMs: 12_000, activeUseMs: 4_000, coverageStart: null },
      topicPaths: ["Work"],
    };
    mocks.fetchFeatureFlags.mockResolvedValue({
      context: false,
      logicalImportance: false,
      privacyPurge: true,
      resources: true,
    });
    mocks.fetchTabs.mockResolvedValue(emptyTabs);
    mocks.fetchLibraryOpenTabs.mockResolvedValue([]);
    mocks.fetchTagTree.mockResolvedValue({
      items: [{ id: 1, name: "Work", path: "Work", color: null, tabCount: 4, children: [] }],
    });
    mocks.fetchResources.mockResolvedValue({ items: [resource], page: 1, pageSize: 100, total: 1 });
    mocks.fetchResourceDetail.mockResolvedValue({ ...resource, rulesetVersion: 3, aliases: [] });
    mocks.fetchLocalResourceContext.mockResolvedValue({
      context: {
        subject: { type: "resource", resourceId: 7 },
        entries: [],
        currentEntries: [],
        preview: null,
      },
      counts: resource.counts,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en"><App /></I18nProvider>
      </QueryClientProvider>,
    );

    await screen.findByTitle("Work");
    fireEvent.click(screen.getByRole("button", { name: "Work4" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Work4" }).getAttribute("aria-current")).toBe("page"));
    expect(await screen.findByText("Topic: Work")).toBeTruthy();
    const facets = screen.getByRole("group", { name: "Library grouping" });
    fireEvent.click(within(facets).getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByRole("button", { name: /YouTube/ }));

    expect(screen.getByText("Topic: Work")).toBeTruthy();
    expect(screen.getByText("Resource: YouTube")).toBeTruthy();
    expect((await screen.findByRole<HTMLButtonElement>("button", {
      name: "Delete this resource's research history",
    })).disabled).toBe(false);
    expect(window.location.search).toBe("?resource=7");
    await waitFor(() => expect(mocks.fetchTabs).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 7, tag: "Work" }),
      expect.any(AbortSignal),
    ));

    fireEvent.click(screen.getByText("Topic: Work").closest("button")!);
    expect(screen.queryByText("Topic: Work")).toBeNull();
    expect(screen.getByText("Resource: YouTube")).toBeTruthy();
    fireEvent.click(within(facets).getByRole("button", { name: "Topics" }));
    expect(screen.getAllByRole("heading", { name: "YouTube" }).length).toBeGreaterThan(0);

    window.history.replaceState({}, "", "/app/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.queryByText("Resource: YouTube")).toBeNull());
    await waitFor(() => expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ resourceId: 7 }),
      expect.any(AbortSignal),
    ));
    queryClient.clear();
  });

  it("fails closed to the exact legacy Topic sidebar when the resource feature is missing", async () => {
    mocks.fetchTabs.mockResolvedValue(emptyTabs);
    mocks.fetchLibraryOpenTabs.mockResolvedValue([]);
    mocks.fetchTagTree.mockResolvedValue(emptyTopics);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en"><App /></I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Topics" });
    expect(screen.queryByRole("group", { name: "Library grouping" })).toBeNull();
    expect(rendered.container.querySelector(".facet-sidebar-shell")).toBeNull();
    expect(mocks.fetchResources).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
