import { describe, expect, it, vi } from "vitest";

import { createWindowsBrowserForegroundHandoff } from "../src/browser-foreground.js";

describe("Windows browser foreground handoff", () => {
  it("addresses the exact browser process and window metadata", async () => {
    const runHelper = vi.fn().mockResolvedValue("OK|10856|5002E\r\n");
    const handoff = createWindowsBrowserForegroundHandoff({
      platform: "win32",
      runHelper,
    });

    await expect(
      handoff({
        bounds: { height: 2169, left: -2160, top: -9, width: 2160 },
        browser: "edge",
        title: "Remote Edge tab",
      }),
    ).resolves.toEqual({
      ok: true,
      processId: 10856,
      windowHandle: "5002E",
    });
    expect(runHelper).toHaveBeenCalledWith([
      "msedge",
      "Remote Edge tab",
      "-2160",
      "-9",
      "2160",
      "2169",
    ]);
  });

  it("fails closed when the native helper cannot confirm foreground", async () => {
    const handoff = createWindowsBrowserForegroundHandoff({
      platform: "win32",
      runHelper: vi.fn().mockRejectedValue(new Error("focus denied")),
    });

    await expect(
      handoff({
        bounds: { height: 900, left: 0, top: 0, width: 1600 },
        browser: "yandex",
        title: "Remote Yandex tab",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "HELPER_EXECUTION_FAILED",
    });
  });

  it("fails a generic other-browser label closed on Windows", async () => {
    const runHelper = vi.fn();
    const handoff = createWindowsBrowserForegroundHandoff({
      platform: "win32",
      runHelper,
    });

    await expect(
      handoff({ browser: "other", title: "Other Chromium tab" }),
    ).resolves.toEqual({ ok: false, reason: "UNSUPPORTED_BROWSER" });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("leaves non-Windows on its native API path and fails unknown labels closed", async () => {
    const runHelper = vi.fn();
    const nonWindows = createWindowsBrowserForegroundHandoff({
      platform: "linux",
      runHelper,
    });
    const unknownLabel = createWindowsBrowserForegroundHandoff({
      platform: "win32",
      runHelper,
    });

    await expect(
      nonWindows({ browser: "edge", title: "Tab" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      unknownLabel({ browser: "unconfigured-browser", title: "Tab" }),
    ).resolves.toEqual({ ok: false, reason: "UNSUPPORTED_BROWSER" });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("preserves an explicit native matching failure for server diagnostics", async () => {
    const handoff = createWindowsBrowserForegroundHandoff({
      platform: "win32",
      runHelper: vi.fn().mockResolvedValue("AMBIGUOUS_MATCH\r\n"),
    });

    await expect(
      handoff({ browser: "chrome", title: "Repeated title" }),
    ).resolves.toEqual({ ok: false, reason: "AMBIGUOUS_MATCH" });
  });
});
