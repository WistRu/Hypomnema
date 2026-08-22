import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { normalizeUrl } from "../src/normalize-url.js";

async function applyThrough(
  database: Database.Database,
  version: number,
): Promise<void> {
  const migrationNames = (await readdir(new URL("../migrations", import.meta.url)))
    .filter(
      (name) =>
        /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= version,
    )
    .sort();
  for (const name of migrationNames) {
    database.exec(
      await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
  database.pragma(`user_version = ${version}`);
}

function registerMigrationDependencies(database: Database.Database): void {
  sqliteVec.load(database);
  database.pragma("foreign_keys = ON");
  database.function(
    "tabhub_normalize_url_v2",
    { deterministic: true },
    normalizeUrl,
  );
}

function seedLogicalPage(database: Database.Database): number {
  const logicalPageId = Number(
    database
      .prepare(`
        INSERT INTO logical_pages (
          identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        "https://example.com/context",
        "https://example.com/context",
        "https://example.com/context",
        "2026-08-12T10:00:00.000Z",
        "2026-08-12T10:00:00.000Z",
      ).lastInsertRowid,
  );
  return logicalPageId;
}

describe("migration 019 context ledger", () => {
  it("creates a separate context FTS namespace on a fresh schema", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.schemaVersion).toBe(26);
      const tables = database.connection
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
          ORDER BY name
        `)
        .pluck()
        .all() as string[];
      expect(tables).toEqual(
        expect.arrayContaining([
          "context_entries",
          "context_entry_reviews",
          "tab_session_intents",
          "context_entries_fts",
          "shareable_context_entries_fts",
          "local_installation_capabilities",
          "local_pairing_challenges",
        ]),
      );
      const contentSql = database.connection
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'contents'")
        .pluck()
        .get() as string;
      expect(contentSql).not.toContain("context");
      expect(
        database.connection.pragma("table_info(tab_instances)") as Array<{
          name: string;
        }>,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "navigation_revision" })]),
      );
      expect(database.connection.pragma("integrity_check", { simple: true })).toBe(
        "ok",
      );
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades schema 18 without changing existing logical, tab, or child counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-context-v18-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const legacy = new Database(databasePath);
    try {
      registerMigrationDependencies(legacy);
      await applyThrough(legacy, 17);
      legacy.exec(`
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, first_seen_at, last_seen_at
        ) VALUES (
          1, 'https://example.com/context', 'https://example.com/context',
          'Context fixture', 'chrome',
          '2026-08-12T10:00:00.000Z', '2026-08-12T10:01:00.000Z'
        );
        INSERT INTO tab_instances (
          tab_id, installation_id, instance_key, browser_session_id,
          browser_tab_id, url, title, window_id, tab_index, active, pinned,
          first_seen_at, last_seen_at
        ) VALUES (
          1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tab:7',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 7,
          'https://example.com/context', 'Context fixture', 1, 0, 1, 0,
          '2026-08-12T10:00:00.000Z', '2026-08-12T10:01:00.000Z'
        );
        INSERT INTO contents (tab_id, text, extracted_at)
        VALUES (1, 'existing captured content', '2026-08-12T10:01:00.000Z');
      `);
      legacy.exec(
        await readFile(
          new URL("../migrations/018_logical_pages.sql", import.meta.url),
          "utf8",
        ),
      );
      legacy.pragma("user_version = 18");

      const preservedTables = [
        "tabs",
        "tab_instances",
        "contents",
        "logical_pages",
        "logical_page_preferences",
        "logical_page_importance_migration_audit",
      ];
      const before = Object.fromEntries(
        preservedTables.map((table) => [
          table,
          Number(legacy.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()),
        ]),
      );
      legacy.close();

      const migrated = openDatabase(databasePath);
      try {
        expect(migrated.schemaVersion).toBe(26);
        const after = Object.fromEntries(
          preservedTables.map((table) => [
            table,
            Number(
              migrated.connection
                .prepare(`SELECT COUNT(*) FROM ${table}`)
                .pluck()
                .get(),
            ),
          ]),
        );
        expect(after).toEqual(before);
        expect(
          migrated.connection
            .prepare("SELECT navigation_revision FROM tab_instances")
            .pluck()
            .get(),
        ).toBe(1);
        expect(migrated.connection.pragma("integrity_check", { simple: true })).toBe(
          "ok",
        );
        expect(migrated.connection.pragma("foreign_key_check")).toEqual([]);
      } finally {
        migrated.close();
      }
    } finally {
      if (legacy.open) legacy.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects NULL-bypass and malformed provenance/lifecycle rows", () => {
    const database = openDatabase(":memory:");
    try {
      const pageId = seedLogicalPage(database.connection);
      const validEntry = {
        pageId,
        kind: "note",
        body: "valid",
        actor: "user",
        method: "manual",
        visibility: "local_only",
        operation: "append",
        state: "active",
        revision: 1,
        key: "entry-valid",
        createdAt: "2026-08-12T10:00:00.000Z",
      };
      const insertEntry = database.connection.prepare(`
        INSERT INTO context_entries (
          logical_page_id, kind, body, actor, method, visibility,
          model_provenance_json, state, operation, revision, idempotency_key,
          created_at
        ) VALUES (
          @pageId, @kind, @body, @actor, @method, @visibility,
          @modelJson, @state, @operation, @revision, @key, @createdAt
        )
      `);
      for (const invalid of [
        { ...validEntry, key: "blank-body", body: "   ", modelJson: null },
        { ...validEntry, key: "null-actor", actor: null, modelJson: null },
        {
          ...validEntry,
          key: "bad-pair",
          actor: "user",
          method: "model",
          modelJson: "{}",
        },
        {
          ...validEntry,
          key: "bad-json",
          actor: "agent",
          method: "model",
          modelJson: "not-json",
        },
      ]) {
        expect(() => insertEntry.run(invalid)).toThrow();
      }

      const validResult = insertEntry.run({ ...validEntry, modelJson: null });
      const entryId = Number(validResult.lastInsertRowid);
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO context_entry_reviews (
              context_entry_id, verdict, reviewed_by, review_method,
              idempotency_key, created_at
            ) VALUES (?, 'accepted', 'user', 'on_behalf_of_user', ?, ?)
          `)
          .run(entryId, "bad-review", validEntry.createdAt),
      ).toThrow();
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO context_entry_reviews (
              context_entry_id, verdict, reviewed_by, review_method,
              idempotency_key, created_at
            ) VALUES (?, 'accepted', 'user', 'manual', ?, ?)
          `)
          .run(entryId, "review-user-context", validEntry.createdAt),
      ).toThrow("only agent context can be reviewed");
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO tab_session_intents (
              installation_id, browser_session_id, browser_tab_id,
              logical_page_id, expected_url, expected_url_normalized,
              expected_instance_revision, body, actor, method, visibility,
              state, idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            7,
            pageId,
            "https://example.com/context",
            "https://example.com/context",
            1,
            "intent",
            "user",
            "manual",
            "local_only",
            "archived",
            "bad-lifecycle",
            validEntry.createdAt,
            validEntry.createdAt,
          ),
      ).toThrow();
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO tab_session_intents (
              installation_id, browser_session_id, browser_tab_id,
              logical_page_id, expected_url, expected_url_normalized,
              expected_instance_revision, body, actor, method, visibility,
              state, idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            7,
            pageId,
            "https://example.com/other",
            "https://example.com/other",
            1,
            "intent",
            "user",
            "manual",
            "local_only",
            "active",
            "wrong-subject",
            validEntry.createdAt,
            validEntry.createdAt,
          ),
      ).toThrow("session intent expected page does not match subject");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces the total provenance matrix and strict model shape in SQL", () => {
    const database = openDatabase(":memory:");
    try {
      const pageId = seedLogicalPage(database.connection);
      const timestamp = "2026-08-12T10:00:00.000Z";
      const validModel = JSON.stringify({
        provider: "fixture",
        name: "model",
        promptVersion: "v1",
      });
      const modelShapes: Array<string | null> = [
        null,
        validModel,
        JSON.stringify({
          provider: "fixture",
          name: "model",
          promptVersion: "v1",
          extra: "forbidden",
        }),
        JSON.stringify({ provider: "fixture", name: "model" }),
        JSON.stringify({ provider: " ", name: "model", promptVersion: "v1" }),
        JSON.stringify({ provider: 7, name: "model", promptVersion: "v1" }),
        '{"provider":"fixture","provider":"duplicate","name":"model","promptVersion":"v1"}',
        "not-json",
      ];
      const actors: Array<string | null> = [null, "user", "agent", "system"];
      const methods: Array<string | null> = [
        null,
        "manual",
        "on_behalf_of_user",
        "rule",
        "model",
        "derived",
      ];
      const sources: Array<string | null> = [null, "source-v1"];
      const confidences: Array<number | null> = [null, 0.5];
      const insertContext = database.connection.prepare(`
        INSERT INTO context_entries (
          logical_page_id, kind, body, actor, method, visibility, confidence,
          source_fingerprint, model_provenance_json, state, operation, revision,
          idempotency_key, created_at
        ) VALUES (
          @pageId, 'note', 'matrix context', @actor, @method, 'local_only',
          @confidence, @source, @model, 'active', 'append', @revision, @key,
          @timestamp
        )
      `);
      const insertIntent = database.connection.prepare(`
        INSERT INTO tab_session_intents (
          installation_id, browser_session_id, browser_tab_id,
          logical_page_id, expected_url, expected_url_normalized,
          expected_instance_revision, body, actor, method, visibility,
          confidence, source_fingerprint, model_provenance_json, state,
          idempotency_key, created_at, updated_at
        ) VALUES (
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', @browserTabId,
          @pageId, 'https://example.com/context',
          'https://example.com/context', 1, 'matrix intent', @actor, @method,
          'local_only', @confidence, @source, @model, 'active', @key,
          @timestamp, @timestamp
        )
      `);

      let contextAccepted = 0;
      let contextRejected = 0;
      let intentAccepted = 0;
      let intentRejected = 0;
      let caseNumber = 0;
      for (const actor of actors) {
        for (const method of methods) {
          for (const source of sources) {
            for (const confidence of confidences) {
              for (const model of modelShapes) {
                caseNumber += 1;
                const contextAllowed =
                  (actor === "user" && method === "manual" &&
                    source === null && confidence === null && model === null) ||
                  (actor === "agent" && method === "on_behalf_of_user" &&
                    source === null && confidence === null && model === null) ||
                  (actor === "agent" && method === "rule" &&
                    source !== null && model === null) ||
                  (actor === "agent" && method === "model" &&
                    source !== null && model === validModel) ||
                  (actor === "system" && method === "derived" &&
                    source !== null && model === null);
                const intentAllowed =
                  (actor === "user" && method === "manual" &&
                    source === null && confidence === null && model === null) ||
                  (actor === "agent" && method === "on_behalf_of_user" &&
                    source === null && confidence === null && model === null) ||
                  (actor === "agent" && method === "model" &&
                    source !== null && model === validModel);
                const contextWrite = () => insertContext.run({
                  pageId,
                  actor,
                  method,
                  confidence,
                  source,
                  model,
                  revision: caseNumber,
                  key: `context-matrix-${caseNumber}`,
                  timestamp,
                });
                const intentWrite = () => insertIntent.run({
                  browserTabId: caseNumber,
                  pageId,
                  actor,
                  method,
                  confidence,
                  source,
                  model,
                  key: `intent-matrix-${caseNumber}`,
                  timestamp,
                });
                const tuple = JSON.stringify({
                  actor,
                  method,
                  source,
                  confidence,
                  model,
                });
                if (contextAllowed) {
                  expect(contextWrite).not.toThrow();
                  contextAccepted += 1;
                } else {
                  let rejected = false;
                  try {
                    contextWrite();
                  } catch {
                    rejected = true;
                  }
                  expect(rejected, `context tuple accepted: ${tuple}`).toBe(true);
                  contextRejected += 1;
                }
                if (intentAllowed) {
                  expect(intentWrite).not.toThrow();
                  intentAccepted += 1;
                } else {
                  let rejected = false;
                  try {
                    intentWrite();
                  } catch {
                    rejected = true;
                  }
                  expect(rejected, `intent tuple accepted: ${tuple}`).toBe(true);
                  intentRejected += 1;
                }
              }
            }
          }
        }
      }

      expect({ contextAccepted, contextRejected }).toEqual({
        contextAccepted: 8,
        contextRejected: 760,
      });
      expect({ intentAccepted, intentRejected }).toEqual({
        intentAccepted: 4,
        intentRejected: 764,
      });
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces hashed per-installation capability and bounded challenge invariants in SQL", () => {
    const database = openDatabase(":memory:");
    try {
      const insertCapability = database.connection.prepare(`
        INSERT INTO local_installation_capabilities (
          installation_id, extension_origin, credential_hash,
          credential_version, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const timestamp = "2026-08-12T10:00:00.000Z";
      const origin = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";
      expect(() =>
        insertCapability.run("install-1", origin, null, 0, timestamp),
      ).not.toThrow();
      expect(() =>
        insertCapability.run("install-2", origin, null, 0, timestamp),
      ).not.toThrow();
      for (const invalid of [
        ["install-3", "https://extension.invalid", null, 0],
        ["install-4", "chrome-extension://ABC", null, 0],
        ["install-5", origin, Buffer.alloc(31), 1],
        ["install-6", origin, "plaintext", 1],
        ["install-7", origin, null, 1],
      ] as const) {
        expect(() => insertCapability.run(...invalid, timestamp)).toThrow();
      }

      const insertChallenge = database.connection.prepare(`
        INSERT INTO local_pairing_challenges (
          challenge_id, installation_id, extension_origin, code_salt,
          code_hash, created_at, expires_at, failed_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      expect(() =>
        insertChallenge.run(
          "challenge-1",
          "install-1",
          origin,
          Buffer.alloc(32),
          Buffer.alloc(32),
          timestamp,
          "2026-08-12T10:05:00.000Z",
          0,
        ),
      ).not.toThrow();
      for (const invalid of [
        ["challenge-2", "install-1", origin, Buffer.alloc(31), Buffer.alloc(32), "2026-08-12T10:05:00.000Z", 0],
        ["challenge-3", "install-1", origin, Buffer.alloc(32), Buffer.alloc(31), "2026-08-12T10:05:00.000Z", 0],
        ["challenge-4", "install-1", origin, Buffer.alloc(32), Buffer.alloc(32), timestamp, 0],
        ["challenge-5", "install-1", origin, Buffer.alloc(32), Buffer.alloc(32), "2026-08-12T10:05:00.000Z", 6],
        ["challenge-6", "missing-install", origin, Buffer.alloc(32), Buffer.alloc(32), "2026-08-12T10:05:00.000Z", 0],
      ] as const) {
        expect(() =>
          insertChallenge.run(
            invalid[0],
            invalid[1],
            invalid[2],
            invalid[3],
            invalid[4],
            timestamp,
            invalid[5],
            invalid[6],
          ),
        ).toThrow();
      }
      expect(() =>
        database.connection
          .prepare(`
            UPDATE local_installation_capabilities
            SET extension_origin = 'chrome-extension://different'
            WHERE installation_id = 'install-1'
          `)
          .run(),
      ).toThrow("local capability identity is immutable");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
