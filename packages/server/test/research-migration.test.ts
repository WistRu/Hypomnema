import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { estimateResearchReservationV1 } from "@tabhub/shared";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import {
  buildCurrentResearchDraft,
  createResearchStore,
  fingerprintResearchApproval,
} from "../src/research-store.js";

const temporaryDirectories: string[] = [];
const at = "2026-08-13T14:00:00.000Z";
const budget = { maxSteps: 10, maxTokens: 1_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSchema23(databasePath: string): Database.Database {
  const connection = new Database(databasePath);
  sqliteVec.load(connection);
  connection.function("tabhub_normalize_url_v2", { deterministic: true }, (value: string) => value);
  connection.function("tabhub_migration_now", () => "2026-08-13T13:00:00.000Z");
  const migrationsDirectory = join(process.cwd(), "migrations");
  for (const name of readdirSync(migrationsDirectory)
    .filter((entry) => /^\d{3}_.+\.sql$/.test(entry) && Number(entry.slice(0, 3)) <= 23)
    .sort()) {
    connection.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
    connection.pragma(`user_version = ${Number(name.slice(0, 3))}`);
  }
  connection.pragma("foreign_keys = ON");
  return connection;
}

function publishResearchReport(
  connection: Database.Database,
  reportText: string,
): { reportId: number; redact: () => void } {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      41, 'https://research.openai.com/report', 'https://research.openai.com/report',
      'https://research.openai.com/report', '${at}', '${at}'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      71, 'https://research.openai.com/report', 'https://research.openai.com/report',
      'Research report fixture', 'chrome', 'inbox', 0, 1, '${at}', '${at}', 41
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (71, 'captured migration evidence', '${at}', 1);
  `);
  const question = "What is valuable?";
  const evidenceMaterial = "captured migration evidence";
  const approvalRequestBase = {
    version: 1 as const,
    target: { type: "page" as const, logicalPageId: 41 },
    question,
    scope: {
      acquisitionLevel: "captured_only" as const,
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: [] as string[],
        sensitiveOriginDigests: [] as string[],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "migration-fts", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength(evidenceMaterial, "utf8"),
      snapshotBytes: 0,
      questionBytes: Buffer.byteLength(question, "utf8"),
      budget,
    }),
    captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
  };
  const current = buildCurrentResearchDraft(connection, approvalRequestBase, {
    clock: () => new Date(at),
  });
  const approvalRequest = {
    ...approvalRequestBase,
    approvalFingerprint: fingerprintResearchApproval(current),
  };
  const draft = buildCurrentResearchDraft(connection, approvalRequest, {
    clock: () => new Date(at),
  });
  const research = createResearchStore(connection, { clock: () => new Date(at) });
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(at),
    kindAvailable: () => true,
    token: () => "migration-research-lease-token",
    research,
  });
  const job = ledger.submitResearch({
    version: 1,
    kind: "resource_research",
    subject: draft.target,
    workflowRef: draft.workflowRef,
    inputFingerprint: draft.approvalFingerprint,
    idempotencyKey: "migration-research-report",
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget,
  }, approvalRequest);
  const claim = ledger.claimNext("resource_research", "migration-worker", {
    maxConcurrent: 1,
    maxAttemptsPerUtcDay: 3,
    maxCostUsdPerUtcDay: 2,
  });
  if (claim === undefined) throw new Error(`Failed to claim ${job.id}`);
  const checkpointDigests = {
    corpusDigest: "1".repeat(64),
    parentDigest: null,
    providerInputDigest: "2".repeat(64),
    quoteDigest: "3".repeat(64),
  } as const;
  ledger.checkpoint(claim, {
    progress: { completed: 0, total: 1, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  });
  ledger.checkpoint(claim, {
    progress: { completed: 0, total: 1, stage: "provider_ready" },
    checkpoint: {
      version: 1, nextStep: 1, stage: "provider_ready", ...checkpointDigests,
    },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  });
  ledger.bindAttemptProvider(claim, {
    provider: "fixture",
    model: "fixture",
    promptVersion: "migration-v1",
    pricingVersion: "fixture-v1",
  });
  const sourceId = connection.prepare(`
    SELECT id FROM research_sources WHERE run_id = (
      SELECT id FROM research_runs WHERE job_id = ?
    )
  `).pluck().get(Number(job.id.split(":")[1])) as number;
  const completed = ledger.completeResearch(claim, {
    progress: { completed: 1, total: 1, stage: "terminal_publication" },
    checkpoint: {
      version: 1, nextStep: 2, stage: "terminal_publication", ...checkpointDigests,
      providerOutputDigest: "4".repeat(64),
    },
    usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, wallTimeMs: 1 },
  }, {
    version: 1,
    status: "succeeded",
    reason: null,
    corpusFingerprint: draft.corpusFingerprint,
    inputFingerprint: draft.approvalFingerprint,
    coverage: { discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0 },
    usedSourceIds: [sourceId],
    provenance: {
      provider: "fixture", model: "fixture", promptVersion: "migration-v1",
      pricingVersion: "fixture-v1", requestId: null, generatedAt: at,
      usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, wallTimeMs: 1 },
    },
    dossier: {
      executiveSummary: reportText,
      valueForUser: reportText,
      capabilities: [], limitations: [], risks: [], unknowns: [], nextSteps: [],
    },
    claims: [{
      claim: "The captured migration material is available.",
      confidence: 1, isInference: false, rationale: null,
      evidence: [{
        kind: "tab_content", sourceId,
        locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 27 },
        excerptHash: createHash("sha256").update("captured migration evidence").digest("hex"),
      }],
    }],
  });
  if (completed.result?.type !== "resource_research") {
    throw new Error("Research publication did not return a report");
  }
  const reportId = completed.result.reportId;
  return {
    reportId,
    redact: () => {
      research.redactResearch({
        target: { type: "report", reportId },
        reason: "Migration FTS redaction proof",
        idempotencyKey: "migration-research-redaction",
      });
    },
  };
}

function expectResearchReportFtsLifecycle(connection: Database.Database): void {
  const ftsSql = connection.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_reports_fts'
  `).pluck().get() as string;
  expect(ftsSql).toContain("fts5");
  expect(ftsSql).toContain("content='research_report_payloads'");
  expect(ftsSql).toContain("content_rowid='report_id'");
  const synchronizationTriggers = connection.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'research_report_payloads'
      AND name LIKE 'research_report_payloads_fts_%'
    ORDER BY name
  `).pluck().all();
  expect(synchronizationTriggers).toEqual([
    "research_report_payloads_fts_after_delete",
    "research_report_payloads_fts_after_insert",
  ]);

  const marker = "constellationmigrationmarker";
  const published = publishResearchReport(connection, `Report ${marker}`);
  expect(connection.prepare(`
    SELECT rowid FROM research_reports_fts WHERE research_reports_fts MATCH ?
  `).pluck().all(marker)).toEqual([published.reportId]);
  expect(() => connection.prepare(`
    UPDATE research_report_payloads SET report_text = ? WHERE report_id = ?
  `).run("resurrectedmigrationmarker", published.reportId)).toThrow(/immutable/i);
  expect(connection.prepare(`
    SELECT rowid FROM research_reports_fts WHERE research_reports_fts MATCH ?
  `).pluck().all("resurrectedmigrationmarker")).toEqual([]);

  published.redact();
  expect(connection.prepare(`
    SELECT rowid FROM research_reports_fts WHERE research_reports_fts MATCH ?
  `).pluck().all(marker)).toEqual([]);
  expect(() => connection.prepare(`
    INSERT INTO research_report_payloads (
      report_id, report_text, structured_json, payload_digest
    ) VALUES (?, 'resurrectedmigrationmarker', '{}', ?)
  `).run(published.reportId, "f".repeat(64))).toThrow(/cannot be restored/i);
  expect(connection.prepare(`
    SELECT rowid FROM research_reports_fts WHERE research_reports_fts MATCH ?
  `).pluck().all("resurrectedmigrationmarker")).toEqual([]);
  expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(connection.pragma("foreign_key_check")).toEqual([]);
}

describe("migration 024 research workflow", () => {
  it("migrates a fresh database through schema 26 with intact foreign keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-research-migration-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "tabhub.sqlite"), {
      migrationClock: () => new Date("2026-08-13T14:00:00.000Z"),
    });
    try {
      expect(database.schemaVersion).toBe(26);
      expect(database.connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
      const tables = database.connection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'research_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
        "research_runs",
        "research_sources",
        "research_source_payloads",
        "research_reports",
        "research_report_payloads",
        "research_claims",
        "research_claim_evidence",
        "research_target_heads",
      ]));
      expect(database.connection.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'agent_research_command_receipts'
      `).pluck().get()).toEqual(expect.stringContaining("operation IN ('start', 'cancel')"));
      expect(database.connection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'agent_research_command_receipts'
        ORDER BY name
      `).pluck().all()).toEqual([
        "agent_research_command_receipts_immutable_delete",
        "agent_research_command_receipts_immutable_update",
        "agent_research_command_receipts_owned_job_insert",
        "privacy_purge26_agent_research_command_receipts_delete_fence",
        "privacy_purge26_agent_research_command_receipts_insert_fence",
        "privacy_purge26_agent_research_command_receipts_update_fence",
      ]);
      expect(database.connection.prepare(`
        SELECT name, type, "notnull" AS required, dflt_value
        FROM pragma_table_info('ai_job_attempts') WHERE name = 'pricing_version'
      `).get()).toEqual({
        name: "pricing_version", type: "TEXT", required: 0, dflt_value: null,
      });
      const attemptsSql = database.connection.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_job_attempts'
      `).pluck().get() as string;
      expect(attemptsSql).toContain("length(CAST(pricing_version AS BLOB)) BETWEEN 1 AND 128");
      const runSql = database.connection.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_runs'
      `).pluck().get() as string;
      expect(runSql).toContain("max_steps BETWEEN 1 AND 100");
      expect(runSql).toContain("max_tokens BETWEEN 0 AND 200000");
      expect(runSql).toContain("max_cost_usd >= 0 AND max_cost_usd <= 2.0");
      expect(runSql).toContain("max_wall_time_ms BETWEEN 1 AND 1800000");
      const sourcePayloadSql = database.connection.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_source_payloads'
      `).pluck().get() as string;
      expect(sourcePayloadSql).toContain("length(CAST(title_snapshot AS BLOB)) <= 8192");
      for (const table of [
        "research_source_state_events",
        "research_snapshot_state_events",
        "research_evidence_state_events",
        "research_report_state_events",
      ]) {
        const eventSql = database.connection.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
        `).pluck().get(table) as string;
        expect(eventSql).toContain("length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 200");
      }
      expectResearchReportFtsLifecycle(database.connection);
    } finally {
      database.close();
    }
  });

  it("supersedes only active unbound schema-23 research jobs during upgrade", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-research-upgrade-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    const connection = createSchema23(databasePath);
    let token = 0;
    const ledger = createAiJobLedger(connection, {
      clock: () => new Date("2026-08-13T13:00:00.000Z"),
      kindAvailable: () => true,
      token: () => `legacy-research-token-${String(++token).padStart(4, "0")}`,
    });
    const makeTask = (fingerprint: string, priority: number, key: string) => ({
      version: 1 as const,
      kind: "resource_research" as const,
      subject: { type: "selection" as const, fingerprint: fingerprint.repeat(64) },
      workflowRef: { id: "legacy-captured", version: 1 },
      inputFingerprint: fingerprint.repeat(64),
      idempotencyKey: key,
      provenance: { requestedBy: "user" as const, requestMethod: "manual" as const },
      schedulingPriority: priority,
      budget: { maxSteps: 10, maxTokens: 100, maxCostUsd: 1, maxWallTimeMs: 60_000 },
    });
    ledger.submit(makeTask("a", -10, "legacy-queued"));
    ledger.submit(makeTask("b", 10, "legacy-running"));
    const running = ledger.claimNext("resource_research", "legacy-worker", {
      maxConcurrent: 10,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 10,
    })!;
    ledger.bindAttemptProvider(running, {
      provider: "legacy-provider",
      model: "legacy-running-model",
      promptVersion: "legacy-prompt-v1",
    });
    ledger.submit(makeTask("c", 20, "legacy-terminal"));
    const terminal = ledger.claimNext("resource_research", "legacy-worker-2", {
      maxConcurrent: 10,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 10,
    })!;
    ledger.bindAttemptProvider(terminal, {
      provider: "legacy-provider",
      model: "legacy-terminal-model",
      promptVersion: "legacy-prompt-v1",
    });
    ledger.complete(terminal, {
      progress: { completed: 1, total: null, stage: "legacy-published" },
      checkpoint: { version: 1, nextStep: 1 },
      usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, wallTimeMs: 1 },
    }, {
      status: "succeeded",
      result: { type: "resource_research", reportId: 999 },
    });
    expect(running.id).toBe(2);
    expect(connection.prepare(`
      SELECT COUNT(*) FROM pragma_table_info('ai_job_attempts') WHERE name = 'pricing_version'
    `).pluck().get()).toBe(0);
    connection.close();

    const upgraded = openDatabase(databasePath);
    try {
      expect(upgraded.schemaVersion).toBe(26);
      expect(upgraded.connection.prepare(`
        SELECT name, "notnull" AS required, dflt_value
        FROM pragma_table_info('ai_job_attempts') WHERE name = 'pricing_version'
      `).get()).toEqual({ name: "pricing_version", required: 0, dflt_value: null });
      expect(upgraded.connection.prepare(`
        SELECT id, pricing_version FROM ai_job_attempts ORDER BY id
      `).all()).toEqual([
        { id: 1, pricing_version: null },
        { id: 2, pricing_version: null },
      ]);
      expect(upgraded.connection.prepare(`
        SELECT id, status, result_report_id FROM ai_jobs ORDER BY id
      `).all()).toEqual([
        { id: 1, status: "superseded", result_report_id: null },
        { id: 2, status: "superseded", result_report_id: null },
        { id: 3, status: "succeeded", result_report_id: 999 },
      ]);
      const upgradedLedger = createAiJobLedger(upgraded.connection, {
        clock: () => new Date("2026-08-13T13:00:00.000Z"),
        kindAvailable: () => true,
      });
      expect(upgradedLedger.get("resource_research", running.id)?.status).toBe("superseded");
      expect(upgradedLedger.get("resource_research", terminal.id)?.status).toBe("succeeded");
      expect(upgraded.connection.prepare(`
        SELECT checkpoint_json FROM ai_jobs WHERE id = ?
      `).pluck().get(terminal.id)).toBe('{"nextStep":1,"version":1}');
      expect(upgraded.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get())
        .toBe(0);
      expect(upgraded.connection.prepare(`
        SELECT COUNT(*) FROM agent_research_command_receipts
      `).pluck().get()).toBe(0);
      expect(upgraded.connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
      expectResearchReportFtsLifecycle(upgraded.connection);
    } finally {
      upgraded.close();
    }
  }, 15_000);
});
