import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const SORT_ROWS = [
  {
    browser: "chrome",
    browserSessionId: "11111111-1111-4111-8111-111111111111",
    browserTabId: 11,
    firstSeenAt: "2026-08-01T10:00:00.000Z",
    foregroundMs: 1_000,
    importance: 1,
    installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "done",
    title: "Zulu",
    topic: "Gamma",
    url: "https://example.com/zulu",
  },
  {
    browser: "yandex",
    browserSessionId: "22222222-2222-4222-8222-222222222222",
    browserTabId: 22,
    firstSeenAt: "2026-08-04T10:00:00.000Z",
    foregroundMs: 2_000,
    importance: 3,
    installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "inbox",
    title: "alpha",
    topic: "Alpha",
    url: "https://example.com/alpha",
  },
  {
    browser: "edge",
    browserSessionId: "33333333-3333-4333-8333-333333333333",
    browserTabId: 33,
    firstSeenAt: "2026-08-03T10:00:00.000Z",
    foregroundMs: 5_000,
    importance: 0,
    installationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "archived",
    title: null,
    topic: null,
    url: "https://example.com/charlie",
  },
  {
    browser: "other",
    browserSessionId: "44444444-4444-4444-8444-444444444444",
    browserTabId: 44,
    firstSeenAt: "2026-08-02T10:00:00.000Z",
    foregroundMs: 3_000,
    importance: 2,
    installationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    status: "in_progress",
    title: "Beta",
    topic: "Beta",
    url: "https://example.com/beta",
  },
] as const;

