// @vitest-environment jsdom

import type { TabDetailResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { TabDrawer } from "../src/TabDrawer";

const mocks = vi.hoisted(() => ({
  fetchFeatureFlags: vi.fn(),
  fetchLogicalPageResourceResolution: vi.fn(),
  fetchResourceOpenTabs: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

vi.mock("../src/PageSummaryCaptureControl", () => ({
  PageSummaryCaptureControl: () => <div data-testid="page-summary-capture">new capture flow</div>,
}));

vi.mock("../src/ResearchPanel", () => ({
  ResearchPanel: ({ entryLabel, target }: { entryLabel: string; target: unknown }) => (
    <div data-entry={entryLabel} data-testid={entryLabel === "Research this page"
      ? "page-research-entry" : "resource-research-entry"}>
      {JSON.stringify(target)}
    </div>
  ),
}));
vi.mock("../src/ResearchHistoryDrawer", () => ({
  ResearchHistoryDrawer: ({ researchEnabled, target }: {
    researchEnabled: boolean;
    target: { type: "page" | "resource" };
  }) => (
    <div data-enabled={String(researchEnabled)} data-testid={`${target.type}-research-history`}>
      {JSON.stringify(target)}
    </div>
  ),
}));

const tab: TabDetailResponse = {
  browser: "chrome",
  closedAt: null,
  content: {
    contentRevision: 2,
    extractedAt: "2026-08-13T10:00:00.000Z",
    htmlExcerpt: null,
    summary: "Existing drawer summary",
    summaryModel: "existing-model",
    text: "Captured",
  },
  customFields: {},
  engagedTimeMs: 0,
  faviconUrl: null,
  firstSeenAt: "2026-08-10T10:00:00.000Z",
  foregroundTimeMs: 0,
  id: 17,
  importance: 1,
  index: 0,
  isOpen: true,
  lastSeenAt: "2026-08-12T10:00:00.000Z",
  links: [],
  logicalPageId: 501,
  openEngagedTimeMs: 0,
  openForegroundTimeMs: 0,
  openInstanceCount: 0,
  status: "inbox",
  summary: "Existing list summary",
  tagPaths: [],
  tags: [],
  title: "Feature gate page",
  url: "https://example.com/feature-gate",
  urlNormalized: "https://example.com/feature-gate",
  windowId: 1,
};

function renderDrawer(onReviewResourceResolution = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(["tab", tab.id], tab);
  queryClient.setQueryData(["links", tab.id], { items: [] });
  queryClient.setQueryData(["tab-instances", { canonicalTabId: tab.id }], []);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <TabDrawer tabId={tab.id} onBrowserAction={vi.fn()} onClose={vi.fn()}
          onReviewResourceResolution={onReviewResourceResolution} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const resolutionCommon = {
  logicalPageId: 501,
  sourceFingerprint: "resolution:one",
  resolvedAt: "2026-08-14T10:00:00.000Z",
};

describe("TabDrawer page-summary capture capability", () => {
  beforeEach(() => {
    mocks.fetchLogicalPageResourceResolution.mockResolvedValue({
      ...resolutionCommon,
      candidateResourceIds: [],
      state: "unmatched",
      reason: "registrable_domain_unavailable",
      resource: null,
      researchEligible: false,
      researchExclusionReason: "registrable_domain_unavailable",
    });
    mocks.fetchResourceOpenTabs.mockResolvedValue([]);
  });
  it("exposes a page research entry for a valid logical page only after research=true", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ research: true });
    renderDrawer();

    const entry = await screen.findByTestId("page-research-entry");
    expect(entry.getAttribute("data-entry")).toBe("Research this page");
    expect(entry.textContent).toBe(JSON.stringify({ type: "page", logicalPageId: 501 }));
    expect(screen.getByTestId("page-research-history").getAttribute("data-enabled")).toBe("true");
  });

  it("keeps page report history mounted read-only when research creation is disabled", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ research: false });
    renderDrawer();

    const history = await screen.findByTestId("page-research-history");
    expect(history.getAttribute("data-enabled")).toBe("false");
    expect(history.textContent).toBe(JSON.stringify({ type: "page", logicalPageId: 501 }));
    expect(screen.queryByTestId("page-research-entry")).toBeNull();
  });

  it("adds Resource research only for a persisted resolved and eligible Resource", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ research: true });
    mocks.fetchLogicalPageResourceResolution.mockResolvedValue({
      ...resolutionCommon,
      candidateResourceIds: [7],
      state: "resolved",
      reason: "system_seed",
      resource: {
        id: 7, resourceKey: "platform:youtube", name: "YouTube", kind: "platform",
        accessClass: "public", lifecycleState: "active", mergedIntoResourceId: null,
        createdAt: "2026-08-13T10:00:00.000Z", updatedAt: "2026-08-14T10:00:00.000Z",
      },
      researchEligible: true,
      researchExclusionReason: null,
    });
    renderDrawer();

    const entry = await screen.findByTestId("resource-research-entry");
    expect(entry.textContent).toBe(JSON.stringify({ type: "resource", resourceId: 7 }));
    expect(mocks.fetchLogicalPageResourceResolution).toHaveBeenCalledWith(501, expect.any(AbortSignal));
    expect(mocks.fetchResourceOpenTabs).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    expect(screen.getByTestId("resource-research-history").textContent)
      .toBe(JSON.stringify({ type: "resource", resourceId: 7 }));
  });

  it("hides a cached resolved-Resource writer when the research capability flips off", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ research: true });
    const resolved = {
      ...resolutionCommon,
      candidateResourceIds: [7],
      state: "resolved" as const,
      reason: "system_seed" as const,
      resource: {
        id: 7, resourceKey: "platform:youtube", name: "YouTube", kind: "platform" as const,
        accessClass: "public" as const, lifecycleState: "active" as const,
        mergedIntoResourceId: null, createdAt: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
      },
      researchEligible: true,
      researchExclusionReason: null,
    };
    mocks.fetchLogicalPageResourceResolution.mockResolvedValue(resolved);
    const client = renderDrawer();
    expect(await screen.findByTestId("resource-research-entry")).toBeTruthy();

    mocks.fetchFeatureFlags.mockResolvedValue({ research: false });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["features"] });
    });

    expect(screen.queryByTestId("page-research-entry")).toBeNull();
    expect(screen.queryByTestId("resource-research-entry")).toBeNull();
    expect(screen.getByTestId("resource-research-history").getAttribute("data-enabled"))
      .toBe("false");
  });

  it("explains a resolved but ineligible Resource without mounting its entry", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ research: true });
    mocks.fetchLogicalPageResourceResolution.mockResolvedValue({
      ...resolutionCommon,
      candidateResourceIds: [7],
      state: "resolved",
      reason: "system_seed",
      resource: {
        id: 7, resourceKey: "platform:account", name: "Account", kind: "platform",
        accessClass: "authenticated", lifecycleState: "active", mergedIntoResourceId: null,
        createdAt: "2026-08-13T10:00:00.000Z", updatedAt: "2026-08-14T10:00:00.000Z",
      },
      researchEligible: false,
      researchExclusionReason: "authenticated_access",
    });
    renderDrawer();

    expect(await screen.findByText(
      "Resource research unavailable: this Resource is not eligible.",
    )).toBeTruthy();
    expect(screen.queryByTestId("resource-research-entry")).toBeNull();
    expect(mocks.fetchResourceOpenTabs).not.toHaveBeenCalled();
  });

  it.each([
    ["unmatched", "Resource research unavailable: this page is not assigned to a Resource."],
    ["ambiguous", "Resource research unavailable: this page matches multiple Resources."],
    ["excluded", "Resource research unavailable: this page is excluded from Resources."],
  ] as const)(
    "explains %s resolution without inventing a Resource research entry",
    async (state, explanation) => {
      mocks.fetchFeatureFlags.mockResolvedValue({ research: true });
      mocks.fetchLogicalPageResourceResolution.mockResolvedValue({
        ...resolutionCommon,
        candidateResourceIds: state === "ambiguous" ? [7, 8] : [],
        state,
        reason: state === "ambiguous" ? "authoritative_tie" :
          state === "excluded" ? "browser_internal" : "registrable_domain_unavailable",
        resource: null,
        researchEligible: false,
        researchExclusionReason: state === "ambiguous" ? "authoritative_tie" :
          state === "excluded" ? "browser_internal" : "registrable_domain_unavailable",
      });
      renderDrawer();

      expect(await screen.findByTestId("page-research-entry")).toBeTruthy();
      await waitFor(() => expect(mocks.fetchLogicalPageResourceResolution).toHaveBeenCalled());
      expect(await screen.findByText(explanation)).toBeTruthy();
      expect(screen.queryByTestId("resource-research-entry")).toBeNull();
      expect(mocks.fetchResourceOpenTabs).not.toHaveBeenCalled();
      if (state === "unmatched" || state === "ambiguous") {
        const review = vi.fn();
        cleanup();
        renderDrawer(review);
        fireEvent.click(await screen.findByRole("button", { name: "Review Resource assignment" }));
        expect(review).toHaveBeenCalledWith(501);
      }
    },
  );
  it.each([
    ["false", { pageSummaryCapture: false }],
    ["absent", {}],
  ])("fails closed when the capability is %s while preserving the existing summary", async (_name, flags) => {
    mocks.fetchFeatureFlags.mockResolvedValue(flags);
    renderDrawer();

    expect(await screen.findByText("Existing drawer summary")).toBeTruthy();
    await waitFor(() => expect(mocks.fetchFeatureFlags).toHaveBeenCalled());
    expect(screen.queryByTestId("page-summary-capture")).toBeNull();
  });

  it("mounts the flow only after an explicit true capability response", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ pageSummaryCapture: true });
    renderDrawer();

    expect(await screen.findByTestId("page-summary-capture")).toBeTruthy();
    expect(screen.getByText("Existing drawer summary")).toBeTruthy();
  });

  it("mounts nothing while capability loading is pending", async () => {
    mocks.fetchFeatureFlags.mockImplementation(() => new Promise(() => undefined));
    renderDrawer();

    expect(await screen.findByText("Existing drawer summary")).toBeTruthy();
    expect(screen.queryByTestId("page-summary-capture")).toBeNull();
  });

  it("mounts nothing when capability loading fails", async () => {
    mocks.fetchFeatureFlags.mockRejectedValue(new Error("feature unavailable"));
    renderDrawer();

    expect(await screen.findByText("Existing drawer summary")).toBeTruthy();
    await waitFor(() => expect(mocks.fetchFeatureFlags).toHaveBeenCalled());
    expect(screen.queryByTestId("page-summary-capture")).toBeNull();
  });
});
