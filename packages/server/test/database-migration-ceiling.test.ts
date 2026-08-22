import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DatabaseSchemaTooNewError,
  openDatabase,
} from "../src/database.js";
import { createPrivacyLifecycle } from "../src/privacy-lifecycle.js";

describe("openDatabase historical migration ceiling", () => {
  it("installs the latest schema by default", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.schemaVersion).toBe(26);
      expect(database.connection.pragma("user_version", { simple: true }))
        .toBe(26);
      expect(database.connection.prepare(`
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'privacy_subject_generations'
      `).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'view'
          AND name = 'privacy_purge26_expected_execution_targets'
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("can stop at schema 24 for an immutable historical baseline", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 24,
    });
    try {
      expect(database.schemaVersion).toBe(24);
      expect(database.connection.pragma("user_version", { simple: true }))
        .toBe(24);
      expect(database.connection.prepare(`
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'research_sources'
      `).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'privacy_subject_generations'
      `).pluck().get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("fails closed when the database is newer than the requested ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-migration-ceiling-"));
    const databasePath = join(directory, "tabhub.sqlite");
    try {
      openDatabase(databasePath).close();

      expect(() => openDatabase(databasePath, {
        maximumMigrationVersion: 24,
      })).toThrowError(DatabaseSchemaTooNewError);
      expect(() => openDatabase(databasePath, {
        maximumMigrationVersion: 24,
      })).toThrow("Database schema version 26 is newer than supported version 24");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts schema-25 terminal purge proofs through the default schema-26 migration path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-schema26-adoption-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const at = "2026-08-21T12:00:00.000Z";
    const completedAt = "2026-08-21T12:00:01.000Z";
    try {
      const legacy = openDatabase(databasePath, {
        maximumMigrationVersion: 25,
        migrationClock: () => new Date(at),
      });
      legacy.connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        9902,
        "https://legacy-default-migration.example/page",
        "https://legacy-default-migration.example/page",
        "https://legacy-default-migration.example/page",
        at,
        at,
      );
      const generationId = Number(legacy.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9902
          AND is_active = 1
      `).pluck().get());
      expect(createPrivacyLifecycle(legacy.connection, {
        clock: () => new Date(completedAt),
      }).purge({
        idempotencyKey: "legacy25-default-migration",
        target: { kind: "logical_page", subjectGenerationId: generationId },
      })).toMatchObject({ status: "completed", deletedRows: 0 });
      legacy.close();

      const migrated = openDatabase(databasePath, {
        migrationClock: () => new Date(completedAt),
      });
      try {
        expect(migrated.connection.pragma("user_version", { simple: true }))
          .toBe(26);
        expect(migrated.connection.prepare(`
          SELECT origin, status FROM privacy_purge_intents
        `).get()).toEqual({ origin: "legacy25", status: "completed" });
        expect(migrated.connection.prepare(`
          SELECT origin, outcome FROM privacy_purge_intent_receipts
        `).get()).toEqual({ origin: "legacy25", outcome: "completed" });
        expect(migrated.connection.prepare(`
          SELECT budget_class, state, legacy25_day_block
          FROM privacy_purge_budget_carryover_days
          ORDER BY budget_class
        `).all()).toEqual([
          {
            budget_class: "c90_coordinator",
            state: "active",
            legacy25_day_block: 1,
          },
          {
            budget_class: "provider",
            state: "active",
            legacy25_day_block: 1,
          },
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("samples one UTC migration day for every legacy terminal in an adoption transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-schema26-clock-snapshot-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacyAt = "2026-08-21T23:59:57.000Z";
    const completedAt = "2026-08-21T23:59:58.000Z";
    try {
      const legacy = openDatabase(databasePath, {
        maximumMigrationVersion: 25,
        migrationClock: () => new Date(legacyAt),
      });
      for (const [offset, suffix] of ["a", "b"].entries()) {
        const logicalPageId = 9_910 + offset;
        const url = `https://legacy-clock-${suffix}.example/page`;
        legacy.connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(logicalPageId, url, url, url, legacyAt, legacyAt);
        const generationId = Number(legacy.connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'logical_page' AND logical_page_id = ?
            AND is_active = 1
        `).pluck().get(logicalPageId));
        createPrivacyLifecycle(legacy.connection, {
          clock: () => new Date(completedAt),
        }).purge({
          idempotencyKey: `legacy-clock-${suffix}`,
          target: { kind: "logical_page", subjectGenerationId: generationId },
        });
      }
      legacy.close();

      let migrationClockCalls = 0;
      const migrated = openDatabase(databasePath, {
        migrationClock: () => {
          migrationClockCalls += 1;
          return new Date(migrationClockCalls === 1
            ? "2026-08-21T23:59:59.000Z"
            : "2026-08-22T00:00:00.000Z");
        },
      });
      try {
        expect(migrationClockCalls).toBe(1);
        expect(migrated.connection.prepare(`
          SELECT utc_date, budget_class, COUNT(*) AS row_count
          FROM privacy_purge_budget_carryover_days
          GROUP BY utc_date, budget_class
          ORDER BY utc_date, budget_class
        `).all()).toEqual([
          {
            utc_date: "2026-08-21",
            budget_class: "c90_coordinator",
            row_count: 2,
          },
          {
            utc_date: "2026-08-21",
            budget_class: "provider",
            row_count: 2,
          },
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails legacy adoption closed when a terminal proof is dated after the sampled UTC day", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-schema26-future-proof-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacyAt = "2026-08-21T12:00:00.000Z";
    const futureCompletedAt = "2026-08-22T00:00:01.000Z";
    try {
      const legacy = openDatabase(databasePath, {
        maximumMigrationVersion: 25,
        migrationClock: () => new Date(legacyAt),
      });
      const url = "https://legacy-future-proof.example/page";
      legacy.connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(9_920, url, url, url, legacyAt, legacyAt);
      const generationId = Number(legacy.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9920
          AND is_active = 1
      `).pluck().get());
      createPrivacyLifecycle(legacy.connection, {
        clock: () => new Date(futureCompletedAt),
      }).purge({
        idempotencyKey: "legacy-future-proof",
        target: { kind: "logical_page", subjectGenerationId: generationId },
      });
      legacy.close();

      expect(() => openDatabase(databasePath, {
        migrationClock: () => new Date(legacyAt),
      })).toThrow("Legacy25 privacy purge terminal proof is future-dated");

      const recovered = openDatabase(databasePath, {
        migrationClock: () => new Date(futureCompletedAt),
      });
      try {
        expect(recovered.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intents
        `).pluck().get()).toBe(1);
        expect(recovered.connection.prepare(`
          SELECT utc_date, COUNT(*) AS row_count
          FROM privacy_purge_budget_carryover_days
          GROUP BY utc_date
        `).get()).toEqual({
          utc_date: "2026-08-22",
          row_count: 2,
        });
      } finally {
        recovered.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
