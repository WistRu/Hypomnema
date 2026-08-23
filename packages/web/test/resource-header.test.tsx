/** @vitest-environment jsdom */

import type {
  ActivityRollup,
  ActivityWindow,
  ContextEntry,
  LocalResourceContextView,
  ResourceDetail,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { I18nProvider } from "../src/i18n";
import { ResourceHeader } from "../src/ResourceHeader";

const mocks = vi.hoisted(() => ({
  appendResourceContext: vi.fn(),
  changeResource: vi.fn(),
  fetchLocalResourceContext: vi.fn(),
  fetchPriorityReadBatch: vi.fn(),
  fetchResourceActivity: vi.fn(),
  fetchResourceDetail: vi.fn(),
  fetchResourceOpenTabs: vi.fn(),
  setResourceUserEvaluation: vi.fn(),
}));
const researchPanelSpy = vi.hoisted(() => vi.fn());
const researchHistorySpy = vi.hoisted(() => vi.fn());
const liveResearchSpy = vi.hoisted(() => vi.fn());
const researchPurgeSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

vi.mock("../src/ResearchPanel", () => ({
  ResearchPanel: (props: unknown) => {
    researchPanelSpy(props);
    return <div data-testid="resource-research-entry">research entry</div>;
  },
}));
vi.mock("../src/ResearchHistoryDrawer", () => ({
  ResearchHistoryDrawer: (props: unknown) => {
    researchHistorySpy(props);
    return <div data-testid="resource-research-history">research history</div>;
  },
}));
vi.mock("../src/LiveResourceResearchPanel", () => ({
  LiveResourceResearchPanel: (props: unknown) => {
    liveResearchSpy(props);
    return <div data-testid="live-resource-research">live resource research</div>;
  },
}));
vi.mock("../src/ResearchPurgeControl", () => ({
  ResearchPurgeControl: (props: unknown) => {
    researchPurgeSpy(props);
    return <div data-testid="resource-research-purge">purge</div>;
  },
}));

const now = "2026-08-12T10:00:00.000Z";
const detail: ResourceDetail = {
  resource: {
    id: 7,
    resourceKey: "platform:youtube",
    name: "YouTube",
    kind: "platform",
    accessClass: "public",
    lifecycleState: "active",
    mergedIntoResourceId: null,
    createdAt: now,
    updatedAt: now,
  },
  version: 2,
  rulesetVersion: 3,
  preference: { userEvaluation: null, provenance: null, updatedAt: now },
  counts: { logicalPageCount: 4, browserPageCount: 6, physicalOpenCopyCount: 2 },
  allTimeActivity: {
    window: "all",
    onScreenMs: 12_000,
    activeUseMs: 4_000,
    coverageStart: null,
  },
  topicPaths: ["Research"],
  aliases: [
    {
      ruleKey: "system:youtube",
      version: 1,
      hostPattern: "youtube.com",
      matchKind: "suffix_host",
      pathPrefix: "/",
      priority: 1_000,
      enabled: true,
      provenance: "system_seed",
    },
    {
      ruleKey: "resource:7:youtu.be",
      version: 1,
      hostPattern: "youtu.be",
      matchKind: "exact_host",
      pathPrefix: "/",
      priority: 100,
      enabled: true,
      provenance: "user_alias",
    },
  ],
};
const subject = { type: "resource" as const, resourceId: 7 };

function entry(): ContextEntry {
  return {
    id: 11,
    subject,
    entryKind: "note",
    body: "Useful talks",
    provenance: { actor: "user", method: "manual" },
    visibility: "local_only",
    staleAt: null,
    supersedesId: null,
    state: "active",
    operation: "append",
    revision: 1,
    idempotencyKey: "local:note",
    createdAt: now,
    withdrawnAt: null,
    currentReview: null,
  };
}

function contextView(entries: ContextEntry[] = []): LocalResourceContextView {
  return {
    context: { subject, entries, currentEntries: entries, preview: null },
    counts: detail.counts,
  };
}

function activity(
  window: ActivityWindow,
  overrides: Partial<ActivityRollup> = {},
): ActivityRollup {
  return {
    window,
    onScreenMs: 12_000,
    activeUseMs: 4_000,
    coverageStart: window === "all" ? null : "2026-08-01T00:00:00.000Z",
    windowStart: window === "all" ? null : "2026-08-06T00:00:00.000Z",
    windowEnd: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderHeader(
  locale: "en" | "ru" = "en",
  activityWindowsEnabled?: boolean,
  priorityShadowEnabled?: boolean,
  manualPriorityEnabled = true,
  researchEnabled = false,
  liveAcquisitionEnabled = false,
  privacyPurgeEnabled = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <ResourceHeader
          activityWindowsEnabled={activityWindowsEnabled}
          manualPriorityEnabled={manualPriorityEnabled}
          liveAcquisitionEnabled={liveAcquisitionEnabled}
          priorityShadowEnabled={priorityShadowEnabled}
          privacyPurgeEnabled={privacyPurgeEnabled}
          researchEnabled={researchEnabled}
          resourceId={7}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(rendered, { queryClient });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchResourceDetail.mockResolvedValue(detail);
  mocks.fetchResourceActivity.mockResolvedValue({
    resourceId: 7,
    activity: activity("all"),
  });
  mocks.fetchResourceOpenTabs.mockResolvedValue([]);
  mocks.fetchLocalResourceContext.mockResolvedValue(contextView());
  mocks.fetchPriorityReadBatch.mockResolvedValue([]);
  mocks.setResourceUserEvaluation.mockResolvedValue({});
  mocks.changeResource.mockResolvedValue({});
  mocks.appendResourceContext.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("ResourceHeader", () => {
  it("exposes the canonical Resource research entry only behind the accepted capability", async () => {
    renderHeader("en", false, false, true, true, true);
    expect(await screen.findByTestId("resource-research-entry")).toBeTruthy();
    expect(researchPanelSpy).toHaveBeenCalledWith(expect.objectContaining({
      entryLabel: "Research this resource",
      target: { type: "resource", resourceId: 7 },
    }));
    expect(researchHistorySpy).toHaveBeenCalledWith(expect.objectContaining({
      researchEnabled: true,
      target: { type: "resource", resourceId: 7 },
    }));
    expect(liveResearchSpy).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 7,
      resourceLabel: "YouTube",
      startEnabled: true,
    }));
  });
  it("keeps canonical Resource research history available when research creation is disabled", async () => {
    renderHeader("en", false, false, true, false);
    expect(await screen.findByTestId("resource-research-history")).toBeTruthy();
    expect(screen.queryByTestId("resource-research-entry")).toBeNull();
    expect(researchHistorySpy).toHaveBeenCalledWith(expect.objectContaining({
      researchEnabled: false,
      target: { type: "resource", resourceId: 7 },
    }));
    expect(liveResearchSpy).not.toHaveBeenCalled();
  });

  it("always mounts one exact resource-history purge control and forwards the effective flag", async () => {
    renderHeader("en", false, false, true, false, false, true);
    expect(await screen.findByTestId("resource-research-purge")).toBeTruthy();
    expect(screen.getAllByTestId("resource-research-purge")).toHaveLength(1);
    expect(researchPurgeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      label: "Delete this resource's research history",
      privacyPurgeEnabled: true,
      target: { kind: "resource_history", resourceId: 7 },
    }));
    expect(researchHistorySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      privacyPurgeEnabled: true,
    }));
  });

  it("keeps the resource purge mounted writer-off and invalidates dependent reads on completion", async () => {
    const view = renderHeader("en", false, false, true, false, false, false);
    await screen.findByTestId("resource-research-purge");
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    const props = researchPurgeSpy.mock.calls.at(-1)![0] as {
      onCompleted: () => void;
      privacyPurgeEnabled: boolean;
    };
    expect(props.privacyPurgeEnabled).toBe(false);
    props.onCompleted();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["live-acquisition-status"],
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["research-report-detail"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["research-report-history", JSON.stringify(subject)],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["resource", 7, "local-context"],
    });
  });

  it("keeps live reads mounted while the live writer is off and routes typed fallback to captured research", async () => {
    renderHeader("en", false, false, true, true, false);
    expect(await screen.findByTestId("live-resource-research")).toBeTruthy();
    const liveProps = liveResearchSpy.mock.calls.at(-1)![0] as {
      startEnabled: boolean;
      onOpenCapturedFallback: (request: {
        version: 1; jobId: string; resourceId: number; actionId: number;
        exactUrl: string; origin: string; reason: "AUTH_REQUIRED";
      }) => void;
    };
    expect(liveProps.startEnabled).toBe(false);
    const request = { version: 1 as const, jobId: "resource_research:91", resourceId: 7,
      actionId: 3, exactUrl: "https://youtube.com/sign-in", origin: "https://youtube.com",
      reason: "AUTH_REQUIRED" as const };
    liveProps.onOpenCapturedFallback(request);
    await waitFor(() => expect(researchPanelSpy.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ openRequestToken: 1, exactTabFallbackRequest: request }),
    ));
  });
  it("labels distinct counts and honest all-time activity without invented windows", async () => {
    const omitted = renderHeader();
    expect(await screen.findByRole("heading", { name: "YouTube" })).toBeTruthy();
    expect(screen.getByText("Logical pages").nextElementSibling?.textContent).toBe("4");
    expect(screen.getByText("Browser pages").nextElementSibling?.textContent).toBe("6");
    expect(screen.getByText("Physical open copies").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText("On screen: 12s")).toBeTruthy();
    expect(screen.getByText("Active use: 4s")).toBeTruthy();
    expect(screen.getByText("Coverage start unknown")).toBeTruthy();
    expect(screen.queryByText(/7d|30d/i)).toBeNull();
    expect(mocks.fetchResourceActivity).not.toHaveBeenCalled();
    expect(screen.getByText("AI assessment").parentElement?.textContent).toContain("Not available yet");
    omitted.unmount();

    renderHeader("en", false);
    await screen.findByRole("heading", { name: "YouTube" });
    expect(screen.queryByRole("group", { name: "Activity period" })).toBeNull();
    expect(mocks.fetchResourceActivity).not.toHaveBeenCalled();
  });

  it("shows Resource You and AI values separately when shadow mode is effective", async () => {
    const resourceDetail = {
      ...detail,
      preference: {
        userEvaluation: 3 as const,
        provenance: { actor: "user" as const, method: "manual" as const },
        updatedAt: now,
      },
    };
    mocks.fetchResourceDetail.mockResolvedValue(resourceDetail);
    mocks.fetchPriorityReadBatch.mockResolvedValue([{
      subject,
      outcome: {
        kind: "assessment",
        assessment: {
          id: 71,
          subject,
          agentScore: 84,
          agentBand: "high",
          confidence: 0.75,
          needsReview: false,
          reasons: [],
          missingSignals: [],
          ruleset: { rulesetId: 1, version: 1 },
          featureFingerprint: "a".repeat(64),
          assessmentMethod: "rule",
          modelProvenance: null,
          revision: 1,
          evaluatedAt: now,
          supersededAt: null,
        },
      },
      isCurrent: true,
      dirty: false,
      needsReview: false,
    }]);

    renderHeader("en", false, true);
    expect(await screen.findByRole("heading", { name: "AI priority" })).toBeTruthy();
    expect(screen.getByText("You: 3")).toBeTruthy();
    expect(screen.getByText("AI: 84")).toBeTruthy();
    expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledWith(
      [subject],
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("button", {
      name: "Set evaluation to 3 of 3",
    }).getAttribute("aria-pressed")).toBe("true");
    expect(mocks.setResourceUserEvaluation).not.toHaveBeenCalled();
  });

  it("loads exact 7d, 30d, and all windows with honest coverage and real zero totals", async () => {
    mocks.fetchResourceActivity.mockImplementation(
      (resourceId: number, window: ActivityWindow) => Promise.resolve({
        resourceId,
        activity: window === "7d"
          ? activity(window, { onScreenMs: 0, activeUseMs: 0 })
          : window === "30d"
            ? activity(window, {
                onScreenMs: 30_000,
                activeUseMs: 10_000,
                coverageStart: "2026-08-01T00:00:00.000Z",
                windowStart: "2026-07-14T00:00:00.000Z",
              })
            : activity(window, {
                coverageStart: "2026-08-01T00:00:00.000Z",
                windowStart: "2026-08-01T00:00:00.000Z",
              }),
      }),
    );
    const view = renderHeader("en", true);

    const group = await screen.findByRole("group", { name: "Activity period" });
    expect(group).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "All time" }).checked).toBe(true);
    expect(await screen.findByText("Tracking since Aug 1, 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    expect(await screen.findByText("Full window coverage")).toBeTruthy();
    expect(screen.getByText("On screen: 0s")).toBeTruthy();
    expect(screen.getByText("Active use: 0s")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    expect(await screen.findByText("Partial coverage since Aug 1, 2026")).toBeTruthy();
    expect(screen.getByText("On screen: 30s")).toBeTruthy();
    expect(mocks.fetchResourceActivity.mock.calls.map(([resourceId, window]) => [resourceId, window])).toEqual([
      [7, "all"],
      [7, "7d"],
      [7, "30d"],
    ]);
    expect(view.container.querySelector("canvas")).toBeNull();
  });

  it("aborts obsolete window requests and never renders their late response", async () => {
    let resolveSeven!: (value: { resourceId: number; activity: ActivityRollup }) => void;
    let resolveThirty!: (value: { resourceId: number; activity: ActivityRollup }) => void;
    mocks.fetchResourceActivity.mockImplementation(
      (resourceId: number, window: ActivityWindow) => {
        if (window === "all") return Promise.resolve({ resourceId, activity: activity(window) });
        return new Promise((resolve) => {
          if (window === "7d") resolveSeven = resolve;
          else resolveThirty = resolve;
        });
      },
    );
    renderHeader("en", true);
    await screen.findByText("On screen: 12s");
    expect(screen.getByText("Tracking start unknown")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(mocks.fetchResourceActivity).toHaveBeenCalledWith(
      7,
      "7d",
      expect.any(AbortSignal),
    ));
    const sevenSignal = mocks.fetchResourceActivity.mock.calls.find(([, window]) => window === "7d")?.[2] as AbortSignal;
    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    await waitFor(() => expect(mocks.fetchResourceActivity).toHaveBeenCalledWith(
      7,
      "30d",
      expect.any(AbortSignal),
    ));
    expect(sevenSignal.aborted).toBe(true);

    resolveSeven({
      resourceId: 7,
      activity: activity("7d", { onScreenMs: 7_000, activeUseMs: 7_000 }),
    });
    expect(screen.queryByText("On screen: 7s")).toBeNull();
    resolveThirty({
      resourceId: 7,
      activity: activity("30d", { onScreenMs: 30_000, activeUseMs: 10_000 }),
    });
    expect(await screen.findByText("On screen: 30s")).toBeTruthy();
    expect(screen.queryByText("On screen: 7s")).toBeNull();
  });

  it("shows a recoverable activity error without inventing totals", async () => {
    mocks.fetchResourceActivity
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ resourceId: 7, activity: activity("all") });
    renderHeader("en", true);

    expect(await screen.findByText("Activity unavailable")).toBeTruthy();
    expect(screen.queryByText("On screen: 0s")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    expect(await screen.findByText("On screen: 12s")).toBeTruthy();
    expect(mocks.fetchResourceActivity).toHaveBeenCalledTimes(2);
  });

  it("keeps valid totals visible when a background refresh fails", async () => {
    mocks.fetchResourceActivity
      .mockResolvedValueOnce({ resourceId: 7, activity: activity("all") })
      .mockRejectedValueOnce(new Error("offline"));
    const view = renderHeader("en", true);
    expect(await screen.findByText("On screen: 12s")).toBeTruthy();

    await view.queryClient.invalidateQueries({
      queryKey: ["resource", 7, "activity", "all"],
    });

    expect(await screen.findByText("Activity unavailable")).toBeTruthy();
    expect(screen.getByText("On screen: 12s")).toBeTruthy();
    expect(screen.getByText("Active use: 4s")).toBeTruthy();
  });

  it("sets and clears only the personal evaluation while keeping AI assessment separate", async () => {
    renderHeader();
    fireEvent.click(await screen.findByRole("button", {
      name: "Set evaluation to 3 of 3",
    }));
    await waitFor(() => expect(mocks.setResourceUserEvaluation).toHaveBeenCalledWith(
      7,
      3,
      expect.stringContaining("resource-evaluation"),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mocks.setResourceUserEvaluation).toHaveBeenLastCalledWith(
      7,
      null,
      expect.stringContaining("resource-evaluation"),
    ));
  });

  it("hides singular evaluation controls without personalization while retaining read-only data", async () => {
    renderHeader("en", false, false, false);
    expect(await screen.findByText("No personal evaluation yet.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Personal rating" })).toBeNull();
    expect(mocks.setResourceUserEvaluation).not.toHaveBeenCalled();
  });

  it("reloads saved local context and sends aliases with accepted CAS versions", async () => {
    mocks.fetchLocalResourceContext
      .mockResolvedValueOnce(contextView())
      .mockResolvedValueOnce(contextView([entry()]));
    renderHeader();
    const context = await screen.findByLabelText("Resource note or next action");
    fireEvent.change(context, { target: { value: "Useful talks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save context" }));
    await waitFor(() => expect(mocks.fetchLocalResourceContext).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Useful talks")).toBeTruthy();
    expect(mocks.appendResourceContext).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        body: "Useful talks",
        entryKind: "note",
        visibility: "share_with_ai",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save aliases" }));
    await waitFor(() => expect(mocks.changeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set_aliases",
        resourceId: 7,
        expectedResourceVersion: 2,
        expectedRulesetVersion: 3,
        aliases: [{
          hostPattern: "youtu.be",
          matchKind: "exact_host",
          pathPrefix: "/",
          priority: 100,
        }],
      }),
    ));
  });

  it("refreshes resource versions after a CAS conflict", async () => {
    mocks.changeResource.mockRejectedValueOnce(Object.assign(new Error("stale"), {
      code: "RESOURCE_VERSION_CONFLICT",
    }));
    renderHeader();
    await screen.findByRole("heading", { name: "YouTube" });
    fireEvent.click(screen.getByRole("button", { name: "Save aliases" }));
    await waitFor(() => expect(mocks.fetchResourceDetail.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("clears drafts and privacy choices when the keyed resource subject changes", async () => {
    const secondDetail: ResourceDetail = {
      ...detail,
      resource: {
        ...detail.resource,
        id: 8,
        resourceKey: "website:example.com",
        name: "Example",
      },
    };
    mocks.fetchResourceDetail.mockImplementation((resourceId: number) =>
      Promise.resolve(resourceId === 7 ? detail : secondDetail),
    );
    mocks.fetchLocalResourceContext.mockImplementation((resourceId: number) =>
      Promise.resolve({
        ...contextView(),
        context: {
          ...contextView().context,
          subject: { type: "resource", resourceId },
        },
      }),
    );
    mocks.fetchResourceActivity.mockImplementation(
      (resourceId: number, window: ActivityWindow) =>
        Promise.resolve({ resourceId, activity: activity(window) }),
    );
    function SubjectHarness() {
      const [resourceId, setResourceId] = useState(7);
      return (
        <>
          <button type="button" onClick={() => setResourceId(8)}>Switch resource</button>
          <ResourceHeader
            activityWindowsEnabled
            key={resourceId}
            resourceId={resourceId}
          />
        </>
      );
    }
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en"><SubjectHarness /></I18nProvider>
      </QueryClientProvider>,
    );
    const draft = await screen.findByLabelText<HTMLTextAreaElement>("Resource note or next action");
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(mocks.fetchResourceActivity).toHaveBeenCalledWith(
      7,
      "7d",
      expect.any(AbortSignal),
    ));
    fireEvent.change(draft, { target: { value: "A-only draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch resource" }));

    expect(await screen.findByRole("heading", { name: "Example" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Resource note or next action").value).toBe("");
    expect(screen.queryByLabelText("Visibility")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save context" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "All time" }).checked).toBe(true);
    await waitFor(() => expect(mocks.fetchResourceActivity).toHaveBeenCalledWith(
      8,
      "all",
      expect.any(AbortSignal),
    ));
  });

  it("has no serious or critical axe violations in English and Russian", async () => {
    const english = renderHeader("en", true);
    await screen.findByRole("heading", { name: "YouTube" });
    const englishResults = await axe.run(english.container);
    expect(englishResults.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    english.unmount();

    const russian = renderHeader("ru", true);
    await screen.findByRole("heading", { name: "YouTube" });
    expect(screen.getByRole("group", { name: "Период активности" })).toBeTruthy();
    expect(screen.getByText("Платформа / Публичный")).toBeTruthy();
    const russianResults = await axe.run(russian.container);
    expect(russianResults.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });
});
