import { randomUUID } from "node:crypto";

import {
  tabCommandRelayClientEnvelopeSchema,
  tabCommandRelayConnectedScopesResponseSchema,
  tabCommandRelayHttpRequestSchema,
  tabCommandRelayHttpResponseSchema,
  tabCommandRelayProtocolVersion,
  type TabCommandRelayClientEnvelope,
  type TabCommandRelayConnectedScopesResponse,
  type TabCommandRelayHttpRequest,
  type TabCommandRelayHttpResponse,
  type TabCommandScope,
} from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import { isExtensionOrigin } from "./request-security.js";

const DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_MUTATION_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 5_000;
const DEFAULT_APP_ORIGINS = [
  "http://127.0.0.1:7717",
  "http://localhost:7717",
] as const;
const SOCKET_OPEN = 1;

interface RelaySocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  send(data: string): void;
}

interface RelayConnection {
  closed: boolean;
  connectedAt: Date;
  lastHeartbeatId?: string;
  lastSeenAt: Date;
  registrationTimer: ReturnType<typeof setTimeout>;
  scope?: TabCommandScope;
  scopeKey?: string;
  socket: RelaySocket;
}

interface PendingCommand {
  command: TabCommandRelayHttpRequest["command"];
  connection: RelayConnection;
  requestId: string;
  resolve: (response: TabCommandRelayHttpResponse) => void;
  scope: TabCommandScope;
  timer: ReturnType<typeof setTimeout>;
}

export interface TabCommandRelayOptions {
  clock?: () => Date;
  commandTimeoutMs?: number;
  createId?: () => string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  registrationTimeoutMs?: number;
}

export interface TabCommandRelay {
  attach(socket: RelaySocket): void;
  close(): void;
  dispatch(command: TabCommandRelayHttpRequest): Promise<TabCommandRelayHttpResponse>;
  listConnectedScopes(): TabCommandRelayConnectedScopesResponse;
}

export interface TabCommandRelayRouteOptions {
  appOrigins?: readonly string[];
}

function defaultCommandTimeoutMs(
  command: TabCommandRelayHttpRequest["command"],
): number {
  const kind: string = command.kind;
  if (kind === "activate-tab" || kind === "get-browser-state") {
    return DEFAULT_INTERACTIVE_COMMAND_TIMEOUT_MS;
  }
  return kind === "open-workspace"
    ? DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS
    : DEFAULT_MUTATION_COMMAND_TIMEOUT_MS;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function commandScope(command: TabCommandRelayHttpRequest): TabCommandScope {
  return {
    browser: command.browser,
    browserSessionId: command.browserSessionId,
    installationId: command.installationId,
  };
}

function scopeKey(scope: TabCommandScope): string {
  return [scope.browser, scope.installationId, scope.browserSessionId].join("\0");
}

function sameScope(left: TabCommandScope, right: TabCommandScope): boolean {
  return (
    left.browser === right.browser &&
    left.installationId === right.installationId &&
    left.browserSessionId === right.browserSessionId
  );
}

type SuccessfulRelayResult = Extract<
  TabCommandRelayClientEnvelope,
  { ok: true; type: "result" }
>["result"];

function hasExactTargetPartition(
  targets: readonly { tabId: number }[],
  result: {
    failed: readonly { tabId: number }[];
    requested: number;
    skipped: readonly { tabId: number }[];
    succeededTabIds: readonly number[];
  },
): boolean {
  if (result.requested !== targets.length) return false;
  const expectedIds = new Set(targets.map(({ tabId }) => tabId));
  const actualIds = [
    ...result.succeededTabIds,
    ...result.skipped.map(({ tabId }) => tabId),
    ...result.failed.map(({ tabId }) => tabId),
  ];
  return (
    actualIds.length === targets.length &&
    new Set(actualIds).size === actualIds.length &&
    actualIds.every((tabId) => expectedIds.has(tabId))
  );
}

function isCorrelatedSuccessfulResult(
  command: TabCommandRelayHttpRequest["command"],
  result: SuccessfulRelayResult,
): boolean {
  switch (command.kind) {
    case "get-browser-state":
      return result.kind === "get-browser-state";
    case "activate-tab":
      return result.kind === "activate-tab" && result.tabId === command.tabId;
    case "close-preview":
      return (
        result.kind === "close-preview" &&
        result.requested === command.targets.length &&
        hasExactTargetPartition(command.targets, {
          failed: [],
          requested: result.requested,
          skipped: result.skipped,
          succeededTabIds: result.candidateTabIds,
        })
      );
    case "close":
      return result.kind === "close";
    case "undo-close":
      return result.kind === "undo-close";
    case "set-pinned":
      return (
        result.kind === "set-pinned" &&
        hasExactTargetPartition(command.targets, result)
      );
    case "set-muted":
      return (
        result.kind === "set-muted" &&
        hasExactTargetPartition(command.targets, result)
      );
    case "discard":
      return (
        result.kind === "discard" &&
        hasExactTargetPartition(command.targets, result)
      );
    case "reload":
      return (
        result.kind === "reload" &&
        hasExactTargetPartition(command.targets, result)
      );
    case "move":
      return (
        result.kind === "move" &&
        hasExactTargetPartition(command.targets, result) &&
        (command.destination.kind !== "window" ||
          result.destinationWindowId === undefined ||
          result.destinationWindowId === command.destination.windowId)
      );
    case "open-workspace": {
      if (result.kind !== "open-workspace") return false;
      const failedIndices = result.failed.map(({ index }) => index);
      return (
        result.requested === command.tabs.length &&
        result.openedTabIds.length <= command.tabs.length &&
        new Set(result.openedTabIds).size === result.openedTabIds.length &&
        new Set(failedIndices).size === failedIndices.length &&
        failedIndices.every((index) => index < command.tabs.length) &&
        result.openedTabIds.length + failedIndices.length >=
          command.tabs.length
      );
    }
  }
}

function serializedMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return undefined;
}