describe("Library tab sorting", () => {
  it("sorts the full filtered collection before applying pagination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tab-sorting-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: ["Delta", "Alpha", "Charlie"].map((title, index) => ({
            url: `https://example.com/${title.toLowerCase()}`,
            title,
            windowId: 1,
            index,
          })),
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=title&sort_direction=asc&page=2&pageSize=1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [{ title: "Charlie" }],
        page: 2,
        pageSize: 1,
        total: 3,
      });

      const descending = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=title&sort_direction=desc&page=3&pageSize=1",
      });
      expect(descending.statusCode).toBe(200);
      expect(descending.json()).toMatchObject({
        items: [{ title: "Alpha" }],
        page: 3,
        pageSize: 1,
        total: 3,
      });

      for (const url of [
        "/api/tabs?sort_by=unsupported",
        "/api/tabs?sort_by=title&sort_direction=sideways",
        "/api/tabs?sort_direction=desc",
        "/api/tabs?search_mode=semantic&q=alpha&sort_by=title",
        "/api/tabs?similar_to=1&sort_by=title",
      ]) {
        const invalid = await app.inject({ method: "GET", url });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sorts lifetime activity across closed pages before pagination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-sorting-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    const installationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const browserSessionId = "55555555-5555-4555-8555-555555555555";
    const rows = [
      { browserTabId: 1, foregroundMs: 1_000, slug: "least" },
      { browserTabId: 2, foregroundMs: 3_000, slug: "most" },
      { browserTabId: 3, foregroundMs: 2_000, slug: "middle" },
    ] as const;

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          browserSessionId,
          tabs: rows.map((row, index) => ({
            tabId: row.browserTabId,
            url: `https://example.com/${row.slug}`,
            title: row.slug,
            windowId: 1,
            index,
          })),
        },
      });

      for (const [index, row] of rows.entries()) {
        const activity = await app.inject({
          method: "POST",
          url: "/api/ingest/activity",
          payload: {
            id: `${String(index + 1).padStart(8, "0")}-6666-4666-8666-666666666666`,
            browser: "chrome",
            installationId,
            browserSessionId,
            browserTabId: row.browserTabId,
            sequence: index + 1,
            url: `https://example.com/${row.slug}`,
            startedAt: "2026-08-05T10:00:00.000Z",
            endedAt: "2026-08-05T10:00:10.000Z",
            foregroundMs: row.foregroundMs,
            engagedMs: Math.floor(row.foregroundMs / 2),
          },
        });
        expect(activity.statusCode).toBe(200);
      }

      const closeMiddle = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          browserSessionId,
          tabs: rows
            .filter(({ slug }) => slug !== "middle")
            .map((row, index) => ({
              tabId: row.browserTabId,
              url: `https://example.com/${row.slug}`,
              title: row.slug,
              windowId: 1,
              index,
            })),
        },
      });
      expect(closeMiddle.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=activity&sort_direction=desc&page=2&pageSize=1",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [
          {
            title: "middle",
            foregroundTimeMs: 2_000,
            engagedTimeMs: 1_000,
            isOpen: false,
          },
        ],
        page: 2,
        pageSize: 1,
        total: 3,
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sorts every visible data column using its user-facing meaning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-column-sorting-"));
    let now = new Date("2026-08-01T10:00:00.000Z");
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => now,
    });

    try {
      for (const row of SORT_ROWS) {
        now = new Date(row.firstSeenAt);
        const snapshot = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: row.browser,
            installationId: row.installationId,
            browserSessionId: row.browserSessionId,
            tabs: [
              {
                tabId: row.browserTabId,
                url: row.url,
                ...(row.title === null ? {} : { title: row.title }),
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        expect(snapshot.statusCode).toBe(200);

        const activity = await app.inject({
          method: "POST",
          url: "/api/ingest/activity",
          payload: {
            id: `${String(row.browserTabId).padStart(8, "0")}-5555-4555-8555-555555555555`,
            browser: row.browser,
            installationId: row.installationId,
            browserSessionId: row.browserSessionId,
            browserTabId: row.browserTabId,
            sequence: 1,
            url: row.url,
            startedAt: "2026-08-05T10:00:00.000Z",
            endedAt: "2026-08-05T10:00:10.000Z",
            foregroundMs: row.foregroundMs,
            engagedMs: Math.floor(row.foregroundMs / 2),
          },
        });
        expect(activity.statusCode).toBe(200);
      }

      const unsorted = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const idsByBrowser = new Map<string, number>(
        unsorted
          .json()
          .items.map((item: { browser: string; id: number }) => [
            item.browser,
            item.id,
          ]),
      );

      for (const row of SORT_ROWS) {
        const id = idsByBrowser.get(row.browser);
        if (id === undefined) throw new Error(`Missing ${row.browser} tab`);
        const patched = await app.inject({
          method: "PATCH",
          url: `/api/tabs/${id}`,
          payload: { importance: row.importance, status: row.status },
        });
        expect(patched.statusCode).toBe(200);

        if (row.topic !== null) {
          const assigned = await app.inject({
            method: "POST",
            url: "/api/tags/assign",
            payload: {
              ids: [id],
              tagPath: row.topic,
              assignedBy: "user",
            },
          });
          expect(assigned.statusCode).toBe(200);
        }
      }

      const closed = SORT_ROWS[1];
      const closeResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: closed.browser,
          installationId: closed.installationId,
          browserSessionId: closed.browserSessionId,
          tabs: [],
        },
      });
      expect(closeResponse.statusCode).toBe(200);

      const expectations = [
        ["title", "asc", ["yandex", "other", "edge", "chrome"]],
        ["topics", "asc", ["yandex", "other", "chrome", "edge"]],
        ["browser", "asc", ["chrome", "edge", "yandex", "other"]],
        ["browser", "desc", ["yandex", "edge", "chrome", "other"]],
        ["activity", "desc", ["edge", "other", "yandex", "chrome"]],
        ["status", "asc", ["yandex", "other", "chrome", "edge"]],
        ["importance", "desc", ["yandex", "other", "chrome", "edge"]],
        ["state", "desc", ["chrome", "edge", "other", "yandex"]],
        ["age", "asc", ["yandex", "edge", "other", "chrome"]],
      ] as const;

      for (const [sortBy, direction, expectedBrowsers] of expectations) {
        const response = await app.inject({
          method: "GET",
          url: `/api/tabs?sort_by=${sortBy}&sort_direction=${direction}&pageSize=10`,
        });
        expect(response.statusCode, sortBy).toBe(200);
        expect(
          response
            .json()
            .items.map((item: { browser: string }) => item.browser),
          sortBy,
        ).toEqual(expectedBrowsers);
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sorts the visible fallback label and Russian text without case groups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-text-sorting-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    const rows = [
      { url: "http://z.example/path", title: null, topic: "Zoo" },
      { url: "https://a.example/path", title: null, topic: "Alpha" },
      { url: "https://example.com/apple", title: "Яблоко", topic: "Яблоко" },
      { url: "https://example.com/melon", title: "арбуз", topic: "арбуз" },
      { url: "https://example.com/banana", title: "Банан", topic: "Банан" },
      { url: "https://example.com/fir", title: "ёж", topic: "ёж" },
    ] as const;

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: rows.map((row, index) => ({
            url: row.url,
            ...(row.title === null ? {} : { title: row.title }),
            windowId: 1,
            index,
          })),
        },
      });

      const listed = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=20",
      });
      const idsByUrl = new Map<string, number>(
        listed
          .json()
          .items.map((item: { id: number; url: string }) => [item.url, item.id]),
      );
      for (const row of rows) {
        const id = idsByUrl.get(row.url);
        if (id === undefined) throw new Error(`Missing ${row.url}`);
        await app.inject({
          method: "POST",
          url: "/api/tags/assign",
          payload: { ids: [id], tagPath: row.topic, assignedBy: "user" },
        });
      }

      const visibleLabel = (item: { title: string | null; url: string }) =>
        item.title?.trim() || new URL(item.url).hostname.replace(/^www\./, "");
      const expected = ["a.example", "z.example", "арбуз", "Банан", "ёж", "Яблоко"];

      const byTitle = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=title&sort_direction=asc&pageSize=20",
      });
      expect(byTitle.statusCode).toBe(200);
      expect(byTitle.json().items.map(visibleLabel)).toEqual(expected);

      const byTopic = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=topics&sort_direction=asc&pageSize=20",
      });
      expect(byTopic.statusCode).toBe(200);
      expect(byTopic.json().items.map(visibleLabel)).toEqual(expected);

      const multiTopicId = idsByUrl.get("https://example.com/apple");
      if (multiTopicId === undefined) throw new Error("Missing multi-topic tab");
      await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [multiTopicId],
          tagPath: "арбуз",
          assignedBy: "user",
        },
      });
      const multiTopicSort = await app.inject({
        method: "GET",
        url: "/api/tabs?sort_by=topics&sort_direction=asc&pageSize=20",
      });
      const multiTopicRow = multiTopicSort
        .json()
        .items.find((item: { title: string | null }) => item.title === "Яблоко");
      expect(multiTopicRow.tagPaths).toEqual(["арбуз", "Яблоко"]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
