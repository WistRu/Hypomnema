import { describe, expect, it, vi } from "vitest";

import {
  createPendingContent,
  createPendingSnapshot,
  drainPendingQueue,
  type PendingItem,
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

describe("drainPendingQueue", () => {
  it("sends queued items in order and persists every acknowledgement", async () => {
    const sent: string[] = [];
    const persisted: PendingItem[][] = [];

    const result = await drainPendingQueue(
      [firstSnapshot, secondSnapshot],
      async (item) => {
        sent.push(item.id);
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
    const persist = vi.fn<(queue: readonly PendingItem[]) => Promise<void>>(
      async () => undefined,
    );

    const result = await drainPendingQueue(
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
    const persist = vi.fn<(queue: readonly PendingItem[]) => Promise<void>>(
      async () => {
        throw new Error("storage unavailable");
      },
    );

    await expect(
      drainPendingQueue(
        [firstSnapshot, secondSnapshot],
        async () => undefined,
        persist,
      ),
    ).rejects.toThrow("storage unavailable");

    expect(persist).toHaveBeenCalledWith([secondSnapshot]);
    expect(secondSnapshot.id).toBe("second");
    expect(secondSnapshot.attempts).toBe(0);
  });

  it("keeps content payloads durable behind an unavailable server", async () => {
    const content = createPendingContent(
      {
        browser: "chrome",
        htmlExcerpt: "<p>Saved</p>",
        text: "Saved",
        url: "https://example.com",
      },
      "content",
      "2026-08-08T00:03:00.000Z",
    );

    const result = await drainPendingQueue(
      [content],
      async () => {
        throw new Error("server offline");
      },
      async () => undefined,
    );

    expect(result.remaining[0]).toMatchObject({
      id: "content",
      kind: "content",
      attempts: 1,
      payload: { text: "Saved" },
    });
  });
});
