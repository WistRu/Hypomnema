// @vitest-environment jsdom

import {
  tabCommandRelayProtocolVersion,
  type SummaryJob,
  type TabDetailResponse,
  type TabCommandRelayConnectedScope,
  type TabInstance,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { ApiRequestError, TabCommandRelayClientError } from "../src/api";
import { I18nProvider } from "../src/i18n";
import { PageSummaryCaptureControl } from "../src/PageSummaryCaptureControl";

const mocks = vi.hoisted(() => ({
  enqueueSummary: vi.fn(),
  executeRelayedTabCommand: vi.fn(),
  fetchConnectedTabCommandScopes: vi.fn(),
  fetchSummaryJob: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  enqueueSummary: mocks.enqueueSummary,
  executeRelayedTabCommand: mocks.executeRelayedTabCommand,
  fetchConnectedTabCommandScopes: mocks.fetchConnectedTabCommandScopes,
  fetchSummaryJob: mocks.fetchSummaryJob,
}));

vi.mock("../src/extension-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/extension-bridge")>()),
  createWindowExtensionBridge: () => ({ probe: mocks.probe }),
}));

const SESSION = "223e4567-e89b-42d3-a456-426614174000";
const INSTALLATION = "123e4567-e89b-42d3-a456-426614174000";

function instance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: SESSION,
    browserTabId: 41,
    canonicalTabId: 7,
    discarded: false,
    duplicateGroupSize: 1,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    foregroundTimeMs: 0,
    importance: "medium",
    index: 1,
    installationId: INSTALLATION,
    instanceId: 11,
    instanceRevision: 3,
    lastAccessed: 100,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Article",
    url: "https://example.com/article",
    urlNormalized: "https://example.com/article",
    windowId: 2,
    ...overrides,
  };
}

function scope(): TabCommandRelayConnectedScope {
  return {
    browser: "chrome",
    browserSessionId: SESSION,
    connectedAt: "2026-08-13T08:00:00.000Z",
    installationId: INSTALLATION,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    protocolVersion: tabCommandRelayProtocolVersion,
  };
}

function capturedRelayResult(contentRevision = 9) {
  return {
    kind: "capture-tab-content" as const,
    outcome: {
      receipt: {
        browserTabId: 41,
        canonicalTabId: 7,
        capturedUrl: "https://example.com/article",
        contentRevision,
        extractedAt: "2026-08-13T12:01:00.000Z",
        firstSeenAt: "2026-08-13T08:00:00.000Z",
        instanceId: 11,
        instanceRevision: 3,
        logicalPageId: 17,
      },
      status: "captured" as const,
    },
    target: {
      expectedFirstSeenAt: "2026-08-13T08:00:00.000Z",
      expectedInstanceRevision: 3,
      expectedUrl: "https://example.com/article",
      instanceId: 11,
      tabId: 41,
    },
  };
}

function summaryJob(overrides: Partial<SummaryJob> = {}): SummaryJob {
  return {
    attempts: 1,
    completedAt: "2026-08-13T12:02:00.000Z",
    contentRevisionMatches: true,
    createdAt: "2026-08-13T12:01:01.000Z",
    currentContentRevision: 9,
    depth: "short",
    error: null,
    id: 31,
    maxAttempts: 3,
    nextAttemptAt: null,
    result: {
      model: "summary-test",
      summary: "Correlated current result",
      usage: { costUsd: 0, inputTokens: 10, outputTokens: 4 },
    },
    sourceContentRevision: 9,
    startedAt: "2026-08-13T12:01:02.000Z",
    status: "succeeded",
    tabId: 7,
    ...overrides,
  };
}

