import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";

describe("knowledge graph migration", () => {
  it("upgrades v8 links into typed relations and registers future entities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-knowledge-v8-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacy = new Database(databasePath);

    try {
      sqliteVec.load(legacy);
      legacy.pragma("foreign_keys = ON");
      const names = [
        "001_initial.sql",
        "002_full_text_search.sql",
        "003_tag_indexes.sql",
        "004_summary_jobs.sql",
        "005_embeddings.sql",
        "006_tab_instances.sql",
        "007_browser_session_identity.sql",
        "008_tab_operations_and_workspaces.sql",
      ];
      for (const name of names) {
        legacy.exec(
          await readFile(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
      }
      legacy.pragma("user_version = 8");

      const insertTab = legacy.prepare(`
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, status, importance,
          is_open, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'chrome', 'inbox', 0, 0, ?, ?)
      `);
      insertTab.run(
        10,
        "https://example.com/a",
        "https://example.com/a",
        "A",
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      insertTab.run(
        20,
        "https://example.com/b",
        "https://example.com/b",
        "B",
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      legacy
        .prepare("INSERT INTO tags (id, name, parent_id) VALUES (30, 'Work', NULL)")
        .run();
      legacy
        .prepare(
          "INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES (10, 30, 'user')",
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO links (id, from_tab, to_tab, kind, note, created_by)
           VALUES (40, 10, 20, 'follows', 'legacy note', 'agent')`,
        )
        .run();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(databasePath);
    try {
      expect(upgraded.schemaVersion).toBe(13);
      expect(
        upgraded.connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'")
          .get(),
      ).toBeUndefined();
      expect(
        upgraded.connection
          .prepare("SELECT kind, tab_id, topic_id FROM knowledge_entities ORDER BY id")
          .all(),
      ).toEqual([
        { kind: "tab", tab_id: 10, topic_id: null },
        { kind: "tab", tab_id: 20, topic_id: null },
        { kind: "topic", tab_id: null, topic_id: 30 },
        { kind: "topic", tab_id: null, topic_id: 31 },
      ]);
      expect(
        upgraded.connection
          .prepare(`
            SELECT
              relations.id,
              from_entity.tab_id AS from_tab,
              to_entity.tab_id AS to_tab,
              relations.kind,
              relations.note,
              relations.created_by
            FROM relations
            JOIN knowledge_entities AS from_entity
              ON from_entity.id = relations.from_entity_id
            JOIN knowledge_entities AS to_entity
              ON to_entity.id = relations.to_entity_id
          `)
          .get(),
      ).toEqual({
        id: 40,
        from_tab: 10,
        to_tab: 20,
        kind: "follows",
        note: "legacy note",
        created_by: "agent",
      });

      upgraded.connection
        .prepare(
          `INSERT INTO tabs (
             id, url, url_normalized, title, browser, status, importance,
             is_open, first_seen_at, last_seen_at
           ) VALUES (50, 'https://example.com/c', 'https://example.com/c',
             'C', 'chrome', 'inbox', 0, 0, '2026-08-10T00:00:00.000Z',
             '2026-08-10T00:00:00.000Z')`,
        )
        .run();
      upgraded.connection
        .prepare("INSERT INTO tags (id, name, parent_id) VALUES (60, 'Crypto', 30)")
        .run();
      expect(
        upgraded.connection
          .prepare(
            `SELECT COUNT(*) AS count
             FROM knowledge_entities
             WHERE tab_id = 50 OR topic_id = 60`,
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(() =>
        upgraded.connection
          .prepare(
            "INSERT INTO knowledge_entities (kind, tab_id, topic_id) VALUES ('tab', 50, 60)",
          )
          .run(),
      ).toThrow();
    } finally {
      upgraded.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
