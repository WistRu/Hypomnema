import type { IngestContent, IngestSnapshot } from "@tabhub/shared";

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

export interface DrainQueueResult {
  remaining: PendingItem[];
  serverReachable: boolean | null;
}

export type PendingItemSender = (item: PendingItem) => Promise<void>;
export type QueuePersister = (queue: readonly PendingItem[]) => Promise<void>;

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
    payload,
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
    payload,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function drainPendingQueue(
  initialQueue: readonly PendingItem[],
  send: PendingItemSender,
  persist: QueuePersister,
  now: () => string = () => new Date().toISOString(),
): Promise<DrainQueueResult> {
  let remaining = [...initialQueue];
  let serverReachable: boolean | null = null;

  while (remaining.length > 0) {
    const next = remaining[0];

    if (next === undefined) {
      break;
    }

    try {
      await send(next);
    } catch (error) {
      serverReachable = false;
      remaining[0] = {
        ...next,
        attempts: next.attempts + 1,
        lastAttemptAt: now(),
        lastError: errorMessage(error),
      };
      await persist(remaining);
      break;
    }

    serverReachable = true;
    const afterAcknowledgement = remaining.slice(1);
    await persist(afterAcknowledgement);
    remaining = afterAcknowledgement;
  }

  return { remaining, serverReachable };
}
