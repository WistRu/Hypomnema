import type { IngestSnapshot } from "@tabhub/shared";

export interface PendingSnapshot {
  attempts: number;
  createdAt: string;
  id: string;
  lastAttemptAt?: string;
  lastError?: string;
  payload: IngestSnapshot;
}

export interface DrainQueueResult {
  remaining: PendingSnapshot[];
  serverReachable: boolean | null;
}

export type SnapshotSender = (snapshot: IngestSnapshot) => Promise<void>;
export type QueuePersister = (queue: readonly PendingSnapshot[]) => Promise<void>;

export function createPendingSnapshot(
  payload: IngestSnapshot,
  id: string = crypto.randomUUID(),
  createdAt: string = new Date().toISOString(),
): PendingSnapshot {
  return {
    attempts: 0,
    createdAt,
    id,
    payload,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function drainSnapshotQueue(
  initialQueue: readonly PendingSnapshot[],
  send: SnapshotSender,
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
      await send(next.payload);
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
