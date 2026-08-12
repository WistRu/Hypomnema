// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { PageRetentionActions } from "../src/PageRetentionActions";

const mocks = vi.hoisted(() => ({
  forgetRetentionTab: vi.fn(),
  setRetentionDecision: vi.fn(),
}));

vi.mock("../src/api", () => mocks);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderActions(onForgotten = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <PageRetentionActions tabId={17} onForgotten={onForgotten} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onForgotten;
}

describe("PageRetentionActions", () => {
  it("lets any page be explicitly protected from future suggestions", async () => {
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
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() => {
      expect(mocks.setRetentionDecision).toHaveBeenCalledWith(17, "keep");
    });
    expect(await screen.findByText("This page will stay in the Library.")).toBeTruthy();
  });

  it("closes every copy before forgetting an arbitrary page", async () => {
    mocks.forgetRetentionTab.mockResolvedValue({
      tabId: 17,
      outcome: "trashed",
      reason: null,
      closedInstanceCount: 2,
      purgeAt: "2026-08-19T10:00:00.000Z",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onForgotten = renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Close and forget" }));

    await waitFor(() => {
      expect(mocks.forgetRetentionTab).toHaveBeenCalledWith(17);
      expect(onForgotten).toHaveBeenCalledOnce();
    });
  });
});
