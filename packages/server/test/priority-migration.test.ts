import { performance } from "node:perf_hooks";
import { readFile, readdir } from "node:fs/promises";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { normalizeUrl } from "../src/normalize-url.js";
import {
  baselinePriorityRuleAstHash,
  baselinePriorityRuleAstJson,
  parsePriorityRuleAst,
} from "../src/priority-engine.js";

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
  database.function("tabhub_migration_now", () => "2026-08-13T00:00:00.000Z");
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
    return [tableName, database.prepare(
      `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`,
    ).all()];
  }));
}

describe("migration 022 priority assessments", () => {
  it("creates schema 22 with one transparent baseline and no outcomes", () => {
    const migrationNow = "2026-08-13T00:00:00.000Z";
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(migrationNow),
    });

    try {
      expect(database.schemaVersion).toBe(26);
      expect(database.connection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%priority%'
        ORDER BY name
      `).pluck().all()).toEqual([
        "priority_assessments",
        "priority_exclusions",
        "priority_feedback",
        "priority_rule_versions",
        "priority_ruleset_activations",
        "priority_rulesets",
        "resource_priority_assessments",
        "resource_priority_exclusions",
        "resource_priority_feedback",
      ]);
      expect(database.connection.prepare(`
        SELECT id, name, created_at, updated_at FROM priority_rulesets
      `).get()).toEqual({
        id: 1,
        name: "TabHub baseline",
        created_at: migrationNow,
        updated_at: migrationNow,
      });
      expect(database.connection.prepare(`
        SELECT ruleset_id, version, created_by, created_at
        FROM priority_rule_versions
      `).get()).toEqual({
        ruleset_id: 1,
        version: 1,
        created_by: "agent",
        created_at: migrationNow,
      });
      const storedAst = database.connection.prepare(`
        SELECT rule_ast_json FROM priority_rule_versions
        WHERE ruleset_id = 1 AND version = 1
      `).pluck().get() as string;
      expect(storedAst).toBe(baselinePriorityRuleAstJson);
      expect(baselinePriorityRuleAstHash).toMatch(/^[0-9a-f]{64}$/);
      expect(database.connection.prepare(`
        SELECT scope, ruleset_id, version, activated_at
        FROM priority_ruleset_activations
      `).get()).toEqual({
        scope: "global",
        ruleset_id: 1,
        version: 1,
        activated_at: migrationNow,
      });
      for (const table of [
        "priority_assessments",
        "priority_exclusions",
        "priority_feedback",
        "resource_priority_assessments",
        "resource_priority_exclusions",
        "resource_priority_feedback",
      ]) {
        expect(database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get())
          .toBe(0);
      }
      expect(database.connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades exact schema 21 additively without changing an old table or row", async () => {
    const legacy = new Database(":memory:");
    registerMigrationDependencies(legacy);
    try {
      await applyThrough(legacy, 21);
      legacy.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          901, 'https://example.com/priority', 'https://example.com/priority',
          'https://example.com/priority', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        );
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (
          901, 3, 'user', 'manual', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        );
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (902, 'website:priority.example', '2026-08-01T00:00:00.000Z');
        INSERT INTO resource_preferences (
          resource_id, user_evaluation, recorded_by, record_method, updated_at
        ) VALUES (902, 2, 'user', 'manual', '2026-08-01T00:00:00.000Z');
      `);
      const before = snapshotExistingTables(legacy);
      const migration = await readFile(
        new URL("../migrations/022_priority_assessments.sql", import.meta.url),
        "utf8",
      );
      const startedAt = performance.now();
      legacy.transaction(() => {
        legacy.exec(migration);
        legacy.pragma("user_version = 22");
      })();
      const elapsedMs = performance.now() - startedAt;
      const after = snapshotExistingTables(legacy);

      for (const [tableName, rows] of Object.entries(before)) {
        expect(after[tableName], tableName).toEqual(rows);
      }
      expect(legacy.pragma("user_version", { simple: true })).toBe(22);
      expect(elapsedMs).toBeLessThan(60_000);
      expect(legacy.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it("enforces typed XOR, immutable history, strict provenance, and privacy cascades", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const connection = database.connection;
    const at = "2026-08-13T00:01:00.000Z";
    const fingerprint = "a".repeat(64);
    try {
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES
          (1, 'https://example.com/1', 'https://example.com/1',
           'https://example.com/1', '${at}', '${at}'),
          (2, 'https://example.com/2', 'https://example.com/2',
           'https://example.com/2', '${at}', '${at}');
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (901, 'website:one.example', '${at}');
      `);

      expect(() => connection.prepare(`
        INSERT INTO priority_rule_versions (
          ruleset_id, version, rule_ast_json, created_by, created_at
        ) VALUES (1, 2, 'not-json', 'agent', ?)
      `).run(at)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO priority_rule_versions (
          ruleset_id, version, rule_ast_json, created_by, created_at
        ) VALUES (1, 2, '{}', 'agent', ?)
      `).run(at)).toThrow();
      const insertRuleAst = connection.prepare(`
        INSERT INTO priority_rule_versions (
          ruleset_id, version, rule_ast_json, created_by, created_at
        ) VALUES (1, 2, ?, 'agent', ?)
      `);
      const baseline = JSON.parse(baselinePriorityRuleAstJson) as {
        policy: Record<string, unknown>;
        rules: Array<Record<string, unknown>>;
        schemaVersion: number;
        unknown?: boolean;
      };
      const malformedAsts: unknown[] = [
        { ...baseline, unknown: true },
        { ...baseline, rules: [{
          ruleKey: "invalid.missing-priority",
          label: "Missing required field",
          appliesTo: "both",
          when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
          effect: { scoreDelta: 1 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.boolean",
          priority: 1,
          label: "Invalid boolean",
          appliesTo: "both",
          when: { all: [{ signal: "is_open", operator: "gte", value: true }] },
          effect: { scoreDelta: 1 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.subject",
          priority: 1,
          label: "Invalid subject",
          appliesTo: "both",
          when: { all: [{ signal: "resource_page_count", operator: "gte", value: 1 }] },
          effect: { scoreDelta: 1 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.numeric-range",
          priority: 1,
          label: "Unsafe numeric condition",
          appliesTo: "both",
          when: { all: [{ signal: "relation_count", operator: "gte", value: 1e100 }] },
          effect: { scoreDelta: 1 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.set",
          priority: 1,
          label: "Invalid set",
          appliesTo: "both",
          when: { all: [{ signal: "status", operator: "in", value: ["inbox", "inbox"] }] },
          effect: { scoreDelta: 1 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.bounds",
          priority: 1,
          label: "Invalid bounds",
          appliesTo: "both",
          when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
          effect: { scoreFloor: 90, scoreCap: 20 },
        }] },
        { ...baseline, rules: [{
          ruleKey: "invalid.missing-content",
          priority: 1,
          label: "Invalid missing content",
          appliesTo: "both",
          when: { all: [{
            signal: "has_captured_content", operator: "eq", value: false,
          }] },
          effect: { scoreDelta: -1 },
        }] },
        { ...baseline, rules: [baseline.rules[0], baseline.rules[0]] },
      ];
      for (const malformed of malformedAsts) {
        expect(() => insertRuleAst.run(JSON.stringify(malformed), at)).toThrow();
      }
      const duplicateKeyAsts = [
        baselinePriorityRuleAstJson.replace(
          '"schemaVersion":1}',
          '"schemaVersion":1,"schemaVersion":1}',
        ),
        baselinePriorityRuleAstJson.replace(
          '"policy":{"bands":',
          '"policy":{"baseScore":40,"bands":',
        ),
        baselinePriorityRuleAstJson.replace(
          '"bands":{"criticalMin":85',
          '"bands":{"criticalMin":85,"criticalMin":85',
        ),
        baselinePriorityRuleAstJson.replace(
          '"priority":100,"ruleKey":"baseline.active-use-30d"',
          '"priority":100,"priority":100,"ruleKey":"baseline.active-use-30d"',
        ),
        baselinePriorityRuleAstJson.replace(
          '"when":{"all":[{"operator":"gte"',
          '"when":{"all":[],"all":[{"operator":"gte"',
        ),
        baselinePriorityRuleAstJson.replace(
          '"effect":{"confidenceDelta":0.1,"scoreDelta":10}',
          '"effect":{"confidenceDelta":0.1,"scoreDelta":10,"scoreDelta":10}',
        ),
        baselinePriorityRuleAstJson.replace(
          '{"operator":"gte","signal":"active_use_30d_ms"',
          '{"operator":"gte","operator":"gte","signal":"active_use_30d_ms"',
        ),
      ];
      for (const duplicateKeyAst of duplicateKeyAsts) {
        expect(() => insertRuleAst.run(duplicateKeyAst, at)).toThrow(/duplicate/i);
      }
      const scalarParityAst = baselinePriorityRuleAstJson
        .replace('"schemaVersion":1', '"schemaVersion":1.0')
        .replace('"baseScore":40', '"baseScore":40.0')
        .replace('"mediumMin":25', '"mediumMin":25.0')
        .replace('"highMin":60', '"highMin":60.0')
        .replace('"criticalMin":85', '"criticalMin":85.0')
        .replaceAll('"priority":100', '"priority":100.0')
        .replace(/"scoreDelta":(-?\d+)/g, (_match, value: string) =>
          `"scoreDelta":${value}.0`)
        .replace('"value":900000', '"value":900000.0')
        .replace('"value":1}', '"value":1.0}');
      expect(parsePriorityRuleAst(JSON.parse(scalarParityAst))).toMatchObject({
        schemaVersion: 1,
      });
      expect(insertRuleAst.run(scalarParityAst, at).changes).toBe(1);
      expect(() => connection.prepare(`
        UPDATE priority_rule_versions SET rule_ast_json = '{}'
        WHERE ruleset_id = 1 AND version = 1
      `).run()).toThrow(/immutable/);
      expect(() => connection.prepare(`
        DELETE FROM priority_rule_versions WHERE ruleset_id = 1 AND version = 1
      `).run()).toThrow(/immutable/);

      const insertAssessment = connection.prepare(`
        INSERT INTO priority_assessments (
          logical_page_id, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, model_provenance_json,
          revision, evaluated_at
        ) VALUES (?, 60, 'high', 0.75, 0, '[]', '[]', 1, 1, ?, ?, ?, 1, ?)
      `);
      const insertAssessmentJson = connection.prepare(`
        INSERT INTO priority_assessments (
          logical_page_id, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, revision, evaluated_at
        ) VALUES (1, 60, 'high', 0.75, 0, ?, ?, 1, 1, ?, 'rule', 1, ?)
      `);
      for (const [reasons, missing] of [
        ['[{"code":"x","code":"x","kind":"review","label":"x"}]', '[]'],
        ['[{"code":"x","kind":"review","label":"x","unknown":true}]', '[]'],
        ['[{"code":"x","kind":"review","label":"x"},{"code":"x","kind":"review","label":"y"}]', '[]'],
        ['[{"code":"x","kind":"unknown","label":"x"}]', '[]'],
        ['[]', '["unknown_signal"]'],
        ['[]', '["captured_content","captured_content"]'],
      ]) {
        expect(() => insertAssessmentJson.run(reasons, missing, fingerprint, at)).toThrow();
      }
      expect(() => insertAssessment.run(1, fingerprint, "model", null, at)).toThrow();
      expect(() => insertAssessment.run(
        1,
        fingerprint,
        "model",
        JSON.stringify({ provider: "p", name: "m", promptVersion: "v", secret: "x" }),
        at,
      )).toThrow();
      expect(() => insertAssessment.run(
        1,
        fingerprint,
        "model",
        '{"provider":"p","provider":"p","name":"m","promptVersion":"v"}',
        at,
      )).toThrow(/duplicate/i);
      expect(() => connection.prepare(`
        INSERT INTO priority_exclusions (
          logical_page_id, reason, detail_json, ruleset_id, ruleset_version,
          feature_fingerprint, revision, evaluated_at
        ) VALUES (2, 'policy_excluded', ?, 1, 1, ?, 1, ?)
      `).run('{"source":"rule","source":"rule"}', fingerprint, at)).toThrow(/duplicate/i);
      expect(() => connection.prepare(`
        INSERT INTO priority_assessments (
          logical_page_id, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, revision, evaluated_at
        ) VALUES (1, 60, 'medium', 0.75, 0, '[]', '[]', 1, 1, ?, 'rule', 1, ?)
      `).run(fingerprint, at)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO priority_assessments (
          logical_page_id, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, revision, evaluated_at
        ) VALUES (1, 60, 'high', 0.50, 0, '[]', '[]', 1, 1, ?, 'rule', 1, ?)
      `).run(fingerprint, at)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO resource_priority_assessments (
          resource_id, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, revision, evaluated_at
        ) VALUES (901, 60, 'high', 0.75, 0, '[]', '[]', 1, 1, ?, 'rule', 1, ?)
      `).run(fingerprint, at)).toThrow(/current active resource/);
      expect(insertAssessment.run(1, fingerprint, "rule", null, at).changes).toBe(1);
      expect(() => connection.prepare(`
        UPDATE priority_assessments SET agent_score = 61 WHERE logical_page_id = 1
      `).run()).toThrow(/append-only/);
      expect(() => connection.prepare(`
        INSERT INTO priority_exclusions (
          logical_page_id, reason, detail_json, ruleset_id, ruleset_version,
          feature_fingerprint, revision, evaluated_at
        ) VALUES (1, 'policy_excluded', '{}', 1, 1, ?, 2, ?)
      `).run(fingerprint, at)).toThrow(/assessment XOR exclusion/);

      connection.prepare(`
        UPDATE priority_assessments SET superseded_at = ? WHERE logical_page_id = 1
      `).run(at);
      expect(connection.prepare(`
        INSERT INTO priority_exclusions (
          logical_page_id, reason, detail_json, ruleset_id, ruleset_version,
          feature_fingerprint, revision, evaluated_at
        ) VALUES (1, 'policy_excluded', '{}', 1, 1, ?, 2, ?)
      `).run(fingerprint, at).changes).toBe(1);
      expect(() => connection.prepare(`
        UPDATE priority_assessments SET superseded_at = ? WHERE logical_page_id = 1
      `).run("2026-08-13T00:02:00.000Z")).toThrow(/append-only/);

      const secondAssessment = insertAssessment.run(2, fingerprint, "rule", null, at);
      expect(secondAssessment.changes).toBe(1);
      const assessmentId = Number(secondAssessment.lastInsertRowid);
      expect(connection.prepare(`
        INSERT INTO priority_feedback (
          logical_page_id, assessment_id, verdict, actor, method,
          authorization_ref, idempotency_key, request_fingerprint,
          revision, created_at
        ) VALUES (2, ?, 'accept', 'user', 'manual', NULL, 'feedback-1', ?, 1, ?)
      `).run(assessmentId, fingerprint, at).changes).toBe(1);
      expect(() => connection.prepare(`
        INSERT INTO resource_priority_feedback (
          resource_id, assessment_id, verdict, actor, method,
          authorization_ref, idempotency_key, request_fingerprint,
          revision, created_at
        ) VALUES (901, 1, 'accept', 'user', 'manual', NULL, 'feedback-1', ?, 1, ?)
      `).run(fingerprint, at)).toThrow(/idempotency key already used/);

      expect(() => connection.prepare(`
        DELETE FROM priority_assessments WHERE logical_page_id = 2
      `).run()).toThrow(/privacy deletion/);
      expect(() => connection.prepare(`
        DELETE FROM priority_feedback WHERE logical_page_id = 2
      `).run()).toThrow(/privacy deletion/);

      connection.prepare("DELETE FROM logical_pages WHERE id = 2").run();
      expect(connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments WHERE logical_page_id = 2
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM priority_feedback WHERE logical_page_id = 2
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM priority_rule_versions
      `).pluck().get()).toBe(2);
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("fails closed for canonical timestamps and integer storage contracts", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const connection = database.connection;
    try {
      expect(() => connection.exec(`
        INSERT INTO priority_rulesets (id, name, created_at, updated_at)
        VALUES (2, 'Bad clock', 'not-a-date', 'not-a-date')
      `)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO priority_ruleset_activations (
          scope, ruleset_id, version, activated_at
        ) VALUES (NULL, 1, 1, ?)
      `).run("2026-08-13T00:01:00.000Z")).toThrow();

      const schemas = Object.fromEntries((connection.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'priority_rulesets', 'priority_rule_versions', 'priority_ruleset_activations',
          'priority_assessments', 'resource_priority_assessments',
          'priority_exclusions', 'resource_priority_exclusions',
          'priority_feedback', 'resource_priority_feedback'
        )
      `).all() as Array<{ name: string; sql: string }>).map(({ name, sql }) => [name, sql]));
      const timestampFields: Record<string, readonly string[]> = {
        priority_rulesets: ["created_at", "updated_at"],
        priority_rule_versions: ["created_at"],
        priority_ruleset_activations: ["activated_at"],
        priority_assessments: ["evaluated_at", "superseded_at"],
        resource_priority_assessments: ["evaluated_at", "superseded_at"],
        priority_exclusions: ["evaluated_at", "superseded_at"],
        resource_priority_exclusions: ["evaluated_at", "superseded_at"],
        priority_feedback: ["created_at", "superseded_at"],
        resource_priority_feedback: ["created_at", "superseded_at"],
      };
      for (const [table, fields] of Object.entries(timestampFields)) {
        for (const field of fields) {
          expect(schemas[table], `${table}.${field}`).toMatch(new RegExp(
            `${field}\\s+TEXT[\\s\\S]{0,30}CHECK\\s*\\(\\s*COALESCE`,
          ));
        }
      }

      const integerFields: Record<string, readonly string[]> = {
        priority_rule_versions: ["ruleset_id", "version"],
        priority_ruleset_activations: ["ruleset_id", "version"],
        priority_assessments: ["logical_page_id", "ruleset_id", "ruleset_version", "revision"],
        resource_priority_assessments: ["resource_id", "ruleset_id", "ruleset_version", "revision"],
        priority_exclusions: ["logical_page_id", "ruleset_id", "ruleset_version", "revision"],
        resource_priority_exclusions: ["resource_id", "ruleset_id", "ruleset_version", "revision"],
        priority_feedback: ["logical_page_id", "assessment_id", "supersedes_id", "revision"],
        resource_priority_feedback: ["resource_id", "assessment_id", "supersedes_id", "revision"],
      };
      for (const [table, fields] of Object.entries(integerFields)) {
        for (const field of fields) {
          expect(schemas[table], `${table}.${field}`).toContain(`typeof(${field}) = 'integer'`);
        }
      }
    } finally {
      database.close();
    }
  });
});
