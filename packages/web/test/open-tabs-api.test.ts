import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAllOpenTabs,
  fetchDuplicateGroups,
  fetchOpenTabs,
} from "../src/api";

function instance(instanceId: number, active = false) {
  return {
    instanceId,
    canonicalTabId: 7,
    installationId: "chrome-main",
    browserTabId: instanceId,
    url: "https://example.com/exact",
    urlNormalized: "https://example.com/exact",
    title: "Exact copy",
    browser: "chrome",
    windowId: 2,
    index: instanceId - 101,
    faviconUrl: null,
    active,
    audible: false,
    discarded: false,
    muted: false,
    pinned: false,
    lastAccessed: 1_754_700_000_000 + instanceId,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:01:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 3,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("open-tab API", () => {
  it("loads more than 200 filtered physical occurrences with one bulk request", async () => {
    const items = Array.from({ length: 251 }, (_, index) =>
      instance(index + 101),
    );
    const fetchMock = vi.fn(async () =>
      Response.json({
        items,
        total: items.length,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllOpenTabs({
        browser: "chrome",
        duplicatesOnly: true,
        q: "exact copy",
      }),
    ).resolves.toHaveLength(251);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tab-instances/bulk?browser=chrome&duplicates_only=true&q=exact+copy",
    );
  });

  it("rejects a bulk payload that violates the shared response contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], total: "all" })),
    );

    await expect(
      fetchAllOpenTabs({ browser: "all", duplicatesOnly: false, q: "" }),
    ).rejects.toThrow("unexpected bulk open-tab list");
  });

  it("requests physical occurrences with duplicate and browser filters", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            instanceId: 101,
            canonicalTabId: 7,
            installationId: "chrome-main",
            browserTabId: 55,
            url: "https://example.com/exact",
            urlNormalized: "https://example.com/exact",
            title: "Exact copy",
            browser: "chrome",
            windowId: 2,
            index: 5,
            faviconUrl: null,
            active: false,
            audible: false,
            discarded: false,
            muted: false,
            pinned: false,
            lastAccessed: 1_754_700_000_000,
            firstSeenAt: "2026-08-09T00:00:00.000Z",
            lastSeenAt: "2026-08-09T00:01:00.000Z",
            status: "inbox",
            importance: 0,
            summary: null,
            tagPaths: [],
            duplicateGroupSize: 2,
          },
        ],
        total: 459,
        page: 2,
        pageSize: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOpenTabs({
      browser: "chrome",
      duplicatesOnly: true,
      page: 2,
      q: "exact copy",
    });

    expect(result.total).toBe(459);
    expect(result.items[0]?.instanceId).toBe(101);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tab-instances?page=2&pageSize=50&browser=chrome&duplicates_only=true&q=exact+copy",
    );
  });

  it("rejects an unreadable physical occurrence payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [] })));

    await expect(
      fetchOpenTabs({
        browser: "all",
        duplicatesOnly: false,
        page: 1,
        q: "",
      }),
    ).rejects.toThrow("unexpected open-tab list");
  });

  it("loads exact duplicate groups with an optional browser scope", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            installationId: "chrome-main",
            browser: "chrome",
            url: "https://example.com/exact",
            count: 3,
            keeperInstanceId: 101,
            candidateInstanceIds: [102],
            protectedInstanceIds: [103],
            instances: [instance(101, true), instance(102), instance(103)],
          },
        ],
        totalGroups: 1,
        totalTabsInGroups: 3,
        totalDuplicateCopies: 2,
        totalCloseCandidates: 1,
        totalProtected: 1,
        page: 1,
        pageSize: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDuplicateGroups({ browser: "chrome", page: 1 });

    expect(result.totalDuplicateCopies).toBe(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/duplicate-groups?page=1&pageSize=50&browser=chrome",
    );
  });
});
