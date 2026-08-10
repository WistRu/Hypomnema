import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healthResponseSchema } from "@tabhub/shared";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("GET /api/health", () => {
  it("upgrades a version 7 database with runtime defaults and workspace storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-v7-upgrade-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacyDatabase = new Database(databasePath);

    try {
      sqliteVec.load(legacyDatabase);
      legacyDatabase.pragma("foreign_keys = ON");
      const migrationNames = [
        "001_initial.sql",
        "002_full_text_search.sql",
        "003_tag_indexes.sql",
        "004_summary_jobs.sql",
        "005_embeddings.sql",
        "006_tab_instances.sql",
        "007_browser_session_identity.sql",
      ];
      for (const fileName of migrationNames) {
        legacyDatabase.exec(
          await readFile(
            new URL(`../migrations/${fileName}`, import.meta.url),
            "utf8",
          ),
        );
      }
      legacyDatabase.pragma("user_version = 7");
      legacyDatabase
        .prepare(`
          INSERT INTO tabs (
            id, url, url_normalized, title, browser, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          1,
          "https://example.com/version-seven",
          "https://example.com/version-seven",
          "Version seven",
          "chrome",
          "2026-08-09T11:00:00.000Z",
          "2026-08-09T11:00:00.000Z",
        );
      legacyDatabase
        .prepare(`
          INSERT INTO tab_instances (
            tab_id, installation_id, instance_key, browser_session_id,
            browser_tab_id, url, title, window_id, tab_index, active, pinned,
            first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          1,
          "0b69c1df-716e-44f1-8211-4dc130177e76",
          "tab:77",
          "333c8de5-e02a-4336-8c50-cf88b7d6e7b6",
          77,
          "https://example.com/version-seven",
          "Version seven",
          1,
          0,
          0,
          0,
          "2026-08-09T11:00:00.000Z",
          "2026-08-09T11:00:00.000Z",
        );
    } finally {
      legacyDatabase.close();
    }

    const app = createApp({ databasePath, logger: false });
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json().schemaVersion).toBe(9);

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(physical.json()).toMatchObject({
        total: 1,
        items: [{ audible: false, muted: false, discarded: false }],
      });

      const workspaces = await app.inject({
        method: "GET",
        url: "/api/workspaces",
      });
      expect(workspaces.statusCode).toBe(200);
      expect(workspaces.json()).toEqual({ items: [] });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a migrated, ready local database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-health-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: "ok",
        database: "ok",
        schemaVersion: 9,
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can reopen an already migrated database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-reopen-"));
    const databasePath = join(directory, "tabhub.sqlite");

    try {
      const firstApp = createApp({ databasePath, logger: false });
      await firstApp.inject({ method: "GET", url: "/api/health" });
      await firstApp.close();

      const reopenedApp = createApp({ databasePath, logger: false });

      try {
        const response = await reopenedApp.inject({
          method: "GET",
          url: "/api/health",
        });

        expect(response.statusCode).toBe(200);
        expect(healthResponseSchema.parse(response.json()).schemaVersion).toBe(
          9,
        );
      } finally {
        await reopenedApp.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a version 1 database and makes existing content searchable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-upgrade-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const migrationSql = await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    const legacyDatabase = new Database(databasePath);

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
        "https://example.com/legacy",
        "https://example.com/legacy",
        "Legacy tab",
        "edge",
        "2026-08-08T18:00:00.000Z",
        "2026-08-08T18:00:00.000Z",
      );
    legacyDatabase
      .prepare(
        `INSERT INTO contents (tab_id, text, extracted_at)
         VALUES (?, ?, ?)`,
      )
      .run(
        1,
        "Pre-migration narwhal research",
        "2026-08-08T18:01:00.000Z",
      );
    legacyDatabase.close();

    const app = createApp({ databasePath, logger: false });

    try {
      const healthResponse = await app.inject({
        method: "GET",
        url: "/api/health",
      });
      expect(healthResponse.json().schemaVersion).toBe(9);

      const physicalResponse = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(physicalResponse.json()).toMatchObject({
        total: 1,
        items: [
          {
            canonicalTabId: 1,
            installationId: "legacy:edge",
            browserTabId: null,
            url: "https://example.com/legacy",
          },
        ],
      });

      const modernSnapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          installationId: "75627e90-67b9-4645-a4d2-7c40f65ff64c",
          tabs: [
            {
              tabId: 77,
              url: "https://example.com/legacy",
              windowId: 9,
              index: 2,
            },
          ],
        },
      });
      expect(modernSnapshot.statusCode).toBe(200);
      const replacedPhysical = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(replacedPhysical.json()).toMatchObject({
        total: 1,
        items: [
          {
            installationId: "75627e90-67b9-4645-a4d2-7c40f65ff64c",
            browserTabId: 77,
          },
        ],
      });

      const searchResponse = await app.inject({
        method: "GET",
        url: "/api/tabs?q=narwhal",
      });
      expect(searchResponse.json()).toMatchObject({
        total: 1,
        items: [{ title: "Legacy tab" }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a schema-valid version 2 database with duplicate root tags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-v2-upgrade-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const initialSql = await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    const searchSql = await readFile(
      new URL("../migrations/002_full_text_search.sql", import.meta.url),
      "utf8",
    );
    const legacyDatabase = new Database(databasePath);

    legacyDatabase.exec(initialSql);
    legacyDatabase.exec(searchSql);
    legacyDatabase
      .prepare("INSERT INTO tags (name, parent_id) VALUES ('AI', NULL)")
      .run();
    legacyDatabase
      .prepare("INSERT INTO tags (name, parent_id) VALUES ('AI', NULL)")
      .run();
    legacyDatabase
      .prepare(
        "INSERT INTO tags (name, parent_id) VALUES ('AI [legacy duplicate #2]', NULL)",
      )
      .run();
    legacyDatabase.pragma("user_version = 2");
    legacyDatabase.close();

    const app = createApp({ databasePath, logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe(9);

      const tags = await app.inject({ method: "GET", url: "/api/tags" });
      const paths = tags
        .json()
        .items.map((tag: { path: string }) => tag.path) as string[];
      expect(paths).toHaveLength(3);
      expect(new Set(paths).size).toBe(3);
      expect(paths).toContain("AI");
      expect(paths).toContain("AI [legacy duplicate #2]");
      expect(
        paths.some((path) => path.startsWith("AI [legacy duplicate #2;")),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
