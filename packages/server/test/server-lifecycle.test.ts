import { describe, expect, it, vi } from "vitest";

import { listenWithCleanup } from "../src/server-lifecycle.js";

describe("server startup lifecycle", () => {
  const listenOptions = { host: "127.0.0.1", port: 7_717 };

  it("closes initialized resources when socket binding fails", async () => {
    const listenError = new Error("EADDRINUSE");
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn().mockRejectedValue(listenError),
    };

    await expect(listenWithCleanup(app, listenOptions)).rejects.toBe(
      listenError,
    );
    expect(app.close).toHaveBeenCalledOnce();
  });

  it("preserves the startup error if cleanup also fails", async () => {
    const listenError = new Error("invalid port");
    const closeError = new Error("database close failed");
    const reportCleanupError = vi.fn();
    const app = {
      close: vi.fn().mockRejectedValue(closeError),
      listen: vi.fn().mockRejectedValue(listenError),
    };

    await expect(
      listenWithCleanup(app, listenOptions, reportCleanupError),
    ).rejects.toBe(listenError);
    expect(reportCleanupError).toHaveBeenCalledWith(closeError);
  });

  it("keeps the running server open after a successful bind", async () => {
    const app = {
      close: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn().mockResolvedValue("http://127.0.0.1:7717"),
    };

    await expect(
      listenWithCleanup(app, listenOptions),
    ).resolves.toBeUndefined();
    expect(app.close).not.toHaveBeenCalled();
  });
});
