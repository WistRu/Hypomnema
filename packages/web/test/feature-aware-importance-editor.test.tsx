// @vitest-environment jsdom

import type { LogicalPageView } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureAwareImportanceEditor } from "../src/FeatureAwareImportanceEditor";
import { I18nProvider } from "../src/i18n";

const mocks = vi.hoisted(() => ({
  fetchFeatureFlags: vi.fn(),
  fetchLogicalPageByTabId: vi.fn(),
  setUserImportance: vi.fn(),
}));

vi.mock("../src/api", () => mocks);

const logicalView: LogicalPageView = {
  page: {
    id: 41,
    identityKey: "https://example.com/page",
    urlNormalized: "https://example.com/page",
    representativeUrl: "https://example.com/page",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  },
  preference: {
    logicalPageId: 41,
    userImportance: 2,
    recordedBy: "user",
    recordMethod: "manual",
    importanceUpdatedAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  },
  legacyImportanceAudit: null,
  browserPages: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderEditor(
  locale: "en" | "ru" = "en",
  onLegacySelect = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <FeatureAwareImportanceEditor
          headingId="drawer-heading"
          legacyBusy={false}
          legacyImportance={1}
          tabId={17}
          onCanonicalChanged={vi.fn()}
          onLegacySelect={onLegacySelect}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onLegacySelect, queryClient };
}

describe("FeatureAwareImportanceEditor", () => {
  it("renders the exact G0 scalar editor and never reads logical state when off", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({
      logicalImportance: false,
      priorityPersonalization: true,
    });
    const { onLegacySelect } = renderEditor();

    const legacyOne = await screen.findByRole("button", { name: "1" });
    expect(legacyOne.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3" })).toBeTruthy();
    expect(mocks.fetchLogicalPageByTabId).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(onLegacySelect).toHaveBeenCalledWith(2);
  });

  it("renders the canonical editor only when the runtime feature is on", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({
      logicalImportance: true,
      priorityPersonalization: true,
    });
    mocks.fetchLogicalPageByTabId.mockResolvedValue(logicalView);
    const { onLegacySelect } = renderEditor();

    expect(
      await screen.findByRole("button", { name: "Set importance to 2 of 3" }),
    ).toBeTruthy();
    expect(await screen.findByText(/Set manually by you/)).toBeTruthy();
    expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledWith(
      17,
      expect.any(AbortSignal),
    );
    expect(onLegacySelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "2" })).toBeNull();
  });

  it("fails closed while the feature contract is pending", () => {
    mocks.fetchFeatureFlags.mockReturnValue(new Promise(() => undefined));
    const { onLegacySelect } = renderEditor();

    expect(
      screen
        .getByRole("group", { name: "Importance" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "0" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Set importance to 1 of 3" }),
    ).toBeNull();
    expect(onLegacySelect).not.toHaveBeenCalled();
    expect(mocks.fetchLogicalPageByTabId).not.toHaveBeenCalled();
  });

  it("fails closed on contract errors and retries without exposing either writer", async () => {
    mocks.fetchFeatureFlags
      .mockRejectedValueOnce(new Error("Feature settings unavailable"))
      .mockResolvedValueOnce({ logicalImportance: false });
    const { onLegacySelect } = renderEditor("ru");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Feature settings unavailable",
    );
    expect(screen.queryByRole("button", { name: "0" })).toBeNull();
    expect(mocks.fetchLogicalPageByTabId).not.toHaveBeenCalled();
    expect(onLegacySelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(mocks.fetchFeatureFlags).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "0" })).toBeTruthy();
  });
});
