import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";

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
  database.function("tabhub_migration_now", () => "2026-08-13T01:00:00.000Z");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function snapshotExistingTables(database: Database.Database): Record<string, unknown[]> {
  const names = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).pluck().all() as string[];
  return Object.fromEntries(names.map((name) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all() as Array<{ name: string }>;
    const order = columns.map(({ name: column }) => quoteIdentifier(column)).join(", ");
    return [name, database.prepare(
      `SELECT * FROM ${quoteIdentifier(name)} ORDER BY ${order}`,
    ).all()];
  }));
}

describe("migration 023 durable AI jobs", () => {
  it("creates the job ledger plus the narrow mutation receipt and keeps the legacy queue", async () => {
    const database = new Database(":memory:");
    registerMigrationDependencies(database);
    await applyThrough(database, 23);
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(23);
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'jobs', 'summary_job_attempts', 'ai_job_runtime_state',
          'ai_jobs', 'ai_job_attempts', 'ai_job_events',
          'agent_user_importance_receipts'
        ) ORDER BY name
      `).pluck().all();
      expect(tables).toEqual([
        "agent_user_importance_receipts",
        "ai_job_attempts",
        "ai_job_events",
        "ai_job_runtime_state",
        "ai_jobs",
        "jobs",
        "summary_job_attempts",
      ]);
      expect(database.prepare(`
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name IN ('research_runs', 'research_reports')
      `).pluck().get()).toBe(0);
      const forbiddenColumns = database.prepare(`
        SELECT name FROM pragma_table_info('ai_jobs')
        WHERE name IN ('prompt', 'content', 'context', 'corpus', 'detail')
      `).pluck().all();
      expect(forbiddenColumns).toEqual([]);
      expect(database.prepare(`
        SELECT COUNT(*) FROM pragma_table_info('ai_job_attempts')
        WHERE name = 'pricing_version'
      `).pluck().get()).toBe(0);
      expect(database.prepare(`
        SELECT singleton_id, cursor, updated_at FROM ai_job_runtime_state
      `).get()).toMatchObject({ singleton_id: 1, cursor: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) FROM agent_user_importance_receipts
      `).pluck().get()).toBe(0);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps one bounded monotonic scheduler cursor at schema 23", () => {
    const at = "2026-08-13T01:00:00.000Z";
    const later = "2026-08-13T01:00:01.000Z";
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    const connection = database.connection;
    try {
      expect(connection.prepare("SELECT * FROM ai_job_runtime_state").all()).toEqual([{
        singleton_id: 1,
        cursor: 0,
        updated_at: at,
      }]);
      expect(connection.prepare(`
        UPDATE ai_job_runtime_state SET cursor = 6, updated_at = ? WHERE singleton_id = 1
      `).run(later).changes).toBe(1);
      for (const sql of [
        "UPDATE ai_job_runtime_state SET cursor = 7",
        "UPDATE ai_job_runtime_state SET cursor = 1.5",
        "UPDATE ai_job_runtime_state SET singleton_id = 2",
        `UPDATE ai_job_runtime_state SET updated_at = '${at}'`,
        "DELETE FROM ai_job_runtime_state",
        `INSERT INTO ai_job_runtime_state VALUES (2, 0, '${later}')`,
      ]) {
        expect(() => connection.exec(sql), sql).toThrow();
      }
      expect(connection.prepare("SELECT * FROM ai_job_runtime_state").get()).toEqual({
        singleton_id: 1,
        cursor: 6,
        updated_at: later,
      });
      expect(() => connection.prepare(`
        INSERT OR REPLACE INTO ai_job_runtime_state
          (singleton_id, cursor, updated_at) VALUES (1, 2, ?)
      `).run(at)).toThrow();
      expect(connection.prepare("SELECT * FROM ai_job_runtime_state").get()).toEqual({
        singleton_id: 1,
        cursor: 6,
        updated_at: later,
      });
    } finally {
      database.close();
    }
  });

  it("keeps agent user-importance receipts bounded, append-only, and secret-free", () => {
    const database = openDatabase(":memory:");
    const connection = database.connection;
    const at = "2026-08-13T01:00:00.000Z";
    try {
      connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (1, 'https://receipt.test/', 'https://receipt.test/',
          'https://receipt.test/', ?, ?)
      `).run(at, at);
      const insert = connection.prepare(`
        INSERT INTO agent_user_importance_receipts (
          idempotency_key_hash, request_fingerprint, authorization_ref_hash,
          subject_type,
          logical_page_id, resource_id, value, result_json,
          result_updated_at, created_at
        ) VALUES (?, ?, ?, 'page', 1, NULL, 3, ?, ?, ?)
      `);
      const result = JSON.stringify({
        subject: { type: "page", logicalPageId: 1 },
        value: 3,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
        updatedAt: at,
      });
      insert.run("a".repeat(64), "b".repeat(64), "c".repeat(64), result, at, at);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM agent_user_importance_receipts",
      ).pluck().get()).toBe(1);
      for (const sql of [
        "UPDATE agent_user_importance_receipts SET value=2",
        "DELETE FROM agent_user_importance_receipts",
      ]) expect(() => connection.exec(sql)).toThrow();
      for (const invalid of [
        ["short", "b".repeat(64), "c".repeat(64), result],
        ["c".repeat(64), "not-a-fingerprint", "d".repeat(64), result],
        ["d".repeat(64), "e".repeat(64), "not-an-auth-hash", result],
        ["e".repeat(64), "f".repeat(64), "0".repeat(64),
          `{"padding":"${"x".repeat(4096)}"}`],
      ] as const) {
        expect(() => insert.run(
          invalid[0], invalid[1], invalid[2], invalid[3], at, at,
        ))
          .toThrow();
      }
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("rejects receipt creation before its result while accepting equal or later creation", () => {
    const database = openDatabase(":memory:");
    const connection = database.connection;
    const at = "2026-08-13T01:00:00.000Z";
    const later = "2026-08-13T01:00:01.000Z";
    try {
      connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (1, 'https://receipt-time.test/', 'https://receipt-time.test/',
          'https://receipt-time.test/', ?, ?)
      `).run(at, at);
      const insert = connection.prepare(`
        INSERT INTO agent_user_importance_receipts (
          idempotency_key_hash, request_fingerprint, authorization_ref_hash,
          subject_type, logical_page_id, resource_id, value, result_json,
          result_updated_at, created_at
        ) VALUES (?, ?, ?, 'page', 1, NULL, 3, '{}', ?, ?)
      `);

      expect(() => insert.run(
        "a".repeat(64), "b".repeat(64), "c".repeat(64), later, at,
      )).toThrow();
      expect(insert.run(
        "d".repeat(64), "e".repeat(64), "f".repeat(64), at, at,
      ).changes).toBe(1);
      expect(insert.run(
        "0".repeat(64), "1".repeat(64), "2".repeat(64), at, later,
      ).changes).toBe(1);
      expect(connection.prepare(`
        SELECT result_updated_at, created_at
        FROM agent_user_importance_receipts ORDER BY created_at, idempotency_key_hash
      `).all()).toEqual([
        { result_updated_at: at, created_at: at },
        { result_updated_at: at, created_at: later },
      ]);
    } finally {
      database.close();
    }
  });

  it("upgrades schema 22 without changing legacy jobs, attempts, or content FKs", async () => {
    const database = new Database(":memory:");
    registerMigrationDependencies(database);
    try {
      await applyThrough(database, 22);
      database.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          61, 'https://example.com/summary', 'https://example.com/summary',
          'https://example.com/summary', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        );
        INSERT INTO tabs (
          id, url, url_normalized, browser, first_seen_at, last_seen_at,
          logical_page_id
        ) VALUES (
          71, 'https://example.com/summary', 'https://example.com/summary',
          'chrome', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 61
        );
        INSERT INTO jobs (
          id, kind, tab_id, requested_by, depth, requested_model,
          source_content_revision, status, attempts, max_attempts,
          available_at, created_at, updated_at
        ) VALUES (
          81, 'summary', 71, 'user', 'short', 'summary-model', 1,
          'running', 1, 3, '2026-08-13T01:00:00.000Z',
          '2026-08-13T01:00:00.000Z', '2026-08-13T01:00:00.000Z'
        );
        INSERT INTO summary_job_attempts (
          id, job_id, attempt_no, started_at, outcome, model
        ) VALUES (91, 81, 1, '2026-08-13T01:00:00.000Z', 'running', 'summary-model');
        INSERT INTO contents (tab_id, text, summary_job_id)
        VALUES (71, 'captured', 81);
      `);
      const beforeJobs = database.prepare("SELECT * FROM jobs").all();
      const beforeAttempts = database.prepare("SELECT * FROM summary_job_attempts").all();
      const beforeContents = database.prepare("SELECT * FROM contents").all();
      const beforeContentsFk = database.prepare("PRAGMA foreign_key_list(contents)").all();
      const beforeAllTables = snapshotExistingTables(database);
      const beforeLegacyDdl = database.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name IN (
          'jobs', 'summary_job_attempts', 'contents',
          'jobs_one_active_summary_per_tab_idx'
        ) ORDER BY type, name
      `).all();

      const startedAt = performance.now();
      const migration = await readFile(
        new URL("../migrations/023_ai_jobs.sql", import.meta.url),
        "utf8",
      );
      database.transaction(() => {
        database.exec(migration);
        database.pragma("user_version = 23");
      })();
      const elapsedMs = performance.now() - startedAt;

      expect(database.prepare("SELECT * FROM jobs").all()).toEqual(beforeJobs);
      expect(database.prepare("SELECT * FROM summary_job_attempts").all()).toEqual(beforeAttempts);
      expect(database.prepare("SELECT * FROM contents").all()).toEqual(beforeContents);
      expect(database.prepare("PRAGMA foreign_key_list(contents)").all()).toEqual(beforeContentsFk);
      const afterAllTables = snapshotExistingTables(database);
      for (const [name, rows] of Object.entries(beforeAllTables)) {
        expect(afterAllTables[name], name).toEqual(rows);
      }
      expect(database.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name IN (
          'jobs', 'summary_job_attempts', 'contents',
          'jobs_one_active_summary_per_tab_idx'
        ) ORDER BY type, name
      `).all()).toEqual(beforeLegacyDdl);
      expect(Object.keys(afterAllTables).filter((name) => !(name in beforeAllTables)))
        .toEqual([
          "agent_user_importance_receipts",
          "ai_job_attempts",
          "ai_job_events",
          "ai_job_idempotency_receipts",
          "ai_job_runtime_state",
          "ai_jobs",
        ]);
      expect(elapsedMs).toBeLessThan(60_000);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces job identity, provenance, lifecycle, event ownership, and strict values", () => {
    const database = openDatabase(":memory:");
    const connection = database.connection;
    const at = "2026-08-13T01:00:00.000Z";
    const later = "2026-08-13T01:00:01.000Z";
    const expiry = "2026-08-13T01:01:01.000Z";
    try {
      const insert = connection.prepare(`
        INSERT INTO ai_jobs (
          kind, subject_type, collection_scope, subject_key,
          requested_by, request_method, authorization_ref,
          idempotency_key, submission_fingerprint, input_fingerprint,
          ruleset_id, ruleset_version, assessment_method,
          assessment_model_provider, assessment_model_name,
          assessment_prompt_version,
          step_batch_size, scheduling_priority,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          @kind, @subjectType, @collectionScope, @subjectKey,
          @requestedBy, @requestMethod, @authorizationRef,
          @idempotencyKey, @submissionFingerprint, @inputFingerprint,
          @rulesetId, @rulesetVersion, @assessmentMethod,
          @assessmentModelProvider, @assessmentModelName,
          @assessmentPromptVersion,
          @stepBatchSize, @schedulingPriority,
          @maxSteps, @maxTokens, @maxCostUsd, @maxWallTimeMs,
          @availableAt, @createdAt, @updatedAt
        )
      `);
      const valid = {
        kind: "priority_assessment",
        subjectType: "collection",
        collectionScope: "all",
        subjectKey: "collection:all",
        requestedBy: "user",
        requestMethod: "manual",
        authorizationRef: null,
        idempotencyKey: "migration-contract-1",
        submissionFingerprint: "a".repeat(64),
        inputFingerprint: "b".repeat(64),
        rulesetId: 1,
        rulesetVersion: 1,
        assessmentMethod: "rule",
        assessmentModelProvider: null,
        assessmentModelName: null,
        assessmentPromptVersion: null,
        stepBatchSize: 100,
        schedulingPriority: 0,
        maxSteps: 100,
        maxTokens: 0,
        maxCostUsd: 0,
        maxWallTimeMs: 60_000,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      };
      const inserted = insert.run(valid);
      const jobId = Number(inserted.lastInsertRowid);
      expect(() => connection.prepare(`
        INSERT INTO ai_jobs (
          kind, subject_type, collection_scope, subject_key,
          requested_by, request_method, idempotency_key,
          submission_fingerprint, input_fingerprint, step_batch_size,
          scheduling_priority, status, result_type, result_output_fingerprint,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at, completed_at
        ) VALUES (
          'priority_assessment', 'collection', 'all', 'collection:all',
          'system', 'scheduled', 'smuggled-terminal', ?, ?, 100,
          0, 'succeeded', 'priority_output', ?,
          100, 0, 0, 60000, ?, ?, ?, ?
        )
      `).run("1".repeat(64), "2".repeat(64), "3".repeat(64), at, at, at, later))
        .toThrow();
      expect(connection.prepare(`
        SELECT status, attempts, event_sequence FROM ai_jobs WHERE id = ?
      `).get(jobId)).toEqual({ status: "queued", attempts: 0, event_sequence: 1 });
      expect(connection.prepare(`
        SELECT sequence_no, event_type, from_status, to_status
        FROM ai_job_events WHERE job_id = ?
      `).get(jobId)).toEqual({
        sequence_no: 1,
        event_type: "submitted",
        from_status: null,
        to_status: "queued",
      });

      for (const [label, changes] of [
        ["fractional step size", { stepBatchSize: 1.5, idempotencyKey: "bad-1" }],
        ["oversized step", { stepBatchSize: 101, idempotencyKey: "bad-2" }],
        ["unsafe integer", { maxSteps: 9_007_199_254_740_992, idempotencyKey: "bad-3" }],
        ["wrong subject key", { subjectKey: "page:1", idempotencyKey: "bad-4" }],
        ["wrong provenance", {
          requestedBy: "agent", requestMethod: "on_behalf_of_user",
          authorizationRef: null, idempotencyKey: "bad-5",
        }],
        ["missing ruleset", { rulesetId: null, idempotencyKey: "bad-6" }],
        ["unknown ruleset version", { rulesetVersion: 999, idempotencyKey: "bad-7" }],
        ["rule with model provenance", {
          assessmentModelProvider: "openai", idempotencyKey: "bad-8",
        }],
        ["model without complete provenance", {
          assessmentMethod: "model", assessmentModelProvider: "openai",
          idempotencyKey: "bad-9",
        }],
        ["noncanonical time", {
          createdAt: "2026-08-13T01:00:00Z", updatedAt: "2026-08-13T01:00:00Z",
          availableAt: "2026-08-13T01:00:00Z", idempotencyKey: "bad-10",
        }],
      ] as const) {
        expect(() => insert.run({ ...valid, ...changes }), label).toThrow();
      }

      expect(() => connection.prepare(`
        UPDATE ai_jobs SET status = 'succeeded', completed_at = ? WHERE id = ?
      `).run(later, jobId)).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_jobs SET progress_completed = 1 WHERE id = ?
      `).run(jobId)).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_jobs SET idempotency_key = 'mutated-key' WHERE id = ?
      `).run(jobId)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 3, 'cancelled', 'queued', 'cancelled', ?)
      `).run(jobId, later)).toThrow();
      connection.exec("SAVEPOINT queued_superseded_payload");
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', 999,
          'forged-queued-lease', ?)
      `).run(jobId, later)).toThrow();
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(jobId, later);
      expect(connection.prepare(`
        SELECT status FROM ai_jobs WHERE id = ?
      `).pluck().get(jobId)).toBe("superseded");
      connection.exec("ROLLBACK TO queued_superseded_payload");
      connection.exec("RELEASE queued_superseded_payload");

      const attempt = connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, 1, ?, 'worker-1', ?, 'running')
      `).run(jobId, "lease-token-0001", later);
      const attemptId = Number(attempt.lastInsertRowid);
      expect(connection.prepare(`
        SELECT status, attempts, lease_owner, lease_token, lease_expires_at,
          event_sequence FROM ai_jobs WHERE id = ?
      `).get(jobId)).toEqual({
        status: "running",
        attempts: 1,
        lease_owner: "worker-1",
        lease_token: "lease-token-0001",
        lease_expires_at: expiry,
        event_sequence: 2,
      });
      expect(() => connection.prepare(`
        UPDATE ai_jobs SET lease_expires_at = '2026-08-13T01:02:00.000Z'
        WHERE id = ?
      `).run(jobId)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, 2, 'lease-token-0002', 'worker-2', ?, 'running')
      `).run(jobId, later)).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts
        SET completed_at = ?, outcome = 'succeeded'
        WHERE id = ?
      `).run("2026-08-13T01:00:01.500Z", attemptId)).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts SET cost_usd = 0.25 WHERE id = ?
      `).run(attemptId)).toThrow();
      connection.exec("SAVEPOINT running_superseded_payload");
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, occurred_at
        ) VALUES (?, 3, 'superseded', 'running', 'superseded', ?,
          'forged-running-lease', ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, occurred_at
        ) VALUES (?, 3, 'superseded', 'running', 'superseded', ?,
          'lease-token-0001', ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z");
      expect(connection.prepare(`
        SELECT status FROM ai_jobs WHERE id = ?
      `).pluck().get(jobId)).toBe("superseded");
      connection.exec("ROLLBACK TO running_superseded_payload");
      connection.exec("RELEASE running_superseded_payload");

      const researchJobId = Number(connection.prepare(`
        INSERT INTO ai_jobs (
          kind, subject_type, selection_fingerprint, subject_key,
          requested_by, request_method, idempotency_key,
          submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          'resource_research', 'selection', ?, ?, 'system', 'scheduled',
          'composite-owner-research', ?, ?, 'captured-only', 1, 0,
          10, 1000, 1, 60000, ?, ?, ?
        )
      `).run(
        "9".repeat(64), `selection:${"9".repeat(64)}`,
        "8".repeat(64), "7".repeat(64), later, later, later,
      ).lastInsertRowid);
      const researchAttemptId = Number(connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, 1, 'lease-research-0001', 'research-worker', ?, 'running')
      `).run(researchJobId, later).lastInsertRowid);
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts
        SET provider = 'fixture', model = 'research-model',
          prompt_version = 'research-v1', provider_bound_at = ?
        WHERE id = ?
      `).run(later, researchAttemptId)).toThrow(/pricing/i);
      connection.prepare(`
        UPDATE ai_job_attempts
        SET provider = 'fixture', model = 'research-model',
          prompt_version = 'research-v1', pricing_version = 'pricing-v1',
          provider_bound_at = ?
        WHERE id = ?
      `).run(later, researchAttemptId);
      expect(connection.prepare(`
        SELECT pricing_version FROM ai_job_attempts WHERE id = ?
      `).pluck().get(researchAttemptId)).toBe("pricing-v1");
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts SET pricing_version = 'pricing-v2' WHERE id = ?
      `).run(researchAttemptId)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_stage,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          spent_cost_usd, spent_wall_time_ms,
          occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 'cross-owner', 1, 0, 0, 0, 0, 1, ?)
      `).run(jobId, researchAttemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      expect(connection.prepare(`
        SELECT COUNT(*) FROM pragma_foreign_key_list('ai_job_events')
        WHERE "table" = 'ai_job_attempts'
      `).pluck().get()).toBe(2);

      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          spent_cost_usd, spent_wall_time_ms,
          occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'stale-token-0000', 1, 'batch', '{"version":1,"nextOffset":1}',
          1, 0, 0, 0, 0, 1, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          spent_cost_usd, spent_wall_time_ms,
          occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 'batch', '{"version":1,"nextOffset":1}',
          1, 0, 0, 0, 0, 1, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          spent_cost_usd, spent_wall_time_ms,
          occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 'batch',
          '{"version":1,"nextOffset":1,"nextOffset":2}', 1, 0, 0, 0, 0, 1, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_total, progress_stage,
          checkpoint_json, spent_steps, spent_tokens, spent_input_tokens,
          spent_output_tokens, spent_cost_usd, spent_wall_time_ms,
          delta_steps, delta_input_tokens, delta_output_tokens,
          delta_cost_usd, delta_wall_time_ms, occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 10, 'bad-delta',
          '{"nextOffset":1,"version":1}', 1, 0, 0, 0, 0, 1,
          2, 0, 0, 0, 1, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z")).toThrow();
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_total, progress_stage,
          checkpoint_json, spent_steps, spent_tokens, spent_input_tokens,
          spent_output_tokens, spent_cost_usd, spent_wall_time_ms,
          delta_steps, delta_input_tokens, delta_output_tokens,
          delta_cost_usd, delta_wall_time_ms, occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 10, 'batch',
          '{"nextOffset":1,"version":1}', 1, 0, 0, 0, 0, 1,
          1, 0, 0, 0, 1, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:02.000Z");
      expect(() => connection.prepare(`
        UPDATE ai_job_events SET event_type = 'failed' WHERE job_id = ? AND sequence_no = 3
      `).run(jobId)).toThrow();
      expect(() => connection.prepare(`
        DELETE FROM ai_job_events WHERE job_id = ? AND sequence_no = 3
      `).run(jobId)).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_report_id, occurred_at
        ) VALUES (?, 4, 'succeeded', 'running', 'succeeded', ?,
          'lease-token-0001', 'research_report', 4, ?)
      `).run(jobId, attemptId, "2026-08-13T01:00:03.000Z")).toThrow();
      const partialInsert = connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_output_fingerprint, error_code,
          occurred_at
        ) VALUES (?, 4, 'partial', 'running', 'partial', ?,
          'lease-token-0001', 'priority_output', ?, ?, ?)
      `);
      const finalProgress = connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_total, progress_stage,
          checkpoint_json, spent_steps, spent_tokens, spent_input_tokens,
          spent_output_tokens, spent_cost_usd, spent_wall_time_ms,
          delta_steps, delta_input_tokens, delta_output_tokens,
          delta_cost_usd, delta_wall_time_ms, occurred_at
        ) VALUES (?, 4, 'progress', 'running', 'running', ?,
          'lease-token-0001', 1, 10, 'final-checkpoint',
          '{"nextOffset":1,"version":1}', 1, 0, 0, 0, 0, 1,
          0, 0, 0, 0, 0, ?)
      `);
      const validPartialInsert = connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_output_fingerprint, error_code,
          occurred_at
        ) VALUES (?, 5, 'partial', 'running', 'partial', ?,
          'lease-token-0001', 'priority_output', ?, 'JOB_BUDGET_EXHAUSTED', ?)
      `);
      expect(() => partialInsert.run(
        jobId, attemptId, "c".repeat(64), null,
        "2026-08-13T01:00:03.000Z",
      )).toThrow();
      expect(() => partialInsert.run(
        jobId, attemptId, "c".repeat(64), "JOB_INPUT_UNAVAILABLE",
        "2026-08-13T01:00:03.000Z",
      )).toThrow();
      expect(() => connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_output_fingerprint, error_code,
          occurred_at
        ) VALUES (?, 4, 'succeeded', 'running', 'succeeded', ?,
          'lease-token-0001', 'priority_output', ?, 'JOB_BUDGET_EXHAUSTED', ?)
      `).run(
        jobId, attemptId, "c".repeat(64), "2026-08-13T01:00:03.000Z",
      )).toThrow();
      connection.exec("SAVEPOINT valid_priority_partial");
      finalProgress.run(jobId, attemptId, "2026-08-13T01:00:03.000Z");
      validPartialInsert.run(
        jobId, attemptId, "c".repeat(64), "2026-08-13T01:00:03.000Z",
      );
      expect(connection.prepare(`
        SELECT status, result_type, result_output_fingerprint, error_code
        FROM ai_jobs WHERE id = ?
      `).get(jobId)).toEqual({
        status: "partial",
        result_type: "priority_output",
        result_output_fingerprint: "c".repeat(64),
        error_code: "JOB_BUDGET_EXHAUSTED",
      });
      expect(connection.prepare(`
        SELECT outcome, error_code FROM ai_job_attempts WHERE id = ?
      `).get(attemptId)).toEqual({
        outcome: "partial",
        error_code: "JOB_BUDGET_EXHAUSTED",
      });
      connection.exec("ROLLBACK TO valid_priority_partial");
      connection.exec("RELEASE valid_priority_partial");
      finalProgress.run(jobId, attemptId, "2026-08-13T01:00:03.000Z");
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_output_fingerprint, occurred_at
        ) VALUES (?, 5, 'succeeded', 'running', 'succeeded', ?,
          'lease-token-0001', 'priority_output', ?, ?)
      `).run(jobId, attemptId, "c".repeat(64), "2026-08-13T01:00:03.000Z");
      expect(connection.prepare(`
        SELECT outcome, completed_at FROM ai_job_attempts WHERE id = ?
      `).get(attemptId)).toEqual({
        outcome: "succeeded",
        completed_at: "2026-08-13T01:00:03.000Z",
      });
      expect(connection.prepare(`
        SELECT status, completed_at, lease_token, result_type,
          result_output_fingerprint FROM ai_jobs WHERE id = ?
      `).get(jobId)).toEqual({
        status: "succeeded",
        completed_at: "2026-08-13T01:00:03.000Z",
        lease_token: null,
        result_type: "priority_output",
        result_output_fingerprint: "c".repeat(64),
      });
      const modelAt = "2026-08-13T01:00:04.000Z";
      const modelProgressAt = "2026-08-13T01:00:05.000Z";
      const modelJobId = Number(insert.run({
        ...valid,
        idempotencyKey: "model-provenance-contract",
        submissionFingerprint: "4".repeat(64),
        inputFingerprint: "5".repeat(64),
        assessmentMethod: "model",
        assessmentModelProvider: "openai",
        assessmentModelName: "gpt-5",
        assessmentPromptVersion: "priority-v1",
        createdAt: modelAt,
        updatedAt: modelAt,
        availableAt: modelAt,
      }).lastInsertRowid);
      const modelAttemptId = Number(connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, 1, 'model-lease-token-0001', 'model-worker', ?, 'running')
      `).run(modelJobId, modelAt).lastInsertRowid);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, progress_completed, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          spent_cost_usd, spent_wall_time_ms, delta_steps, delta_input_tokens,
          delta_output_tokens, delta_cost_usd, delta_wall_time_ms, occurred_at
        ) VALUES (?, 3, 'progress', 'running', 'running', ?,
          'model-lease-token-0001', 0, 'final-checkpoint',
          '{"nextOffset":0,"version":1}', 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, ?)
      `).run(modelJobId, modelAttemptId, modelProgressAt);
      const modelSuccess = connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, attempt_id,
          lease_token, result_type, result_output_fingerprint, occurred_at
        ) VALUES (?, 4, 'succeeded', 'running', 'succeeded', ?,
          'model-lease-token-0001', 'priority_output', ?, ?)
      `);
      expect(() => modelSuccess.run(
        modelJobId, modelAttemptId, "6".repeat(64), modelProgressAt,
      )).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts SET provider = 'openai' WHERE id = ?
      `).run(modelAttemptId)).toThrow();
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts SET provider = 'other', model = 'gpt-5',
          prompt_version = 'priority-v1', provider_bound_at = ? WHERE id = ?
      `).run(modelProgressAt, modelAttemptId)).toThrow();
      expect(connection.prepare(`
        SELECT status, event_sequence FROM ai_jobs WHERE id = ?
      `).get(modelJobId)).toEqual({ status: "running", event_sequence: 3 });
      connection.prepare(`
        UPDATE ai_job_attempts SET provider = 'openai', model = 'gpt-5',
          prompt_version = 'priority-v1', provider_bound_at = ? WHERE id = ?
      `).run(modelProgressAt, modelAttemptId);
      expect(connection.prepare(`
        SELECT pricing_version FROM ai_job_attempts WHERE id = ?
      `).pluck().get(modelAttemptId)).toBeNull();
      modelSuccess.run(modelJobId, modelAttemptId, "6".repeat(64), modelProgressAt);
      expect(insert.run({
        ...valid,
        requestedBy: "system",
        requestMethod: "scheduled",
        authorizationRef: null,
        idempotencyKey: "scheduled-contract-1",
        submissionFingerprint: "d".repeat(64),
        inputFingerprint: "e".repeat(64),
        createdAt: "2026-08-13T01:00:07.000Z",
        updatedAt: "2026-08-13T01:00:07.000Z",
        availableAt: "2026-08-13T01:00:07.000Z",
      }).changes).toBe(1);
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
