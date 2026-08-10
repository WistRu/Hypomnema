import { snapshotTabFaviconUrlMaxLength } from "@tabhub/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorage = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));
const sessionStorage = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: localStorage,
      session: sessionStorage,
    },
  },
}));

import { STORAGE_KEYS } from "./constants";
import { createPendingActivity, createPendingSnapshot } from "./queue";
import {
  BROWSER_CONFIG_VERSION,
  getBrowserIdentifier,
  getOrCreateBrowserSessionId,
  getOrCreateInstallationId,
  readQueueState,
  writeActivityCheckpointAndQueueState,
  writeIdentityAndQueueState,
} from "./storage";

describe("browser identity storage", () => {
  beforeEach(() => {
    localStorage.get.mockReset();
    localStorage.set.mockReset();
    sessionStorage.get.mockReset();
    sessionStorage.set.mockReset();
  });

  it("treats a legacy auto-default without an explicit marker as unconfigured", async () => {
    localStorage.get.mockResolvedValue({ [STORAGE_KEYS.browser]: "chrome" });

    await expect(getBrowserIdentifier()).resolves.toBeUndefined();
  });

  it("returns an identity only when the explicit-choice marker is current", async () => {
    localStorage.get.mockResolvedValue({
      [STORAGE_KEYS.browser]: "edge",
      [STORAGE_KEYS.browserConfigured]: BROWSER_CONFIG_VERSION,
    });

    await expect(getBrowserIdentifier()).resolves.toBe("edge");
  });

  it("writes the identity and explicit-choice marker together", async () => {
    localStorage.set.mockResolvedValue(undefined);

    await writeIdentityAndQueueState("yandex", [], []);

    expect(localStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.browser]: "yandex",
      [STORAGE_KEYS.browserConfigured]: BROWSER_CONFIG_VERSION,
      [STORAGE_KEYS.deadLetters]: [],
      [STORAGE_KEYS.pendingSnapshots]: [],
    });
  });

  it("persists the close-old/open-new transition in the supplied order", async () => {
    localStorage.set.mockResolvedValue(undefined);
    const closeOld = createPendingSnapshot(
      { browser: "chrome", tabs: [] },
      "close-old",
    );
    const openNew = createPendingSnapshot(
      {
        browser: "edge",
        tabs: [{ index: 0, url: "https://example.com", windowId: 1 }],
      },
      "open-new",
    );

    await writeIdentityAndQueueState("edge", [closeOld, openNew], []);

    expect(localStorage.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.browser]: "edge",
        [STORAGE_KEYS.pendingSnapshots]: [closeOld, openNew],
      }),
    );
  });

  it("turns legacy queue records rejected by the current schema into dead letters", async () => {
    const legacyOversizedSnapshot = {
      attempts: 0,
      createdAt: "2026-08-07T12:00:00.000Z",
      id: "legacy-oversized",
      kind: "snapshot",
      payload: {
        browser: "chrome",
        tabs: [
          {
            faviconUrl: "f".repeat(snapshotTabFaviconUrlMaxLength + 1),
            index: 0,
            url: "https://example.com",
            windowId: 1,
          },
        ],
      },
    };
    localStorage.get.mockResolvedValue({
      [STORAGE_KEYS.deadLetters]: [],
      [STORAGE_KEYS.pendingSnapshots]: [legacyOversizedSnapshot],
    });

    const state = await readQueueState();

    expect(state.pending).toEqual([]);
    expect(state.deadLetters).toEqual([
      expect.objectContaining({
        attempts: 1,
        browser: "chrome",
        createdAt: "2026-08-07T12:00:00.000Z",
        error: expect.stringContaining("queue migration"),
        id: "legacy-oversized",
        kind: "snapshot",
      }),
    ]);
  });

  it("restores durable activity intervals from the offline queue", async () => {
    const pending = createPendingActivity({
      id: "323e4567-e89b-42d3-a456-426614174000",
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      browserTabId: 42,
      sequence: 1,
      url: "https://example.com/article",
      startedAt: "2026-08-10T12:00:00.000Z",
      endedAt: "2026-08-10T12:00:10.000Z",
      foregroundMs: 10_000,
      engagedMs: 4_000,
    });
    localStorage.get.mockResolvedValue({
      [STORAGE_KEYS.deadLetters]: [],
      [STORAGE_KEYS.pendingSnapshots]: [pending],
    });

    await expect(readQueueState()).resolves.toEqual({
      deadLetters: [],
      pending: [pending],
    });
  });

  it("persists an activity checkpoint atomically with its retry-safe queue item", async () => {
    const pending = createPendingActivity({
      id: "323e4567-e89b-42d3-a456-426614174000",
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      browserTabId: 42,
      sequence: 1,
      url: "https://example.com/article",
      startedAt: "2026-08-10T12:00:00.000Z",
      endedAt: "2026-08-10T12:00:10.000Z",
      foregroundMs: 10_000,
      engagedMs: 4_000,
    });
    const checkpoint = {
      browser: "chrome" as const,
      installationId: pending.payload.installationId,
      browserSessionId: pending.payload.browserSessionId,
      sequence: 1,
      tracker: {
        engagedUntil: Date.parse(pending.payload.endedAt) + 60_000,
        lastObservedAt: Date.parse(pending.payload.endedAt),
        machineActive: true,
        target: {
          browserTabId: 42,
          url: pending.payload.url,
        },
      },
    };

    await writeActivityCheckpointAndQueueState(checkpoint, [pending], []);

    expect(localStorage.set).toHaveBeenCalledOnce();
    expect(localStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.activityCheckpoint]: checkpoint,
      [STORAGE_KEYS.deadLetters]: [],
      [STORAGE_KEYS.pendingSnapshots]: [pending],
    });
  });
});

