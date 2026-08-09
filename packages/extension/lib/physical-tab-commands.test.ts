import { describe, expect, it, vi } from "vitest";

import {
  createPhysicalTabCommandExecutor,
  parsePhysicalTabCommand,
  type PhysicalTabCommandAdapter,
  type PhysicalTabCommandStorage,
} from "./physical-tab-commands";

const CURRENT_SCOPE = {
  browser: "chrome",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
} as const;

function adapter(): PhysicalTabCommandAdapter {
  return {
    createTab: vi.fn(),
    createWindow: vi.fn(),
    discardTab: vi.fn(),
    getTab: vi.fn(),
    getWindow: vi.fn(),
    listWindows: vi.fn(),
    moveTabs: vi.fn(),
    reloadTab: vi.fn(),
    removeTab: vi.fn(),
    updateTab: vi.fn(),
  };
}

function storage(): PhysicalTabCommandStorage {
  return {
    get: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

interface StatefulTestStorage extends PhysicalTabCommandStorage {
  peek(key: string): unknown;
}

function statefulStorage(
  initial: Record<string, unknown> = {},
): StatefulTestStorage {
  const values = { ...initial };
  return {
    get: vi.fn(async (key) =>
      Object.hasOwn(values, key) ? { [key]: values[key] } : {},
    ),
    remove: vi.fn(async (key) => {
      delete values[key];
    }),
    set: vi.fn(async (items) => {
      Object.assign(values, items);
    }),
    peek: (key) => values[key],
  };
}

describe("physical tab command executor", () => {
  it("rejects a stale browser-session scope before touching any browser tab", async () => {
    const browserAdapter = adapter();
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
          command: {
            kind: "set-pinned",
            targets: [{ tabId: 42, expectedUrl: "https://example.com/" }],
            value: true,
          },
        },
      ),
    ).rejects.toThrow(/different browser installation or session/i);

    expect(browserAdapter.getTab).not.toHaveBeenCalled();
    expect(browserAdapter.updateTab).not.toHaveBeenCalled();
  });

  it("sets pinned state on the live physical tab even if it navigated since the snapshot", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockResolvedValue({
      id: 42,
      index: 2,
      pinned: false,
      url: "https://example.com/navigated",
      windowId: 7,
    });
    vi.mocked(browserAdapter.updateTab).mockResolvedValue({
      id: 42,
      index: 2,
      pinned: true,
      windowId: 7,
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            kind: "set-pinned",
            targets: [{ tabId: 42, expectedUrl: "https://example.com/old" }],
            value: true,
          },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "set-pinned",
      requested: 1,
      skipped: [],
      succeededTabIds: [42],
    });

    expect(browserAdapter.updateTab).toHaveBeenCalledWith(42, { pinned: true });
  });

  it("reports per-target mute successes, no-ops, missing tabs, and failures", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      if (tabId === 44) throw new Error("No tab");
      return {
        id: tabId,
        index: tabId,
        mutedInfo: { muted: tabId === 42 },
        windowId: 7,
      };
    });
    vi.mocked(browserAdapter.updateTab).mockImplementation(async (tabId) => {
      if (tabId === 45) throw new Error("Tab cannot be edited");
      return { id: tabId, index: tabId, windowId: 7 };
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            kind: "set-muted",
            targets: [42, 43, 44, 45].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
            value: true,
          },
        },
      ),
    ).resolves.toEqual({
      failed: [{ error: "Tab cannot be edited", tabId: 45 }],
      kind: "set-muted",
      requested: 4,
      skipped: [
        { reason: "already-in-state", tabId: 42 },
        { reason: "missing", tabId: 44 },
      ],
      succeededTabIds: [43],
    });
  });

  it("discards only inactive loaded tabs", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      active: tabId === 41,
      discarded: tabId === 42,
      id: tabId,
      index: tabId,
      windowId: 7,
    }));
    vi.mocked(browserAdapter.discardTab).mockResolvedValue({
      discarded: true,
      id: 43,
      index: 43,
      windowId: 7,
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            kind: "discard",
            targets: [41, 42, 43].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "discard",
      requested: 3,
      skipped: [
        { reason: "active-protected", tabId: 41 },
        { reason: "already-discarded", tabId: 42 },
      ],
      succeededTabIds: [43],
    });

    expect(browserAdapter.discardTab).toHaveBeenCalledTimes(1);
    expect(browserAdapter.discardTab).toHaveBeenCalledWith(43);
  });

  it("reloads selected live tabs but protects the TabHub control tab", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      id: tabId,
      index: tabId,
      windowId: 7,
    }));
    vi.mocked(browserAdapter.reloadTab).mockResolvedValue(undefined);
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            bypassCache: true,
            kind: "reload",
            targets: [42, 900].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "reload",
      requested: 2,
      skipped: [{ reason: "control-tab-protected", tabId: 900 }],
      succeededTabIds: [42],
    });

    expect(browserAdapter.reloadTab).toHaveBeenCalledTimes(1);
    expect(browserAdapter.reloadTab).toHaveBeenCalledWith(42, {
      bypassCache: true,
    });
  });

  it("moves live tabs into the window containing the TabHub page", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      id: tabId,
      index: tabId,
      windowId: tabId === 43 ? 90 : 7,
    }));
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 90,
      type: "normal",
    });
    vi.mocked(browserAdapter.moveTabs).mockResolvedValue({
      id: 42,
      index: 5,
      windowId: 90,
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            destination: { kind: "app-window" },
            kind: "move",
            targets: [42, 43].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      destinationWindowId: 90,
      failed: [],
      kind: "move",
      requested: 2,
      skipped: [{ reason: "already-in-destination", tabId: 43 }],
      succeededTabIds: [42],
    });

    expect(browserAdapter.moveTabs).toHaveBeenCalledWith(42, {
      index: -1,
      windowId: 90,
    });
  });

  it("reports each existing-window move independently when one tab races away", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      id: tabId,
      index: tabId,
      windowId: 7,
    }));
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 90,
      type: "normal",
    });
    vi.mocked(browserAdapter.moveTabs).mockImplementation(async (tabId) => {
      if (tabId === 43) throw new Error("Tab vanished while moving");
      return { id: 42, index: 0, windowId: 90 };
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            destination: { kind: "window", windowId: 90 },
            kind: "move",
            targets: [42, 43].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      destinationWindowId: 90,
      failed: [{ error: "Tab vanished while moving", tabId: 43 }],
      kind: "move",
      requested: 2,
      skipped: [],
      succeededTabIds: [42],
    });
  });

  it("moves a deterministic ordered selection into one new window", async () => {
    const browserAdapter = adapter();
    const positions = new Map([
      [42, { index: 10, windowId: 6 }],
      [43, { index: 8, windowId: 7 }],
      [44, { index: 2, windowId: 6 }],
    ]);
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      id: tabId,
      ...positions.get(tabId)!,
    }));
    vi.mocked(browserAdapter.createWindow).mockResolvedValue({
      id: 99,
      type: "normal",
    });
    vi.mocked(browserAdapter.moveTabs).mockImplementation(async (tabId) => ({
      id: tabId as number,
      index: 0,
      windowId: 99,
    }));
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            destination: { kind: "new-window" },
            kind: "move",
            targets: [43, 42, 44].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      destinationWindowId: 99,
      failed: [],
      kind: "move",
      requested: 3,
      skipped: [],
      succeededTabIds: [44, 42, 43],
    });

    expect(browserAdapter.createWindow).toHaveBeenCalledWith({
      focused: true,
      tabId: 44,
    });
    expect(browserAdapter.moveTabs).toHaveBeenNthCalledWith(1, 42, {
      index: -1,
      windowId: 99,
    });
    expect(browserAdapter.moveTabs).toHaveBeenNthCalledWith(2, 43, {
      index: -1,
      windowId: 99,
    });
  });

  it("previews close from live exact URLs while protecting active, pinned, and control tabs", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      if (tabId === 46) throw new Error("No tab");
      return {
        active: tabId === 42,
        id: tabId,
        index: tabId,
        pinned: tabId === 43,
        url:
          tabId === 45
            ? "https://example.com/changed"
            : `https://example.com/${tabId}`,
        windowId: 7,
      };
    });
    const sessionStorage = storage();
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => "323e4567-e89b-42d3-a456-426614174000",
      now: () => 1_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 44,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            kind: "close-preview",
            targets: [41, 42, 43, 44, 45, 46].map((tabId) => ({
              expectedUrl: `https://example.com/${tabId}`,
              tabId,
            })),
          },
        },
      ),
    ).resolves.toEqual({
      candidateTabIds: [41],
      expiresAt: 301_000,
      kind: "close-preview",
      previewId: "323e4567-e89b-42d3-a456-426614174000",
      requested: 6,
      skipped: [
        { reason: "active-protected", tabId: 42 },
        { reason: "pinned-protected", tabId: 43 },
        { reason: "control-tab-protected", tabId: 44 },
        { reason: "url-changed", tabId: 45 },
        { reason: "missing", tabId: 46 },
      ],
    });

    expect(sessionStorage.set).toHaveBeenCalledOnce();
    expect(vi.mocked(sessionStorage.set).mock.calls[0]?.[0]).toEqual({
      [`tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`]: {
        ...CURRENT_SCOPE,
        expiresAt: 301_000,
        previewId: "323e4567-e89b-42d3-a456-426614174000",
        targets: [{ tabId: 41, expectedUrl: "https://example.com/41" }],
        version: 1,
      },
    });
  });

  it("previews every target when a close contains more than 500 tabs", async () => {
    const targets = Array.from({ length: 501 }, (_, index) => ({
      expectedUrl: `https://example.com/${index}`,
      tabId: 1_000 + index,
    }));
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      active: false,
      id: tabId,
      index: tabId - 1_000,
      pinned: false,
      url: targets[tabId - 1_000]!.expectedUrl,
      windowId: 7,
    }));
    const sessionStorage = storage();
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => previewId,
      now: () => 1_000,
      storage: sessionStorage,
    });

    const result = await executor.execute(
      {
        controlTabId: 900,
        controlWindowId: 90,
        currentScope: CURRENT_SCOPE,
      },
      {
        ...CURRENT_SCOPE,
        command: { kind: "close-preview", targets },
      },
    );

    expect(result).toMatchObject({
      candidateTabIds: targets.map(({ tabId }) => tabId),
      kind: "close-preview",
      requested: 501,
      skipped: [],
    });
    expect(sessionStorage.set).toHaveBeenCalledWith({
      [`tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`]:
        expect.objectContaining({ targets }),
    });
  });

  it("previews a duplicate close only while its exact keeper is still live", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      if (tabId === 101) throw new Error("Keeper was closed");
      if (tabId === 102) {
        return {
          id: 102,
          index: 2,
          url: "https://example.com/keeper-navigated",
          windowId: 7,
        };
      }
      const suffix = new Map([
        [41, "shared-a"],
        [42, "shared-b"],
        [43, "shared-c"],
        [103, "shared-c"],
      ]).get(tabId);
      return {
        active: false,
        id: tabId,
        index: tabId,
        pinned: false,
        url: `https://example.com/${suffix}`,
        windowId: 7,
      };
    });
    const sessionStorage = storage();
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => previewId,
      now: () => 1_000,
      storage: sessionStorage,
    });
    const targets = [
      {
        expectedUrl: "https://example.com/shared-a",
        keeper: {
          expectedUrl: "https://example.com/shared-a",
          tabId: 101,
        },
        tabId: 41,
      },
      {
        expectedUrl: "https://example.com/shared-b",
        keeper: {
          expectedUrl: "https://example.com/shared-b",
          tabId: 102,
        },
        tabId: 42,
      },
      {
        expectedUrl: "https://example.com/shared-c",
        keeper: {
          expectedUrl: "https://example.com/shared-c",
          tabId: 103,
        },
        tabId: 43,
      },
    ];

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { kind: "close-preview", targets },
        },
      ),
    ).resolves.toEqual({
      candidateTabIds: [43],
      expiresAt: 301_000,
      kind: "close-preview",
      previewId,
      requested: 3,
      skipped: [
        { reason: "keeper-missing", tabId: 41 },
        { reason: "keeper-changed", tabId: 42 },
      ],
    });

    expect(sessionStorage.set).toHaveBeenCalledWith({
      [`tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`]: {
        ...CURRENT_SCOPE,
        expiresAt: 301_000,
        previewId,
        targets: [targets[2]],
        version: 1,
      },
    });
  });

  it("refuses to persist a close token when its generated id is invalid", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockResolvedValue({
      active: false,
      id: 41,
      index: 1,
      pinned: false,
      url: "https://example.com/41",
      windowId: 7,
    });
    const sessionStorage = storage();
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => "not-an-opaque-id",
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            kind: "close-preview",
            targets: [
              { tabId: 41, expectedUrl: "https://example.com/41" },
            ],
          },
        },
      ),
    ).rejects.toThrow(/valid opaque id/i);

    expect(sessionStorage.set).not.toHaveBeenCalled();
  });

  it("rechecks a confirmed close, writes Undo first, and reports every skipped tab", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const previewTargets = [41, 42, 43, 44, 900].map((tabId) => ({
      expectedUrl: `https://example.com/${tabId}`,
      tabId,
    }));
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      active: tabId === 43,
      id: tabId,
      index: tabId,
      mutedInfo: { muted: tabId === 41 },
      pinned: tabId === 44,
      url:
        tabId === 42
          ? "https://example.com/navigated"
          : `https://example.com/${tabId}`,
      windowId: 7,
    }));
    const events: string[] = [];
    vi.mocked(browserAdapter.removeTab).mockImplementation(async () => {
      events.push("remove");
    });
    const sessionStorage = storage();
    vi.mocked(sessionStorage.get).mockResolvedValue({
      [`tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets: previewTargets,
        version: 1,
      },
    });
    vi.mocked(sessionStorage.set).mockImplementation(async (items) => {
      if (
        Object.hasOwn(
          items,
          `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`,
        )
      ) {
        events.push("journal");
      }
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => undoId,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "close",
      requested: 5,
      skipped: [
        { reason: "url-changed", tabId: 42 },
        { reason: "active-protected", tabId: 43 },
        { reason: "pinned-protected", tabId: 44 },
        { reason: "control-tab-protected", tabId: 900 },
      ],
      succeededTabIds: [41],
      undo: { count: 1, expiresAt: 602_000, undoId },
    });

    expect(events[0]).toBe("journal");
    expect(events).toContain("remove");
    expect(sessionStorage.remove).toHaveBeenCalledWith(
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`,
    );
  });

  it("keeps multiple close Undos discoverable newest-first across executor recreation", async () => {
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const firstPreviewId = "323e4567-e89b-42d3-a456-426614174000";
    const secondPreviewId = "423e4567-e89b-42d3-a456-426614174000";
    const firstUndoId = "523e4567-e89b-42d3-a456-426614174000";
    const secondUndoId = "623e4567-e89b-42d3-a456-426614174000";
    const sessionStorage = statefulStorage();
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      active: false,
      id: tabId,
      index: tabId,
      pinned: false,
      url: `https://example.com/${tabId}`,
      windowId: 7,
    }));
    let currentTime = 1_000;
    const ids = [firstUndoId, secondUndoId];
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => ids.shift()!,
      now: () => currentTime,
      storage: sessionStorage,
    });

    for (const [previewId, tabId] of [
      [firstPreviewId, 41],
      [secondPreviewId, 42],
    ] as const) {
      await sessionStorage.set({
        [previewKey]: {
          ...CURRENT_SCOPE,
          expiresAt: 100_000,
          previewId,
          targets: [{ expectedUrl: `https://example.com/${tabId}`, tabId }],
          version: 1,
        },
      });
      await executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      );
      currentTime += 1_000;
    }

    const recreatedExecutor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      now: () => currentTime,
      storage: sessionStorage,
    });
    await expect(
      recreatedExecutor.listPendingUndos(CURRENT_SCOPE),
    ).resolves.toEqual([
      { count: 1, expiresAt: 602_000, undoId: secondUndoId },
      { count: 1, expiresAt: 601_000, undoId: firstUndoId },
    ]);
  });

  it("cleans expired and malformed journal entries while listing pending Undos", async () => {
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const expiredUndoId = "423e4567-e89b-42d3-a456-426614174000";
    const pendingUndoId = "523e4567-e89b-42d3-a456-426614174000";
    const target = (originalTabId: number) => ({
      index: 1,
      muted: false,
      originalTabId,
      pinned: false,
      title: null,
      url: `https://example.com/${originalTabId}`,
      windowId: 7,
    });
    const sessionStorage = statefulStorage({
      [undoKey]: {
        entries: [
          {
            ...CURRENT_SCOPE,
            expiresAt: 1_500,
            targets: [target(41)],
            undoId: expiredUndoId,
            version: 1,
          },
          { undoId: "not-a-valid-record" },
          {
            ...CURRENT_SCOPE,
            expiresAt: 10_000,
            targets: [target(42)],
            undoId: pendingUndoId,
            version: 1,
          },
        ],
        version: 2,
      },
    });
    const currentExecutor = createPhysicalTabCommandExecutor({
      adapter: adapter(),
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(currentExecutor.listPendingUndos(CURRENT_SCOPE)).resolves.toEqual([
      { count: 1, expiresAt: 10_000, undoId: pendingUndoId },
    ]);

    const recreatedWithEarlierClock = createPhysicalTabCommandExecutor({
      adapter: adapter(),
      now: () => 1_000,
      storage: sessionStorage,
    });
    await expect(
      recreatedWithEarlierClock.listPendingUndos(CURRENT_SCOPE),
    ).resolves.toEqual([
      { count: 1, expiresAt: 10_000, undoId: pendingUndoId },
    ]);
  });

  it("keeps only the five newest pending Undo entries", async () => {
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const undoIds = [4, 5, 6, 7, 8, 9].map(
      (digit) => `${digit}23e4567-e89b-42d3-a456-426614174000`,
    );
    const entries = undoIds.map((undoId, index) => ({
      ...CURRENT_SCOPE,
      expiresAt: 100_000 - index,
      targets: [
        {
          index,
          muted: false,
          originalTabId: 41 + index,
          pinned: false,
          title: null,
          url: `https://example.com/${41 + index}`,
          windowId: 7,
        },
      ],
      undoId,
      version: 1,
    }));
    const sessionStorage = statefulStorage({
      [undoKey]: { entries, version: 2 },
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: adapter(),
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(executor.listPendingUndos(CURRENT_SCOPE)).resolves.toEqual(
      entries.slice(0, 5).map(({ expiresAt, undoId }) => ({
        count: 1,
        expiresAt,
        undoId,
      })),
    );
  });

  it("rejects a close of more than 500 tabs when it cannot fit a quota-safe Undo before removing tabs", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const suffix = "a".repeat(9_000);
    const targets = Array.from({ length: 501 }, (_, index) => ({
      expectedUrl: `https://example.com/${index}?value=${suffix}`,
      tabId: 1_000 + index,
    }));
    const sessionStorage = statefulStorage({
      [previewKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets,
        version: 1,
      },
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => ({
      active: false,
      id: tabId,
      index: tabId,
      pinned: false,
      url: targets[tabId - 1_000]!.expectedUrl,
      windowId: 7,
    }));
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => "423e4567-e89b-42d3-a456-426614174000",
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      ),
    ).rejects.toThrow(/quota-safe Undo journal/i);
    expect(browserAdapter.removeTab).not.toHaveBeenCalled();
  });

  it("undoes only the requested journal entry and leaves other closes pending", async () => {
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const newerUndoId = "423e4567-e89b-42d3-a456-426614174000";
    const requestedUndoId = "523e4567-e89b-42d3-a456-426614174000";
    const storedEntry = (undoId: string, originalTabId: number) => ({
      ...CURRENT_SCOPE,
      expiresAt: 100_000,
      targets: [
        {
          index: 1,
          muted: false,
          originalTabId,
          pinned: false,
          title: null,
          url: `https://example.com/${originalTabId}`,
          windowId: 7,
        },
      ],
      undoId,
      version: 1,
    });
    const sessionStorage = statefulStorage({
      [undoKey]: {
        entries: [
          storedEntry(newerUndoId, 41),
          storedEntry(requestedUndoId, 42),
        ],
        version: 2,
      },
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockRejectedValue(new Error("No tab"));
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 7,
      type: "normal",
    });
    vi.mocked(browserAdapter.createTab).mockResolvedValue({
      id: 142,
      index: 1,
      windowId: 7,
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { kind: "undo-close", undoId: requestedUndoId },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "undo-close",
      requested: 1,
      restoredTabIds: [142],
      skipped: [],
    });
    await expect(executor.listPendingUndos(CURRENT_SCOPE)).resolves.toEqual([
      { count: 1, expiresAt: 100_000, undoId: newerUndoId },
    ]);
  });

  it("does not close a duplicate when its keeper disappears or navigates after preview", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const sessionStorage = storage();
    vi.mocked(sessionStorage.get).mockResolvedValue({
      [previewKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets: [
          {
            expectedUrl: "https://example.com/shared-a",
            keeper: {
              expectedUrl: "https://example.com/shared-a",
              tabId: 101,
            },
            tabId: 41,
          },
          {
            expectedUrl: "https://example.com/shared-b",
            keeper: {
              expectedUrl: "https://example.com/shared-b",
              tabId: 102,
            },
            tabId: 42,
          },
        ],
        version: 1,
      },
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      if (tabId === 101) throw new Error("Keeper disappeared");
      if (tabId === 102) {
        return {
          id: 102,
          index: 2,
          url: "https://example.com/navigated",
          windowId: 7,
        };
      }
      return {
        active: false,
        id: tabId,
        index: tabId,
        pinned: false,
        url: tabId === 41
          ? "https://example.com/shared-a"
          : "https://example.com/shared-b",
        windowId: 7,
      };
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => undoId,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "close",
      requested: 2,
      skipped: [
        { reason: "keeper-missing", tabId: 41 },
        { reason: "keeper-changed", tabId: 42 },
      ],
      succeededTabIds: [],
      undo: null,
    });

    expect(browserAdapter.removeTab).not.toHaveBeenCalled();
  });

  it("durably refreshes Undo metadata from the live target immediately before remove", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const sessionStorage = statefulStorage({
      [previewKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets: [{ expectedUrl: "https://example.com/exact", tabId: 41 }],
        version: 1,
      },
    });
    const browserAdapter = adapter();
    let reads = 0;
    vi.mocked(browserAdapter.getTab).mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? {
            active: false,
            id: 41,
            index: 1,
            mutedInfo: { muted: false },
            pinned: false,
            title: "Preview title",
            url: "https://example.com/exact",
            windowId: 7,
          }
        : {
            active: false,
            id: 41,
            index: 9,
            mutedInfo: { muted: true },
            pinned: false,
            title: "Live title",
            url: "https://example.com/exact",
            windowId: 8,
          };
    });
    vi.mocked(browserAdapter.removeTab).mockImplementation(async () => {
      const journal = sessionStorage.peek(undoKey) as {
        entries: Array<{
          targets: Array<Record<string, unknown>>;
          undoId: string;
        }>;
      };
      expect(
        journal.entries.find((entry) => entry.undoId === undoId)?.targets[0],
      ).toMatchObject({
        index: 9,
        muted: true,
        originalTabId: 41,
        title: "Live title",
        windowId: 8,
      });
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => undoId,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      ),
    ).resolves.toMatchObject({
      failed: [],
      kind: "close",
      succeededTabIds: [41],
    });
  });

  it("keeps every live target crash-recoverable while a later remove is in flight", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const sessionStorage = statefulStorage({
      [previewKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets: [
          { expectedUrl: "https://example.com/41", tabId: 41 },
          { expectedUrl: "https://example.com/42", tabId: 42 },
        ],
        version: 1,
      },
    });
    const browserAdapter = adapter();
    const readsByTab = new Map<number, number>();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      const read = (readsByTab.get(tabId) ?? 0) + 1;
      readsByTab.set(tabId, read);
      const live = read > 1;
      return {
        active: false,
        id: tabId,
        index: live ? tabId + 10 : tabId - 40,
        mutedInfo: { muted: live },
        pinned: false,
        title: live ? `Live ${tabId}` : `Preview ${tabId}`,
        url: `https://example.com/${tabId}`,
        windowId: live ? tabId - 33 : 7,
      };
    });
    let signalSecondRemove!: () => void;
    const secondRemoveStarted = new Promise<void>((resolve) => {
      signalSecondRemove = resolve;
    });
    let releaseSecondRemove!: () => void;
    const secondRemovePending = new Promise<void>((resolve) => {
      releaseSecondRemove = resolve;
    });
    vi.mocked(browserAdapter.removeTab).mockImplementation((tabId) => {
      if (tabId !== 42) return Promise.resolve();
      signalSecondRemove();
      return secondRemovePending;
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => undoId,
      now: () => 2_000,
      storage: sessionStorage,
    });

    const execution = executor.execute(
      {
        controlTabId: 900,
        controlWindowId: 90,
        currentScope: CURRENT_SCOPE,
      },
      {
        ...CURRENT_SCOPE,
        command: { confirmed: true, kind: "close", previewId },
      },
    );
    await secondRemoveStarted;

    try {
      expect(browserAdapter.removeTab).toHaveBeenNthCalledWith(1, 41);
      expect(browserAdapter.removeTab).toHaveBeenNthCalledWith(2, 42);
      const journal = sessionStorage.peek(undoKey) as {
        entries: Array<{
          targets: Array<Record<string, unknown>>;
          undoId: string;
        }>;
      };
      expect(
        journal.entries.find((entry) => entry.undoId === undoId)?.targets,
      ).toMatchObject([
        {
          index: 51,
          muted: true,
          originalTabId: 41,
          title: "Live 41",
          windowId: 8,
        },
        {
          index: 52,
          muted: true,
          originalTabId: 42,
          title: "Live 42",
          windowId: 9,
        },
      ]);

      const recreatedExecutor = createPhysicalTabCommandExecutor({
        adapter: browserAdapter,
        now: () => 2_000,
        storage: sessionStorage,
      });
      await expect(
        recreatedExecutor.listPendingUndos(CURRENT_SCOPE),
      ).resolves.toEqual([
        { count: 2, expiresAt: 602_000, undoId },
      ]);
    } finally {
      releaseSecondRemove();
    }

    await expect(execution).resolves.toMatchObject({
      failed: [],
      kind: "close",
      succeededTabIds: [41, 42],
    });
  });

  it("rechecks the target immediately before remove after the Undo journal is durable", async () => {
    const previewId = "323e4567-e89b-42d3-a456-426614174000";
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const previewKey =
      `tabhub:physical-close-preview:${CURRENT_SCOPE.installationId}`;
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const sessionStorage = storage();
    vi.mocked(sessionStorage.get).mockResolvedValue({
      [previewKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        previewId,
        targets: [
          { expectedUrl: "https://example.com/exact", tabId: 41 },
        ],
        version: 1,
      },
    });
    let journalIsDurable = false;
    vi.mocked(sessionStorage.set).mockImplementation(async (items) => {
      if (Object.hasOwn(items, undoKey)) journalIsDurable = true;
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async () => ({
      active: false,
      id: 41,
      index: 1,
      pinned: false,
      url: journalIsDurable
        ? "https://example.com/navigated"
        : "https://example.com/exact",
      windowId: 7,
    }));
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      createId: () => undoId,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { confirmed: true, kind: "close", previewId },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "close",
      requested: 1,
      skipped: [{ reason: "url-changed", tabId: 41 }],
      succeededTabIds: [],
      undo: null,
    });
    expect(browserAdapter.removeTab).not.toHaveBeenCalled();
    expect(sessionStorage.remove).toHaveBeenCalledWith(undoKey);
  });

  it("consumes Undo once and restores missing tabs into original or replacement windows", async () => {
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const sessionStorage = storage();
    vi.mocked(sessionStorage.get).mockResolvedValue({
      [`tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        targets: [
          {
            index: 2,
            muted: true,
            originalTabId: 41,
            pinned: false,
            title: "First",
            url: "https://example.com/41",
            windowId: 7,
          },
          {
            index: 3,
            muted: false,
            originalTabId: 42,
            pinned: false,
            title: "Still open",
            url: "https://example.com/42",
            windowId: 7,
          },
          {
            index: 1,
            muted: false,
            originalTabId: 43,
            pinned: true,
            title: "New window",
            url: "https://example.com/43",
            windowId: 8,
          },
        ],
        undoId,
        version: 1,
      },
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockImplementation(async (tabId) => {
      if (tabId !== 42) throw new Error("No tab");
      return { id: 42, index: 3, windowId: 7 };
    });
    vi.mocked(browserAdapter.getWindow).mockImplementation(async (windowId) => {
      if (windowId === 8) throw new Error("No window");
      return { id: windowId, type: "normal" };
    });
    vi.mocked(browserAdapter.createTab).mockResolvedValue({
      id: 101,
      index: 2,
      windowId: 7,
    });
    vi.mocked(browserAdapter.createWindow).mockResolvedValue({
      id: 98,
      tabs: [{ id: 103, index: 0, windowId: 98 }],
      type: "normal",
    });
    vi.mocked(browserAdapter.updateTab).mockImplementation(async (tabId) => ({
      id: tabId,
      index: 0,
      windowId: tabId === 103 ? 98 : 7,
    }));
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { kind: "undo-close", undoId },
        },
      ),
    ).resolves.toEqual({
      failed: [],
      kind: "undo-close",
      requested: 3,
      restoredTabIds: [101, 103],
      skipped: [{ reason: "already-open", tabId: 42 }],
    });

    expect(sessionStorage.remove).toHaveBeenCalledWith(
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`,
    );
    expect(browserAdapter.createTab).toHaveBeenCalledWith({
      active: false,
      index: 2,
      pinned: false,
      url: "https://example.com/41",
      windowId: 7,
    });
    expect(browserAdapter.createWindow).toHaveBeenCalledWith({
      focused: false,
      url: "https://example.com/43",
    });
    expect(browserAdapter.updateTab).toHaveBeenCalledWith(101, { muted: true });
    expect(browserAdapter.updateTab).toHaveBeenCalledWith(103, { pinned: true });
  });

  it("keeps only failed-to-create Undo entries so retry cannot duplicate restored tabs", async () => {
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const undoKey =
      `tabhub:physical-close-undo:${CURRENT_SCOPE.installationId}`;
    const targets = [41, 42, 43].map((originalTabId) => ({
      index: originalTabId,
      muted: originalTabId === 43,
      originalTabId,
      pinned: false,
      title: null,
      url: `https://example.com/${originalTabId}`,
      windowId: 7,
    }));
    const sessionStorage = storage();
    vi.mocked(sessionStorage.get).mockResolvedValue({
      [undoKey]: {
        ...CURRENT_SCOPE,
        expiresAt: 100_000,
        targets,
        undoId,
        version: 1,
      },
    });
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getTab).mockRejectedValue(new Error("No tab"));
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 7,
      type: "normal",
    });
    vi.mocked(browserAdapter.createTab).mockImplementation(async (properties) => {
      if (properties.url === "https://example.com/42") {
        throw new Error("Cannot restore this URL");
      }
      return {
        id: properties.url === "https://example.com/43" ? 103 : 101,
        index: 41,
        windowId: 7,
      };
    });
    vi.mocked(browserAdapter.updateTab).mockRejectedValue(
      new Error("Could not restore mute flag"),
    );
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      now: () => 2_000,
      storage: sessionStorage,
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: { kind: "undo-close", undoId },
        },
      ),
    ).resolves.toEqual({
      failed: [
        { error: "Cannot restore this URL", tabId: 42 },
        { error: "Could not restore mute flag", tabId: 43 },
      ],
      kind: "undo-close",
      requested: 3,
      retry: { count: 1, expiresAt: 100_000, undoId },
      restoredTabIds: [101, 103],
      skipped: [],
    });

    expect(sessionStorage.remove).not.toHaveBeenCalledWith(undoKey);
    expect(sessionStorage.set).toHaveBeenLastCalledWith({
      [undoKey]: {
        entries: [
          {
            ...CURRENT_SCOPE,
            expiresAt: 100_000,
            targets: [targets[1]],
            undoId,
            version: 1,
          },
        ],
        version: 2,
      },
    });
  });

  it("opens a saved workspace in the window containing TabHub with partial results", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 90,
      type: "normal",
    });
    vi.mocked(browserAdapter.createTab).mockImplementation(async (properties) => {
      if (properties.url === "https://example.com/fail") {
        throw new Error("Cannot open URL");
      }
      return {
        id:
          properties.url === "https://example.com/one"
            ? 101
            : properties.url === "https://example.com/flags-fail"
              ? 104
              : 102,
        index: 0,
        windowId: 90,
      };
    });
    vi.mocked(browserAdapter.updateTab).mockImplementation(async (tabId) => {
      if (tabId === 104) throw new Error("Could not restore mute flag");
      return { id: tabId, index: 0, windowId: 90 };
    });
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            destination: { kind: "app-window" },
            kind: "open-workspace",
            tabs: [
              { muted: true, pinned: false, url: "https://example.com/one" },
              { muted: false, pinned: true, url: "https://example.com/fail" },
              { muted: false, pinned: true, url: "https://example.com/two" },
              {
                muted: true,
                pinned: false,
                url: "https://example.com/flags-fail",
              },
            ],
          },
        },
      ),
    ).resolves.toEqual({
      destinationWindowId: 90,
      failed: [
        { error: "Cannot open URL", index: 1 },
        { error: "Could not restore mute flag", index: 3 },
      ],
      kind: "open-workspace",
      openedTabIds: [101, 102, 104],
      requested: 4,
    });

    expect(browserAdapter.createTab).toHaveBeenNthCalledWith(1, {
      active: false,
      pinned: false,
      url: "https://example.com/one",
      windowId: 90,
    });
    expect(browserAdapter.updateTab).toHaveBeenCalledWith(101, { muted: true });
  });

  it("opens every saved tab when a workspace contains more than 500 entries", async () => {
    const tabs = Array.from({ length: 501 }, (_, index) => ({
      muted: false,
      pinned: false,
      url: `https://example.com/saved/${index}`,
    }));
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.getWindow).mockResolvedValue({
      id: 90,
      type: "normal",
    });
    vi.mocked(browserAdapter.createTab).mockImplementation(
      async (_properties) => ({
        id: 1_000 + vi.mocked(browserAdapter.createTab).mock.calls.length,
        index: 0,
        windowId: 90,
      }),
    );
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    const result = await executor.execute(
      {
        controlTabId: 900,
        controlWindowId: 90,
        currentScope: CURRENT_SCOPE,
      },
      {
        ...CURRENT_SCOPE,
        command: {
          destination: { kind: "app-window" },
          kind: "open-workspace",
          tabs,
        },
      },
    );

    if (!("openedTabIds" in result)) {
      throw new Error(`Expected open-workspace, received ${result.kind}`);
    }
    expect(result.requested).toBe(501);
    expect(result.failed).toEqual([]);
    expect(result.openedTabIds).toHaveLength(501);
    expect(browserAdapter.createTab).toHaveBeenCalledTimes(501);
    expect(browserAdapter.createTab).toHaveBeenNthCalledWith(
      501,
      expect.objectContaining({ url: "https://example.com/saved/500" }),
    );
  });

  it("opens the first saved tab as the anchor of one new workspace window", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.createWindow).mockResolvedValue({
      id: 99,
      tabs: [{ id: 101, index: 0, windowId: 99 }],
      type: "normal",
    });
    vi.mocked(browserAdapter.createTab).mockResolvedValue({
      id: 102,
      index: 1,
      windowId: 99,
    });
    vi.mocked(browserAdapter.updateTab).mockImplementation(async (tabId) => ({
      id: tabId,
      index: 0,
      windowId: 99,
    }));
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(
      executor.execute(
        {
          controlTabId: 900,
          controlWindowId: 90,
          currentScope: CURRENT_SCOPE,
        },
        {
          ...CURRENT_SCOPE,
          command: {
            destination: { kind: "new-window" },
            kind: "open-workspace",
            tabs: [
              { muted: true, pinned: true, url: "https://example.com/one" },
              { muted: false, pinned: false, url: "https://example.com/two" },
            ],
          },
        },
      ),
    ).resolves.toEqual({
      destinationWindowId: 99,
      failed: [],
      kind: "open-workspace",
      openedTabIds: [101, 102],
      requested: 2,
    });

    expect(browserAdapter.createWindow).toHaveBeenCalledWith({
      focused: true,
      url: "https://example.com/one",
    });
    expect(browserAdapter.updateTab).toHaveBeenCalledWith(101, {
      muted: true,
      pinned: true,
    });
    expect(browserAdapter.createTab).toHaveBeenCalledWith({
      active: false,
      pinned: false,
      url: "https://example.com/two",
      windowId: 99,
    });
  });

  it("lists only normal browser windows for the probe in stable focus order", async () => {
    const browserAdapter = adapter();
    vi.mocked(browserAdapter.listWindows).mockResolvedValue([
      { focused: false, id: 8, tabs: [], type: "normal" },
      {
        focused: true,
        id: 7,
        tabs: [
          { id: 1, index: 0, windowId: 7 },
          { id: 2, index: 1, windowId: 7 },
        ],
        type: "normal",
      },
      { focused: false, id: 9, tabs: [], type: "popup" },
      { focused: false, tabs: [], type: "normal" },
    ]);
    const executor = createPhysicalTabCommandExecutor({
      adapter: browserAdapter,
      storage: storage(),
    });

    await expect(executor.listWindows()).resolves.toEqual([
      { focused: true, tabCount: 2, windowId: 7 },
      { focused: false, tabCount: 0, windowId: 8 },
    ]);
  });
});

