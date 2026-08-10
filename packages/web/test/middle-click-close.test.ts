import { describe, expect, it, vi } from "vitest";

import {
  executeSingleTabClose,
  handleMiddleClickClose,
} from "../src/middle-click-close";

describe("middle-click close interaction", () => {
  it("closes only for the middle mouse button and consumes that gesture", () => {
    const close = vi.fn();
    const middleEvent = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(handleMiddleClickClose(middleEvent, close)).toBe(true);
    expect(middleEvent.preventDefault).toHaveBeenCalledOnce();
    expect(middleEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    const leftEvent = {
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    expect(handleMiddleClickClose(leftEvent, close)).toBe(false);
    expect(leftEvent.preventDefault).not.toHaveBeenCalled();
    expect(leftEvent.stopPropagation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("explicit single-tab close", () => {
  const scope = {
    browser: "edge",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    installationId: "123e4567-e89b-42d3-a456-426614174000",
  };
  const target = { expectedUrl: "https://example.com/exact", tabId: 73 };

  it("previews and confirms exactly the addressed physical tab", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        candidateTabIds: [73],
        expiresAt: Date.now() + 60_000,
        kind: "close-preview",
        previewId: "323e4567-e89b-42d3-a456-426614174000",
        requested: 1,
        skipped: [],
      })
      .mockResolvedValueOnce({
        failed: [],
        kind: "close",
        requested: 1,
        skipped: [],
        succeededTabIds: [73],
        undo: {
          count: 1,
          expiresAt: Date.now() + 60_000,
          undoId: "423e4567-e89b-42d3-a456-426614174000",
        },
      });

    await expect(
      executeSingleTabClose({ route: "relay", scope, target }, execute),
    ).resolves.toMatchObject({ kind: "close", succeededTabIds: [73] });
    expect(execute).toHaveBeenNthCalledWith(1, "relay", scope, {
      intent: "explicit-single",
      kind: "close-preview",
      targets: [target],
    });
    expect(execute).toHaveBeenNthCalledWith(2, "relay", scope, {
      confirmed: true,
      kind: "close",
      previewId: "323e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("fails closed without confirmation when preview is partial", async () => {
    const execute = vi.fn().mockResolvedValue({
      candidateTabIds: [],
      expiresAt: Date.now() + 60_000,
      kind: "close-preview",
      previewId: "323e4567-e89b-42d3-a456-426614174000",
      requested: 1,
      skipped: [{ reason: "control-tab-protected", tabId: 73 }],
    });

    await expect(
      executeSingleTabClose({ route: "direct", scope, target }, execute),
    ).rejects.toThrow("TabHub control tab is protected");
    expect(execute).toHaveBeenCalledOnce();
  });
});
