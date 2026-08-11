// @vitest-environment jsdom

import type { TabListItem, TabListResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  fetchLibraryOpenTabs: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
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

const tab: TabListItem = {
  browser: "chrome",
  closedAt: null,
  faviconUrl: null,
  firstSeenAt: "2026-08-11T00:00:00.000Z",
  id: 17,
  importance: 2,
  index: 0,
  isOpen: true,
  lastSeenAt: "2026-08-11T00:01:00.000Z",
  openEngagedTimeMs: 12_000,
  openForegroundTimeMs: 61_000,
  openInstanceCount: 0,
  status: "in_progress",
  summary: null,
  tagPaths: ["Work/AI"],
  title: "Sortable page",
  url: "https://example.com/sortable",
  urlNormalized: "https://example.com/sortable",
  windowId: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderApp(total = 1) {
  mocks.fetchTabs.mockImplementation(
    async ({ page }: { page: number }): Promise<TabListResponse> => ({
      items: [tab],
      page,
      pageSize: 50,
      total,
    }),
  );
  mocks.fetchLibraryOpenTabs.mockResolvedValue([]);
  mocks.fetchTagTree.mockResolvedValue({ items: [] });
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

  return queryClient;
}

describe("Library column sorting", () => {
  it("cycles a sortable header through ascending, descending, and default order", async () => {
    const queryClient = renderApp();

    await screen.findByText("Sortable page");
    const initialButton = screen.getByRole("button", { name: "Sort by Tab" });
    const header = initialButton.closest("th");
    if (!header) throw new Error("Missing Tab column header");
    expect(header.getAttribute("aria-sort")).toBeNull();

    fireEvent.click(initialButton);
    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          sortBy: "title",
          sortDirection: "asc",
        }),
        expect.any(AbortSignal),
      );
    });
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(
      screen.getByRole("button", { name: "Sort by Topics" }).closest("th")
        ?.getAttribute("aria-sort"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Sort Tab descending" }),
    );
    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          sortBy: "title",
          sortDirection: "desc",
        }),
        expect.any(AbortSignal),
      );
    });
    expect(header.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(
      screen.getByRole("button", { name: "Clear sorting for Tab" }),
    );
    await waitFor(() => {
      const [filters] = mocks.fetchTabs.mock.calls.at(-1) ?? [];
      expect(filters).not.toHaveProperty("sortBy");
      expect(filters).not.toHaveProperty("sortDirection");
    });
    expect(header.getAttribute("aria-sort")).toBeNull();

    queryClient.clear();
  });

  it("uses useful first directions and returns to page one when sorting changes", async () => {
    const queryClient = renderApp(100);

    await screen.findByText("Sortable page");
    expect(screen.getAllByRole("columnheader")).toHaveLength(9);
    expect(screen.getAllByRole("button", { name: /^Sort by / })).toHaveLength(8);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
        expect.any(AbortSignal),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Sort by Activity" }));
    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          sortBy: "activity",
          sortDirection: "desc",
        }),
        expect.any(AbortSignal),
      );
    });
    const activityHeader = screen
      .getByRole("button", { name: "Sort Activity ascending" })
      .closest("th");
    expect(activityHeader?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Age" }));
    await waitFor(() => {
      expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          sortBy: "age",
          sortDirection: "asc",
        }),
        expect.any(AbortSignal),
      );
    });
    expect(
      screen
        .getByRole("button", { name: "Sort Age descending" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");

    queryClient.clear();
  });
});
