// @vitest-environment jsdom

import type { FeatureFlagsResponse, TabListItem, TabListResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  closeCanonical: vi.fn(),
  closePhysical: vi.fn(),
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
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
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
    closeCanonical: mocks.closeCanonical,
    closePhysical: mocks.closePhysical,
    errorForCanonical: () => undefined,
    errorForPhysical: () => undefined,
    isClosingCanonical: () => false,
    isClosingPhysical: () => false,
  }),
}));

const tab: TabListItem = {
  browser: "chrome",
  closedAt: null,
  faviconUrl: null,
  firstSeenAt: "2026-08-11T00:00:00.000Z",
  id: 17,
  logicalPageId: 501,
  importance: 2,
  index: 0,
  isOpen: true,
  lastSeenAt: "2026-08-11T00:01:00.000Z",
  engagedTimeMs: 0,
  foregroundTimeMs: 0,
  openEngagedTimeMs: 12_000,
  openForegroundTimeMs: 61_000,
  openInstanceCount: 0,
  status: "in_progress",
  summary: null,
  tagPaths: [],
  title: "Pending feature page",
  url: "https://example.com/pending",
  urlNormalized: "https://example.com/pending",
  windowId: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("W60 App feature boundary acceptance", () => {
  it("uses the exact pre-G6 request and exposes no personalization UI while flags are pending", async () => {
    let resolveFlags!: (flags: FeatureFlagsResponse) => void;
    mocks.fetchFeatureFlags.mockReturnValue(new Promise((resolve) => {
      resolveFlags = resolve;
    }));
    mocks.fetchTabs.mockImplementation(async ({ page }: { page: number }): Promise<TabListResponse> => ({
      items: [tab],
      page,
      pageSize: 50,
      total: 1,
    }));
    mocks.fetchLibraryOpenTabs.mockResolvedValue([]);
    mocks.fetchTagTree.mockResolvedValue({ items: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
      <App />
    </I18nProvider></QueryClientProvider>);

    await screen.findByText("Pending feature page");
    expect(mocks.fetchTabs).toHaveBeenCalled();
    for (const [filters] of mocks.fetchTabs.mock.calls) {
      expect(filters).not.toHaveProperty("priorityMode");
      expect(filters).not.toHaveProperty("needsReview");
    }
    expect(screen.queryByRole("group", { name: "Priority order" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personal priority rules" })).toBeNull();

    resolveFlags({
      context: false,
      logicalImportance: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: false,
    });
    await waitFor(() => expect(screen.getByRole("group", {
      name: "Priority order",
    })).toBeTruthy());
    const [lastFilters] = mocks.fetchTabs.mock.calls.at(-1) ?? [];
    expect(lastFilters).not.toHaveProperty("priorityMode");
    expect(lastFilters).not.toHaveProperty("needsReview");
    client.clear();
  });
});
