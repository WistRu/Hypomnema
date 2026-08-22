// @vitest-environment jsdom

import type { DurableJobView, ResearchPreflight, TabInstance } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import type { ExactTabFallbackRequest } from "../src/live-acquisition-model";
import { ResearchPanel, ResearchSelectionPanel } from "../src/ResearchPanel";

const mocks = vi.hoisted(() => ({
  cancelResearchJob: vi.fn(),
  executeRelayedTabCommand: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  fetchLogicalPageByTabId: vi.fn(),
  fetchResearchJob: vi.fn(),
  fetchResearchLatestRun: vi.fn(),
  preflightResearch: vi.fn(),
  submitResearchRefinement: vi.fn(),
  submitResearchRun: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

const timestamp = "2026-08-14T10:00:00.000Z";
const target = { type: "page" as const, logicalPageId: 501 };
const budget = { maxSteps: 4, maxTokens: 20_000, maxCostUsd: 1, maxWallTimeMs: 120_000 };

function preflight(overrides: Partial<ResearchPreflight> = {}): ResearchPreflight {
  return {
    version: 1,
    target,
    approvalFingerprint: "a".repeat(64),
    corpusFingerprint: "b".repeat(64),
    coverage: { discovered: 2, captured: 1, eligible: 1, used: 0, missing: 1, failed: 0 },
    approvedBudget: budget,
    acquisitionLevel: "captured_only",
    manifest: [
      {
        ordinal: 1, logicalPageId: 501, selectedTabId: 17, contentRevision: 3,
        contentDigest: "c".repeat(64), state: "captured", exclusionReason: null,
        exclusionCategory: null, accessClass: "public", originDigest: "d".repeat(64),
        requiresConfirmation: false, failureCode: null,
        capturedChunkManifest: { version: "captured_text_chunks:v1", byteStart: 0,
          byteEnd: 100, chunkDigest: "e".repeat(64), truncated: true },
      },
      {
        ordinal: 2, logicalPageId: 502, selectedTabId: null, contentRevision: null,
        contentDigest: null, state: "missing", exclusionReason: null,
        exclusionCategory: null, accessClass: "public", originDigest: "f".repeat(64),
        requiresConfirmation: false, failureCode: null, capturedChunkManifest: null,
      },
    ],
    snapshots: [{
      kind: "page_context", ordinal: 1, snapshotDigest: "1".repeat(64),
      materialBytes: 42, truncated: false, contextEntryId: 9, logicalPageId: 501,
    }],
    confirmationRequirements: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
    confirmationDisplay: [],
    estimate: {
      estimateVersion: "research_estimate:v1", estimateKind: "reservation_envelope",
      calls: 1, inputTokens: 1_200, outputTokens: 1_024, costUsd: 1, wallTimeMs: 120_000,
    },
    requiresConfirmation: false,
    limitations: [],
    ...overrides,
  };
}

function tabInstance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: true, audible: false, browser: "chrome", browserSessionId: "session-a",
    browserTabId: 41, canonicalTabId: 17, discarded: false, engagedTimeMs: 0,
    faviconUrl: null, firstSeenAt: timestamp, foregroundTimeMs: 0, index: 0,
    installationId: "installation-a", instanceId: 71, instanceRevision: 3,
    lastSeenAt: timestamp, muted: false, pinned: false, status: "complete",
    title: "Exact copy", url: "https://secret.example/path?token=hidden", windowId: 2,
    ...overrides,
  };
}

function renderPanel(
  locale: "en" | "ru" = "en",
  instances: TabInstance[] = [],
  captureInstancesState: "ready" | "pending" | "error" = "ready",
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const rendered = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <ResearchPanel
          captureInstances={instances}
          captureInstancesState={captureInstancesState}
          entryLabel="Research this page"
          onRetryCaptureInstances={() => undefined}
          target={target}
          onRefresh={onRefresh}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(rendered, { client, onRefresh });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchResearchLatestRun.mockResolvedValue(null);
  mocks.fetchResearchJob.mockImplementation(async (id: string) => ({
    id,
    kind: "resource_research",
    subject: target,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    progress: { completed: 0, total: 1, stage: "queued" },
    canCancel: true,
    cancellationRequest: null,
    createdAt: timestamp,
    startedAt: null,
    completedAt: null,
    nextAttemptAt: null,
    error: null,
    result: null,
  } satisfies DurableJobView));
  mocks.fetchConnectedTabCommandScopes.mockResolvedValue([]);
  mocks.fetchLogicalPageByTabId.mockResolvedValue({ page: { id: 501 } });
  mocks.preflightResearch.mockResolvedValue(preflight());
  mocks.submitResearchRun.mockResolvedValue({
    id: "resource_research:9", kind: "resource_research", status: "queued",
  });
  mocks.submitResearchRefinement.mockResolvedValue({
    id: "resource_research:10", kind: "resource_research", status: "queued",
  });
});

