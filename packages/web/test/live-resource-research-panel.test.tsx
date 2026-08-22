// @vitest-environment jsdom

import type {
  LiveAcquisitionPreflight,
  LiveAcquisitionRunStatus,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api";
import { I18nProvider } from "../src/i18n";
import { LiveResourceResearchPanel } from "../src/LiveResourceResearchPanel";

const mocks = vi.hoisted(() => ({
  fetchLiveAcquisitionStatus: vi.fn(),
  preflightLiveAcquisition: vi.fn(),
  startLiveAcquisition: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

const timestamp = "2026-08-21T10:00:00.000Z";
const expiresAt = "2099-08-21T10:05:00.000Z";
const resetAt = "2099-08-22T00:00:00.000Z";

function preflight(overrides: Partial<LiveAcquisitionPreflight> = {}): LiveAcquisitionPreflight {
  return {
    version: 1,
    target: { type: "resource", resourceId: 42 },
    approvedOrigins: ["https://docs.example.com", "https://example.com"],
    limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
    researchApprovalFingerprint: "a".repeat(64),
    approvalFingerprint: "b".repeat(64),
    expiresAt,
    provider: {
      provider: "fixture", model: "fixture-model", promptVersion: "prompt-v1",
      pricingVersion: "pricing-v1", maxOutputTokens: 1_024,
    },
    rulesetVersion: 3,
    rulesetGenerationDigest: "c".repeat(64),
    resourceGenerationDigest: "d".repeat(64),
    dailyStartsRemaining: 7,
    dailyStartsResetAt: resetAt,
    effectivePolicy: {
      egress: "local_tabhub_server", browserNetworkMayDiffer: true, method: "GET",
      sendsCookies: false, sendsCredentials: false, followsRedirects: false,
      robotsRequired: true, minCadenceMs: 2_000, maxSourceBytes: 65_536,
      maxTotalBytes: 4_194_304, dnsTimeoutMs: 3_000, connectTimeoutMs: 5_000,
      headersTimeoutMs: 8_000, bodyIdleTimeoutMs: 3_000, requestTimeoutMs: 15_000,
      maxHeaderBytes: 16_384, maxNetworkActions: 12,
      requestPolicyVersion: "safe_public_http_request:v1", ipPolicyVersion: "public_ip_policy:v1",
    },
    capturedCorpus: {
      corpusFingerprint: "e".repeat(64),
      coverage: { discovered: 2, captured: 1, eligible: 1, used: 0, missing: 1, failed: 0 },
      manifest: [{
        sourceKind: "captured", acquisitionMethod: "captured", ordinal: 1,
        logicalPageId: 7, selectedTabId: 9, contentRevision: 2,
        contentDigest: "f".repeat(64), state: "captured", exclusionReason: null,
        exclusionCategory: null, accessClass: "public", originDigest: null,
        requiresConfirmation: false, failureCode: null,
        capturedChunkManifest: { version: "captured_text_chunks:v1", byteStart: 0,
          byteEnd: 512, chunkDigest: "1".repeat(64), truncated: false },
      }],
      snapshots: [],
      estimate: { estimateVersion: "research_estimate:v1", estimateKind: "reservation_envelope",
        calls: 1, inputTokens: 500, outputTokens: 1_024, costUsd: 1, wallTimeMs: 120_000 },
    },
    ...overrides,
  };
}

function status(overrides: Partial<LiveAcquisitionRunStatus> = {}): LiveAcquisitionRunStatus {
  return {
    version: 1,
    jobId: "resource_research:91",
    target: { type: "resource", resourceId: 42 },
    coordinator: { runId: 91, status: "superseded" },
    final: { jobId: "resource_research:92", runId: 92, status: "running", reportId: null },
    consent: {
      state: "consumed", createdAt: timestamp, expiresAt,
      terminalAt: "2026-08-21T10:01:00.000Z",
      approvedOrigins: ["https://docs.example.com", "https://example.com"],
      limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1,
        maxOrigins: 2, maxOutputTokens: 1_024 },
      effectivePolicy: preflight().effectivePolicy,
    },
    runLiveSuccess: true,
    workflowOutcome: "handoff",
    workflowOutcomeCode: "WORKFLOW_COMPLETED",
    acquisitionOutcome: "mixed",
    counters: { reservedPages: 2, visitedPages: 2, capturedPages: 1, blockedPages: 1,
      ambiguousPages: 0, robotsActions: 2, networkActions: 4, plannedActions: 0,
      activeActions: 0 },
    actions: [],
    ...overrides,
  };
}

function renderPanel(
  onOpenCapturedFallback = vi.fn(),
  startEnabled = true,
  onRefresh = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <LiveResourceResearchPanel resourceId={42} resourceLabel="Example docs"
          onOpenCapturedFallback={onOpenCapturedFallback} onRefresh={onRefresh}
          startEnabled={startEnabled} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, client, onOpenCapturedFallback, onRefresh };
}

function openAndFill() {
  fireEvent.click(screen.getByRole("button", { name: "Research public pages from this Resource" }));
  fireEvent.change(screen.getByLabelText("Research question"), {
    target: { value: "What is valuable here?" },
  });
  fireEvent.change(screen.getByLabelText("HTTPS origins, one per line"), {
    target: { value: "https://example.com/path\nhttps://docs.example.com/guide" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.preflightLiveAcquisition.mockResolvedValue(preflight());
  mocks.startLiveAcquisition.mockResolvedValue({
    id: "resource_research:91", kind: "resource_research", status: "queued",
  });
  mocks.fetchLiveAcquisitionStatus.mockResolvedValue(status());
});

afterEach(() => cleanup());

describe("LiveResourceResearchPanel", () => {
  it("stays closed initially and sends a canonical Resource-only preflight", async () => {
    renderPanel();
    expect(screen.queryByRole("heading", { name: "Live Resource research" })).toBeNull();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await waitFor(() => expect(mocks.preflightLiveAcquisition).toHaveBeenCalledTimes(1));
    expect(mocks.preflightLiveAcquisition.mock.calls[0]![0]).toMatchObject({
      version: 1,
      approvedOrigins: ["https://docs.example.com", "https://example.com"],
      limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
      research: { target: { type: "resource", resourceId: 42 },
        question: "What is valuable here?", includeShareableContext: true,
        maxIncludedSources: 10 },
    });
  });

  it("shows exact server policy, corpus and network disclosures", async () => {
    renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    expect(await screen.findByRole("heading", { name: "Exact consent returned by TabHub" }))
      .toBeTruthy();
    expect(screen.getByText(/local TabHub server, not the browser/i)).toBeTruthy();
    expect(screen.getByText(/No cookies, credentials, or authorization headers/i)).toBeTruthy();
    expect(screen.getByText(/Redirects are rejected/i)).toBeTruthy();
    expect(screen.getByText(/Robots policy is checked/i)).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Captured corpus coverage" })).toBeTruthy();
    expect(screen.getByText(/fixture-model/)).toBeTruthy();
  });

  it("invalidates consent on any changed approval input", async () => {
    renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    fireEvent.change(screen.getByLabelText("Maximum pages"), { target: { value: "11" } });
    expect(screen.queryByRole("heading", { name: "Exact consent returned by TabHub" })).toBeNull();
  });

  it("does not restore a stale review that returns after an input change", async () => {
    let resolveReview: ((value: LiveAcquisitionPreflight) => void) | undefined;
    mocks.preflightLiveAcquisition.mockReturnValue(new Promise((resolve) => {
      resolveReview = resolve;
    }));
    renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await waitFor(() => expect(mocks.preflightLiveAcquisition).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Maximum pages"), { target: { value: "11" } });
    await act(async () => { resolveReview!(preflight()); });
    expect(screen.queryByRole("heading", { name: "Exact consent returned by TabHub" })).toBeNull();
  });

  it("requires exact approval, prevents duplicate starts, and Enter in question never starts", async () => {
    renderPanel();
    openAndFill();
    fireEvent.keyDown(screen.getByLabelText("Research question"), { key: "Enter" });
    expect(mocks.startLiveAcquisition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    const start = await screen.findByRole("button", { name: "Start approved live research" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I approve this exact Resource/));
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(mocks.startLiveAcquisition).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Live Resource research" }),
    ));
  });

  it("preserves typed daily remaining/reset details", async () => {
    mocks.startLiveAcquisition.mockRejectedValue(new ApiRequestError(
      "budget exhausted", "JOB_BUDGET_EXHAUSTED", 429, undefined,
      { dailyStartsRemaining: 0, dailyStartsResetAt: resetAt },
    ));
    renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    fireEvent.click(screen.getByLabelText(/I approve this exact Resource/));
    fireEvent.click(screen.getByRole("button", { name: "Start approved live research" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/0 remain.*UTC/i);
  });

  it("polls and distinguishes mixed and zero-usable acquisition outcomes", async () => {
    const rendered = renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    fireEvent.click(screen.getByLabelText(/I approve this exact Resource/));
    fireEvent.click(screen.getByRole("button", { name: "Start approved live research" }));
    expect(await screen.findByText("Mixed live acquisition completed")).toBeTruthy();
    mocks.fetchLiveAcquisitionStatus.mockResolvedValue(status({
      acquisitionOutcome: "zero_usable", runLiveSuccess: false, final: null,
      workflowOutcome: "captured_only", workflowOutcomeCode: "NO_ELIGIBLE_SOURCE",
    }));
    await rendered.client.invalidateQueries({ queryKey: ["live-acquisition-status"] });
    expect(await screen.findByText("No usable live sources")).toBeTruthy();
    expect(screen.getByText("Final research has not started")).toBeTruthy();
  });

  it("routes a typed fallback with its exact run/action/source binding", async () => {
    mocks.fetchLiveAcquisitionStatus.mockResolvedValue(status({
      actions: [{ id: 3, kind: "page", depth: 0, state: "blocked",
        latestOutcome: "AUTH_REQUIRED", createdAt: timestamp, terminalAt: timestamp,
        exactUrl: "https://example.com/login", origin: "https://example.com",
        redacted: false, usability: "unusable", sourceUsable: false,
        omissionReason: "AUTH_REQUIRED",
        fallback: { recommendedKind: "exact_tab_capture", reason: "AUTH_REQUIRED" },
        capture: null, finalInclusion: null }],
    }));
    const rendered = renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    fireEvent.click(screen.getByLabelText(/I approve this exact Resource/));
    fireEvent.click(screen.getByRole("button", { name: "Start approved live research" }));
    const fallback = await screen.findByRole("button", { name: "Use exact tab capture" });
    fireEvent.click(fallback);
    expect(rendered.onOpenCapturedFallback).toHaveBeenCalledWith({
      version: 1, jobId: "resource_research:91", resourceId: 42, actionId: 3,
      exactUrl: "https://example.com/login", origin: "https://example.com",
      reason: "AUTH_REQUIRED",
    });
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Live Resource research" }),
    ));
  });

  it("restores a safe reviewed summary after reload without restoring approval or source material", async () => {
    const first = renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    expect(window.localStorage.getItem("tabhub.live-acquisition.review-summary.v1"))
      .not.toMatch(/https:\/\/|logicalPageId|corpusFingerprint|snapshot/u);
    first.unmount();

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Research public pages from this Resource" }));
    expect(screen.getByRole("heading", { name: "Previous live review summary" })).toBeTruthy();
    expect(screen.getByText("Daily starts remaining: 7")).toBeTruthy();
    expect(screen.getByText(/Estimate: 1 calls, 500 input tokens, 1,024 output tokens/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start approved live research" })).toBeNull();
    expect(screen.queryByText("https://docs.example.com")).toBeNull();
  });

  it("renders explicit zero states for an empty captured manifest", async () => {
    mocks.preflightLiveAcquisition.mockResolvedValue(preflight({ capturedCorpus: {
      ...preflight().capturedCorpus,
      coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
      manifest: [],
    } }));
    renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    expect(await screen.findByText("No captured corpus entries were returned.")).toBeTruthy();
  });

  it("has no basic axe violations in the reviewed state", async () => {
    const rendered = renderPanel();
    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Review live research" }));
    await screen.findByRole("heading", { name: "Exact consent returned by TabHub" });
    expect((await axe.run(rendered.container)).violations).toEqual([]);
  });

  it("restores and reads a persisted Resource job while new live starts are disabled", async () => {
    window.localStorage.setItem("tabhub.live-acquisition.active-job.v1", JSON.stringify({
      jobId: "resource_research:91", resourceId: 42,
    }));
    renderPanel(vi.fn(), false);
    expect(screen.queryByRole("button", {
      name: "Research public pages from this Resource",
    })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Live acquisition audit" })).toBeTruthy();
    expect(mocks.preflightLiveAcquisition).not.toHaveBeenCalled();
    expect(mocks.startLiveAcquisition).not.toHaveBeenCalled();
    expect(mocks.fetchLiveAcquisitionStatus).toHaveBeenCalledWith(
      "resource_research:91", expect.any(AbortSignal),
    );
  });

  it("refreshes Resource and report history once after terminal evidence is readable", async () => {
    window.localStorage.setItem("tabhub.live-acquisition.active-job.v1", JSON.stringify({
      jobId: "resource_research:91", resourceId: 42,
    }));
    mocks.fetchLiveAcquisitionStatus.mockResolvedValue(status({
      acquisitionOutcome: "live_complete",
      final: { jobId: "resource_research:92", runId: 92, status: "succeeded", reportId: 12 },
    }));
    const rendered = renderPanel(vi.fn(), false);
    await screen.findByText("Final research: Succeeded");
    await waitFor(() => expect(rendered.onRefresh).toHaveBeenCalledTimes(1));
    await rendered.client.refetchQueries({ queryKey: ["live-acquisition-status"] });
    expect(rendered.onRefresh).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("tabhub.live-acquisition.active-job.v1"))
      .toContain("resource_research:91");
  });
});
