import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tabCommandRelayProtocolVersion,
  type TabCommandRelayHttpRequest,
  type TabCommandRelayResult,
} from "@tabhub/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createApp, type TabHubApp } from "../src/app.js";
import { createTabCommandRelay } from "../src/tab-command-relay.js";

const scope = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const commandHeaders = {
  origin: "http://127.0.0.1:7717",
  "sec-fetch-site": "same-origin",
} as const;

describe("tab command relay", () => {
  let app: TabHubApp;
  let directory: string;
  let sockets: WebSocket[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tabhub-command-relay-"));
    app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      tabCommandRelayCommandTimeoutMs: 75,
    });
    await app.ready();
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(directory, { force: true, recursive: true });
  });

  it("reports a command as not sent when the exact extension scope is offline", async () => {
    const response = await app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "SCOPE_OFFLINE",
      message: "That browser extension session is not connected.",
      ok: false,
      outcome: "not-sent",
    });
  });

  it("routes a command to the exact connected scope and returns its correlated result", async () => {
    const socket = await app.injectWS("/api/tab-command-relay/ws", {
      headers: {
        host: "127.0.0.1:7717",
        origin: "chrome-extension://tabhubtest",
      },
    });
    sockets.push(socket);

    const readyMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({
        scope,
        type: "register",
        version: tabCommandRelayProtocolVersion,
      }),
    );
    await expect(readyMessage).resolves.toMatchObject({
      scope,
      type: "ready",
      version: tabCommandRelayProtocolVersion,
    });

    const scopes = await app.inject({
      method: "GET",
      url: "/api/tab-command-relay/scopes",
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json()).toEqual({
      items: [
        {
          ...scope,
          connectedAt: expect.any(String),
          lastSeenAt: expect.any(String),
        },
      ],
    });

    const command = {
      kind: "close-preview" as const,
      targets: [
        {
          expectedUrl: "https://example.com/duplicate",
          keeper: {
            expectedUrl: "https://example.com/duplicate",
            tabId: 42,
          },
          tabId: 43,
        },
      ],
    };
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: { ...scope, command },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    expect(envelope).toMatchObject({
      command,
      requestId: expect.any(String),
      scope,
      type: "command",
      version: tabCommandRelayProtocolVersion,
    });

    const result = {
      candidateTabIds: [43],
      expiresAt: Date.now() + 30_000,
      kind: "close-preview" as const,
      previewId: "423e4567-e89b-42d3-a456-426614174000",
      requested: 1,
      skipped: [],
    };
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      requestId: (envelope as { requestId: string }).requestId,
      result,
      scope,
    });
  });

  it("routes a physical tab mutation to a different connected browser", async () => {
    const socket = await registeredSocket(app, sockets);
    const command = {
      kind: "set-pinned" as const,
      targets: [
        {
          expectedUrl: "https://example.com/remote-tab",
          tabId: 41,
        },
      ],
      value: true,
    };
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: { ...scope, command },
      url: "/api/tab-command-relay/commands",
    });

    const envelope = await commandMessage;
    expect(envelope).toMatchObject({
      command,
      requestId: expect.any(String),
      scope,
      type: "command",
      version: tabCommandRelayProtocolVersion,
    });
    const result = {
      failed: [],
      kind: "set-pinned" as const,
      requested: 1,
      skipped: [],
      succeededTabIds: [41],
    };
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      requestId: (envelope as { requestId: string }).requestId,
      result,
      scope,
    });
  });

  it("routes activation to the browser session that owns the tab", async () => {
    const socket = await registeredSocket(app, sockets);
    const command = { kind: "activate-tab" as const, tabId: 41 };
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: { ...scope, command },
      url: "/api/tab-command-relay/commands",
    });

    const envelope = await commandMessage;
    expect(envelope).toMatchObject({ command, scope, type: "command" });
    const result = {
      kind: "activate-tab" as const,
      tabId: 41,
      windowId: 7,
    };
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, result, scope });
  });

  it("rejects an activation receipt for a different tab", async () => {
    const socket = await registeredSocket(app, sockets);
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: { kind: "activate-tab", tabId: 41 },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result: {
          kind: "activate-tab",
          tabId: 42,
          windowId: 7,
        },
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "INVALID_COMMAND_RECEIPT",
      ok: false,
      outcome: "unknown",
    });
  });

  it("rejects mutation and workspace receipts that do not match their command", async () => {
    const target = {
      expectedUrl: "https://example.com/remote-tab",
      tabId: 41,
    };
    const cases: Array<{
      command: TabCommandRelayHttpRequest["command"];
      result: TabCommandRelayResult;
    }> = [
      {
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "https://example.com/remote-tab",
              tabId: 41,
            },
          ],
        },
        result: {
          candidateTabIds: [42],
          expiresAt: Date.now() + 30_000,
          kind: "close-preview",
          previewId: "823e4567-e89b-42d3-a456-426614174000",
          requested: 1,
          skipped: [],
        },
      },
      {
        command: { kind: "set-pinned", targets: [target], value: true },
        result: {
          failed: [],
          kind: "set-pinned",
          requested: 2,
          skipped: [],
          succeededTabIds: [41],
        },
      },
      {
        command: { kind: "reload", targets: [target] },
        result: {
          failed: [{ error: "failed after success", tabId: 41 }],
          kind: "reload",
          requested: 1,
          skipped: [],
          succeededTabIds: [41],
        },
      },
      {
        command: {
          destination: { kind: "window", windowId: 8 },
          kind: "move",
          targets: [target],
        },
        result: {
          destinationWindowId: 8,
          failed: [],
          kind: "move",
          requested: 1,
          skipped: [],
          succeededTabIds: [42],
        },
      },
      {
        command: {
          destination: { kind: "new-window" },
          kind: "open-workspace",
          tabs: [
            {
              muted: false,
              pinned: false,
              url: "https://example.com/workspace",
            },
          ],
        },
        result: {
          failed: [{ error: "wrong index", index: 1 }],
          kind: "open-workspace",
          openedTabIds: [],
          requested: 1,
        },
      },
      {
        command: {
          destination: { kind: "new-window" },
          kind: "open-workspace",
          tabs: [
            {
              muted: false,
              pinned: false,
              url: "https://example.com/workspace",
            },
          ],
        },
        result: {
          destinationWindowId: 9,
          failed: [],
          kind: "open-workspace",
          openedTabIds: [51],
          requested: 2,
        },
      },
    ];

    for (const { command, result } of cases) {
      await expectInvalidSuccessfulReceipt(app, sockets, command, result);
    }
  });

  it("returns an outcome-unknown timeout without retrying the command", async () => {
    const socket = await registeredSocket(app, sockets);
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;

    const response = await responsePromise;
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      error: "COMMAND_TIMEOUT",
      message: "The browser command timed out. Its outcome is unknown.",
      ok: false,
      outcome: "unknown",
      requestId: (envelope as { requestId: string }).requestId,
    });

    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result: {
          failed: [],
          kind: "undo-close",
          requested: 1,
          restoredTabIds: [44],
          skipped: [],
        },
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const scopes = await app.inject({
      method: "GET",
      url: "/api/tab-command-relay/scopes",
    });
    expect(scopes.json().items).toHaveLength(1);
  });

  it("rejects a correlated receipt for the wrong command kind", async () => {
    const socket = await registeredSocket(app, sockets);
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    const closed = socketClosed(socket);
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result: {
          candidateTabIds: [],
          expiresAt: Date.now() + 30_000,
          kind: "close-preview",
          previewId: "423e4567-e89b-42d3-a456-426614174000",
          requested: 0,
          skipped: [],
        },
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "INVALID_COMMAND_RECEIPT",
      message:
        "The browser extension returned a receipt for a different scope or command.",
      ok: false,
      outcome: "unknown",
      requestId: (envelope as { requestId: string }).requestId,
    });
    await closed;
    const scopes = await app.inject({
      method: "GET",
      url: "/api/tab-command-relay/scopes",
    });
    expect(scopes.json()).toEqual({ items: [] });
  });

  it("cleans up presence and pending commands when an extension disconnects", async () => {
    const socket = await registeredSocket(app, sockets);
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    const closed = socketClosed(socket);
    socket.terminate();
    await closed;

    const response = await responsePromise;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "EXTENSION_DISCONNECTED",
      message:
        "The browser extension disconnected before returning a receipt.",
      ok: false,
      outcome: "unknown",
      requestId: (envelope as { requestId: string }).requestId,
    });
    const scopes = await app.inject({
      method: "GET",
      url: "/api/tab-command-relay/scopes",
    });
    expect(scopes.json()).toEqual({ items: [] });
  });

  it("lets the newest socket replace an older connection for the same exact scope", async () => {
    const first = await registeredSocket(app, sockets);
    const firstClosed = socketClosed(first);
    const second = await registeredSocket(app, sockets);
    await firstClosed;
    expect(first.readyState).toBe(3);

    const scopes = await app.inject({
      method: "GET",
      url: "/api/tab-command-relay/scopes",
    });
    expect(scopes.json().items).toHaveLength(1);

    const commandMessage = nextMessage(second);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    const result = {
      failed: [],
      kind: "undo-close" as const,
      requested: 1,
      restoredTabIds: [44],
      skipped: [],
    };
    second.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, result, scope });
  });

  it("rejects a correlated receipt that claims a different browser session", async () => {
    const socket = await registeredSocket(app, sockets);
    const commandMessage = nextMessage(socket);
    const responsePromise = app.inject({
      headers: commandHeaders,
      method: "POST",
      payload: {
        ...scope,
        command: {
          kind: "undo-close",
          undoId: "323e4567-e89b-42d3-a456-426614174000",
        },
      },
      url: "/api/tab-command-relay/commands",
    });
    const envelope = await commandMessage;
    socket.send(
      JSON.stringify({
        ok: true,
        requestId: (envelope as { requestId: string }).requestId,
        result: {
          failed: [],
          kind: "undo-close",
          requested: 1,
          restoredTabIds: [44],
          skipped: [],
        },
        scope: {
          ...scope,
          browserSessionId: "523e4567-e89b-42d3-a456-426614174000",
        },
        type: "result",
        version: tabCommandRelayProtocolVersion,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: "INVALID_COMMAND_RECEIPT",
      ok: false,
      outcome: "unknown",
    });
  });

  it("round-trips representative expanded commands and rejects non-strict variants", async () => {
    const socket = await registeredSocket(app, sockets);
    const cases = [
      {
        command: { kind: "get-browser-state" },
        result: {
          kind: "get-browser-state",
          pendingUndos: [],
          windows: [{ focused: true, tabCount: 3, windowId: 7 }],
        },
      },
      {
        command: {
          bypassCache: true,
          kind: "reload",
          targets: [
            {
              expectedUrl: "https://example.com/reload",
              tabId: 41,
            },
          ],
        },
        result: {
          failed: [],
          kind: "reload",
          requested: 1,
          skipped: [],
          succeededTabIds: [41],
        },
      },
      {
        command: {
          destination: { kind: "window", windowId: 8 },
          kind: "move",
          targets: [
            {
              expectedUrl: "https://example.com/move",
              tabId: 42,
            },
          ],
        },
        result: {
          destinationWindowId: 8,
          failed: [],
          kind: "move",
          requested: 1,
          skipped: [],
          succeededTabIds: [42],
        },
      },
      {
        command: {
          destination: { kind: "new-window" },
          kind: "open-workspace",
          tabs: [
            {
              muted: false,
              pinned: true,
              url: "https://example.com/workspace",
            },
          ],
        },
        result: {
          destinationWindowId: 9,
          failed: [],
          kind: "open-workspace",
          openedTabIds: [43],
          requested: 1,
        },
      },
    ] as const;

    for (const { command, result } of cases) {
      const commandMessage = nextMessage(socket);
      const responsePromise = app.inject({
        headers: commandHeaders,
        method: "POST",
        payload: { ...scope, command },
        url: "/api/tab-command-relay/commands",
      });
      const envelope = await commandMessage;
      expect(envelope).toMatchObject({
        command,
        scope,
        type: "command",
        version: tabCommandRelayProtocolVersion,
      });
      socket.send(
        JSON.stringify({
          ok: true,
          requestId: (envelope as { requestId: string }).requestId,
          result,
          scope,
          type: "result",
          version: tabCommandRelayProtocolVersion,
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, result, scope });
    }

    for (const command of [
      { extra: true, kind: "get-browser-state" },
      { kind: "reload", targets: [] },
      {
        kind: "set-muted",
        targets: [
          { expectedUrl: "https://example.com/one", tabId: 44 },
          { expectedUrl: "https://example.com/two", tabId: 44 },
        ],
        value: true,
      },
      {
        destination: { kind: "new-window" },
        kind: "open-workspace",
        tabs: [],
      },
      {
        destination: { kind: "app-window" },
        kind: "move",
        targets: [
          { expectedUrl: "https://example.com/move", tabId: 45 },
        ],
      },
      {
        destination: { kind: "app-window" },
        kind: "open-workspace",
        tabs: [
          {
            muted: false,
            pinned: false,
            url: "https://example.com/workspace",
          },
        ],
      },
    ]) {
      const response = await app.inject({
        headers: commandHeaders,
        method: "POST",
        payload: { ...scope, command },
        url: "/api/tab-command-relay/commands",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    }
  });

  it("rejects an empty or internally ambiguous close preview before routing", async () => {
    for (const targets of [
      [],
      [
        {
          expectedUrl: "https://example.com/duplicate",
          tabId: 43,
        },
        {
          expectedUrl: "https://example.com/duplicate",
          tabId: 43,
        },
      ],
      [
        {
          expectedUrl: "https://example.com/duplicate",
          keeper: {
            expectedUrl: "https://example.com/different",
            tabId: 42,
          },
          tabId: 43,
        },
      ],
    ]) {
      const response = await app.inject({
        headers: commandHeaders,
        method: "POST",
        payload: {
          ...scope,
          command: { kind: "close-preview", targets },
        },
        url: "/api/tab-command-relay/commands",
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it.each([
    {
      expectedError: "TABHUB_APP_ORIGIN_REQUIRED",
      headers: {},
      label: "a missing Origin",
    },
    {
      expectedError: "TABHUB_APP_ORIGIN_REQUIRED",
      headers: {
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
      },
      label: "another localhost port",
    },
    {
      expectedError: "CROSS_SITE_REQUEST_BLOCKED",
      headers: {
        origin: "http://127.0.0.1:7717",
        "sec-fetch-site": "cross-site",
      },
      label: "cross-site fetch metadata",
    },
  ])(
    "rejects destructive commands from $label",
    async ({ expectedError, headers }) => {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {
          ...scope,
          command: {
            kind: "undo-close",
            undoId: "323e4567-e89b-42d3-a456-426614174000",
          },
        },
        url: "/api/tab-command-relay/commands",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: expectedError });
    },
  );

  it("allows only extension-origin WebSockets onto the executor channel", async () => {
    await expect(
      app.injectWS("/api/tab-command-relay/ws", {
        headers: {
          host: "127.0.0.1:7717",
          origin: "http://127.0.0.1:7717",
        },
      }),
    ).rejects.toThrow(/403/);
  });
});

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function registeredSocket(
  app: TabHubApp,
  sockets: WebSocket[],
): Promise<WebSocket> {
  const socket = await app.injectWS("/api/tab-command-relay/ws", {
    headers: {
      host: "127.0.0.1:7717",
      origin: "chrome-extension://tabhubtest",
    },
  });
  sockets.push(socket);
  const ready = nextMessage(socket);
  socket.send(
    JSON.stringify({
      scope,
      type: "register",
      version: tabCommandRelayProtocolVersion,
    }),
  );
  await ready;
  return socket;
}

async function expectInvalidSuccessfulReceipt(
  app: TabHubApp,
  sockets: WebSocket[],
  command: TabCommandRelayHttpRequest["command"],
  result: TabCommandRelayResult,
): Promise<void> {
  const socket = await registeredSocket(app, sockets);
  const commandMessage = nextMessage(socket);
  const responsePromise = app.inject({
    headers: commandHeaders,
    method: "POST",
    payload: { ...scope, command },
    url: "/api/tab-command-relay/commands",
  });
  const envelope = await commandMessage;
  socket.send(
    JSON.stringify({
      ok: true,
      requestId: (envelope as { requestId: string }).requestId,
      result,
      scope,
      type: "result",
      version: tabCommandRelayProtocolVersion,
    }),
  );

  const response = await responsePromise;
  expect(response.statusCode).toBe(502);
  expect(response.json()).toMatchObject({
    error: "INVALID_COMMAND_RECEIPT",
    ok: false,
    outcome: "unknown",
  });
}

function socketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

class FakeRelaySocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: unknown) => void> = [];

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  on(event: "close", listener: () => void): this;
  on(event: "error", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(
    event: "close" | "error" | "message",
    listener: (() => void) | ((data: unknown) => void),
  ): this {
    if (event === "close") {
      this.closeListeners.push(listener as () => void);
    } else if (event === "error") {
      this.errorListeners.push(listener as () => void);
    } else {
      this.messageListeners.push(listener as (data: unknown) => void);
    }
    return this;
  }

  receive(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const listener of this.messageListeners) listener(serialized);
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const defaultTimeoutCases: Array<{
  command: TabCommandRelayHttpRequest["command"];
  label: string;
  timeoutMs: number;
}> = [
  {
    command: { kind: "activate-tab", tabId: 41 },
    label: "activation",
    timeoutMs: 5_000,
  },
  {
    command: { kind: "get-browser-state" },
    label: "browser-state reads",
    timeoutMs: 5_000,
  },
  {
    command: {
      kind: "reload",
      targets: [
        { expectedUrl: "https://example.com/timeout", tabId: 41 },
      ],
    },
    label: "ordinary mutations",
    timeoutMs: 2 * 60_000,
  },
  {
    command: {
      kind: "close-preview",
      targets: [
        { expectedUrl: "https://example.com/close-timeout", tabId: 41 },
      ],
    },
    label: "duplicate close previews",
    timeoutMs: 10 * 60_000,
  },
  {
    command: {
      destination: { kind: "new-window" },
      kind: "open-workspace",
      tabs: [
        {
          muted: false,
          pinned: false,
          url: "https://example.com/workspace-timeout",
        },
      ],
    },
    label: "workspace restores",
    timeoutMs: 10 * 60_000,
  },
];

describe("tab command relay timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(defaultTimeoutCases)(
    "uses the per-kind default for $label",
    async ({ command, timeoutMs }) => {
      await expectCommandTimeout(command, timeoutMs);
    },
  );

  it.each(defaultTimeoutCases)(
    "lets commandTimeoutMs override the $label default",
    async ({ command }) => {
      await expectCommandTimeout(command, 25, 25);
    },
  );
});

async function expectCommandTimeout(
  command: TabCommandRelayHttpRequest["command"],
  expectedTimeoutMs: number,
  commandTimeoutMs?: number,
): Promise<void> {
  const relay = createTabCommandRelay({
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    heartbeatIntervalMs: 20 * 60_000,
    heartbeatTimeoutMs: 30 * 60_000,
  });
  const socket = new FakeRelaySocket();
  relay.attach(socket);
  socket.receive({
    scope,
    type: "register",
    version: tabCommandRelayProtocolVersion,
  });

  try {
    let settled = false;
    const dispatchedAt = Date.now();
    const pending = relay.dispatch({ ...scope, command });
    const commandEnvelope = JSON.parse(socket.sent.at(-1)!) as {
      executionDeadlineAt?: number;
      type?: string;
    };
    expect(commandEnvelope).toMatchObject({
      executionDeadlineAt: dispatchedAt + expectedTimeoutMs,
      type: "command",
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      error: "COMMAND_TIMEOUT",
      ok: false,
      outcome: "unknown",
    });
  } finally {
    relay.close();
  }
}
