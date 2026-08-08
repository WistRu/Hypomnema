import {
  ingestContentSchema,
  ingestSnapshotSchema,
  type IngestContent,
  type IngestSnapshot,
} from "@tabhub/shared";

interface PendingItemMetadata {
  attempts: number;
  createdAt: string;
  id: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface PendingSnapshot extends PendingItemMetadata {
  kind: "snapshot";
  payload: IngestSnapshot;
}

export interface PendingContent extends PendingItemMetadata {
  kind: "content";
  payload: IngestContent;
}

export type PendingItem = PendingSnapshot | PendingContent;

export interface DeadLetter {
  attempts: number;
  browser: string;
  createdAt: string;
  error: string;
  failedAt: string;
  id: string;
  kind: PendingItem["kind"];
  statusCode?: number;
  url?: string;
}

export interface DrainQueueResult {
  deadLetters: DeadLetter[];
  remaining: PendingItem[];
  serverReachable: boolean | null;
}

export interface PendingQueueLimits {
  maxBytes: number;
  maxItems: number;
}

export interface PendingQueueSummary {
  pendingOperationCount: number;
  pendingTabCount: number;
}

export const MAX_DEAD_LETTERS = 50;
export const DEFAULT_PENDING_QUEUE_LIMITS: PendingQueueLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxItems: 2_000,
};

export type PendingItemSender = (item: PendingItem) => Promise<void>;
export type QueuePersister = (
  queue: readonly PendingItem[],
  deadLetters: readonly DeadLetter[],
) => Promise<void>;

export class PendingRequestError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number },
  ) {
    super(message);
    this.name = "PendingRequestError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export class PendingQueueCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingQueueCapacityError";
  }
}

export function createPendingSnapshot(
  payload: IngestSnapshot,
  id: string = crypto.randomUUID(),
  createdAt: string = new Date().toISOString(),
): PendingSnapshot {
  return {
    attempts: 0,
    createdAt,
    id,
    kind: "snapshot",
    payload: ingestSnapshotSchema.parse(payload),
  };
}

export function createPendingContent(
  payload: IngestContent,
  id: string = crypto.randomUUID(),
  createdAt: string = new Date().toISOString(),
): PendingContent {
  return {
    attempts: 0,
    createdAt,
    id,
    kind: "content",
    payload: ingestContentSchema.parse(payload),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentKey(item: PendingContent): string {
  return `${item.payload.browser}\u0000${item.payload.url}`;
}

/**
 * Keep the newest content for a browser/URL, then remove snapshots superseded
 * by a newer snapshot for that browser. Content is a barrier: the nearest
 * preceding snapshot must remain ahead of it so first-time content ingestion
 * can still resolve the tab.
 */
export function compactPendingQueue(
  queue: readonly PendingItem[],
): PendingItem[] {
  const newestContentIndex = new Map<string, number>();

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];

    if (item?.kind === "content") {
      newestContentIndex.set(contentKey(item), index);
    }
  }

  const deduplicatedContent = queue.filter((item, index) => {
    return (
      item.kind !== "content" ||
      newestContentIndex.get(contentKey(item)) === index
    );
  });
  const compacted: Array<PendingItem | undefined> = [];
  const replaceableSnapshot = new Map<string, number>();

  for (const item of deduplicatedContent) {
    if (item.kind === "content") {
      compacted.push(item);
      replaceableSnapshot.delete(item.payload.browser);
      continue;
    }

    const browser = item.payload.browser;
    const supersededIndex = replaceableSnapshot.get(browser);

    if (supersededIndex !== undefined) {
      compacted[supersededIndex] = undefined;
    }

    compacted.push(item);
    replaceableSnapshot.set(browser, compacted.length - 1);
  }

  return compacted.filter((item): item is PendingItem => item !== undefined);
}

export function pendingQueueByteSize(queue: readonly PendingItem[]): number {
  return new TextEncoder().encode(JSON.stringify(queue)).byteLength;
}

export function assertPendingQueueCapacity(
  queue: readonly PendingItem[],
  limits: PendingQueueLimits = DEFAULT_PENDING_QUEUE_LIMITS,
): void {
  const byteSize = pendingQueueByteSize(queue);

  if (queue.length > limits.maxItems || byteSize > limits.maxBytes) {
    throw new PendingQueueCapacityError(
      `TabHub's offline queue is full (${queue.length} operations, ${byteSize} bytes; limits ${limits.maxItems} operations and ${limits.maxBytes} bytes). Reconnect the local server and retry.`,
    );
  }
}

export function appendPendingItems(
  current: readonly PendingItem[],
  additions: readonly PendingItem[],
  limits: PendingQueueLimits = DEFAULT_PENDING_QUEUE_LIMITS,
): PendingItem[] {
  const compacted = compactPendingQueue([...current, ...additions]);
  assertPendingQueueCapacity(compacted, limits);
  return compacted;
}

export function summarizePendingItems(
  queue: readonly PendingItem[],
): PendingQueueSummary {
  const tabs = new Set<string>();

  for (const item of queue) {
    if (item.kind === "content") {
      tabs.add(`${item.payload.browser}\u0000${item.payload.url}`);
      continue;
    }

    for (const tab of item.payload.tabs) {
      tabs.add(`${item.payload.browser}\u0000${tab.url}`);
    }
  }

  return {
    pendingOperationCount: queue.length,
    pendingTabCount: tabs.size,
  };
}

function toDeadLetter(
  item: PendingItem,
  error: PendingRequestError,
  failedAt: string,
): DeadLetter {
  const deadLetter: DeadLetter = {
    attempts: item.attempts + 1,
    browser: item.payload.browser,
    createdAt: item.createdAt,
    error: error.message,
    failedAt,
    id: item.id,
    kind: item.kind,
  };
  const url = item.kind === "content" ? item.payload.url : undefined;

  if (url !== undefined) {
    deadLetter.url = url;
  }

  if (error.statusCode !== undefined) {
    deadLetter.statusCode = error.statusCode;
  }

  return deadLetter;
}

function capDeadLetters(deadLetters: readonly DeadLetter[]): DeadLetter[] {
  return deadLetters.slice(-MAX_DEAD_LETTERS);
}

export async function drainPendingQueue(
  initialQueue: readonly PendingItem[],
  send: PendingItemSender,
  persist: QueuePersister,
  now: () => string = () => new Date().toISOString(),
  initialDeadLetters: readonly DeadLetter[] = [],
): Promise<DrainQueueResult> {
  let remaining = [...initialQueue];
  let deadLetters = capDeadLetters(initialDeadLetters);
  let serverReachable: boolean | null = null;

  while (remaining.length > 0) {
    const next = remaining[0];

    if (next === undefined) {
      break;
    }

    try {
      await send(next);
    } catch (error) {
      const failedAt = now();

      if (error instanceof PendingRequestError && !error.retryable) {
        serverReachable = true;
        deadLetters = capDeadLetters([
          ...deadLetters,
          toDeadLetter(next, error, failedAt),
        ]);
        remaining = remaining.slice(1);
        await persist(remaining, deadLetters);
        continue;
      }

      serverReachable = false;
      remaining[0] = {
        ...next,
        attempts: next.attempts + 1,
        lastAttemptAt: failedAt,
        lastError: errorMessage(error),
      };
      await persist(remaining, deadLetters);
      break;
    }

    serverReachable = true;
    remaining = remaining.slice(1);
    await persist(remaining, deadLetters);
  }

  return { deadLetters, remaining, serverReachable };
}
