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
    .filter(
      (name) =>
        /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name, 10) <= version,
    )
    .sort();
  for (const name of names) {
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

describe("migration 020 resources", () => {
  it("creates immutable event/head schema and deterministic YouTube seeds", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.schemaVersion).toBe(26);
      const tables = database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all() as string[];
      expect(tables).toEqual(
        expect.arrayContaining([
          "resources",
          "resource_events",
          "resource_heads",
          "resource_match_rules",
          "resource_match_rule_heads",
          "resource_ruleset_events",
          "resource_ruleset_heads",
          "logical_page_resource_assignments",
          "logical_page_resource_heads",
          "resource_resolution_events",
          "resource_resolution_heads",
          "resource_command_receipts",
          "resource_preferences",
          "resource_context_entries",
          "resource_context_entry_reviews",
        ]),
      );
      expect(
        database.connection
          .prepare("SELECT resource_key FROM resources ORDER BY resource_key")
          .pluck()
          .all(),
      ).toEqual(["platform:youtube"]);
      expect(
        database.connection
          .prepare(
            `SELECT host_pattern FROM resource_match_rules ORDER BY host_pattern`,
          )
          .pluck()
          .all(),
      ).toEqual(["youtu.be", "youtube.com"]);
      expect(
        database.connection
          .prepare(`
            SELECT events.version
            FROM resource_ruleset_heads AS heads
            JOIN resource_ruleset_events AS events
              ON events.id = heads.ruleset_event_id
            WHERE heads.scope = 'global'
          `)
          .pluck()
          .get(),
      ).toBe(1);
      expect(database.connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades a v19 fixture without changing Topic or logical-page data", async () => {
    const legacy = new Database(":memory:");
    registerMigrationDependencies(legacy);
    try {
      await applyThrough(legacy, 19);
      legacy.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          91, 'https://example.com/topic', 'https://example.com/topic',
          'https://example.com/topic', '2026-08-12T10:00:00.000Z',
          '2026-08-12T10:00:00.000Z'
        );
        INSERT INTO logical_page_preferences (
          logical_page_id, updated_at
        ) VALUES (91, '2026-08-12T10:00:00.000Z');
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
          logical_page_id
        ) VALUES (
          71, 'https://example.com/topic', 'https://example.com/topic',
          'Topic fixture', 'chrome', '2026-08-12T10:00:00.000Z',
          '2026-08-12T10:00:00.000Z', 91
        );
        INSERT INTO tags (id, name, color) VALUES (81, 'Research', '#112233');
        INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES (71, 81, 'user');
      `);
      const before = legacy
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM logical_pages) AS logical_pages,
            (SELECT COUNT(*) FROM tabs) AS tabs,
            (SELECT COUNT(*) FROM tags) AS tags,
            (SELECT COUNT(*) FROM tab_tags) AS tab_tags,
            (SELECT group_concat(id || ':' || name || ':' || COALESCE(parent_id, ''), '|')
               FROM (SELECT * FROM tags ORDER BY id)) AS tag_checksum,
            (SELECT group_concat(tab_id || ':' || tag_id || ':' || assigned_by, '|')
               FROM (SELECT * FROM tab_tags ORDER BY tab_id, tag_id)) AS membership_checksum
        `)
        .get();
      legacy.exec(
        await readFile(new URL("../migrations/020_resources.sql", import.meta.url), "utf8"),
      );
      legacy.pragma("user_version = 20");
      const after = legacy
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM logical_pages) AS logical_pages,
            (SELECT COUNT(*) FROM tabs) AS tabs,
            (SELECT COUNT(*) FROM tags) AS tags,
            (SELECT COUNT(*) FROM tab_tags) AS tab_tags,
            (SELECT group_concat(id || ':' || name || ':' || COALESCE(parent_id, ''), '|')
               FROM (SELECT * FROM tags ORDER BY id)) AS tag_checksum,
            (SELECT group_concat(tab_id || ':' || tag_id || ':' || assigned_by, '|')
               FROM (SELECT * FROM tab_tags ORDER BY tab_id, tag_id)) AS membership_checksum
        `)
        .get();
      expect(after).toEqual(before);
      expect(
        legacy.prepare("SELECT COUNT(*) FROM resource_resolution_events").pluck().get(),
      ).toBe(0);
      expect(legacy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it("rejects updates and deletes of immutable history rows", () => {
    const database = openDatabase(":memory:");
    try {
      const eventId = database.connection
        .prepare("SELECT id FROM resource_events LIMIT 1")
        .pluck()
        .get();
      const ruleId = database.connection
        .prepare("SELECT id FROM resource_match_rules LIMIT 1")
        .pluck()
        .get();
      expect(() =>
        database.connection.prepare("UPDATE resource_events SET name = 'Changed' WHERE id = ?").run(eventId),
      ).toThrow(/append-only/);
      expect(() =>
        database.connection.prepare("DELETE FROM resource_match_rules WHERE id = ?").run(ruleId),
      ).toThrow(/append-only/);
    } finally {
      database.close();
    }
  });

  it("enforces direct version successors for resource, rule, and ruleset heads", () => {
    const database = openDatabase(":memory:");
    try {
      const resourceId = database.connection
        .prepare("SELECT id FROM resources WHERE resource_key = 'platform:youtube'")
        .pluck()
        .get() as number;
      const resourceEventId = database.connection
        .prepare("SELECT event_id FROM resource_heads WHERE resource_id = ?")
        .pluck()
        .get(resourceId) as number;
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO resource_events (
              resource_id, version, name, kind, access_class, lifecycle_state,
              created_by, creation_method, supersedes_id, created_at
            ) VALUES (
              ?, 3, 'Skipped', 'platform', 'public', 'active',
              'user', 'manual', ?, '2026-08-12T12:00:00.000Z'
            )
          `)
          .run(resourceId, resourceEventId),
      ).toThrow(/current version/);

      const rule = database.connection
        .prepare(`
          SELECT id, rule_key, resource_id
          FROM resource_match_rules
          WHERE rule_key = 'seed:youtube:youtube.com'
        `)
        .get() as { id: number; rule_key: string; resource_id: number };
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO resource_match_rules (
              rule_key, version, resource_id, host_pattern, match_kind,
              path_prefix, priority, provenance_class, created_by,
              creation_method, supersedes_id, created_at
            ) VALUES (
              ?, 3, ?, 'youtube.com', 'suffix_host', '/', 100,
              'system_seed', 'system', 'derived', ?,
              '2026-08-12T12:00:00.000Z'
            )
          `)
          .run(rule.rule_key, rule.resource_id, rule.id),
      ).toThrow(/current version/);

      const rulesetId = database.connection
        .prepare("SELECT ruleset_event_id FROM resource_ruleset_heads WHERE scope = 'global'")
        .pluck()
        .get() as number;
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO resource_ruleset_events (
              version, supersedes_id, created_by, creation_method, created_at
            ) VALUES (3, ?, 'user', 'manual', '2026-08-12T12:00:00.000Z')
          `)
          .run(rulesetId),
      ).toThrow(/current version/);

      const pageA = database.connection
        .prepare(`
          INSERT INTO logical_pages (
            identity_key, url_normalized, representative_url, created_at, updated_at
          ) VALUES (
            'https://cross-a.example/page', 'https://cross-a.example/page',
            'https://cross-a.example/page', '2026-08-12T12:00:00.000Z',
            '2026-08-12T12:00:00.000Z'
          )
        `)
        .run().lastInsertRowid;
      const pageB = database.connection
        .prepare(`
          INSERT INTO logical_pages (
            identity_key, url_normalized, representative_url, created_at, updated_at
          ) VALUES (
            'https://cross-b.example/page', 'https://cross-b.example/page',
            'https://cross-b.example/page', '2026-08-12T12:00:00.000Z',
            '2026-08-12T12:00:00.000Z'
          )
        `)
        .run().lastInsertRowid;
      const firstAssignment = database.connection
        .prepare(`
          INSERT INTO logical_page_resource_assignments (
            logical_page_id, action, resource_id, provenance_class,
            assigned_by, assignment_method, source_fingerprint, created_at
          ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual',
            'manual-a', '2026-08-12T12:00:00.000Z')
        `)
        .run(pageA, resourceId).lastInsertRowid;
      database.connection
        .prepare(`
          INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
          VALUES (?, ?)
        `)
        .run(pageA, firstAssignment);
      expect(() =>
        database.connection
          .prepare(`
            INSERT INTO logical_page_resource_assignments (
              logical_page_id, action, resource_id, provenance_class,
              assigned_by, assignment_method, source_fingerprint,
              supersedes_id, created_at
            ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual',
              'manual-b', ?, '2026-08-12T12:00:00.000Z')
          `)
          .run(pageB, resourceId, firstAssignment),
      ).toThrow(/current head/);
    } finally {
      database.close();
    }
  });

  it("stores the exact closed C30b command union in immutable receipts", () => {
    const database = openDatabase(":memory:");
    try {
      const kinds = [
        "create",
        "set_aliases",
        "apply_override",
        "merge",
        "split",
        "rename",
        "set_user_evaluation",
      ] as const;
      const insert = database.connection.prepare(`
        INSERT INTO resource_command_receipts (
          idempotency_key, command_kind, request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, '{}', '2026-08-12T12:00:00.000Z')
      `);
      kinds.forEach((kind) => insert.run(`key:${kind}`, kind, `sha256:${kind}`));
      expect(
        database.connection
          .prepare("SELECT command_kind FROM resource_command_receipts ORDER BY command_kind")
          .pluck()
          .all(),
      ).toEqual([...kinds].sort());
      expect(() => insert.run("key:legacy", "override", "sha256:legacy")).toThrow();
      expect(() =>
        database.connection
          .prepare("UPDATE resource_command_receipts SET result_json = '{\"changed\":true}'")
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        database.connection.prepare("DELETE FROM resource_command_receipts").run(),
      ).toThrow(/append-only/);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM resource_command_receipts")
          .pluck()
          .get(),
      ).toBe(kinds.length);
    } finally {
      database.close();
    }
  });

  it("guards derived resource-context provenance and reviews only agent entries", () => {
    const database = openDatabase(":memory:");
    try {
      const resourceId = database.connection
        .prepare("SELECT id FROM resources WHERE resource_key = 'platform:youtube'")
        .pluck()
        .get() as number;
      const insertContext = database.connection.prepare(`
        INSERT INTO resource_context_entries (
          resource_id, kind, body, actor, method, visibility, confidence,
          source_fingerprint, model_provenance_json, state, operation,
          revision, idempotency_key, created_at
        ) VALUES (
          @resourceId, 'note', @body, @actor, @method, 'share_with_ai',
          @confidence, @sourceFingerprint, @modelJson, 'active', 'append',
          @revision, @key, '2026-08-12T12:00:00.000Z'
        )
      `);
      for (const invalid of [
        {
          actor: "agent",
          method: "rule",
          confidence: 0.8,
          modelJson: null,
          body: "Rule without fingerprint",
          key: "resource-context-rule-no-fingerprint",
        },
        {
          actor: "agent",
          method: "model",
          confidence: 0.8,
          modelJson: "{}",
          body: "Model without fingerprint",
          key: "resource-context-model-no-fingerprint",
        },
        {
          actor: "system",
          method: "derived",
          confidence: 1,
          modelJson: null,
          body: "Derived without fingerprint",
          key: "resource-context-derived-no-fingerprint",
        },
      ]) {
        expect(() =>
          insertContext.run({
            resourceId,
            sourceFingerprint: null,
            revision: 1,
            ...invalid,
          }),
        ).toThrow();
      }
      for (const invalid of [
        {
          actor: "user",
          method: "manual",
          confidence: 0.5,
          sourceFingerprint: "manual-extra",
          modelJson: "{}",
          body: "Manual with derived extras",
          key: "resource-context-manual-extras",
        },
        {
          actor: "agent",
          method: "on_behalf_of_user",
          confidence: 0.5,
          sourceFingerprint: "on-behalf-extra",
          modelJson: "{}",
          body: "On behalf with derived extras",
          key: "resource-context-on-behalf-extras",
        },
        {
          actor: "agent",
          method: "rule",
          confidence: 0.8,
          sourceFingerprint: "rule:fingerprint",
          modelJson: "{}",
          body: "Rule with model extras",
          key: "resource-context-rule-model-extras",
        },
        {
          actor: "system",
          method: "derived",
          confidence: 1,
          sourceFingerprint: "derived:fingerprint",
          modelJson: "{}",
          body: "Derived with model extras",
          key: "resource-context-derived-model-extras",
        },
        {
          actor: "agent",
          method: "model",
          confidence: 0.8,
          sourceFingerprint: "model:fingerprint",
          modelJson: "{}",
          body: "Model with incomplete provenance",
          key: "resource-context-model-incomplete-json",
        },
        {
          actor: "agent",
          method: "model",
          confidence: 0.8,
          sourceFingerprint: "model:fingerprint",
          modelJson: JSON.stringify({
            provider: "fixture",
            name: "fixture-model",
            promptVersion: "v1",
            extra: true,
          }),
          body: "Model with extra provenance",
          key: "resource-context-model-extra-json",
        },
      ]) {
        expect(() =>
          insertContext.run({ resourceId, revision: 1, ...invalid }),
        ).toThrow();
      }

      const userEntryId = Number(
        insertContext.run({
          resourceId,
          actor: "user",
          method: "manual",
          confidence: null,
          sourceFingerprint: null,
          modelJson: null,
          body: "User-authored note",
          revision: 1,
          key: "resource-context-user-note",
        }).lastInsertRowid,
      );
      const insertReview = database.connection.prepare(`
        INSERT INTO resource_context_entry_reviews (
          context_entry_id, verdict, reviewed_by, review_method,
          idempotency_key, created_at
        ) VALUES (?, 'accepted', 'user', 'manual', ?, ?)
      `);
      expect(() =>
        insertReview.run(
          userEntryId,
          "review-user-resource-context",
          "2026-08-12T12:01:00.000Z",
        ),
      ).toThrow(/only agent resource context/);

      const agentEntryId = Number(
        insertContext.run({
          resourceId,
          actor: "agent",
          method: "rule",
          confidence: 0.8,
          sourceFingerprint: "rule:fingerprint",
          modelJson: null,
          body: "Agent hypothesis",
          revision: 2,
          key: "resource-context-agent-note",
        }).lastInsertRowid,
      );
      expect(
        insertReview.run(
          agentEntryId,
          "review-agent-resource-context",
          "2026-08-12T12:01:00.000Z",
        ).changes,
      ).toBe(1);
      expect(
        insertContext.run({
          resourceId,
          actor: "agent",
          method: "model",
          confidence: 0.8,
          sourceFingerprint: "model:fingerprint",
          modelJson: JSON.stringify({
            provider: "fixture",
            name: "fixture-model",
            promptVersion: "v1",
          }),
          body: "Valid modeled hypothesis",
          revision: 3,
          key: "resource-context-valid-model",
        }).changes,
      ).toBe(1);
    } finally {
      database.close();
    }
  });
});
