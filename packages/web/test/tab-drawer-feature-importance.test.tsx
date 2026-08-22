// @vitest-environment jsdom

import type {
  FeatureFlagsResponse,
  PrioritySafeRead,
  TabDetailResponse,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { TabDrawer } from "../src/TabDrawer";

const mocks = vi.hoisted(() => ({
  fetchFeatureFlags: vi.fn(),
  fetchPriorityReadBatch: vi.fn(),
  patchTabDetails: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchFeatureFlags: mocks.fetchFeatureFlags,
  fetchPriorityReadBatch: mocks.fetchPriorityReadBatch,
  patchTabDetails: mocks.patchTabDetails,
}));

const tab: TabDetailResponse = {
  id: 17,
  logicalPageId: 501,
  browser: "chrome",
  closedAt: null,
  content: null,
  customFields: {},
  engagedTimeMs: 0,
  faviconUrl: null,
  firstSeenAt: "2026-08-10T10:00:00.000Z",
  foregroundTimeMs: 0,
  importance: 1,
  index: 0,
  isOpen: true,
  lastSeenAt: "2026-08-12T10:00:00.000Z",
  links: [],
  openEngagedTimeMs: 0,
  openForegroundTimeMs: 0,
  openInstanceCount: 0,
  status: "inbox",
  summary: null,
  tagPaths: [],
  tags: [],
  title: "Feature-off page",
  url: "https://example.com/feature-off",
  urlNormalized: "https://example.com/feature-off",
  windowId: 1,
};
const prioritySubject = { type: "page" as const, logicalPageId: 501 };

function priorityRead(): PrioritySafeRead {
  return {
    subject: prioritySubject,
    outcome: {
      kind: "assessment",
      assessment: {
        id: 71,
        subject: prioritySubject,
        agentScore: 78,
        agentBand: "high",
        confidence: 0.8,
        needsReview: false,
        reasons: [{
          code: "rule:next-action",
          kind: "contribution",
          label: "Has a shareable next action",
          scoreDelta: 25,
        }],
        missingSignals: ["captured_content"],
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

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["tab", tab.id], tab);
  queryClient.setQueryData(["links", tab.id], { items: [] });
  queryClient.setQueryData(
    ["tab-instances", { canonicalTabId: tab.id }],
    [],
  );
  queryClient.setQueryData(["tags"], { items: [] });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <TabDrawer
          tabId={tab.id}
          onBrowserAction={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("TabDrawer feature-off importance", () => {
  it("routes the old scalar control through patchTabDetails", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ logicalImportance: false });
    mocks.patchTabDetails.mockResolvedValue({ ...tab, importance: 2 });
    renderDrawer();

    fireEvent.click(await screen.findByRole("button", { name: "2" }));

    await waitFor(() => {
      expect(mocks.patchTabDetails).toHaveBeenCalledWith(17, {
        importance: 2,
      });
    });
  });

  it("shows the drawer explanation for the canonical logical page without replacing manual importance", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({
      logicalImportance: false,
      priorityAssessmentWriter: false,
      priorityReaders: true,
      priorityShadow: true,
    });
    mocks.fetchPriorityReadBatch.mockResolvedValue([priorityRead()]);
    renderDrawer();

    expect(await screen.findByRole("heading", { name: "AI priority" })).toBeTruthy();
    expect(await screen.findByText("You: 1")).toBeTruthy();
    expect(screen.getByText("AI: 78")).toBeTruthy();
    expect(screen.getByText("Has a shareable next action")).toBeTruthy();
    expect(screen.getAllByText("Captured content")).toHaveLength(2);
    expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledWith(
      [prioritySubject],
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("button", { name: "1" }).getAttribute("aria-pressed")).toBe("true");
    expect(mocks.patchTabDetails).not.toHaveBeenCalled();
  });

  it("hides cached drawer priority data when the current feature refresh fails", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({
      logicalImportance: false,
      priorityAssessmentWriter: false,
      priorityReaders: true,
      priorityShadow: true,
    });
    mocks.fetchPriorityReadBatch.mockResolvedValue([priorityRead()]);
    const queryClient = renderDrawer();

    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByText("Has a shareable next action")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();

    mocks.fetchFeatureFlags.mockRejectedValueOnce(
      new Error("Feature refresh failed"),
    );
    await queryClient.refetchQueries({ queryKey: ["features"] });

    await waitFor(() => expect(mocks.fetchFeatureFlags).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "AI priority" })).toBeNull();
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.queryByText("Has a shareable next action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
    expect(screen.getByRole("button", { name: "1" })).toBeTruthy();

    let resolveFeatures: ((value: FeatureFlagsResponse) => void) | undefined;
    mocks.fetchFeatureFlags.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveFeatures = resolve;
      }),
    );
    const refresh = queryClient.refetchQueries({ queryKey: ["features"] });
    expect(screen.queryByRole("heading", { name: "AI priority" })).toBeNull();
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
    resolveFeatures?.({
      logicalImportance: false,
      priorityAssessmentWriter: false,
      priorityReaders: true,
      priorityShadow: true,
    });
    await refresh;
    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();
  });
});
