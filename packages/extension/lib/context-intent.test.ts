import type { IngestSnapshot } from "@tabhub/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localStore = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    clear: () => {
      for (const key of Object.keys(values)) delete values[key];
    },
    get: vi.fn(async (key: string) =>
      Object.hasOwn(values, key) ? { [key]: values[key] } : {},
    ),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
    setAccessLevel: vi.fn(async () => undefined),
    values,
  };
});

vi.mock("wxt/browser", () => ({
  browser: { storage: { local: localStore } },
}));

import {
  createPendingContextMutation,
  deliverPendingContextMutation,
  discardStalePendingContextMutationHead,
  drainPendingContextMutations,
  fetchContextFeatures,
  readPendingContextMutations,
  resolveContextFeatures,
  StaleContextMutationError,
  writePendingContextMutations,
  type PendingContextMutation,
} from "./context-intent";
import { PairingRequiredError } from "./local-capability";

const snapshot: IngestSnapshot = {
  browser: "chrome",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
  tabs: [],
};

beforeEach(() => {
  localStore.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function item(key = "stable-key") {
  return createPendingContextMutation(
    {
      kind: "session-intent",
      command: {
        body: "Compare with the alternative",
        expectedUrl: "https://example.com/article",
        idempotencyKey: key,
        kind: "set",
        scope: {
          browserSessionId: snapshot.browserSessionId!,
          browserTabId: 42,
          installationId: snapshot.installationId!,
        },
        visibility: "local_only",
      },
      snapshot,
    },
    "323e4567-e89b-42d3-a456-426614174000",
    "2026-08-12T10:00:00.000Z",
  );
}

describe("context mutation queue", () => {
  it("waits for a successful snapshot before sending the context command", async () => {
    const events: string[] = [];
    await deliverPendingContextMutation(item(), {
      postSnapshot: async () => {
        events.push("snapshot");
      },
      postCommand: async () => {
        events.push("command");
      },
    });
    expect(events).toEqual(["snapshot", "command"]);
  });

  it("sends zero context commands when the preceding snapshot fails", async () => {
    const postCommand = vi.fn(async () => undefined);
    await expect(
      deliverPendingContextMutation(item(), {
        postSnapshot: async () => {
          throw new Error("snapshot unavailable");
        },
        postCommand,
      }),
    ).rejects.toThrow("snapshot unavailable");
    expect(postCommand).not.toHaveBeenCalled();
  });

  it("keeps the head before an unavailable snapshot and sends no later mutation", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const persist = vi.fn(async () => undefined);
    const result = await drainPendingContextMutations(
      [item(), item("later-key")],
      persist,
      send,
      () => "2026-08-12T10:01:00.000Z",
    );

    expect(send).toHaveBeenCalledOnce();
    expect(result.remaining.map(({ command }) => command.idempotencyKey)).toEqual([
      "stable-key",
      "later-key",
    ]);
    expect(persist).toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
  });

  it("retries a lost response with the same idempotency key and ACKs one head", async () => {
    const pending = item();
    const persist = vi.fn(async () => undefined);
    const firstSend = vi.fn(async () => {
      throw new Error("response lost");
    });
    const first = await drainPendingContextMutations(
      [pending],
      persist,
      firstSend,
    );
    expect(first.remaining[0]?.command.idempotencyKey).toBe("stable-key");

    const secondSend = vi.fn(async () => undefined);
    const second = await drainPendingContextMutations(
      first.remaining,
      persist,
      secondSend,
    );
    expect(secondSend).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ idempotencyKey: "stable-key" }),
      }),
    );
    expect(second).toMatchObject({ remaining: [], sent: 1 });
    expect(persist).toHaveBeenLastCalledWith([]);
  });

  it("replays after server success before local ACK without duplicating the effect", async () => {
    const pending = item("crash-safe-key");
    const applied = new Set<string>();
    let effectCount = 0;
    const server = async (queued: PendingContextMutation) => {
      const key = queued.command.idempotencyKey;
      if (!applied.has(key)) {
        applied.add(key);
        effectCount += 1;
      }
    };
    const first = await drainPendingContextMutations(
      [pending],
      async () => undefined,
      async (queued) => {
        await server(queued);
        throw new Error("worker crashed before queue ACK");
      },
    );

    expect(first.remaining[0]?.command.idempotencyKey).toBe("crash-safe-key");
    const second = await drainPendingContextMutations(
      first.remaining,
      async () => undefined,
      server,
    );
    expect(second.remaining).toEqual([]);
    expect(effectCount).toBe(1);
  });

  it("keeps queued payload secret-free and reports pairing generically", async () => {
    const pending = item();
    expect(JSON.stringify(pending)).not.toContain("Bearer");
    expect(JSON.stringify(pending)).not.toContain("credential");
    expect(JSON.stringify(pending)).not.toContain("challengeId");
    const result = await drainPendingContextMutations(
      [pending],
      async () => undefined,
      async () => {
        throw new PairingRequiredError();
      },
    );
    expect(result.pairingRequired).toBe(true);
    expect(result.remaining[0]?.lastError).toBe("Pairing required");
  });

  it("uses the last trusted feature discovery while the server is offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ context: true, logicalImportance: false }),
      ),
    );
    await expect(fetchContextFeatures()).resolves.toMatchObject({ context: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(resolveContextFeatures()).resolves.toEqual({
      context: true,
      logicalImportance: false,
    });
  });

  it("blocks visibly at a corrupted queue head without sending successors", async () => {
    localStore.values["tabhub.pendingContextMutations"] = [
      { corrupted: true },
      item("must-not-send"),
    ];
    await expect(readPendingContextMutations()).rejects.toThrow(
      "Personal-context queue is corrupted; no later mutations were sent",
    );
  });

  it.each([
    { id: "not-a-uuid" },
    { createdAt: "not-a-datetime" },
    { createdAt: "2026-02-30T10:00:00.000Z" },
    { lastAttemptAt: 42 },
    { lastAttemptAt: "2026-08-12" },
    { lastAttemptAt: `2026-08-12T10:00:00.${"1".repeat(20)}Z` },
    { lastError: "Unexpected retry state" },
    { lastError: null },
  ])("rejects corrupted optional queue metadata %#", async (metadata) => {
    localStore.values["tabhub.pendingContextMutations"] = [
      { ...item(), ...metadata },
      item("must-not-send"),
    ];

    await expect(readPendingContextMutations()).rejects.toThrow(
      "Personal-context queue is corrupted; no later mutations were sent",
    );
  });

  it("keeps a stale-navigation head as an explicit review barrier", async () => {
    const send = vi.fn(async () => {
      throw new StaleContextMutationError();
    });
    const result = await drainPendingContextMutations(
      [item(), item("later")],
      async () => undefined,
      send,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(result.remaining[0]?.lastError).toBe(
      "Page changed; review required",
    );
    expect(result.remaining[1]?.command.idempotencyKey).toBe("later");
  });

  it("does not retry an already-marked stale head without user resolution", async () => {
    const stale = {
      ...item(),
      lastError: "Page changed; review required" as const,
    };
    const send = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);

    const result = await drainPendingContextMutations(
      [stale, item("later")],
      persist,
      send,
    );

    expect(send).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ remaining: [stale, item("later")], sent: 0 });
  });

  it("discards only the confirmed stale head and drains its successor exactly once", async () => {
    const stale = item();
    const successor = item("later");
    await writePendingContextMutations([stale, successor]);
    const offline = await drainPendingContextMutations(
      [stale, successor],
      writePendingContextMutations,
      async () => {
        throw new Error("offline");
      },
      () => "2026-08-12T10:01:00.000Z",
    );
    expect(offline.remaining[0]?.lastError).toBe("Retry required");
    const navigated = await drainPendingContextMutations(
      offline.remaining,
      writePendingContextMutations,
      async () => {
        throw new StaleContextMutationError();
      },
      () => "2026-08-12T10:02:00.000Z",
    );
    expect(navigated.remaining[0]?.lastError).toBe(
      "Page changed; review required",
    );

    const send = vi.fn(async () => undefined);
    const result = await discardStalePendingContextMutationHead(stale.id, {
      send,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ idempotencyKey: "later" }),
      }),
    );
    expect(result).toMatchObject({ remaining: [], sent: 1 });
    await expect(readPendingContextMutations()).resolves.toEqual([]);
  });

  it("refuses a stale discard when the reviewed head has changed", async () => {
    const current = {
      ...item("current-key"),
      lastError: "Page changed; review required" as const,
    };
    await writePendingContextMutations([current]);

    await expect(
      discardStalePendingContextMutationHead("previous-head-id"),
    ).rejects.toThrow("The queued context changed; review it again");
    await expect(readPendingContextMutations()).resolves.toEqual([current]);
  });
});
