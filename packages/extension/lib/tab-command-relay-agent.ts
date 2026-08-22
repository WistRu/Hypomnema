import {
  tabCommandRelayClientEnvelopeSchema,
  tabCommandRelayProtocolVersion,
  tabCommandRelayResultEnvelopeSchema,
  tabCommandRelayResultSchema,
  tabCommandRelayServerEnvelopeSchema,
  tabCommandScopeSchema,
  type TabCommandRelayClientEnvelope,
  type TabCommandRelayCommand,
  type TabCommandRelayResult,
  type TabCommandRelayServerEnvelope,
  type TabCommandScope,
} from "@tabhub/shared";

const RECEIPT_STORAGE_KEY = "tabhub.tabCommandRelayReceipts";
const RECEIPT_TTL_MS = 10 * 60_000;
const MAX_STORED_RECEIPTS = 128;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_INACTIVITY_TIMEOUT_MS = 45_000;

export interface TabCommandRelaySocketHandlers {
  close(): void;
  error(): void;
  message(data: unknown): void;
  open(): void;
}

/** A small adapter seam keeps WebSocket lifecycle behaviour deterministic in tests. */
export interface TabCommandRelaySocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  setHandlers(handlers: TabCommandRelaySocketHandlers): void;
}

export interface TabCommandRelaySessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface TabCommandRelayAgentOptions {
  canConnect(): Promise<boolean>;
  createSocket(url: string): TabCommandRelaySocket;
  execute(
    scope: TabCommandScope,
    command: TabCommandRelayCommand,
    metadata: TabCommandRelayExecutionMetadata,
  ): Promise<TabCommandRelayResult>;
  getScope(): Promise<TabCommandScope | undefined>;
  now?: () => number;
  relayUrl: string;
  sequenceLiveCommand<T>(operation: () => Promise<T>): Promise<T>;
  storage: TabCommandRelaySessionStorage;
  onError?: (error: unknown) => void;
}

export interface TabCommandRelayExecutionMetadata {
  executionDeadlineAt: number;
  requestId: string;
}

export interface TabCommandRelayAgent {
  restart(): void;
  start(): void;
  stop(): void;
}

export function createBrowserTabCommandRelaySocket(
  url: string,
): TabCommandRelaySocket {
  const socket = new WebSocket(url);
  return {
    close: (code, reason) => socket.close(code, reason),
    send: (data) => socket.send(data),
    setHandlers(handlers) {
      socket.addEventListener("open", () => handlers.open());
      socket.addEventListener("message", (event) =>
        handlers.message(event.data),
      );
      socket.addEventListener("close", () => handlers.close());
      socket.addEventListener("error", () => handlers.error());
    },
  };
}

interface StoredReceipt {
  envelope: TabCommandRelayResultEnvelope;
  expiresAt: number;
}

type TabCommandRelayResultEnvelope = Extract<
  TabCommandRelayClientEnvelope,
  { type: "result" }
>;

type TabCommandRelayCommandEnvelope = Extract<
  TabCommandRelayServerEnvelope,
  { type: "command" }
>;

interface Connection {
  generation: number;
  heartbeatIntervalMs: number;
  ready: boolean;
  scope: TabCommandScope;
  socket: TabCommandRelaySocket;
  watchdog?: ReturnType<typeof setTimeout>;
}

function scopesEqual(left: TabCommandScope, right: TabCommandScope): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const value = String(error).trim();
  return value.length > 0 ? value : "The browser command failed.";
}

function parseStoredReceipts(value: unknown, now: number): StoredReceipt[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Object.hasOwn(entry, "envelope") ||
      !Object.hasOwn(entry, "expiresAt")
    ) {
      return [];
    }
    const candidate = entry as { envelope?: unknown; expiresAt?: unknown };
    const expiresAt = candidate.expiresAt;
    if (
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    ) {
      return [];
    }
    const parsed = tabCommandRelayResultEnvelopeSchema.safeParse(
      candidate.envelope,
    );
    return parsed.success
      ? [{ envelope: parsed.data, expiresAt }]
      : [];
  });
}

function parseServerEnvelope(data: unknown) {
  if (typeof data !== "string") return undefined;
  try {
    const decoded: unknown = JSON.parse(data);
    const parsed = tabCommandRelayServerEnvelopeSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function reconnectDelay(attempt: number): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 16),
    MAX_RECONNECT_DELAY_MS,
  );
}

