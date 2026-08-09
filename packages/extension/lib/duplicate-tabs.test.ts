import { describe, expect, it, vi } from "vitest";

import {
  closeObviousDuplicates,
  closeObviousDuplicatesAndRefresh,
  parseDuplicateClosePlan,
  previewObviousDuplicates,
  type DuplicateTabAdapter,
  type DuplicateTabLike,
} from "./duplicate-tabs";

function tab(
  id: number,
  url: string,
  overrides: Partial<DuplicateTabLike> = {},
): DuplicateTabLike {
  return {
    active: false,
    id,
    index: id,
    lastAccessed: id * 1_000,
    pinned: false,
    url,
    windowId: 1,
    ...overrides,
  };
}

function fakeAdapter(
  initialTabs: readonly DuplicateTabLike[],
  failRemoval = new Set<number>(),
): DuplicateTabAdapter & {
  get: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const tabs = new Map(
    initialTabs.flatMap((item) =>
      item.id === undefined ? [] : [[item.id, { ...item }] as const],
    ),
  );
  const query = vi.fn(async () => [...tabs.values()]);
  const get = vi.fn(async (tabId: number) => {
    const current = tabs.get(tabId);
    if (current === undefined) throw new Error("No tab with id");
    return { ...current };
  });
  const remove = vi.fn(async (tabId: number) => {
    if (failRemoval.has(tabId)) throw new Error("remove failed");
    tabs.delete(tabId);
  });

  return { get, query, remove };
}

function closePlan(
  tabs: readonly DuplicateTabLike[],
  urls?: readonly string[],
) {
  return previewObviousDuplicates(tabs, urls).plan;
}

describe("parseDuplicateClosePlan", () => {
  it("accepts complete plans above the former group and target ceilings", () => {
    const groups = Array.from({ length: 10_001 }, (_, groupIndex) => {
      const keeperTabId = groupIndex * 6;
      return {
        exactUrl: `https://example.com/duplicate/${groupIndex}`,
        keeperTabId,
        protectedCount: 0,
        targetTabIds: Array.from(
          { length: 5 },
          (_, targetIndex) => keeperTabId + targetIndex + 1,
        ),
      };
    });

    const parsed = parseDuplicateClosePlan({ groups });

    expect(parsed?.groups).toHaveLength(10_001);
    expect(parsed?.groups.at(-1)).toEqual(groups.at(-1));
    expect(
      parsed?.groups.reduce(
        (total, group) => total + group.targetTabIds.length,
        0,
      ),
    ).toBe(50_005);
  });
});

describe("previewObviousDuplicates", () => {
  it("counts only exact trimmed URL groups and keeps their newest tab", () => {
    const preview = previewObviousDuplicates([
      tab(1, "https://example.com/read", { lastAccessed: 100 }),
      tab(2, " https://example.com/read ", { lastAccessed: 300 }),
      tab(3, "https://example.com/read", { lastAccessed: 200 }),
      tab(4, "https://example.com/read#section"),
      tab(5, "https://example.com/read?utm_source=mail"),
    ]);

    expect(preview).toEqual({
      plan: {
        groups: [
          {
            exactUrl: "https://example.com/read",
            keeperTabId: 2,
            protectedCount: 0,
            targetTabIds: [3, 1],
          },
        ],
      },
      totalCloseCandidates: 2,
      totalGroups: 1,
      totalProtected: 0,
    });
  });

  it("protects pinned duplicates while allowing active copies to close", () => {
    const preview = previewObviousDuplicates([
      tab(10, "https://example.com/same", { active: true }),
      tab(11, "https://example.com/same", { pinned: true }),
      tab(12, "https://example.com/same"),
      tab(13, "https://example.com/same"),
    ]);

    expect(preview).toEqual({
      plan: {
        groups: [
          {
            exactUrl: "https://example.com/same",
            keeperTabId: 11,
            protectedCount: 1,
            targetTabIds: [10, 13, 12],
          },
        ],
      },
      totalCloseCandidates: 3,
      totalGroups: 1,
      totalProtected: 1,
    });
  });

  it("limits planning to the exact URL allowlist", () => {
    const preview = previewObviousDuplicates(
      [
        tab(20, "https://one.example"),
        tab(21, "https://one.example"),
        tab(22, "https://two.example"),
        tab(23, "https://two.example"),
      ],
      ["https://two.example"],
    );

    expect(preview.totalGroups).toBe(1);
    expect(preview.totalCloseCandidates).toBe(1);
  });

  it("keeps a tab with known recent access ahead of one with unknown access time", () => {
    const preview = previewObviousDuplicates([
      tab(27, "https://known-recency.example", {
        index: 0,
        lastAccessed: undefined,
        windowId: 1,
      }),
      tab(28, "https://known-recency.example", {
        index: 9,
        lastAccessed: 100,
        windowId: 9,
      }),
    ]);

    expect(preview.plan.groups).toEqual([
      {
        exactUrl: "https://known-recency.example",
        keeperTabId: 28,
        protectedCount: 0,
        targetTabIds: [27],
      },
    ]);
  });
});

