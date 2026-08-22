import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createActivityCatalog, ActivityDailyWriterStateError } from "../src/activity-catalog.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { installPrivacyPurgeAuthorization } from "../src/live-acquisition-migration.js";
import { installPrivacyPurgeIntentCapabilities } from
  "../src/privacy-purge-intent-capabilities.js";
import { createLogicalPageCatalog } from "../src/logical-page-catalog.js";

vi.setConfig({ testTimeout: 20_000 });

const installationId = "122e4567-e89b-42d3-a456-426614174000";
const url = "https://www.youtube.com/watch?v=writer-lifecycle";
const flags = {
  activityDailyWriter: true,
  activityWindows: true,
  context: false,
  logicalImportance: true,
  resources: true,
  priorityShadow: false,
  research: false,
} as const;

function event(input: {
  id: string;
  session: string;
  startedAt: string;
  endedAt: string;
  foregroundMs: number;
  engagedMs: number;
}) {
  return {
    id: input.id,
    browser: "chrome",
    installationId,
    browserSessionId: input.session,
    browserTabId: 7,
    sequence: 1,
    url,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    foregroundMs: input.foregroundMs,
    engagedMs: input.engagedMs,
  };
}

function readState(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare(`
      SELECT state, coverage_started_at, updated_at
      FROM activity_daily_writer_state WHERE singleton_id = 1
    `).get();
  } finally {
    database.close();
  }
}

