/** @vitest-environment jsdom */

import type { LiveAcquisitionRunStatus } from "@tabhub/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import { LiveAcquisitionRunView } from "../src/LiveAcquisitionRunView";

afterEach(cleanup);

const at = "2026-08-15T09:00:00.000Z";

function status(overrides: Partial<LiveAcquisitionRunStatus> = {}): LiveAcquisitionRunStatus {
  return {
    version: 1,
    jobId: "resource_research:41",
    target: { type: "resource", resourceId: 7 },
    coordinator: { runId: 41, status: "running" },
    final: null,
    consent: {
      state: "active", createdAt: at, expiresAt: "2026-08-15T09:05:00.000Z", terminalAt: null,
      approvedOrigins: ["https://docs.example.com"],
      limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1,
        maxOrigins: 1, maxOutputTokens: 8_192 },
      effectivePolicy: { egress: "local_tabhub_server", browserNetworkMayDiffer: true,
        method: "GET", sendsCookies: false, sendsCredentials: false, followsRedirects: false,
        robotsRequired: true, minCadenceMs: 2_000, maxSourceBytes: 65_536,
        maxTotalBytes: 4_194_304, dnsTimeoutMs: 3_000, connectTimeoutMs: 5_000,
        headersTimeoutMs: 8_000, bodyIdleTimeoutMs: 3_000, requestTimeoutMs: 15_000,
        maxHeaderBytes: 16_384, maxNetworkActions: 11,
        requestPolicyVersion: "safe_public_http_request:v1", ipPolicyVersion: "public_ip_policy:v1" },
    },
    runLiveSuccess: null,
    workflowOutcome: null,
    workflowOutcomeCode: null,
    acquisitionOutcome: "running",
    counters: { reservedPages: 2, visitedPages: 1, capturedPages: 1, blockedPages: 0,
      ambiguousPages: 0, robotsActions: 1, networkActions: 2, plannedActions: 1,
      activeActions: 0 },
    actions: [{ id: 1, kind: "robots", depth: null, state: "completed",
      latestOutcome: "HTTP_SUCCESS", createdAt: at, terminalAt: at, exactUrl: null,
      origin: "https://docs.example.com", redacted: false, usability: null,
      sourceUsable: null, omissionReason: null, fallback: null, capture: null,
      finalInclusion: null },
    { id: 2, kind: "page", depth: 0, state: "completed", latestOutcome: "FETCH_COMPLETED",
      createdAt: at, terminalAt: at, exactUrl: "https://docs.example.com/guide",
      origin: "https://docs.example.com", redacted: false, usability: "usable",
      sourceUsable: true, omissionReason: null, fallback: null,
      capture: { manifestId: 21, logicalPageId: 12, captureSequence: 1,
        contentDigest: "a".repeat(64) },
      finalInclusion: { sourceReceiptId: 31, finalRunId: 51, includedOrder: 1,
        sourceKind: "live_acquisition", acquisitionMethod: "safe_public_http_v1" } }],
    ...overrides,
  };
}

function show(value: LiveAcquisitionRunStatus, props: {
  onExactTabFallback?: (action: LiveAcquisitionRunStatus["actions"][number]) => void;
  onRefresh?: () => void;
} = {}) {
  return render(<I18nProvider initialLocale="en">
    <LiveAcquisitionRunView status={value} {...props} />
  </I18nProvider>);
}