describe("installation identity storage", () => {
  beforeEach(() => {
    localStorage.get.mockReset();
    localStorage.set.mockReset();
    sessionStorage.get.mockReset();
    sessionStorage.set.mockReset();
  });

  it("creates one stable UUID when concurrent callers find no stored identity", async () => {
    localStorage.get.mockResolvedValue({});
    localStorage.set.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      getOrCreateInstallationId(),
      getOrCreateInstallationId(),
    ]);

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).toBe(first);
    expect(localStorage.get).toHaveBeenCalledTimes(1);
    expect(localStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.installationId]: first,
    });
  });

  it("reuses a valid stored installation UUID without rewriting storage", async () => {
    const installationId = "123e4567-e89b-42d3-a456-426614174000";
    localStorage.get.mockResolvedValue({
      [STORAGE_KEYS.installationId]: installationId,
    });

    await expect(getOrCreateInstallationId()).resolves.toBe(installationId);
    expect(localStorage.set).not.toHaveBeenCalled();
  });

  it("replaces malformed stored installation identity", async () => {
    localStorage.get.mockResolvedValue({
      [STORAGE_KEYS.installationId]: "not-an-installation-uuid",
    });
    localStorage.set.mockResolvedValue(undefined);

    const installationId = await getOrCreateInstallationId();

    expect(installationId).not.toBe("not-an-installation-uuid");
    expect(localStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.installationId]: installationId,
    });
  });
});

describe("browser session identity storage", () => {
  beforeEach(() => {
    localStorage.get.mockReset();
    localStorage.set.mockReset();
    sessionStorage.get.mockReset();
    sessionStorage.set.mockReset();
  });

  it("creates one UUID in session storage for concurrent startup paths", async () => {
    sessionStorage.get.mockResolvedValue({});
    sessionStorage.set.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      getOrCreateBrowserSessionId(),
      getOrCreateBrowserSessionId(),
    ]);

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second).toBe(first);
    expect(sessionStorage.get).toHaveBeenCalledTimes(1);
    expect(sessionStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.browserSessionId]: first,
    });
    expect(localStorage.set).not.toHaveBeenCalled();
  });

  it("reuses a valid UUID for service-worker restarts in the same browser session", async () => {
    const browserSessionId = "223e4567-e89b-42d3-a456-426614174000";
    sessionStorage.get.mockResolvedValue({
      [STORAGE_KEYS.browserSessionId]: browserSessionId,
    });

    await expect(getOrCreateBrowserSessionId()).resolves.toBe(browserSessionId);
    expect(sessionStorage.set).not.toHaveBeenCalled();
  });

  it("replaces malformed browser-session identity without touching persistent storage", async () => {
    sessionStorage.get.mockResolvedValue({
      [STORAGE_KEYS.browserSessionId]: "not-a-session-uuid",
    });
    sessionStorage.set.mockResolvedValue(undefined);

    const browserSessionId = await getOrCreateBrowserSessionId();

    expect(browserSessionId).not.toBe("not-a-session-uuid");
    expect(sessionStorage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.browserSessionId]: browserSessionId,
    });
    expect(localStorage.set).not.toHaveBeenCalled();
  });
});
