import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAllLibraryTabIds, fetchTabs } from "../src/api";

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
        importance: 2,
        openState: "open",
        q: "research",
        status: "in_progress",
        tag: "Work/AI",
      }),
    ).resolves.toEqual(ids);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tabs/bulk-ids?browser=chrome&is_open=true&status=in_progress&importance=2&q=research&tag=Work%2FAI",
    );
  });
});

describe("Library activity API", () => {
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