describe("LiveAcquisitionRunView", () => {
  it("renders running consent, safe policy, live progress, and ordered action provenance", () => {
    const refresh = vi.fn();
    show(status(), { onRefresh: refresh });
    expect(screen.getByText("Live acquisition is running")).toBeTruthy();
    expect(screen.getByText("Final research has not started")).toBeTruthy();
    expect(screen.getByText("Live success: Pending final research")).toBeTruthy();
    expect(screen.getByText("https://docs.example.com/guide")).toBeTruthy();
    expect(screen.getByText("captured · Manifest 21")).toBeTruthy();
    expect(screen.getByText("live_acquisition")).toBeTruthy();
    expect(screen.getByText("safe_public_http_v1")).toBeTruthy();
    expect(screen.getByText("GET only; no cookies, credentials, or redirects")).toBeTruthy();
    const progress = screen.getByRole("status", { name: "Live acquisition progress" });
    expect(progress.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Robots")).toBeTruthy();
    expect(within(rows[1]!).getByText("Page")).toBeTruthy();
  });

  it("separates successful handoff/final research and never calls coordinator superseded a failure", () => {
    show(status({ coordinator: { runId: 41, status: "superseded" }, workflowOutcome: "handoff",
      workflowOutcomeCode: "WORKFLOW_COMPLETED", acquisitionOutcome: "live_complete",
      runLiveSuccess: true, final: { jobId: "resource_research:51", runId: 51,
        status: "succeeded", reportId: 61 } }));
    expect(screen.getByText("Coordinator: Handed off")).toBeTruthy();
    expect(screen.getByText("The coordinator was superseded after handoff; this is not a failure."))
      .toBeTruthy();
    expect(screen.getByText("Final research: Succeeded")).toBeTruthy();
    expect(screen.getByText("Live success: Yes")).toBeTruthy();
    expect(screen.queryByText("Coordinator: Failed")).toBeNull();
    expect(screen.getByText("Final dossier 61 includes live acquisition evidence.")).toBeTruthy();
  });

  it.each(["queued", "running", "partial", "failed", "cancelled", "superseded"] as const)(
    "keeps final research %s separate from acquisition state",
    (finalStatus) => {
      show(status({ acquisitionOutcome: finalStatus === "queued" || finalStatus === "running"
        ? "running" : "zero_usable", coordinator: { runId: 41, status: "superseded" },
      workflowOutcome: "handoff", workflowOutcomeCode: "WORKFLOW_COMPLETED",
      runLiveSuccess: finalStatus === "queued" || finalStatus === "running" ? null : false,
      final: { jobId: "resource_research:51", runId: 51, status: finalStatus, reportId: null } }));
      expect(screen.getByText(`Final research: ${finalStatus === "partial" ? "Partially completed"
        : finalStatus[0]!.toUpperCase() + finalStatus.slice(1)}`)).toBeTruthy();
      expect(screen.getByText("Coordinator: Handed off")).toBeTruthy();
    },
  );

  it("makes mixed usable evidence and omissions prominent and offers only persisted fallback", () => {
    const fallback = vi.fn();
    const blocked: LiveAcquisitionRunStatus["actions"][number] = {
      id: 3, kind: "page", depth: 1, state: "blocked", latestOutcome: "CHALLENGE_PAGE",
      createdAt: at, terminalAt: at, exactUrl: "https://docs.example.com/login",
      origin: "https://docs.example.com", redacted: false, usability: "unusable",
      sourceUsable: false, omissionReason: "CHALLENGE_PAGE",
      fallback: { recommendedKind: "exact_tab_capture", reason: "CHALLENGE_PAGE" },
      capture: null, finalInclusion: null,
    };
    show(status({ acquisitionOutcome: "mixed", runLiveSuccess: true,
      coordinator: { runId: 41, status: "superseded" }, workflowOutcome: "handoff",
      workflowOutcomeCode: "WORKFLOW_COMPLETED", final: { jobId: "resource_research:51",
        runId: 51, status: "succeeded", reportId: 61 },
      counters: { ...status().counters, blockedPages: 1, plannedActions: 0 },
      actions: [...status().actions, blocked] }), { exactTabFallbackActionIds: new Set([blocked.id]),
        onExactTabFallback: fallback });
    expect(screen.getByText("Mixed result: 1 usable live sources and 1 visible omissions."))
      .toBeTruthy();
    expect(screen.getByText("Omission: CHALLENGE_PAGE")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Use exact tab capture" });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(blocked);
  });

  it("does not render a persisted fallback as a control without an explicit callback", () => {
    const blocked = { ...status().actions[1]!, id: 3, state: "blocked" as const,
      latestOutcome: "CHALLENGE_PAGE" as const, usability: "unusable" as const,
      sourceUsable: false, omissionReason: "CHALLENGE_PAGE" as const,
      fallback: { recommendedKind: "exact_tab_capture" as const, reason: "CHALLENGE_PAGE" as const },
      capture: null, finalInclusion: null };
    show(status({ actions: [blocked] }));
    expect(screen.queryByRole("button", { name: "Use exact tab capture" })).toBeNull();
  });

  it("does not invent fallback controls or a dossier for zero usable acquisition", () => {
    const blocked = { ...status().actions[1]!, id: 3, state: "blocked" as const,
      latestOutcome: "BUDGET_EXHAUSTED" as const, usability: "unusable" as const,
      sourceUsable: false, omissionReason: "BUDGET_EXHAUSTED" as const,
      fallback: null, capture: null, finalInclusion: null };
    show(status({ acquisitionOutcome: "zero_usable", runLiveSuccess: false,
      coordinator: { runId: 41, status: "superseded" }, workflowOutcome: "captured_only",
      workflowOutcomeCode: "NO_ELIGIBLE_SOURCE", actions: [status().actions[0]!, blocked],
      counters: { ...status().counters, capturedPages: 0, blockedPages: 1,
        plannedActions: 0 } }), { onExactTabFallback: vi.fn() });
    expect(screen.getByText("No usable live sources")).toBeTruthy();
    expect(screen.getByText("No live dossier was produced from this acquisition.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use exact tab capture" })).toBeNull();
    expect(screen.queryByText(/includes live acquisition evidence/)).toBeNull();
  });

  it("renders an explicit zero state when the server projects no acquisition actions", () => {
    show(status({ actions: [], counters: { ...status().counters, reservedPages: 0,
      visitedPages: 0, capturedPages: 0, blockedPages: 0, ambiguousPages: 0,
      robotsActions: 0, networkActions: 0, plannedActions: 0, activeActions: 0 } }));
    expect(screen.getByText("No acquisition actions were recorded for this run.")).toBeTruthy();
  });

  it.each(["purging", "redacted"] as const)(
    "suppresses all source material while %s",
    (acquisitionOutcome) => {
      const sensitive = "https://secret.example/private-token";
      const hiddenAction = { ...status().actions[1]!, exactUrl: sensitive,
        origin: "https://secret.example", redacted: false };
      const { container } = show(status({ acquisitionOutcome, actions: [hiddenAction],
        consent: { ...status().consent, approvedOrigins: ["https://secret.example"] } }),
      { onExactTabFallback: vi.fn() });
      expect(container.textContent).not.toContain(sensitive);
      expect(container.textContent).not.toContain("https://secret.example");
      expect(container.textContent).not.toContain("Manifest 21");
      expect(container.textContent).not.toContain("Final run 51");
      expect(screen.getByText(/Source material and provenance are hidden/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use exact tab capture" })).toBeNull();
    },
  );
});
