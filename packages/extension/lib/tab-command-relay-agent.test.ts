import { afterEach, describe, expect, it, vi } from "vitest";

import { tabCommandRelayProtocolVersion } from "@tabhub/shared";

import {
  createTabCommandRelayAgent,
  type TabCommandRelaySessionStorage,
  type TabCommandRelaySocket,
  type TabCommandRelaySocketHandlers,
} from "./tab-command-relay-agent";

const RELAY_URL = "ws://127.0.0.1:7717/api/tab-command-relay/ws";
const SCOPE = {
  browser: "chrome",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
} as const;
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const PREVIEW_ID = "423e4567-e89b-42d3-a456-426614174000";
const EXECUTION_DEADLINE_AT = 2_000_000_000_000;

class FakeSocket implements TabCommandRelaySocket {
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly sent: unknown[] = [];
  private handlers: TabCommandRelaySocketHandlers | undefined;

  close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }

  setHandlers(handlers: TabCommandRelaySocketHandlers): void {
    this.handlers = handlers;
  }

  open(): void {
    this.handlers?.open();
  }

  receive(value: unknown): void {
    this.handlers?.message(JSON.stringify(value));
  }

  receiveRaw(value: unknown): void {
    this.handlers?.message(value);
  }

  serverClose(): void {
    this.handlers?.close();
  }
}

interface StatefulSessionStorage extends TabCommandRelaySessionStorage {
  peek(key: string): unknown;
}

function sessionStorage(
  initial: Record<string, unknown> = {},
): StatefulSessionStorage {
  const values = { ...initial };
  return {
    get: vi.fn(async (key) =>
      Object.hasOwn(values, key) ? { [key]: values[key] } : {},
    ),
    set: vi.fn(async (items) => {
      Object.assign(values, items);
    }),
    peek: (key) => values[key],
  };
}

function previewResult() {
  return {
    candidateTabIds: [41],
    expiresAt: 300_000,
    kind: "close-preview" as const,
    previewId: PREVIEW_ID,
    requested: 1,
    skipped: [],
  };
}

function readyEnvelope() {
  return {
    connectedAt: "2026-08-09T06:00:00.000Z",
    heartbeatIntervalMs: 15_000,
    scope: SCOPE,
    type: "ready",
    version: tabCommandRelayProtocolVersion,
  } as const;
}

function commandEnvelope(requestId = REQUEST_ID) {
  return {
    command: {
      kind: "close-preview",
      targets: [
        {
          expectedUrl: "https://example.com/shared",
          keeper: {
            expectedUrl: "https://example.com/shared",
            tabId: 40,
          },
          tabId: 41,
        },
      ],
    },
    executionDeadlineAt: EXECUTION_DEADLINE_AT,
    requestId,
    scope: SCOPE,
    type: "command",
    version: tabCommandRelayProtocolVersion,
  } as const;
}

function mutationResult() {
  return {
    failed: [],
    kind: "set-muted" as const,
    requested: 1,
    skipped: [],
    succeededTabIds: [41],
  };
}

function mutationCommandEnvelope(requestId = REQUEST_ID) {
  return {
    command: {
      kind: "set-muted" as const,
      targets: [
        {
          expectedUrl: "https://example.com/live",
          tabId: 41,
        },
      ],
      value: true,
    },
    executionDeadlineAt: EXECUTION_DEADLINE_AT,
    requestId,
    scope: SCOPE,
    type: "command",
    version: tabCommandRelayProtocolVersion,
  } as const;
}

function browserStateCommandEnvelope(
  requestId: string,
  executionDeadlineAt = EXECUTION_DEADLINE_AT,
) {
  return {
    command: { kind: "get-browser-state" as const },
    executionDeadlineAt,
    requestId,
    scope: SCOPE,
    type: "command",
    version: tabCommandRelayProtocolVersion,
  } as const;
}

function browserStateResult() {
  return {
    kind: "get-browser-state" as const,
    pendingUndos: [],
    windows: [{ focused: true, tabCount: 3, windowId: 7 }],
  };
}

function activationCommandEnvelope(
  requestId: string,
  executionDeadlineAt = EXECUTION_DEADLINE_AT,
) {
  return {
    command: { kind: "activate-tab" as const, tabId: 41 },
    executionDeadlineAt,
    requestId,
    scope: SCOPE,
    type: "command",
    version: tabCommandRelayProtocolVersion,
  } as const;
}

