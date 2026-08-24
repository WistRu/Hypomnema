// @vitest-environment jsdom

import type { DurableJobStatus } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { useI18n } from "../src/i18n";
import { PersonalPriorityRulesDialog } from "../src/PersonalPriorityRulesDialog";

const mocks = vi.hoisted(() => ({
  changePersonalPriorityRules: vi.fn(),
  fetchPersonalPriorityRules: vi.fn(),
  fetchPersonalPriorityRulesVersion: vi.fn(),
  fetchPriorityRecomputeJob: vi.fn(),
  previewPersonalPriorityRules: vi.fn(),
  submitPriorityRecompute: vi.fn(),
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

const timestamp = "2026-08-13T10:00:00.000Z";
const baselineRef = { rulesetId: 1, version: 1 };
const rulesState = {
  name: "Personal priority rules",
  baselineRef,
  activeRef: baselineRef,
  latestVersion: null,
  versions: [],
  versionCount: 0,
  historyTruncated: false,
  recomputeRequired: false,
  staleOutcomeCount: 0,
};
const rulesPreview = {
  compiler: {
    kind: "natural_language" as const,
    compilerVersion: "priority-rule-natural-language-v1" as const,
    sourceSpans: [{
      ruleKey: "personal.nl.acceptance.0",
      rule: { start: 0, end: 50 },
      conditions: [{ start: 11, end: 30 }],
      effects: [{ start: 36, end: 50 }],
    }],
    readableRules: [{
      ruleKey: "personal.nl.acceptance.0",
      en: "Open pages gain 10",
      ru: "Open pages gain 10 RU",
    }],
  },
  candidate: {
    additions: [{
      ruleKey: "personal.nl.acceptance.0",
      priority: 100,
      label: "Open pages gain 10",
      appliesTo: "page" as const,
      when: { all: [{ signal: "is_open" as const, operator: "eq" as const, value: true }] },
      effect: { scoreDelta: 10 },
    }],
    astHash: "b".repeat(64),
    naturalLanguageSource: "pages when is open equals true then score add 10",
    totalRuleCount: 9,
  },
  diff: { added: ["personal.nl.acceptance.0"], changed: [], removed: [] },
  examples: [],
  eligibleCount: 0,
  scannedCount: 0,
  comparedActiveRef: baselineRef,
  comparedActiveAstHash: "a".repeat(64),
  requestFingerprint: "c".repeat(64),
};

function LocaleSwitch() {
  const { setLocale } = useI18n();
  return <button type="button" onClick={() => setLocale("ru")}>Switch to Russian</button>;
}

function terminalJob(status: DurableJobStatus) {
  const completedAt = timestamp;
  const error = status === "failed"
    ? { type: "durable" as const, code: "JOB_INPUT_UNAVAILABLE" as const,
      message: "Input unavailable" }
    : status === "partial"
      ? { type: "durable" as const, code: "JOB_BUDGET_EXHAUSTED" as const,
        message: "Budget exhausted" }
      : null;
  const result = status === "succeeded" || status === "partial"
    ? { type: "priority_assessment" as const, outputFingerprint: "a".repeat(64) }
    : null;
  return {
    id: "priority_assessment:17" as const,
    kind: "priority_assessment" as const,
    subject: { type: "collection" as const, scope: "all" as const },
    status,
    attempts: status === "cancelled" || status === "superseded" ? 0 : 1,
    maxAttempts: 3,
    progress: { completed: 1, total: 1, stage: status },
    canCancel: false,
    cancellationRequest: null,
    createdAt: timestamp,
    startedAt: status === "cancelled" || status === "superseded" ? null : timestamp,
    completedAt,
    nextAttemptAt: null,
    error,
    result,
  };
}

function renderTracked(status: DurableJobStatus, locale: "en" | "ru" = "en") {
  window.localStorage.setItem("tabhub.priority-recompute.v1", JSON.stringify({
    id: "priority_assessment:17",
    kind: "priority_assessment",
    status: "queued",
  }));
  mocks.fetchPersonalPriorityRules.mockResolvedValue(rulesState);
  mocks.fetchPriorityRecomputeJob.mockResolvedValue(terminalJob(status));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  render(<QueryClientProvider client={client}><I18nProvider initialLocale={locale}>
    <PersonalPriorityRulesDialog canMutateAndRecompute onDismiss={vi.fn()} />
  </I18nProvider></QueryClientProvider>);
  return client;
}

function renderRulesDialog(
  locale: "en" | "ru" = "en",
  options: { readonly onDismiss?: () => void; readonly trigger?: HTMLElement } = {},
) {
  mocks.fetchPersonalPriorityRules.mockResolvedValue(rulesState);
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  const rendered = render(<QueryClientProvider client={client}>
    <I18nProvider initialLocale={locale}>
      <PersonalPriorityRulesDialog
        canMutateAndRecompute
        onDismiss={options.onDismiss ?? vi.fn()}
        trigger={options.trigger}
      />
    </I18nProvider>
  </QueryClientProvider>);
  return { ...rendered, client };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("W60 rules and durable recompute acceptance", () => {
  it.each(["succeeded", "partial", "failed", "cancelled", "superseded"] as const)(
    "restores and exposes terminal priority job status %s without submitting another job",
    async (status) => {
      const client = renderTracked(status);
      expect(await screen.findByText(`Priority recompute finished: ${status}`, {
        exact: false,
      })).toBeTruthy();
      expect(window.localStorage.getItem("tabhub.priority-recompute.v1")).toBeNull();
      expect(mocks.submitPriorityRecompute).not.toHaveBeenCalled();
      expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
      client.clear();
    },
  );

  it("keeps recompute explicit after every lifecycle mutation", async () => {
    mocks.fetchPersonalPriorityRules.mockResolvedValue(rulesState);
    mocks.previewPersonalPriorityRules.mockResolvedValue({
      compiler: { kind: "structured", compilerVersion: null, sourceSpans: [],
        readableRules: [] },
      candidate: { additions: [], astHash: "b".repeat(64), naturalLanguageSource: null,
        totalRuleCount: 8 },
      diff: { added: [], changed: [], removed: [] },
      examples: [], eligibleCount: 0, scannedCount: 0, strataCounts: { exclusionChanged: 0, bandChanged: 0, assessmentChanged: 0, unchanged: 0 },
      comparedActiveRef: baselineRef, comparedActiveAstHash: "a".repeat(64),
      requestFingerprint: "c".repeat(64),
    });
    mocks.changePersonalPriorityRules.mockResolvedValue({
      operation: "disable", target: baselineRef, activeRef: baselineRef,
      latestVersion: null, requestFingerprint: "d".repeat(64), replayed: false,
      changed: true, recomputeRequired: true, staleOutcomeCount: 2,
    });
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false }, mutations: { retry: false },
    } });
    render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
      <PersonalPriorityRulesDialog canMutateAndRecompute onDismiss={vi.fn()} />
    </I18nProvider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Turn my rules off" }));
    expect(await screen.findByRole("alertdialog", { name: "Confirm rule change" }))
      .toBeTruthy();
    expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(mocks.changePersonalPriorityRules).toHaveBeenCalledOnce());
    expect(mocks.submitPriorityRecompute).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Recompute priority" })).toBeTruthy();
    client.clear();
  });

  it("has no serious or critical axe violations in English and Russian", async () => {
    const english = renderRulesDialog("en");
    await screen.findByRole("heading", { name: "Personal priority rules" });
    const englishResults = await axe.run(english.container);
    expect(englishResults.violations.filter(({ impact }) =>
      impact === "serious" || impact === "critical")).toEqual([]);
    english.unmount();
    english.client.clear();

    const russian = renderRulesDialog("ru");
    await screen.findByRole("dialog");
    const russianResults = await axe.run(russian.container);
    expect(russianResults.violations.filter(({ impact }) =>
      impact === "serious" || impact === "critical")).toEqual([]);
    russian.client.clear();
  });

  it("supports a trapped keyboard path, Escape dismissal, and trigger focus restoration", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open rules";
    document.body.append(trigger);
    trigger.focus();
    const onDismiss = vi.fn();
    const rendered = renderRulesDialog("en", { onDismiss, trigger });
    const dialog = await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    const recompute = await screen.findByRole("button", { name: "Recompute priority" });

    expect(document.activeElement).toBe(close);
    recompute.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
    rendered.client.clear();
  });

  it("rejects an async preview result made stale by a later draft edit", async () => {
    let resolvePreview!: (value: typeof rulesPreview) => void;
    mocks.previewPersonalPriorityRules.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    const rendered = renderRulesDialog("en");
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value: rulesPreview.candidate.naturalLanguageSource } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(mocks.previewPersonalPriorityRules).toHaveBeenCalledOnce());
    fireEvent.change(source, { target: { value: `${rulesPreview.candidate.naturalLanguageSource}!` } });
    await act(async () => {
      resolvePreview(rulesPreview);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", {
      name: "Preview changes",
    }).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Save inactive version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save inactive version" })).toBeNull();
    expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
    rendered.client.clear();
  });

  it("rejects an async preview result made stale by a locale change", async () => {
    let resolvePreview!: (value: typeof rulesPreview) => void;
    mocks.previewPersonalPriorityRules.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    mocks.fetchPersonalPriorityRules.mockResolvedValue(rulesState);
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false }, mutations: { retry: false },
    } });
    render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
      <LocaleSwitch />
      <PersonalPriorityRulesDialog canMutateAndRecompute onDismiss={vi.fn()} />
    </I18nProvider></QueryClientProvider>);
    const source = await screen.findByRole("textbox", { name: "Rule source" });
    fireEvent.change(source, { target: { value: rulesPreview.candidate.naturalLanguageSource } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(mocks.previewPersonalPriorityRules).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Switch to Russian" }));
    await act(async () => {
      resolvePreview(rulesPreview);
      await Promise.resolve();
    });

    expect(screen.queryByText(rulesPreview.candidate.astHash)).toBeNull();
    expect(mocks.changePersonalPriorityRules).not.toHaveBeenCalled();
    client.clear();
  });
});
