import { performance } from "node:perf_hooks";
import { readFile, readdir } from "node:fs/promises";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { normalizeUrl } from "../src/normalize-url.js";

async function applyThrough(
  database: Database.Database,
  version: number,
): Promise<void> {
  const names = (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= version)
    .sort();
  for (const name of names) {
    database.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.pragma(`user_version = ${version}`);
}

function registerMigrationDependencies(database: Database.Database): void {
  sqliteVec.load(database);
  database.pragma("foreign_keys = ON");
  database.function("tabhub_normalize_url_v2", { deterministic: true }, normalizeUrl);
  database.function("tabhub_migration_now", () => "2026-08-12T12:00:00.000Z");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function snapshotExistingTables(database: Database.Database): Record<string, unknown[]> {
  const tableNames = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).pluck().all() as string[];
  return Object.fromEntries(tableNames.map((tableName) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all() as Array<{ name: string }>;
    const orderBy = columns.map(({ name }) => quoteIdentifier(name)).join(", ");
    const rows = database.prepare(
      `SELECT * FROM ${quoteIdentifier(tableName)}${orderBy === "" ? "" : ` ORDER BY ${orderBy}`}`,
    ).all();
    return [tableName, rows];
  }));
}

describe("migration 021 daily activity", () => {
  it("uses the real current time when no migration clock is injected", () => {
    const before = Date.now();
    const database = openDatabase(":memory:");
    const after = Date.now();
    try {
      const epoch = database.connection.prepare(`
        SELECT coverage_started_at FROM activity_tracking_epochs
        WHERE metric = 'logical_page_activity_daily'
      `).pluck().get() as string;
      expect(Date.parse(epoch)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(epoch)).toBeLessThanOrEqual(after);
    } finally {
      database.close();
    }
  });

  it("creates constrained daily, immutable epoch, and persistent metric storage", () => {
    const migrationNow = "2026-08-12T12:00:00.000Z";
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(migrationNow),
    });
    try {
      expect(database.schemaVersion).toBe(26);
      const tables = database.connection.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `).pluck().all();
      expect(tables).toEqual(expect.arrayContaining([
        "logical_page_activity_daily",
        "activity_tracking_epochs",
        "activity_ingest_metrics",
        "activity_daily_writer_state",
      ]));
      expect(database.connection.prepare(`
        SELECT metric, coverage_started_at FROM activity_tracking_epochs
      `).get()).toMatchObject({
        metric: "logical_page_activity_daily",
        coverage_started_at: migrationNow,
      });
      expect(database.connection.prepare(`
        SELECT updated_at FROM activity_ingest_metrics WHERE singleton_id = 1
      `).pluck().get()).toBe(migrationNow);
      expect(database.connection.prepare(`
        SELECT state, coverage_started_at, updated_at
        FROM activity_daily_writer_state WHERE singleton_id = 1
      `).get()).toEqual({
        state: "disabled",
        coverage_started_at: null,
        updated_at: migrationNow,
      });
      expect(() => database.connection.prepare(`
        UPDATE activity_tracking_epochs SET coverage_started_at = '2000-01-01T00:00:00.000Z'
      `).run()).toThrow(/immutable/);
      expect(() => database.connection.prepare("DELETE FROM activity_tracking_epochs").run())
        .toThrow(/immutable/);
      expect(() => database.connection.prepare(`
        INSERT INTO activity_ingest_metrics (singleton_id, updated_at) VALUES (2, 'x')
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        INSERT INTO activity_daily_writer_state (
          singleton_id, state, coverage_started_at, updated_at
        ) VALUES (2, 'disabled', NULL, 'x')
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        UPDATE activity_daily_writer_state
        SET state = 'enabled', coverage_started_at = NULL
        WHERE singleton_id = 1
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        UPDATE activity_daily_writer_state
        SET state = 'disabled', coverage_started_at = '2026-08-12T12:00:00.000Z'
        WHERE singleton_id = 1
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        UPDATE activity_daily_writer_state SET updated_at = 'not-a-timestamp'
        WHERE singleton_id = 1
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        UPDATE activity_daily_writer_state
        SET updated_at = '2026-08-12 12:00:00'
        WHERE singleton_id = 1
      `).run()).toThrow();
      expect(database.connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades v20 quickly without reconstructing daily history or changing old tables", async () => {
    const legacy = new Database(":memory:");
    registerMigrationDependencies(legacy);
    try {
      await applyThrough(legacy, 20);
      legacy.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          91, 'https://example.com/legacy', 'https://example.com/legacy',
          'https://example.com/legacy', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        );
        INSERT INTO logical_page_preferences (logical_page_id, updated_at)
        VALUES (91, '2026-08-01T00:00:00.000Z');
        INSERT INTO tab_page_activity_totals (
          browser, url_normalized, url, foreground_ms, engaged_ms,
          first_activity_at, last_activity_at, updated_at
        ) VALUES (
          'chrome', 'https://example.com/legacy', 'https://example.com/legacy',
          9000, 4000, '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:09.000Z', '2026-08-01T00:00:09.000Z'
        );
      `);
      const before = snapshotExistingTables(legacy);
      const migration = await readFile(
        new URL("../migrations/021_activity_daily.sql", import.meta.url),
        "utf8",
      );
      const startedAt = performance.now();
      legacy.transaction(() => {
        legacy.exec(migration);
        legacy.pragma("user_version = 21");
      })();
      const elapsedMs = performance.now() - startedAt;
      const after = snapshotExistingTables(legacy);

      for (const [tableName, rows] of Object.entries(before)) {
        expect(after[tableName], tableName).toEqual(rows);
      }
      expect(legacy.prepare("SELECT COUNT(*) FROM logical_page_activity_daily").pluck().get())
        .toBe(0);
      expect(legacy.prepare("SELECT COUNT(*) FROM activity_tracking_epochs").pluck().get())
        .toBe(1);
      expect(legacy.prepare(`
        SELECT state, coverage_started_at FROM activity_daily_writer_state
      `).get()).toEqual({ state: "disabled", coverage_started_at: null });
      expect(legacy.pragma("user_version", { simple: true })).toBe(21);
      expect(elapsedMs).toBeLessThan(60_000);
      expect(legacy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it("enforces canonical dates and daily invariants", () => {
    const database = openDatabase(":memory:");
    try {
      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          1, 'https://example.com/', 'https://example.com/', 'https://example.com/',
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z'
        );
      `);
      const insert = database.connection.prepare(`
        INSERT INTO logical_page_activity_daily (
          logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
        ) VALUES (1, ?, ?, ?, '2026-08-12T00:00:00.000Z')
      `);
      expect(() => insert.run("2026-8-12", 1, 1)).toThrow();
      expect(() => insert.run("2026-08-12", 1, 2)).toThrow();
      expect(() => insert.run("2026-08-12", -1, 0)).toThrow();
      expect(insert.run("2026-08-12", 2, 1).changes).toBe(1);
    } finally {
      database.close();
    }
  });
});