describe("parsePhysicalTabCommand", () => {
  it("parses every strict v4 command shape", () => {
    const targets = [{ tabId: 42, expectedUrl: "https://example.com/42" }];

    expect(
      [
        {
          kind: "close-preview",
          targets: [
            {
              ...targets[0],
              keeper: {
                expectedUrl: "https://example.com/42",
                tabId: 99,
              },
            },
          ],
        },
        {
          confirmed: true,
          kind: "close",
          previewId: "323e4567-e89b-42d3-a456-426614174000",
        },
        { destination: { kind: "app-window" }, kind: "move", targets },
        {
          destination: { kind: "window", windowId: 7 },
          kind: "move",
          targets,
        },
        { destination: { kind: "new-window" }, kind: "move", targets },
        { kind: "set-pinned", targets, value: true },
        { kind: "set-muted", targets, value: false },
        { kind: "discard", targets },
        { bypassCache: true, kind: "reload", targets },
        {
          kind: "undo-close",
          undoId: "423e4567-e89b-42d3-a456-426614174000",
        },
        {
          destination: { kind: "new-window" },
          kind: "open-workspace",
          tabs: [
            { muted: false, pinned: true, url: "https://example.com/saved" },
          ],
        },
      ].map(parsePhysicalTabCommand),
    ).not.toContain(undefined);
  });

  it("accepts complete physical-tab and workspace requests larger than 500 entries", () => {
    const targets = Array.from({ length: 501 }, (_, index) => ({
      expectedUrl: `https://example.com/${index}`,
      tabId: 1_000 + index,
    }));
    const tabs = Array.from({ length: 501 }, (_, index) => ({
      muted: index % 2 === 0,
      pinned: index % 3 === 0,
      url: `https://example.com/saved/${index}`,
    }));

    expect(
      parsePhysicalTabCommand({ kind: "discard", targets }),
    ).toMatchObject({ kind: "discard", targets });
    expect(
      parsePhysicalTabCommand({ kind: "close-preview", targets }),
    ).toMatchObject({ kind: "close-preview", targets });
    expect(
      parsePhysicalTabCommand({
        destination: { kind: "new-window" },
        kind: "open-workspace",
        tabs,
      }),
    ).toMatchObject({ kind: "open-workspace", tabs });
  });

  it.each([
    { kind: "discard", targets: [] },
    {
      kind: "set-muted",
      targets: [
        { tabId: 42, expectedUrl: "https://example.com" },
        { tabId: 42, expectedUrl: "https://example.com/other" },
      ],
      value: true,
    },
    {
      kind: "close-preview",
      targets: [{ tabId: 42, expectedUrl: "not a URL" }],
    },
    {
      kind: "close-preview",
      targets: [
        {
          expectedUrl: "https://example.com/shared",
          keeper: {
            expectedUrl: "https://example.com/shared",
            extra: true,
            tabId: 99,
          },
          tabId: 42,
        },
      ],
    },
    {
      kind: "close-preview",
      targets: [
        {
          expectedUrl: "https://example.com/shared",
          keeper: {
            expectedUrl: "https://example.com/shared",
            tabId: 43,
          },
          tabId: 42,
        },
        {
          expectedUrl: "https://example.com/shared",
          tabId: 43,
        },
      ],
    },
    {
      kind: "close-preview",
      targets: [
        {
          expectedUrl: "https://example.com/shared",
          keeper: {
            expectedUrl: "https://example.com/different",
            tabId: 99,
          },
          tabId: 42,
        },
      ],
    },
    {
      kind: "close-preview",
      targets: [
        {
          expectedUrl: "https://example.com/shared",
          keeper: {
            expectedUrl: "https://example.com/shared",
            tabId: 42,
          },
          tabId: 42,
        },
      ],
    },
    {
      kind: "close",
      confirmed: false,
      previewId: "323e4567-e89b-42d3-a456-426614174000",
    },
    {
      destination: { kind: "window", windowId: -1 },
      kind: "move",
      targets: [{ tabId: 42, expectedUrl: "https://example.com" }],
    },
    {
      destination: { kind: "window", windowId: 7, extra: true },
      kind: "move",
      targets: [{ tabId: 42, expectedUrl: "https://example.com" }],
    },
    {
      destination: { kind: "app-window" },
      extra: true,
      kind: "open-workspace",
      tabs: [
        { muted: false, pinned: false, url: "https://example.com/saved" },
      ],
    },
  ])("rejects an unsafe command: %#", (command) => {
    expect(parsePhysicalTabCommand(command)).toBeUndefined();
  });
});
