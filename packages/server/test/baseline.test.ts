import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { resolvePersonalAttentionFeatureFlags } from "../src/attention-feature-flags.js";
import {
  baselineContractHashes,
  q0LibraryV1,
  q10kBaseV1,
  s10kV1,
} from "../src/baseline-contract.js";
import {
  createSyntheticBaselineFixture,
  createVerifiedDatabaseSnapshot,
} from "../src/baseline-database.js";
import {
  measureLibraryQueries,
  runG0Baseline,
} from "../src/baseline-runner.js";

describe("G0 baseline harness", () => {
  it("keeps all personal-attention features off unless explicitly enabled", () => {
    expect(resolvePersonalAttentionFeatureFlags({})).toEqual({
      activityDailyWriter: false,
      activityWindows: false,
      context: false,
      liveAcquisition: false,
      logicalImportance: false,
      pageSummaryCapture: false,
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: false,
      priorityShadow: false,
      privacyPurge: false,
      research: false,
      resources: false,
    });
    expect(
      resolvePersonalAttentionFeatureFlags({
        TABHUB_FEATURE_CONTEXT: "true",
        TABHUB_FEATURE_LOGICAL_IMPORTANCE: "TRUE",
        TABHUB_FEATURE_PRIORITY_SHADOW: "1",
        TABHUB_FEATURE_RESEARCH: "false",
        TABHUB_FEATURE_RESOURCES: "0",
        TABHUB_FEATURE_ACTIVITY_WINDOWS: "true",
        TABHUB_FEATURE_ACTIVITY_DAILY_WRITER: "1",
      }),
    ).toEqual({
      activityDailyWriter: true,
      activityWindows: true,
      context: true,
      liveAcquisition: false,
      logicalImportance: true,
      pageSummaryCapture: false,
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: false,
      priorityShadow: true,
      privacyPurge: false,
      research: false,
      resources: false,
    });
    expect(() =>
      resolvePersonalAttentionFeatureFlags({
        TABHUB_FEATURE_CONTEXT: "sometimes",
      }),
    ).toThrow("TABHUB_FEATURE_CONTEXT must be one of");
    expect(() =>
      resolvePersonalAttentionFeatureFlags({
        TABHUB_FEATURE_LOGICAL_IMPORTANCE: "enabled",
      }),
    ).toThrow("TABHUB_FEATURE_LOGICAL_IMPORTANCE must be one of");
    expect(() =>
      resolvePersonalAttentionFeatureFlags({
        TABHUB_FEATURE_ACTIVITY_WINDOWS: "enabled",
      }),
    ).toThrow("TABHUB_FEATURE_ACTIVITY_WINDOWS must be one of");
    expect(() =>
      resolvePersonalAttentionFeatureFlags({
        TABHUB_FEATURE_ACTIVITY_DAILY_WRITER: "enabled",
      }),
    ).toThrow("TABHUB_FEATURE_ACTIVITY_DAILY_WRITER must be one of");
  });

  it("freezes versioned query and fixture definitions behind stable hashes", () => {
    expect(Object.isFrozen(q0LibraryV1)).toBe(true);
    expect(Object.isFrozen(q10kBaseV1)).toBe(true);
    expect(q10kBaseV1).not.toBe(q0LibraryV1);
    expect(Object.isFrozen(s10kV1)).toBe(true);
    expect(baselineContractHashes).toEqual({
      q0LibraryV1:
        "e62536999fcbd4dd813643da44e9b3832c1d3e327d46945debc8a11a412f6e8a",
      q10kBaseV1:
        "e62536999fcbd4dd813643da44e9b3832c1d3e327d46945debc8a11a412f6e8a",
      s10kV1:
        "d1ffc1866d0ec0ed1047c25c438bb1b2af826e9a2b8743cb31ff4843bd943013",
    });
  });

  it("creates a deterministic sanitized fixture and proves backup restore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g0-fixture-"));
    const sourcePath = join(directory, "source.sqlite");
    const replicaPath = join(directory, "replica.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const restoredPath = join(directory, "restored.sqlite");

    try {
      const fixture = await createSyntheticBaselineFixture(sourcePath, {
        rowCount: 120,
      });
      expect(fixture.schemaVersion).toBe(17);
      expect(fixture.integrityCheck).toEqual(["ok"]);
      expect(fixture.foreignKeyViolationCount).toBe(0);
      expect(fixture.tables.tabs.rowCount).toBe(120);
      expect(fixture.tables.contents.rowCount).toBe(60);
      expect(fixture.tables.contents_fts.rowCount).toBe(120);
      expect(fixture.tables.tags.rowCount).toBe(21);
      expect(fixture.tables.tab_page_activity_totals.rowCount).toBe(120);

      const replica = await createSyntheticBaselineFixture(replicaPath, {
        rowCount: 120,
      });
      expect(replica.fileSha256).toBe(fixture.fileSha256);
      expect(replica.tables).toEqual(fixture.tables);
      expect(replica.importanceCounts).toEqual(fixture.importanceCounts);

      const alternateContractPath = join(directory, "alternate-contract.sqlite");
      const alternateContractFixture = await createSyntheticBaselineFixture(
        alternateContractPath,
        {
          contract: { ...s10kV1, seed: "tabhub-s10k-alternate" },
          rowCount: 120,
        },
      );
      expect(alternateContractFixture.tables.tabs.checksumSha256).not.toBe(
        fixture.tables.tabs.checksumSha256,
      );

      const reader = new Database(sourcePath, {
        fileMustExist: true,
        readonly: true,
      });
      try {
        expect(
          (
            reader
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM (
                   SELECT url_normalized
                   FROM tabs
                   GROUP BY url_normalized
                   HAVING COUNT(DISTINCT browser) > 1
                 )`,
              )
              .get() as { count: number }
          ).count,
        ).toBeGreaterThan(0);
        expect(
          (
            reader
              .prepare(`
                SELECT COUNT(*) AS count
                FROM sqlite_schema
                WHERE type = 'table'
                  AND name IN (
                    'logical_pages',
                    'logical_page_importance_migration_audit',
                    'logical_page_preferences'
                  )
              `)
              .get() as { count: number }
          ).count,
        ).toBe(0);
      } finally {
        reader.close();
      }

      const snapshot = await createVerifiedDatabaseSnapshot(
        sourcePath,
        backupPath,
        restoredPath,
      );
      expect(snapshot.backup.tables).toEqual(snapshot.restored.tables);
      expect(snapshot.backup.integrityCheck).toEqual(["ok"]);
      expect(snapshot.restored.foreignKeyViolationCount).toBe(0);

      const performance = await measureLibraryQueries(
        restoredPath,
        "test-fixture",
        "Q0-library-v1",
        baselineContractHashes.q0LibraryV1,
        q0LibraryV1,
        2,
      );
      expect(performance.queries).toHaveLength(4);
      expect(performance.queries.every(({ p95Ms }) => p95Ms >= 0)).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports the retained fixture hash and a derived smoke-contract hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g0-runner-"));
    const sourcePath = join(directory, "source.sqlite");
    const workDirectory = join(directory, "work");
    const occupiedWorkDirectory = join(directory, "occupied-work");

    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 40 });
      await mkdir(occupiedWorkDirectory);
      const markerPath = join(occupiedWorkDirectory, "keep.txt");
      await writeFile(markerPath, "do not overwrite");
      await expect(
        runG0Baseline({
          samples: 1,
          sourcePath,
          syntheticRows: 40,
          workDirectory: occupiedWorkDirectory,
        }),
      ).rejects.toThrow("G0 baseline work directory must be empty");
      expect(await readFile(markerPath, "utf8")).toBe("do not overwrite");

      const result = await runG0Baseline({
        samples: 1,
        sourcePath,
        syntheticRows: 40,
        workDirectory,
      });
      const retained = new Database(join(workDirectory, "S10K-v1.sqlite"), {
        fileMustExist: true,
        readonly: true,
      });
      retained.close();
      expect(result.fixture.fileSha256).toBe(
        createHash("sha256")
          .update(await readFile(join(workDirectory, "S10K-v1.sqlite")))
          .digest("hex"),
      );
      expect(result.fixtureContractHash).not.toBe(
        baselineContractHashes.s10kV1,
      );
      expect(result.fixture.tables.tabs.rowCount).toBe(40);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
