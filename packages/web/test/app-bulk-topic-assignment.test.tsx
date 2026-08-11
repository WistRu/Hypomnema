// @vitest-environment jsdom

import type { TabListResponse, TagTreeResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  assignTag: vi.fn(),
  fetchLibraryOpenTabs: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  assignTag: mocks.assignTag,
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
      status: "inbox",
      summary: null,
      tagPaths: ["Без темы"],
      title: "Existing tab",
      url: "https://example.com/existing",
      urlNormalized: "https://example.com/existing",
      windowId: 1,
    },
  ],
  page: 1,
  pageSize: 50,
  total: 1,
};

const topics: TagTreeResponse = {
  items: [
    {
      id: 6,
      name: "Без темы",
      path: "Без темы",
      color: "#64748b",
      tabCount: 1,
      children: [],
    },
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
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Library bulk topic assignment", () => {
  it("selects tabs, suggests existing topics, and submits a free-form path", async () => {
    class ResizeObserverStub {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    mocks.fetchTabs.mockResolvedValue(tabs);
    mocks.fetchTagTree.mockResolvedValue(topics);
    mocks.assignTag.mockResolvedValue({ assigned: 1, tagId: 7 });

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
      [],
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
    fireEvent.click(
      within(rendered.container).getByRole("checkbox", {
        name: "Select all tabs on this page",
      }),
    );

    const bulkToolbar = rendered.container.querySelector<HTMLElement>(".bulk-toolbar");
    if (!bulkToolbar) throw new Error("Missing bulk toolbar");
    const suggestions = [...bulkToolbar.querySelectorAll("datalist option")].map(
      (option) => option.getAttribute("value"),
    );
    expect(suggestions).toEqual(["Работа", "Работа/ИИ"]);

    const topicInput = within(bulkToolbar).getByLabelText<HTMLInputElement>(
      "Topic path",
    );
    fireEvent.change(topicInput, { target: { value: "Новая/Тема" } });
    expect(topicInput.value).toBe("Новая/Тема");

    const form = topicInput.closest("form");
    if (!form) throw new Error("Missing bulk topic form");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mocks.assignTag).toHaveBeenCalledWith([17], "Новая/Тема");
    });
    queryClient.clear();
  });
});