function renderControl(options: {
  detailRevision?: number;
  locale?: "en" | "ru";
  instances?: TabInstance[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const instances = options.instances ?? [instance()];
  const element = (detailRevision: number) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={options.locale ?? "en"}>
        <PageSummaryCaptureControl
          canonicalTabId={7}
          detail={{ id: 7, content: { contentRevision: detailRevision } }}
          instances={instances}
          instancesPending={false}
          refetchInstances={() => Promise.resolve({ data: instances, isError: false })}
          refetchTabDetail={() => Promise.resolve({ data: { id: 7, content: { contentRevision: 9 } }, isError: false })}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
  const view = render(element(options.detailRevision ?? 9));
  return {
    ...view,
    queryClient,
    rerenderDetail: (detailRevision: number) => view.rerender(element(detailRevision)),
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("Drawer page-summary capture control", () => {
  it("queues only after an exact correlated capture receipt and preserves the selected depth", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    let releaseCapture: ((value: ReturnType<typeof capturedRelayResult>) => void) | undefined;
    mocks.executeRelayedTabCommand.mockImplementation(
      () => new Promise((resolve) => { releaseCapture = resolve; }),
    );
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob({ depth: "deep" }));
    renderControl();

    fireEvent.click(screen.getByRole("radio", { name: "Deep page summary" }));
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    expect(mocks.enqueueSummary).not.toHaveBeenCalled();
    releaseCapture?.(capturedRelayResult());

    await waitFor(() => {
      expect(mocks.enqueueSummary).toHaveBeenCalledWith(7, {
        depth: "deep",
        expectedContentRevision: 9,
      });
    });
    expect(await screen.findByText("Correlated current result")).toBeTruthy();
    expect(screen.getByText("summary-test")).toBeTruthy();
  });

  it("requires an explicit exact-copy choice for two same-URL copies", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const second = instance({
      browserTabId: 52,
      firstSeenAt: "2026-08-13T08:03:00.000Z",
      instanceId: 12,
      instanceRevision: 8,
      windowId: 3,
    });
    mocks.executeRelayedTabCommand.mockImplementation(async (request) => ({
      ...capturedRelayResult(),
      outcome: {
        ...capturedRelayResult().outcome,
        receipt: {
          ...capturedRelayResult().outcome.receipt,
          browserTabId: 52,
          firstSeenAt: second.firstSeenAt,
          instanceId: 12,
          instanceRevision: 8,
        },
      },
      target: request.command.target,
    }));
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob());
    renderControl({ instances: [instance(), second] });

    const copies = await screen.findAllByRole("radio", { name: /chrome, window/ });
    expect(copies).toHaveLength(2);
    const action = screen.getByRole("button", { name: "Capture and summarize" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(copies[1]!);
    fireEvent.click(action);

    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          target: expect.objectContaining({
            expectedInstanceRevision: 8,
            instanceId: 12,
            tabId: 52,
          }),
        }),
      }),
    ));
    await waitFor(() => expect(mocks.enqueueSummary).toHaveBeenCalledOnce());
  });

  it("does not queue when exact capture fails", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue({
      kind: "capture-tab-content",
      outcome: {
        failure: { code: "CAPTURE_TAB_NAVIGATED", message: "navigated", recoverable: true },
        status: "failed",
      },
      target: capturedRelayResult().target,
    });
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("The selected copy navigated. Refresh it before capturing.")).toBeTruthy();
    expect(mocks.enqueueSummary).not.toHaveBeenCalled();
  });

  it("blocks an enqueue response with a missing revision and never starts polling", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, status: "queued" });
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("TabHub returned a summary job for a different capture. Capture and summarize again.")).toBeTruthy();
    expect(mocks.fetchSummaryJob).not.toHaveBeenCalled();
  });

  it("never retries a guaranteed content-missing 409 against the same revision", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockRejectedValue(
      new ApiRequestError("missing", "TAB_CONTENT_MISSING", 409),
    );
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("Captured page content is no longer available. Capture and summarize again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry page summary" })).toBeNull();
    expect(mocks.enqueueSummary).toHaveBeenCalledOnce();
  });

  it("does not render a stale succeeded result", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(
      summaryJob({
        contentRevisionMatches: false,
        currentContentRevision: 10,
        result: { model: "stale-model", summary: "Never show me", usage: { costUsd: 0, inputTokens: 1, outputTokens: 1 } },
      }),
    );
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("Captured content changed while the page summary was running. Capture and summarize again.")).toBeTruthy();
    expect(screen.queryByText("Never show me")).toBeNull();
    expect(screen.queryByText("stale-model")).toBeNull();
  });

  it("removes a current result immediately after a newer captured revision is observed", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob());
    const view = renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    expect(await screen.findByText("Correlated current result")).toBeTruthy();

    view.rerenderDetail(10);

    expect(await screen.findByText("Captured content changed while the page summary was running. Capture and summarize again.")).toBeTruthy();
    expect(screen.queryByText("Correlated current result")).toBeNull();
  });

  it("waits for the captured detail revision before exposing a current result", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob());
    const view = renderControl({ detailRevision: 8 });
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("Confirming the current captured revision before showing this page summary...")).toBeTruthy();
    expect(screen.queryByText("Correlated current result")).toBeNull();
    view.rerenderDetail(9);
    expect(await screen.findByText("Correlated current result")).toBeTruthy();
  });

  it("hides summary-only retry when rendered content has advanced", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockRejectedValue(new Error("transport failure"));
    const view = renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    expect(await screen.findByRole("button", { name: "Retry page summary" })).toBeTruthy();

    view.rerenderDetail(10);

    expect(await screen.findByText("Captured content changed while the page summary was running. Capture and summarize again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry page summary" })).toBeNull();
    expect(mocks.enqueueSummary).toHaveBeenCalledOnce();
  });

  it.each([
    ["job id", { id: 32 }],
    ["canonical page", { tabId: 8 }],
    ["depth", { depth: "deep" as const }],
    ["source revision", { sourceContentRevision: 10 }],
    ["missing source revision", { sourceContentRevision: undefined }],
    ["missing current revision", { currentContentRevision: undefined }],
    ["missing current marker", { contentRevisionMatches: undefined }],
  ])("blocks a polled job with mismatched %s", async (_label, overrides) => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob(overrides));
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("TabHub returned a summary job for a different capture. Capture and summarize again.")).toBeTruthy();
    expect(screen.queryByText("Correlated current result")).toBeNull();
  });

  it("does not leak a provider failure in Russian", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob({ error: "secret provider failure", result: null, status: "failed" }));
    renderControl({ locale: "ru" });
    const action = await screen.findByRole("button", { name: "Сохранить и создать сводку" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("TabHub не смог создать сводку страницы.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret provider failure");
  });

  it("binds a recapture to the new revision and ignores late data from the superseded job", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand
      .mockResolvedValueOnce(capturedRelayResult(9))
      .mockResolvedValueOnce(capturedRelayResult(10));
    mocks.enqueueSummary
      .mockResolvedValueOnce({ jobId: 31, sourceContentRevision: 9, status: "queued" })
      .mockResolvedValueOnce({ jobId: 32, sourceContentRevision: 10, status: "queued" });
    mocks.fetchSummaryJob.mockImplementation(async (jobId: number) =>
      jobId === 31
        ? summaryJob({
            contentRevisionMatches: false,
            currentContentRevision: 10,
            result: null,
            status: "succeeded",
          })
        : summaryJob({
            currentContentRevision: 10,
            id: 32,
            result: {
              model: "new-model",
              summary: "New revision result",
              usage: { costUsd: 0, inputTokens: 8, outputTokens: 3 },
            },
            sourceContentRevision: 10,
          }),
    );
    const view = renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    expect(await screen.findByText("Captured content changed while the page summary was running. Capture and summarize again.")).toBeTruthy();

    fireEvent.click(action);
    await waitFor(() => expect(mocks.enqueueSummary).toHaveBeenNthCalledWith(2, 7, {
      depth: "short",
      expectedContentRevision: 10,
    }));
    view.queryClient.setQueryData(["summary-job", 31], summaryJob({
      result: {
        model: "old-model",
        summary: "Old job late result",
        usage: { costUsd: 0, inputTokens: 8, outputTokens: 3 },
      },
    }));
    view.rerenderDetail(10);

    expect(await screen.findByText("New revision result")).toBeTruthy();
    expect(screen.queryByText("Old job late result")).toBeNull();
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledTimes(2);
  });

  it("shows queued and running stages and a current depth-specific completion", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob
      .mockResolvedValueOnce(summaryJob({ completedAt: null, result: null, status: "queued" }))
      .mockResolvedValueOnce(summaryJob({ completedAt: null, result: null, status: "running" }))
      .mockResolvedValueOnce(summaryJob());
    const { queryClient } = renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText("Page summary queued.")).toBeTruthy();
    await queryClient.refetchQueries({ queryKey: ["summary-job", 31] });
    expect(await screen.findByText("Creating page summary...")).toBeTruthy();
    await queryClient.refetchQueries({ queryKey: ["summary-job", 31] });
    expect(await screen.findByText("Short page summary ready.")).toBeTruthy();
    expect(screen.getByText("Correlated current result")).toBeTruthy();
  });

  it("retries only polling after a transport error", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockResolvedValue(capturedRelayResult());
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(summaryJob());
    renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    const check = await screen.findByRole("button", { name: "Check page summary status" });
    expect(mocks.enqueueSummary).toHaveBeenCalledOnce();
    fireEvent.click(check);
    expect(await screen.findByText("Correlated current result")).toBeTruthy();
    expect(mocks.enqueueSummary).toHaveBeenCalledOnce();
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
  });

  it("resumes explicitly from an advanced revision after an unknown outcome without another relay", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    mocks.executeRelayedTabCommand.mockRejectedValue(
      new TabCommandRelayClientError("lost response", {
        code: "EXTENSION_DISCONNECTED",
        outcome: "unknown",
      }),
    );
    mocks.enqueueSummary.mockResolvedValue({ jobId: 31, sourceContentRevision: 9, status: "queued" });
    mocks.fetchSummaryJob.mockResolvedValue(summaryJob());

    function Harness() {
      const [detail, setDetail] = useState<Pick<TabDetailResponse, "id" | "content">>({
        id: 7,
        content: { contentRevision: 8 },
      });
      return (
        <PageSummaryCaptureControl
          canonicalTabId={7}
          detail={detail}
          instances={[instance()]}
          instancesPending={false}
          refetchInstances={() => Promise.resolve({ data: [instance()], isError: false })}
          refetchTabDetail={async () => {
            const fresh = { id: 7, content: { contentRevision: 9 } };
            setDetail(fresh);
            return { data: fresh, isError: false };
          }}
        />
      );
    }
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en"><Harness /></I18nProvider>
      </QueryClientProvider>,
    );
    const capture = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    await screen.findByText(/Capture outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh copies" }));
    const resume = await screen.findByRole("button", { name: "Summarize captured revision" });
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
    fireEvent.click(resume);

    await waitFor(() => expect(mocks.enqueueSummary).toHaveBeenCalledWith(7, {
      depth: "short",
      expectedContentRevision: 9,
    }));
    expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce();
    expect(await screen.findByText("Correlated current result")).toBeTruthy();
  });

  it("does not enqueue when a pending relay resolves after the page flow unmounts", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    let release: ((value: ReturnType<typeof capturedRelayResult>) => void) | undefined;
    mocks.executeRelayedTabCommand.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const view = renderControl();
    const action = await screen.findByRole("button", { name: "Capture and summarize" });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    await waitFor(() => expect(mocks.executeRelayedTabCommand).toHaveBeenCalledOnce());
    view.unmount();
    release?.(capturedRelayResult());
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.enqueueSummary).not.toHaveBeenCalled();
  });

  it("renders the page-summary controls in Russian without calling it research", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([]);
    renderControl({ locale: "ru", instances: [] });

    expect(screen.getByRole("radio", { name: "Краткая сводка страницы" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Подробная сводка страницы" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сохранить и создать сводку" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("research");
    expect(document.body.textContent).not.toContain("исследован");
  });

  it("has no serious or critical axe findings in English or Russian", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    const english = renderControl();
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture and summarize" }) as HTMLButtonElement).disabled).toBe(false));
    const en = await axe.run(english.container);
    expect(en.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    english.unmount();

    const russian = renderControl({ locale: "ru" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Сохранить и создать сводку" }) as HTMLButtonElement).disabled).toBe(false));
    const ru = await axe.run(russian.container);
    expect(ru.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });

  it("keeps the depth, exact-copy, and action controls native and keyboard reachable", async () => {
    mocks.probe.mockResolvedValue({ available: false });
    mocks.fetchConnectedTabCommandScopes.mockResolvedValue([scope()]);
    renderControl();
    const shortDepth = screen.getByRole("radio", { name: "Short page summary" });
    const deepDepth = screen.getByRole("radio", { name: "Deep page summary" });
    const copies = await screen.findByRole("group", { name: "Open copy to capture" });
    const action = screen.getByRole("button", { name: "Capture and summarize" });

    expect(shortDepth.tagName).toBe("INPUT");
    expect(deepDepth.tagName).toBe("INPUT");
    expect(copies.querySelector('input[type="radio"]')).toBeTruthy();
    expect(action.tagName).toBe("BUTTON");
    expect(shortDepth.getAttribute("tabindex")).toBeNull();
    expect(action.getAttribute("tabindex")).toBeNull();
    fireEvent.click(deepDepth);
    expect((deepDepth as HTMLInputElement).checked).toBe(true);
  });
});
