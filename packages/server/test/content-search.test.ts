import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { createApp } from "../src/app.js";

describe("captured content search", () => {
  it("finds snapshot titles before page content is captured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-title-search-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "yandex",
          tabs: [
            {
              url: "https://example.com/handbook",
              title: "Unique Narwhal Handbook",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/tabs?q=narwhal",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        total: 1,
        items: [{ title: "Unique Narwhal Handbook" }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finds a tab by text captured from the page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-content-search-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-08T19:00:00.000Z"),
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/research?utm_source=reader#intro",
              title: "Research note",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });

      const contentResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://example.com/research#intro",
          text: "A field report about quantum wombats and local-first tools.",
          htmlExcerpt: "<article>A field report about quantum wombats.</article>",
        },
      });

      expect(contentResponse.statusCode).toBe(200);
      expect(contentResponse.json()).toMatchObject({
        tabId: expect.any(Number),
        extractedAt: "2026-08-08T19:00:00.000Z",
      });

      const matchingResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?q=quantum%20wombats",
      });
      expect(matchingResponse.statusCode).toBe(200);
      expect(matchingResponse.json()).toMatchObject({
        total: 1,
        items: [
          {
            title: "Research note",
            browser: "chrome",
          },
        ],
      });

      const missingResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?q=platypus",
      });
      expect(missingResponse.json().total).toBe(0);

      const updatedContentResponse = await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://example.com/research#intro",
          text: "The revised field report is about a platypus habitat.",
          htmlExcerpt: "<article>A platypus habitat.</article>",
        },
      });
      expect(updatedContentResponse.statusCode).toBe(200);

      const staleTermResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?q=quantum",
      });
      expect(staleTermResponse.json().total).toBe(0);

      const currentTermResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?q=platypus",
      });
      expect(currentTermResponse.json().total).toBe(1);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates a stale summary when page content is recaptured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-stale-summary-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacyDatabase = new Database(databasePath);
    const migrationSql = await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    );

    legacyDatabase.exec(migrationSql);
    legacyDatabase.pragma("user_version = 1");
    legacyDatabase
      .prepare(
        `INSERT INTO tabs (
           id, url, url_normalized, title, browser, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "https://example.com/changing",
        "https://example.com/changing",
        "Changing page",
        "edge",
        "2026-08-08T18:00:00.000Z",
        "2026-08-08T18:00:00.000Z",
      );
    legacyDatabase
      .prepare(
        `INSERT INTO contents (
           tab_id, text, summary, summary_model, extracted_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "Original article text",
        "An obsolete capybara summary",
        "old-model",
        "2026-08-08T18:01:00.000Z",
      );
    legacyDatabase.close();

    const app = createApp({ databasePath, logger: false });

    try {
      const before = await app.inject({
        method: "GET",
        url: "/api/tabs?q=capybara",
      });
      expect(before.json().total).toBe(1);

      const capture = await app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "edge",
          url: "https://example.com/changing",
          text: "Replacement article about otters",
          htmlExcerpt: "<article>Replacement article about otters</article>",
        },
      });
      expect(capture.statusCode).toBe(200);

      const staleSearch = await app.inject({
        method: "GET",
        url: "/api/tabs?q=capybara",
      });
      expect(staleSearch.json().total).toBe(0);

      const currentList = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=edge",
      });
      expect(currentList.json()).toMatchObject({
        items: [{ summary: null }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
