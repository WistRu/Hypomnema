import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";

const livePath = fileURLToPath(new URL("../../../data/tabhub.sqlite", import.meta.url));
const envExamplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Rollout gate: the migration that will run against the user's daily database is
 * proven here on an isolated copy first. The live file is only ever read, and the
 * test records its hash before and after so an accidental write would fail loudly.
 *
 * The copy is taken through SQLite's online backup API, so the running daily server
 * may keep writing to the live file while this test runs.
 */
describe.skipIf(!existsSync(livePath))("live database migration 17 -> 26", () => {
  it("migrates an isolated copy and keeps feature-off Library reads working", async () => {
    const liveHashBefore = await sha256File(livePath);
    const directory = await mkdtemp(join(tmpdir(), "tabhub-live-migration-"));
    const copyPath = join(directory, "live-copy.sqlite");
    try {
      const source = new Database(livePath, { readonly: true });
      let sourceVersion: number;
      let sourceTabCount: number;
      try {
        sourceVersion = source.pragma("user_version", { simple: true }) as number;
        sourceTabCount = Number(
          source.prepare("SELECT COUNT(*) FROM tabs").pluck().get(),
        );
        await source.backup(copyPath);
      } finally {
        source.close();
      }

      expect(sourceVersion).toBe(17);

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
      try {
        expect(migrated.pragma("user_version", { simple: true })).toBe(26);
        expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(migrated.pragma("foreign_key_check")).toEqual([]);
        expect(Number(migrated.prepare("SELECT COUNT(*) FROM tabs").pluck().get()))
          .toBe(sourceTabCount);
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
