/** @vitest-environment jsdom */

import type { ResourceSummary } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { ResourceSidebar } from "../src/ResourceSidebar";

const mocks = vi.hoisted(() => ({
  changeResource: vi.fn(),
  fetchResourceReviewQueue: vi.fn(),
  fetchResources: vi.fn(),
  setResourceUserEvaluation: vi.fn(),
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

const now = "2026-08-12T10:00:00.000Z";
const youtube: ResourceSummary = {
  resource: {
    id: 7,
    resourceKey: "platform:youtube",
    name: "YouTube",
    kind: "platform",
    accessClass: "public",
    lifecycleState: "active",
    mergedIntoResourceId: null,
    createdAt: now,
    updatedAt: now,
  },
  version: 2,
  preference: { userEvaluation: null, provenance: null, updatedAt: now },
  counts: { logicalPageCount: 4, browserPageCount: 6, physicalOpenCopyCount: 2 },
  allTimeActivity: { window: "all", onScreenMs: 12_000, activeUseMs: 4_000, coverageStart: null },
  topicPaths: ["Research"],
};

function renderSidebar(
  locale: "en" | "ru" = "en",
  manualPriorityEnabled = false,
  priority?: { priorityMode: "recommended"; needsReview: true },
  reviewRequest?: { logicalPageId: number; nonce: number },
) {
  const onSelectResource = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <ResourceSidebar
          filters={{
            browser: "chrome",
            importance: 2,
            q: "video",
            status: "in_progress",
            tag: "Research",
            ...priority,
          }}
          selectedResource={null}
          manualPriorityEnabled={manualPriorityEnabled}
          onSelectResource={onSelectResource}
          reviewRequest={reviewRequest}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, onSelectResource };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchResources.mockResolvedValue({ items: [youtube], total: 1, page: 1, pageSize: 100 });
  mocks.fetchResourceReviewQueue.mockResolvedValue({
    items: [{
      logicalPageId: 41,
      urlNormalized: "https://video.example/watch",
      state: "ambiguous",
      reason: "authoritative_tie",
      candidateResourceIds: [7, 8],
      currentAssignmentId: 29,
      sourceFingerprint: "fingerprint",
      resolvedAt: now,
    }],
    total: 1,
    page: 1,
    pageSize: 100,
  });
  mocks.changeResource.mockResolvedValue({});
  mocks.setResourceUserEvaluation.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("ResourceSidebar", () => {
  it("opens the existing override flow for an external logical-page review request", async () => {
    renderSidebar("en", false, undefined, { logicalPageId: 41, nonce: 1 });

    expect(await screen.findByText("Reviewing Resource assignment for page 41.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Classification review" }).getAttribute("aria-expanded"))
      .toBe("true");
    expect(await screen.findByRole("button", { name: "Apply override" })).toBeTruthy();
    expect(document.activeElement).toBe(document.getElementById("resource-review-page-41"));
  });

  it("locates and focuses the exact requested page beyond the first 50 review items", async () => {
    const reviewItem = (logicalPageId: number) => ({
      logicalPageId,
      urlNormalized: `https://video.example/${logicalPageId}`,
      state: "unmatched" as const,
      reason: "registrable_domain_unavailable" as const,
      candidateResourceIds: [] as number[],
      currentAssignmentId: null,
      sourceFingerprint: `fingerprint-${logicalPageId}`,
      resolvedAt: now,
    });
    mocks.fetchResourceReviewQueue.mockImplementation(async (page: number) => page === 1
      ? { items: Array.from({ length: 50 }, (_, index) => reviewItem(index + 1)),
          total: 51, page: 1, pageSize: 50 }
      : { items: [reviewItem(99)], total: 51, page: 2, pageSize: 50 });

    renderSidebar("en", false, undefined, { logicalPageId: 99, nonce: 1 });

    expect(await screen.findByText("https://video.example/99")).toBeTruthy();
    await waitFor(() => expect(document.activeElement)
      .toBe(document.getElementById("resource-review-page-99")));
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(mocks.fetchResourceReviewQueue.mock.calls.some(([page]) => page === 2)).toBe(true);
  });
  it("uses the active Library intersections and selects a resource without creating a new view", async () => {
    const { onSelectResource } = renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: /YouTube/ }));
    expect(mocks.fetchResources).toHaveBeenCalledWith({
      browser: "chrome",
      importance: 2,
      page: 1,
      pageSize: 100,
      q: "video",
      status: "in_progress",
      tag: "Research",
    }, expect.any(AbortSignal));
    expect(onSelectResource).toHaveBeenCalledWith({ id: 7, name: "YouTube" });
    expect(screen.queryByRole("link", { name: "Resources" })).toBeNull();
  });

  it("propagates the same priority mode and review intersection to Resources", async () => {
    renderSidebar("en", false, {
      priorityMode: "recommended",
      needsReview: true,
    });
    await screen.findByRole("button", { name: /YouTube/ });
    expect(mocks.fetchResources).toHaveBeenCalledWith(
      expect.objectContaining({
        priorityMode: "recommended",
        needsReview: true,
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps ambiguous pages unassigned until an explicit target and sends a manual override", async () => {
    renderSidebar();
    expect(mocks.fetchResourceReviewQueue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Classification review" }));
    const apply = await screen.findByRole("button", { name: "Apply override" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.changeResource).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Assign manually"), { target: { value: "7" } });
    fireEvent.click(apply);
    await waitFor(() => expect(mocks.changeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "apply_override",
        logicalPageId: 41,
        resourceId: 7,
        expectedAssignmentId: 29,
      }),
    ));
  });

  it("accepts an exact active Resource ID beyond the bounded target list", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Classification review" }));
    await screen.findByRole("button", { name: "Apply override" });
    fireEvent.change(screen.getByLabelText("Resource ID"), { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() => expect(mocks.changeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "apply_override",
        resourceId: 999,
        expectedAssignmentId: 29,
      }),
    ));
  });

  it("applies visible Resource evaluation with an exact partial receipt", async () => {
    mocks.setResourceUserEvaluation.mockRejectedValueOnce(Object.assign(
      new Error("network disconnected"),
      { name: "TypeError" },
    ));
    renderSidebar("en", true);
    fireEvent.click(await screen.findByRole("checkbox", {
      name: "Select YouTube for bulk evaluation",
    }));
    const rating = screen.getByRole("group", {
      name: "Set evaluation for selected Resources",
    });
    expect(screen.getByText("1 Resources, 4 logical pages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set evaluation to 2 of 3" }));
    expect(await screen.findByText(
      "Resource bulk result: 0 succeeded, 0 failed, 1 unknown; 4 logical pages.",
    )).toBeTruthy();
    expect(mocks.setResourceUserEvaluation).toHaveBeenCalledWith(
      7,
      2,
      expect.stringMatching(/^resource-evaluation:[0-9a-f]{64}$/),
    );
    expect(rating).toBeTruthy();
  });

  it("has no serious or critical axe violations in English and Russian", async () => {
    const english = renderSidebar("en");
    await screen.findByRole("button", { name: /YouTube/ });
    const englishResults = await axe.run(english.container);
    expect(englishResults.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    english.unmount();

    const russian = renderSidebar("ru");
    await screen.findByRole("button", { name: /YouTube/ });
    const russianResults = await axe.run(russian.container);
    expect(russianResults.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });
});