afterEach(() => cleanup());

describe("ResearchPanel", () => {
  it("opens and focuses captured-only research when an external fallback token changes", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const view = (openRequestToken: number) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchPanel entryLabel="Research this resource" openRequestToken={openRequestToken}
            target={{ type: "resource", resourceId: 42 }} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const rendered = render(view(0));
    expect(screen.getByRole("button", { name: "Research this resource" })
      .getAttribute("aria-expanded")).toBe("false");
    rendered.rerender(view(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Research this resource" })
      .getAttribute("aria-expanded")).toBe("true"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Research preflight" }));
  });

  it("binds an external live fallback to only the exact source action and open URL", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const exact = tabInstance({ canonicalTabId: 18, instanceId: 72,
      url: "https://example.com/login", title: "Exact login tab" });
    const unrelated = tabInstance({ canonicalTabId: 19, instanceId: 73,
      url: "https://example.com/other", title: "Other tab" });
    const request: ExactTabFallbackRequest = { version: 1, jobId: "resource_research:91",
      resourceId: 42, actionId: 3, exactUrl: "https://example.com/login",
      origin: "https://example.com", reason: "AUTH_REQUIRED" };
    mocks.preflightResearch.mockResolvedValue(preflight({
      target: { type: "resource", resourceId: 42 },
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{ ...preflight().manifest[1]!, ordinal: 1 }],
      approvalFingerprint: null,
    }));
    mocks.fetchLogicalPageByTabId.mockResolvedValue({ page: { id: 502 } });
    const view = (fallback?: ExactTabFallbackRequest) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchPanel captureInstances={[exact, unrelated]}
            entryLabel="Research this resource" exactTabFallbackRequest={fallback}
            target={{ type: "resource", resourceId: 42 }} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const rendered = render(view());
    rendered.rerender(view(request));
    expect(await screen.findByText(/Run resource_research:91, action 3/)).toBeTruthy();
    expect(screen.getByText("https://example.com/login")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Research question"), {
      target: { value: "Capture the blocked source" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    await waitFor(() => expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalled());
    expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledTimes(1);
    expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledWith(18, expect.any(AbortSignal));
    expect(screen.queryByText("Other tab")).toBeNull();
  });

  it("binds refinement preflight and submission to the selected parent and compares coverage", async () => {
    const previousCoverage = {
      discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0,
    };
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchPanel
            entryLabel="Refine this report"
            refinement={{ parentReportId: 9, previousCoverage }}
            target={target}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refine this report" }));
    fireEvent.change(screen.getByLabelText("Research question"), {
      target: { value: "Investigate the missing material" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));

    expect(await screen.findByRole("table", { name: "Coverage comparison" })).toBeTruthy();
    expect(screen.getByText("Coverage compared with parent report 9")).toBeTruthy();
    expect(screen.getByRole("row", { name: "Discovered 1 2 +1" })).toBeTruthy();
    expect(screen.getByRole("row", { name: "Missing 1 1 0" })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /^Used / })).toBeNull();
    expect(screen.getByText(/Used sources are omitted because preflight usage stays zero until publication/))
      .toBeTruthy();
    expect(mocks.preflightResearch).toHaveBeenCalledWith(expect.objectContaining({
      parentReportId: 9,
      target,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Start research" }));
    await waitFor(() => expect(mocks.submitResearchRefinement).toHaveBeenCalledTimes(1));
    expect(mocks.submitResearchRefinement).toHaveBeenCalledWith(
      9,
      target,
      expect.not.objectContaining({ parentReportId: expect.anything() }),
    );
    expect(mocks.submitResearchRun).not.toHaveBeenCalled();
  });

  it("renders exact coverage, safe manifest limits, estimate, and submits the approved preflight bytes", async () => {
    const rendered = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), {
      target: { value: "What is important here?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));

    expect(await screen.findByText("Discovered")).toBeTruthy();
    expect(screen.getByText("2", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText((_, element) => element?.textContent === "Acquisition: Captured-only corpus")).toBeTruthy();
    expect(screen.getByText("1,200 input tokens")).toBeTruthy();
    expect(screen.getByText("Used")).toBeTruthy();
    expect(screen.getByText("Page 501 · Captured · Public")).toBeTruthy();
    expect(screen.getByText("Selected tab: 17")).toBeTruthy();
    expect(screen.getByText("Content revision: 3")).toBeTruthy();
    expect(screen.getByText(`Content digest: ${"c".repeat(64)}`)).toBeTruthy();
    expect(screen.getByText(`Origin digest: ${"d".repeat(64)}`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Captured chunk: bytes 0-100 · digest ${"e".repeat(64)}`)))
      .toBeTruthy();
    expect(screen.getByText(new RegExp(`Page context snapshot · context entry 9, page 501 · digest ${"1".repeat(64)}`)))
      .toBeTruthy();
    expect(screen.getByText("Shareable snapshots: 1 · 42 B")).toBeTruthy();
    expect(rendered.container.textContent).not.toContain("secret.example");
    expect(rendered.container.textContent).not.toContain("token=hidden");

    fireEvent.click(screen.getByRole("button", { name: "Start research" }));
    await waitFor(() => expect(mocks.submitResearchRun).toHaveBeenCalledTimes(1));
    expect(mocks.submitResearchRun.mock.calls[0]![0]).toEqual({
      version: 1,
      target,
      question: "What is important here?",
      includeShareableContext: true,
      maxIncludedSources: 10,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      estimate: preflight().estimate,
      approvalFingerprint: "a".repeat(64),
      idempotencyKey: expect.stringMatching(/^research-run:/),
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Research preflight" }));
    const results = await axe.run(rendered.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });

  it("requires per-run authenticated and sensitive confirmation before producing approval", async () => {
    const auth = "2".repeat(64);
    const sensitive = "3".repeat(64);
    mocks.preflightResearch
      .mockResolvedValueOnce(preflight({
        approvalFingerprint: null,
        requiresConfirmation: true,
        confirmationRequirements: {
          authenticatedOriginDigests: [auth], sensitiveOriginDigests: [sensitive],
        },
        confirmationDisplay: [
          { accessClass: "authenticated", originDigest: auth, origin: "https://account.example" },
          { accessClass: "sensitive", originDigest: sensitive, origin: "https://secure.example:8443" },
        ],
      }))
      .mockResolvedValueOnce(preflight({
        requiresConfirmation: true,
        confirmationRequirements: {
          authenticatedOriginDigests: [auth], sensitiveOriginDigests: [sensitive],
        },
        confirmationDisplay: [
          { accessClass: "authenticated", originDigest: auth, origin: "https://account.example" },
          { accessClass: "sensitive", originDigest: sensitive, origin: "https://secure.example:8443" },
        ],
      }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));

    expect(await screen.findByRole("checkbox", { name: "Confirm authenticated origins for this run" })).toBeTruthy();
    expect(screen.getByText("Authenticated origin: https://account.example")).toBeTruthy();
    expect(screen.getByText("Sensitive origin: https://secure.example:8443")).toBeTruthy();
    expect(document.body.textContent).not.toContain("/private/path");
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirm authenticated origins for this run" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirm sensitive origins for this run" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and refresh preflight" }));
    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalledTimes(2));
    expect(mocks.preflightResearch.mock.calls[1]![0].confirmedOrigins).toEqual({
      authenticatedOriginDigests: [auth], sensitiveOriginDigests: [sensitive],
    });
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
  });

  it("requires fresh authenticated and sensitive consent for a second run", async () => {
    const auth = "5".repeat(64);
    const sensitive = "6".repeat(64);
    const confirmationPreflight = (approved: boolean) => preflight({
      approvalFingerprint: approved ? "a".repeat(64) : null,
      requiresConfirmation: true,
      confirmationRequirements: {
        authenticatedOriginDigests: [auth], sensitiveOriginDigests: [sensitive],
      },
      confirmationDisplay: [
        { accessClass: "authenticated", originDigest: auth, origin: "https://account.example" },
        { accessClass: "sensitive", originDigest: sensitive, origin: "https://secure.example" },
      ],
    });
    mocks.preflightResearch
      .mockResolvedValueOnce(confirmationPreflight(false))
      .mockResolvedValueOnce(confirmationPreflight(true))
      .mockResolvedValueOnce(confirmationPreflight(false))
      .mockResolvedValueOnce(confirmationPreflight(true));
    mocks.fetchResearchJob.mockResolvedValue({
      id: "resource_research:9", kind: "resource_research", subject: target, status: "queued",
      attempts: 0, maxAttempts: 3, progress: { completed: 0, total: 3, stage: "claimed" },
      canCancel: true, cancellationRequest: null, createdAt: timestamp, startedAt: null,
      completedAt: null, nextAttemptAt: null, error: null, result: null,
    } satisfies DurableJobView);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    const authBox = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Confirm authenticated origins for this run",
    });
    const sensitiveBox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Confirm sensitive origins for this run",
    });
    fireEvent.click(authBox);
    fireEvent.click(sensitiveBox);
    fireEvent.click(screen.getByRole("button", { name: "Confirm and refresh preflight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start research" }));
    await waitFor(() => expect(mocks.submitResearchRun).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    const secondAuth = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Confirm authenticated origins for this run",
    });
    const secondSensitive = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Confirm sensitive origins for this run",
    });
    expect(secondAuth.checked).toBe(false);
    expect(secondSensitive.checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(mocks.preflightResearch.mock.calls[2]![0].confirmedOrigins).toEqual({
      authenticatedOriginDigests: [], sensitiveOriginDigests: [],
    });

    fireEvent.click(secondAuth);
    fireEvent.click(secondSensitive);
    fireEvent.click(screen.getByRole("button", { name: "Confirm and refresh preflight" }));
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
  });

  it("invalidates approval on form changes and reuses one idempotency key when the same approval is retried", async () => {
    mocks.submitResearchRun
      .mockRejectedValueOnce(new Error("Temporary network failure"))
      .mockResolvedValueOnce({ id: "resource_research:9", kind: "resource_research", status: "queued" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    const question = screen.getByLabelText("Research question");
    fireEvent.change(question, { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    const start = await screen.findByRole("button", { name: "Start research" });
    fireEvent.click(start);
    expect(await screen.findByText("Temporary network failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start research" }));
    await waitFor(() => expect(mocks.submitResearchRun).toHaveBeenCalledTimes(2));
    expect(mocks.submitResearchRun.mock.calls[0]![0].idempotencyKey)
      .toBe(mocks.submitResearchRun.mock.calls[1]![0].idempotencyKey);

    fireEvent.change(question, { target: { value: "Changed question" } });
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
  });

  it("ignores a preflight response that arrives after approval inputs change", async () => {
    let resolvePreflight!: (value: ResearchPreflight) => void;
    mocks.preflightResearch.mockReturnValueOnce(new Promise((resolve) => {
      resolvePreflight = resolve;
    }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    const question = screen.getByLabelText("Research question");
    fireEvent.change(question, { target: { value: "Old question" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalledTimes(1));

    fireEvent.change(question, { target: { value: "New question" } });
    resolvePreflight(preflight());
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", {
      name: "Prepare research",
    }).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(screen.queryByText("Discovered")).toBeNull();
  });

  it("resets target-scoped approval and active job before a late old preflight can resolve", async () => {
    const nextTarget = { type: "resource" as const, resourceId: 7 };
    let resolveOldPreflight!: (value: ResearchPreflight) => void;
    mocks.preflightResearch
      .mockResolvedValueOnce(preflight())
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOldPreflight = resolve;
      }))
      .mockResolvedValueOnce(preflight({ target: nextTarget }));
    const oldJob: DurableJobView = {
      id: "resource_research:9", kind: "resource_research", subject: target, status: "running",
      attempts: 1, maxAttempts: 3, progress: { completed: 1, total: 3, stage: "provider_ready" },
      canCancel: true, cancellationRequest: null, createdAt: timestamp, startedAt: timestamp,
      completedAt: null, nextAttemptAt: null, error: null, result: null,
    };
    mocks.fetchResearchJob.mockResolvedValue(oldJob);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const view = (currentTarget: typeof target | typeof nextTarget, entryLabel: string) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchPanel captureInstances={[]} entryLabel={entryLabel} target={currentTarget} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const rendered = render(view(target, "Research this page"));
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Old" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start research" }));
    expect(await screen.findByText("Research: running")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalledTimes(2));
    rendered.rerender(view(nextTarget, "Research this resource"));

    expect(screen.getByRole("button", { name: "Research this resource" }).getAttribute("aria-expanded"))
      .toBe("false");
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel research" })).toBeNull();
    expect(screen.queryByText("Research: running")).toBeNull();
    await waitFor(() => expect(mocks.fetchResearchLatestRun).toHaveBeenCalledWith(
      nextTarget,
      expect.any(AbortSignal),
    ));

    resolveOldPreflight(preflight());
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(screen.queryByText("Research: running")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Research this resource" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
    expect(mocks.preflightResearch.mock.calls[2]![0]).toMatchObject({
      target: nextTarget,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
    });
  });

  it("discards a stale approval and requires a wholly new preflight", async () => {
    mocks.submitResearchRun.mockRejectedValueOnce(Object.assign(
      new Error("unsafe stale detail"), { code: "RESEARCH_PREFLIGHT_STALE" },
    ));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start research" }));

    expect(await screen.findByText("The approved research preflight is stale. Prepare it again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(screen.getByRole("button", { name: "Prepare research" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Research preflight" }));
  });

  it.each([
    ["FEATURE_DISABLED", "Research is disabled. Enable it and prepare a new preflight."],
    ["RESEARCH_PROVIDER_UNAVAILABLE", "The research provider is unavailable. Check provider settings and try again."],
    ["JOB_BUDGET_EXHAUSTED", "The research budget is exhausted. Reduce the scope or approve a new budget."],
  ])("shows typed %s failures without server detail", async (code, expected) => {
    mocks.preflightResearch.mockRejectedValueOnce(Object.assign(new Error("unsafe server detail"), { code }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect((await screen.findByRole("alert")).textContent).toBe(expected);
  });

  it("reuses exact-copy capture without URL opening, requires a choice for duplicates, and refreshes preflight", async () => {
    const first = tabInstance({ title: "First copy" });
    const second = tabInstance({
      browserTabId: 42,
      instanceId: 72,
      title: "Second copy",
    });
    const missing = preflight({
      approvalFingerprint: "a".repeat(64),
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{
        ordinal: 1, logicalPageId: 501, selectedTabId: null, contentRevision: null,
        contentDigest: null, state: "missing", exclusionReason: null,
        exclusionCategory: null, accessClass: "public", originDigest: "f".repeat(64),
        requiresConfirmation: false, failureCode: null, capturedChunkManifest: null,
      }],
      estimate: { ...preflight().estimate, calls: 0, inputTokens: 0, outputTokens: 0,
        costUsd: 0, wallTimeMs: 0 },
    });
    mocks.preflightResearch.mockResolvedValueOnce(missing).mockResolvedValueOnce(preflight({
      coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
      manifest: [preflight().manifest[0]!],
    }));
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([{
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      connectedAt: timestamp, lastSeenAt: timestamp, protocolVersion: 5,
    }]);
    mocks.executeRelayedTabCommand.mockImplementation(async (request: any) => ({
      kind: "capture-tab-content",
      target: request.command.target,
      outcome: {
        status: "captured",
        receipt: {
          browserTabId: 42, canonicalTabId: 17, capturedUrl: second.url,
          contentRevision: 4, extractedAt: timestamp, firstSeenAt: timestamp,
          instanceId: 72, instanceRevision: 3,
        },
      },
    }));

    const rendered = renderPanel("en", [first, second]);
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText("No eligible captured pages")).toBeTruthy();
    const capture = screen.getByRole<HTMLButtonElement>("button", { name: "Capture selected open pages" });
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
    expect(capture.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Second copy/ }));
    expect(capture.disabled).toBe(false);
    fireEvent.click(capture);

    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledTimes(1));
    expect(mocks.executeRelayedTabCommand.mock.calls[0]![0]).toMatchObject({
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      command: {
        kind: "capture-tab-content",
        target: {
          instanceId: 72, tabId: 42, expectedUrl: second.url,
          expectedInstanceRevision: 3, expectedFirstSeenAt: timestamp,
        },
      },
    });
    expect(rendered.onRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalledTimes(2));
    expect(mocks.preflightResearch.mock.calls[1]![0].captureIntent).toEqual({
      selectedTabIds: [17], knownFailures: [],
    });
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Research preflight" }));
  });

  it("does not carry old exact-capture intent or outcomes into a new target", async () => {
    const current = tabInstance({ title: "Old exact copy" });
    const nextTarget = { type: "resource" as const, resourceId: 7 };
    const missing = preflight({
      approvalFingerprint: "a".repeat(64),
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{
        ordinal: 1, logicalPageId: 501, selectedTabId: null, contentRevision: null,
        contentDigest: null, state: "missing", exclusionReason: null,
        exclusionCategory: null, accessClass: "public", originDigest: "f".repeat(64),
        requiresConfirmation: false, failureCode: null, capturedChunkManifest: null,
      }],
      snapshots: [],
      estimate: { ...preflight().estimate, calls: 0, inputTokens: 0, outputTokens: 0,
        costUsd: 0, wallTimeMs: 0 },
    });
    mocks.preflightResearch
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight({ target: nextTarget }));
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([{
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      connectedAt: timestamp, lastSeenAt: timestamp, protocolVersion: 5,
    }]);
    mocks.executeRelayedTabCommand.mockImplementation(async (request: any) => ({
      kind: "capture-tab-content",
      target: request.command.target,
      outcome: {
        status: "captured",
        receipt: {
          browserTabId: 41, canonicalTabId: 17, capturedUrl: current.url,
          contentRevision: 4, extractedAt: timestamp, firstSeenAt: timestamp,
          instanceId: 71, instanceRevision: 3,
        },
      },
    }));
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const view = (currentTarget: typeof target | typeof nextTarget, copies: TabInstance[]) => (
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchPanel captureInstances={copies} entryLabel="Research" target={currentTarget} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const rendered = render(view(target, [current]));
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Old" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText("No eligible captured pages")).toBeTruthy();
    const capture = screen.getByRole<HTMLButtonElement>("button", {
      name: "Capture selected open pages",
    });
    await waitFor(() => expect(capture.disabled).toBe(false));
    fireEvent.click(capture);
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
    expect(mocks.preflightResearch.mock.calls[1]![0].captureIntent).toEqual({
      selectedTabIds: [17], knownFailures: [],
    });

    rendered.rerender(view(nextTarget, []));
    expect(screen.queryByRole("button", { name: "Start research" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Capture results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByRole("button", { name: "Start research" })).toBeTruthy();
    expect(mocks.preflightResearch.mock.calls[2]![0]).toMatchObject({
      target: nextTarget,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
    });
  });

  it("keeps a newer approved preflight when an older submit fails late as stale", async () => {
    let rejectOldSubmit!: (error: unknown) => void;
    mocks.submitResearchRun.mockReturnValueOnce(new Promise((_, reject) => {
      rejectOldSubmit = reject;
    }));
    mocks.preflightResearch.mockResolvedValue(preflight());
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    const question = screen.getByLabelText("Research question");
    fireEvent.change(question, { target: { value: "Old" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start research" }));
    await waitFor(() => expect(mocks.submitResearchRun).toHaveBeenCalledTimes(1));

    fireEvent.change(question, { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText("Discovered")).toBeTruthy();
    rejectOldSubmit(Object.assign(new Error("old stale response"), {
      code: "RESEARCH_PREFLIGHT_STALE",
    }));

    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", {
      name: "Start research",
    }).disabled).toBe(false));
    expect(screen.queryByText("The approved research preflight is stale. Prepare it again.")).toBeNull();
  });

  it("reconciles a terminal local job so a newer same-target run becomes current", async () => {
    const newerLatest = {
      runId: 10, jobId: "resource_research:10", status: "running" as const,
      parentReportId: null, reportId: null, createdAt: timestamp,
    };
    mocks.fetchResearchLatestRun
      .mockResolvedValueOnce(null)
      .mockResolvedValue(newerLatest);
    mocks.fetchResearchJob.mockImplementation(async (id: string) => ({
      id, kind: "resource_research", subject: target,
      status: id === "resource_research:9" ? "succeeded" : "running",
      attempts: 1, maxAttempts: 3,
      progress: id === "resource_research:9"
        ? { completed: 3, total: 3, stage: "terminal_publication" }
        : { completed: 1, total: 4, stage: "provider_ready" },
      canCancel: id !== "resource_research:9", cancellationRequest: null,
      createdAt: timestamp, startedAt: timestamp,
      completedAt: id === "resource_research:9" ? timestamp : null,
      nextAttemptAt: null, error: null, result: null,
    } satisfies DurableJobView));
    mocks.cancelResearchJob.mockImplementation(async () => mocks.fetchResearchJob("resource_research:10"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start research" }));

    expect(await screen.findByText("Stage: provider_ready · 1/4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel research" }));
    await waitFor(() => expect(mocks.cancelResearchJob).toHaveBeenCalledWith("resource_research:10"));
  });

  it("offers optional exact capture for mixed eligible and missing coverage without blocking Start", async () => {
    mocks.fetchLogicalPageByTabId.mockResolvedValue({ page: { id: 502 } });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([{
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      connectedAt: timestamp, lastSeenAt: timestamp, protocolVersion: 5,
    }]);
    renderPanel("en", [tabInstance()]);
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));

    expect(await screen.findByText("Improve the captured corpus")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start research" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture selected open pages" })).toBeTruthy();
  });

  it("allows recapture only for the recoverable empty-captured-text exclusion", async () => {
    const excluded = preflight().manifest[0]!;
    const excludedPreflight = (reason: "empty_captured_text" | "embedded_credentials") => preflight({
      coverage: { discovered: 1, captured: 1, eligible: 0, used: 0, missing: 0, failed: 0 },
      manifest: [{ ...excluded, state: "excluded", exclusionReason: reason,
        exclusionCategory: reason === "empty_captured_text" ? "size" : "privacy" }],
      limitations: [reason],
    });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([{
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      connectedAt: timestamp, lastSeenAt: timestamp, protocolVersion: 5,
    }]);
    mocks.preflightResearch.mockResolvedValueOnce(excludedPreflight("empty_captured_text"));
    renderPanel("en", [tabInstance()]);
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByRole("button", { name: "Capture selected open pages" })).toBeTruthy();

    cleanup();
    mocks.preflightResearch.mockResolvedValueOnce(excludedPreflight("embedded_credentials"));
    renderPanel("en", [tabInstance()]);
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText(/Limitation: URL contains embedded credentials/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Capture selected open pages" })).toBeNull();
  });

  it("does not report no copies while caller-owned copy data is loading or failed", async () => {
    const missing = preflight({
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{ ...preflight().manifest[1]!, ordinal: 1 }], snapshots: [],
    });
    mocks.preflightResearch.mockResolvedValue(missing);
    renderPanel("en", [], "pending");
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText("Checking exact open copies...")).toBeTruthy();
    expect(screen.queryByText("No already-open exact copies are available for missing pages.")).toBeNull();

    cleanup();
    renderPanel("en", [], "error");
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    expect(await screen.findByText(/Open-copy data could not be loaded for capture/)).toBeTruthy();
    expect(screen.queryByText("No already-open exact copies are available for missing pages.")).toBeNull();
  });

  it.each([
    ["scopes", "Connected browser scopes could not be loaded for capture."],
    ["mapping", "Open copies could not be mapped to logical pages."],
  ])("shows an actionable %s lookup error without a false empty-copy conclusion", async (kind, message) => {
    const missing = preflight({
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{ ...preflight().manifest[1]!, ordinal: 1 }], snapshots: [],
    });
    mocks.preflightResearch.mockResolvedValue(missing);
    if (kind === "scopes") mocks.fetchConnectedTabCommandScopes.mockRejectedValue(new Error("offline"));
    else mocks.fetchLogicalPageByTabId.mockRejectedValue(new Error("mapping unavailable"));
    renderPanel("en", [tabInstance()]);
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Assess" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("No already-open exact copies are available for missing pages.")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Capture selected open pages" }).disabled)
      .toBe(true);
  });

  it("restores a durable running job after remount and only offers cancel when canCancel", async () => {
    const latest = {
      runId: 2, jobId: "resource_research:9", status: "running" as const,
      parentReportId: null, reportId: null, createdAt: timestamp,
    };
    const job: DurableJobView = {
      id: latest.jobId, kind: "resource_research", subject: target, status: "running",
      attempts: 1, maxAttempts: 3, progress: { completed: 1, total: 3, stage: "provider" },
      canCancel: true, cancellationRequest: null, createdAt: timestamp, startedAt: timestamp,
      completedAt: null, nextAttemptAt: null, error: null, result: null,
    };
    mocks.fetchResearchLatestRun.mockResolvedValue(latest);
    mocks.fetchResearchJob.mockResolvedValue(job);
    mocks.cancelResearchJob.mockResolvedValue({ ...job, canCancel: false,
      cancellationRequest: { requestedBy: "user", requestedAt: timestamp } });

    const first = renderPanel();
    expect(await screen.findByText("Research: running")).toBeTruthy();
    first.unmount();
    renderPanel();
    expect(await screen.findByText("Stage: provider · 1/3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Research this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel research" }));
    await waitFor(() => expect(mocks.cancelResearchJob).toHaveBeenCalledWith(latest.jobId));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel research" })).toBeNull());
  });

  it("refreshes history when a restored running job reaches terminal publication", async () => {
    const latest = {
      runId: 2, jobId: "resource_research:9", status: "running" as const,
      parentReportId: 4, reportId: null, createdAt: timestamp,
    };
    const running: DurableJobView = {
      id: latest.jobId, kind: "resource_research", subject: target, status: "running",
      attempts: 1, maxAttempts: 3, progress: { completed: 2, total: 3, stage: "provider" },
      canCancel: true, cancellationRequest: null, createdAt: timestamp, startedAt: timestamp,
      completedAt: null, nextAttemptAt: null, error: null, result: null,
    };
    mocks.fetchResearchLatestRun.mockResolvedValue(latest);
    mocks.fetchResearchJob.mockResolvedValue(running);
    const rendered = renderPanel();
    expect(await screen.findByText("Research: running")).toBeTruthy();
    const invalidate = vi.spyOn(rendered.client, "invalidateQueries");

    act(() => rendered.client.setQueryData(["research-job", latest.jobId], {
      ...running,
      status: "succeeded",
      canCancel: false,
      completedAt: timestamp,
      progress: { completed: 3, total: 3, stage: "terminal_publication" },
    } satisfies DurableJobView));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["research-report-history", JSON.stringify(target)],
    }));
  });

  it("maps canonical Library rows through logical pages, deduplicates, and creates one bounded selection target", async () => {
    mocks.fetchLogicalPageByTabId.mockImplementation(async (id: number) => ({
      page: { id: id === 18 ? 502 : 501 },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchSelectionPanel canonicalTabIds={[18, 17, 19, 17]} captureInstances={[]} />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Research selected pages" })).toBeTruthy();
    expect(mocks.fetchLogicalPageByTabId.mock.calls.map(([id]) => id)).toEqual([17, 18, 19]);
    fireEvent.click(screen.getByRole("button", { name: "Research selected pages" }));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Compare" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare research" }));
    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalled());
    expect(mocks.preflightResearch.mock.calls.at(-1)![0].target).toMatchObject({
      type: "selection",
      logicalPageIds: [501, 502],
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("applies the 100-page cap after physical rows map to unique logical pages", async () => {
    const physicalIds = Array.from({ length: 101 }, (_, index) => index + 1);
    mocks.fetchLogicalPageByTabId.mockImplementation(async () => ({ page: { id: 501 } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchSelectionPanel canonicalTabIds={physicalIds} captureInstances={[]} />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Research selected pages" })).toBeTruthy();
    expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledTimes(101);
  });

  it("rejects only after mapping produces more than 100 unique logical pages", async () => {
    const physicalIds = Array.from({ length: 101 }, (_, index) => index + 1);
    mocks.fetchLogicalPageByTabId.mockImplementation(async (id: number) => ({ page: { id } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ResearchSelectionPanel canonicalTabIds={physicalIds} captureInstances={[]} />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Research supports at most 100 selected logical pages.",
    );
    expect(mocks.fetchLogicalPageByTabId).toHaveBeenCalledTimes(101);
  });

  it("renders complete Russian entry and preflight copy without serious accessibility violations", async () => {
    const rendered = renderPanel("ru");
    fireEvent.click(await screen.findByRole("button", { name: "Исследовать эту страницу" }));
    fireEvent.change(screen.getByLabelText("Вопрос исследования"), {
      target: { value: "Что здесь важно?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подготовить исследование" }));
    expect(await screen.findByText("Найдено")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Запустить исследование" })).toBeTruthy();
    const results = await axe.run(rendered.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });

  it("localizes an untitled exact capture copy in Russian", async () => {
    const missing = preflight({
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      manifest: [{
        ...preflight().manifest[1]!, ordinal: 1, logicalPageId: target.logicalPageId,
      }],
      snapshots: [],
    });
    mocks.preflightResearch.mockResolvedValueOnce(missing);
    mocks.fetchConnectedTabCommandScopes.mockResolvedValueOnce([{
      browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
      connectedAt: timestamp, lastSeenAt: timestamp, protocolVersion: 5,
    }]);
    renderPanel("ru", [tabInstance({ title: "   " })]);
    fireEvent.click(screen.getByRole("button", { name: "Исследовать эту страницу" }));
    fireEvent.change(screen.getByLabelText("Вопрос исследования"), {
      target: { value: "Что важно?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подготовить исследование" }));

    expect(await screen.findByText(/Без названия/)).toBeTruthy();
    expect(screen.queryByText(/Untitled/)).toBeNull();
  });

  it("localizes every closed limitation code, snapshot kind, and USD cost in Russian", async () => {
    const reasons: ResearchPreflight["limitations"] = [
      "invalid_url", "browser_internal", "extension", "file", "data", "unsupported_scheme",
      "embedded_credentials", "localhost", "private_ip", "private_hostname",
      "registrable_domain_unavailable", "weak_sensitive_signal", "empty_captured_text",
      "source_limit", "corpus_byte_limit",
    ];
    mocks.preflightResearch.mockResolvedValueOnce(preflight({ limitations: reasons }));
    const rendered = renderPanel("ru");
    fireEvent.click(screen.getByRole("button", { name: "Исследовать эту страницу" }));
    fireEvent.change(screen.getByLabelText("Вопрос исследования"), {
      target: { value: "Что важно?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подготовить исследование" }));
    const limitations = await screen.findByText(/^Ограничения:/);
    for (const translation of [
      "Некорректный URL", "Внутренняя страница браузера", "Страница расширения браузера",
      "Локальный файл", "Встроенный data URL", "Неподдерживаемая схема URL",
      "URL содержит встроенные учётные данные", "Источник localhost",
      "Источник с частным IP-адресом", "Источник с частным именем хоста",
      "Регистрируемый домен недоступен", "Чувствительный источник нельзя безопасно подтвердить",
      "Сохранённый текст пуст", "Достигнут лимит источников", "Достигнут лимит объёма корпуса",
    ]) expect(limitations.textContent).toContain(translation);
    expect(rendered.container.textContent).toContain("Контекст страницы");
    expect(rendered.container.textContent).toMatch(/До 1,00\s?\$/);
  });

  it("shows normalized confirmation origins in Russian without exposing URL paths", async () => {
    const auth = "4".repeat(64);
    mocks.preflightResearch.mockResolvedValueOnce(preflight({
      approvalFingerprint: null,
      requiresConfirmation: true,
      confirmationRequirements: {
        authenticatedOriginDigests: [auth], sensitiveOriginDigests: [],
      },
      confirmationDisplay: [{
        accessClass: "authenticated",
        originDigest: auth,
        origin: "https://account.example",
      }],
    }));
    const rendered = renderPanel("ru");
    fireEvent.click(screen.getByRole("button", { name: "Исследовать эту страницу" }));
    fireEvent.change(screen.getByLabelText("Вопрос исследования"), {
      target: { value: "Что здесь важно?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подготовить исследование" }));

    expect(await screen.findByText("Источник с авторизацией: https://account.example")).toBeTruthy();
    expect(rendered.container.textContent).not.toContain("/private/path");
    const results = await axe.run(rendered.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });
});
