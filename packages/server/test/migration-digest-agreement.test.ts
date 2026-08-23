import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { sqlJsonObjectMirrorV1 as sqlJsonMirror } from "@tabhub/shared";

import { assertPrivacyPurgeDeletionManifestFrozen } from
  "../src/live-acquisition-migration.js";
import { openDatabase } from "../src/database.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Migration 025 computes its schema digests while migrating and the runtime validators
 * recompute them afterwards. Both sides must use the same byte contract, or a database
 * built by migration and a database built fresh disagree about identical schema.
 */
function schema25Digests(connection: Database.Database) {
  const purgeTargetCatalog = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank,
      requires_authority, guard_trigger_name
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all();
  const deletionManifest = connection.prepare(`
    SELECT trigger_name, table_name, pk_columns_json, pk_expression_sql,
      predicate_sql, trigger_sql_digest
    FROM privacy_purge_deletion_manifest ORDER BY trigger_name
  `).all();
  return {
    purgeTargetCatalogRows: purgeTargetCatalog.length,
    deletionManifestRows: deletionManifest.length,
    purgeTargetCatalog: sha256(sqlJsonMirror(purgeTargetCatalog)),
    deletionManifest: sha256(sqlJsonMirror(deletionManifest)),
  };
}

async function migratedDatabase(
  directory: string,
  name: string,
  ceiling?: number,
): Promise<string> {
  const path = join(directory, name);
  const database = openDatabase(
    path,
    ceiling === undefined ? {} : { maximumMigrationVersion: ceiling },
  );
  database.close();
  return path;
}

describe("migration 025 digest agreement", () => {
  it("computes the same schema digests on a fresh and on a migrated database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-digest-agreement-"));
    try {
      const freshPath = await migratedDatabase(directory, "fresh.sqlite");

      // Stop below 25, then finish the migration in a second pass: the digests are
      // computed during migration 025 there, not during a single fresh build.
      const steppedPath = await migratedDatabase(directory, "stepped.sqlite", 24);
      const stepped = openDatabase(steppedPath);
      stepped.close();

      const fresh = new Database(freshPath, { readonly: true });
      const migrated = new Database(steppedPath, { readonly: true });
      try {
        expect(fresh.pragma("user_version", { simple: true })).toBe(26);
        expect(migrated.pragma("user_version", { simple: true })).toBe(26);
        const freshDigests = schema25Digests(fresh);
        // Guard against a vacuous pass: two empty catalogs would hash equal.
        expect(freshDigests.purgeTargetCatalogRows).toBeGreaterThan(0);
        expect(freshDigests.deletionManifestRows).toBeGreaterThan(0);
        expect(schema25Digests(migrated)).toEqual(freshDigests);
      } finally {
        fresh.close();
        migrated.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);

  it("recomputes each stored trigger digest from the schema it pins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-stored-digest-"));
    try {
      const path = await migratedDatabase(directory, "stored-digest.sqlite");
      const connection = new Database(path);
      try {
        const stored = connection.prepare(`
          SELECT trigger_name, trigger_sql_digest
          FROM privacy_purge_deletion_manifest ORDER BY trigger_name
        `).all() as { trigger_name: string; trigger_sql_digest: string }[];
        expect(stored.length).toBeGreaterThan(0);

        // Production reads each stored digest and recomputes it from the trigger SQL
        // the schema actually holds. Nothing here restates the formula.
        expect(() => assertPrivacyPurgeDeletionManifestFrozen(connection)).not.toThrow();

        // The manifest row itself is frozen by its own trigger, so the way to prove
        // the check is live is to move the other side: drop the trigger the digest
        // pins and the recomputation no longer has anything to agree with.
        const target = stored[0]!;
        expect(() => connection.prepare(`
          UPDATE privacy_purge_deletion_manifest
          SET trigger_sql_digest = ? WHERE trigger_name = ?
        `).run("0".repeat(64), target.trigger_name)).toThrow(/frozen/);

        connection.exec(`DROP TRIGGER "${target.trigger_name}"`);
        expect(() => assertPrivacyPurgeDeletionManifestFrozen(connection))
          .toThrow(/drifted/);
      } finally {
        connection.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