function activationResult() {
  return {
    kind: "activate-tab" as const,
    tabId: 41,
    windowId: 7,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
}

function createLiveCommandSequencer() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tab command relay agent", () => {
  it("registers its exact scope and answers server heartbeats", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const agent = createTabCommandRelayAgent({
      createSocket: vi.fn(() => socket),
      execute: vi.fn(async () => previewResult()),
      getScope: vi.fn(async () => SCOPE),
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    socket.open();
    expect(socket.sent).toEqual([
      {
        scope: SCOPE,
        type: "register",
        version: tabCommandRelayProtocolVersion,
      },
    ]);

    socket.receive(readyEnvelope());
    socket.receive({
      heartbeatId: "523e4567-e89b-42d3-a456-426614174000",
      sentAt: "2026-08-09T06:00:15.000Z",
      type: "ping",
      version: tabCommandRelayProtocolVersion,
    });
    expect(socket.sent.at(-1)).toEqual({
      heartbeatId: "523e4567-e89b-42d3-a456-426614174000",
      type: "pong",
      version: tabCommandRelayProtocolVersion,
    });

    agent.stop();
  });

  it("executes a strict scoped command and returns a persisted receipt", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const stored = sessionStorage();
    const execute = vi.fn(async () => previewResult());
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      now: () => 1_000,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: stored,
    });

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(commandEnvelope());
    await settle();

    expect(execute).toHaveBeenCalledWith(SCOPE, commandEnvelope().command);
    expect(socket.sent.at(-1)).toEqual({
      ok: true,
      requestId: REQUEST_ID,
      result: previewResult(),
      scope: SCOPE,
      type: "result",
      version: tabCommandRelayProtocolVersion,
    });
    expect(stored.peek("tabhub.tabCommandRelayReceipts")).toEqual([
      {
        envelope: socket.sent.at(-1),
        expiresAt: 601_000,
      },
    ]);

    agent.stop();
  });

  it("executes a non-close command exactly once and replays its receipt", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const execute = vi.fn(async () => mutationResult());
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(mutationCommandEnvelope());
    socket.receive(mutationCommandEnvelope());
    await settle();
    await settle();
    socket.receive(mutationCommandEnvelope());
    await settle();

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      SCOPE,
      mutationCommandEnvelope().command,
    );
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "result",
      ),
    ).toEqual([
      expect.objectContaining({ ok: true, result: mutationResult() }),
      expect.objectContaining({ ok: true, result: mutationResult() }),
      expect.objectContaining({ ok: true, result: mutationResult() }),
    ]);

    agent.stop();
  });

  it("disconnects without touching tabs when a command addresses another session", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const execute = vi.fn(async () => previewResult());
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive({
      ...commandEnvelope(),
      scope: {
        ...SCOPE,
        browserSessionId: "723e4567-e89b-42d3-a456-426614174000",
      },
    });
    await settle();

    expect(execute).not.toHaveBeenCalled();
    expect(socket.closes.at(-1)).toMatchObject({ code: 1008 });
    agent.stop();
  });

  it("rejects a command envelope without an execution deadline", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const execute = vi.fn(async () => previewResult());
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });
    const invalidEnvelope = {
      ...commandEnvelope(),
      executionDeadlineAt: undefined,
    };

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(invalidEnvelope);
    await settle();

    expect(execute).not.toHaveBeenCalled();
    expect(socket.closes.at(-1)).toMatchObject({ code: 1008 });
    agent.stop();
  });

  it("replays a stored receipt without executing a duplicate request", async () => {
    vi.useFakeTimers();
    const storedEnvelope = {
      ok: true,
      requestId: REQUEST_ID,
      result: previewResult(),
      scope: SCOPE,
      type: "result",
      version: tabCommandRelayProtocolVersion,
    } as const;
    const stored = sessionStorage({
      "tabhub.tabCommandRelayReceipts": [
        { envelope: storedEnvelope, expiresAt: 100_000 },
      ],
    });
    const socket = new FakeSocket();
    const execute = vi.fn(async () => previewResult());
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      now: () => 1_000,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: stored,
    });

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(commandEnvelope());
    await settle();

    expect(execute).not.toHaveBeenCalled();
    expect(socket.sent.at(-1)).toEqual(storedEnvelope);
    agent.stop();
  });

  it("serializes different commands and coalesces an in-flight duplicate", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: ReturnType<typeof previewResult>) => void) | undefined;
    const first = new Promise<ReturnType<typeof previewResult>>((resolve) => {
      resolveFirst = resolve;
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockImplementation(async () => previewResult());
    const socket = new FakeSocket();
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });
    const secondRequestId = "623e4567-e89b-42d3-a456-426614174000";

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(commandEnvelope());
    socket.receive(commandEnvelope());
    socket.receive(commandEnvelope(secondRequestId));
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    resolveFirst?.(previewResult());
    await settle();
    await settle();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "result",
      ),
    ).toHaveLength(3);
    agent.stop();
  });

  it("keeps state reads responsive while activation stays behind a live mutation", async () => {
    vi.useFakeTimers();
    let resolveMutation:
      | ((value: ReturnType<typeof mutationResult>) => void)
      | undefined;
    const mutation = new Promise<ReturnType<typeof mutationResult>>(
      (resolve) => {
        resolveMutation = resolve;
      },
    );
    const executionOrder: string[] = [];
    const execute = vi.fn(async (_scope, command) => {
      executionOrder.push(command.kind);
      switch (command.kind) {
        case "set-muted":
          return mutation;
        case "get-browser-state":
          return browserStateResult();
        case "activate-tab":
          return activationResult();
        default:
          return previewResult();
      }
    });
    const socket = new FakeSocket();
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });
    const stateRequestId = "823e4567-e89b-42d3-a456-426614174000";
    const activationRequestId = "923e4567-e89b-42d3-a456-426614174000";

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(mutationCommandEnvelope());
    await settle();
    socket.receive(browserStateCommandEnvelope(stateRequestId));
    socket.receive(browserStateCommandEnvelope(stateRequestId));
    socket.receive(activationCommandEnvelope(activationRequestId));
    await settle();

    expect(executionOrder).toEqual(["set-muted", "get-browser-state"]);
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "requestId" in message &&
          message.requestId === stateRequestId,
      ),
    ).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);

    resolveMutation?.(mutationResult());
    await settle();
    await settle();
    expect(executionOrder).toEqual([
      "set-muted",
      "get-browser-state",
      "activate-tab",
    ]);
    agent.stop();
  });

  it("caches an expired queued activation receipt without executing it", async () => {
    vi.useFakeTimers();
    let currentTime = 1_000;
    let resolveMutation:
      | ((value: ReturnType<typeof mutationResult>) => void)
      | undefined;
    const mutation = new Promise<ReturnType<typeof mutationResult>>(
      (resolve) => {
        resolveMutation = resolve;
      },
    );
    const execute = vi.fn(async (_scope, command) =>
      command.kind === "set-muted" ? mutation : activationResult(),
    );
    const socket = new FakeSocket();
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute,
      getScope: async () => SCOPE,
      now: () => currentTime,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });
    const activationRequestId = "a23e4567-e89b-42d3-a456-426614174000";
    const activationEnvelope = activationCommandEnvelope(
      activationRequestId,
      1_500,
    );

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    socket.receive(mutationCommandEnvelope());
    await settle();
    socket.receive(activationEnvelope);
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);

    currentTime = 1_500;
    resolveMutation?.(mutationResult());
    await settle();
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "requestId" in message &&
          message.requestId === activationRequestId,
      ),
    ).toEqual([
      expect.objectContaining({
        error: "The browser command expired before execution.",
        ok: false,
      }),
    ]);

    socket.receive(activationEnvelope);
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "requestId" in message &&
          message.requestId === activationRequestId,
      ),
    ).toHaveLength(2);
    agent.stop();
  });

  it("never sends a completed command receipt through a replacement socket", async () => {
    vi.useFakeTimers();
    let resolveExecution:
      | ((value: ReturnType<typeof previewResult>) => void)
      | undefined;
    const execution = new Promise<ReturnType<typeof previewResult>>((resolve) => {
      resolveExecution = resolve;
    });
    const sockets: FakeSocket[] = [];
    const agent = createTabCommandRelayAgent({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      execute: vi.fn(async () => execution),
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.receive(readyEnvelope());
    sockets[0]!.receive(commandEnvelope());
    await settle();
    sockets[0]!.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    sockets[1]!.open();
    sockets[1]!.receive(readyEnvelope());

    resolveExecution?.(previewResult());
    await settle();
    await settle();
    expect(
      sockets[1]!.sent.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "result",
      ),
    ).toBe(false);
    agent.stop();
  });

  it("fails closed on invalid frames and reconnects with backoff", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const agent = createTabCommandRelayAgent({
      createSocket,
      execute: vi.fn(async () => previewResult()),
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.receiveRaw("not-json");
    expect(sockets[0]!.closes.at(-1)).toMatchObject({ code: 1008 });

    await vi.advanceTimersByTimeAsync(499);
    expect(createSocket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(createSocket).toHaveBeenCalledTimes(2);
    agent.stop();
  });

  it("drops a relay that stops sending heartbeats", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const agent = createTabCommandRelayAgent({
      createSocket: () => socket,
      execute: vi.fn(async () => previewResult()),
      getScope: async () => SCOPE,
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    socket.open();
    socket.receive(readyEnvelope());
    await vi.advanceTimersByTimeAsync(44_999);
    expect(socket.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closes.at(-1)).toMatchObject({ code: 1001 });
    agent.stop();
  });

  it("stays dormant before browser identity is configured, then restarts", async () => {
    vi.useFakeTimers();
    let configured = false;
    const sockets: FakeSocket[] = [];
    const agent = createTabCommandRelayAgent({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      execute: vi.fn(async () => previewResult()),
      getScope: async () => (configured ? SCOPE : undefined),
      relayUrl: RELAY_URL,
      sequenceLiveCommand: createLiveCommandSequencer(),
      storage: sessionStorage(),
    });

    agent.start();
    await settle();
    expect(sockets).toHaveLength(0);

    configured = true;
    agent.restart();
    await settle();
    expect(sockets).toHaveLength(1);
    agent.stop();
  });
});
