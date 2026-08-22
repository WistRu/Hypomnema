import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import {
  logicalPageImportanceMigrationAuditSchema,
  logicalPagePreferenceSchema,
} from "@tabhub/shared";

import {
  g0BaselineTables,
  inspectDatabaseBaseline,
} from "../src/baseline-database.js";
import { openDatabase } from "../src/database.js";
import { normalizeUrl } from "../src/normalize-url.js";

async function createSchema17Fixture(databasePath: string): Promise<void> {
  const database = new Database(databasePath);

  try {
    sqliteVec.load(database);
    database.pragma("foreign_keys = ON");
    database.function(
      "tabhub_normalize_url_v2",
      { deterministic: true },
      normalizeUrl,
    );

    const migrationNames = (await readdir(new URL("../migrations", import.meta.url)))
      .filter(
        (name) =>
          /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= 17,
      )
      .sort();

    for (const name of migrationNames) {
      database.exec(
        await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
      );
    }
    database.pragma("user_version = 17");

    const insertTab = database.prepare(`
      INSERT INTO tabs (
        id, url, url_normalized, title, browser, window_id, tab_index,
        status, importance, is_open, first_seen_at, last_seen_at, closed_at
      ) VALUES (
        @id, @url, @urlNormalized, @title, @browser, @windowId, @tabIndex,
        'inbox', @importance, @isOpen, @firstSeenAt, @lastSeenAt, @closedAt
      )
    `);

    const rows = [
      {
        id: 10,
        url: "https://example.com/article?utm_source=chrome#part-1",
        urlNormalized: "https://example.com/article#part-1",
        title: "Older browser copy",
        browser: "chrome",
        windowId: 1,
        tabIndex: 0,
        importance: 0,
        isOpen: 1,
        firstSeenAt: "2026-08-01T08:00:00.000Z",
        lastSeenAt: "2026-08-01T09:00:00.000Z",
        closedAt: null,
      },
      {
        id: 11,
        url: "https://example.com/article?utm_source=edge#part-1",
        urlNormalized: "https://example.com/article#part-1",
        title: "Freshest browser copy",
        browser: "edge",
        windowId: 2,
        tabIndex: 0,
        importance: 0,
        isOpen: 0,
        firstSeenAt: "2026-08-01T08:30:00.000Z",
        lastSeenAt: "2026-08-01T10:00:00.000Z",
        closedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: 12,
        url: "https://example.com/article#part-2",
        urlNormalized: "https://example.com/article#part-2",
        title: "Distinct fragment",
        browser: "yandex",
        windowId: 3,
        tabIndex: 0,
        importance: 2,
        isOpen: 0,
        firstSeenAt: "2026-08-02T08:00:00.000Z",
        lastSeenAt: "2026-08-02T09:00:00.000Z",
        closedAt: "2026-08-02T09:00:00.000Z",
      },
      {
        id: 13,
        url: "https://example.com/equal",
        urlNormalized: "https://example.com/equal",
        title: "Equal legacy chrome",
        browser: "chrome",
        windowId: 1,
        tabIndex: 1,
        importance: 3,
        isOpen: 0,
        firstSeenAt: "2026-08-03T08:00:00.000Z",
        lastSeenAt: "2026-08-03T09:00:00.000Z",
        closedAt: "2026-08-03T09:00:00.000Z",
      },
      {
        id: 14,
        url: "https://example.com/equal",
        urlNormalized: "https://example.com/equal",
        title: "Equal legacy edge",
        browser: "edge",
        windowId: 2,
        tabIndex: 1,
        importance: 3,
        isOpen: 0,
        firstSeenAt: "2026-08-03T08:00:00.000Z",
        lastSeenAt: "2026-08-03T09:30:00.000Z",
        closedAt: "2026-08-03T09:30:00.000Z",
      },
      {
        id: 15,
        url: "https://example.com/conflict",
        urlNormalized: "https://example.com/conflict",
        title: "Conflict chrome",
        browser: "chrome",
        windowId: 1,
        tabIndex: 2,
        importance: 1,
        isOpen: 0,
        firstSeenAt: "2026-08-04T08:00:00.000Z",
        lastSeenAt: "2026-08-04T09:00:00.000Z",
        closedAt: "2026-08-04T09:00:00.000Z",
      },
      {
        id: 16,
        url: "https://example.com/conflict",
        urlNormalized: "https://example.com/conflict",
        title: "Conflict edge",
        browser: "edge",
        windowId: 2,
        tabIndex: 2,
        importance: 2,
        isOpen: 0,
        firstSeenAt: "2026-08-04T08:00:00.000Z",
        lastSeenAt: "2026-08-04T09:30:00.000Z",
        closedAt: "2026-08-04T09:30:00.000Z",
      },
      {
        id: 17,
        url: "https://example.com/tie?copy=first",
        urlNormalized: "https://example.com/tie",
        title: "Stable tie first",
        browser: "chrome",
        windowId: 1,
        tabIndex: 3,
        importance: 0,
        isOpen: 0,
        firstSeenAt: "2026-08-05T08:00:00.000Z",
        lastSeenAt: "2026-08-05T09:00:00.000Z",
        closedAt: "2026-08-05T09:00:00.000Z",
      },
      {
        id: 18,
        url: "https://example.com/tie?copy=second",
        urlNormalized: "https://example.com/tie",
        title: "Stable tie second",
        browser: "edge",
        windowId: 2,
        tabIndex: 3,
        importance: 0,
        isOpen: 0,
        firstSeenAt: "2026-08-05T08:00:00.000Z",
        lastSeenAt: "2026-08-05T09:00:00.000Z",
        closedAt: "2026-08-05T09:00:00.000Z",
      },
    ];

    database.transaction(() => {
      for (const row of rows) insertTab.run(row);

      database.exec(`
        INSERT INTO contents (tab_id, text, html_excerpt, summary, extracted_at)
        VALUES (10, 'Captured body', '<p>Captured body</p>', 'Summary', '2026-08-01T09:00:00.000Z');

        INSERT INTO custom_fields (tab_id, key, value)
        VALUES (10, 'owner', 'me');

        INSERT INTO relations (
          from_entity_id, to_entity_id, kind, note, created_by
        )
        SELECT source.id, target.id, 'related', 'fixture relation', 'user'
        FROM knowledge_entities AS source
        CROSS JOIN knowledge_entities AS target
        WHERE source.tab_id = 10 AND target.tab_id = 11;

        INSERT INTO tab_instances (
          tab_id, installation_id, instance_key, browser_session_id,
          browser_tab_id, url, title, window_id, tab_index, active, pinned,
          audible, muted, discarded, first_seen_at, last_seen_at
        ) VALUES (
          10, 'installation-a', 'tab:10',
          '00000000-0000-4000-8000-000000000001', 10,
          'https://example.com/article?utm_source=chrome#part-1',
          'Older browser copy', 1, 0, 1, 0, 0, 0, 0,
          '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z'
        );

        INSERT INTO saved_workspaces (id, name, created_at, updated_at)
        VALUES (1, 'Fixture workspace', '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z');

        INSERT INTO saved_workspace_items (
          workspace_id, ordinal, source_instance_id, canonical_tab_id,
          browser, installation_id, browser_session_id, browser_tab_id,
          url, title, window_id, tab_index, active, pinned, audible, muted,
          discarded
        ) VALUES (
          1, 0, 1, 10, 'chrome', 'installation-a',
          '00000000-0000-4000-8000-000000000001', 10,
          'https://example.com/article?utm_source=chrome#part-1',
          'Older browser copy', 1, 0, 1, 0, 0, 0, 0
        );

        INSERT INTO tab_activity_totals (
          installation_id, browser_session_id, browser_tab_id,
          foreground_ms, engaged_ms, updated_at
        ) VALUES (
          'installation-a', '00000000-0000-4000-8000-000000000001', 10,
          1000, 500, '2026-08-01T09:00:00.000Z'
        );

        INSERT INTO tab_activity_stream_cursors (
          installation_id, browser_session_id, last_sequence,
          last_event_id, last_payload_digest, updated_at
        ) VALUES (
          'installation-a', '00000000-0000-4000-8000-000000000001', 1,
          'event-1', 'digest-1', '2026-08-01T09:00:00.000Z'
        );

        INSERT INTO tab_page_activity_totals (
          browser, url_normalized, url, foreground_ms, engaged_ms,
          first_activity_at, last_activity_at, updated_at
        ) VALUES (
          'chrome', 'https://example.com/article#part-1',
          'https://example.com/article?utm_source=chrome#part-1',
          1000, 500, '2026-08-01T08:00:00.000Z',
          '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z'
        );

        INSERT INTO page_retention (
          tab_id, state, decided_by, decided_at
        ) VALUES (11, 'kept', 'user', '2026-08-01T10:00:00.000Z');
      `);
    })();
  } finally {
    database.close();
  }
}

