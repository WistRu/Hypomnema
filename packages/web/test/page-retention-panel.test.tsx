// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { PageRetentionPanel } from "../src/PageRetentionPanel";

const mocks = vi.hoisted(() => ({
  fetchRetentionReview: vi.fn(),
  fetchRetentionTrash: vi.fn(),
  forgetRetentionTab: vi.fn(),
  restoreRetentionTab: vi.fn(),
  setRetentionDecision: vi.fn(),
}));

vi.mock("../src/api", () => mocks);

const tab = {
  id: 17,
  browser: "chrome",
  closedAt: "2026-08-12T09:00:00.000Z",
  faviconUrl: null,
  firstSeenAt: "2026-08-12T08:00:00.000Z",
  importance: 0 as const,
  index: 0,
  isOpen: false,
  lastSeenAt: "2026-08-12T09:00:00.000Z",
  engagedTimeMs: 0,
  foregroundTimeMs: 3_000,
  openEngagedTimeMs: 0,
  openForegroundTimeMs: 0,
  openInstanceCount: 0,
  status: "inbox" as const,
  summary: null,
  tagPaths: [],
  title: "Postal code lookup",
  url: "https://www.google.com/search?q=postal+code",
  urlNormalized: "https://www.google.com/search?q=postal+code",
  windowId: 1,
};

function renderPanel(collection: "review" | "trash") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <PageRetentionPanel collection={collection} onSelectTab={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("PageRetentionPanel", () => {
  it("explains suggestions and records an explicit keep decision", async () => {
    mocks.fetchRetentionReview.mockResolvedValue({
      items: [
        {
          tab,
          score: 0.8,
          reasons: ["closed", "search_results", "no_captured_content"],
          warnings: [],
        },
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    mocks.setRetentionDecision.mockResolvedValue({
      tabId: 17,
      decision: "keep",
      state: "kept",
      decidedBy: "user",
      decidedAt: "2026-08-12T10:00:00.000Z",
      reviewAfter: null,
      trashedAt: null,
      purgeAt: null,
    });

    renderPanel("review");

    expect(await screen.findByText("Postal code lookup")).toBeTruthy();
    expect(screen.getByText("Search results page")).toBeTruthy();
    expect(screen.getByText("No captured content")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Keep Postal code lookup" }),
    );

    await waitFor(() => {
      expect(mocks.setRetentionDecision).toHaveBeenCalledWith(17, "keep");
    });
  });

  it("requires confirmation and reports a protected close failure", async () => {
    mocks.fetchRetentionReview.mockResolvedValue({
      items: [
        {
          tab: { ...tab, isOpen: true, openInstanceCount: 1, closedAt: null },
          score: 0.62,
          reasons: ["search_results", "no_captured_content"],
          warnings: [{ kind: "open_instances", count: 1 }],
        },
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    mocks.forgetRetentionTab.mockResolvedValue({
      tabId: 17,
      outcome: "blocked",
      reason: "scope_offline",
      closedInstanceCount: 0,
      purgeAt: null,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel("review");
    expect(await screen.findByText("Open copies: 1")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close and forget Postal code lookup",
      }),
    );

    await waitFor(() => {
      expect(mocks.forgetRetentionTab).toHaveBeenCalledWith(17);
    });
    expect(
      await screen.findByRole("alert", {
        name: "The owning browser session is offline. Nothing was forgotten.",
      }),
    ).toBeTruthy();
  });

  it("shows the deletion date and restores a page from trash", async () => {
    mocks.fetchRetentionTrash.mockResolvedValue({
      items: [
        {
          tab,
          decidedBy: "user",
          trashedAt: "2026-08-12T10:00:00.000Z",
          purgeAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    mocks.restoreRetentionTab.mockResolvedValue({
      tabId: 17,
      decision: "keep",
      state: "kept",
      decidedBy: "user",
      decidedAt: "2026-08-12T10:05:00.000Z",
      reviewAfter: null,
      trashedAt: null,
      purgeAt: null,
    });

    renderPanel("trash");

    expect(await screen.findByText("Postal code lookup")).toBeTruthy();
    expect(screen.getByText(/Permanently deleted/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Postal code lookup" }),
    );

    await waitFor(() => {
      expect(mocks.restoreRetentionTab).toHaveBeenCalledWith(17);
    });
  });

  it("returns to the last valid page after the current page becomes empty", async () => {
    mocks.fetchRetentionTrash.mockImplementation(async (page: number) =>
      page === 2
        ? {
            items: [
              {
                tab,
                decidedBy: "user",
                trashedAt: "2026-08-12T10:00:00.000Z",
                purgeAt: "2026-08-19T10:00:00.000Z",
              },
            ],
            page: 2,
            pageSize: 1,
            total: 2,
          }
        : {
            items: [{ tab: { ...tab, id: 16, title: "Earlier page" }, decidedBy: "user", trashedAt: "2026-08-12T10:00:00.000Z", purgeAt: "2026-08-19T10:00:00.000Z" }],
            page: 1,
            pageSize: 1,
            total: 2,
          },
    );
    const { queryClient } = renderPanel("trash");
    expect(await screen.findByText("Earlier page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Postal code lookup")).toBeTruthy();

    mocks.fetchRetentionTrash.mockResolvedValue({
      items: [{ tab: { ...tab, id: 16, title: "Earlier page" }, decidedBy: "user", trashedAt: "2026-08-12T10:00:00.000Z", purgeAt: "2026-08-19T10:00:00.000Z" }],
      page: 1,
      pageSize: 1,
      total: 1,
    });
    await queryClient.invalidateQueries({ queryKey: ["retention", "trash"] });

    expect(await screen.findByText("Earlier page")).toBeTruthy();
    expect(screen.queryByText("Trash is empty.")).toBeNull();
  });
});
