/** @vitest-environment jsdom */

import type {
  DurableJobView,
  ResearchReportDetail,
  ResearchReportListResponse,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, useI18n } from "../src/i18n";
import { ResearchHistoryDrawer } from "../src/ResearchHistoryDrawer";

const mocks = vi.hoisted(() => ({
  appendResourceContext: vi.fn(),
  changeLocalPageContext: vi.fn(),
  fetchResearchJob: vi.fn(),
  fetchResearchReport: vi.fn(),
  fetchResearchReports: vi.fn(),
}));
const researchPanelSpy = vi.hoisted(() => vi.fn());
const researchPurgeSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));
vi.mock("../src/ResearchPanel", () => ({
  ResearchPanel: (props: unknown) => {
    researchPanelSpy(props);
    return <div data-testid="refine-research-panel">refine</div>;
  },
}));
vi.mock("../src/ResearchPurgeControl", () => ({
  ResearchPurgeControl: (props: unknown) => {
    researchPurgeSpy(props);
    return <div data-testid="run-research-purge">run purge</div>;
  },
}));

const timestamp = "2026-08-14T10:00:00.000Z";
const target = { type: "page" as const, logicalPageId: 7 };
const coverage = {
  discovered: 2, captured: 1, eligible: 1, used: 1, missing: 1, failed: 0,
};

function history(): ResearchReportListResponse {
  return {
    target,
    head: {
      latestPublishedReportId: 9,
      currentFreshReportId: 9,
      lastSuccessfulReportId: 9,
    },
    latestRun: {
      runId: 5,
      jobId: "resource_research:5",
      status: "failed",
      parentReportId: 9,
      reportId: null,
      createdAt: "2026-08-14T11:00:00.000Z",
    },
    items: [{
      id: 9,
      runId: 4,
      jobId: "resource_research:4",
      version: 3,
      parentReportId: null,
      publishStatus: "succeeded",
      state: "fresh",
      reason: null,
      coverage,
      createdAt: timestamp,
      executiveSummary: "The last successful report",
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: true,
        isLastSuccessful: true,
      },
    }],
    nextBeforeVersion: null,
  };
}

function detail(overrides: Partial<ResearchReportDetail> = {}): ResearchReportDetail {
  return {
    id: 9,
    runId: 4,
    jobId: "resource_research:4",
    runStatus: "succeeded",
    target,
    version: 3,
    parentReportId: null,
    publishStatus: "succeeded",
    state: "fresh",
    reason: null,
    coverage,
    createdAt: timestamp,
    headFlags: {
      isLatestPublished: true,
      isCurrentFresh: true,
      isLastSuccessful: true,
    },
    dossier: {
      executiveSummary: "The last successful report",
      valueForUser: "Useful for the project",
      capabilities: ["Search"],
      limitations: ["Captured corpus only"],
      risks: ["May become stale"],
      unknowns: ["Pricing"],
      nextSteps: ["Compare alternatives"],
    },
    reportText: "Plain report text",
    provenance: {
      provider: "test",
      model: "test-model",
      promptVersion: "research:v1",
      pricingVersion: "test:1",
      requestId: "request-1",
      generatedAt: timestamp,
      usage: { steps: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.01, wallTimeMs: 100 },
      inputFingerprint: "c".repeat(64),
      terminalAttemptId: 1,
    },
    claims: [],
    ...overrides,
  };
}

function failedJob(): DurableJobView {
  return {
    id: "resource_research:5",
    kind: "resource_research",
    subject: target,
    status: "failed",
    attempts: 1,
    maxAttempts: 3,
    progress: { completed: 1, total: 1, stage: "failed" },
    canCancel: false,
    cancellationRequest: null,
    createdAt: "2026-08-14T11:00:00.000Z",
    startedAt: "2026-08-14T11:00:01.000Z",
    completedAt: "2026-08-14T11:00:02.000Z",
    nextAttemptAt: null,
    error: { type: "durable", code: "RESEARCH_PROVIDER_UNAVAILABLE", message: "provider offline" },
    result: null,
  };
}

