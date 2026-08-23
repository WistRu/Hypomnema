// @vitest-environment jsdom

import type {
  FeatureFlagsResponse,
  PrioritySafeRead,
  TabListItem,
  TabListResponse,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  closeCanonical: vi.fn(),
  closePhysical: vi.fn(),
  fetchFeatureFlags: vi.fn(),
  fetchRetentionReview: vi.fn(),
  fetchRetentionTrash: vi.fn(),
  forgetRetentionTab: vi.fn(),
  fetchLibraryOpenTabs: vi.fn(),
  fetchPriorityReadBatch: vi.fn(),
  fetchTabs: vi.fn(),
  fetchTagTree: vi.fn(),
  restoreRetentionTab: vi.fn(),
  setRetentionDecision: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchFeatureFlags: mocks.fetchFeatureFlags,
  fetchRetentionReview: mocks.fetchRetentionReview,
  fetchRetentionTrash: mocks.fetchRetentionTrash,
  forgetRetentionTab: mocks.forgetRetentionTab,
  fetchLibraryOpenTabs: mocks.fetchLibraryOpenTabs,
  fetchPriorityReadBatch: mocks.fetchPriorityReadBatch,
  fetchTabs: mocks.fetchTabs,
  fetchTagTree: mocks.fetchTagTree,
  restoreRetentionTab: mocks.restoreRetentionTab,
  setRetentionDecision: mocks.setRetentionDecision,
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
  tagPaths: ["Work/AI"],
  title: "Sortable page",
  url: "https://example.com/sortable",
  urlNormalized: "https://example.com/sortable",
  windowId: 1,
};

const priorityTab = {
  ...tab,
  logicalPageId: 501,
};

