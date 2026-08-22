/** @vitest-environment jsdom */

import type { ContextEntry, LocalPageContextView, SessionIntentBundle, TabInstance } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, useI18n } from "../src/i18n";
import { PersonalContextPanel } from "../src/PersonalContextPanel";

const mocks = vi.hoisted(() => ({
  changeLocalPageContext: vi.fn(),
  changeLocalSessionIntent: vi.fn(),
  createLocalPairingChallenge: vi.fn(),
  fetchFeatureFlags: vi.fn(),
  fetchLocalPageContext: vi.fn(),
  fetchLocalSessionIntents: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));
vi.mock("../src/extension-bridge", () => ({
  createWindowExtensionBridge: () => ({
    probe: mocks.probe,
  }),
}));

const now = "2026-08-12T10:00:00.000Z";
const scope = {
  installationId: "122e4567-e89b-42d3-a456-426614174000",
  browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
  browserTabId: 7,
};
const subject = { type: "page" as const, logicalPageId: 41 };

function contextEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: 9,
    subject,
    entryKind: "purpose",
    body: "Compare browser APIs",
    provenance: { actor: "user", method: "manual" },
    visibility: "local_only",
    staleAt: null,
    supersedesId: null,
    state: "active",
    operation: "append",
    revision: 1,
    idempotencyKey: "local:key",
    createdAt: now,
    withdrawnAt: null,
    currentReview: null,
    ...overrides,
  };
}

function pageView(entries: ContextEntry[] = []): LocalPageContextView {
  return {
    context: { subject, entries, currentEntries: entries, preview: null },
    affectedBrowserPageCount: 3,
  };
}

const intent = {
  id: 12,
  scope,
  subject,
  expectedPage: {
    logicalPageId: 41,
    url: "https://example.com/docs",
    urlNormalized: "https://example.com/docs",
    instanceRevision: 1,
  },
  body: "Compare this exact copy",
  provenance: { actor: "user" as const, method: "manual" as const },
  visibility: "local_only" as const,
  staleAt: null,
  state: "active" as const,
  idempotencyKey: "local:intent",
  archivedAt: null,
  expiresAt: null,
  promotedContextEntryId: null,
  createdAt: now,
  updatedAt: now,
};
const intentBundle: SessionIntentBundle = { scope, current: intent, history: [intent] };

function instance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    instanceId: 1,
    canonicalTabId: 17,
    installationId: scope.installationId,
    browserSessionId: scope.browserSessionId,
    browserTabId: 7,
    url: "https://example.com/docs",
    urlNormalized: "https://example.com/docs",
    title: "Docs",
    browser: "chrome",
    windowId: 2,
    index: 0,
    faviconUrl: null,
    active: true,
    audible: false,
    muted: false,
    discarded: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: now,
    lastSeenAt: now,
    foregroundTimeMs: 0,
    engagedTimeMs: 0,
    status: "inbox",
    importance: 0,
    summary: null,
    ...overrides,
  };
}

function LocaleToggle() {
  const { locale, setLocale } = useI18n();
  return (
    <button type="button" onClick={() => setLocale(locale === "en" ? "ru" : "en")}>
      Switch locale
    </button>
  );
}

function renderPanel(options: { entries?: ContextEntry[]; exactScopeRequest?: { instanceId: number; nonce: number }; instances?: TabInstance[]; locale?: "en" | "ru"; withLocaleToggle?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={options.locale ?? "en"}>
        {options.withLocaleToggle ? <LocaleToggle /> : null}
        <PersonalContextPanel exactScopeRequest={options.exactScopeRequest} instances={options.instances ?? [instance()]} tabId={17} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchFeatureFlags.mockResolvedValue({ context: true, logicalImportance: false });
  mocks.fetchLocalPageContext.mockResolvedValue(pageView());
  mocks.fetchLocalSessionIntents.mockResolvedValue(intentBundle);
  mocks.changeLocalPageContext.mockResolvedValue({ kind: "changed", operation: "append", entry: contextEntry() });
  mocks.changeLocalSessionIntent.mockResolvedValue({ kind: "set", intent });
  mocks.probe.mockResolvedValue({
    available: false,
    browser: null,
    browserSessionId: null,
    controlWindowId: null,
    installationId: null,
    pendingUndos: [],
    windows: [],
  });
});
afterEach(() => cleanup());