function renderHistory(
  researchEnabled = false,
  nextTarget: Parameters<typeof ResearchHistoryDrawer>[0]["target"] = target,
  locale: "en" | "ru" = "en",
  privacyPurgeEnabled = false,
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <button type="button">Before history</button>
        <ResearchHistoryDrawer
          privacyPurgeEnabled={privacyPurgeEnabled}
          researchEnabled={researchEnabled}
          target={nextTarget}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(rendered, { client });
}

function LocaleSwitch() {
  const { locale, setLocale } = useI18n();
  const [switches, setSwitches] = useState(0);
  return <button type="button" onClick={() => {
    setLocale(locale === "en" ? "ru" : "en");
    setSwitches((value) => value + 1);
  }}>Switch locale {switches}</button>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchResearchReports.mockResolvedValue(history());
  mocks.fetchResearchReport.mockResolvedValue(detail());
  mocks.fetchResearchJob.mockResolvedValue(failedJob());
});
afterEach(() => cleanup());

describe("ResearchHistoryDrawer", () => {
  it("does not expose purge for page targets or before a Resource report is selected", async () => {
    renderHistory(false);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    expect(await screen.findByText("The last successful report")).toBeTruthy();
    expect(screen.queryByTestId("run-research-purge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");
    expect(screen.queryByTestId("run-research-purge")).toBeNull();
    expect(researchPurgeSpy).not.toHaveBeenCalled();
  });

  it("mounts one exact run purge for selected Resource detail even writer-off", async () => {
    const resourceTarget = { type: "resource" as const, resourceId: 12 };
    renderHistory(false, resourceTarget, "en", false);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    await screen.findByText("The last successful report");
    expect(screen.queryByTestId("run-research-purge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View report version 3" }));

    expect(await screen.findByTestId("run-research-purge")).toBeTruthy();
    expect(screen.getAllByTestId("run-research-purge")).toHaveLength(1);
    expect(researchPurgeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      label: "Delete this research run",
      privacyPurgeEnabled: false,
      target: { kind: "run", researchRunId: 4 },
    }));
  });

  it("clears stale selected detail and invalidates history after run purge completion", async () => {
    const resourceTarget = { type: "resource" as const, resourceId: 12 };
    const view = renderHistory(false, resourceTarget, "en", true);
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    await screen.findByText("The last successful report");
    fireEvent.click(screen.getByRole("button", { name: "View report version 3" }));
    await screen.findByTestId("run-research-purge");
    const purgeProps = researchPurgeSpy.mock.calls.at(-1)![0] as {
      onCompleted: () => void;
    };

    purgeProps.onCompleted();
    expect(await screen.findByText("Research run 4 was deleted and its report is redacted."))
      .toBeTruthy();
    expect(screen.queryByText("Plain report text")).toBeNull();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["research-report-history", JSON.stringify(resourceTarget)],
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["live-acquisition-status"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["resource", 12, "local-context"],
    });
  });

  it("keeps published history readable when writers are disabled and a newer attempt failed", async () => {
    renderHistory(false);
    const trigger = screen.getByRole("button", { name: "Research history" });
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Research history" })).toBeTruthy();
    expect(await screen.findByText("Latest attempt: Research run failed")).toBeTruthy();
    expect(await screen.findByText("The research provider is unavailable. Check provider settings and try again."))
      .toBeTruthy();
    expect(screen.getByText("Last successful")).toBeTruthy();
    expect(screen.getByText("The last successful report")).toBeTruthy();
    expect(screen.getByText("Research creation is disabled; published history remains available."))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View report version 3" }));
    expect(await screen.findByRole("heading", { name: "Report version 3" })).toBeTruthy();
    expect(await screen.findByText("Plain report text")).toBeTruthy();
    expect(screen.queryByTestId("refine-research-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save next step as context" })).toBeNull();
    expect(mocks.fetchResearchReport).toHaveBeenCalledWith(9, target, expect.any(AbortSignal));

    fireEvent.click(screen.getByRole("button", { name: "Close research history" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("loads stable before-version pages, deduplicates overlaps, and keeps descending versions", async () => {
    const first = { ...history(), nextBeforeVersion: 3 };
    const older = {
      ...history(),
      latestRun: history().latestRun,
      items: [
        history().items[0]!,
        {
          ...history().items[0]!,
          id: 8,
          runId: 3,
          jobId: "resource_research:3" as const,
          version: 2,
          executiveSummary: "Older report",
          headFlags: {
            isLatestPublished: false,
            isCurrentFresh: false,
            isLastSuccessful: false,
          },
        },
      ],
      nextBeforeVersion: null,
    } satisfies ResearchReportListResponse;
    mocks.fetchResearchReports.mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(older);

    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Older report")).toBeTruthy();
    expect(screen.getAllByText("Version 3")).toHaveLength(1);
    expect(screen.getAllByText(/^Version /).map(({ textContent }) => textContent))
      .toEqual(["Version 3", "Version 2"]);
    expect(mocks.fetchResearchReports).toHaveBeenNthCalledWith(
      2,
      target,
      { limit: 20, beforeVersion: 3 },
      expect.any(AbortSignal),
    );
  });

  it("renders typed evidence safely and distinguishes inference, invalid, and redacted material", async () => {
    mocks.fetchResearchReport.mockResolvedValue(detail({
      reportText: "<img src=x onerror=alert(1)> plain text",
      claims: [
        {
          id: 1,
          ordinal: 1,
          claimDigest: "1".repeat(64),
          claimText: "Search is available.",
          confidence: 0.9,
          isInference: false,
          rationaleDigest: null,
          rationale: null,
          evidence: [{
            id: 11,
            ordinal: 1,
            kind: "tab_content",
            sourceId: 17,
            sourceKind: "live_acquisition",
            acquisitionMethod: "safe_public_http_v1",
            contentRevision: 2,
            contentDigest: "2".repeat(64),
            state: "valid",
            stateReason: null,
            locatorDigest: "3".repeat(64),
            locator: { version: "utf8_range:v1", byteStart: 10, byteEnd: 25 },
            excerptHash: "4".repeat(64),
            excerpt: "Search is available",
            url: "https://example.test/search",
            title: "Example search",
          }],
        },
        {
          id: 2,
          ordinal: 2,
          claimDigest: "5".repeat(64),
          claimText: "The resource may fit the project.",
          confidence: 0.6,
          isInference: true,
          rationaleDigest: "6".repeat(64),
          rationale: "This is inferred from the available capabilities.",
          evidence: [],
        },
        {
          id: 3,
          ordinal: 3,
          claimDigest: "7".repeat(64),
          claimText: "A prior context entry existed.",
          confidence: 0.5,
          isInference: false,
          rationaleDigest: null,
          rationale: null,
          evidence: [{
            id: 12,
            ordinal: 1,
            kind: "page_context",
            snapshotId: 8,
            state: "invalid",
            stateReason: "snapshot changed",
            locatorDigest: "8".repeat(64),
            locator: { version: "whole_snapshot:v1" },
            excerptHash: "9".repeat(64),
            excerpt: "stale private excerpt",
          }],
        },
        {
          id: 4,
          ordinal: 4,
          claimDigest: "a".repeat(64),
          claimText: "A relation existed.",
          confidence: 0.4,
          isInference: false,
          rationaleDigest: null,
          rationale: null,
          evidence: [{
            id: 13,
            ordinal: 1,
            kind: "relation",
            snapshotId: 9,
            state: "redacted",
            stateReason: "user redaction",
            locatorDigest: "b".repeat(64),
            locator: null,
            excerptHash: "c".repeat(64),
            excerpt: null,
          }],
        },
      ],
    }));

    const rendered = renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));

    expect(await screen.findByText("Search is available.")).toBeTruthy();
    expect(screen.getByText("Confidence: 90%")).toBeTruthy();
    expect(screen.getByText(`Source 17 · revision 2 · digest ${"2".repeat(64)}`)).toBeTruthy();
    expect(screen.getByText(
      "Source kind: live_acquisition · acquisition method: safe_public_http_v1",
    )).toBeTruthy();
    expect(screen.getByText("Bytes 10–25")).toBeTruthy();
    expect(screen.getByText("https://example.test/search")).toBeTruthy();
    expect(screen.getByText("Inference")).toBeTruthy();
    expect(screen.getByText("This is inferred from the available capabilities.")).toBeTruthy();
    expect(screen.getByText("Invalid evidence unavailable: snapshot changed")).toBeTruthy();
    expect(screen.queryByText("stale private excerpt")).toBeNull();
    expect(screen.getByText("Redacted evidence unavailable: user redaction")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)> plain text")).toBeTruthy();
    expect(rendered.container.querySelector("img")).toBeNull();

    rendered.unmount();
    const russian = renderHistory(true, target, "ru");
    fireEvent.click(screen.getByRole("button", { name: "История исследований" }));
    fireEvent.click(await screen.findByRole("button", { name: "Открыть отчёт версии 3" }));
    expect(await screen.findByText(
      "Тип источника: онлайн-получение · способ получения: безопасный публичный HTTP v1",
    )).toBeTruthy();
    const results = await axe.run(russian.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"))
      .toEqual([]);
  });

  it("saves one explicitly selected page next action with a stable retry key", async () => {
    mocks.changeLocalPageContext
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce({ kind: "changed" });

    renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");

    expect(screen.queryByRole("combobox", { name: "Next-action visibility" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Compare alternatives" }));
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save next step as context" });
    fireEvent.click(save);
    expect(await screen.findByText("connection lost")).toBeTruthy();
    fireEvent.click(save);
    expect(await screen.findByText("Next action saved.")).toBeTruthy();

    expect(mocks.changeLocalPageContext).toHaveBeenCalledTimes(2);
    const first = mocks.changeLocalPageContext.mock.calls[0]!;
    const retry = mocks.changeLocalPageContext.mock.calls[1]!;
    expect(first[0]).toBe(7);
    expect(first[1]).toMatchObject({
      kind: "append",
      entryKind: "next_action",
      body: "Compare alternatives",
      visibility: "share_with_ai",
      staleAt: null,
      idempotencyKey: expect.any(String),
    });
    expect(retry[1].idempotencyKey).toBe(first[1].idempotencyKey);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save next step as context" }).disabled)
      .toBe(true);
  });

  it("writes a Resource next action to exactly one Resource and never fans out a selection", async () => {
    const resourceTarget = { type: "resource" as const, resourceId: 23 };
    mocks.fetchResearchReports.mockResolvedValue({ ...history(), target: resourceTarget });
    mocks.fetchResearchReport.mockResolvedValue(detail({ target: resourceTarget }));
    mocks.fetchResearchJob.mockResolvedValue({ ...failedJob(), subject: resourceTarget });
    mocks.appendResourceContext.mockResolvedValue({ kind: "changed" });

    const resource = renderHistory(true, resourceTarget);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");
    fireEvent.click(screen.getByRole("radio", { name: "Compare alternatives" }));
    fireEvent.click(screen.getByRole("button", { name: "Save next step as context" }));
    await screen.findByText("Next action saved.");
    expect(mocks.appendResourceContext).toHaveBeenCalledWith(23, expect.objectContaining({
      entryKind: "next_action",
      body: "Compare alternatives",
      visibility: "share_with_ai",
    }));
    expect(mocks.changeLocalPageContext).not.toHaveBeenCalled();
    resource.unmount();

    const selectionTarget = {
      type: "selection" as const,
      logicalPageIds: [7, 8],
      fingerprint: "f".repeat(64),
    };
    mocks.fetchResearchReports.mockResolvedValue({ ...history(), target: selectionTarget });
    mocks.fetchResearchReport.mockResolvedValue(detail({ target: selectionTarget }));
    mocks.fetchResearchJob.mockResolvedValue({ ...failedJob(), subject: selectionTarget });
    renderHistory(true, selectionTarget);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    expect(await screen.findByText(
      "A selection cannot save one shared next action. Open one page or Resource and choose its next step there.",
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save next step as context" })).toBeNull();
  });

  it("offers parent-bound refinement only for an eligible report", async () => {
    renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    expect(await screen.findByTestId("refine-research-panel")).toBeTruthy();
    expect(researchPanelSpy).toHaveBeenCalledWith(expect.objectContaining({
      entryLabel: "Refine this report",
      target,
      refinement: {
        parentReportId: 9,
        previousCoverage: coverage,
      },
    }));

    cleanup();
    researchPanelSpy.mockClear();
    mocks.fetchResearchReport.mockResolvedValue(detail({ state: "superseded" }));
    renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");
    expect(screen.queryByTestId("refine-research-panel")).toBeNull();
  });

  it("opens a last-successful head even when that report is outside the loaded page", async () => {
    mocks.fetchResearchReports.mockResolvedValue({
      ...history(),
      head: {
        latestPublishedReportId: 30,
        currentFreshReportId: null,
        lastSuccessfulReportId: 9,
      },
      items: [{ ...history().items[0]!, id: 30, version: 30, runId: 30,
        jobId: "resource_research:30", executiveSummary: "Partial latest" }],
    });
    let resolveDetail!: (value: ResearchReportDetail) => void;
    mocks.fetchResearchReport.mockImplementation(() => new Promise((resolve) => {
      resolveDetail = resolve;
    }));

    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Last successful report 9" }));

    expect(screen.getByRole("heading", { name: "Report 9" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Report version 0" })).toBeNull();
    await act(async () => resolveDetail(detail({ id: 9, version: 9, reportText: "Report 9" })));
    expect(await screen.findByRole("heading", { name: "Report version 9" })).toBeTruthy();
    expect(screen.getByText("Report 9")).toBeTruthy();
    expect(mocks.fetchResearchReport).toHaveBeenCalledWith(9, target, expect.any(AbortSignal));
  });

  it("keeps retained audit identity and provenance visible after full redaction without material leaks", async () => {
    const claimDigest = "d".repeat(64);
    const locatorDigest = "e".repeat(64);
    const excerptDigest = "f".repeat(64);
    mocks.fetchResearchReport.mockResolvedValue(detail({
      state: "redacted",
      dossier: null,
      reportText: null,
      claims: [{
        id: 55,
        ordinal: 1,
        claimDigest,
        claimText: "PRIVATE CLAIM CANARY",
        confidence: 0.75,
        isInference: true,
        rationaleDigest: "a".repeat(64),
        rationale: "PRIVATE RATIONALE CANARY",
        evidence: [{
          id: 77,
          ordinal: 1,
          kind: "tab_content",
          sourceId: 17,
          sourceKind: "captured",
          acquisitionMethod: "exact_capture",
          contentRevision: 2,
          contentDigest: "b".repeat(64),
          state: "redacted",
          stateReason: "Report redacted",
          locatorDigest,
          locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 99 },
          excerptHash: excerptDigest,
          excerpt: "PRIVATE EXCERPT CANARY",
          url: "https://private.example/canary",
          title: "PRIVATE TITLE CANARY",
        }],
      }],
    }));

    const rendered = renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    expect(await screen.findByText("This report has been redacted. Its private material is unavailable."))
      .toBeTruthy();
    expect(screen.getByText(`Claim 1 · id 55 · digest ${claimDigest}`)).toBeTruthy();
    expect(screen.getByText("Evidence 1 · id 77")).toBeTruthy();
    expect(screen.getByText("Captured page content")).toBeTruthy();
    expect(screen.getByText(`Locator digest: ${locatorDigest}`)).toBeTruthy();
    expect(screen.getByText(`Excerpt digest: ${excerptDigest}`)).toBeTruthy();
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(screen.getByText("request-1")).toBeTruthy();
    expect(screen.getByText("20", { selector: "dd" })).toBeTruthy();
    expect(screen.queryByTestId("refine-research-panel")).toBeNull();
    for (const canary of [
      "PRIVATE CLAIM CANARY", "PRIVATE RATIONALE CANARY", "PRIVATE EXCERPT CANARY",
      "https://private.example/canary", "PRIVATE TITLE CANARY", "Compare alternatives",
    ]) expect(rendered.container.textContent).not.toContain(canary);
  });

  it("rebases an open report's mutable head badges when refreshed history advances", async () => {
    const rendered = renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    const detailSection = (await screen.findByRole("heading", { name: "Report version 3" })).parentElement!;
    expect(await within(detailSection).findByText("Current fresh")).toBeTruthy();
    expect(within(detailSection).getByText("Last successful")).toBeTruthy();

    const child = {
      ...history().items[0]!, id: 10, version: 4, runId: 6,
      jobId: "resource_research:6" as const, parentReportId: 9,
      executiveSummary: "Fresh child",
    };
    mocks.fetchResearchReports.mockResolvedValue({
      ...history(),
      head: { latestPublishedReportId: 10, currentFreshReportId: 10, lastSuccessfulReportId: 10 },
      items: [child, history().items[0]!],
    });
    await act(async () => {
      await rendered.client.invalidateQueries({
        queryKey: ["research-report-history", JSON.stringify(target)],
      });
    });

    await screen.findByText("Fresh child");
    expect(within(detailSection).queryByText("Current fresh")).toBeNull();
    expect(within(detailSection).queryByText("Last successful")).toBeNull();
    expect(within(detailSection).queryByText("Latest published")).toBeNull();
  });

  it("keeps the selected report and its local form state isolated from late prior detail data", async () => {
    const secondSummary = {
      ...history().items[0]!, id: 8, runId: 3, jobId: "resource_research:3" as const,
      version: 2, executiveSummary: "Second report",
      headFlags: { isLatestPublished: false, isCurrentFresh: false, isLastSuccessful: false },
    };
    mocks.fetchResearchReports.mockResolvedValue({ ...history(), items: [history().items[0]!, secondSummary] });
    let resolveNine!: (value: ResearchReportDetail) => void;
    let resolveEight!: (value: ResearchReportDetail) => void;
    mocks.fetchResearchReport.mockImplementation((reportId: number) => new Promise((resolve) => {
      if (reportId === 9) resolveNine = resolve;
      else resolveEight = resolve;
    }));

    renderHistory(true);
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    fireEvent.click(screen.getByRole("button", { name: "View report version 2" }));
    await act(async () => resolveEight(detail({ id: 8, version: 2, reportText: "Report B" })));
    expect(await screen.findByRole("heading", { name: "Report version 2" })).toBeTruthy();
    expect(screen.getByText("Report B")).toBeTruthy();
    await act(async () => resolveNine(detail({ id: 9, version: 3, reportText: "Late report A" })));
    expect(screen.getByText("Report B")).toBeTruthy();
    expect(screen.queryByText("Late report A")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Compare alternatives" }));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Compare alternatives" }).checked).toBe(true);
    mocks.fetchResearchReport.mockImplementation(async (reportId: number) =>
      reportId === 9 ? detail() : detail({ id: 8, version: 2, reportText: "Report B again" }));
    fireEvent.click(screen.getByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Compare alternatives" }).checked).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save next step as context" }).disabled)
      .toBe(true);
  });

  it("fails closed when paginated history contains conflicting immutable report identities", async () => {
    mocks.fetchResearchReports.mockReset()
      .mockResolvedValueOnce({ ...history(), nextBeforeVersion: 3 })
      .mockResolvedValueOnce({ ...history(), items: [{
        ...history().items[0]!, version: 2, executiveSummary: "Conflicting duplicate",
      }], nextBeforeVersion: null });
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect((await screen.findByText("Research history is inconsistent. Retry before relying on it."))
      .closest('[role="alert"]')).toBeTruthy();
  });

  it("consumes Escape inside a nested modal and restores the history trigger", async () => {
    const outerEscape = vi.fn();
    document.addEventListener("keydown", outerEscape);
    renderHistory();
    const trigger = screen.getByRole("button", { name: "Research history" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Research history" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Research history" })).toBeNull());
    expect(outerEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    document.removeEventListener("keydown", outerEscape);
  });

  it("remains accessible and translates already-loaded asynchronous history in place", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const rendered = render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <LocaleSwitch />
          <ResearchHistoryDrawer researchEnabled={false} target={target} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Research history" }));
    fireEvent.click(await screen.findByRole("button", { name: "View report version 3" }));
    await screen.findByText("Plain report text");
    const results = await axe.run(rendered.container);
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"))
      .toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Switch locale 0" }));
    expect(await screen.findByRole("dialog", { name: "История исследований" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Отчёт версии 3" })).toBeTruthy();
    expect(screen.getAllByText("Актуальный отчёт").length).toBeGreaterThan(0);
    expect(screen.queryByText("Research creation is disabled; published history remains available."))
      .toBeNull();
  });

  it.each([
    ["en", "State: Stale report", "Partial publication", "Budget exhausted"],
    ["ru", "Состояние: Устаревший отчёт", "Частичная публикация", "Бюджет исчерпан"],
  ] as const)("renders human labels for every report enum in %s", async (
    locale, listState, publication, reason,
  ) => {
    const partialSummary = {
      ...history().items[0]!,
      publishStatus: "partial" as const,
      state: "stale" as const,
      reason: "budget_exhausted" as const,
      headFlags: { isLatestPublished: true, isCurrentFresh: false, isLastSuccessful: false },
    };
    mocks.fetchResearchReports.mockResolvedValue({
      ...history(),
      head: { latestPublishedReportId: 9, currentFreshReportId: null, lastSuccessfulReportId: null },
      items: [partialSummary],
    });
    mocks.fetchResearchReport.mockResolvedValue(detail({
      publishStatus: "partial",
      runStatus: "partial",
      state: "stale",
      reason: "budget_exhausted",
      headFlags: { isLatestPublished: true, isCurrentFresh: false, isLastSuccessful: false },
      provenance: {
        ...detail().provenance,
        usage: { ...detail().provenance.usage, costUsd: 0.004 },
      },
    }));

    renderHistory(false, target, locale);
    fireEvent.click(screen.getByRole("button", {
      name: locale === "en" ? "Research history" : "История исследований",
    }));
    expect(await screen.findByText(listState)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: locale === "en" ? "View report version 3" : "Открыть отчёт версии 3",
    }));
    await screen.findByText(publication);
    expect(screen.getByText(reason)).toBeTruthy();
    const expectedCost = new Intl.NumberFormat(locale === "en" ? "en-US" : "ru-RU", {
      style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6,
    }).format(0.004);
    expect(screen.getByText((_, element) => element?.textContent === expectedCost)).toBeTruthy();
  });

  it("localizes a mismatched latest-job target error in Russian", async () => {
    mocks.fetchResearchJob.mockResolvedValue({
      ...failedJob(),
      subject: { type: "page", logicalPageId: 99 },
    });
    renderHistory(false, target, "ru");
    fireEvent.click(screen.getByRole("button", { name: "История исследований" }));
    expect(await screen.findByText("TabHub вернул ход выполнения другого исследования."))
      .toBeTruthy();
    expect(screen.queryByText("TabHub returned mismatched research progress.")).toBeNull();
  });
});