describe("persisted daily writer lifecycle", () => {
  it("starts delayed coverage, clips only the post-epoch suffix, and preserves it on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-writer-lifecycle-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let now = new Date("2026-08-12T10:00:00.000Z");
    const migrationClock = () => new Date("2026-08-12T09:00:00.000Z");
    let app = createApp({
      databasePath,
      logger: false,
      featureFlags: { ...flags, activityDailyWriter: false, activityWindows: false },
      clock: () => now,
      migrationClock,
    });
    try {
      const seededState = readState(databasePath);
      expect(seededState).toEqual({
        state: "disabled",
        coverage_started_at: null,
        updated_at: "2026-08-12T09:00:00.000Z",
      });
      await app.close();
      let disabledNow = new Date("2026-08-12T08:00:00.000Z");
      app = createApp({
        databasePath,
        logger: false,
        featureFlags: { ...flags, activityDailyWriter: false, activityWindows: false },
        clock: () => disabledNow,
        migrationClock,
      });
      expect(readState(databasePath)).toEqual(seededState);
      disabledNow = new Date("2026-08-12T10:00:00.000Z");
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: event({
        id: "223e4567-e89b-42d3-a456-426614174000",
        session: "323e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-08-12T09:30:00.000Z",
        endedAt: "2026-08-12T09:30:01.000Z",
        foregroundMs: 1_000,
        engagedMs: 500,
      }) })).statusCode).toBe(200);
      await app.close();

      now = new Date("2026-08-12T12:00:00.000Z");
      app = createApp({ databasePath, logger: false, featureFlags: flags,
        clock: () => now, migrationClock });
      expect(readState(databasePath)).toEqual({
        state: "enabled",
        coverage_started_at: "2026-08-12T12:00:00.000Z",
        updated_at: "2026-08-12T12:00:00.000Z",
      });
      const tabBeforeCoverage = (await app.inject({
        method: "GET", url: "/api/tabs?q=writer-lifecycle",
      })).json().items[0];
      const pageBeforeCoverage = (await app.inject({
        method: "GET", url: `/api/logical-pages/by-tab/${tabBeforeCoverage.id}`,
      })).json().page.id;
      now = new Date("2026-08-12T11:59:00.000Z");
      const databaseBeforeRegression = new Database(databasePath, { readonly: true });
      const beforeRegression = databaseBeforeRegression.prepare(`
        SELECT
          (SELECT COUNT(*) FROM tab_activity_stream_cursors) AS cursors,
          (SELECT COUNT(*) FROM logical_page_activity_daily) AS daily_rows,
          (SELECT SUM(foreground_ms) FROM tab_page_activity_totals) AS lifetime_ms
      `).get();
      databaseBeforeRegression.close();
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: event({
        id: "333e4567-e89b-42d3-a456-426614174000",
        session: "343e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-08-12T11:57:59.000Z",
        endedAt: "2026-08-12T11:58:00.000Z",
        foregroundMs: 1_000,
        engagedMs: 500,
      }) })).statusCode).toBe(500);
      expect((await app.inject({ method: "GET",
        url: `/api/logical-pages/${pageBeforeCoverage}/activity?window=7d`,
      })).statusCode).toBe(500);
      const databaseAfterRegression = new Database(databasePath, { readonly: true });
      expect(databaseAfterRegression.prepare(`
        SELECT
          (SELECT COUNT(*) FROM tab_activity_stream_cursors) AS cursors,
          (SELECT COUNT(*) FROM logical_page_activity_daily) AS daily_rows,
          (SELECT SUM(foreground_ms) FROM tab_page_activity_totals) AS lifetime_ms
      `).get()).toEqual(beforeRegression);
      databaseAfterRegression.close();
      now = new Date("2026-08-12T12:01:00.000Z");
      for (const payload of [
        event({
          id: "423e4567-e89b-42d3-a456-426614174000",
          session: "523e4567-e89b-42d3-a456-426614174000",
          startedAt: "2026-08-12T11:59:59.800Z",
          endedAt: "2026-08-12T12:00:00.000Z",
          foregroundMs: 101,
          engagedMs: 51,
        }),
        event({
          id: "623e4567-e89b-42d3-a456-426614174000",
          session: "723e4567-e89b-42d3-a456-426614174000",
          startedAt: "2026-08-12T11:59:59.900Z",
          endedAt: "2026-08-12T12:00:00.100Z",
          foregroundMs: 101,
          engagedMs: 51,
        }),
        event({
          id: "823e4567-e89b-42d3-a456-426614174000",
          session: "923e4567-e89b-42d3-a456-426614174000",
          startedAt: "2026-08-12T12:00:00.000Z",
          endedAt: "2026-08-12T12:00:00.100Z",
          foregroundMs: 100,
          engagedMs: 50,
        }),
      ]) {
        expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload }))
          .statusCode).toBe(200);
      }
      const database = new Database(databasePath, { readonly: true });
      try {
        expect(database.prepare(`
          SELECT foreground_ms, engaged_ms FROM logical_page_activity_daily
        `).get()).toEqual({ foreground_ms: 150, engaged_ms: 75 });
        expect(database.prepare(`
          SELECT foreground_ms, engaged_ms FROM tab_page_activity_totals
          WHERE url_normalized = ?
        `).get(url)).toEqual({ foreground_ms: 1_302, engaged_ms: 652 });
      } finally {
        database.close();
      }
      const tab = (await app.inject({ method: "GET", url: "/api/tabs?q=writer-lifecycle" }))
        .json().items[0];
      const pageId = (await app.inject({ method: "GET",
        url: `/api/logical-pages/by-tab/${tab.id}` })).json().page.id;
      expect((await app.inject({ method: "GET",
        url: `/api/logical-pages/${pageId}/activity?window=7d` })).json().activity)
        .toMatchObject({
          onScreenMs: 150,
          activeUseMs: 75,
          coverageStart: "2026-08-12T12:00:00.000Z",
        });

      const beforeRestart = readState(databasePath);
      await app.close();
      now = new Date("2026-08-12T13:00:00.000Z");
      app = createApp({ databasePath, logger: false, featureFlags: flags,
        clock: () => now, migrationClock });
      expect(readState(databasePath)).toEqual(beforeRestart);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resets continuous coverage and purges same-day, next-day, and future contamination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-writer-reset-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let now = new Date("2026-08-12T08:00:00.000Z");
    const migrationClock = () => new Date("2026-08-12T07:00:00.000Z");
    let app = createApp({ databasePath, logger: false, featureFlags: flags,
      clock: () => now, migrationClock });
    try {
      now = new Date("2026-08-12T08:01:00.000Z");
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: event({
        id: "a23e4567-e89b-42d3-a456-426614174000",
        session: "b23e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-08-12T08:00:00.000Z",
        endedAt: "2026-08-12T08:00:01.000Z",
        foregroundMs: 1_000,
        engagedMs: 500,
      }) })).statusCode).toBe(200);
      await app.close();

      now = new Date("2026-08-13T08:00:00.000Z");
      app = createApp({ databasePath, logger: false,
        featureFlags: { ...flags, activityDailyWriter: false, activityWindows: false },
        clock: () => now, migrationClock });
      expect(readState(databasePath)).toEqual({
        state: "disabled", coverage_started_at: null,
        updated_at: "2026-08-13T08:00:00.000Z",
      });
      const database = new Database(databasePath);
      try {
        database.pragma("foreign_keys = ON");
        database.pragma("recursive_triggers = ON");
        installPrivacyPurgeAuthorization(database);
        installPrivacyPurgeIntentCapabilities(database);
        const pageId = database.prepare("SELECT id FROM logical_pages LIMIT 1").pluck().get();
        const insert = database.prepare(`
          INSERT INTO logical_page_activity_daily (
            logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
          ) VALUES (?, ?, 9000, 4000, ?)
          ON CONFLICT (logical_page_id, activity_date) DO UPDATE SET
            foreground_ms = excluded.foreground_ms,
            engaged_ms = excluded.engaged_ms,
            updated_at = excluded.updated_at
        `);
        insert.run(pageId, "2026-08-13", now.toISOString());
        insert.run(pageId, "2026-08-14", now.toISOString());
      } finally {
        database.close();
      }
      await app.close();

      now = new Date("2026-08-13T09:00:00.000Z");
      app = createApp({ databasePath, logger: false, featureFlags: flags,
        clock: () => now, migrationClock });
      expect(readState(databasePath)).toMatchObject({
        state: "enabled", coverage_started_at: "2026-08-13T09:00:00.000Z",
      });
      let reader = new Database(databasePath, { readonly: true });
      try {
        expect(reader.prepare(`
          SELECT activity_date FROM logical_page_activity_daily ORDER BY activity_date
        `).pluck().all()).toEqual(["2026-08-12"]);
      } finally {
        reader.close();
      }
      now = new Date("2026-08-14T10:00:01.000Z");
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: event({
        id: "c23e4567-e89b-42d3-a456-426614174000",
        session: "d23e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-08-14T10:00:00.000Z",
        endedAt: "2026-08-14T10:00:01.000Z",
        foregroundMs: 1_000,
        engagedMs: 500,
      }) })).statusCode).toBe(200);
      reader = new Database(databasePath, { readonly: true });
      try {
        expect(reader.prepare(`
          SELECT activity_date, foreground_ms FROM logical_page_activity_daily
          ORDER BY activity_date
        `).all()).toEqual([
          { activity_date: "2026-08-12", foreground_ms: 1_000 },
          { activity_date: "2026-08-14", foreground_ms: 1_000 },
        ]);
      } finally {
        reader.close();
      }
      const tab = (await app.inject({ method: "GET", url: "/api/tabs?q=writer-lifecycle" }))
        .json().items[0];
      const pageId = (await app.inject({ method: "GET",
        url: `/api/logical-pages/by-tab/${tab.id}` })).json().page.id;
      expect((await app.inject({ method: "GET",
        url: `/api/logical-pages/${pageId}/activity?window=7d` })).json().activity)
        .toMatchObject({
          onScreenMs: 1_000,
          activeUseMs: 500,
          coverageStart: "2026-08-13T09:00:00.000Z",
        });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects clock regression and rolls state back when purge fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-writer-rollback-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-12T08:00:00.000Z"),
    });
    try {
      const logicalPages = createLogicalPageCatalog(database.connection);
      const seeded = readState(databasePath);
      expect(() => createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T07:59:59.999Z"), { dailyWriterEnabled: true }))
        .toThrow(ActivityDailyWriterStateError);
      expect(readState(databasePath)).toEqual(seeded);
      createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T09:00:00.000Z"), { dailyWriterEnabled: true });
      const enabled = readState(databasePath);
      expect(() => createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T08:30:00.000Z"), { dailyWriterEnabled: true }))
        .toThrow(ActivityDailyWriterStateError);
      expect(readState(databasePath)).toEqual(enabled);
      expect(() => createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T08:30:00.000Z"), { dailyWriterEnabled: false }))
        .toThrow(ActivityDailyWriterStateError);
      expect(readState(databasePath)).toEqual(enabled);

      createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T10:00:00.000Z"), { dailyWriterEnabled: false });
      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          999, 'https://stale.example/', 'https://stale.example/', 'https://stale.example/',
          '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z'
        );
        INSERT INTO logical_page_activity_daily (
          logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
        ) VALUES (999, '2026-08-12', 10, 5, '2026-08-12T10:00:00.000Z');
        CREATE TRIGGER fail_writer_purge
        BEFORE DELETE ON logical_page_activity_daily
        BEGIN
          SELECT RAISE(ABORT, 'forced writer purge failure');
        END;
      `);
      const beforeFailure = readState(databasePath);
      expect(() => createActivityCatalog(database.connection, logicalPages,
        () => new Date("2026-08-12T11:00:00.000Z"), { dailyWriterEnabled: true }))
        .toThrow(/forced writer purge failure/);
      expect(readState(databasePath)).toEqual(beforeFailure);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM logical_page_activity_daily WHERE logical_page_id = 999
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts catalog creation when persisted writer state or availability is corrupt", async () => {
    const corruptions = [
      "missing-state",
      "null-enabled-coverage",
      "missing-availability",
      "coverage-before-availability",
      "mismatched-enabled-timestamps",
    ] as const;
    for (const corruption of corruptions) {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-writer-corrupt-"));
      const databasePath = join(directory, "tabhub.sqlite");
      const database = openDatabase(databasePath, {
        migrationClock: () => new Date("2026-08-12T08:00:00.000Z"),
      });
      try {
        if (corruption === "missing-state") {
          database.connection.exec("DELETE FROM activity_daily_writer_state");
        } else if (corruption === "null-enabled-coverage") {
          database.connection.pragma("ignore_check_constraints = ON");
          database.connection.exec(`
            UPDATE activity_daily_writer_state
            SET state = 'enabled', coverage_started_at = NULL
          `);
          database.connection.pragma("ignore_check_constraints = OFF");
        } else if (corruption === "missing-availability") {
          database.connection.exec(`
            DROP TRIGGER activity_tracking_epochs_immutable_delete;
            DELETE FROM activity_tracking_epochs;
          `);
        } else if (corruption === "coverage-before-availability") {
          database.connection.exec(`
            UPDATE activity_daily_writer_state
            SET state = 'enabled',
              coverage_started_at = '2026-08-12T07:00:00.000Z',
              updated_at = '2026-08-12T07:00:00.000Z'
          `);
        } else {
          database.connection.exec(`
            UPDATE activity_daily_writer_state
            SET state = 'enabled',
              coverage_started_at = '2026-08-12T09:00:00.000Z',
              updated_at = '2026-08-12T10:00:00.000Z'
          `);
        }
        expect(() => createActivityCatalog(
          database.connection,
          createLogicalPageCatalog(database.connection),
        )).toThrow(ActivityDailyWriterStateError);
      } finally {
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
