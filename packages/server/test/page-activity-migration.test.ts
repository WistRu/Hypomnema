import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { normalizeUrl } from "../src/normalize-url.js";

describe("page activity migration", () => {
  it("materializes schema 15 activity that has no canonical Library page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-page-activity-v15-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacy = new Database(databasePath);

    try {
      sqliteVec.load(legacy);
      legacy.pragma("foreign_keys = ON");
      legacy.function(
        "tabhub_normalize_url_v2",
        { deterministic: true },
        normalizeUrl,
      );
      const migrationNames = (await readdir(new URL("../migrations", import.meta.url)))
        .filter(
          (name) =>
            /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= 15,
        )
        .sort();
      for (const name of migrationNames) {
        legacy.exec(
          await readFile(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
      }
      legacy.pragma("user_version = 15");
      legacy
        .prepare(`
          INSERT INTO tab_page_activity_totals (
            browser,
            url_normalized,
            url,
            foreground_ms,
            engaged_ms,
            first_activity_at,
            last_activity_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "edge",
          "https://example.com/transient",
          "https://example.com/transient",
          814,
          200,
          "2026-08-11T09:43:48.008Z",
          "2026-08-11T09:43:48.822Z",
          "2026-08-11T09:43:49.000Z",
        );
    } finally {
      legacy.close();
    }

    const app = createApp({ databasePath, logger: false });
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json().schemaVersion).toBe(16);

      const library = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=edge&is_open=false&pageSize=50",
      });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toMatchObject({
        total: 1,
        items: [
          {
            url: "https://example.com/transient",
            urlNormalized: "https://example.com/transient",
            title: null,
            browser: "edge",
            tagPaths: ["Без темы"],
            isOpen: false,
            windowId: null,
            index: null,
            firstSeenAt: "2026-08-11T09:43:48.008Z",
            lastSeenAt: "2026-08-11T09:43:48.822Z",
            closedAt: "2026-08-11T09:43:48.822Z",
            foregroundTimeMs: 814,
            engagedTimeMs: 200,
          },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