function priorityRead(): PrioritySafeRead {
  const subject = { type: "page" as const, logicalPageId: 501 };
  return {
    subject,
    outcome: {
      kind: "assessment",
      assessment: {
        id: 71,
        subject,
        agentScore: 78,
        agentBand: "high",
        confidence: 0.8,
        needsReview: false,
        reasons: [],
        missingSignals: [],
        ruleset: { rulesetId: 1, version: 1 },
        featureFingerprint: "a".repeat(64),
        assessmentMethod: "rule",
        modelProvenance: null,
        revision: 1,
        evaluatedAt: "2026-08-13T10:00:00.000Z",
        supersededAt: null,
      },
    },
    isCurrent: true,
    dirty: false,
    needsReview: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderApp(
  total = 1,
  options: {
    flags?: FeatureFlagsResponse;
    items?: TabListItem[];
    priorityError?: Error;
  } = {},
) {
  mocks.fetchFeatureFlags.mockResolvedValue(options.flags ?? {
    context: false,
    logicalImportance: false,
  });
  mocks.fetchTabs.mockImplementation(
    async ({ page }: { page: number }): Promise<TabListResponse> => ({
      items: options.items ?? [tab],
      page,
      pageSize: 50,
      total,
    }),
  );
  mocks.fetchLibraryOpenTabs.mockResolvedValue([]);
  mocks.fetchTagTree.mockResolvedValue({ items: [] });
  if (options.priorityError === undefined) {
    mocks.fetchPriorityReadBatch.mockResolvedValue([priorityRead()]);
  } else {
    mocks.fetchPriorityReadBatch.mockRejectedValue(options.priorityError);
  }
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

  it("adds one bounded shadow read for visible logical pages without changing default request or row order", async () => {
    const duplicate = {
      ...priorityTab,
      browser: "edge" as const,
      id: 18,
      title: "Second browser copy",
    };
    const queryClient = renderApp(2, {
      flags: {
        context: false,
        logicalImportance: true,
        priorityAssessmentWriter: true,
        priorityReaders: true,
        priorityShadow: true,
      },
      items: [priorityTab, duplicate],
    });

    expect(await screen.findAllByText("AI: 78")).toHaveLength(2);
    expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledWith(
      [{ type: "page", logicalPageId: 501 }],
      expect.any(AbortSignal),
    );
    const [filters] = mocks.fetchTabs.mock.calls.at(-1) ?? [];
    expect(filters).not.toHaveProperty("sortBy");
    expect(filters).not.toHaveProperty("sortDirection");
    const titleButtons = screen.getAllByRole("button").filter((node) =>
      node.classList.contains("tab-open-button"),
    );
    expect(titleButtons.map(({ textContent }) => textContent)).toEqual([
      "Sortable page",
      "Second browser copy",
    ]);
    expect(screen.getByRole("button", { name: "Review AI priorities" })).toBeTruthy();
    expect(mocks.fetchRetentionReview).not.toHaveBeenCalled();
    expect(mocks.fetchRetentionTrash).not.toHaveBeenCalled();
    expect(mocks.setRetentionDecision).not.toHaveBeenCalled();
    expect(mocks.forgetRetentionTab).not.toHaveBeenCalled();
    expect(mocks.restoreRetentionTab).not.toHaveBeenCalled();
    expect(mocks.closeCanonical).not.toHaveBeenCalled();
    expect(mocks.closePhysical).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it.each([
    ["off", false, false],
    ["readers only", true, false],
    ["shadow only", false, true],
    ["writer only", false, false],
  ])("fails closed for the %s flag combination", async (_name, readers, shadow) => {
    const queryClient = renderApp(1, {
      flags: {
        context: false,
        logicalImportance: false,
        priorityAssessmentWriter: _name === "writer only",
        priorityReaders: readers,
        priorityShadow: shadow,
      },
      items: [priorityTab],
    });

    await screen.findByText("Sortable page");
    expect(mocks.fetchPriorityReadBatch).not.toHaveBeenCalled();
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review AI priorities" })).toBeNull();
    expect(screen.getByLabelText("Importance 2 of 3")).toBeTruthy();
    queryClient.clear();
  });

  it("does not expose stale badges when the shadow batch route is feature-disabled", async () => {
    const queryClient = renderApp(1, {
      flags: {
        context: false,
        logicalImportance: true,
        priorityReaders: true,
        priorityShadow: true,
      },
      items: [priorityTab],
      priorityError: Object.assign(new Error("Feature disabled"), {
        code: "FEATURE_DISABLED",
      }),
    });
    await screen.findByText("Sortable page");
    await waitFor(() => expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.getByLabelText("Importance 2 of 3")).toBeTruthy();
    queryClient.clear();
  });

  it("applies personalized mode and review filters, then clears them on a runtime flag flip", async () => {
    const queryClient = renderApp(1, {
      flags: {
        context: false,
        logicalImportance: true,
        priorityPersonalization: true,
        priorityReaders: true,
        priorityShadow: false,
      },
      items: [priorityTab],
    });
    await screen.findByText("Sortable page");
    fireEvent.click(screen.getByRole("radio", { name: "Recommended" }));
    fireEvent.click(screen.getByRole("radio", { name: "Needs review" }));
    await waitFor(() => expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        priorityMode: "recommended",
        needsReview: true,
      }),
      expect.any(AbortSignal),
    ));

    mocks.fetchFeatureFlags.mockResolvedValueOnce({
      context: false,
      logicalImportance: true,
      priorityPersonalization: false,
      priorityReaders: true,
      priorityShadow: false,
    });
    await queryClient.refetchQueries({ queryKey: ["features"] });
    await waitFor(() => {
      const [filters] = mocks.fetchTabs.mock.calls.at(-1) ?? [];
      expect(filters).not.toHaveProperty("priorityMode");
      expect(filters).not.toHaveProperty("needsReview");
    });
    expect(screen.queryByRole("group", { name: "Priority order" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personal priority rules" })).toBeNull();
    expect(screen.queryByText("Priority: Recommended")).toBeNull();
    expect(screen.queryByText("Review: Needs review")).toBeNull();
    queryClient.clear();
  });

  it("drops importance sorting when personalized priority order becomes active", async () => {
    const queryClient = renderApp(1, {
      flags: {
        context: false,
        logicalImportance: true,
        priorityPersonalization: true,
        priorityReaders: true,
        priorityShadow: false,
      },
      items: [priorityTab],
    });
    await screen.findByText("Sortable page");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Importance" }));
    await waitFor(() => expect(mocks.fetchTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "importance" }),
      expect.any(AbortSignal),
    ));
    fireEvent.click(screen.getByRole("radio", { name: "AI" }));
    await waitFor(() => {
      const [filters] = mocks.fetchTabs.mock.calls.at(-1) ?? [];
      expect(filters).toMatchObject({ priorityMode: "ai" });
      expect(filters).not.toHaveProperty("sortBy");
      expect(filters).not.toHaveProperty("sortDirection");
    });
    expect(screen.queryByRole("button", { name: /Importance/ })).toBeNull();
    queryClient.clear();
  });

  it("hides cached priority surfaces when the current feature refresh fails", async () => {
    const queryClient = renderApp(1, {
      flags: {
        context: false,
        logicalImportance: true,
        priorityReaders: true,
        priorityShadow: true,
      },
      items: [priorityTab],
    });

    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review AI priorities" })).toBeTruthy();

    mocks.fetchFeatureFlags.mockRejectedValueOnce(
      new Error("Feature refresh failed"),
    );
    await queryClient.refetchQueries({ queryKey: ["features"] });

    // Waiting for the fetch says the data arrived, not that React rendered it, so the
    // DOM assertions wait for the render rather than for the request.
    await waitFor(() => {
      expect(mocks.fetchFeatureFlags).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("AI: 78")).toBeNull();
      expect(screen.queryByRole("button", { name: "Review AI priorities" })).toBeNull();
    });
    expect(screen.getByLabelText("Importance 2 of 3")).toBeTruthy();

    let resolveFeatures: ((value: FeatureFlagsResponse) => void) | undefined;
    mocks.fetchFeatureFlags.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveFeatures = resolve;
      }),
    );
    const refresh = queryClient.refetchQueries({ queryKey: ["features"] });
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review AI priorities" })).toBeNull();
    resolveFeatures?.({
      context: false,
      logicalImportance: true,
      priorityReaders: true,
      priorityShadow: true,
    });
    await refresh;
    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review AI priorities" })).toBeTruthy();
    queryClient.clear();
  });
});
