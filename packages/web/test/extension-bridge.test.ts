import { afterEach, describe, expect, it, vi } from "vitest";

import { createExtensionBridge } from "../src/extension-bridge";

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

class FakeBridgeWindow {
  readonly posted: PostedMessage[] = [];
  readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: unknown, targetOrigin: string): void {
    this.posted.push({ message, targetOrigin });
  }

  respond(data: Record<string, unknown>, origin = "http://127.0.0.1:7717") {
    const event = {
      data,
      origin,
      source: this,
    } as unknown as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("local extension bridge", () => {
  it("probes with a correlated envelope and ignores unrelated responses", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "probe-1",
    });

    const pending = bridge.probe();

    expect(target.posted).toEqual([
      {
        message: {
          source: "tabhub-web",
          channel: "tabhub-extension-bridge",
          version: 3,
          requestId: "probe-1",
          type: "probe",
        },
        targetOrigin: "http://127.0.0.1:7717",
      },
    ]);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "another-request",
      type: "probe",
      ok: true,
      data: { available: true, installationId: "wrong", browser: "edge" },
    });
    expect(target.listeners.size).toBe(1);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "probe-1",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
      },
    });

    await expect(pending).resolves.toEqual({
      available: true,
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      browser: "chrome",
    });
    expect(target.listeners.size).toBe(0);
  });

  it("reports an unavailable extension when the probe times out", async () => {
    vi.useFakeTimers();
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://localhost:7717",
      requestId: () => "probe-timeout",
      timeouts: { probe: 25 },
    });

    const pending = bridge.probe();
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      available: false,
      browserSessionId: null,
      installationId: null,
      browser: null,
    });
    expect(target.listeners.size).toBe(0);
  });

  it("re-probes the live extension identity without reconstructing the bridge", async () => {
    const target = new FakeBridgeWindow();
    let nextId = 0;
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => `probe-refresh-${++nextId}`,
    });

    const first = bridge.probe();
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "probe-refresh-1",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: null,
      },
    });
    await expect(first).resolves.toMatchObject({ browser: null });

    const second = bridge.probe();
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "probe-refresh-2",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
      },
    });

    await expect(second).resolves.toMatchObject({ browser: "chrome" });
    expect(target.posted).toHaveLength(2);
  });

  it("activates one existing physical tab through a correlated request", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "activate-1",
    });

    const pending = bridge.activate({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
    });

    expect(target.posted).toEqual([
      {
        message: {
          browser: "chrome",
          browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
          channel: "tabhub-extension-bridge",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          requestId: "activate-1",
          source: "tabhub-web",
          tabId: 42,
          type: "activate-tab",
          version: 3,
        },
        targetOrigin: "http://127.0.0.1:7717",
      },
    ]);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "activate-1",
      type: "activate-tab",
      ok: true,
      data: {
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        tabId: 42,
        windowId: 7,
      },
    });

    await expect(pending).resolves.toEqual({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
      windowId: 7,
    });
  });

  it("rejects an invalid physical activation scope before posting", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
    });

    await expect(
      bridge.activate({
        browser: "chrome",
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        installationId: "legacy:chrome",
        tabId: 42,
      }),
    ).rejects.toThrow("Invalid physical tab activation target");
    expect(target.posted).toEqual([]);
  });

  it("reports an activation timeout as an outcome that may still complete", async () => {
    vi.useFakeTimers();
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "activate-timeout",
      timeouts: { activate: 25 },
    });

    const pending = bridge.activate({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      tabId: 42,
    });
    const rejection = expect(pending).rejects.toThrow(
      /outcome is unknown.*still complete/i,
    );
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(target.listeners.size).toBe(0);
  });

  it("previews and closes only the requested exact URLs with explicit confirmation", async () => {
    const target = new FakeBridgeWindow();
    let nextId = 0;
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => `request-${++nextId}`,
    });

    const preview = bridge.preview([
      " https://example.com/exact ",
      "https://example.com/exact",
    ]);
    expect(target.posted.at(-1)?.message).toMatchObject({
      requestId: "request-1",
      type: "preview-obvious-duplicates",
      urls: ["https://example.com/exact"],
    });
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "request-1",
      type: "preview-obvious-duplicates",
      ok: true,
      data: {
        browser: "chrome",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        previewId: "223e4567-e89b-42d3-a456-426614174000",
        totalGroups: 1,
        totalCloseCandidates: 2,
        totalProtected: 1,
      },
    });
    const previewResult = await preview;
    expect(previewResult).toMatchObject({ totalCloseCandidates: 2 });

    const close = bridge.close(previewResult.previewId);
    expect(target.posted.at(-1)?.message).toMatchObject({
      requestId: "request-2",
      type: "close-obvious-duplicates",
      confirmed: true,
      previewId: previewResult.previewId,
    });
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "request-2",
      type: "close-obvious-duplicates",
      ok: true,
      data: {
        browser: "chrome",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        closed: 2,
        skipped: 1,
        failed: 0,
      },
    });
    await expect(close).resolves.toEqual({
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      closed: 2,
      skipped: 1,
      failed: 0,
    });
  });

  it("surfaces a correlated extension rejection", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "close-1",
    });

    const pending = bridge.close("123e4567-e89b-42d3-a456-426614174001");
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 3,
      requestId: "close-1",
      type: "close-obvious-duplicates",
      ok: false,
      error: "Browser identity changed",
    });

    await expect(pending).rejects.toThrow("Browser identity changed");
    expect(target.listeners.size).toBe(0);
  });
});
