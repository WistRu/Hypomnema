// @vitest-environment jsdom

import type { PrivacyPurgeStatusResponse } from "@tabhub/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPrivacyPurgeStatus: vi.fn(),
  retryPrivacyPurge: vi.fn(),
  startPrivacyPurge: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  fetchPrivacyPurgeStatus: mocks.fetchPrivacyPurgeStatus,
  retryPrivacyPurge: mocks.retryPrivacyPurge,
  startPrivacyPurge: mocks.startPrivacyPurge,
}));

vi.mock("../src/i18n", () => ({
  useI18n: () => ({
    errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause),
    formatDate: (value: string) => value,
    formatNumber: (value: number) => String(value),
    t: (key: string, params: Record<string, number | string> = {}) =>
      key.replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)),
  }),
}));

import {
  ResearchPurgeControl,
  researchPurgeStorageKey,
  type ResearchPurgeTarget,
} from "../src/ResearchPurgeControl";

const TARGET = { kind: "run", researchRunId: 42 } as const;
const PURGE_ID = `purge_${"a".repeat(64)}`;

function receipt(overrides: Partial<PrivacyPurgeStatusResponse> = {}): PrivacyPurgeStatusResponse {
  return {
    version: 1,
    purgeId: PURGE_ID,
    target: TARGET,
    state: "waiting",
    progress: { completedSteps: 1, totalSteps: 4 },
    holdReason: null,
    canRetry: false,
    timestamps: {
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:01:00.000Z",
      completedAt: null,
    },
    result: null,
    ...overrides,
  };
}

function renderControl(options: {
  enabled?: boolean;
  onCompleted?: (value: PrivacyPurgeStatusResponse) => void;
  pollIntervalMs?: number;
  target?: ResearchPurgeTarget;
} = {}) {
  return render(
    <ResearchPurgeControl
      label="Delete research"
      onCompleted={options.onCompleted}
      pollIntervalMs={options.pollIntervalMs ?? 5}
      privacyPurgeEnabled={options.enabled ?? true}
      target={options.target ?? TARGET}
    />,
  );
}