describe("closeObviousDuplicates", () => {
  it("rejects a corrupt plan that names its keeper as a close target", async () => {
    const adapter = fakeAdapter([tab(23, "https://same.example")]);

    await expect(
      closeObviousDuplicates(adapter, {
        groups: [
          {
            exactUrl: "https://same.example",
            keeperTabId: 23,
            protectedCount: 0,
            targetTabIds: [23],
          },
        ],
      }),
    ).rejects.toThrow("Invalid duplicate close plan");
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("never expands a confirmed preview to a duplicate opened afterward", async () => {
    const preview = previewObviousDuplicates([
      tab(24, "https://same.example", { lastAccessed: 100 }),
      tab(25, "https://same.example", { lastAccessed: 200 }),
    ]);
    const adapter = fakeAdapter([
      tab(24, "https://same.example", { lastAccessed: 100 }),
      tab(25, "https://same.example", { lastAccessed: 200 }),
      tab(26, "https://same.example", { lastAccessed: 300 }),
    ]);

    await expect(closeObviousDuplicates(adapter, preview.plan)).resolves.toEqual({
      closed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(adapter.remove.mock.calls.flat()).toEqual([24]);
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it("revalidates keeper and target, then removes only older unprotected copies", async () => {
    const tabs = [
      tab(30, "https://same.example", { lastAccessed: 100 }),
      tab(31, "https://same.example", { lastAccessed: 300 }),
      tab(32, "https://same.example", { lastAccessed: 200 }),
    ];
    const adapter = fakeAdapter(tabs);

    await expect(closeObviousDuplicates(adapter, closePlan(tabs))).resolves.toEqual({
      closed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(adapter.remove.mock.calls.flat()).toEqual([32, 30]);
    expect(adapter.get).toHaveBeenCalledWith(31);
    expect(adapter.get).toHaveBeenCalledWith(32);
    expect(adapter.get).toHaveBeenCalledWith(30);
  });

  it("retains one active keeper but closes a target that later became active", async () => {
    const tabs = [
      tab(40, "https://same.example", { active: true }),
      tab(41, "https://same.example"),
      tab(42, "https://same.example"),
    ];
    const adapter = fakeAdapter(tabs);
    adapter.get.mockImplementation(async (tabId: number) => {
      if (tabId === 41) {
        return tab(41, "https://same.example", { active: true });
      }
      return tab(tabId, "https://same.example", {
        active: tabId === 40,
      });
    });

    await expect(closeObviousDuplicates(adapter, closePlan(tabs))).resolves.toEqual({
      closed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(adapter.get.mock.calls[0]).toEqual([40]);
    expect(adapter.remove).toHaveBeenCalledTimes(2);
    expect(adapter.remove).toHaveBeenCalledWith(41);
    expect(adapter.remove).toHaveBeenCalledWith(42);
  });

  it("uses pinned before active and recency as the retained witness", async () => {
    const tabs = [
      tab(43, "https://same.example", {
        active: true,
        lastAccessed: 100,
      }),
      tab(44, "https://same.example", {
        lastAccessed: 900,
        pinned: true,
      }),
      tab(45, "https://same.example", { lastAccessed: 800 }),
    ];
    const adapter = fakeAdapter(tabs);

    await closeObviousDuplicates(adapter, closePlan(tabs));

    expect(adapter.get.mock.calls[0]).toEqual([44]);
    expect(adapter.remove).toHaveBeenCalledWith(43);
    expect(adapter.remove).toHaveBeenCalledWith(45);
  });

  it("skips stale navigation and a missing keeper without closing a unique tab", async () => {
    const tabs = [
      tab(50, "https://same.example", { lastAccessed: 500 }),
      tab(51, "https://same.example", { lastAccessed: 100 }),
    ];
    const adapter = fakeAdapter(tabs);
    adapter.get.mockImplementation(async (tabId: number) => {
      if (tabId === 50) throw new Error("keeper closed");
      return tab(51, "https://different.example");
    });

    await expect(closeObviousDuplicates(adapter, closePlan(tabs))).resolves.toEqual({
      closed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["keeper", 80],
    ["target", 81],
  ] as const)(
    "skips the group while its %s has a pending navigation",
    async (_role, navigatingTabId) => {
      const tabs = [
        tab(80, "https://same.example", { lastAccessed: 200 }),
        tab(81, "https://same.example", { lastAccessed: 100 }),
      ];
      const adapter = fakeAdapter(tabs);
      adapter.get.mockImplementation(async (tabId: number) =>
        tab(tabId, "https://same.example", {
          lastAccessed: tabId === 80 ? 200 : 100,
          ...(tabId === navigatingTabId
            ? { pendingUrl: "https://different.example/loading" }
            : {}),
        }),
      );

      await expect(closeObviousDuplicates(adapter, closePlan(tabs))).resolves.toEqual({
        closed: 0,
        failed: 0,
        skipped: 1,
      });
      expect(adapter.remove).not.toHaveBeenCalled();
    },
  );

  it("continues after a removal failure and reports it separately", async () => {
    const tabs = [
      tab(60, "https://same.example", { lastAccessed: 300 }),
      tab(61, "https://same.example", { lastAccessed: 200 }),
      tab(62, "https://same.example", { lastAccessed: 100 }),
    ];
    const adapter = fakeAdapter(tabs, new Set([61]));

    await expect(closeObviousDuplicates(adapter, closePlan(tabs))).resolves.toEqual({
      closed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(adapter.remove.mock.calls.flat()).toEqual([61, 62]);
  });

  it("refreshes the durable snapshot only after the confirmed close finishes", async () => {
    const events: string[] = [];
    const tabs = [
      tab(70, "https://same.example", { lastAccessed: 200 }),
      tab(71, "https://same.example", { lastAccessed: 100 }),
    ];
    const adapter = fakeAdapter(tabs);
    adapter.remove.mockImplementation(async () => {
      events.push("closed");
    });

    await closeObviousDuplicatesAndRefresh(
      adapter,
      async () => {
        events.push("snapshot");
      },
      closePlan(tabs),
    );

    expect(events).toEqual(["closed", "snapshot"]);
  });
});
