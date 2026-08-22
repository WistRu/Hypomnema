import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enqueueShortSummary,
  enqueueSummary,
  fetchAllLibraryTabIds,
  fetchLibraryOpenTabs,
  fetchTabs,
  resetLocalSessionBootstrapForTests,
} from "../src/api";

afterEach(() => {
  resetLocalSessionBootstrapForTests();
  vi.unstubAllGlobals();
});

describe("Library bulk selection API", () => {
  it("posts a revision-bound page summary while preserving the legacy short-summary body", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ jobId: 31, sourceContentRevision: 9, status: "queued" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await enqueueSummary(7, { depth: "deep", expectedContentRevision: 9 });
    await enqueueShortSummary(7);

    expect(fetchMock.mock.calls.map(([url, init]) => ({
      body: init?.body,
      method: init?.method,
      url,
    }))).toEqual([
      {
        body: JSON.stringify({ depth: "deep", expectedContentRevision: 9 }),
        method: "POST",
        url: "/api/tabs/7/summarize",
      },
      {
        body: JSON.stringify({ depth: "short" }),
        method: "POST",
        url: "/api/tabs/7/summarize",
      },
    ]);
  });

  it("loads every filtered canonical ID in one request without truncation", async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => index + 1);
    const fetchMock = vi.fn(async () => Response.json({ ids, logicalPageCount: ids.length }));
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

  it("composes the resource facet with canonical, physical, pagination, and sorting filters", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [], page: 3, pageSize: 50, total: 0 }))
      .mockResolvedValueOnce(Response.json({ ids: [], logicalPageCount: 0 }))
      .mockResolvedValueOnce(Response.json({
        items: [], total: 0, logicalPageCount: 0,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = {
      browser: "chrome",
      duplicatesOnly: false,
      importance: 3 as const,
      openState: "open" as const,
      q: "agent",
      resourceId: 19,
      status: "in_progress" as const,
      tag: "Work/AI",
    };

    await fetchTabs({ ...filters, page: 3, sortBy: "activity", sortDirection: "desc" });
    await fetchAllLibraryTabIds(filters);
    await fetchLibraryOpenTabs(filters);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/tabs?page=3&pageSize=50&sort_by=activity&sort_direction=desc&browser=chrome&is_open=true&status=in_progress&importance=3&q=agent&tag=Work%2FAI&resource_id=19",
      "/api/tabs/bulk-ids?browser=chrome&is_open=true&status=in_progress&importance=3&q=agent&tag=Work%2FAI&resource_id=19",
      "/api/tab-instances/library-bulk?browser=chrome&is_open=true&status=in_progress&importance=3&q=agent&tag=Work%2FAI&resource_id=19",
    ]);
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
      instanceRevision: 1,
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
      Response.json({ items: [item], total: 1, logicalPageCount: 1 }),
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

  it("uses the protected local companions for context-aware IDs and physical instances", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ids: [17], logicalPageCount: 1 }))
      .mockResolvedValueOnce(Response.json({
        items: [], total: 0, logicalPageCount: 0,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = {
      browser: "all" as const,
      importance: "all" as const,
      openState: "all" as const,
      q: "private context marker",
      status: "all" as const,
      tag: "",
    };

    await expect(
      fetchAllLibraryTabIds(filters, undefined, "local"),
    ).resolves.toEqual([17]);
    await expect(
      fetchLibraryOpenTabs(filters, undefined, "local"),
    ).resolves.toEqual([]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/local/session/bootstrap",
      "/api/local/tabs/bulk-ids?q=private+context+marker",
      "/api/local/tab-instances/library-bulk?q=private+context+marker",
    ]);
  });
});

describe("Library activity API", () => {
  it("loads context-aware Library rows through the protected local seam", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ items: [], page: 1, pageSize: 50, total: 0 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchTabs(
      {
        browser: "all",
        importance: "all",
        openState: "all",
        page: 1,
        q: "personal marker",
        status: "all",
        tag: "",
      },
      undefined,
      "local",
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/local/session/bootstrap",
      "/api/local/tabs?page=1&pageSize=50&q=personal+marker",
    ]);
  });

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

  it("preserves lifetime page activity separately from current-copy activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              id: 17,
              logicalPageId: 501,
              browser: "chrome",
              closedAt: null,
              faviconUrl: null,
              firstSeenAt: "2026-08-10T00:00:00.000Z",
              importance: 0,
              index: 0,
              isOpen: true,
              lastSeenAt: "2026-08-10T00:01:00.000Z",
              engagedTimeMs: 45_000,
              foregroundTimeMs: 125_000,
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
      engagedTimeMs: 45_000,
      foregroundTimeMs: 125_000,
      openEngagedTimeMs: 12_000,
      openForegroundTimeMs: 61_000,
      openInstanceCount: 2,
    });
  });
});
