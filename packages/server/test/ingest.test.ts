import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("tab snapshot ingestion", () => {
  it("keeps the same URL from different browsers as separate tabs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ingest-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      for (const browser of ["chrome", "edge", "yandex"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser,
            tabs: [
              {
                url: "https://example.com/article",
                title: `${browser} article`,
                windowId: 1,
                index: 0,
              },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
      }

      const response = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=50",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        total: 3,
        page: 1,
        pageSize: 50,
        items: [
          { browser: "yandex", url: "https://example.com/article" },
          { browser: "edge", url: "https://example.com/article" },
          { browser: "chrome", url: "https://example.com/article" },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates normalized URLs and retains tabs missing from a later snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-deduplicate-"));
    let now = new Date("2026-08-08T18:00:00.000Z");
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => now,
    });

    try {
      const firstResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/read?utm_source=mail",
              title: "First title",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/closed-later",
              title: "Close me",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });

      expect(firstResponse.json()).toEqual({ upserted: 2, closed: 0 });

      now = new Date("2026-08-08T18:05:00.000Z");

      const secondResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/read",
              title: "Updated title",
              windowId: 2,
              index: 3,
            },
          ],
        },
      });

      expect(secondResponse.json()).toEqual({ upserted: 1, closed: 1 });

      const response = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });
      const body = response.json();

      expect(body.total).toBe(2);
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            urlNormalized: "https://example.com/read",
            title: "Updated title",
            isOpen: true,
            firstSeenAt: "2026-08-08T18:00:00.000Z",
            lastSeenAt: "2026-08-08T18:05:00.000Z",
            closedAt: null,
          }),
          expect.objectContaining({
            urlNormalized: "https://example.com/closed-later",
            isOpen: false,
            closedAt: "2026-08-08T18:05:00.000Z",
          }),
        ]),
      );

      const closedOnly = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&is_open=false",
      });

      expect(closedOnly.json()).toMatchObject({
        total: 1,
        items: [
          {
            urlNormalized: "https://example.com/closed-later",
            isOpen: false,
          },
        ],
      });

      now = new Date("2026-08-08T18:10:00.000Z");
      const reopenResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/read",
              title: "Updated title",
              windowId: 2,
              index: 3,
            },
            {
              url: "https://example.com/closed-later",
              title: "Open again",
              windowId: 2,
              index: 4,
            },
          ],
        },
      });

      expect(reopenResponse.json()).toEqual({ upserted: 2, closed: 0 });

      const reopenedList = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&is_open=true",
      });
      expect(reopenedList.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            urlNormalized: "https://example.com/closed-later",
            isOpen: true,
            firstSeenAt: "2026-08-08T18:00:00.000Z",
            lastSeenAt: "2026-08-08T18:10:00.000Z",
            closedAt: null,
          }),
        ]),
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collapses duplicate normalized URLs inside one snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-snapshot-duplicates-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const ingestResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "yandex",
          tabs: [
            {
              url: "https://example.com/topic?utm_medium=social#first",
              title: "Older duplicate",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/topic#first",
              title: "Latest duplicate",
              windowId: 2,
              index: 4,
            },
          ],
        },
      });

      expect(ingestResponse.json()).toEqual({ upserted: 1, closed: 0 });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=yandex",
      });

      expect(listResponse.json()).toMatchObject({
        total: 1,
        items: [
          {
            title: "Latest duplicate",
            urlNormalized: "https://example.com/topic#first",
          },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps different URL fragments as separate Library records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-fragment-pages-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const ingestResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: ["inbox/message-one", "inbox/message-two"].map(
            (fragment, index) => ({
              url: `https://mail.example.com/#${fragment}`,
              title: `Message ${index + 1}`,
              windowId: 1,
              index,
            }),
          ),
        },
      });
      expect(ingestResponse.json()).toEqual({ upserted: 2, closed: 0 });

      const library = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome",
      });
      expect(library.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            urlNormalized: "https://mail.example.com/#inbox/message-one",
          }),
          expect.objectContaining({
            urlNormalized: "https://mail.example.com/#inbox/message-two",
          }),
        ]),
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the exact invalid URL in a snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-invalid-url-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/valid",
              windowId: 1,
              index: 0,
            },
            {
              url: "this is not a URL",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "VALIDATION_ERROR",
        issues: [
          {
            path: ["tabs", 1, "url"],
          },
        ],
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/tabs",
      });
      expect(listResponse.json().total).toBe(0);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "accepts a full 10,000-tab browser snapshot",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-large-snapshot-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: Array.from({ length: 10_000 }, (_, index) => ({
              url: `https://example.com/tabs/${index}?utm_source=boundary-test`,
              title: `Boundary tab ${index}`,
              windowId: Math.floor(index / 100),
              index: index % 100,
            })),
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ upserted: 10_000, closed: 0 });

        const listResponse = await app.inject({
          method: "GET",
          url: "/api/tabs?pageSize=1",
        });
        expect(listResponse.json()).toMatchObject({ total: 10_000 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
