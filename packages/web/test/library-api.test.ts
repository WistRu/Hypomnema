import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAllLibraryTabIds,
  fetchLibraryOpenTabs,
  fetchTabs,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Library bulk selection API", () => {
  it("loads every filtered canonical ID in one request without truncation", async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => index + 1);
    const fetchMock = vi.fn(async () => Response.json({ ids }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllLibraryTabIds({
        browser: "chrome",
        duplicatesOnly: true,
        importance: 2,
        openState: "open",
        q: "research",
        status: "in_progress",
        tag: "Work/AI",
      }),
    ).resolves.toEqual(ids);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tabs/bulk-ids?browser=chrome&duplicates_only=true&is_open=true&status=in_progress&importance=2&q=research&tag=Work%2FAI",
    );
  });

  it("loads every physical instance through the same canonical Library filter", async () => {
    const item = {
      active: false,
      audible: false,
      browser: "chrome",
      browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
      browserTabId: 42,
      canonicalTabId: 17,
      discarded: false,
      duplicateGroupSize: 2,
      engagedTimeMs: 0,
      faviconUrl: null,
      firstSeenAt: "2026-08-10T00:00:00.000Z",
      foregroundTimeMs: 0,
      importance: 2,
      index: 0,
      installationId: "223e4567-e89b-42d3-a456-426614174000",
      instanceId: 9,
      lastAccessed: null,
      lastSeenAt: "2026-08-10T00:01:00.000Z",
      muted: false,
      pinned: false,
      status: "in_progress",
      summary: null,
      tagPaths: ["Work/AI"],
      title: "Research",
      url: "https://example.com/research",
      urlNormalized: "https://example.com/research",
      windowId: 1,
    };
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [item], total: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLibraryOpenTabs({
        browser: "chrome",
        duplicatesOnly: true,
        importance: 2,
        openState: "open",
        q: "research",
        status: "in_progress",
        tag: "Work/AI",
      }),
    ).resolves.toEqual([item]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tab-instances/library-bulk?browser=chrome&duplicates_only=true&is_open=true&status=in_progress&importance=2&q=research&tag=Work%2FAI",
    );
  });
});

describe("Library activity API", () => {
  it("serializes an active server-side Library sort", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], page: 1, pageSize: 50, total: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchTabs({
      browser: "all",
      importance: "all",
      openState: "all",
      page: 1,
      q: "",
      sortBy: "title",
      sortDirection: "desc",
      status: "all",
      tag: "",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tabs?page=1&pageSize=50&sort_by=title&sort_direction=desc",
    );
  });

  it("serializes the canonical duplicate filter for paginated Library rows", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [], page: 2, pageSize: 50, total: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchTabs({
      browser: "all",
      duplicatesOnly: true,
      importance: "all",
      openState: "all",
      page: 2,
      q: "",
      status: "all",
      tag: "",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tabs?page=2&pageSize=50&duplicates_only=true",
    );
  });

  it("preserves the current-copy activity aggregate returned by the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              id: 17,
              browser: "chrome",
              closedAt: null,
              faviconUrl: null,
              firstSeenAt: "2026-08-10T00:00:00.000Z",
              importance: 0,
              index: 0,
              isOpen: true,
              lastSeenAt: "2026-08-10T00:01:00.000Z",
              openEngagedTimeMs: 12_000,
              openForegroundTimeMs: 61_000,
              openInstanceCount: 2,
              status: "inbox",
              summary: null,
              tagPaths: [],
              title: "Tracked tab",
              url: "https://example.com/tracked",
              urlNormalized: "https://example.com/tracked",
              windowId: 1,
            },
          ],
          page: 1,
          pageSize: 50,
          total: 1,
        }),
      ),
    );

    const response = await fetchTabs({
      browser: "all",
      importance: "all",
      openState: "all",
      page: 1,
      q: "",
      status: "all",
      tag: "",
    });

    expect(response.items[0]).toMatchObject({
      openEngagedTimeMs: 12_000,
      openForegroundTimeMs: 61_000,
      openInstanceCount: 2,
    });
  });
});
