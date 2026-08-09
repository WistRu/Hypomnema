import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAllLibraryTabIds } from "../src/api";

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
