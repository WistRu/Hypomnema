import { describe, expect, it, vi } from "vitest";

import {
  createPendingSnapshot,
  drainSnapshotQueue,
  type PendingSnapshot,
} from "./queue";

const firstSnapshot = createPendingSnapshot(
  { browser: "chrome", tabs: [] },
  "first",
  "2026-08-08T00:00:00.000Z",
);
const secondSnapshot = createPendingSnapshot(
  { browser: "chrome", tabs: [] },
  "second",
  "2026-08-08T00:01:00.000Z",
);

describe("drainSnapshotQueue", () => {
  it("sends snapshots in order and persists every acknowledgement", async () => {
    const sent: string[] = [];
    const persisted: PendingSnapshot[][] = [];

    const result = await drainSnapshotQueue(
      [firstSnapshot, secondSnapshot],
      async (_snapshot) => {
        sent.push(sent.length === 0 ? "first" : "second");
      },
      async (queue) => {
        persisted.push([...queue]);
      },
    );

    expect(sent).toEqual(["first", "second"]);
    expect(persisted.map((queue) => queue.map(({ id }) => id))).toEqual([
      ["second"],
      [],
    ]);
    expect(result).toEqual({ remaining: [], serverReachable: true });
  });

  it("keeps the failed snapshot and every successor for retry", async () => {
    const persist = vi.fn<
      (queue: readonly PendingSnapshot[]) => Promise<void>
    >(async () => undefined);

    const result = await drainSnapshotQueue(
      [firstSnapshot, secondSnapshot],
      async () => {
        throw new Error("server offline");
      },
      persist,
      () => "2026-08-08T00:02:00.000Z",
    );

    expect(result.serverReachable).toBe(false);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining[0]).toMatchObject({
      id: "first",
      attempts: 1,
      lastAttemptAt: "2026-08-08T00:02:00.000Z",
      lastError: "server offline",
    });
    expect(result.remaining[1]?.id).toBe("second");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not mutate later entries when persisting an acknowledgement fails", async () => {
    const persist = vi.fn<
      (queue: readonly PendingSnapshot[]) => Promise<void>
    >(async () => {
      throw new Error("storage unavailable");
    });

    await expect(
      drainSnapshotQueue(
        [firstSnapshot, secondSnapshot],
        async () => undefined,
        persist,
      ),
    ).rejects.toThrow("storage unavailable");

    expect(persist).toHaveBeenCalledWith([secondSnapshot]);
    expect(secondSnapshot.id).toBe("second");
    expect(secondSnapshot.attempts).toBe(0);
  });
});
