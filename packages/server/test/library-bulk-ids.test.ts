import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("Library bulk ID selection", () => {
  it("returns and mutates every filtered canonical tab without a page ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-library-bulk-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabCount = 1_001;
      const chromeSnapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: Array.from({ length: tabCount }, (_, index) => ({
            index,
            title: `Chrome ${index + 1}`,
            url: `https://chrome.example/${index + 1}`,
            windowId: 1,
          })),
        },
      });
      expect(chromeSnapshot.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              index: 0,
              title: "Excluded Edge tab",
              url: "https://edge.example/excluded",
              windowId: 1,
            },
          ],
        },
      });

      const selected = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?browser=chrome&status=inbox&importance=0&is_open=true",
      });

      expect(selected.statusCode).toBe(200);
      expect(selected.json().ids).toHaveLength(tabCount);
      expect(new Set(selected.json().ids).size).toBe(tabCount);

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids: selected.json().ids, status: "done" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ status: "done", updated: tabCount });

      const filteredAfterMutation = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?browser=chrome&status=done",
      });
      expect(filteredAfterMutation.json().ids).toEqual(selected.json().ids);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("filters canonical pages with multiple open physical copies before pagination and bulk selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-library-duplicates-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const snapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "123e4567-e89b-42d3-a456-426614174000",
          tabs: [
            {
              tabId: 101,
              title: "Alpha first copy",
              url: "https://example.com/alpha?utm_source=first",
              windowId: 1,
              index: 0,
            },
            {
              tabId: 102,
              title: "Alpha second copy",
              url: "https://example.com/alpha?utm_source=second",
              windowId: 1,
              index: 1,
            },
            {
              tabId: 201,
              title: "Beta first copy",
              url: "https://example.com/beta?utm_campaign=first",
              windowId: 2,
              index: 0,
            },
            {
              tabId: 202,
              title: "Beta second copy",
              url: "https://example.com/beta?utm_campaign=second",
              windowId: 2,
              index: 1,
            },
            {
              tabId: 301,
              title: "Unique page",
              url: "https://example.com/unique",
              windowId: 2,
              index: 2,
            },
          ],
        },
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toEqual({ upserted: 3, closed: 0 });

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/tabs?duplicates_only=true&page=1&pageSize=1",
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toMatchObject({
        total: 2,
        page: 1,
        pageSize: 1,
        items: [
          expect.objectContaining({
            isOpen: true,
            openInstanceCount: 2,
          }),
        ],
      });

      const duplicateIds = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?duplicates_only=true",
      });
      expect(duplicateIds.statusCode).toBe(200);
      expect(duplicateIds.json().ids).toHaveLength(2);
      expect(duplicateIds.json().ids).toContain(firstPage.json().items[0].id);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resolves every physical instance for an unbounded canonical Library filter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-library-instances-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabCount = 1_001;
      const snapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "223e4567-e89b-42d3-a456-426614174000",
          tabs: Array.from({ length: tabCount }, (_, index) => ({
            tabId: index + 1,
            title: `Library instance ${index + 1}`,
            url: `https://library.example/${index + 1}`,
            windowId: Math.floor(index / 100),
            index: index % 100,
          })),
        },
      });
      expect(snapshot.statusCode).toBe(200);

      const canonical = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?browser=chrome",
      });
      expect(canonical.statusCode).toBe(200);
      expect(canonical.json().ids).toHaveLength(tabCount);
      const excludedCanonicalId = canonical.json().ids[0] as number;

      const markDone = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids: [excludedCanonicalId], status: "done" },
      });
      expect(markDone.statusCode).toBe(200);

      const instances = await app.inject({
        method: "GET",
        url: "/api/tab-instances/library-bulk?browser=chrome&is_open=true&status=inbox&importance=0",
      });
      expect(instances.statusCode).toBe(200);
      expect(instances.json().total).toBe(1_000);
      expect(instances.json().items).toHaveLength(1_000);
      expect(
        new Set(
          instances
            .json()
            .items.map((item: { canonicalTabId: number }) => item.canonicalTabId),
        ).size,
      ).toBe(1_000);
      expect(
        instances
          .json()
          .items.some(
            (item: { canonicalTabId: number }) =>
              item.canonicalTabId === excludedCanonicalId,
          ),
      ).toBe(false);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);
});
