import { describe, expect, it, vi } from "vitest";

import { readBrowserState } from "./browser-state";

const scope = {
  browser: "yandex",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};

describe("readBrowserState", () => {
  it("returns windows and session-scoped pending Undos from one shared reader", async () => {
    const pendingUndos = [
      {
        count: 2,
        expiresAt: 30_000,
        undoId: "323e4567-e89b-42d3-a456-426614174000",
      },
    ];
    const windows = [{ focused: true, tabCount: 14, windowId: 7 }];
    const listPendingUndos = vi.fn(async () => pendingUndos);
    const listWindows = vi.fn(async () => windows);

    await expect(
      readBrowserState({ listPendingUndos, listWindows }, scope),
    ).resolves.toEqual({ pendingUndos, windows });
    expect(listPendingUndos).toHaveBeenCalledOnce();
    expect(listPendingUndos).toHaveBeenCalledWith(scope);
    expect(listWindows).toHaveBeenCalledOnce();
  });

  it("still lists windows before identity is configured without reading Undo state", async () => {
    const listPendingUndos = vi.fn();
    const windows = [{ focused: false, tabCount: 3, windowId: 9 }];

    await expect(
      readBrowserState(
        {
          listPendingUndos,
          listWindows: vi.fn(async () => windows),
        },
        undefined,
      ),
    ).resolves.toEqual({ pendingUndos: [], windows });
    expect(listPendingUndos).not.toHaveBeenCalled();
  });
});
