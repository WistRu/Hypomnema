// @vitest-environment jsdom

import type { LogicalPageView } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { LegacyImportanceReview } from "../src/LegacyImportanceReview";

const mocks = vi.hoisted(() => ({
  fetchLogicalPageByTabId: vi.fn(),
  setUserImportance: vi.fn(),
}));

vi.mock("../src/api", () => mocks);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function view(
  state: "legacy_unknown" | "conflict" | "confirmed",
  options: {
    userImportance?: 1 | 2 | 3 | null;
    recordedBy?: "agent" | "user" | null;
  } = {},
): LogicalPageView {
  const userImportance = options.userImportance ?? null;
  const recordedBy =
    userImportance === null ? null : (options.recordedBy ?? "user");
  return {
    page: {
      id: 41,
      identityKey: "https://example.com/research",
      urlNormalized: "https://example.com/research",
      representativeUrl: "https://example.com/research",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-12T10:00:00.000Z",
    },
    preference:
      userImportance === null
        ? {
            logicalPageId: 41,
            userImportance: null,
            recordedBy: null,
            recordMethod: null,
            importanceUpdatedAt: null,
            updatedAt: "2026-08-10T10:00:00.000Z",
          }
        : recordedBy === "agent"
          ? {
              logicalPageId: 41,
              userImportance,
              recordedBy: "agent",
              recordMethod: "on_behalf_of_user",
              importanceUpdatedAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
            }
          : {
              logicalPageId: 41,
              userImportance,
              recordedBy: "user",
              recordMethod: "manual",
              importanceUpdatedAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
            },
    legacyImportanceAudit: {
      logicalPageId: 41,
      legacyValues:
        state === "conflict"
          ? [
              { tabId: 17, browser: "chrome", value: 1 },
              { tabId: 23, browser: "edge", value: 3 },
              { tabId: 29, browser: "yandex", value: 0 },
            ]
          : [
              { tabId: 17, browser: "chrome", value: 2 },
              { tabId: 23, browser: "edge", value: 2 },
            ],
      suggestedValue: state === "legacy_unknown" ? 2 : null,
      resolutionState: state,
      createdAt: "2026-08-10T10:00:00.000Z",
      reviewedAt:
        state === "confirmed" ? "2026-08-12T10:00:00.000Z" : null,
    },
    browserPages: [
      {
        tabId: 17,
        logicalPageId: 41,
        browser: "chrome",
        url: "https://example.com/research",
        urlNormalized: "https://example.com/research",
      },
      {
        tabId: 23,
        logicalPageId: 41,
        browser: "edge",
        url: "https://example.com/research",
        urlNormalized: "https://example.com/research",
      },
    ],
  };
}

function renderReview(locale: "en" | "ru" = "en", onChanged = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <LegacyImportanceReview
          headingId="drawer-heading"
          tabId={17}
          onChanged={onChanged}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onChanged, queryClient };
}

