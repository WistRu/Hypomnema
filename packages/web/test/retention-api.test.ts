import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRetentionReview,
  fetchRetentionTrash,
  forgetRetentionTab,
  restoreRetentionTab,
  setRetentionDecision,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page retention API", () => {
  it("loads the personalized review queue and trash with pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ items: [], page: 2, pageSize: 50, total: 0 }),
      )
      .mockResolvedValueOnce(
        Response.json({ items: [], page: 3, pageSize: 50, total: 0 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRetentionReview(2)).resolves.toMatchObject({ page: 2 });
    await expect(fetchRetentionTrash(3)).resolves.toMatchObject({ page: 3 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/retention/review?page=2&pageSize=50",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/retention/trash?page=3&pageSize=50",
    );
  });

  it("records explicit keep and later decisions", async () => {
    const response = {
      tabId: 17,
      decision: "keep",
      state: "kept",
      decidedBy: "user",
      decidedAt: "2026-08-12T10:00:00.000Z",
      reviewAfter: null,
      trashedAt: null,
      purgeAt: null,
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setRetentionDecision(17, "keep")).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/retention/tabs/17");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ decision: "keep", decidedBy: "user" }),
    });
  });

  it("requires the dedicated confirmed operation to close and forget a page", async () => {
    const response = {
      tabId: 17,
      outcome: "trashed",
      reason: null,
      closedInstanceCount: 2,
      purgeAt: "2026-08-19T10:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(forgetRetentionTab(17)).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/retention/tabs/17/forget",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ decidedBy: "user", confirmed: true }),
    });
  });

  it("restores a page from the reversible trash", async () => {
    const response = {
      tabId: 17,
      decision: "keep",
      state: "kept",
      decidedBy: "user",
      decidedAt: "2026-08-12T10:00:00.000Z",
      reviewAfter: null,
      trashedAt: null,
      purgeAt: null,
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restoreRetentionTab(17)).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/retention/trash/17/restore",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ decidedBy: "user" }),
    });
  });
});
