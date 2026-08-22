/** @vitest-environment jsdom */

import type {
  PrioritySafeRead,
  PrioritySubjectContract,
} from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode, useState } from "react";

import { hasRussianTranslation, I18nProvider } from "../src/i18n";
import {
  priorityShadowDynamicTranslationKeys,
  PriorityReviewQueue,
  PriorityShadowDetails,
  PriorityShadowSummary,
} from "../src/PriorityShadow";

const mocks = vi.hoisted(() => ({
  fetchPriorityReadBatch: vi.fn(),
  fetchPriorityReviewQueue: vi.fn(),
  submitPriorityFeedback: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  ...mocks,
}));

const evaluatedAt = "2026-08-13T10:00:00.000Z";

function assessmentRead(
  subject: PrioritySubjectContract,
  overrides: Partial<PrioritySafeRead> = {},
): PrioritySafeRead {
  return {
    subject,
    outcome: {
      kind: "assessment",
      assessment: {
        id: 71,
        subject,
        agentScore: 78,
        agentBand: "high",
        confidence: 0.45,
        needsReview: true,
        reasons: [
          {
            code: "rule:next-action",
            kind: "contribution",
            label: "Has a shareable next action",
            scoreDelta: 25,
            confidenceDelta: 0.15,
          },
          {
            code: "review:low-confidence",
            kind: "review",
            label: "Confidence is below the active review threshold",
          },
        ],
        missingSignals: ["captured_content"],
        ruleset: { rulesetId: 1, version: 1 },
        featureFingerprint: "a".repeat(64),
        assessmentMethod: "rule",
        modelProvenance: null,
        revision: 1,
        evaluatedAt,
        supersededAt: null,
      },
    },
    isCurrent: true,
    dirty: false,
    needsReview: true,
    ...overrides,
  };
}

function exclusionRead(subject: PrioritySubjectContract): PrioritySafeRead {
  return {
    subject,
    outcome: {
      kind: "exclusion",
      exclusion: {
        id: 80,
        subject,
        reason: "private_or_internal",
        detail: { source: "url_policy", code: "private_ip" },
        ruleset: { rulesetId: 1, version: 1 },
        featureFingerprint: "b".repeat(64),
        revision: 1,
        evaluatedAt,
        supersededAt: null,
      },
    },
    isCurrent: true,
    dirty: false,
    needsReview: false,
  };
}