function relayFailure(
  error: Exclude<TabCommandRelayHttpResponse, { ok: true }>["error"],
  message: string,
  outcome: "not-sent" | "unknown",
  requestId?: string,
): TabCommandRelayHttpResponse {
  return tabCommandRelayHttpResponseSchema.parse({
    error,
    message,
    ok: false,
    outcome,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function createTabCommandRelay(
  options: TabCommandRelayOptions = {},
): TabCommandRelay {
  const clock = options.clock ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const commandTimeoutMs =
    options.commandTimeoutMs === undefined
      ? undefined
      : positiveInteger("commandTimeoutMs", options.commandTimeoutMs);
  const heartbeatIntervalMs = positiveInteger(
    "heartbeatIntervalMs",
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimeoutMs = positiveInteger(
    "heartbeatTimeoutMs",
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
  );
  const registrationTimeoutMs = positiveInteger(
    "registrationTimeoutMs",
    options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
  );
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error("heartbeatTimeoutMs must exceed heartbeatIntervalMs");
  }

  const connections = new Map<string, RelayConnection>();
  const pendingCommands = new Map<string, PendingCommand>();
  const sockets = new Set<RelayConnection>();
  let relayClosed = false;

  const finishPending = (
    pending: PendingCommand,
    response: TabCommandRelayHttpResponse,
  ) => {
    if (pendingCommands.get(pending.requestId) !== pending) return;
    pendingCommands.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  };

  const disconnect = (
    connection: RelayConnection,
    closeSocket: boolean,
    code = 1000,
    reason = "connection closed",
  ) => {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.registrationTimer);
    sockets.delete(connection);
    if (
      connection.scopeKey !== undefined &&
      connections.get(connection.scopeKey) === connection
    ) {
      connections.delete(connection.scopeKey);
    }
    for (const pending of pendingCommands.values()) {
      if (pending.connection === connection) {
        finishPending(
          pending,
          relayFailure(
            "EXTENSION_DISCONNECTED",
            "The browser extension disconnected before returning a receipt.",
            "unknown",
            pending.requestId,
          ),
        );
      }
    }
    if (closeSocket) {
      try {
        connection.socket.close(code, reason.slice(0, 120));
      } catch {
        // The close event performs the same cleanup when the socket is alive.
      }
    }
  };

  const protocolViolation = (
    connection: RelayConnection,
    pending?: PendingCommand,
  ) => {
    if (pending !== undefined) {
      finishPending(
        pending,
        relayFailure(
          "INVALID_COMMAND_RECEIPT",
          "The browser extension returned a receipt for a different scope or command.",
          "unknown",
          pending.requestId,
        ),
      );
    }
    disconnect(connection, true, 4002, "invalid relay message");
  };

  const send = (connection: RelayConnection, message: unknown): boolean => {
    if (connection.closed || connection.socket.readyState !== SOCKET_OPEN) {
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const handleRegister = (
    connection: RelayConnection,
    envelope: Extract<TabCommandRelayClientEnvelope, { type: "register" }>,
  ) => {
    if (connection.scope !== undefined) {
      protocolViolation(connection);
      return;
    }

    const key = scopeKey(envelope.scope);
    const previous = connections.get(key);
    if (previous !== undefined && previous !== connection) {
      disconnect(previous, true, 4001, "replaced by newer connection");
    }

    const connectedAt = clock();
    connection.connectedAt = connectedAt;
    connection.lastSeenAt = connectedAt;
    connection.scope = envelope.scope;
    connection.scopeKey = key;
    clearTimeout(connection.registrationTimer);
    connections.set(key, connection);
    if (
      !send(connection, {
        connectedAt: connectedAt.toISOString(),
        heartbeatIntervalMs,
        scope: envelope.scope,
        type: "ready",
        version: tabCommandRelayProtocolVersion,
      })
    ) {
      disconnect(connection, true, 1011, "could not acknowledge registration");
    }
  };

  const handlePong = (
    connection: RelayConnection,
    envelope: Extract<TabCommandRelayClientEnvelope, { type: "pong" }>,
  ) => {
    if (
      connection.scope === undefined ||
      connection.scopeKey === undefined ||
      connections.get(connection.scopeKey) !== connection ||
      connection.lastHeartbeatId !== envelope.heartbeatId
    ) {
      protocolViolation(connection);
      return;
    }
    delete connection.lastHeartbeatId;
    connection.lastSeenAt = clock();
  };

  const handleResult = (
    connection: RelayConnection,
    envelope: Extract<TabCommandRelayClientEnvelope, { type: "result" }>,
  ) => {
    const pending = pendingCommands.get(envelope.requestId);
    if (pending === undefined) {
      // A timed-out command may still complete. Its late receipt is deliberately
      // ignored because the server never retries an outcome-unknown mutation.
      return;
    }
    if (
      connection.scope === undefined ||
      connection.scopeKey === undefined ||
      connections.get(connection.scopeKey) !== connection ||
      pending.connection !== connection
    ) {
      protocolViolation(connection);
      return;
    }
    if (
      !sameScope(connection.scope, envelope.scope) ||
      !sameScope(pending.scope, envelope.scope) ||
      (envelope.ok &&
        !isCorrelatedSuccessfulResult(pending.command, envelope.result))
    ) {
      protocolViolation(connection, pending);
      return;
    }

    connection.lastSeenAt = clock();
    if (!envelope.ok) {
      finishPending(
        pending,
        relayFailure(
          "EXTENSION_COMMAND_FAILED",
          envelope.error,
          "unknown",
          pending.requestId,
        ),
      );
      return;
    }

    finishPending(
      pending,
      tabCommandRelayHttpResponseSchema.parse({
        ok: true,
        requestId: pending.requestId,
        result: envelope.result,
        scope: pending.scope,
      }),
    );
  };

  const handleMessage = (connection: RelayConnection, data: unknown) => {
    if (connection.closed) return;
    const text = serializedMessage(data);
    if (text === undefined) {
      protocolViolation(connection);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      protocolViolation(connection);
      return;
    }
    const parsed = tabCommandRelayClientEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      protocolViolation(connection);
      return;
    }

    switch (parsed.data.type) {
      case "register":
        handleRegister(connection, parsed.data);
        break;
      case "pong":
        handlePong(connection, parsed.data);
        break;
      case "result":
        handleResult(connection, parsed.data);
        break;
    }
  };

  const heartbeatTimer = setInterval(() => {
    const now = clock();
    for (const connection of connections.values()) {
      if (now.getTime() - connection.lastSeenAt.getTime() > heartbeatTimeoutMs) {
        disconnect(connection, true, 4000, "heartbeat timeout");
        continue;
      }
      if (connection.lastHeartbeatId !== undefined) continue;
      const heartbeatId = createId();
      connection.lastHeartbeatId = heartbeatId;
      if (
        !send(connection, {
          heartbeatId,
          sentAt: now.toISOString(),
          type: "ping",
          version: tabCommandRelayProtocolVersion,
        })
      ) {
        disconnect(connection, true, 1011, "heartbeat send failed");
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    attach(socket) {
      if (relayClosed) {
        socket.close(1012, "relay is shutting down");
        return;
      }
      const connectedAt = clock();
      const connection: RelayConnection = {
        closed: false,
        connectedAt,
        lastSeenAt: connectedAt,
        registrationTimer: setTimeout(() => {
          disconnect(connection, true, 4003, "registration timeout");
        }, registrationTimeoutMs),
        socket,
      };
      connection.registrationTimer.unref?.();
      sockets.add(connection);
      socket.on("message", (data) => handleMessage(connection, data));
      socket.on("close", () => disconnect(connection, false));
      socket.on("error", () => disconnect(connection, false));
    },

    close() {
      if (relayClosed) return;
      relayClosed = true;
      clearInterval(heartbeatTimer);
      for (const connection of [...sockets]) {
        disconnect(connection, true, 1001, "relay is shutting down");
      }
    },

    dispatch(command) {
      const scope = commandScope(command);
      const key = scopeKey(scope);
      const connection = connections.get(key);
      if (
        connection === undefined ||
        connection.closed ||
        connection.socket.readyState !== SOCKET_OPEN
      ) {
        if (connection !== undefined) disconnect(connection, false);
        return Promise.resolve(
          relayFailure(
            "SCOPE_OFFLINE",
            "That browser extension session is not connected.",
            "not-sent",
          ),
        );
      }

      const requestId = createId();
      const timeoutMs =
        commandTimeoutMs ?? defaultCommandTimeoutMs(command.command);
      const executionDeadlineAt = clock().getTime() + timeoutMs;
      return new Promise<TabCommandRelayHttpResponse>((resolve) => {
        const pending: PendingCommand = {
          command: command.command,
          connection,
          requestId,
          resolve,
          scope,
          timer: setTimeout(() => {
            finishPending(
              pending,
              relayFailure(
                "COMMAND_TIMEOUT",
                "The browser command timed out. Its outcome is unknown.",
                "unknown",
                requestId,
              ),
            );
          }, timeoutMs),
        };
        pending.timer.unref?.();
        pendingCommands.set(requestId, pending);
        if (
          !send(connection, {
            command: command.command,
            executionDeadlineAt,
            requestId,
            scope,
            type: "command",
            version: tabCommandRelayProtocolVersion,
          })
        ) {
          finishPending(
            pending,
            relayFailure(
              "EXTENSION_DISCONNECTED",
              "The browser extension disconnected while the command was being sent.",
              "unknown",
              requestId,
            ),
          );
          disconnect(connection, true, 1011, "command send failed");
        }
      });
    },

    listConnectedScopes() {
      const items = [...connections.values()]
        .filter(
          (connection): connection is RelayConnection & {
            scope: TabCommandScope;
          } => connection.scope !== undefined && !connection.closed,
        )
        .map((connection) => ({
          ...connection.scope,
          connectedAt: connection.connectedAt.toISOString(),
          lastSeenAt: connection.lastSeenAt.toISOString(),
        }))
        .sort(
          (left, right) =>
            left.browser.localeCompare(right.browser) ||
            left.installationId.localeCompare(right.installationId) ||
            left.browserSessionId.localeCompare(right.browserSessionId),
        );
      return tabCommandRelayConnectedScopesResponseSchema.parse({ items });
    },
  };
}

function statusForRelayResponse(response: TabCommandRelayHttpResponse): number {
  if (response.ok) return 200;
  switch (response.error) {
    case "SCOPE_OFFLINE":
      return 503;
    case "COMMAND_TIMEOUT":
      return 504;
    default:
      return 502;
  }
}

export function registerTabCommandRelayRoutes(
  app: FastifyInstance,
  relay: TabCommandRelay,
  options: TabCommandRelayRouteOptions = {},
): void {
  const appOrigins = new Set(
    (options.appOrigins ?? DEFAULT_APP_ORIGINS).map((origin) =>
      new URL(origin).origin,
    ),
  );
  app.get(
    "/api/tab-command-relay/ws",
    {
      websocket: true,
      async preValidation(request, reply) {
        if (!isExtensionOrigin(request.headers.origin)) {
          return reply.code(403).send({ error: "EXTENSION_ORIGIN_REQUIRED" });
        }
      },
    },
    (socket) => relay.attach(socket),
  );

  app.get("/api/tab-command-relay/scopes", async () =>
    relay.listConnectedScopes(),
  );

  app.post(
    "/api/tab-command-relay/commands",
    {
      async preValidation(request, reply) {
        if (
          request.headers.origin === undefined ||
          !appOrigins.has(request.headers.origin) ||
          request.headers["sec-fetch-site"] !== "same-origin"
        ) {
          return reply.code(403).send({
            error: "TABHUB_APP_ORIGIN_REQUIRED",
          });
        }
      },
    },
    async (request, reply) => {
      const parsed = tabCommandRelayHttpRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "VALIDATION_ERROR",
          issues: parsed.error.issues,
        });
      }

      const response = await relay.dispatch(parsed.data);
      return reply.code(statusForRelayResponse(response)).send(response);
    },
  );
}