export function createTabCommandRelayAgent(
  options: TabCommandRelayAgentOptions,
): TabCommandRelayAgent {
  const now = options.now ?? (() => Date.now());
  const receipts = new Map<string, StoredReceipt>();
  const inFlight = new Map<
    string,
    Promise<TabCommandRelayResultEnvelope>
  >();
  let receiptLoad: Promise<void> | undefined;
  let receiptWriteTail: Promise<void> = Promise.resolve();
  let activeConnection: Connection | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let started = false;
  let connectionPending = false;

  const reportError = (error: unknown) => options.onError?.(error);

  function pruneReceipts(): void {
    const currentTime = now();
    for (const [requestId, receipt] of receipts) {
      if (receipt.expiresAt <= currentTime) receipts.delete(requestId);
    }
    while (receipts.size > MAX_STORED_RECEIPTS) {
      const oldest = receipts.keys().next();
      if (oldest.done) break;
      receipts.delete(oldest.value);
    }
  }

  async function loadReceipts(): Promise<void> {
    if (receiptLoad === undefined) {
      receiptLoad = options.storage
        .get(RECEIPT_STORAGE_KEY)
        .then((stored) => {
          for (const receipt of parseStoredReceipts(
            stored[RECEIPT_STORAGE_KEY],
            now(),
          )) {
            receipts.set(receipt.envelope.requestId, receipt);
          }
          pruneReceipts();
        })
        .catch(reportError);
    }
    await receiptLoad;
  }

  function persistReceipts(): Promise<void> {
    pruneReceipts();
    const snapshot = {
      [RECEIPT_STORAGE_KEY]: [...receipts.values()],
    };
    const write = receiptWriteTail.then(
      () => options.storage.set(snapshot),
      () => options.storage.set(snapshot),
    );
    receiptWriteTail = write.catch(() => undefined);
    return write;
  }

  function send(
    connection: Connection,
    envelope: TabCommandRelayClientEnvelope,
  ): boolean {
    if (activeConnection !== connection || connection.generation !== generation) {
      return false;
    }
    const parsed = tabCommandRelayClientEnvelopeSchema.parse(envelope);
    try {
      connection.socket.send(JSON.stringify(parsed));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function clearWatchdog(connection: Connection): void {
    if (connection.watchdog !== undefined) {
      clearTimeout(connection.watchdog);
      delete connection.watchdog;
    }
  }

  function scheduleReconnect(): void {
    if (!started || reconnectTimer !== undefined) return;
    const expectedGeneration = generation;
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (started && expectedGeneration === generation) {
        void connect(expectedGeneration);
      }
    }, delay);
  }

  function dropConnection(
    connection: Connection,
    code?: number,
    reason?: string,
  ): void {
    if (activeConnection !== connection) return;
    activeConnection = undefined;
    clearWatchdog(connection);
    try {
      connection.socket.close(code, reason);
    } catch (error) {
      reportError(error);
    }
    scheduleReconnect();
  }

  function resetWatchdog(connection: Connection): void {
    clearWatchdog(connection);
    const timeoutMs = Math.max(
      INITIAL_INACTIVITY_TIMEOUT_MS,
      connection.heartbeatIntervalMs * 3,
    );
    connection.watchdog = setTimeout(() => {
      dropConnection(connection, 1001, "TabHub relay heartbeat timed out");
    }, timeoutMs);
  }

  async function executeCommand(
    requestId: string,
    scope: TabCommandScope,
    command: TabCommandRelayCommand,
    executionDeadlineAt: number,
  ): Promise<TabCommandRelayResultEnvelope> {
    if (now() >= executionDeadlineAt) {
      return tabCommandRelayResultEnvelopeSchema.parse({
        error: "The browser command expired before execution.",
        ok: false,
        requestId,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      });
    }
    try {
      const result = tabCommandRelayResultSchema.parse(
        await options.execute(scope, command, {
          executionDeadlineAt,
          requestId,
        }),
      );
      return tabCommandRelayResultEnvelopeSchema.parse({
        ok: true,
        requestId,
        result,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      });
    } catch (error) {
      return tabCommandRelayResultEnvelopeSchema.parse({
        error: errorMessage(error),
        ok: false,
        requestId,
        scope,
        type: "result",
        version: tabCommandRelayProtocolVersion,
      });
    }
  }

  async function receiptForCommand(
    requestId: string,
    scope: TabCommandScope,
    command: TabCommandRelayCommand,
    executionDeadlineAt: number,
  ): Promise<TabCommandRelayResultEnvelope> {
    await loadReceipts();
    pruneReceipts();
    const stored = receipts.get(requestId);
    if (stored !== undefined && scopesEqual(stored.envelope.scope, scope)) {
      return stored.envelope;
    }

    const pending = inFlight.get(requestId);
    if (pending !== undefined) return pending;

    const operation = () =>
      executeCommand(requestId, scope, command, executionDeadlineAt);
    const execution =
      command.kind === "get-browser-state"
        ? operation()
        : options.sequenceLiveCommand(operation);
    inFlight.set(requestId, execution);
    try {
      const envelope = await execution;
      receipts.set(requestId, {
        envelope,
        expiresAt: now() + RECEIPT_TTL_MS,
      });
      try {
        await persistReceipts();
      } catch (error) {
        // The in-memory receipt still prevents a duplicate execution during
        // this worker lifetime. Do not hide a known command result from the UI.
        reportError(error);
      }
      return envelope;
    } finally {
      inFlight.delete(requestId);
    }
  }

  async function handleCommand(
    connection: Connection,
    envelope: TabCommandRelayCommandEnvelope,
  ): Promise<void> {
    if (!connection.ready) {
      dropConnection(connection, 1008, "Command received before relay ready");
      return;
    }
    if (!scopesEqual(connection.scope, envelope.scope)) {
      dropConnection(
        connection,
        1008,
        "Command scope does not match this browser session",
      );
      return;
    }

    const receipt = await receiptForCommand(
      envelope.requestId,
      envelope.scope,
      envelope.command,
      envelope.executionDeadlineAt,
    );
    // If execution completed after a disconnect, the receipt stays available
    // for deduplication but is never forwarded through a replacement socket.
    send(connection, receipt);
  }

  function onServerMessage(connection: Connection, data: unknown): void {
    const envelope = parseServerEnvelope(data);
    if (envelope === undefined) {
      dropConnection(connection, 1008, "Invalid TabHub relay message");
      return;
    }
    resetWatchdog(connection);

    switch (envelope.type) {
      case "ready":
        if (!scopesEqual(connection.scope, envelope.scope)) {
          dropConnection(connection, 1008, "Relay registered the wrong scope");
          return;
        }
        connection.ready = true;
        connection.heartbeatIntervalMs = envelope.heartbeatIntervalMs;
        reconnectAttempt = 0;
        resetWatchdog(connection);
        return;
      case "ping":
        send(connection, {
          heartbeatId: envelope.heartbeatId,
          type: "pong",
          version: tabCommandRelayProtocolVersion,
        });
        return;
      case "command":
        void handleCommand(connection, envelope).catch(reportError);
        return;
    }
  }

  async function connect(expectedGeneration: number): Promise<void> {
    if (
      !started ||
      expectedGeneration !== generation ||
      activeConnection !== undefined ||
      connectionPending
    ) {
      return;
    }
    connectionPending = true;
    try {
      const scopeValue = await options.getScope();
      if (!started || expectedGeneration !== generation) return;
      if (scopeValue === undefined) return;
      const scope = tabCommandScopeSchema.parse(scopeValue);
      const canConnect = await options.canConnect();
      if (!started || expectedGeneration !== generation) return;
      if (!canConnect) {
        scheduleReconnect();
        return;
      }
      let socket: TabCommandRelaySocket;
      try {
        socket = options.createSocket(options.relayUrl);
      } catch (error) {
        reportError(error);
        scheduleReconnect();
        return;
      }

      const connection: Connection = {
        generation: expectedGeneration,
        heartbeatIntervalMs: INITIAL_INACTIVITY_TIMEOUT_MS / 3,
        ready: false,
        scope,
        socket,
      };
      activeConnection = connection;
      resetWatchdog(connection);
      socket.setHandlers({
        close: () => dropConnection(connection),
        error: () => dropConnection(connection),
        message: (data) => onServerMessage(connection, data),
        open: () => {
          send(connection, {
            scope,
            type: "register",
            version: tabCommandRelayProtocolVersion,
          });
        },
      });
    } catch (error) {
      reportError(error);
      scheduleReconnect();
    } finally {
      connectionPending = false;
      if (
        started &&
        expectedGeneration !== generation &&
        activeConnection === undefined
      ) {
        void connect(generation);
      }
    }
  }

  return {
    restart() {
      generation += 1;
      reconnectAttempt = 0;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const connection = activeConnection;
      activeConnection = undefined;
      if (connection !== undefined) {
        clearWatchdog(connection);
        try {
          connection.socket.close(1000, "TabHub relay scope changed");
        } catch (error) {
          reportError(error);
        }
      }
      if (started) void connect(generation);
    },
    start() {
      if (started) return;
      started = true;
      void connect(generation);
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const connection = activeConnection;
      activeConnection = undefined;
      if (connection !== undefined) {
        clearWatchdog(connection);
        try {
          connection.socket.close(1000, "TabHub relay agent stopped");
        } catch (error) {
          reportError(error);
        }
      }
    },
  };
}