function renderWithClient(
  node: ReactNode,
  locale: "en" | "ru" = "en",
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { queryClient });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("priority shadow presentation", () => {
  it("has Russian catalog entries for every dynamic priority label", () => {
    expect(
      priorityShadowDynamicTranslationKeys.filter(
        (key) => !hasRussianTranslation(key),
      ),
    ).toEqual([]);
  });

  it("keeps You and AI separate and renders current, stale, excluded, unranked and needs-review states", () => {
    const page = { type: "page" as const, logicalPageId: 17 };
    const views = [
      assessmentRead(page),
      assessmentRead(page, { isCurrent: false, dirty: true }),
      exclusionRead(page),
      { subject: page, outcome: null, isCurrent: false, dirty: true, needsReview: false },
    ] satisfies PrioritySafeRead[];
    const rendered = views.map((read, index) => renderWithClient(
      <PriorityShadowSummary
        read={read}
        userImportance={index === 0 ? 3 : null}
      />,
    ));

    expect(screen.getByText("You: 3")).toBeTruthy();
    expect(screen.getAllByText("AI: 78")).toHaveLength(2);
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getAllByText("Needs review")).toHaveLength(2);
    expect(screen.getAllByText("Stale")).toHaveLength(2);
    expect(screen.getByText("AI: Excluded")).toBeTruthy();
    expect(screen.getByText("Excluded")).toBeTruthy();
    expect(screen.getByText("AI: Unranked")).toBeTruthy();
    expect(screen.getByText("Unranked")).toBeTruthy();
    rendered.forEach(({ unmount }) => unmount());
  });

  it("fails closed when disabled and renders readable page explanation only when enabled", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    mocks.fetchPriorityReadBatch.mockResolvedValue([assessmentRead(subject)]);
    const disabled = renderWithClient(
      <PriorityShadowDetails enabled={false} subject={subject} userImportance={3} />,
    );
    expect(screen.queryByText("AI priority")).toBeNull();
    expect(mocks.fetchPriorityReadBatch).not.toHaveBeenCalled();
    disabled.unmount();

    renderWithClient(
      <PriorityShadowDetails enabled subject={subject} userImportance={3} />,
    );
    expect(await screen.findByRole("heading", { name: "AI priority" })).toBeTruthy();
    expect(await screen.findByText("You: 3")).toBeTruthy();
    expect(screen.getByText("AI: 78")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("45%")).toBeTruthy();
    expect(screen.getByText("Has a shareable next action")).toBeTruthy();
    expect(screen.getByText("+25 score")).toBeTruthy();
    expect(screen.getByText("+15% confidence")).toBeTruthy();
    expect(screen.getByText("Captured content")).toBeTruthy();
    expect(screen.getByText(/does not change Library order/)).toBeTruthy();
    expect(mocks.fetchPriorityReadBatch).toHaveBeenCalledWith(
      [subject],
      expect.any(AbortSignal),
    );
  });

  it("renders typed Resource exclusion details without offering invalid feedback", async () => {
    const subject = { type: "resource" as const, resourceId: 22 };
    mocks.fetchPriorityReadBatch.mockResolvedValue([exclusionRead(subject)]);
    renderWithClient(<PriorityShadowDetails enabled subject={subject} />);

    expect(await screen.findByText("Private or internal page")).toBeTruthy();
    expect(screen.getByText("No AI score is assigned to an excluded subject.")).toBeTruthy();
    expect(screen.getByText("source: url_policy")).toBeTruthy();
    expect(screen.getByText("code: private_ip")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });

  it("retries the exact failed feedback input and announces success without changing importance or rules", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    mocks.fetchPriorityReadBatch.mockResolvedValue([assessmentRead(subject)]);
    mocks.submitPriorityFeedback
      .mockRejectedValueOnce(new Error("Temporary feedback failure"))
      .mockResolvedValueOnce({
        id: 99,
        subject,
        assessmentId: 71,
        verdict: "too_low",
        note: "This supports active work",
        provenance: { actor: "user", method: "manual" },
        supersedesId: null,
        supersededAt: null,
        revision: 1,
        createdAt: evaluatedAt,
      });
    renderWithClient(<PriorityShadowDetails enabled subject={subject} />);
    await screen.findByRole("heading", { name: "AI priority" });

    fireEvent.change(await screen.findByLabelText("Feedback"), { target: { value: "too_low" } });
    fireEvent.change(screen.getByLabelText("Optional note"), {
      target: { value: "This supports active work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Temporary feedback failure",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry same feedback" }));
    expect(await screen.findByText("Feedback saved.")).toBeTruthy();

    expect(mocks.submitPriorityFeedback).toHaveBeenCalledTimes(2);
    expect(mocks.submitPriorityFeedback.mock.calls[0]?.[0]).toEqual(subject);
    expect(mocks.submitPriorityFeedback.mock.calls[1]?.[0]).toEqual(subject);
    expect(mocks.submitPriorityFeedback.mock.calls[1]?.[1]).toEqual(
      mocks.submitPriorityFeedback.mock.calls[0]?.[1],
    );
    expect(mocks.submitPriorityFeedback.mock.calls[0]?.[1]).not.toHaveProperty("actor");
    expect(mocks.submitPriorityFeedback.mock.calls[0]?.[1]).not.toHaveProperty("method");
  });

  it("clears feedback state when polling replaces the current assessment", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    mocks.fetchPriorityReadBatch.mockResolvedValue([assessmentRead(subject)]);
    mocks.submitPriorityFeedback.mockResolvedValue({});
    const view = renderWithClient(<PriorityShadowDetails enabled subject={subject} />);
    await screen.findByRole("heading", { name: "AI priority" });

    fireEvent.click(await screen.findByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Feedback saved.")).toBeTruthy();

    const replacement = assessmentRead(subject);
    if (replacement.outcome?.kind !== "assessment") {
      throw new Error("Expected an assessment fixture.");
    }
    replacement.outcome.assessment.id = 72;
    view.queryClient.setQueryData(["priority", "shadow", "page:17"], [replacement]);

    await waitFor(() => expect(screen.queryByText("Feedback saved.")).toBeNull());
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();
  });

  it("hides cached assessment data when a detail refresh fails", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    mocks.fetchPriorityReadBatch.mockResolvedValueOnce([assessmentRead(subject)]);
    const view = renderWithClient(
      <PriorityShadowDetails enabled subject={subject} userImportance={3} />,
    );

    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByText("Has a shareable next action")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();

    mocks.fetchPriorityReadBatch.mockRejectedValueOnce(
      new Error("Priority refresh failed"),
    );
    await view.queryClient.refetchQueries({
      queryKey: ["priority", "shadow", "page:17"],
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Priority refresh failed",
    );
    expect(screen.queryByText("You: 3")).toBeNull();
    expect(screen.queryAllByText("AI: 78")).toHaveLength(0);
    expect(screen.queryByText("Has a shareable next action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();

    let resolveRead: ((value: PrioritySafeRead[]) => void) | undefined;
    mocks.fetchPriorityReadBatch.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const refresh = view.queryClient.refetchQueries({
      queryKey: ["priority", "shadow", "page:17"],
    });
    expect(screen.queryByText("AI: 78")).toBeNull();
    expect(screen.queryByText("Has a shareable next action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
    resolveRead?.([assessmentRead(subject)]);
    await refresh;
    expect(await screen.findByText("AI: 78")).toBeTruthy();
    expect(screen.getByText("Has a shareable next action")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();
  });

  it("paginates a mixed page/Resource review queue with an opaque cursor and keyboard-native controls", async () => {
    const page = assessmentRead({ type: "page", logicalPageId: 17 });
    const resource = exclusionRead({ type: "resource", resourceId: 22 });
    mocks.fetchPriorityReviewQueue
      .mockResolvedValueOnce({ items: [page, resource], nextCursor: "opaque-next" })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    renderWithClient(<PriorityReviewQueue enabled />);

    const toggle = screen.getByRole("button", { name: "Review AI priorities" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("Page #17")).toBeTruthy();
    expect(screen.getByText("Resource #22")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.fetchPriorityReviewQueue).toHaveBeenLastCalledWith(
      { cursor: "opaque-next", limit: 50 },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("No AI priorities need review.")).toBeTruthy();
    expect(screen.getByText("Page 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(screen.getByText("Page #17")).toBeTruthy());
  });

  it("hides cached queue items when a refresh fails", async () => {
    const page = assessmentRead({ type: "page", logicalPageId: 17 });
    mocks.fetchPriorityReviewQueue.mockResolvedValueOnce({
      items: [page],
      nextCursor: null,
    });
    const view = renderWithClient(<PriorityReviewQueue enabled />);

    fireEvent.click(screen.getByRole("button", { name: "Review AI priorities" }));
    expect(await screen.findByText("Page #17")).toBeTruthy();
    expect(screen.getAllByText("AI: 78")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();

    mocks.fetchPriorityReviewQueue.mockRejectedValueOnce(
      new Error("Priority queue refresh failed"),
    );
    await view.queryClient.refetchQueries({
      queryKey: ["priority", "review-queue", "first"],
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Priority queue refresh failed",
    );
    expect(screen.queryByText("Page #17")).toBeNull();
    expect(screen.queryAllByText("AI: 78")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();

    let resolveQueue: ((value: {
      items: PrioritySafeRead[];
      nextCursor: null;
    }) => void) | undefined;
    mocks.fetchPriorityReviewQueue.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveQueue = resolve;
      }),
    );
    const refresh = view.queryClient.refetchQueries({
      queryKey: ["priority", "review-queue", "first"],
    });
    expect(screen.queryByText("Page #17")).toBeNull();
    expect(screen.queryAllByText("AI: 78")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
    resolveQueue?.({ items: [page], nextCursor: null });
    await refresh;
    expect(await screen.findByText("Page #17")).toBeTruthy();
    expect(screen.getAllByText("AI: 78")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();
  });

  it("resets queue expansion and pagination and waits for fresh success after re-enable", async () => {
    const first = assessmentRead({ type: "page", logicalPageId: 17 });
    const second = assessmentRead({ type: "page", logicalPageId: 18 });
    const fresh = assessmentRead({ type: "page", logicalPageId: 19 });
    mocks.fetchPriorityReviewQueue
      .mockResolvedValueOnce({ items: [first], nextCursor: "second-page" })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });

    function QueueHarness() {
      const [enabled, setEnabled] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setEnabled((value) => !value)}>
            {enabled ? "Disable queue" : "Enable queue"}
          </button>
          <PriorityReviewQueue enabled={enabled} />
        </>
      );
    }

    renderWithClient(<QueueHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Review AI priorities" }));
    expect(await screen.findByText("Page #17")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page #18")).toBeTruthy();
    expect(screen.getByText("Page 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disable queue" }));
    expect(screen.queryByRole("button", { name: "Review AI priorities" })).toBeNull();

    let resolveFresh: ((value: {
      items: PrioritySafeRead[];
      nextCursor: null;
    }) => void) | undefined;
    mocks.fetchPriorityReviewQueue.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveFresh = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable queue" }));
    const toggle = screen.getByRole("button", { name: "Review AI priorities" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(await screen.findByText("Loading priority review queue...")).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.queryByText("Page #17")).toBeNull();
    expect(screen.queryByText("Page #18")).toBeNull();
    expect(screen.queryAllByText("AI: 78")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
    expect(mocks.fetchPriorityReviewQueue).toHaveBeenLastCalledWith(
      { limit: 50 },
      expect.any(AbortSignal),
    );

    resolveFresh?.({ items: [fresh], nextCursor: null });
    expect(await screen.findByText("Page #19")).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
  });

  it("has no serious or critical axe violations in EN and RU", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    mocks.fetchPriorityReadBatch.mockResolvedValue([assessmentRead(subject)]);
    const english = renderWithClient(<PriorityShadowDetails enabled subject={subject} />);
    await screen.findByRole("heading", { name: "AI priority" });
    const en = await axe.run(english.container);
    expect(en.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    english.unmount();

    const russian = renderWithClient(
      <PriorityShadowDetails enabled subject={subject} userImportance={null} />,
      "ru",
    );
    await screen.findByRole("heading", { name: "Приоритет ИИ" });
    expect(await screen.findByText("Вы: без оценки")).toBeTruthy();
    expect(screen.getByText("Сохранённое содержимое")).toBeTruthy();
    const ru = await axe.run(russian.container);
    expect(ru.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });
});
