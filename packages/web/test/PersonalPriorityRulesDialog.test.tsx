// @vitest-environment jsdom

import type {
  PersonalPriorityLifecycleRequest,
} from "@tabhub/shared";
import { personalPriorityNaturalLanguageGrammarV1 } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, useI18n } from "../src/i18n";
import { PersonalPriorityRulesDialog } from "../src/PersonalPriorityRulesDialog";
import type {
  fetchPersonalPriorityRules as fetchRulesType,
  previewPersonalPriorityRules as previewRulesType,
} from "../src/api";

const mocks = vi.hoisted(() => ({
  changePersonalPriorityRules: vi.fn(),
  fetchPersonalPriorityRules: vi.fn(),
  fetchPersonalPriorityRulesVersion: vi.fn(),
  fetchPriorityRecomputeJob: vi.fn(),
  previewPersonalPriorityRules: vi.fn(),
  submitPriorityRecompute: vi.fn(),
}));
vi.mock("../src/api", () => mocks);

const baselineRef = { rulesetId: 1, version: 1 };
const state: Awaited<ReturnType<typeof fetchRulesType>> = {
  name: "Personal priority rules", baselineRef, activeRef: baselineRef,
  latestVersion: null, versions: [], versionCount: 0, historyTruncated: false,
  recomputeRequired: false, staleOutcomeCount: 0,
};
const preview: Awaited<ReturnType<typeof previewRulesType>> = {
  compiler: { kind: "natural_language", compilerVersion: "priority-rule-natural-language-v1",
    sourceSpans: [{ ruleKey: "personal.nl.abc.0", rule: { start: 0, end: 56 },
      conditions: [{ start: 11, end: 30 }], effects: [{ start: 36, end: 56 }] }],
    readableRules: [{ ruleKey: "personal.nl.abc.0", en: "Open pages gain 10",
      ru: "Открытые страницы получают 10" }] },
  candidate: { additions: [{ ruleKey: "personal.nl.abc.0", priority: 100,
    label: "Open pages gain 10", appliesTo: "page",
    when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
    effect: { scoreDelta: 10 } }], astHash: "b".repeat(64),
    naturalLanguageSource: "pages when is open equals true then score add 10", totalRuleCount: 9 },
  diff: { added: ["personal.nl.abc.0"], changed: [], removed: [] },
  examples: [{ logicalPageId: 17, display: { title: "Private project",
    representativeUrl: "https://example.com/private" }, stratum: "band_changed",
    before: { kind: "assessment", agentScore: 20, agentBand: "low", confidence: 0.8,
      needsReview: false, reasons: [], missingSignals: [] },
    after: { kind: "assessment", agentScore: 30, agentBand: "medium", confidence: 0.8,
      needsReview: false, reasons: [], missingSignals: [] } }],
  eligibleCount: 1, scannedCount: 1, strataCounts: { exclusionChanged: 0, bandChanged: 1, assessmentChanged: 0, unchanged: 0 }, comparedActiveRef: baselineRef,
  comparedActiveAstHash: "a".repeat(64), requestFingerprint: "c".repeat(64),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

function renderDialog(writer = true, locale: "en" | "ru" = "en") {
  mocks.fetchPersonalPriorityRules.mockResolvedValue(state);
  mocks.previewPersonalPriorityRules.mockResolvedValue(preview);
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  render(<QueryClientProvider client={client}><I18nProvider initialLocale={locale}>
    <PersonalPriorityRulesDialog canMutateAndRecompute={writer} onDismiss={vi.fn()} />
  </I18nProvider></QueryClientProvider>);
  return client;
}

describe("PersonalPriorityRulesDialog", () => {
  it("consumes the frozen shared EN/RU grammar and exposes structured plus natural drafts", async () => {
    expect(Object.isFrozen(personalPriorityNaturalLanguageGrammarV1)).toBe(true);
    renderDialog(false, "ru");
    expect(await screen.findByRole("heading", {
      name: "Персональные правила приоритета",
    })).toBeTruthy();
    expect(await screen.findByText(
      personalPriorityNaturalLanguageGrammarV1.locales.ru.ruleTemplate,
    ))
      .toBeTruthy();
    expect(screen.getByRole("tab", { name: "Естественный язык" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Структурированные правила" })).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "Активировать сохранённую версию",
    })).toBeNull();
  });

  it("requires a fresh compared-active preview, saves inactive, then activates explicitly", async () => {
    const saved = { operation: "save", target: { rulesetId: 2, version: 1 },
      activeRef: baselineRef, latestVersion: 1, requestFingerprint: "d".repeat(64),
      replayed: false, changed: true, recomputeRequired: false, staleOutcomeCount: 0 };
    mocks.changePersonalPriorityRules
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({ ...saved, operation: "activate", activeRef: saved.target,
        recomputeRequired: true });
    renderDialog();
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value:
      "pages when is open equals true then score add 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText("Private project")).toBeTruthy();
    expect(screen.getByText("https://example.com/private")).toBeTruthy();
    expect(screen.getByText(preview.comparedActiveAstHash)).toBeTruthy();
    expect(screen.getByText("Compiled conditions:")).toBeTruthy();
    expect(screen.getByText("Compiled effects:")).toBeTruthy();
    expect(screen.getByText(/is_open/)).toBeTruthy();
    expect(screen.getByText(/scoreDelta/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save inactive version" }));
    await waitFor(() => expect(mocks.changePersonalPriorityRules).toHaveBeenCalledTimes(1));
    const save = mocks.changePersonalPriorityRules.mock.calls[0]?.[0] as
      Omit<Extract<PersonalPriorityLifecycleRequest, { kind: "save" }>, "requestFingerprint">;
    expect(save.expectedActiveRef).toEqual(preview.comparedActiveRef);
    expect(await screen.findByText("Saved version 1 is inactive.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Activate saved version" }));
    expect(mocks.changePersonalPriorityRules).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    await waitFor(() => expect(mocks.changePersonalPriorityRules).toHaveBeenCalledTimes(2));
    expect(mocks.changePersonalPriorityRules.mock.calls[1]?.[0]).toMatchObject({
      kind: "activate", target: saved.target, expectedActiveRef: baselineRef,
    });
    expect(mocks.submitPriorityRecompute).not.toHaveBeenCalled();
  });

  it("discards an async preview when the draft changes and saves only the exact previewed draft", async () => {
    let resolveFirst!: (value: typeof preview) => void;
    mocks.previewPersonalPriorityRules.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveFirst = resolve; }),
    );
    mocks.changePersonalPriorityRules.mockResolvedValue({
      operation: "save", target: { rulesetId: 2, version: 1 }, activeRef: baselineRef,
      latestVersion: 1, requestFingerprint: "d".repeat(64), replayed: false,
      changed: true, recomputeRequired: false, staleOutcomeCount: 0,
    });
    renderDialog(false);
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value:
      "pages when is open equals true then score add 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(mocks.previewPersonalPriorityRules).toHaveBeenCalledOnce());
    const revisedSource = "pages when importance >= 2 then score add 10";
    fireEvent.change(source, { target: { value: revisedSource } });
    await act(() => { resolveFirst(preview); });
    expect(screen.queryByText("Private project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save inactive version" })).toBeNull();

    mocks.previewPersonalPriorityRules.mockResolvedValueOnce(preview);
    const previewAgain = screen.getByRole<HTMLButtonElement>("button", {
      name: "Preview changes",
    });
    await waitFor(() => expect(previewAgain.disabled).toBe(false));
    fireEvent.click(previewAgain);
    fireEvent.click(await screen.findByRole("button", { name: "Save inactive version" }));
    await waitFor(() => expect(mocks.changePersonalPriorityRules).toHaveBeenCalledWith(
      expect.objectContaining({ draft: {
        kind: "natural_language", locale: "en", source: revisedSource,
      } }),
    ));
  });

  it("invalidates a natural-language preview when the locale changes", async () => {
    function Harness() {
      const { setLocale } = useI18n();
      return <><button type="button" onClick={() => setLocale("ru")}>Switch RU</button>
        <PersonalPriorityRulesDialog canMutateAndRecompute={false} onDismiss={vi.fn()} />
      </>;
    }
    mocks.fetchPersonalPriorityRules.mockResolvedValue(state);
    mocks.previewPersonalPriorityRules.mockResolvedValue(preview);
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false }, mutations: { retry: false },
    } });
    render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
      <Harness />
    </I18nProvider></QueryClientProvider>);
    fireEvent.change(await screen.findByRole("textbox", { name: "Rule source" }), {
      target: { value: "pages when is open equals true then score add 10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText("Private project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch RU" }));
    await waitFor(() => expect(screen.queryByText("Private project")).toBeNull());
    expect(screen.queryByRole("button", {
      name: "Сохранить неактивную версию",
    })).toBeNull();
  });

  it("renders lifecycle preview conflicts as recoverable dialog errors", async () => {
    mocks.previewPersonalPriorityRules.mockRejectedValueOnce(Object.assign(
      new Error("server detail"),
      { code: "PRIORITY_RULESET_CONFLICT", status: 409,
        span: { start: 11, end: 30 } },
    ));
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Error at characters 11-30: Active priority rules changed. Reload them and preview again.",
    );
    expect(screen.queryByRole("alertdialog", {
      name: "Confirm rule change",
    })).toBeNull();
    expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
  });

  it("localizes a durable save receipt in Russian", async () => {
    const saved = { operation: "save", target: { rulesetId: 2, version: 4 },
      activeRef: baselineRef, latestVersion: 4, requestFingerprint: "d".repeat(64),
      replayed: false, changed: true, recomputeRequired: false, staleOutcomeCount: 0 };
    mocks.changePersonalPriorityRules.mockResolvedValue(saved);
    renderDialog(false, "ru");
    fireEvent.change(await screen.findByRole("textbox", { name: "Текст правил" }), {
      target: { value: "страницы когда открыта равно да тогда оценка плюс 10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Предпросмотр изменений" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Сохранить неактивную версию",
    }));
    expect(await screen.findByText("Версия 4 сохранена, но не активна.")).toBeTruthy();
  });

  it("starts recompute only from an explicit action and persists the job", async () => {
    mocks.submitPriorityRecompute.mockResolvedValue({
      id: "priority_assessment:17", kind: "priority_assessment", status: "queued",
    });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Recompute priority" }));
    await waitFor(() => expect(mocks.submitPriorityRecompute).toHaveBeenCalledOnce());
    expect(JSON.parse(window.localStorage.getItem("tabhub.priority-recompute.v1")!))
      .toMatchObject({ id: "priority_assessment:17", status: "queued" });
  });

  it("loads exact history and previews rollback before confirmation", async () => {
    const prior = {
      ref: { rulesetId: 2, version: 1 }, createdBy: "user" as const,
      createdAt: "2026-08-12T10:00:00.000Z", naturalLanguageSource: null,
      astHash: "d".repeat(64), additions: [], active: false,
    };
    mocks.fetchPersonalPriorityRules.mockResolvedValue({
      ...state, latestVersion: 1, versionCount: 1, versions: [prior],
    });
    mocks.fetchPersonalPriorityRulesVersion.mockResolvedValue(prior);
    mocks.previewPersonalPriorityRules.mockResolvedValue(preview);
    mocks.changePersonalPriorityRules.mockResolvedValue({
      operation: "rollback", target: prior.ref, activeRef: prior.ref, latestVersion: 1,
      requestFingerprint: "e".repeat(64), replayed: false, changed: true,
      recomputeRequired: true, staleOutcomeCount: 1,
    });
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false }, mutations: { retry: false },
    } });
    render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
      <PersonalPriorityRulesDialog canMutateAndRecompute onDismiss={vi.fn()} />
    </I18nProvider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Version 1" }));
    await waitFor(() => expect(mocks.fetchPersonalPriorityRulesVersion)
      .toHaveBeenCalledWith(prior.ref));
    fireEvent.click(await screen.findByRole("button", { name: "Preview rollback" }));
    await waitFor(() => expect(mocks.previewPersonalPriorityRules)
      .toHaveBeenCalledWith({ kind: "structured", additions: [] }));
    expect(screen.getByRole("alertdialog", { name: "Confirm rule change" })).toBeTruthy();
    expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(mocks.changePersonalPriorityRules).toHaveBeenCalledWith({
      kind: "rollback", target: prior.ref, expectedActiveRef: baselineRef,
    }));
  });

  it("resumes polling after reload and clears a superseded job", async () => {
    window.localStorage.setItem("tabhub.priority-recompute.v1", JSON.stringify({
      id: "priority_assessment:17", kind: "priority_assessment", status: "queued",
    }));
    mocks.fetchPriorityRecomputeJob.mockResolvedValue({
      id: "priority_assessment:17", kind: "priority_assessment", status: "superseded",
      progress: { completed: 0, total: null, stage: "superseded" },
    });
    renderDialog();
    await waitFor(() => expect(mocks.fetchPriorityRecomputeJob)
      .toHaveBeenCalledWith("priority_assessment:17", expect.any(AbortSignal)));
    await waitFor(() => expect(window.localStorage.getItem("tabhub.priority-recompute.v1"))
      .toBeNull());
    expect((await screen.findByRole("status")).textContent).toContain(
      "Priority recompute finished: superseded",
    );
    expect(mocks.submitPriorityRecompute).not.toHaveBeenCalled();
  });
});

describe("PersonalPriorityRulesDialog preview, in words", () => {
  it("states how many pages change, and what each example becomes", async () => {
    // The fixture's example moves low -> medium. A renderer that misreads the
    // outcome shape would say "no assessment" both sides and look plausible,
    // which is the failure that made hashes preferable to prose. Assert the
    // rendered sentence, not the payload.
    renderDialog();
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value:
      "pages when is open equals true then score add 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(await screen.findByText("1 of 1 checked pages change with this rule.")).toBeTruthy();
    expect(screen.getByText("Was importance: low, becomes importance: medium.")).toBeTruthy();
    expect(screen.getByText("Moves to a different importance band")).toBeTruthy();
  });

  it("keeps the hashes reachable rather than deleting them", async () => {
    renderDialog();
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value:
      "pages when is open equals true then score add 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    // Two disclosures carry the label: one for the preview as a whole, one per
    // compiled rule. Both are deliberate; assert the hashes rather than the count.
    expect((await screen.findAllByText("Technical detail")).length).toBeGreaterThan(0);
    expect(screen.getByText("b".repeat(64))).toBeTruthy();
  });
});