describe("LegacyImportanceReview", () => {
  it("keeps an unknown legacy suggestion unrated until the user confirms it", async () => {
    mocks.fetchLogicalPageByTabId.mockResolvedValue(view("legacy_unknown"));
    mocks.setUserImportance.mockResolvedValue({ updated: 1, importance: 2 });
    const { onChanged } = renderReview();

    expect(
      await screen.findByRole("heading", {
        name: "Previous importance needs review",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/author is unknown/)).toBeTruthy();
    expect(screen.getByText("Chrome · 2 · Tab #17")).toBeTruthy();
    expect(screen.getByText("Edge · 2 · Tab #23")).toBeTruthy();
    expect(
      screen.getByText("Current confirmed importance: Unrated."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear importance" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(
      screen.getAllByRole("button", { name: "Set importance to 2 of 3" })[0]
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(mocks.setUserImportance).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 of 3" }));

    await waitFor(() => {
      expect(mocks.setUserImportance).toHaveBeenCalledWith([17], 2);
      expect(onChanged).toHaveBeenCalledWith(2);
    });
    expect(
      await screen.findByText("Importance saved for all browser copies."),
    ).toBeTruthy();
  });

  it("does not choose a winner for a conflict and exposes explicit set/clear actions", async () => {
    mocks.fetchLogicalPageByTabId.mockResolvedValue(view("conflict"));
    mocks.setUserImportance.mockResolvedValue({ updated: 1, importance: 3 });
    renderReview();

    expect(
      await screen.findByText(
        "Browser copies disagree about importance. TabHub has not chosen a winner.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Chrome · 1 · Tab #17")).toBeTruthy();
    expect(screen.getByText("Edge · 3 · Tab #23")).toBeTruthy();
    expect(screen.getByText("Yandex · Unrated · Tab #29")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();

    const setThree = screen.getByRole("button", {
      name: "Set importance to 3 of 3",
    });
    fireEvent.click(setThree);

    await waitFor(() => {
      expect(mocks.setUserImportance).toHaveBeenCalledWith([17], 3);
    });
  });

  it("stays compact without a pending audit while showing confirmed provenance", async () => {
    mocks.fetchLogicalPageByTabId.mockResolvedValue(
      view("confirmed", { userImportance: 2, recordedBy: "agent" }),
    );
    renderReview();

    expect(
      await screen.findByText(/Recorded by an agent on your behalf/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Previous importance needs review" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Set importance to 2 of 3" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("provides Russian copy, native keyboard controls, and live feedback semantics", async () => {
    mocks.fetchLogicalPageByTabId.mockResolvedValue(view("legacy_unknown"));
    renderReview("ru");

    expect(
      await screen.findByRole("heading", {
        name: "Нужно проверить прежнюю важность",
      }),
    ).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Подтвердить: 2 из 3" });
    expect(confirm.tagName).toBe("BUTTON");
    expect(confirm.getAttribute("type")).toBe("button");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("fails closed when canonical preference cannot be verified and leaves retry available", async () => {
    let resolveRetry: ((value: LogicalPageView) => void) | undefined;
    const retryResult = new Promise<LogicalPageView>((resolve) => {
      resolveRetry = resolve;
    });
    mocks.fetchLogicalPageByTabId
      .mockRejectedValueOnce(new Error("Canonical importance unavailable"))
      .mockImplementationOnce(() => retryResult);
    renderReview();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Canonical importance unavailable",
    );
    for (const button of screen.getAllByRole("button", {
      name: /importance/i,
    })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    const retry = screen.getByRole("button", { name: "Try again" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(
        screen.getByRole("group", { name: "Importance" }).getAttribute(
          "aria-busy",
        ),
      ).toBe("true");
    });

    await waitFor(() => {
      expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledTimes(2);
    });
    resolveRetry?.(view("conflict"));
    expect(
      await screen.findByText(
        "Browser copies disagree about importance. TabHub has not chosen a winner.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Set importance to 1 of 3",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("keeps a submitted legacy review disabled until canonical state is refreshed", async () => {
    let resolveRefetch: ((value: LogicalPageView) => void) | undefined;
    const refetch = new Promise<LogicalPageView>((resolve) => {
      resolveRefetch = resolve;
    });
    mocks.fetchLogicalPageByTabId
      .mockResolvedValueOnce(view("legacy_unknown"))
      .mockImplementationOnce(() => refetch);
    mocks.setUserImportance.mockResolvedValue({ updated: 1, importance: 2 });
    renderReview();

    const confirm = await screen.findByRole("button", {
      name: "Confirm 2 of 3",
    });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(mocks.setUserImportance).toHaveBeenCalledOnce();
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.click(confirm);
    expect(mocks.setUserImportance).toHaveBeenCalledOnce();

    resolveRefetch?.(
      view("confirmed", { userImportance: 2, recordedBy: "user" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Previous importance needs review",
        }),
      ).toBeNull();
    });
  });
});
