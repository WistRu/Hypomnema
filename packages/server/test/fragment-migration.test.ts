import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("fragment-aware canonical page migration", () => {
  it("splits live fragment variants while preserving Library metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-fragment-v11-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacy = new Database(databasePath);

    try {
      sqliteVec.load(legacy);
      legacy.pragma("foreign_keys = ON");
      for (const name of [
        "001_initial.sql",
        "002_full_text_search.sql",
        "003_tag_indexes.sql",
        "004_summary_jobs.sql",
        "005_embeddings.sql",
        "006_tab_instances.sql",
        "007_browser_session_identity.sql",
        "008_tab_operations_and_workspaces.sql",
        "009_knowledge_graph_relations.sql",
        "010_default_topic.sql",
        "011_default_topic_guards.sql",
      ]) {
        legacy.exec(
          await readFile(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
      }
      legacy.pragma("user_version = 11");
      legacy.exec(`
        INSERT INTO tags (name, parent_id, color)
        VALUES ('Work', NULL, '#123456');

        INSERT INTO tabs (
          id, url, url_normalized, title, browser, window_id, tab_index,
          status, importance, is_open, first_seen_at, last_seen_at
        ) VALUES (
          10,
          'https://mail.example.com/#inbox/message-two',
          'https://mail.example.com/',
          'Message two',
          'chrome',
          1,
          1,
          'in_progress',
          3,
          1,
          '2026-08-10T00:00:00.000Z',
          '2026-08-10T00:05:00.000Z'
        );

        INSERT INTO tab_tags (tab_id, tag_id, assigned_by)
        SELECT 10, id, 'user'
        FROM tags
        WHERE name = 'Work';

        INSERT INTO custom_fields (tab_id, key, value)
        VALUES (10, 'owner', 'me');

        INSERT INTO tab_instances (
          tab_id, installation_id, instance_key, browser_session_id,
          browser_tab_id, url, title, window_id, tab_index, active, pinned,
          first_seen_at, last_seen_at
        ) VALUES
          (
            10, 'install-a', 'tab:101',
            '00000000-0000-4000-8000-000000000001', 101,
            'https://mail.example.com/?utm_source=mail#inbox/message-one',
            'Message one',
            1, 0, 0, 0,
            '2026-08-10T00:01:00.000Z', '2026-08-10T00:05:00.000Z'
          ),
          (
            10, 'install-a', 'tab:102',
            '00000000-0000-4000-8000-000000000001', 102,
            'https://mail.example.com/#inbox/message-two', 'Message two',
            1, 1, 1, 0,
            '2026-08-10T00:02:00.000Z', '2026-08-10T00:05:00.000Z'
          );

        INSERT INTO saved_workspaces (
          id, name, created_at, updated_at
        ) VALUES (
          1, 'Saved messages',
          '2026-08-10T00:03:00.000Z', '2026-08-10T00:03:00.000Z'
        );

        INSERT INTO saved_workspace_items (
          workspace_id, ordinal, source_instance_id, canonical_tab_id,
          browser, installation_id, browser_session_id, browser_tab_id,
          url, title, window_id, tab_index, favicon_url, active, pinned,
          audible, muted, discarded, last_accessed
        ) VALUES (
          1, 0, 999, 10,
          'chrome', 'install-a',
          '00000000-0000-4000-8000-000000000001', 103,
          'https://mail.example.com/#inbox/message-three', 'Message three',
          1, 2, NULL, 0, 0,
          0, 0, 0, NULL
        );
      `);
    } finally {
      legacy.close();
    }

    const app = createApp({ databasePath, logger: false });
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json().schemaVersion).toBe(17);

      const library = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });
      expect(library.json()).toMatchObject({
        total: 3,
        items: expect.arrayContaining([
          expect.objectContaining({
            urlNormalized: "https://mail.example.com/#inbox/message-one",
            status: "in_progress",
            importance: 3,
            isOpen: true,
            firstSeenAt: "2026-08-10T00:01:00.000Z",
            lastSeenAt: "2026-08-10T00:05:00.000Z",
            tagPaths: ["Work"],
          }),
          expect.objectContaining({
            urlNormalized: "https://mail.example.com/#inbox/message-two",
            status: "in_progress",
            importance: 3,
            isOpen: true,
            firstSeenAt: "2026-08-10T00:02:00.000Z",
            lastSeenAt: "2026-08-10T00:05:00.000Z",
            tagPaths: ["Work"],
          }),
          expect.objectContaining({
            urlNormalized: "https://mail.example.com/#inbox/message-three",
            status: "in_progress",
            importance: 3,
            isOpen: false,
            firstSeenAt: "2026-08-10T00:03:00.000Z",
            lastSeenAt: "2026-08-10T00:03:00.000Z",
            tagPaths: ["Work"],
          }),
        ]),
      });

      const items = library.json().items as Array<{
        id: number;
        urlNormalized: string;
      }>;
      for (const item of items) {
        const detail = await app.inject({
          method: "GET",
          url: `/api/tabs/${item.id}`,
        });
        expect(detail.json()).toMatchObject({
          customFields: { owner: "me" },
          tags: [expect.objectContaining({ path: "Work" })],
        });
      }

      const instances = await app.inject({
        method: "GET",
        url: "/api/tab-instances/bulk",
      });
      expect(instances.statusCode, instances.body).toBe(200);
      expect(
        new Set(
          instances
            .json()
            .items.map((item: { canonicalTabId: number }) => item.canonicalTabId),
        ).size,
      ).toBe(2);

      const savedVariant = items.find(
        ({ urlNormalized }) =>
          urlNormalized === "https://mail.example.com/#inbox/message-three",
      );
      const workspace = await app.inject({
        method: "GET",
        url: "/api/workspaces/1",
      });
      expect(workspace.statusCode, workspace.body).toBe(200);
      expect(workspace.json()).toMatchObject({
        items: [
          {
            url: "https://mail.example.com/#inbox/message-three",
            canonicalTabId: savedVariant?.id,
          },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
