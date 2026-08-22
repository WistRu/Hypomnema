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
          version: 4,
          requestId: "probe-1",
          type: "probe",
        },
        targetOrigin: "http://127.0.0.1:7717",
      },
    ]);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "another-request",
      type: "probe",
      ok: true,
      data: { available: true, installationId: "wrong", browser: "edge" },
    });
    expect(target.listeners.size).toBe(1);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "probe-1",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        commandProtocolVersion: 4,
        controlWindowId: 7,
        extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
        pendingUndos: [
          {
            count: 2,
            expiresAt: 1_800_000_000_000,
            undoId: "323e4567-e89b-42d3-a456-426614174000",
          },
        ],
        windows: [{ focused: true, tabCount: 3, windowId: 7 }],
      },
    });

    await expect(pending).resolves.toEqual({
      available: true,
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      commandProtocolVersion: 4,
      controlWindowId: 7,
      extensionOrigin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      browser: "chrome",
      pendingUndos: [
        {
          count: 2,
          expiresAt: 1_800_000_000_000,
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      ],
      windows: [{ focused: true, tabCount: 3, windowId: 7 }],
    });
    expect(target.listeners.size).toBe(0);
  });

  it("normalizes a legacy probe without a command version to protocol v3", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "legacy-probe",
    });

    const pending = bridge.probe();
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "legacy-probe",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        controlWindowId: 7,
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
        pendingUndos: [],
        windows: [{ focused: true, tabCount: 3, windowId: 7 }],
      },
    });

    await expect(pending).resolves.toMatchObject({
      available: true,
      commandProtocolVersion: 3,
    });
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
      controlWindowId: null,
      installationId: null,
      browser: null,
      pendingUndos: [],
      windows: [],
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
      version: 4,
      requestId: "probe-refresh-1",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        controlWindowId: 7,
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: null,
        pendingUndos: [],
        windows: [{ focused: true, tabCount: 3, windowId: 7 }],
      },
    });
    await expect(first).resolves.toMatchObject({ browser: null });

    const second = bridge.probe();
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "probe-refresh-2",
      type: "probe",
      ok: true,
      data: {
        available: true,
        browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
        controlWindowId: 7,
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browser: "chrome",
        pendingUndos: [],
        windows: [{ focused: true, tabCount: 3, windowId: 7 }],
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
          version: 4,
        },
        targetOrigin: "http://127.0.0.1:7717",
      },
    ]);
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
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

  it("sends a scoped v4 close preview and parses its protected candidates", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "tab-command-1",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const pending = bridge.command({
      ...scope,
      command: {
        kind: "close-preview",
        targets: [
          {
            tabId: 42,
            expectedUrl: "https://example.com/exact",
            keeper: {
              tabId: 43,
              expectedUrl: "https://example.com/exact",
            },
          },
        ],
      },
    });

    expect(target.posted.at(-1)?.message).toMatchObject({
      ...scope,
      command: {
        kind: "close-preview",
        targets: [
          {
            expectedUrl: "https://example.com/exact",
            keeper: {
              expectedUrl: "https://example.com/exact",
              tabId: 43,
            },
            tabId: 42,
          },
        ],
      },
      type: "tab-command",
      version: 4,
    });
    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "tab-command-1",
      type: "tab-command",
      ok: true,
      data: {
        ...scope,
        result: {
          candidateTabIds: [42],
          expiresAt: 1_800_000_000_000,
          kind: "close-preview",
          previewId: "323e4567-e89b-42d3-a456-426614174000",
          requested: 1,
          skipped: [],
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      result: { candidateTabIds: [42], kind: "close-preview" },
    });
  });

  it("allows explicit-single close intent only for one physical target", () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "explicit-single-close",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const first = { expectedUrl: "https://example.com/one", tabId: 41 };

    expect(() =>
      bridge.command({
        ...scope,
        command: {
          intent: "explicit-single",
          kind: "close-preview",
          targets: [
            first,
            { expectedUrl: "https://example.com/two", tabId: 42 },
          ],
        },
      }),
    ).toThrow(/exactly one physical tab/i);

    void bridge.command({
      ...scope,
      command: {
        intent: "explicit-single",
        kind: "close-preview",
        targets: [first],
      },
    });
    expect(target.posted.at(-1)?.message).toMatchObject({
      command: {
        intent: "explicit-single",
        kind: "close-preview",
        targets: [first],
      },
    });
  });

  it("sends every one of 501 physical targets without truncation", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "large-tab-command",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const targets = Array.from({ length: 501 }, (_, tabId) => ({
      expectedUrl: `https://example.com/tab/${tabId}`,
      tabId,
    }));

    const pending = bridge.command({
      ...scope,
      command: { kind: "reload", targets },
    });
    const posted = target.posted.at(-1)?.message as {
      command: { targets: typeof targets };
    };
    expect(posted.command.targets).toHaveLength(501);
    expect(posted.command.targets.at(-1)).toEqual(targets.at(-1));

    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "large-tab-command",
      type: "tab-command",
      ok: true,
      data: {
        ...scope,
        result: {
          failed: [],
          kind: "reload",
          requested: 501,
          skipped: [],
          succeededTabIds: targets.map(({ tabId }) => tabId),
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      result: { kind: "reload", requested: 501 },
    });
  });

  it("sends every one of 2,001 workspace tabs without truncation", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "large-workspace-command",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const tabs = Array.from({ length: 2_001 }, (_, index) => ({
      muted: index % 2 === 0,
      pinned: index % 3 === 0,
      url: `https://example.com/workspace/${index}`,
    }));

    const pending = bridge.command({
      ...scope,
      command: {
        destination: { kind: "new-window" },
        kind: "open-workspace",
        tabs,
      },
    });
    const posted = target.posted.at(-1)?.message as {
      command: { tabs: typeof tabs };
    };
    expect(posted.command.tabs).toHaveLength(2_001);
    expect(posted.command.tabs.at(-1)).toEqual(tabs.at(-1));

    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "large-workspace-command",
      type: "tab-command",
      ok: true,
      data: {
        ...scope,
        result: {
          failed: [],
          kind: "open-workspace",
          openedTabIds: [],
          requested: 2_001,
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      result: { kind: "open-workspace", requested: 2_001 },
    });
  });

  it("keeps minimum, unique-ID, and URL validation without an upper bound", () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };

    expect(() =>
      bridge.command({
        ...scope,
        command: { kind: "reload", targets: [] },
      }),
    ).toThrow(/at least one physical tab/i);
    expect(() =>
      bridge.command({
        ...scope,
        command: {
          kind: "reload",
          targets: [
            { expectedUrl: "https://example.com/one", tabId: 1 },
            { expectedUrl: "https://example.com/two", tabId: 1 },
          ],
        },
      }),
    ).toThrow(/unique tab IDs/i);
    expect(() =>
      bridge.command({
        ...scope,
        command: {
          kind: "reload",
          targets: [{ expectedUrl: "not a URL", tabId: 1 }],
        },
      }),
    ).toThrow(/current exact URL/i);
    expect(() =>
      bridge.command({
        ...scope,
        command: {
          destination: { kind: "app-window" },
          kind: "open-workspace",
          tabs: [],
        },
      }),
    ).toThrow(/at least one tab/i);
    expect(() =>
      bridge.command({
        ...scope,
        command: {
          destination: { kind: "app-window" },
          kind: "open-workspace",
          tabs: [{ muted: false, pinned: false, url: "not a URL" }],
        },
      }),
    ).toThrow(/invalid workspace tab/i);
    expect(target.posted).toEqual([]);
  });

  it("keeps a workspace restore pending beyond the ordinary command timeout", async () => {
    vi.useFakeTimers();
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "workspace-timeout",
      timeouts: { command: 25, workspace: 50 },
    });
    const pending = bridge.command({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        destination: { kind: "app-window" },
        kind: "open-workspace",
        tabs: [
          { muted: false, pinned: false, url: "https://example.com/saved" },
        ],
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const rejection = expect(pending).rejects.toThrow(/outcome is unknown/i);

    await vi.advanceTimersByTimeAsync(25);
    expect(target.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(target.listeners.size).toBe(0);
  });

  it("keeps a large close preview pending beyond the ordinary command timeout", async () => {
    vi.useFakeTimers();
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "close-timeout",
      timeouts: { close: 50, command: 25 },
    });
    const pending = bridge.command({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      command: {
        kind: "close-preview",
        targets: [{ expectedUrl: "https://example.com/exact", tabId: 41 }],
      },
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const rejection = expect(pending).rejects.toThrow(/outcome is unknown/i);

    await vi.advanceTimersByTimeAsync(25);
    expect(target.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(target.listeners.size).toBe(0);
  });

  it("rejects a close preview whose keeper is the target or a different URL", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "invalid-keeper",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };

    expect(() =>
      bridge.command({
        ...scope,
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "https://example.com/exact",
              keeper: {
                expectedUrl: "https://example.com/exact",
                tabId: 42,
              },
              tabId: 42,
            },
          ],
        },
      }),
    ).toThrow(/keeper/i);

    expect(() =>
      bridge.command({
        ...scope,
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "https://example.com/exact",
              keeper: {
                expectedUrl: "https://example.com/different",
                tabId: 43,
              },
              tabId: 42,
            },
          ],
        },
      }),
    ).toThrow(/keeper/i);

    expect(() =>
      bridge.command({
        ...scope,
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "https://example.com/exact",
              keeper: {
                expectedUrl: "https://example.com/exact",
                tabId: 43,
              },
              tabId: 42,
            },
            {
              expectedUrl: "https://example.com/exact",
              tabId: 43,
            },
          ],
        },
      }),
    ).toThrow(/keeper/i);
  });

  it("rejects a valid receipt for a different command kind", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "tab-command-kind-mismatch",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const pending = bridge.command({
      ...scope,
      command: {
        kind: "set-pinned",
        targets: [{ tabId: 42, expectedUrl: "https://example.com/exact" }],
        value: true,
      },
    });

    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "tab-command-kind-mismatch",
      type: "tab-command",
      ok: true,
      data: {
        ...scope,
        result: {
          failed: [],
          kind: "set-muted",
          requested: 1,
          skipped: [],
          succeededTabIds: [42],
        },
      },
    });

    await expect(pending).rejects.toThrow(/different command/i);
  });

  it("returns a retry token only for Undo entries that were not recreated", async () => {
    const target = new FakeBridgeWindow();
    const bridge = createExtensionBridge({
      target,
      origin: "http://127.0.0.1:7717",
      requestId: () => "undo-retry",
    });
    const scope = {
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const undoId = "423e4567-e89b-42d3-a456-426614174000";
    const pending = bridge.command({
      ...scope,
      command: { kind: "undo-close", undoId },
    });

    target.respond({
      source: "tabhub-extension",
      channel: "tabhub-extension-bridge",
      version: 4,
      requestId: "undo-retry",
      type: "tab-command",
      ok: true,
      data: {
        ...scope,
        result: {
          failed: [{ error: "Window unavailable", tabId: 42 }],
          kind: "undo-close",
          requested: 2,
          restoredTabIds: [101],
          retry: { count: 1, expiresAt: 1_800_000_000_000, undoId },
          skipped: [],
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      result: { kind: "undo-close", retry: { count: 1, undoId } },
    });
  });
});
