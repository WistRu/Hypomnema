import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { changedRowCounts, sha256File, tableRowCounts } from
  "../../../rollback/sqlite-facts.mjs";
import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";

const livePath = fileURLToPath(new URL("../../../data/tabhub.sqlite", import.meta.url));
const envExamplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));

/**
 * The runbook forbids the live database as a migration test target, so the ordinary
 * test run must never open it. Proving the migration against real data is a deliberate
 * act: set `TABHUB_PROVE_LIVE_MIGRATION=1` for that one run. Any other value is a typo
 * and fails rather than quietly disabling the proof.
 */
const optIn = process.env.TABHUB_PROVE_LIVE_MIGRATION;
const proveAgainstLiveDatabase = optIn === "1";

describe("live database migration proof gate", () => {
  it("stays opt-in and refuses to be enabled by a typo", () => {
    expect(
      optIn === undefined || optIn === "1",
      `TABHUB_PROVE_LIVE_MIGRATION must be unset or "1", got ${String(optIn)}`,
    ).toBe(true);
  });

  it("finds the live database whenever the proof is switched on", () => {
    if (!proveAgainstLiveDatabase) {
      // Nothing to look for: the proof below is skipped, and the skip is reported.
      expect(proveAgainstLiveDatabase).toBe(false);
      return;
    }
    expect(
      existsSync(livePath),
      `TABHUB_PROVE_LIVE_MIGRATION=1 but there is no live database at ${livePath}`,
    ).toBe(true);
  });
});

/**
 * Rollout gate: the migration that will run against the user's daily database is
 * proven here on an isolated copy first. The live file is only ever read, and the
 * test records its hash before and after so an accidental write would fail loudly.
 *
 * The copy is taken through SQLite's online backup API, so the running daily server
 * may keep writing to the live file while this test runs.
 */
describe.skipIf(!proveAgainstLiveDatabase)("live database migration 17 -> 26", () => {
  it("migrates an isolated copy and keeps feature-off Library reads working", async () => {
    const liveHashBefore = await sha256File(livePath);
    const directory = await mkdtemp(join(tmpdir(), "tabhub-live-migration-"));
    const copyPath = join(directory, "live-copy.sqlite");
    try {
      const source = new Database(livePath, { readonly: true });
      sqliteVec.load(source);
      let sourceVersion: number;
      let sourceRowCounts: ReadonlyMap<string, number>;
      try {
        sourceVersion = source.pragma("user_version", { simple: true }) as number;
        sourceRowCounts = tableRowCounts(source);
        await source.backup(copyPath);
      } finally {
        source.close();
      }
      expect(sourceRowCounts.size).toBeGreaterThan(0);

      // Before Rollout this is 17; after Rollout the live file is already at 26 and
      // the copy simply has nothing left to migrate. Both must end at 26.
      expect(sourceVersion).toBeLessThanOrEqual(26);

      const app = createApp({
        databasePath: copyPath,
        logger: false,
        featureFlags: personalAttentionFeatureFlagsOff,
      });
      try {
        const health = await app.inject({ method: "GET", url: "/api/health" });
        expect(health.statusCode).toBe(200);
        expect(health.json()).toMatchObject({
          status: "ok",
          database: "ok",
          schemaVersion: 26,
        });

        const library = await app.inject({ method: "GET", url: "/api/tabs?limit=1" });
        expect(library.statusCode).toBe(200);
      } finally {
        await app.close();
      }

      const migrated = new Database(copyPath, { readonly: true });
      sqliteVec.load(migrated);
      try {
        expect(migrated.pragma("user_version", { simple: true })).toBe(26);
        expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(migrated.pragma("foreign_key_check")).toEqual([]);

        // Every table that existed before the migration must still hold exactly the
        // rows it held, not just the ones a sample happened to cover.
        expect(changedRowCounts(sourceRowCounts, tableRowCounts(migrated)))
          .toEqual([]);
      } finally {
        migrated.close();
      }

      expect(await sha256File(livePath)).toBe(liveHashBefore);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);
});

describe("rollback profile documentation", () => {
  it("lists every feature flag in .env.example", async () => {
    const example = await readFile(envExamplePath, "utf8");
    for (const name of Object.keys(personalAttentionFeatureFlagsOff)) {
      const key = `TABHUB_FEATURE_${name.replace(/[A-Z]/g, (letter) =>
        `_${letter}`).toUpperCase()}`;
      expect(example).toContain(`${key}=`);
    }
  });
});
