import { describe, expect, it, vi } from "vitest";

import {
  activateExistingTab,
  activateTabForScope,
} from "./activate-tab";

describe("activateExistingTab", () => {
  it("activates the exact existing tab and then focuses its current window", async () => {
    const get = vi.fn().mockResolvedValue({
      id: 42,
      url: "https://example.com/exact",
      windowId: 7,
    });
    const activate = vi.fn().mockResolvedValue({
      id: 42,
      windowId: 9,
    });
    const getWindow = vi.fn().mockResolvedValue({ state: "maximized" });
    const focusWindow = vi.fn().mockResolvedValue(undefined);
    const restoreWindow = vi.fn().mockResolvedValue(undefined);

    await expect(
      activateExistingTab(
        { activate, focusWindow, get, getWindow, restoreWindow },
        42,
      ),
    ).resolves.toEqual({
      tabId: 42,
      windowId: 9,
    });

    expect(activate).toHaveBeenCalledWith(42);
    expect(getWindow).toHaveBeenCalledWith(9);
    expect(restoreWindow).not.toHaveBeenCalled();
    expect(focusWindow).toHaveBeenCalledWith(9);
    expect(activate.mock.invocationCallOrder[0]).toBeLessThan(
      focusWindow.mock.invocationCallOrder[0]!,
    );
  });

  it("uses physical identity even when that tab has navigated since the snapshot", async () => {
    const activate = vi.fn().mockResolvedValue({
      id: 42,
      pendingUrl: "https://example.com/loading-next",
      url: "https://example.com/changed",
      windowId: 7,
    });
    const focusWindow = vi.fn().mockResolvedValue(undefined);

    await expect(
      activateExistingTab(
        {
          activate,
          focusWindow,
          get: vi.fn().mockResolvedValue({
            id: 42,
            url: "https://example.com/changed",
            windowId: 7,
          }),
          getWindow: vi.fn().mockResolvedValue({ state: "normal" }),
          restoreWindow: vi.fn(),
        },
        42,
      ),
    ).resolves.toEqual({ tabId: 42, windowId: 7 });

    expect(activate).toHaveBeenCalledWith(42);
    expect(focusWindow).toHaveBeenCalledWith(7);
  });

  it("restores a minimized destination window without resetting other window states", async () => {
    const restoreWindow = vi.fn().mockResolvedValue(undefined);
    const focusWindow = vi.fn().mockResolvedValue(undefined);

    await expect(
      activateExistingTab(
        {
          get: vi.fn().mockResolvedValue({ id: 42, windowId: 7 }),
          activate: vi.fn().mockResolvedValue({ id: 42, windowId: 7 }),
          focusWindow,
          getWindow: vi.fn().mockResolvedValue({ state: "minimized" }),
          restoreWindow,
        },
        42,
      ),
    ).resolves.toEqual({ tabId: 42, windowId: 7 });

    expect(restoreWindow).toHaveBeenCalledWith(7);
    expect(focusWindow).toHaveBeenCalledWith(7);
    expect(restoreWindow.mock.invocationCallOrder[0]).toBeLessThan(
      focusWindow.mock.invocationCallOrder[0]!,
    );
  });

  it("does not focus any window when the native tab no longer exists", async () => {
    const activate = vi.fn();
    const focusWindow = vi.fn();

    await expect(
      activateExistingTab(
        {
          activate,
          focusWindow,
          get: vi.fn().mockRejectedValue(new Error("No tab with id: 42")),
          getWindow: vi.fn(),
          restoreWindow: vi.fn(),
        },
        42,
      ),
    ).rejects.toThrow("No tab with id: 42");

    expect(activate).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
  });
});

describe("activateTabForScope", () => {
  it.each([
    {
      requested: {
        browser: "edge",
        browserSessionId: "session-a",
        installationId: "install-a",
        tabId: 42,
      },
      mismatch: "browser identity",
    },
    {
      requested: {
        browser: "chrome",
        browserSessionId: "session-a",
        installationId: "install-b",
        tabId: 42,
      },
      mismatch: "installation identity",
    },
    {
      requested: {
        browser: "chrome",
        browserSessionId: "session-b",
        installationId: "install-a",
        tabId: 42,
      },
      mismatch: "browser session identity",
    },
  ])("rejects a different $mismatch before reading any tab", async ({ requested }) => {
    const get = vi.fn();

    await expect(
      activateTabForScope(
        {
          activate: vi.fn(),
          focusWindow: vi.fn(),
          get,
          getWindow: vi.fn(),
          restoreWindow: vi.fn(),
        },
        {
          browser: "chrome",
          browserSessionId: "session-a",
          installationId: "install-a",
        },
        requested,
      ),
    ).rejects.toThrow("different browser installation");

    expect(get).not.toHaveBeenCalled();
  });
});
