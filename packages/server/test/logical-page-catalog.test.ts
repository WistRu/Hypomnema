import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { installPrivacyPurgeAuthorization } from
  "../src/live-acquisition-migration.js";
import { createLogicalPageCatalog } from "../src/logical-page-catalog.js";
import { installPrivacyPurgeIntentCapabilities } from
  "../src/privacy-purge-intent-capabilities.js";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";
const LOGICAL_IMPORTANCE_FEATURES = {
  context: false,
  logicalImportance: true,
  priorityShadow: false,
  research: false,
  resources: false,
} as const;

function installSchema26Capabilities(connection: Database.Database): void {
  connection.pragma("foreign_keys = ON");
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeAuthorization(connection);
  installPrivacyPurgeIntentCapabilities(connection);
}

describe("LogicalPageCatalog", () => {
  it("resolves exact normalized identities and updates representatives deterministically", () => {
    const database = openDatabase(":memory:");
    const catalog = createLogicalPageCatalog(database.connection);

    try {
      const first = catalog.resolve({
        observedAt: "2026-08-12T10:00:00.000Z",
        url: "https://example.com/page?utm_source=first#one",
        urlNormalized: "https://example.com/page#one",
      });
      const earlier = catalog.resolve({
        observedAt: "2026-08-12T09:00:00.000Z",
        url: "https://example.com/page?utm_source=earlier#one",
        urlNormalized: "https://example.com/page#one",
      });
      const tiedWinner = catalog.resolve({
        observedAt: "2026-08-12T10:00:00.000Z",
        url: "https://example.com/page?utm_source=aaa#one",
        urlNormalized: "https://example.com/page#one",
      });
      const otherFragment = catalog.resolve({
        observedAt: "2026-08-12T11:00:00.000Z",
        url: "https://example.com/page#two",
        urlNormalized: "https://example.com/page#two",
      });

      expect(earlier.id).toBe(first.id);
      expect(tiedWinner).toMatchObject({
        id: first.id,
        representativeUrl: "https://example.com/page?utm_source=aaa#one",
        createdAt: "2026-08-12T09:00:00.000Z",
        updatedAt: "2026-08-12T10:00:00.000Z",
      });
      expect(otherFragment.id).not.toBe(first.id);
      expect(catalog.get(first.id)?.preference).toMatchObject({
        userImportance: null,
        recordedBy: null,
        recordMethod: null,
      });
    } finally {
      database.close();
    }
  });

  it("fails closed when persisted importance provenance is malformed", () => {
    const database = openDatabase(":memory:");
    const catalog = createLogicalPageCatalog(database.connection);

    try {
      const page = catalog.resolve({
        observedAt: "2026-08-12T10:00:00.000Z",
        url: "https://example.com/malformed-provenance",
        urlNormalized: "https://example.com/malformed-provenance",
      });
      const updatePreference = database.connection.prepare(`
        UPDATE logical_page_preferences
        SET user_importance = @userImportance,
            recorded_by = @recordedBy,
            record_method = @recordMethod,
            importance_updated_at = @importanceUpdatedAt
        WHERE logical_page_id = @logicalPageId
      `);
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
        "2026-08-12T10:01:00.000Z",
      ] as const;
      let accepted = 0;
      let rejected = 0;

      database.connection.pragma("ignore_check_constraints = ON");
      for (const userImportance of importanceValues) {
        for (const recordedBy of recordedByValues) {
          for (const recordMethod of recordMethodValues) {
            for (const importanceUpdatedAt of importanceUpdatedAtValues) {
              updatePreference.run({
                logicalPageId: page.id,
                userImportance,
                recordedBy,
                recordMethod,
                importanceUpdatedAt,
              });
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

              if (isValid) {
                expect(catalog.get(page.id)?.preference).toMatchObject({
                  userImportance,
                  recordedBy,
                  recordMethod,
                  importanceUpdatedAt,
                });
                accepted += 1;
              } else {
                expect(() => catalog.get(page.id)).toThrow(
                  `Invalid logical page preference provenance for logical page ${page.id}`,
                );
                rejected += 1;
              }
            }
          }
        }
      }
      database.connection.pragma("ignore_check_constraints = OFF");

      expect({ accepted, rejected }).toEqual({ accepted: 7, rejected: 217 });
    } finally {
      database.close();
    }
  });

  it("maps snapshot and activity-only browser pages atomically without orphan identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-logical-writers-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({
      databasePath,
      featureFlags: LOGICAL_IMPORTANCE_FEATURES,
      logger: false,
      clock: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    try {
      const chrome = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/shared?utm_source=chrome",
              title: "Chrome",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const edge = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              url: "https://example.com/shared?utm_source=edge",
              title: "Edge",
              windowId: 2,
              index: 0,
            },
          ],
        },
      });
      const repeatedEdge = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              url: "https://example.com/shared?utm_source=edge",
              title: "Edge repeated",
              windowId: 2,
              index: 0,
            },
          ],
        },
      });
      const activityOnly = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          id: "323e4567-e89b-42d3-a456-426614174000",
          browser: "yandex",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          browserTabId: 7,
          sequence: 1,
          url: "https://example.com/activity-only",
          startedAt: "2026-08-12T11:59:00.000Z",
          endedAt: "2026-08-12T12:00:00.000Z",
          foregroundMs: 60_000,
          engagedMs: 10_000,
        },
      });

      expect(chrome.statusCode).toBe(200);
      expect(edge.statusCode).toBe(200);
      expect(repeatedEdge.statusCode).toBe(200);
      expect(activityOnly.statusCode).toBe(200);

      const inspector = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          inspector
            .prepare("SELECT COUNT(*) FROM tabs WHERE logical_page_id IS NULL")
            .pluck()
            .get(),
        ).toBe(0);
        expect(
          inspector
            .prepare(
              "SELECT COUNT(DISTINCT logical_page_id) FROM tabs WHERE url_normalized = ?",
            )
            .pluck()
            .get("https://example.com/shared"),
        ).toBe(1);
        expect(
          inspector
            .prepare("SELECT COUNT(*) FROM tabs WHERE url_normalized = ?")
            .pluck()
            .get("https://example.com/activity-only"),
        ).toBe(1);
        expect(
          inspector
            .prepare(
              "SELECT created_at, updated_at FROM logical_pages WHERE identity_key = ?",
            )
            .get("https://example.com/activity-only"),
        ).toEqual({
          created_at: "2026-08-12T11:59:00.000Z",
          updated_at: "2026-08-12T12:00:00.000Z",
        });

        inspector.exec(`
          CREATE TRIGGER reject_failed_browser_page
          BEFORE INSERT ON tabs
          WHEN NEW.browser = 'failed-browser'
          BEGIN
            SELECT RAISE(ABORT, 'forced browser-page failure');
          END;

          CREATE TRIGGER reject_failed_page_activity
          BEFORE INSERT ON tab_page_activity_totals
          WHEN NEW.url_normalized = 'https://example.com/activity-must-roll-back'
          BEGIN
            SELECT RAISE(ABORT, 'forced page-activity failure');
          END;
        `);
      } finally {
        inspector.close();
      }

      const failed = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "failed-browser",
          tabs: [
            {
              url: "https://example.com/must-roll-back",
              windowId: 3,
              index: 0,
            },
          ],
        },
      });
      expect(failed.statusCode).toBe(500);

      const failedActivity = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          id: "423e4567-e89b-42d3-a456-426614174000",
          browser: "yandex",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          browserTabId: 7,
          sequence: 2,
          url: "https://example.com/activity-must-roll-back",
          startedAt: "2026-08-12T11:59:59.000Z",
          endedAt: "2026-08-12T12:00:00.000Z",
          foregroundMs: 1_000,
          engagedMs: 500,
        },
      });
      expect(failedActivity.statusCode).toBe(500);

      const afterFailure = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          afterFailure
            .prepare("SELECT COUNT(*) FROM logical_pages WHERE identity_key = ?")
            .pluck()
            .get("https://example.com/must-roll-back"),
        ).toBe(0);
        expect(
          afterFailure
            .prepare("SELECT COUNT(*) FROM logical_pages WHERE identity_key = ?")
            .pluck()
            .get("https://example.com/activity-must-roll-back"),
        ).toBe(0);
        expect(
          afterFailure
            .prepare("SELECT COUNT(*) FROM tabs WHERE url_normalized = ?")
            .pluck()
            .get("https://example.com/activity-must-roll-back"),
        ).toBe(0);
        expect(
          afterFailure
            .prepare(`
              SELECT last_sequence
              FROM tab_activity_stream_cursors
              WHERE installation_id = ? AND browser_session_id = ?
            `)
            .pluck()
            .get(INSTALLATION_ID, BROWSER_SESSION_ID),
        ).toBe(1);
      } finally {
        afterFailure.close();
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates logical importance writes, projects every browser copy, and fixes provenance at the route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-logical-importance-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let now = new Date("2026-08-12T13:00:00.000Z");
    const app = createApp({
      databasePath,
      featureFlags: LOGICAL_IMPORTANCE_FEATURES,
      logger: false,
      clock: () => now,
    });

    try {
      const features = await app.inject({ method: "GET", url: "/api/features" });
      expect(features.statusCode).toBe(200);
      expect(features.json()).toEqual({
        activityWindows: false,
        agentUserImportance: true,
        context: false,
        logicalImportance: true,
        liveAcquisition: false,
        pageSummaryCapture: false,
        priorityAssessmentWriter: false,
        priorityPersonalization: false,
        priorityReaders: false,
        priorityShadow: false,
        privacyPurge: false,
        research: false,
        resources: false,
      });

      for (const browser of ["chrome", "edge"]) {
        const ingest = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser,
            tabs: [
              {
                url: `https://example.com/importance?utm_source=${browser}`,
                title: browser,
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        expect(ingest.statusCode).toBe(200);
      }

      const list = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const ids = (list.json().items as Array<{ id: number }>).map(({ id }) => id);
      const inspector = new Database(databasePath, { fileMustExist: true });
      try {
        installSchema26Capabilities(inspector);
        const logicalPageId = inspector
          .prepare("SELECT logical_page_id FROM tabs WHERE id = ?")
          .pluck()
          .get(ids[0]) as number;
        inspector
          .prepare(`
            INSERT INTO logical_page_importance_migration_audit (
              logical_page_id, legacy_values_json, suggested_value,
              resolution_state, created_at, reviewed_at
            ) VALUES (?, ?, 2, 'legacy_unknown', ?, NULL)
          `)
          .run(
            logicalPageId,
            JSON.stringify(ids.map((tabId) => ({ tabId, browser: "legacy", value: 2 }))),
            "2026-08-12T12:00:00.000Z",
          );
      } finally {
        inspector.close();
      }

      const reviews = await app.inject({
        method: "GET",
        url: "/api/logical-pages/importance-reviews?page=1&pageSize=10",
      });
      expect(reviews.statusCode).toBe(200);
      expect(reviews.json()).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 10,
        items: [
          {
            legacyImportanceAudit: {
              resolutionState: "legacy_unknown",
              suggestedValue: 2,
            },
          },
        ],
      });

      const userWrite = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: {
          ids,
          importance: 3,
          recordedBy: "agent",
          recordMethod: "on_behalf_of_user",
        },
      });
      expect(userWrite.statusCode).toBe(200);
      expect(userWrite.json()).toEqual({ updated: 2, importance: 3 });

      let state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT user_importance, recorded_by, record_method
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          user_importance: 3,
          recorded_by: "user",
          record_method: "manual",
        });
        expect(
          state.prepare("SELECT GROUP_CONCAT(importance) FROM tabs ORDER BY id").pluck().get(),
        ).toBe("3,3");
        expect(
          state
            .prepare(
              "SELECT resolution_state, reviewed_at FROM logical_page_importance_migration_audit",
            )
            .get(),
        ).toEqual({
          resolution_state: "confirmed",
          reviewed_at: "2026-08-12T13:00:00.000Z",
        });
      } finally {
        state.close();
      }

      now = new Date("2026-08-12T13:30:00.000Z");
      const replayedUserWrite = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[0]], importance: 3 },
      });
      expect(replayedUserWrite.statusCode).toBe(200);
      expect(replayedUserWrite.json()).toEqual({ updated: 1, importance: 3 });
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT importance_updated_at, updated_at
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          importance_updated_at: "2026-08-12T13:00:00.000Z",
          updated_at: "2026-08-12T13:00:00.000Z",
        });
        expect(
          state
            .prepare("SELECT reviewed_at FROM logical_page_importance_migration_audit")
            .pluck()
            .get(),
        ).toBe("2026-08-12T13:00:00.000Z");
      } finally {
        state.close();
      }

      now = new Date("2026-08-12T14:00:00.000Z");
      const agentWrite = await app.inject({
        method: "PATCH",
        url: "/api/agent/tabs/importance",
        payload: { ids: [ids[0]], importance: 1 },
      });
      expect(agentWrite.statusCode).toBe(200);
      expect(agentWrite.json()).toEqual({ updated: 1, importance: 1 });
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT user_importance, recorded_by, record_method
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          user_importance: 1,
          recorded_by: "agent",
          record_method: "on_behalf_of_user",
        });
        expect(
          state
            .prepare(
              "SELECT resolution_state, reviewed_at FROM logical_page_importance_migration_audit",
            )
            .get(),
        ).toEqual({
          resolution_state: "confirmed",
          reviewed_at: "2026-08-12T13:00:00.000Z",
        });
      } finally {
        state.close();
      }

      now = new Date("2026-08-12T15:00:00.000Z");
      state = new Database(databasePath, { fileMustExist: true });
      try {
        state.prepare("UPDATE tabs SET importance = 0 WHERE id = ?").run(ids[1]);
      } finally {
        state.close();
      }
      const replayedAgentWrite = await app.inject({
        method: "PATCH",
        url: "/api/agent/tabs/importance",
        payload: { ids: [ids[0]], importance: 1 },
      });
      expect(replayedAgentWrite.statusCode).toBe(200);
      expect(replayedAgentWrite.json()).toEqual({ updated: 1, importance: 1 });
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT importance_updated_at, updated_at
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          importance_updated_at: "2026-08-12T14:00:00.000Z",
          updated_at: "2026-08-12T14:00:00.000Z",
        });
        expect(
          state.prepare("SELECT GROUP_CONCAT(importance) FROM tabs ORDER BY id").pluck().get(),
        ).toBe("1,1");
        expect(
          state
            .prepare("SELECT reviewed_at FROM logical_page_importance_migration_audit")
            .pluck()
            .get(),
        ).toBe("2026-08-12T13:00:00.000Z");
      } finally {
        state.close();
      }

      const missing = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[0], 999_999], importance: 2 },
      });
      expect(missing.statusCode).toBe(404);
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare("SELECT DISTINCT importance FROM tabs")
            .pluck()
            .all(),
        ).toEqual([1]);
      } finally {
        state.close();
      }

      const singleUserWrite = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${ids[0]}`,
        payload: { importance: 2 },
      });
      expect(singleUserWrite.statusCode).toBe(200);
      expect(singleUserWrite.json().importance).toBe(2);
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT user_importance, recorded_by, record_method
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          user_importance: 2,
          recorded_by: "user",
          record_method: "manual",
        });
        expect(
          state.prepare("SELECT DISTINCT importance FROM tabs").pluck().all(),
        ).toEqual([2]);
      } finally {
        state.close();
      }

      now = new Date("2026-08-12T16:00:00.000Z");
      const clear = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[1]], importance: 0 },
      });
      expect(clear.statusCode).toBe(200);
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT user_importance, recorded_by, record_method,
                     importance_updated_at
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          user_importance: null,
          recorded_by: null,
          record_method: null,
          importance_updated_at: null,
        });
        expect(
          state.prepare("SELECT GROUP_CONCAT(importance) FROM tabs ORDER BY id").pluck().get(),
        ).toBe("0,0");
      } finally {
        state.close();
      }

      now = new Date("2026-08-12T17:00:00.000Z");
      const replayedClear = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[0]], importance: 0 },
      });
      expect(replayedClear.statusCode).toBe(200);
      expect(replayedClear.json()).toEqual({ updated: 1, importance: 0 });
      state = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          state
            .prepare(`
              SELECT importance_updated_at, updated_at
              FROM logical_page_preferences
            `)
            .get(),
        ).toEqual({
          importance_updated_at: null,
          updated_at: "2026-08-12T16:00:00.000Z",
        });
        expect(
          state
            .prepare("SELECT reviewed_at FROM logical_page_importance_migration_audit")
            .pluck()
            .get(),
        ).toBe("2026-08-12T13:00:00.000Z");
      } finally {
        state.close();
      }

      const view = await app.inject({
        method: "GET",
        url: `/api/logical-pages/by-tab/${ids[0]}`,
      });
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({
        page: { urlNormalized: "https://example.com/importance" },
        preference: { userImportance: null },
        legacyImportanceAudit: {
          resolutionState: "confirmed",
          reviewedAt: "2026-08-12T13:00:00.000Z",
        },
        browserPages: [{ browser: "chrome" }, { browser: "edge" }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "updates more logical importance targets than SQLite permits as variables in one statement",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-logical-bulk-"));
      const databasePath = join(directory, "tabhub.sqlite");
      const tabCount = 33_000;
      const seeded = openDatabase(databasePath);

      try {
        const logicalPage = createLogicalPageCatalog(
          seeded.connection,
        ).resolve({
          observedAt: "2026-08-12T15:00:00.000Z",
          url: "https://bulk.example/shared",
          urlNormalized: "https://bulk.example/shared",
        });
        const insertTab = seeded.connection.prepare(`
          INSERT INTO tabs (
            id, url, url_normalized, browser, importance, is_open,
            first_seen_at, last_seen_at, logical_page_id
          ) VALUES (
            @id, 'https://bulk.example/shared', 'https://bulk.example/shared',
            @browser, 0, 0, '2026-08-12T15:00:00.000Z',
            '2026-08-12T15:00:00.000Z', @logicalPageId
          )
        `);
        seeded.connection.transaction(() => {
          for (let id = 1; id <= tabCount; id += 1) {
            insertTab.run({
              id,
              browser: `bulk-${id}`,
              logicalPageId: logicalPage.id,
            });
          }
        })();
      } finally {
        seeded.close();
      }

      const app = createApp({
        databasePath,
        featureFlags: LOGICAL_IMPORTANCE_FEATURES,
        logger: false,
      });
      try {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/tabs/importance",
          payload: {
            ids: Array.from({ length: tabCount }, (_, index) => index + 1),
            importance: 3,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ updated: tabCount, importance: 3 });

        const inspector = new Database(databasePath, { fileMustExist: true });
        try {
          expect(
            inspector
              .prepare("SELECT COUNT(*) FROM tabs WHERE importance = 3")
              .pluck()
              .get(),
          ).toBe(tabCount);
          expect(
            inspector
              .prepare(`
                SELECT user_importance, recorded_by, record_method
                FROM logical_page_preferences
              `)
              .get(),
          ).toEqual({
            user_importance: 3,
            recorded_by: "user",
            record_method: "manual",
          });
        } finally {
          inspector.close();
        }
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("fails logical importance closed and preserves legacy mutations by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-logical-feature-off-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({ databasePath, logger: false });

    try {
      for (const browser of ["chrome", "edge"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser,
            tabs: [{
              url: `https://feature-off.example/page?utm_source=${browser}`,
              title: browser,
              windowId: 1,
              index: 0,
            }],
          },
        });
        expect(response.statusCode).toBe(200);
      }

      const features = await app.inject({ method: "GET", url: "/api/features" });
      expect(features.statusCode).toBe(200);
      expect(features.json()).toEqual({
        activityWindows: false,
        agentUserImportance: false,
        context: false,
        logicalImportance: false,
        liveAcquisition: false,
        pageSummaryCapture: false,
        priorityAssessmentWriter: false,
        priorityPersonalization: false,
        priorityReaders: false,
        priorityShadow: false,
        privacyPurge: false,
        research: false,
        resources: false,
      });

      const initialList = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const initialItems = initialList.json().items as Array<{
        id: number;
        browser: string;
        importance: number;
      }>;
      const ids = initialItems.map(({ id }) => id);
      const seedAudit = new Database(databasePath, { fileMustExist: true });
      try {
        installSchema26Capabilities(seedAudit);
        const logicalPageId = seedAudit
          .prepare("SELECT logical_page_id FROM tabs WHERE id = ?")
          .pluck()
          .get(ids[0]) as number;
        seedAudit.prepare(`
          INSERT INTO logical_page_importance_migration_audit (
            logical_page_id, legacy_values_json, suggested_value,
            resolution_state, created_at, reviewed_at
          ) VALUES (?, ?, 2, 'legacy_unknown', ?, NULL)
        `).run(
          logicalPageId,
          JSON.stringify(ids.map((tabId) => ({ tabId, browser: "legacy", value: 2 }))),
          "2026-08-12T12:00:00.000Z",
        );
      } finally {
        seedAudit.close();
      }

      const legacyBulk = await app.inject({
        method: "PATCH",
        url: "/api/tabs/importance",
        payload: { ids: [ids[0]], importance: 3 },
      });
      expect(legacyBulk.statusCode).toBe(200);
      expect(legacyBulk.json()).toEqual({ updated: 1, importance: 3 });
      const legacySingle = await app.inject({
        method: "PATCH",
        url: `/api/tabs/${ids[1]}`,
        payload: { importance: 2 },
      });
      expect(legacySingle.statusCode).toBe(200);

      for (const request of [
        { method: "GET", url: `/api/logical-pages/by-tab/${ids[0]}` },
        { method: "GET", url: "/api/logical-pages/importance-reviews" },
        {
          method: "PATCH",
          url: "/api/agent/tabs/importance",
          payload: { ids, importance: 1 },
        },
      ] as const) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(404);
      }

      const inspector = new Database(databasePath, { fileMustExist: true });
      try {
        expect(
          inspector.prepare("SELECT id, importance FROM tabs ORDER BY id").all(),
        ).toEqual([
          { id: ids[0], importance: 3 },
          { id: ids[1], importance: 2 },
        ]);
        expect(
          inspector.prepare(`
            SELECT user_importance, recorded_by, record_method,
                   importance_updated_at
            FROM logical_page_preferences
          `).get(),
        ).toEqual({
          user_importance: null,
          recorded_by: null,
          record_method: null,
          importance_updated_at: null,
        });
        expect(
          inspector.prepare(`
            SELECT resolution_state, reviewed_at
            FROM logical_page_importance_migration_audit
          `).get(),
        ).toEqual({ resolution_state: "legacy_unknown", reviewed_at: null });
      } finally {
        inspector.close();
      }

      const finalList = await app.inject({ method: "GET", url: "/api/tabs?pageSize=10" });
      expect(
        finalList.json().items.map((item: { id: number }) => item.id),
      ).toEqual(initialItems.map(({ id }) => id));
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