function storeReference(purgeId: string | null = PURGE_ID, idempotencyKey = "stable-key") {
  localStorage.setItem(researchPurgeStorageKey(TARGET), JSON.stringify({
    idempotencyKey,
    purgeId,
  }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.fetchPrivacyPurgeStatus.mockReset();
  mocks.retryPrivacyPurge.mockReset();
  mocks.startPrivacyPurge.mockReset();
});

describe("ResearchPurgeControl", () => {
  it("gives simultaneous confirmation dialogs unique accessible title references", () => {
    render(
      <>
        <ResearchPurgeControl
          label="Delete first research"
          privacyPurgeEnabled
          target={TARGET}
        />
        <ResearchPurgeControl
          label="Delete second research"
          privacyPurgeEnabled
          target={{ kind: "run", researchRunId: 43 }}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete first research" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete second research" }));

    const dialogs = screen.getAllByRole("dialog");
    const titleIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    expect(new Set(titleIds).size).toBe(2);
    for (const [index, dialog] of dialogs.entries()) {
      const titleId = titleIds[index];
      expect(titleId).toBeTruthy();
      const title = document.getElementById(titleId!);
      expect(dialog.contains(title)).toBe(true);
      expect(title?.textContent).toBe("Permanently delete research data?");
    }
  });

  it("uses a safe confirmation focus order, traps focus, restores the trigger, and handles Escape", () => {
    renderControl();
    const trigger = screen.getByRole("button", { name: "Delete research" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const destructive = screen.getByRole("button", { name: "Delete permanently" });
    expect(document.activeElement).toBe(cancel);

    destructive.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(destructive);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("persists a stable key before POST and disables duplicate confirmation", async () => {
    let resolveStart!: (value: PrivacyPurgeStatusResponse) => void;
    mocks.startPrivacyPurge.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Delete research" }));
    const confirm = screen.getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.startPrivacyPurge).toHaveBeenCalledTimes(1));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(researchPurgeStorageKey(TARGET))!)).toMatchObject({
      idempotencyKey: mocks.startPrivacyPurge.mock.calls[0]![0].idempotencyKey,
      purgeId: null,
    });
    fireEvent.click(confirm);
    expect(mocks.startPrivacyPurge).toHaveBeenCalledTimes(1);

    resolveStart(receipt());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(localStorage.getItem(researchPurgeStorageKey(TARGET))).toContain(PURGE_ID);
  });

  it("replays a stored start after reload, including while new purges are feature-off", async () => {
    storeReference(null, "same-idempotency-key");
    mocks.startPrivacyPurge.mockResolvedValue(receipt());
    renderControl({ enabled: false });

    await waitFor(() => expect(mocks.startPrivacyPurge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "same-idempotency-key", target: TARGET }),
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("Waiting for safe deletion")).toBeTruthy();
  });

  it("resumes polling, renders progress and completion receipt, then clears persistence", async () => {
    storeReference();
    const completed = receipt({
      state: "completed",
      progress: { completedSteps: 4, totalSteps: 4 },
      timestamps: {
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:02:00.000Z",
        completedAt: "2026-08-21T10:02:00.000Z",
      },
      result: { deletedRows: 91 },
    });
    mocks.fetchPrivacyPurgeStatus
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(completed);
    const onCompleted = vi.fn();
    renderControl({ enabled: false, onCompleted, pollIntervalMs: 1 });

    expect(await screen.findByText("1 of 4 deletion steps completed")).toBeTruthy();
    expect(await screen.findByText("Deleted 91 stored rows")).toBeTruthy();
    expect(screen.getByText("Created 2026-08-21T10:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("Updated 2026-08-21T10:02:00.000Z")).toBeTruthy();
    expect(screen.getByText("Completed 2026-08-21T10:02:00.000Z")).toBeTruthy();
    // The completion text rendering and the completion callback firing are two
    // consequences of the same poll, not one after the other, so the callback and the
    // storage cleanup are awaited rather than assumed to have already happened.
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith(completed);
      expect(localStorage.getItem(researchPurgeStorageKey(TARGET))).toBeNull();
    });
  });

  it("shows hold reasons, offers retry only when allowed, and renders failed/error states", async () => {
    storeReference();
    mocks.fetchPrivacyPurgeStatus.mockResolvedValue(receipt({
      state: "failed_hold",
      holdReason: "manual_review",
      canRetry: true,
    }));
    mocks.retryPrivacyPurge.mockResolvedValue(receipt({ state: "ready" }));
    const view = renderControl({ pollIntervalMs: 100_000 });

    expect(await screen.findByText("Deletion requires manual review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry deletion" }));
    await waitFor(() => expect(mocks.retryPrivacyPurge).toHaveBeenCalledWith(PURGE_ID));
    expect(await screen.findByText("Ready to delete")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry deletion" })).toBeNull();

    view.unmount();
    storeReference();
    mocks.fetchPrivacyPurgeStatus.mockRejectedValueOnce(new Error("offline"));
    renderControl();
    expect((await screen.findByRole("alert")).textContent).toBe("Deletion error: offline");
  });

  it("blocks a new start when privacy purge is feature-off and displays terminal failure", async () => {
    const view = renderControl({ enabled: false });
    expect((screen.getByRole("button", { name: "Delete research" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText("Privacy deletion is unavailable")).toBeTruthy();
    expect(mocks.startPrivacyPurge).not.toHaveBeenCalled();

    view.unmount();
    storeReference();
    mocks.fetchPrivacyPurgeStatus.mockResolvedValue(receipt({ state: "failed" }));
    renderControl({ enabled: false });
    expect(await screen.findByText("Deletion failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry deletion" })).toBeNull();
  });
});
