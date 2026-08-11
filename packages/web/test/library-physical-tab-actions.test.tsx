// @vitest-environment jsdom

import type { TabInstance } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/extension-bridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/extension-bridge")>();
  return {
    ...original,
    createWindowExtensionBridge: () => ({
      activate: vi.fn(),
      command: vi.fn(),
      probe: vi.fn(async () => ({
        available: false,
        browser: null,
        browserSessionId: null,
        controlWindowId: null,
        installationId: null,
        pendingUndos: [],
        windows: [],
      })),
    }),
  };
});

import { I18nProvider } from "../src/i18n";
import { TabCommandRelayClientError } from "../src/api";
import { DuplicateGroupsCloseAllUnknownOutcomeError } from "../src/duplicate-groups-close-all-outcome";
import type {
  PhysicalTabScope,
  TabMutationResult,
} from "../src/extension-bridge";
import {
  clearMultiCloseScopeUndo,
  LibraryPhysicalTabActions,
  settledMultiCloseScopeReceipts,
  type MultiCloseFeedback,
} from "../src/LibraryPhysicalTabActions";

afterEach(cleanup);

function tab(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    browserTabId: 42,
    canonicalTabId: 1,
    discarded: false,
    duplicateGroupSize: 1,
    faviconUrl: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    importance: 0,
    index: 0,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    instanceId: 1,
    lastAccessed: null,
    lastSeenAt: "2026-08-11T00:00:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Example",
    url: "https://example.com",
    urlNormalized: "https://example.com",
    windowId: 1,
    ...overrides,
  };
}

describe("Library physical-tab actions", () => {
  it("fails closed for an offline physical selection while keeping export available", () => {
    const selected = tab();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLocale="en">
          <LibraryPhysicalTabActions
            allFilteredInstances={[selected]}
            selection={new Map([[selected.instanceId, selected]])}
            onSelectionChange={vi.fn()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("The selected browser profile is offline.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Move<\/button>/);
    expect(markup).toContain("Copy URLs");
  });

  it("exposes multi-profile cleanup only as an explicit exact-copy action", () => {
    const first = tab();
    const second = tab({
      browserTabId: 43,
      index: 1,
      instanceId: 2,
      title: "Example copy",
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLocale="en">
          <LibraryPhysicalTabActions
            allFilteredInstances={[first, second]}
            selection={new Map()}
            onSelectionChange={vi.fn()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Close all matching duplicates (1)…");
    expect(markup).not.toContain("open-tab-bulk-toolbar");
  });

  it("preserves known, failed, and unknown cleanup outcomes per exact scope", () => {
    const scopes: PhysicalTabScope[] = [
      {
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
      },
      {
        browser: "edge",
        browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
        installationId: "323e4567-e89b-42d3-a456-426614174000",
      },
      {
        browser: "yandex",
        browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
        installationId: "523e4567-e89b-42d3-a456-426614174000",
      },
    ];
    const known: TabMutationResult = {
      failed: [],
      kind: "close",
      requested: 2,
      skipped: [],
      succeededTabIds: [41, 42],
      undo: {
        count: 2,
        expiresAt: 1_800_000_000_000,
        undoId: "723e4567-e89b-42d3-a456-426614174000",
      },
    };
    const planned = scopes.map((scope, index) => ({
      requested: index + 2,
      scope,
    }));
    const receipts = settledMultiCloseScopeReceipts(
      [
        { status: "fulfilled", value: { requested: 2, result: known, scope: scopes[0]! } },
        {
          reason: new TabCommandRelayClientError("offline", {
            code: "SCOPE_OFFLINE",
            outcome: "not-sent",
          }),
          status: "rejected",
        },
        {
          reason: new DuplicateGroupsCloseAllUnknownOutcomeError("unknown"),
          status: "rejected",
        },
      ],
      planned,
    );

    expect(receipts.map(({ kind, requested, scope }) => ({
      browser: scope.browser,
      browserSessionId: scope.browserSessionId,
      installationId: scope.installationId,
      kind,
      requested,
    }))).toEqual([
      { ...scopes[0], kind: "known", requested: 2 },
      { ...scopes[1], kind: "failed", requested: 3 },
      { ...scopes[2], kind: "unknown", requested: 4 },
    ]);
    expect(receipts[0]?.kind === "known" && receipts[0].result.undo?.undoId).toBe(
      "723e4567-e89b-42d3-a456-426614174000",
    );
    expect("result" in receipts[1]!).toBe(false);
    expect("result" in receipts[2]!).toBe(false);
  });

  it("clears only the successfully undone scope while preserving other receipts and exclusions", () => {
    const chromeScope: PhysicalTabScope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const edgeScope: PhysicalTabScope = {
      browser: "edge",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    };
    const result = (undoId: string): TabMutationResult => ({
      failed: [],
      kind: "close",
      requested: 1,
      skipped: [],
      succeededTabIds: [1],
      undo: { count: 1, expiresAt: 1_800_000_000_000, undoId },
    });
    const feedback: MultiCloseFeedback = {
      blockedCandidateCount: 2,
      blockedGroupCount: 1,
      excluded: [{
        ...edgeScope,
        candidateCount: 2,
        groupCount: 1,
        reason: "offline",
      }],
      kind: "multi-close",
      scopes: [
        { kind: "known", requested: 1, result: result("chrome-undo"), scope: chromeScope },
        { kind: "known", requested: 1, result: result("edge-undo"), scope: edgeScope },
      ],
    };

    const next = clearMultiCloseScopeUndo(feedback, chromeScope, "chrome-undo");

    expect(next.excluded).toEqual(feedback.excluded);
    expect(next.scopes[0]?.kind === "known" && next.scopes[0].result.undo).toBeNull();
    expect(next.scopes[1]?.kind === "known" && next.scopes[1].result.undo?.undoId).toBe(
      "edge-undo",
    );
    expect(feedback.scopes[0]?.kind === "known" && feedback.scopes[0].result.undo?.undoId).toBe(
      "chrome-undo",
    );
  });

  it("keeps structured exclusion detail when every duplicate scope is excluded", () => {
    const first = tab();
    const second = tab({ browserTabId: 43, index: 1, instanceId: 2 });
    const third = tab({ browserTabId: null, index: 2, instanceId: 3 });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLocale="en">
          <LibraryPhysicalTabActions
            allFilteredInstances={[first, second, third]}
            selection={new Map()}
            onSelectionChange={vi.fn()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close all matching duplicates (2)…",
      }),
    );

    expect(screen.getByText("Excluded from this cleanup")).toBeTruthy();
    expect(
      screen.getByText(
        "Chrome · Installation 123e4567-e89b-42d3-a456-426614174000 · Session 223e4567-e89b-42d3-a456-426614174000",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Browser profile offline")).toBeTruthy();
    expect(screen.getByText("1 groups · 2 copies")).toBeTruthy();
  });
});
