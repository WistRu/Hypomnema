import { describe, expect, it, vi } from "vitest";

import {
  appendPendingItems,
  compactPendingQueue,
  createPendingContent,
  createPendingSnapshot,
  drainPendingQueue,
  MAX_DEAD_LETTERS,
  PendingQueueCapacityError,
  PendingRequestError,
  summarizePendingItems,
  type DeadLetter,
  type PendingItem,
} from "./queue";

function snapshot(
  id: string,
  browser: "chrome" | "edge" = "chrome",
  urls: readonly string[] = [],
  installationId?: string,
) {
  return createPendingSnapshot(
    {
      browser,
      ...(installationId === undefined ? {} : { installationId }),
      tabs: urls.map((url, index) => ({
        index,
        ...(installationId === undefined ? {} : { tabId: index + 1 }),
        url,
        windowId: 1,
      })),
    },
    id,
    `2026-08-08T00:${id.padStart(2, "0")}:00.000Z`,
  );
}

function content(
  id: string,
  url: string,
  browser: "chrome" | "edge" = "chrome",
) {
  return createPendingContent(
    { browser, htmlExcerpt: `<p>${id}</p>`, text: id, url },
    id,
    `2026-08-08T01:${id.padStart(2, "0")}:00.000Z`,
  );
}

