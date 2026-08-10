import { describe, expect, it, vi } from "vitest";

import { createActivityContentInjector } from "./activity-content-injection";

describe("activity content-script injection", () => {
  it("pings an eligible tab before injecting and skips an existing script", async () => {
    const inject = vi.fn(async () => undefined);
    const injector = createActivityContentInjector({
      getTab: async () => ({ url: "https://example.com" }),
      inject,
      ping: async () => true,
    });

    await injector.ensure(42);

    expect(inject).not.toHaveBeenCalled();
  });

  it("injects all frames only once when concurrent activation checks race", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inject = vi.fn(async () => gate);
    const injector = createActivityContentInjector({
      getTab: async () => ({ url: "https://example.com" }),
      inject,
      ping: async () => false,
    });

    const first = injector.ensure(42);
    const second = injector.ensure(42);
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(42);
  });

  it("silently skips protected pages and scripting failures", async () => {
    const inject = vi.fn(async () => {
      throw new Error("Cannot access this page");
    });
    const injector = createActivityContentInjector({
      getTab: async (tabId) => ({
        url: tabId === 1 ? "chrome://settings" : "https://chrome.google.com",
      }),
      inject,
      ping: async () => false,
    });

    await expect(injector.ensureAll([1, 2])).resolves.toBeUndefined();
    expect(inject).toHaveBeenCalledOnce();
  });
});
