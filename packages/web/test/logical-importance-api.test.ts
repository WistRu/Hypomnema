import type { LogicalPageView } from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchFeatureFlags,
  fetchLogicalPageByTabId,
  patchTabDetails,
  setUserImportance,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const logicalPageView: LogicalPageView = {
  page: {
    id: 41,
    identityKey: "https://example.com/research",
    urlNormalized: "https://example.com/research",
    representativeUrl: "https://example.com/research",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  },
  preference: {
    logicalPageId: 41,
    userImportance: null,
    recordedBy: null,
    recordMethod: null,
    importanceUpdatedAt: null,
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  legacyImportanceAudit: {
    logicalPageId: 41,
    legacyValues: [
      { tabId: 17, browser: "chrome", value: 2 },
      { tabId: 23, browser: "edge", value: 2 },
    ],
    suggestedValue: 2,
    resolutionState: "legacy_unknown",
    createdAt: "2026-08-10T10:00:00.000Z",
    reviewedAt: null,
  },
  browserPages: [
    {
      tabId: 17,
      logicalPageId: 41,
      browser: "chrome",
      url: "https://example.com/research",
      urlNormalized: "https://example.com/research",
    },
  ],
};

describe("logical importance API", () => {
  it("loads and validates the runtime feature contract", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ context: false, logicalImportance: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFeatureFlags()).resolves.toEqual({
      context: false,
      logicalImportance: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/features");
  });

  it("loads and validates the logical page for the selected browser page", async () => {
    const fetchMock = vi.fn(async () => Response.json(logicalPageView));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLogicalPageByTabId(17)).resolves.toEqual(logicalPageView);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/logical-pages/by-tab/17");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: "application/json" },
    });
  });

  it("writes only IDs and the explicit user value through the trusted route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ updated: 2, importance: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(setUserImportance([17, 23], 3)).resolves.toEqual({
      updated: 2,
      importance: 3,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tabs/importance");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ ids: [17, 23], importance: 3 }),
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "body",
      expect.stringContaining("recordedBy"),
    );
  });

  it("clears canonical importance through the same trusted user route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ updated: 1, importance: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(setUserImportance([17], 0)).resolves.toEqual({
      updated: 1,
      importance: 0,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tabs/importance");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ ids: [17], importance: 0 }),
    });
  });

  it("preserves the G0 scalar patch route for feature-off importance", async () => {
    const tab = {
      id: 17,
      logicalPageId: 41,
      browser: "chrome",
      closedAt: null,
      content: null,
      customFields: {},
      engagedTimeMs: 0,
      faviconUrl: null,
      firstSeenAt: "2026-08-10T10:00:00.000Z",
      foregroundTimeMs: 0,
      importance: 2,
      index: 0,
      isOpen: true,
      lastSeenAt: "2026-08-12T10:00:00.000Z",
      links: [],
      openEngagedTimeMs: 0,
      openForegroundTimeMs: 0,
      openInstanceCount: 1,
      status: "inbox",
      summary: null,
      tagPaths: [],
      tags: [],
      title: "Legacy page",
      url: "https://example.com/legacy",
      urlNormalized: "https://example.com/legacy",
      windowId: 1,
    };
    const fetchMock = vi.fn(async () => Response.json(tab));
    vi.stubGlobal("fetch", fetchMock);

    await expect(patchTabDetails(17, { importance: 2 })).resolves.toEqual(tab);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tabs/17");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ importance: 2 }),
    });
  });

  it("rejects malformed feature data instead of guessing a mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ logicalImportance: "false" })),
    );

    await expect(fetchFeatureFlags()).rejects.toThrow(
      "TabHub returned unexpected feature settings.",
    );
  });

  it("rejects malformed logical-page data instead of rendering guessed provenance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...logicalPageView, preference: { userImportance: 2 } }),
      ),
    );

    await expect(fetchLogicalPageByTabId(17)).rejects.toThrow(
      "TabHub returned unexpected logical page details.",
    );
  });
});