const firstSnapshot = snapshot("01");
const secondSnapshot = snapshot("02");

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

    expect(sent).toEqual(["01", "02"]);
    expect(persisted.map((queue) => queue.map(({ id }) => id))).toEqual([
      ["02"],
      [],
    ]);
    expect(result).toEqual({
      deadLetters: [],
      remaining: [],
      serverReachable: true,
    });
  });

  it("keeps a transiently failed head and every successor for retry", async () => {
    const persist = vi.fn(
      async (_queue: readonly PendingItem[], _dead: readonly DeadLetter[]) =>
        undefined,
    );

    const result = await drainPendingQueue(
      [firstSnapshot, secondSnapshot],
      async () => {
        throw new PendingRequestError("server overloaded", {
          retryable: true,
          statusCode: 503,
        });
      },
      persist,
      () => "2026-08-08T00:03:00.000Z",
    );

    expect(result.serverReachable).toBe(false);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining[0]).toMatchObject({
      id: "01",
      attempts: 1,
      lastAttemptAt: "2026-08-08T00:03:00.000Z",
      lastError: "server overloaded",
    });
    expect(result.remaining[1]?.id).toBe("02");
    expect(result.deadLetters).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("dead-letters a permanent head and continues with successors", async () => {
    const sent: string[] = [];
    const persisted: Array<{ dead: string[]; pending: string[] }> = [];

    const result = await drainPendingQueue(
      [firstSnapshot, secondSnapshot],
      async (item) => {
        sent.push(item.id);

        if (item.id === "01") {
          throw new PendingRequestError("invalid snapshot (HTTP 400)", {
            retryable: false,
            statusCode: 400,
          });
        }
      },
      async (queue, deadLetters) => {
        persisted.push({
          dead: deadLetters.map(({ id }) => id),
          pending: queue.map(({ id }) => id),
        });
      },
      () => "2026-08-08T00:04:00.000Z",
    );

    expect(sent).toEqual(["01", "02"]);
    expect(persisted).toEqual([
      { dead: ["01"], pending: ["02"] },
      { dead: ["01"], pending: [] },
    ]);
    expect(result.remaining).toEqual([]);
    expect(result.serverReachable).toBe(true);
    expect(result.deadLetters).toEqual([
      expect.objectContaining({
        attempts: 1,
        error: "invalid snapshot (HTTP 400)",
        failedAt: "2026-08-08T00:04:00.000Z",
        id: "01",
        kind: "snapshot",
        statusCode: 400,
      }),
    ]);
  });

  it("treats throttling as transient and does not discard the head", async () => {
    const result = await drainPendingQueue(
      [firstSnapshot, secondSnapshot],
      async () => {
        throw new PendingRequestError("rate limited", {
          retryable: true,
          statusCode: 429,
        });
      },
      async () => undefined,
    );

    expect(result.remaining.map(({ id }) => id)).toEqual(["01", "02"]);
    expect(result.deadLetters).toEqual([]);
  });

  it("caps durable dead-letter history", async () => {
    const queue = Array.from({ length: MAX_DEAD_LETTERS + 3 }, (_, index) =>
      snapshot(String(index + 10), index % 2 === 0 ? "chrome" : "edge"),
    );
    const result = await drainPendingQueue(
      queue,
      async () => {
        throw new PendingRequestError("bad request", {
          retryable: false,
          statusCode: 422,
        });
      },
      async () => undefined,
    );

    expect(result.remaining).toEqual([]);
    expect(result.deadLetters).toHaveLength(MAX_DEAD_LETTERS);
    expect(result.deadLetters[0]?.id).toBe("13");
  });

  it("does not mutate later entries when persisting an acknowledgement fails", async () => {
    const persist = vi.fn(
      async (_queue: readonly PendingItem[], _dead: readonly DeadLetter[]) => {
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

    expect(persist).toHaveBeenCalledWith([secondSnapshot], []);
    expect(secondSnapshot.id).toBe("02");
    expect(secondSnapshot.attempts).toBe(0);
  });
});

describe("compactPendingQueue", () => {
  it("keeps only the newest uninterrupted snapshot for each browser", () => {
    const chromeOld = snapshot("10", "chrome");
    const edge = snapshot("11", "edge");
    const chromeNew = snapshot("12", "chrome");

    expect(
      compactPendingQueue([chromeOld, edge, chromeNew]).map(({ id }) => id),
    ).toEqual(["11", "12"]);
  });

  it("keeps the snapshot needed before queued content", () => {
    const before = snapshot("20", "chrome", ["https://example.com"]);
    const captured = content("21", "https://example.com");
    const after = snapshot("22", "chrome", ["https://example.com"]);

    expect(
      compactPendingQueue([before, captured, after]).map(({ id }) => id),
    ).toEqual(["20", "21", "22"]);
  });

  it("compacts repeated content by browser and URL before dependencies", () => {
    const before = snapshot("30", "chrome", ["https://example.com"]);
    const oldContent = content("31", "https://example.com");
    const newerSnapshot = snapshot("32", "chrome", ["https://example.com"]);
    const newContent = content("33", "https://example.com");

    expect(
      compactPendingQueue([
        before,
        oldContent,
        newerSnapshot,
        newContent,
      ]).map(({ id }) => id),
    ).toEqual(["32", "33"]);
  });

  it("does not merge identical URLs belonging to different browsers", () => {
    const chrome = content("40", "https://example.com", "chrome");
    const edge = content("41", "https://example.com", "edge");

    expect(compactPendingQueue([chrome, edge]).map(({ id }) => id)).toEqual([
      "40",
      "41",
    ]);
  });

  it("does not supersede snapshots from distinct installations of one browser", () => {
    const first = snapshot(
      "42",
      "chrome",
      ["https://example.com/first"],
      "123e4567-e89b-42d3-a456-426614174000",
    );
    const second = snapshot(
      "43",
      "chrome",
      ["https://example.com/second"],
      "223e4567-e89b-42d3-a456-426614174000",
    );

    expect(compactPendingQueue([first, second]).map(({ id }) => id)).toEqual([
      "42",
      "43",
    ]);
  });
});

describe("appendPendingItems", () => {
  it("accepts more than 2,000 pending operations while within byte capacity", () => {
    const additions = Array.from({ length: 2_001 }, (_, index) =>
      content(
        `item-${index}`,
        `https://example.com/pending/${index}`,
      ),
    );

    expect(
      appendPendingItems([], additions, { maxBytes: 10_000_000 }),
    ).toHaveLength(2_001);
  });

  it("checks serialized byte capacity before persistence with a clear error", () => {
    expect(() =>
      appendPendingItems([], [content("52", "https://example.com")], {
        maxBytes: 10,
      }),
    ).toThrow(/offline queue is full.*bytes.*Reconnect the local server/i);
  });
});

describe("summarizePendingItems", () => {
  it("counts unique unsynchronized tabs separately from queued operations", () => {
    const queue = [
      snapshot("60", "chrome", [
        "https://one.example",
        "https://two.example",
      ]),
      content("61", "https://one.example", "chrome"),
      content("62", "https://one.example", "edge"),
      snapshot("63", "edge", []),
    ];

    expect(summarizePendingItems(queue)).toEqual({
      pendingOperationCount: 4,
      pendingTabCount: 3,
    });
  });

  it("counts duplicate URLs as separate physical tabs when tab IDs are present", () => {
    const pending = createPendingSnapshot(
      {
        browser: "chrome",
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        tabs: [
          { index: 0, tabId: 10, url: "https://same.example", windowId: 1 },
          { index: 1, tabId: 11, url: "https://same.example", windowId: 1 },
        ],
      },
      "physical",
    );

    expect(summarizePendingItems([pending]).pendingTabCount).toBe(2);
  });

  it("uses window and index to retain physical counts for legacy snapshots", () => {
    const pending = createPendingSnapshot(
      {
        browser: "chrome",
        tabs: [
          { index: 0, url: "https://same.example", windowId: 1 },
          { index: 1, url: "https://same.example", windowId: 1 },
          { index: 0, url: "https://same.example", windowId: 2 },
        ],
      },
      "legacy-physical",
    );

    expect(summarizePendingItems([pending]).pendingTabCount).toBe(3);
  });
});

describe("pending payload validation", () => {
  it("rejects invalid snapshots before they can enter persistent storage", () => {
    expect(() =>
      createPendingSnapshot({
        browser: "chrome",
        tabs: [{ index: 0, url: "not a URL", windowId: 1 }],
      }),
    ).toThrow();
  });
});