function readLogicalState(databasePath: string): Record<string, unknown[]> {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });

  try {
    return {
      logicalPages: database
        .prepare("SELECT * FROM logical_pages ORDER BY id")
        .all(),
      preferences: database
        .prepare("SELECT * FROM logical_page_preferences ORDER BY logical_page_id")
        .all(),
      migrationAudit: database
        .prepare(
          "SELECT * FROM logical_page_importance_migration_audit ORDER BY logical_page_id",
        )
        .all(),
      tabMappings: database
        .prepare("SELECT id, logical_page_id FROM tabs ORDER BY id")
        .all(),
    };
  } finally {
    database.close();
  }
}

describe("logical page migration", () => {
  it("validates canonical importance provenance and conflict audit contracts", () => {
    const timestamp = "2026-08-12T00:00:00.000Z";
    const importanceValues = [null, 0, 1, 2, 3, 4, 1.5] as const;
    const recordedByValues = [null, "user", "agent", "system"] as const;
    const recordMethodValues = [
      null,
      "manual",
      "on_behalf_of_user",
      "rule",
    ] as const;
    const importanceUpdatedAtValues = [null, timestamp] as const;
    let accepted = 0;
    let rejected = 0;

    for (const userImportance of importanceValues) {
      for (const recordedBy of recordedByValues) {
        for (const recordMethod of recordMethodValues) {
          for (const importanceUpdatedAt of importanceUpdatedAtValues) {
            const isUnrated =
              userImportance === null &&
              recordedBy === null &&
              recordMethod === null &&
              importanceUpdatedAt === null;
            const hasRatedImportance =
              userImportance === 1 ||
              userImportance === 2 ||
              userImportance === 3;
            const hasValidProvenance =
              (recordedBy === "user" && recordMethod === "manual") ||
              (recordedBy === "agent" &&
                recordMethod === "on_behalf_of_user");
            const isValid =
              isUnrated ||
              (hasRatedImportance &&
                hasValidProvenance &&
                importanceUpdatedAt !== null);

            expect(
              logicalPagePreferenceSchema.safeParse({
                logicalPageId: 1,
                userImportance,
                recordedBy,
                recordMethod,
                importanceUpdatedAt,
                updatedAt: timestamp,
              }).success,
            ).toBe(isValid);
            if (isValid) accepted += 1;
            else rejected += 1;
          }
        }
      }
    }

    expect({ accepted, rejected }).toEqual({ accepted: 7, rejected: 217 });
    expect(
      logicalPageImportanceMigrationAuditSchema.safeParse({
        logicalPageId: 1,
        legacyValues: [
          { tabId: 1, browser: "chrome", value: 1 },
          { tabId: 2, browser: "edge", value: 2 },
        ],
        suggestedValue: 2,
        resolutionState: "conflict",
        createdAt: timestamp,
        reviewedAt: null,
      }).success,
    ).toBe(false);
  });

  it("creates the current schema on a fresh database and enforces mapped tabs", () => {
    const database = openDatabase(":memory:");

    try {
      expect(database.schemaVersion).toBe(26);
      expect(
        database.connection.pragma("user_version", { simple: true }),
      ).toBe(26);

      database.connection
        .prepare(`
          INSERT INTO logical_pages (
            identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          "https://example.com/new#fragment",
          "https://example.com/new#fragment",
          "https://example.com/new#fragment",
          "2026-08-12T00:00:00.000Z",
          "2026-08-12T00:00:00.000Z",
        );

      const logicalPageId = Number(
        database.connection
          .prepare("SELECT id FROM logical_pages")
          .pluck()
          .get(),
      );
      database.connection
        .prepare(`
          INSERT INTO tabs (
            url, url_normalized, title, browser, status, importance,
            is_open, first_seen_at, last_seen_at, logical_page_id
          ) VALUES (?, ?, ?, ?, 'inbox', 0, 1, ?, ?, ?)
        `)
        .run(
          "https://example.com/new#fragment",
          "https://example.com/new#fragment",
          "Mapped tab",
          "chrome",
          "2026-08-12T00:00:00.000Z",
          "2026-08-12T00:00:00.000Z",
          logicalPageId,
        );

      const insertPreference = database.connection.prepare(`
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (
          @logicalPageId, @userImportance, @recordedBy, @recordMethod,
          @importanceUpdatedAt, @updatedAt
        )
      `);
      const deletePreference = database.connection.prepare(
        "DELETE FROM logical_page_preferences WHERE logical_page_id = ?",
      );
      const importanceValues = [null, 0, 1, 2, 3, 4, 1.5] as const;
      const recordedByValues = [null, "user", "agent", "system"] as const;
      const recordMethodValues = [
        null,
        "manual",
        "on_behalf_of_user",
        "rule",
      ] as const;
      const importanceUpdatedAtValues = [
        null,
        "2026-08-12T00:00:00.000Z",
      ] as const;
      let accepted = 0;
      let rejected = 0;

      for (const userImportance of importanceValues) {
        for (const recordedBy of recordedByValues) {
          for (const recordMethod of recordMethodValues) {
            for (const importanceUpdatedAt of importanceUpdatedAtValues) {
              const isUnrated =
                userImportance === null &&
                recordedBy === null &&
                recordMethod === null &&
                importanceUpdatedAt === null;
              const hasRatedImportance =
                userImportance === 1 ||
                userImportance === 2 ||
                userImportance === 3;
              const hasValidProvenance =
                (recordedBy === "user" && recordMethod === "manual") ||
                (recordedBy === "agent" &&
                  recordMethod === "on_behalf_of_user");
              const isValid =
                isUnrated ||
                (hasRatedImportance &&
                  hasValidProvenance &&
                  importanceUpdatedAt !== null);
              const insert = () =>
                insertPreference.run({
                  logicalPageId,
                  userImportance,
                  recordedBy,
                  recordMethod,
                  importanceUpdatedAt,
                  updatedAt: "2026-08-12T00:00:00.000Z",
                });

              if (isValid) {
                expect(insert).not.toThrow();
                accepted += 1;
                deletePreference.run(logicalPageId);
              } else {
                expect(insert).toThrow(/CHECK constraint/);
                rejected += 1;
              }
            }
          }
        }
      }

      expect({ accepted, rejected }).toEqual({ accepted: 7, rejected: 217 });

      database.connection
        .prepare(`
          INSERT INTO logical_page_preferences (
            logical_page_id, user_importance, recorded_by, record_method,
            importance_updated_at, updated_at
          ) VALUES (?, NULL, NULL, NULL, NULL, ?)
        `)
        .run(logicalPageId, "2026-08-12T00:00:00.000Z");

      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO tabs (
              url, url_normalized, title, browser, status, importance,
              is_open, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, 'inbox', 0, 1, ?, ?)
          `)
          .run(
            "https://example.com/unmapped",
            "https://example.com/unmapped",
            "Unmapped tab",
            "edge",
            "2026-08-12T00:00:00.000Z",
            "2026-08-12T00:00:00.000Z",
          ),
      ).toThrow(/logical_page_id/);

      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO tabs (
              url, url_normalized, title, browser, status, importance,
              is_open, first_seen_at, last_seen_at, logical_page_id
            ) VALUES (?, ?, ?, ?, 'inbox', 0, 1, ?, ?, ?)
          `)
          .run(
            "https://example.com/different",
            "https://example.com/different",
            "Wrong identity",
            "edge",
            "2026-08-12T00:00:00.000Z",
            "2026-08-12T00:00:00.000Z",
            logicalPageId,
          ),
      ).toThrow(/logical_page_id/);

      expect(() =>
        database.connection
          .prepare("UPDATE tabs SET logical_page_id = NULL")
          .run(),
      ).toThrow(/logical_page_id/);
    } finally {
      database.close();
    }
  });

  it("backfills exact identity, representative, legacy audit, and preserves children", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-logical-page-v17-"));
    const databasePath = join(directory, "tabhub.sqlite");

    try {
      await createSchema17Fixture(databasePath);
      const before = await inspectDatabaseBaseline(databasePath);
      const migrated = openDatabase(databasePath);
      migrated.close();
      const after = await inspectDatabaseBaseline(databasePath);
      const database = new Database(databasePath, {
        fileMustExist: true,
        readonly: true,
      });

      try {
        database.pragma("foreign_keys = ON");
        expect(after.schemaVersion).toBe(26);
        expect(after.integrityCheck).toEqual(["ok"]);
        expect(after.foreignKeyViolationCount).toBe(0);
        expect(after.tables.tabs.rowCount).toBe(before.tables.tabs.rowCount);

        for (const tableName of g0BaselineTables) {
          if (tableName === "tabs") continue;
          if (tableName === "tab_instances") {
            expect(after.tables[tableName].rowCount, tableName).toBe(
              before.tables[tableName].rowCount,
            );
            continue;
          }
          expect(after.tables[tableName], tableName).toEqual(
            before.tables[tableName],
          );
        }

        expect(
          database.prepare("SELECT COUNT(*) FROM tabs WHERE logical_page_id IS NULL").pluck().get(),
        ).toBe(0);
        expect(
          database.prepare("SELECT COUNT(*) FROM logical_pages").pluck().get(),
        ).toBe(5);

        const fragmentOne = database
          .prepare(`
            SELECT id, representative_url
            FROM logical_pages
            WHERE identity_key = ?
          `)
          .get("https://example.com/article#part-1") as {
          id: number;
          representative_url: string;
        };
        const fragmentTwoId = database
          .prepare("SELECT id FROM logical_pages WHERE identity_key = ?")
          .pluck()
          .get("https://example.com/article#part-2") as number;

        expect(fragmentOne.representative_url).toBe(
          "https://example.com/article?utm_source=edge#part-1",
        );
        expect(fragmentTwoId).not.toBe(fragmentOne.id);
        expect(
          database
            .prepare("SELECT COUNT(DISTINCT logical_page_id) FROM tabs WHERE id IN (10, 11)")
            .pluck()
            .get(),
        ).toBe(1);
        expect(
          database
            .prepare("SELECT representative_url FROM logical_pages WHERE identity_key = ?")
            .pluck()
            .get("https://example.com/tie"),
        ).toBe("https://example.com/tie?copy=first");

        const preferences = database
          .prepare(`
            SELECT user_importance, recorded_by, record_method, importance_updated_at
            FROM logical_page_preferences
            ORDER BY logical_page_id
          `)
          .all();
        expect(preferences).toHaveLength(5);
        expect(preferences).toEqual(
          preferences.map(() => ({
            user_importance: null,
            recorded_by: null,
            record_method: null,
            importance_updated_at: null,
          })),
        );

        const auditByIdentity = Object.fromEntries(
          (
            database
              .prepare(`
                SELECT
                  logical_pages.identity_key,
                  audit.legacy_values_json,
                  audit.suggested_value,
                  audit.resolution_state
                FROM logical_page_importance_migration_audit AS audit
                JOIN logical_pages ON logical_pages.id = audit.logical_page_id
              `)
              .all() as Array<{
              identity_key: string;
              legacy_values_json: string;
              suggested_value: number | null;
              resolution_state: string;
            }>
          ).map((row) => [row.identity_key, row]),
        );

        expect(auditByIdentity["https://example.com/article#part-1"]).toMatchObject({
          legacy_values_json:
            '[{"tabId":10,"browser":"chrome","value":0},{"tabId":11,"browser":"edge","value":0}]',
          suggested_value: null,
          resolution_state: "confirmed",
        });
        expect(auditByIdentity["https://example.com/article#part-2"]).toMatchObject({
          legacy_values_json:
            '[{"tabId":12,"browser":"yandex","value":2}]',
          suggested_value: 2,
          resolution_state: "legacy_unknown",
        });
        expect(auditByIdentity["https://example.com/equal"]).toMatchObject({
          legacy_values_json:
            '[{"tabId":13,"browser":"chrome","value":3},{"tabId":14,"browser":"edge","value":3}]',
          suggested_value: 3,
          resolution_state: "legacy_unknown",
        });
        expect(auditByIdentity["https://example.com/conflict"]).toMatchObject({
          legacy_values_json:
            '[{"tabId":15,"browser":"chrome","value":1},{"tabId":16,"browser":"edge","value":2}]',
          suggested_value: null,
          resolution_state: "conflict",
        });

        const repeatedPath = join(directory, "tabhub-repeat.sqlite");
        await createSchema17Fixture(repeatedPath);
        const repeatedMigration = openDatabase(repeatedPath);
        repeatedMigration.close();
        const repeated = await inspectDatabaseBaseline(repeatedPath);

        expect(repeated.tables).toEqual(after.tables);
        expect(readLogicalState(repeatedPath)).toEqual(
          readLogicalState(databasePath),
        );
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
