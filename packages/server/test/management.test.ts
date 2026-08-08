import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("tab management REST behavior", () => {
  it("updates status and returns complete tab details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-management-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-08T20:00:00.000Z"),
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/managed",
              title: "Managed tab",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://example.com/managed",
          text: "Detailed managed content",
          htmlExcerpt: "<article>Detailed managed content</article>",
        },
      });
      const list = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = list.json().items[0].id as number;

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${tabId}`,
        payload: { status: "done" },
      });

      expect(patchResponse.statusCode).toBe(200);
      expect(patchResponse.json()).toMatchObject({
        id: tabId,
        title: "Managed tab",
        status: "done",
        importance: 0,
        content: { text: "Detailed managed content" },
        tags: [],
        links: [],
        customFields: {},
      });

      const detailResponse = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        id: tabId,
        title: "Managed tab",
        status: "done",
        content: {
          text: "Detailed managed content",
          htmlExcerpt: "<article>Detailed managed content</article>",
          summary: null,
          extractedAt: "2026-08-08T20:00:00.000Z",
        },
        tags: [],
        links: [],
        customFields: {},
      });

      const missingBulk = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids: [tabId, 999_999], status: "archived" },
      });
      expect(missingBulk.statusCode).toBe(404);
      const afterFailedBulk = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(afterFailedBulk.json().status).toBe("done");

      const bulk = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids: [tabId], status: "archived" },
      });
      expect(bulk.statusCode).toBe(200);
      expect(bulk.json()).toEqual({ updated: 1, status: "archived" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("patches importance and custom fields and deletes null-valued fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tab-patch-"));
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
          tabs: [
            {
              url: "https://example.com/patch-fields",
              title: "Patch fields",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const list = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = list.json().items[0].id as number;

      const initialPatch = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${tabId}`,
        payload: {
          status: "in_progress",
          importance: 3,
          customFields: {
            " owner ": "alice",
            obsolete: "remove me",
          },
        },
      });

      expect(initialPatch.statusCode).toBe(200);
      expect(initialPatch.json()).toMatchObject({
        id: tabId,
        status: "in_progress",
        importance: 3,
        customFields: { owner: "alice", obsolete: "remove me" },
      });

      const deletionPatch = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${tabId}`,
        payload: {
          customFields: { owner: null, " reviewed ": "yes" },
        },
      });
      expect(deletionPatch.statusCode).toBe(200);
      expect(deletionPatch.json()).toMatchObject({
        status: "in_progress",
        importance: 3,
        customFields: { obsolete: "remove me", reviewed: "yes" },
      });
      expect(deletionPatch.json().customFields).not.toHaveProperty("owner");

      const empty = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${tabId}`,
        payload: {},
      });
      expect(empty.statusCode).toBe(400);

      const blankKey = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${tabId}`,
        payload: { customFields: { "   ": "invalid" } },
      });
      expect(blankKey.statusCode).toBe(400);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("updates importance in bulk without partially updating missing ID sets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-importance-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              url: "https://example.com/important-one",
              title: "Important one",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/important-two",
              title: "Important two",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });
      const list = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const ids = (list.json().items as Array<{ id: number }>).map(
        ({ id }) => id,
      );

      const missing = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[0], 999_999], importance: 3 },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: "TAB_NOT_FOUND",
        missingIds: [999_999],
      });
      const afterFailure = await app.inject({
        method: "GET",
        url: `/api/tabs/${ids[0]}`,
      });
      expect(afterFailure.json().importance).toBe(0);

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids, importance: 2 },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ updated: 2, importance: 2 });

      const filtered = await app.inject({
        method: "GET",
        url: "/api/tabs?importance=2&pageSize=10",
      });
      expect(filtered.json()).toMatchObject({ total: 2 });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates hierarchical tags, assigns them atomically, and returns a counted tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tags-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-08T20:00:00.000Z"),
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/one",
              title: "One",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/two",
              title: "Two",
              windowId: 1,
              index: 1,
            },
            {
              url: "https://example.com/untagged",
              title: "Untagged",
              windowId: 1,
              index: 2,
            },
          ],
        },
      });
      const list = await app.inject({ method: "GET", url: "/api/tabs" });
      const ids = (
        list.json().items as Array<{ id: number; title: string | null }>
      )
        .filter(({ title }) => title !== "Untagged")
        .map(({ id }) => id);

      const assign = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids,
          tagPath: " AI / LLM / Agents ",
          assignedBy: "agent",
        },
      });

      expect(assign.statusCode).toBe(200);
      expect(assign.json()).toMatchObject({ assigned: 2 });

      const repeated = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids,
          tagPath: "AI/LLM/Agents",
          assignedBy: "agent",
        },
      });
      expect(repeated.json()).toMatchObject({ assigned: 0 });

      const rowsWithTags = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const compactTagsByTitle = Object.fromEntries(
        (
          rowsWithTags.json().items as Array<{
            title: string;
            tagPaths: string[];
          }>
        ).map(({ title, tagPaths }) => [title, tagPaths]),
      );
      expect(compactTagsByTitle).toEqual({
        One: ["AI/LLM/Agents"],
        Two: ["AI/LLM/Agents"],
        Untagged: [],
      });

      const bulkStatus = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids, status: "in_progress" },
      });
      expect(bulkStatus.statusCode).toBe(200);
      expect(bulkStatus.json()).toEqual({
        updated: 2,
        status: "in_progress",
      });

      const inProgress = await app.inject({
        method: "GET",
        url: "/api/tabs?status=in_progress",
      });
      expect(inProgress.json().total).toBe(2);

      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      expect(tree.statusCode).toBe(200);
      expect(tree.json()).toMatchObject({
        items: [
          {
            name: "AI",
            path: "AI",
            tabCount: 2,
            children: [
              {
                name: "LLM",
                path: "AI/LLM",
                tabCount: 2,
                children: [
                  {
                    name: "Agents",
                    path: "AI/LLM/Agents",
                    tabCount: 2,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      });

      for (const tagPath of ["AI", "AI/LLM", "AI/LLM/Agents"]) {
        const filtered = await app.inject({
          method: "GET",
          url: `/api/tabs?tag=${encodeURIComponent(tagPath)}&pageSize=10`,
        });
        expect(filtered.statusCode).toBe(200);
        expect(filtered.json().total).toBe(2);
        expect(
          (filtered.json().items as Array<{ id: number }>).map(({ id }) => id),
        ).toEqual(expect.arrayContaining(ids));
      }
      const unknownTag = await app.inject({
        method: "GET",
        url: "/api/tabs?tag=AI%2FMissing",
      });
      expect(unknownTag.json().total).toBe(0);

      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${ids[0]}`,
      });
      expect(detail.json().tags).toEqual([
        expect.objectContaining({
          name: "Agents",
          path: "AI/LLM/Agents",
          assignedBy: "agent",
        }),
      ]);

      const missing = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [ids[0], 999_999],
          tagPath: "Should/Not/Exist",
          assignedBy: "agent",
        },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: "TAB_NOT_FOUND",
        missingIds: [999_999],
      });
      const treeAfterFailure = await app.inject({
        method: "GET",
        url: "/api/tags",
      });
      expect(JSON.stringify(treeAfterFailure.json())).not.toContain("Should");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports status totals by browser and tag and supports management filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-stats-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-08T20:00:00.000Z"),
    });

    try {
      for (const [browser, suffixes] of [
        ["chrome", ["one", "two"]],
        ["edge", ["three"]],
      ] as const) {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser,
            tabs: suffixes.map((suffix, index) => ({
              url: `https://example.com/${suffix}`,
              title: suffix,
              windowId: 1,
              index,
            })),
          },
        });
      }

      const list = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const items = list.json().items as Array<{
        id: number;
        browser: string;
      }>;
      const chromeIds = items
        .filter((tab) => tab.browser === "chrome")
        .map((tab) => tab.id);

      await app.inject({
        method: "PATCH",
        url: `/api/tabs/${chromeIds[0]}`,
        payload: { status: "done" },
      });
      await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: chromeIds,
          tagPath: "AI/LLM",
          assignedBy: "agent",
        },
      });

      const stats = await app.inject({ method: "GET", url: "/api/stats" });
      expect(stats.statusCode).toBe(200);
      expect(stats.json()).toMatchObject({
        total: 3,
        open: 3,
        byStatus: [
          { status: "inbox", count: 2 },
          { status: "in_progress", count: 0 },
          { status: "done", count: 1 },
          { status: "archived", count: 0 },
        ],
        byBrowser: [
          {
            browser: "chrome",
            total: 2,
            open: 2,
            byStatus: [
              { status: "inbox", count: 1 },
              { status: "in_progress", count: 0 },
              { status: "done", count: 1 },
              { status: "archived", count: 0 },
            ],
          },
          {
            browser: "edge",
            total: 1,
            open: 1,
          },
        ],
        byTag: [
          {
            name: "AI",
            path: "AI",
            total: 2,
          },
          {
            name: "LLM",
            path: "AI/LLM",
            total: 2,
            byStatus: [
              { status: "inbox", count: 1 },
              { status: "in_progress", count: 0 },
              { status: "done", count: 1 },
              { status: "archived", count: 0 },
            ],
          },
        ],
      });

      const done = await app.inject({
        method: "GET",
        url: "/api/tabs?status=done&importance=0",
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({
        total: 1,
        items: [{ id: chromeIds[0], status: "done", importance: 0 }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns persisted nullable content and unbounded tag collections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-persisted-detail-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const seedApp = createApp({ databasePath, logger: false });

    try {
      await seedApp.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/persisted",
              title: "Persisted",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/related",
              title: "Related",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });
    } finally {
      await seedApp.close();
    }

    const database = new Database(databasePath);
    const tabIds = (
      database.prepare("SELECT id FROM tabs ORDER BY id").all() as Array<{
        id: number;
      }>
    ).map((row) => row.id);
    const tabId = tabIds[0]!;
    const relatedTabId = tabIds[1]!;
    database
      .prepare(
        "INSERT INTO contents (tab_id, text, summary) VALUES (?, ?, ?)",
      )
      .run(tabId, "Text without a timestamp", "Existing summary");
    database
      .prepare(
        "INSERT INTO custom_fields (tab_id, key, value) VALUES (?, ?, ?)",
      )
      .run(tabId, " foo ", "spaced");
    database
      .prepare(
        "INSERT INTO custom_fields (tab_id, key, value) VALUES (?, ?, ?)",
      )
      .run(tabId, "foo", null);
    database
      .prepare(
        `INSERT INTO links (from_tab, to_tab, kind, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tabId, relatedTabId, "follows", "outbound", "user");
    database
      .prepare(
        `INSERT INTO links (from_tab, to_tab, kind, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(relatedTabId, tabId, "related", null, "agent");
    const insertTag = database.prepare(
      "INSERT INTO tags (name, parent_id) VALUES (?, NULL)",
    );
    const assignTag = database.prepare(
      "INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES (?, ?, 'user')",
    );
    database.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const result = insertTag.run(`Tag ${index.toString().padStart(4, "0")}`);
        assignTag.run(tabId, Number(result.lastInsertRowid));
      }
    })();
    database.close();

    const app = createApp({ databasePath, logger: false });
    try {
      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        content: {
          text: "Text without a timestamp",
          summary: "Existing summary",
          extractedAt: null,
        },
      });
      expect(detail.json().tags).toHaveLength(1_001);
      expect(detail.json().customFields).toEqual({
        " foo ": "spaced",
        foo: null,
      });
      expect(detail.json().links).toEqual([
        expect.objectContaining({
          fromTab: tabId,
          toTab: relatedTabId,
          kind: "follows",
          note: "outbound",
          createdBy: "user",
        }),
        expect.objectContaining({
          fromTab: relatedTabId,
          toTab: tabId,
          kind: "related",
          note: null,
          createdBy: "agent",
        }),
      ]);

      const tags = await app.inject({ method: "GET", url: "/api/tags" });
      expect(tags.statusCode).toBe(200);
      expect(tags.json().items).toHaveLength(1_001);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
