/** @vitest-environment jsdom */

import type {
  LiveAcquisitionRunStatus,
  ResearchPreflight,
  ResearchReportDetail,
  ResearchReportListResponse,
  TabInstance,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { LiveAcquisitionRunView } from "../src/LiveAcquisitionRunView";
import { ResearchHistoryDrawer } from "../src/ResearchHistoryDrawer";
import { ResearchPanel } from "../src/ResearchPanel";

const mocks = vi.hoisted(() => ({
  appendResourceContext: vi.fn(),
  cancelResearchJob: vi.fn(),
  changeLocalPageContext: vi.fn(),
  executeRelayedTabCommand: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  fetchLogicalPageByTabId: vi.fn(),
  fetchResearchJob: vi.fn(),
  fetchResearchLatestRun: vi.fn(),
  fetchResearchReport: vi.fn(),
  fetchResearchReports: vi.fn(),
  preflightResearch: vi.fn(),
  submitResearchRefinement: vi.fn(),
  submitResearchRun: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));
vi.mock("../src/ResearchPurgeControl", () => ({
  ResearchPurgeControl: () => null,
}));

const at = "2026-08-21T10:00:00.000Z";
const target = { type: "resource" as const, resourceId: 42 };
const budget = { maxSteps: 4, maxTokens: 20_000, maxCostUsd: 1, maxWallTimeMs: 120_000 };

function preflight(captured: boolean): ResearchPreflight {
  return {
    version: 1,
    target,
    approvalFingerprint: captured ? "a".repeat(64) : null,
    corpusFingerprint: (captured ? "b" : "c").repeat(64),
    coverage: captured
      ? { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 }
      : { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
    approvedBudget: budget,
    acquisitionLevel: "captured_only",
    manifest: [{
      sourceKind: "captured",
      acquisitionMethod: captured ? "exact_capture" : "inventory",
      ordinal: 1,
      logicalPageId: 501,
      selectedTabId: captured ? 17 : null,
      contentRevision: captured ? 4 : null,
      contentDigest: captured ? "d".repeat(64) : null,
      state: captured ? "captured" : "missing",
      exclusionReason: null,
      exclusionCategory: null,
      accessClass: "public",
      originDigest: "e".repeat(64),
      requiresConfirmation: false,
      failureCode: null,
      capturedChunkManifest: captured ? {
        version: "captured_text_chunks:v1", byteStart: 0, byteEnd: 100,
        chunkDigest: "f".repeat(64), truncated: false,
      } : null,
    }],
    snapshots: [],
    confirmationRequirements: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
    confirmationDisplay: [],
    estimate: captured
      ? { estimateVersion: "research_estimate:v1", estimateKind: "reservation_envelope",
          calls: 1, inputTokens: 600, outputTokens: 1024, costUsd: 1, wallTimeMs: 120_000 }
      : { estimateVersion: "research_estimate:v1", estimateKind: "reservation_envelope",
          calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    requiresConfirmation: false,
    limitations: [],
  };
}

function runStatus(): LiveAcquisitionRunStatus {
  return {
    version: 1,
    jobId: "resource_research:91",
    target,
    coordinator: { runId: 91, status: "superseded" },
    final: { jobId: "resource_research:92", runId: 92, status: "succeeded", reportId: 9 },
    consent: {
      state: "consumed", createdAt: at, expiresAt: "2026-08-21T10:05:00.000Z", terminalAt: at,
      approvedOrigins: ["https://example.com"],
      limits: { maxPages: 1, maxDepth: 0, durationMs: 300_000, maxCostUsd: 1,
        maxOrigins: 1, maxOutputTokens: 1024 },
      effectivePolicy: {
        egress: "local_tabhub_server", browserNetworkMayDiffer: true, method: "GET",
        sendsCookies: false, sendsCredentials: false, followsRedirects: false,
        robotsRequired: true, minCadenceMs: 2_000, maxSourceBytes: 65_536,
        maxTotalBytes: 4_194_304, dnsTimeoutMs: 3_000, connectTimeoutMs: 5_000,
        headersTimeoutMs: 8_000, bodyIdleTimeoutMs: 3_000, requestTimeoutMs: 15_000,
        maxHeaderBytes: 16_384, maxNetworkActions: 2,
        requestPolicyVersion: "safe_public_http_request:v1", ipPolicyVersion: "public_ip_policy:v1",
      },
    },
    runLiveSuccess: false,
    workflowOutcome: "captured_only",
    workflowOutcomeCode: "NO_ELIGIBLE_SOURCE",
    acquisitionOutcome: "mixed",
    counters: { reservedPages: 1, visitedPages: 1, capturedPages: 0, blockedPages: 1,
      ambiguousPages: 0, robotsActions: 1, networkActions: 2, plannedActions: 0,
      activeActions: 0 },
    actions: [{
      id: 3, kind: "page", depth: 0, state: "blocked", latestOutcome: "AUTH_REQUIRED",
      createdAt: at, terminalAt: at, exactUrl: "https://example.com/private",
      origin: "https://example.com", redacted: false, usability: "unusable",
      sourceUsable: false, omissionReason: "AUTH_REQUIRED",
      fallback: { recommendedKind: "exact_tab_capture", reason: "AUTH_REQUIRED" },
      capture: null, finalInclusion: null,
    }],
  };
}

function tabInstance(): TabInstance {
  return {
    active: true, audible: false, browser: "chrome", browserSessionId: "session-a",
    browserTabId: 41, canonicalTabId: 17, discarded: false, engagedTimeMs: 0,
    faviconUrl: null, firstSeenAt: at, foregroundTimeMs: 0, index: 0,
    installationId: "installation-a", instanceId: 71, instanceRevision: 3,
    lastSeenAt: at, muted: false, pinned: false, status: "complete",
    title: "Exact private copy", url: "https://example.com/private", windowId: 2,
  };
}

function report(): ResearchReportDetail {
  return {
    id: 9, runId: 92, jobId: "resource_research:92", runStatus: "succeeded", target,
    version: 1, parentReportId: null, publishStatus: "succeeded", state: "fresh", reason: null,
    coverage: { discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0 },
    createdAt: at,
    headFlags: { isLatestPublished: true, isCurrentFresh: true, isLastSuccessful: true },
    dossier: { executiveSummary: "Captured-only dossier", valueForUser: "Useful",
      capabilities: [], limitations: ["Captured corpus only"], risks: [], unknowns: [], nextSteps: [] },
    reportText: "Captured-only report",
    provenance: { provider: "fixture", model: "fixture-model", promptVersion: "research:v1",
      pricingVersion: "fixture:1", requestId: "request-9", generatedAt: at,
      usage: { steps: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.01, wallTimeMs: 100 },
      inputFingerprint: "1".repeat(64), terminalAttemptId: 1 },
    claims: [{ id: 1, ordinal: 1, claimDigest: "2".repeat(64), claimText: "Captured claim",
      confidence: 1, isInference: false, rationaleDigest: null, rationale: null,
      evidence: [{ id: 2, ordinal: 1, kind: "tab_content", sourceId: 17,
        sourceKind: "captured", acquisitionMethod: "exact_capture", contentRevision: 4,
        contentDigest: "3".repeat(64), state: "valid", stateReason: null,
        locatorDigest: "4".repeat(64), locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 14 },
        excerptHash: "5".repeat(64), excerpt: "Captured claim", url: "https://example.com/private",
        title: "Exact private copy" }] }],
  };
}

function Harness({ locale }: { locale: "en" | "ru" }) {
  const [openToken, setOpenToken] = useState(0);
  return <I18nProvider initialLocale={locale}>
    <LiveAcquisitionRunView exactTabFallbackActionIds={new Set([3])} status={runStatus()}
      onExactTabFallback={() => setOpenToken((value) => value + 1)} />
    <ResearchPanel captureInstances={[tabInstance()]} entryLabel="Research this resource"
      openRequestToken={openToken} target={target} />
    <ResearchHistoryDrawer researchEnabled={false} target={target} />
  </I18nProvider>;
}

function keyboardActivate(button: HTMLElement) {
  button.focus();
  fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
  // jsdom does not synthesize the browser's native click after Enter.
  fireEvent.click(button);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchResearchLatestRun.mockResolvedValue(null);
  mocks.fetchConnectedTabCommandScopes.mockResolvedValue([{
    browser: "chrome", browserSessionId: "session-a", installationId: "installation-a",
    connectedAt: at, lastSeenAt: at, protocolVersion: 5,
  }]);
  mocks.fetchLogicalPageByTabId.mockResolvedValue({ page: { id: 501 } });
  mocks.preflightResearch.mockResolvedValueOnce(preflight(false)).mockResolvedValueOnce(preflight(true));
  mocks.executeRelayedTabCommand.mockImplementation(async (request: any) => ({
    kind: "capture-tab-content", target: request.command.target,
    outcome: { status: "captured", receipt: { browserTabId: 41, canonicalTabId: 17,
      capturedUrl: tabInstance().url, contentRevision: 4, extractedAt: at, firstSeenAt: at,
      instanceId: 71, instanceRevision: 3 } },
  }));
  const summary = { id: 9, runId: 92, jobId: "resource_research:92" as const, version: 1,
    parentReportId: null, publishStatus: "succeeded" as const, state: "fresh" as const,
    reason: null, coverage: report().coverage, createdAt: at, executiveSummary: "Captured-only dossier",
    headFlags: { isLatestPublished: true, isCurrentFresh: true, isLastSuccessful: true } };
  mocks.fetchResearchReports.mockResolvedValue({ target,
    head: { latestPublishedReportId: 9, currentFreshReportId: 9, lastSuccessfulReportId: 9 },
    latestRun: null, items: [summary], nextBeforeVersion: null } satisfies ResearchReportListResponse);
  mocks.fetchResearchReport.mockResolvedValue(report());
});

afterEach(() => cleanup());

describe("W90 integrated limitation-to-dossier journey", () => {
  it.each([
    ["en", { fallback: "Use exact tab capture", question: "Research question",
      prepare: "Prepare research", empty: "No eligible captured pages",
      capture: "Capture selected open pages", start: "Start research",
      history: "Research history", view: "View report version 1",
      provenance: "Source kind: captured · acquisition method: exact_capture" }],
    ["ru", { fallback: "Сохранить точную копию вкладки", question: "Вопрос исследования",
      prepare: "Подготовить исследование", empty: "Нет подходящих сохранённых страниц",
      capture: "Сохранить выбранные открытые страницы", start: "Запустить исследование",
      history: "История исследований", view: "Открыть отчёт версии 1",
      provenance: "Тип источника: сохранено · способ получения: точное сохранение вкладки" }],
  ] as const)("preserves the exact keyboard handoff and provenance in %s", async (locale, copy) => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false },
      queries: { retry: false } } });
    const rendered = render(<QueryClientProvider client={client}><Harness locale={locale} />
      </QueryClientProvider>);

    const fallback = screen.getByRole("button", { name: copy.fallback });
    expect(fallback.closest("tr")?.textContent).toContain("https://example.com/private");
    keyboardActivate(fallback);
    expect(await screen.findByRole("heading", { name: locale === "en"
      ? "Research preflight" : "Проверка перед исследованием" })).toBe(document.activeElement);

    fireEvent.change(screen.getByLabelText(copy.question), { target: { value: "Assess" } });
    keyboardActivate(screen.getByRole("button", { name: copy.prepare }));
    expect(await screen.findByText(copy.empty)).toBeTruthy();
    const exactCopy = await screen.findByRole("radio", { name: /Exact private copy/ });
    fireEvent.click(exactCopy);
    keyboardActivate(screen.getByRole("button", { name: copy.capture }));

    await waitFor(() => expect(mocks.preflightResearch).toHaveBeenCalledTimes(2));
    expect(mocks.preflightResearch.mock.calls[1]![0].captureIntent).toEqual({
      selectedTabIds: [17], knownFailures: [],
    });
    expect(await screen.findByRole("button", { name: copy.start })).toBeTruthy();

    keyboardActivate(screen.getByRole("button", { name: copy.history }));
    keyboardActivate(await screen.findByRole("button", { name: copy.view }));
    expect(await screen.findByText(copy.provenance)).toBeTruthy();
    expect(screen.getAllByText("Captured-only dossier").length).toBeGreaterThan(0);

    const results = await axe.run(rendered.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"))
      .toEqual([]);
  });
});
