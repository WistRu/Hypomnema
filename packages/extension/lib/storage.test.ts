import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: storage,
    },
  },
}));

import { STORAGE_KEYS } from "./constants";
import { createPendingSnapshot } from "./queue";
import {
  BROWSER_CONFIG_VERSION,
  getBrowserIdentifier,
  getStoredBrowserIdentifier,
  writeIdentityAndQueueState,
} from "./storage";

describe("browser identity storage", () => {
  beforeEach(() => {
    storage.get.mockReset();
    storage.set.mockReset();
  });

  it("treats a legacy auto-default without an explicit marker as unconfigured", async () => {
    storage.get.mockResolvedValue({ [STORAGE_KEYS.browser]: "chrome" });

    await expect(getBrowserIdentifier()).resolves.toBeUndefined();
  });

  it("retains a legacy identity only for closing its stale server rows", async () => {
    storage.get.mockResolvedValue({ [STORAGE_KEYS.browser]: "chrome" });

    await expect(getStoredBrowserIdentifier()).resolves.toBe("chrome");
  });

  it("returns an identity only when the explicit-choice marker is current", async () => {
    storage.get.mockResolvedValue({
      [STORAGE_KEYS.browser]: "edge",
      [STORAGE_KEYS.browserConfigured]: BROWSER_CONFIG_VERSION,
    });

    await expect(getBrowserIdentifier()).resolves.toBe("edge");
  });

  it("writes the identity and explicit-choice marker together", async () => {
    storage.set.mockResolvedValue(undefined);

    await writeIdentityAndQueueState("yandex", [], []);

    expect(storage.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.browser]: "yandex",
      [STORAGE_KEYS.browserConfigured]: BROWSER_CONFIG_VERSION,
      [STORAGE_KEYS.deadLetters]: [],
      [STORAGE_KEYS.pendingSnapshots]: [],
    });
  });

  it("persists the close-old/open-new transition in the supplied order", async () => {
    storage.set.mockResolvedValue(undefined);
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

    expect(storage.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.browser]: "edge",
        [STORAGE_KEYS.pendingSnapshots]: [closeOld, openNew],
      }),
    );
  });
});