describe("PersonalContextPanel", () => {
  it("has no serious or critical axe violations across page and exact-tab modes in EN/RU", async () => {
    const english = renderPanel({ locale: "en" });
    await screen.findByLabelText("Why is this important?");
    const englishResults = await axe.run(english.container);
    expect(
      englishResults.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
    english.unmount();

    const russian = renderPanel({ locale: "ru" });
    fireEvent.click(await screen.findByLabelText("Только этой открытой вкладки"));
    await screen.findByLabelText("Зачем это открыто сейчас?");
    const russianResults = await axe.run(russian.container);
    expect(
      russianResults.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
  });

  it("fails closed when context is off and makes no local context call", async () => {
    mocks.fetchFeatureFlags.mockResolvedValue({ context: false, logicalImportance: false });
    renderPanel();
    await waitFor(() => expect(mocks.fetchFeatureFlags).toHaveBeenCalledOnce());
    expect(screen.queryByRole("heading", { name: "Personal context" })).toBeNull();
    expect(mocks.fetchLocalPageContext).not.toHaveBeenCalled();
  });

  it("shows page scope/copy counts and sends immutable local-only revisions", async () => {
    const original = contextEntry();
    mocks.fetchLocalPageContext.mockResolvedValue(pageView([original]));
    mocks.changeLocalPageContext.mockResolvedValue({
      kind: "changed",
      operation: "append",
      entry: contextEntry({ id: 10, supersedesId: 9, revision: 2, body: "Updated reason" }),
    });
    renderPanel({ entries: [original] });

    expect(await screen.findByText("3 browser copies")).toBeTruthy();
    expect(screen.getByText("Applies to 3 saved browser copies; 1 are open now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByLabelText("Why is this important?");
    fireEvent.change(textarea, { target: { value: "Updated reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));

    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledOnce());
    const command = mocks.changeLocalPageContext.mock.calls[0]?.[1];
    expect(command).toMatchObject({
      kind: "append",
      body: "Updated reason",
      supersedesEntryId: 9,
      visibility: "local_only",
    });
    expect(command).not.toHaveProperty("subject");
    expect(command).not.toHaveProperty("provenance");
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("reloads saved context from the server projection instead of component state", async () => {
    mocks.fetchLocalPageContext.mockResolvedValue(pageView());
    const first = renderPanel();
    const textarea = await screen.findByLabelText("Why is this important?");
    fireEvent.change(textarea, { target: { value: "Persisted after reload" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledOnce());
    first.unmount();

    mocks.fetchLocalPageContext.mockResolvedValue(
      pageView([contextEntry({ body: "Persisted after reload" })]),
    );
    renderPanel();
    expect(await screen.findByText("Persisted after reload")).toBeTruthy();
  });

  it("maps canonical dispositions, compensates withdraw with restore, and reviews an agent without changing its actor", async () => {
    const agent = contextEntry({
      id: 20,
      body: "Agent hypothesis",
      provenance: { actor: "agent", method: "on_behalf_of_user" },
      visibility: "share_with_ai",
    });
    mocks.fetchLocalPageContext.mockResolvedValue(pageView([agent]));
    mocks.changeLocalPageContext
      .mockResolvedValueOnce({ kind: "reviewed", review: { id: 1, contextEntryId: 20, verdict: "accepted", provenance: { actor: "user", method: "manual" }, idempotencyKey: "local:r", supersedesId: null, createdAt: now } })
      .mockResolvedValueOnce({ kind: "changed", operation: "withdraw", entry: contextEntry({ id: 21, state: "withdrawn", operation: "withdraw", supersedesId: 20 }) })
      .mockResolvedValueOnce({ kind: "changed", operation: "restore", entry: contextEntry({ id: 22, operation: "restore", supersedesId: 21 }) })
      .mockResolvedValueOnce({ kind: "changed", operation: "append", entry: contextEntry({ id: 23, entryKind: "disposition", body: "not_useful" }) });
    renderPanel({ entries: [agent] });

    await screen.findByText("Agent hypothesis");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledWith(41, expect.objectContaining({ kind: "review", verdict: "accepted" })));
    expect(screen.getByText("AI suggestion")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledWith(41, expect.objectContaining({ kind: "restore", entryId: 21 })));

    fireEvent.click(screen.getByRole("button", { name: "Not useful" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenLastCalledWith(41, expect.objectContaining({ entryKind: "disposition", body: "not_useful" })));
  });

  it.each([
    ["Do", "next_action", "do"],
    ["Research", "next_action", "research"],
    ["Reference", "purpose", "reference"],
    ["Compare", "next_action", "compare"],
    ["Temporary", "note", "temporary"],
    ["Not useful", "disposition", "not_useful"],
    ["Already handled", "disposition", "already_handled"],
  ] as const)(
    "prepares the %s quick chip without writing until Save",
    async (label, entryKind, body) => {
      renderPanel();

      expect(
        await screen.findByRole("group", { name: "Quick context presets" }),
      ).toBeTruthy();
      const chip = await screen.findByRole("button", { name: label });
      fireEvent.click(chip);
      expect(mocks.changeLocalPageContext).not.toHaveBeenCalled();
      expect(chip.getAttribute("aria-pressed")).toBe("true");

      const editor =
        entryKind === "disposition"
          ? screen.getByLabelText("Disposition")
          : screen.getByLabelText("Why is this important?");
      expect(document.activeElement).toBe(editor);
      expect((editor as HTMLInputElement).value).toBe(body);

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(mocks.changeLocalPageContext).toHaveBeenCalledWith(
          41,
          expect.objectContaining({ body, entryKind }),
        ),
      );
    },
  );

  it("localizes quick-chip labels while preserving stable wire tokens", async () => {
    renderPanel({ locale: "ru" });

    fireEvent.click(await screen.findByRole("button", { name: "Исследовать" }));
    expect((screen.getByLabelText("Почему это важно?") as HTMLTextAreaElement).value).toBe(
      "research",
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mocks.changeLocalPageContext).toHaveBeenCalledWith(
        41,
        expect.objectContaining({ body: "research", entryKind: "next_action" }),
      ),
    );
  });

  it("distinguishes a selected preset from manually edited text", async () => {
    renderPanel();

    const research = await screen.findByRole("button", { name: "Research" });
    fireEvent.click(research);
    expect(screen.getByText("Selected preset: Research").getAttribute("role")).toBe(
      "status",
    );

    fireEvent.change(screen.getByLabelText("Why is this important?"), {
      target: { value: "research notes" },
    });
    expect(
      screen.getByRole("button", { name: "Research" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.queryByText("Selected preset: Research")).toBeNull();
  });

  it("requires an explicit exact-copy picker and supports set/archive/promote with Russian live UI", async () => {
    const second = instance({ instanceId: 2, browserTabId: 8, windowId: 4, browser: "edge" });
    mocks.changeLocalSessionIntent
      .mockResolvedValueOnce({ kind: "set", intent })
      .mockResolvedValueOnce({ kind: "archived", intent: { ...intent, state: "archived" } })
      .mockResolvedValueOnce({ kind: "promoted", intent: { ...intent, state: "promoted", promotedContextEntryId: 9 }, context: contextEntry() });
    renderPanel({ instances: [instance(), second], locale: "ru" });

    fireEvent.click(await screen.findByLabelText("Только этой открытой вкладки"));
    expect((screen.getByLabelText("Открытая копия") as HTMLSelectElement).value).toBe("");
    expect(screen.getByLabelText("Открытая копия").querySelectorAll("option")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Открытая копия"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Зачем это открыто сейчас?"), { target: { value: "Сравнить эту копию" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(mocks.changeLocalSessionIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "set",
      scope: expect.objectContaining({ browserTabId: 8 }),
      expectedUrl: "https://example.com/docs",
      visibility: "local_only",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    fireEvent.click(screen.getByRole("button", { name: "Перенести в контекст страницы" }));
    await waitFor(() => expect(mocks.changeLocalSessionIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "promote", intentId: 12 })));
    expect(screen.getAllByRole("status").some((node) => node.getAttribute("aria-live") === "polite")).toBe(true);
  });

  it("honors the direct per-copy exact-scope request without guessing among copies", async () => {
    const second = instance({ instanceId: 2, browserTabId: 8, windowId: 4, browser: "edge" });
    renderPanel({
      exactScopeRequest: { instanceId: 2, nonce: 1 },
      instances: [instance(), second],
    });
    expect((await screen.findByLabelText("Only this open tab") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Open copy") as HTMLSelectElement).value).toBe("2");
    expect(screen.getByText(/edge · 122e4567 · window 4, tab 8 · Docs · https:\/\/example.com\/docs/)).toBeTruthy();
  });

  it("undoes an exact-intent replacement by setting the previous intent current again", async () => {
    const replacement = { ...intent, id: 13, body: "Replacement intent" };
    const restored = { ...intent, id: 14 };
    mocks.changeLocalSessionIntent
      .mockResolvedValueOnce({ kind: "set", intent: replacement })
      .mockResolvedValueOnce({ kind: "set", intent: restored });
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Only this open tab"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Why is this open now?"), {
      target: { value: replacement.body },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.changeLocalSessionIntent).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(mocks.changeLocalSessionIntent).toHaveBeenCalledTimes(2));
    expect(mocks.changeLocalSessionIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "set",
        body: intent.body,
        expectedUrl: intent.expectedPage.url,
        scope: intent.scope,
        visibility: intent.visibility,
      }),
    );
    expect(mocks.changeLocalSessionIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "archive", intentId: replacement.id }),
    );
  });

  it("requires an explicit visible page-context kind for exact-intent promotion", async () => {
    mocks.changeLocalSessionIntent.mockResolvedValueOnce({
      kind: "promoted",
      intent: { ...intent, state: "promoted", promotedContextEntryId: 9 },
      context: contextEntry({ entryKind: "question", body: intent.body }),
    });
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Only this open tab"));
    const promotionKind = await screen.findByLabelText("Promote as");
    expect((promotionKind as HTMLSelectElement).value).toBe("purpose");
    fireEvent.change(promotionKind, { target: { value: "question" } });
    fireEvent.click(screen.getByRole("button", { name: "Promote to page context" }));

    await waitFor(() =>
      expect(mocks.changeLocalSessionIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "promote",
          intentId: intent.id,
          contextKind: "question",
        }),
      ),
    );
  });

  it("shows each page-context history revision body, state, and operation", async () => {
    const current = contextEntry({ id: 10, body: "Current reason", revision: 2 });
    const historical = contextEntry({
      id: 9,
      body: "Original reason",
      operation: "withdraw",
      state: "withdrawn",
    });
    mocks.fetchLocalPageContext.mockResolvedValue({
      affectedBrowserPageCount: 3,
      context: {
        subject,
        entries: [current, historical],
        currentEntries: [current],
        preview: null,
      },
    });
    renderPanel();

    expect(await screen.findByText("Original reason")).toBeTruthy();
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
  });

  it("translates every exact-intent history state", async () => {
    mocks.fetchLocalSessionIntents.mockResolvedValue({
      scope,
      current: intent,
      history: [
        intent,
        { ...intent, id: 13, state: "archived", body: "Archived intent" },
        { ...intent, id: 14, state: "promoted", body: "Promoted intent" },
        { ...intent, id: 15, state: "expired", body: "Expired intent" },
      ],
    });
    renderPanel({ locale: "ru" });

    fireEvent.click(await screen.findByLabelText("Только этой открытой вкладки"));

    expect(await screen.findByText("Активна")).toBeTruthy();
    expect(screen.getByText("В архиве")).toBeTruthy();
    expect(screen.getByText("Перенесено")).toBeTruthy();
    expect(screen.getByText("Истекло")).toBeTruthy();
  });

  it("retranslates a visible receipt and its live announcement after a locale change", async () => {
    const view = renderPanel({ withLocaleToggle: true });
    fireEvent.change(await screen.findByLabelText("Why is this important?"), {
      target: { value: "Locale-safe receipt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.changeLocalPageContext).toHaveBeenCalledOnce());
    expect(view.container.querySelector(".context-receipt")?.textContent).toContain(
      "Personal context saved.",
    );
    expect(view.container.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Personal context saved.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch locale" }));

    expect(view.container.querySelector(".context-receipt")?.textContent).toContain(
      "Личный контекст сохранён.",
    );
    expect(view.container.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Личный контекст сохранён.",
    );
  });

  it.each([
    {
      code: "CONTEXT_STATE_INVALID",
      expected:
        "Эту запись контекста нельзя изменить в её текущем состоянии. Обновите личный контекст и повторите попытку.",
      mode: "page" as const,
    },
    {
      code: "SESSION_INTENT_STATE_INVALID",
      expected:
        "Цель этой открытой вкладки нельзя изменить в её текущем состоянии. Обновите её и повторите попытку.",
      mode: "exact" as const,
    },
    {
      code: "NOT_FOUND",
      expected:
        "Запрошенный личный контекст больше не существует. Обновите данные и повторите попытку.",
      mode: "exact" as const,
    },
  ])("shows a localized mutation alert for $code", async ({ code, expected, mode }) => {
    const serverError = Object.assign(new Error("unsafe server English"), { code });
    if (mode === "page") {
      mocks.changeLocalPageContext.mockRejectedValue(serverError);
    } else {
      mocks.changeLocalSessionIntent.mockRejectedValue(serverError);
    }
    const view = renderPanel({ locale: "ru" });

    if (mode === "page") {
      fireEvent.change(await screen.findByLabelText("Почему это важно?"), {
        target: { value: "Проверить ошибку" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    } else {
      fireEvent.click(await screen.findByLabelText("Только этой открытой вкладки"));
      fireEvent.click(await screen.findByRole("button", { name: "Архивировать" }));
    }

    expect((await screen.findByRole("alert")).textContent).toBe(expected);
    expect(view.container.textContent).not.toContain("unsafe server English");
  });

  it("offers pairing only from a probe-bound installation/origin and OK only dismisses the receipt", async () => {
    mocks.probe.mockResolvedValue({
      available: true,
      browser: "chrome",
      browserSessionId: scope.browserSessionId,
      commandProtocolVersion: 4,
      controlWindowId: 2,
      extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
      installationId: scope.installationId,
      pendingUndos: [],
      windows: [],
    });
    mocks.createLocalPairingChallenge.mockResolvedValue({
      challengeId: "322e4567-e89b-42d3-a456-426614174000",
      code: "PAIRING-CODE-DOES-NOT-ENTER-A-URL-1234567890",
      expiresAt: now,
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Pair this browser for personal context" }));
    await waitFor(() => expect(mocks.createLocalPairingChallenge).toHaveBeenCalledWith({
      extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
      installationId: scope.installationId,
    }));
    expect(await screen.findByText(/PAIRING-CODE-DOES-NOT-ENTER-A-URL/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByText(/PAIRING-CODE-DOES-NOT-ENTER-A-URL/)).toBeNull());
    expect(mocks.changeLocalPageContext).not.toHaveBeenCalled();
    expect(mocks.changeLocalSessionIntent).not.toHaveBeenCalled();
  });
});
