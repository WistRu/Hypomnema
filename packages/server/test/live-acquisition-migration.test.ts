import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase as openCurrentDatabase } from "../src/database.js";
import { createAiJobLedger } from "../src/ai-job-ledger.js";
import * as liveAcquisitionMigration from "../src/live-acquisition-migration.js";
import { createResearchStore } from "../src/research-store.js";
import {
  assertNoMigrationTransactionControl,
  digestPrivacyPurgeLifecycleTargets,
  digestPrivacyPurgeExecutionTargets,
  encodePrivacyPurgePrimaryKeyV1,
  executePrivacyPurgePlan,
  runLiveAcquisitionMigration,
  type PrivacyPurgeExecutionPlan,
  type PrivacyPurgeExecutionTarget,
} from "../src/live-acquisition-migration.js";
import {
  liveResearchFixtureAt,
  liveResearchFixtureCompletedAt,
  seedReceiptBackedLiveResearchRun as seedReceiptBackedLiveResearchRunWithoutEpoch,
} from "./live-research-fixture.js";

const temporaryDirectories: string[] = [];

function openDatabase(
  ...[databasePath, options]: Parameters<typeof openCurrentDatabase>
): ReturnType<typeof openCurrentDatabase> {
  return openCurrentDatabase(databasePath, {
    ...options,
    maximumMigrationVersion: 25,
  });
}

const unsafeRetainedJsonPayloads = [
  '{"url":"https://secret.example/private"}',
  '{"hostname":"secret.example"}',
  '{"address":"10.0.0.7"}',
  '{"body":"private response body"}',
  '{"cookie":"session=secret"}',
  '{"authorization":"Bearer secret-token"}',
  '{"url_digest":{"authorization":"Bearer nested-secret"}}',
  '{"url_digest":"authorization: Bearer disguised-secret"}',
] as const;
const frozenConsentLimitsJson = JSON.stringify({
  max_pages: 10,
  max_depth: 1,
  duration_ms: 300000,
  max_cost_usd: 1,
  max_origins: 1,
  max_output_tokens: 2000,
  provider_digest: "1".repeat(64),
  model_digest: "2".repeat(64),
  pricing_digest: "3".repeat(64),
  ruleset_generation_digest: "4".repeat(64),
  resource_generation_digest: "5".repeat(64),
  max_source_bytes: 65536,
  max_total_bytes: 4194304,
  dns_timeout_ms: 3000,
  connect_timeout_ms: 5000,
  headers_timeout_ms: 8000,
  body_idle_timeout_ms: 3000,
  request_timeout_ms: 15000,
  max_header_bytes: 16384,
});

function seedReceiptBackedLiveResearchRun(
  connection: Database.Database,
): ReturnType<typeof seedReceiptBackedLiveResearchRunWithoutEpoch> {
  const triggerSql = connection.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?
  `).pluck();
  const insertGuardSql = triggerSql.get(
    "research_runs_history_epoch_insert_guard",
  ) as string;
  const immutableUpdateSql = triggerSql.get(
    "research_runs_immutable_update",
  ) as string;
  const captureLineageGuardSql = triggerSql.get(
    "live_acquisition_handoff_receipts_capture_lineage_guard",
  ) as string;
  const sourceReceiptImmutableUpdateSql = triggerSql.get(
    "live_acquisition_source_receipts_immutable_update",
  ) as string;
  connection.exec(`
    DROP TRIGGER research_runs_history_epoch_insert_guard;
    DROP TRIGGER research_runs_immutable_update;
    DROP TRIGGER live_acquisition_handoff_receipts_capture_lineage_guard;
    DROP TRIGGER live_acquisition_source_receipts_immutable_update;
    CREATE TRIGGER test_fixture_research_run_history_epoch
    AFTER INSERT ON research_runs
    WHEN NEW.target_resource_id IS NOT NULL AND NEW.history_epoch_id IS NULL
    BEGIN
      UPDATE research_runs
      SET history_epoch_id = (
        SELECT id FROM research_history_epochs
        WHERE resource_id = NEW.target_resource_id AND is_active = 1
      )
      WHERE id = NEW.id;
    END;
  `);
  try {
    const fixture = seedReceiptBackedLiveResearchRunWithoutEpoch(connection);
    const lineage = connection.prepare(`
      SELECT receipt.id AS source_receipt_id,
        receipt.logical_page_id, receipt.logical_page_generation_id,
        receipt.content_digest, consent.id AS consent_id,
        consent.resource_generation_id, consent.history_epoch_id,
        consent.coordinator_run_generation_id, consent.runtime_epoch,
        page.url_normalized
      FROM live_acquisition_source_receipts AS receipt
      JOIN live_acquisition_handoffs AS handoff ON handoff.id = receipt.handoff_id
      JOIN live_acquisition_consents AS consent
        ON consent.coordinator_run_generation_id
          = handoff.coordinator_run_generation_id
      JOIN logical_pages AS page ON page.id = receipt.logical_page_id
      WHERE receipt.id = ?
    `).get(fixture.sourceReceiptId) as {
      source_receipt_id: number;
      logical_page_id: number;
      logical_page_generation_id: number;
      content_digest: string;
      consent_id: number;
      resource_generation_id: number;
      history_epoch_id: number;
      coordinator_run_generation_id: number;
      runtime_epoch: number;
      url_normalized: string;
    };
    const actionId = Number(connection.prepare(`
      SELECT manifest.action_id
      FROM live_acquisition_source_receipts AS receipt
      JOIN live_acquisition_capture_manifests AS manifest
        ON manifest.id = receipt.capture_manifest_id
      WHERE receipt.id = ?
    `).pluck().get(lineage.source_receipt_id));
    const childActionId = Number(connection.prepare(`
      SELECT COALESCE(MAX(id), 0) + 1 FROM live_acquisition_actions
    `).pluck().get());
    connection.prepare(`
      INSERT INTO live_acquisition_actions (
        id, consent_id, coordinator_run_generation_id,
        resource_generation_id, history_epoch_id, runtime_epoch,
        action_kind, depth, discovered_from_action_id,
        canonical_fetch_url_fingerprint, canonical_origin_digest,
        action_key_digest, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'page', 1, ?, ?, NULL, ?, 'planned', ?)
    `).run(
      childActionId,
      lineage.consent_id,
      lineage.coordinator_run_generation_id,
      lineage.resource_generation_id,
      lineage.history_epoch_id,
      lineage.runtime_epoch,
      actionId,
      createHash("sha256").update(`${lineage.url_normalized}/child`).digest("hex"),
      createHash("sha256").update(`legacy-fixture:${childActionId}`).digest("hex"),
      liveResearchFixtureAt,
    );
    return fixture;
  } finally {
    connection.exec(`DROP TRIGGER test_fixture_research_run_history_epoch;`);
    connection.exec(`${sourceReceiptImmutableUpdateSql};`);
    connection.exec(`${captureLineageGuardSql};`);
    connection.exec(`${immutableUpdateSql};`);
    connection.exec(`${insertGuardSql};`);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSchema24(databasePath: string): void {
  const connection = new Database(databasePath);
  try {
    sqliteVec.load(connection);
    connection.function(
      "tabhub_normalize_url_v2",
      { deterministic: true },
      (value: string) => value,
    );
    connection.function("tabhub_migration_now", () =>
      "2026-08-14T10:00:00.000Z",
    );

    const migrationsDirectory = join(process.cwd(), "migrations");
    for (const name of readdirSync(migrationsDirectory)
      .filter(
        (entry) =>
          /^\d{3}_.+\.sql$/.test(entry) && Number(entry.slice(0, 3)) <= 24,
      )
      .sort()) {
      connection.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
      connection.pragma(`user_version = ${Number(name.slice(0, 3))}`);
    }
  } finally {
    connection.close();
  }
}

function seedCapturedResearchSource(
  connection: Database.Database,
  workflowId = "research_workflow:c81:v1",
  contentDigest: string | Buffer = "e".repeat(64),
): void {
  const at = "2026-08-14T10:00:00.000Z";
  const hasHistoryEpochColumn = (connection.prepare(
    "PRAGMA table_info(research_runs)",
  ).all() as Array<{ name: string }>).some(({ name }) => name === "history_epoch_id");
  const historyEpochColumn = hasHistoryEpochColumn ? ", history_epoch_id" : "";
  const historyEpochValue = hasHistoryEpochColumn
    ? ", (SELECT id FROM research_history_epochs WHERE resource_id = 9001 AND is_active = 1)"
    : "";
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      9001, 'https://example.com/source', 'https://example.com/source',
      'https://example.com/source', '${at}', '${at}'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      9001, 'https://example.com/source', 'https://example.com/source',
      'Migration source', 'chrome', 'inbox', 0, 1, '${at}', '${at}', 9001
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (9001, 'migration source material', '${at}', 1);
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (9001, 'migration-example.com', '${at}');
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      progress_total, created_at, updated_at
    ) VALUES (
      9001, 'resource_research', 'resource', 9001, 'resource:9001', 'user', 'manual',
      'migration-source-job', '${"a".repeat(64)}', '${"b".repeat(64)}',
      '${workflowId}', 1, 0, '${at}', 10, 1000, 1, 60000,
      1, '${at}', '${at}'
    );
    INSERT INTO research_runs (
      id, job_id, target_resource_id, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at${historyEpochColumn}
    ) VALUES (
      9001, 9001, 9001, 'resource:9001', '${"c".repeat(64)}', '{}', '${"b".repeat(64)}',
      '${"d".repeat(64)}', '${"a".repeat(64)}', '${workflowId}',
      1, 10, 1000, 1, 60000, '${at}'${historyEpochValue}
    );
  `);
  connection.prepare(`
    INSERT INTO research_sources (
      id, run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
      content_revision, content_digest, extracted_at, acquisition_method,
      access_class_snapshot, eligibility, inclusion_state, included_order,
      created_at
    ) VALUES (
      9001, 9001, 1, 9001, 9001, 9001, 1, ?, ?, 'captured',
      'public', 'eligible', 'included', 1, ?
    )
  `).run(contentDigest, at, at);
}

function seedOrdinaryC81ResearchJob(
  connection: Database.Database,
  id: number,
  at: string,
  maxCostUsd = 0,
  schedulingPriority = 100,
): void {
  const url = `https://ordinary-${id}.example/`;
  const submission = createHash("sha256").update(`ordinary-submit:${id}`).digest("hex");
  const approval = createHash("sha256").update(`ordinary-input:${id}`).digest("hex");
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, url, url, url, at, at);
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, logical_page_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      progress_total, available_at, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, updated_at
    ) VALUES (
      ?, 'resource_research', 'page', ?, ?, 'system', 'scheduled', ?, ?, ?,
      'research_workflow:c81:v1', 1, ?, 1, ?, 10, 1000, ?, 60000, ?, ?
    )
  `).run(
    id, id, `page:${id}`, `ordinary-bind-${id}`, submission, approval,
    schedulingPriority, at, maxCostUsd, at, at,
  );
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_logical_page_id, target_key, question_digest,
      scope_json, approval_fingerprint, corpus_fingerprint,
      submission_fingerprint, workflow_id, workflow_version, max_steps,
      max_tokens, max_cost_usd, max_wall_time_ms, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'research_workflow:c81:v1', 1,
      10, 1000, ?, 60000, ?
    )
  `).run(
    id, id, id, `page:${id}`,
    createHash("sha256").update(`ordinary-question:${id}`).digest("hex"),
    approval,
    createHash("sha256").update(`ordinary-corpus:${id}`).digest("hex"),
    submission, maxCostUsd, at,
  );
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', ?, ?)
  `).run(id, `ordinary-bind-${id}-queued`, at);
}

function insertPrivacyPurgeCommand(
  connection: Database.Database,
  input: {
    readonly id: number;
    readonly targetKind: "logical_page" | "resource_history" | "run";
    readonly subjectGenerationId?: number;
    readonly historyEpochId?: number;
    readonly orderedTargets?: readonly PrivacyPurgeExecutionTarget[];
    readonly createdAt: string;
    readonly digestSeed?: string;
  },
): void {
  const orderedTargets = input.orderedTargets ?? [];
  const seed = input.digestSeed ?? String(input.id);
  connection.prepare(`
    INSERT INTO privacy_purge_commands (
      id, idempotency_key_hash, request_fingerprint, target_kind,
      subject_generation_id, history_epoch_id, deletion_target_count,
      deletion_plan_digest, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    input.id,
    createHash("sha256").update(`purge-idempotency:${seed}`).digest("hex"),
    createHash("sha256").update(`purge-request:${seed}`).digest("hex"),
    input.targetKind,
    input.subjectGenerationId ?? null,
    input.historyEpochId ?? null,
    orderedTargets.length,
    digestPrivacyPurgeExecutionTargets(orderedTargets),
    input.createdAt,
  );
}

function completedPrivacyPurgePlan(
  commandId: number,
  orderedTargets: readonly PrivacyPurgeExecutionTarget[],
  completedAt: string,
  digestSeed = "a",
) {
  return {
    version: "privacy_purge_execution:v1" as const,
    commandId,
    outcome: "completed" as const,
    orderedTargets,
    tombstoneDigest: digestSeed.repeat(64),
    safeCounts: { deleted_rows: orderedTargets.length },
    resultDigest: ((Number.parseInt(digestSeed, 16) + 1) % 16)
      .toString(16).repeat(64),
    completedAt,
  };
}

function everyExistingPurgeTarget(
  connection: Database.Database,
): readonly PrivacyPurgeExecutionTarget[] {
  const catalog = connection.prepare(`
    SELECT table_name, pk_columns_json, delete_rank
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all() as Array<{
    table_name: string;
    pk_columns_json: string;
    delete_rank: number;
  }>;
  const targets: Array<PrivacyPurgeExecutionTarget & {
    deleteRank: number;
    actionDepth: number;
  }> = [];
  for (const entry of catalog) {
    const columns = JSON.parse(entry.pk_columns_json) as string[];
    const quotedTable = `"${entry.table_name.replaceAll('"', '""')}"`;
    const quotedColumns = columns.map((column) =>
      `"${column.replaceAll('"', '""')}"`
    );
    const rows = connection.prepare(
      `SELECT ${quotedColumns.join(", ")}${
        entry.table_name === "live_acquisition_actions"
          ? ", depth AS __action_depth"
          : ""
      } FROM ${quotedTable}
       ORDER BY ${quotedColumns.join(", ")}`,
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      targets.push({
        tableName: entry.table_name,
        pkV1: encodePrivacyPurgePrimaryKeyV1(columns.map((column) => {
          const value = row[column];
          if (typeof value === "number" || typeof value === "bigint") {
            return { type: "integer" as const, value };
          }
          if (typeof value === "string") return { type: "text" as const, value };
          throw new Error(`Unsupported purge test primary key: ${entry.table_name}`);
        })),
        deleteRank: entry.delete_rank,
        actionDepth: entry.table_name === "live_acquisition_actions"
          ? Number(row.__action_depth)
          : -1,
      });
    }
  }
  return targets.sort((left, right) =>
    right.deleteRank - left.deleteRank ||
    left.tableName.localeCompare(right.tableName, "en") ||
    (left.tableName === "live_acquisition_actions"
      ? right.actionDepth - left.actionDepth
      : 0) ||
    left.pkV1.localeCompare(right.pkV1, "en")
  ).map(({ tableName, pkV1 }) => ({ tableName, pkV1 }));
}

function seedCommittedRunGraphPurge(
  connection: Database.Database,
  commandId: number,
): {
  readonly coordinatorRunId: number;
  readonly finalRunId: number;
  readonly rootGenerationId: number;
  readonly orderedTargets: readonly PrivacyPurgeExecutionTarget[];
} {
  const fixture = seedReceiptBackedLiveResearchRun(connection);
  connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, occurred_at
    ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
  `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
  const rootGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(fixture.coordinatorJobId));
  const orderedTargets = everyExistingPurgeTarget(connection);
  insertPrivacyPurgeCommand(connection, {
    id: commandId,
    targetKind: "run",
    subjectGenerationId: rootGenerationId,
    orderedTargets,
    createdAt: "2026-08-14T12:00:02.000Z",
  });
  return {
    coordinatorRunId: fixture.coordinatorJobId,
    finalRunId: fixture.finalRunId,
    rootGenerationId,
    orderedTargets,
  };
}

function seedAdditionalResearchRun(
  connection: Database.Database,
  runId: number,
  at: string,
): number {
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      created_at, updated_at
    ) VALUES (
      ?, 'resource_research', 'resource', 7001, 'resource:7001',
      'user', 'manual', ?, ?, ?, 'research_workflow:c81:v1', 1, 0, ?,
      10, 1000, 1, 60000, ?, ?
    )
  `).run(
    runId,
    `graph-shape-${runId}`,
    "a".repeat(64),
    "b".repeat(64),
    at,
    at,
    at,
  );
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_resource_id, target_key, question_digest,
      scope_json, approval_fingerprint, corpus_fingerprint,
      submission_fingerprint, workflow_id, workflow_version, max_steps,
      max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
    ) VALUES (
      ?, ?, 7001, 'resource:7001', ?, '{}', ?, ?, ?,
      'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, ?,
      (SELECT id FROM research_history_epochs
       WHERE resource_id = 7001 AND is_active = 1)
    )
  `).run(
    runId,
    runId,
    "c".repeat(64),
    "b".repeat(64),
    "d".repeat(64),
    "a".repeat(64),
    at,
  );
  return Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ?
      AND is_active = 1
  `).pluck().get(runId));
}

function seedEpochBoundRun(
  connection: Database.Database,
  runId: number,
  resourceId: number,
  historyEpochId: number,
  at: string,
  supersede: boolean,
  workflowId = "research_workflow:c81:v1",
): number {
  const fingerprint = createHash("sha256").update(`epoch-run:${runId}`).digest("hex");
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      created_at, updated_at
    ) VALUES (
      ?, 'resource_research', 'resource', ?, ?, 'user', 'manual', ?, ?, ?,
      ?, 1, 0, ?, 10, 1000, 1, 60000, ?, ?
    )
  `).run(
    runId,
    resourceId,
    `resource:${resourceId}`,
    `epoch-run-${runId}`,
    fingerprint,
    "b".repeat(64),
    workflowId,
    at,
    at,
    at,
  );
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_resource_id, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, history_epoch_id
    ) VALUES (
      ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 1,
      10, 1000, 1, 60000, ?, ?
    )
  `).run(
    runId,
    runId,
    resourceId,
    `resource:${resourceId}`,
    "c".repeat(64),
    "b".repeat(64),
    "d".repeat(64),
    fingerprint,
    workflowId,
    at,
    historyEpochId,
  );
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', ?, ?)
  `).run(runId, `epoch-run-${runId}-queued`, at);
  if (supersede) {
    connection.prepare(`
      INSERT INTO ai_job_events (
        job_id, sequence_no, event_type, from_status, to_status, occurred_at
      ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
    `).run(runId, at);
  }
  return Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(runId));
}

function privacyPurgeStateFingerprint(
  connection: Database.Database,
  commandId: number,
): string {
  const snapshot = {
    catalogTargets: everyExistingPurgeTarget(connection),
    command: connection.prepare(
      "SELECT * FROM privacy_purge_commands WHERE id = ?",
    ).get(commandId),
    lifecycleTargets: connection.prepare(`
      SELECT * FROM privacy_purge_lifecycle_targets
      WHERE purge_command_id = ? ORDER BY subject_generation_id
    `).all(commandId),
    runGenerations: connection.prepare(`
      SELECT * FROM privacy_subject_generations
      WHERE subject_kind = 'research_run' ORDER BY id
    `).all(),
    researchRuns: connection.prepare(
      "SELECT * FROM research_runs ORDER BY id",
    ).all(),
    historyEpochs: connection.prepare(
      "SELECT * FROM research_history_epochs ORDER BY id",
    ).all(),
    tombstones: connection.prepare(`
      SELECT * FROM privacy_subject_tombstones
      WHERE purge_command_id = ? ORDER BY id
    `).all(commandId),
    results: connection.prepare(
      "SELECT * FROM privacy_purge_results WHERE command_id = ?",
    ).all(commandId),
    authorities: connection.prepare(`
      SELECT * FROM privacy_purge_authorities
      WHERE command_id = ? ORDER BY table_name, pk_v1
    `).all(commandId),
    fences: connection.prepare(
      "SELECT * FROM privacy_purge_transaction_fences ORDER BY nonce_digest",
    ).all(),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function seedCompleteLogicalPagePurgeFixture(
  connection: Database.Database,
  at: string,
): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url,
      created_at, updated_at
    ) VALUES (
      9400, 'https://complete-purge.example/page',
      'https://complete-purge.example/page',
      'https://complete-purge.example/page', '${at}', '${at}'
    );
    INSERT INTO logical_page_preferences (
      logical_page_id, user_importance, recorded_by, record_method,
      importance_updated_at, updated_at
    ) VALUES (9400, 3, 'agent', 'on_behalf_of_user', '${at}', '${at}');
    INSERT INTO logical_page_importance_migration_audit (
      logical_page_id, legacy_values_json, suggested_value,
      resolution_state, created_at, reviewed_at
    ) VALUES (9400, '[]', 3, 'confirmed', '${at}', '${at}');
    INSERT INTO context_entries (
      id, logical_page_id, kind, body, actor, method, visibility,
      source_fingerprint, state, operation, revision, idempotency_key,
      created_at
    ) VALUES (
      9401, 9400, 'project', 'complete purge context', 'agent', 'rule',
      'share_with_ai', 'complete-purge-context', 'active', 'append', 1,
      'complete-purge-context', '${at}'
    );
    INSERT INTO context_entry_reviews (
      id, context_entry_id, verdict, reviewed_by, review_method,
      idempotency_key, created_at
    ) VALUES (
      9402, 9401, 'accepted', 'user', 'manual',
      'complete-purge-review', '${at}'
    );
    INSERT INTO tab_session_intents (
      id, installation_id, browser_session_id, browser_tab_id,
      logical_page_id, expected_url, expected_url_normalized,
      expected_instance_revision, body, actor, method, visibility,
      state, idempotency_key, created_at, updated_at
    ) VALUES (
      9403, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 9400, 9400,
      'https://complete-purge.example/page',
      'https://complete-purge.example/page', 1, 'complete purge intent',
      'user', 'manual', 'local_only', 'active', 'complete-purge-intent',
      '${at}', '${at}'
    );
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (9400, '2026-08-14', 9000, 4000, '${at}');

    INSERT INTO resources (id, resource_key, created_at)
    VALUES (9600, 'website:complete-purge-resource.example', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (
      9601, 9600, 1, 'Complete Purge Resource', 'website', 'public',
      'active', 'user', 'manual', '${at}'
    );
    INSERT INTO resource_heads (resource_id, event_id) VALUES (9600, 9601);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class,
      assigned_by, assignment_method, source_fingerprint, created_at
    ) VALUES (
      9602, 9400, 'assigned', 9600, 'user_manual', 'user', 'manual',
      'complete-purge-assignment', '${at}'
    );
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (9400, 9602);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, candidate_resource_ids_json,
      source_fingerprint, research_eligible, research_exclusion_reason,
      created_at
    ) VALUES (
      9603, 9400, 'unmatched', 'weak_sensitive_signal', '[]',
      'complete-purge-resolution', 0, 'weak_sensitive_signal', '${at}'
    );
    INSERT INTO resource_resolution_heads (
      logical_page_id, resolution_event_id
    ) VALUES (9400, 9603);

    INSERT INTO priority_assessments (
      id, logical_page_id, agent_score, agent_band, confidence, needs_review,
      reasons_json, missing_signals_json, ruleset_id, ruleset_version,
      feature_fingerprint, assessment_method, model_provenance_json,
      revision, evaluated_at
    ) VALUES (
      9410, 9400, 60, 'high', 0.75, 0, '[]', '[]', 1, 1,
      '${"7".repeat(64)}', 'rule', NULL, 1, '${at}'
    );
    INSERT INTO priority_feedback (
      id, logical_page_id, assessment_id, verdict, actor, method,
      authorization_ref, idempotency_key, request_fingerprint,
      revision, created_at
    ) VALUES (
      9411, 9400, 9410, 'accept', 'user', 'manual', NULL,
      'complete-purge-feedback', '${"8".repeat(64)}', 1, '${at}'
    );
    UPDATE priority_assessments SET superseded_at = '${at}' WHERE id = 9410;
    INSERT INTO priority_exclusions (
      id, logical_page_id, reason, detail_json, ruleset_id, ruleset_version,
      feature_fingerprint, revision, evaluated_at
    ) VALUES (
      9412, 9400, 'policy_excluded', '{}', 1, 1,
      '${"9".repeat(64)}', 2, '${at}'
    );

    INSERT INTO ai_jobs (
      id, kind, subject_type, logical_page_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      created_at, updated_at
    ) VALUES (
      9420, 'resource_research', 'page', 9400, 'page:9400', 'user', 'manual',
      'complete-purge-page-job', '${"a".repeat(64)}', '${"b".repeat(64)}',
      'research_workflow:c81:v1', 1, 0, '${at}', 10, 1000, 1, 60000,
      '${at}', '${at}'
    );
    INSERT INTO agent_user_importance_receipts (
      idempotency_key_hash, request_fingerprint, authorization_ref_hash,
      subject_type, logical_page_id, resource_id, value, result_json,
      result_updated_at, created_at
    ) VALUES (
      '${"c".repeat(64)}', '${"d".repeat(64)}', '${"e".repeat(64)}',
      'page', 9400, NULL, 3,
      '{"subject":{"type":"page","logicalPageId":9400},"value":3,"provenance":{"actor":"agent","method":"on_behalf_of_user"},"updatedAt":"${at}"}',
      '${at}', '${at}'
    );

    INSERT INTO resources (id, resource_key, created_at)
    VALUES (9500, 'website:retained-foreign-report.example', '${at}');
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      created_at, updated_at
    ) VALUES (
      9500, 'resource_research', 'resource', 9500, 'resource:9500', 'user',
      'manual', 'retained-foreign-report-job', '${"1".repeat(64)}',
      '${"2".repeat(64)}', 'research_workflow:c81:v1', 1, 0, '${at}',
      10, 1000, 1, 60000, '${at}', '${at}'
    );
    INSERT INTO research_runs (
      id, job_id, target_resource_id, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, history_epoch_id
    ) VALUES (
      9500, 9500, 9500, 'resource:9500', '${"3".repeat(64)}', '{}',
      '${"2".repeat(64)}', '${"4".repeat(64)}', '${"1".repeat(64)}',
      'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
      (SELECT id FROM research_history_epochs WHERE resource_id = 9500 AND is_active = 1)
    );
    INSERT INTO research_reports (
      id, run_id, target_resource_id, target_key, version, publish_status,
      coverage_json, coverage_fingerprint, provenance_json,
      input_fingerprint, created_at
    ) VALUES (
      9500, 9500, 9500, 'resource:9500', 1, 'partial', '{}',
      '${"5".repeat(64)}', '{}', '${"2".repeat(64)}', '${at}'
    );
    INSERT INTO research_page_context_snapshots (
      id, run_id, context_entry_audit_id, logical_page_audit_id,
      context_entry_id, snapshot_digest, created_at
    ) VALUES (
      9501, 9500, 9401, 9400, 9401, '${"6".repeat(64)}', '${at}'
    );
  `);
}

describe("live acquisition migration 025", { timeout: 60_000 }, () => {
  it("encodes scalar and composite pk:v1 values without separator or Unicode collisions", () => {
    expect(
      encodePrivacyPurgePrimaryKeyV1([{ type: "integer", value: 9001 }]),
    ).toBe("pk:v1|1|i:4:9001");
    expect(
      encodePrivacyPurgePrimaryKeyV1([
        { type: "text", value: "a|b" },
        { type: "text", value: "é" },
        { type: "integer", value: 12n },
      ]),
    ).toBe("pk:v1|3|s:3:a|bs:2:éi:2:12");
    expect(
      encodePrivacyPurgePrimaryKeyV1([
        { type: "text", value: "a" },
        { type: "text", value: "bc" },
      ]),
    ).not.toBe(
      encodePrivacyPurgePrimaryKeyV1([
        { type: "text", value: "ab" },
        { type: "text", value: "c" },
      ]),
    );
    expect(() =>
      encodePrivacyPurgePrimaryKeyV1([
        { type: "integer", value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrow(/safe canonical integer/i);
  });

  it("freezes the exact root and descendant run generations in the command statement", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const fixture = seedCommittedRunGraphPurge(connection, 25_001);
      const lifecycleRows = connection.prepare(`
        SELECT subject_generation_id AS subjectGenerationId,
          generation_token AS generationToken, research_run_id AS researchRunId,
          is_root
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25001 ORDER BY subject_generation_id
      `).all() as Array<{
        subjectGenerationId: number;
        generationToken: string;
        researchRunId: number;
        is_root: 0 | 1;
      }>;
      const command = connection.prepare(`
        SELECT lifecycle_target_count, lifecycle_plan_digest
        FROM privacy_purge_commands WHERE id = 25001
      `).get() as {
        lifecycle_target_count: number;
        lifecycle_plan_digest: string;
      };

      expect(lifecycleRows).toHaveLength(2);
      expect(lifecycleRows.map((row) => row.researchRunId).sort((a, b) => a - b))
        .toEqual([fixture.coordinatorRunId, fixture.finalRunId].sort((a, b) => a - b));
      expect(lifecycleRows.filter((row) => row.is_root === 1).map(
        (row) => row.subjectGenerationId,
      )).toEqual([fixture.rootGenerationId]);
      expect(command.lifecycle_target_count).toBe(lifecycleRows.length);
      expect(command.lifecycle_plan_digest).toBe(
        digestPrivacyPurgeLifecycleTargets(lifecycleRows.map((row) => ({
          subjectGenerationId: row.subjectGenerationId,
          generationToken: row.generationToken,
          researchRunId: row.researchRunId,
        }))),
      );

      expect(() => connection.prepare(`
        DELETE FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25001 AND is_root = 0
      `).run()).toThrow(/permanent/i);
      expect(() => connection.prepare(`
        UPDATE privacy_purge_lifecycle_targets SET generation_token = ?
        WHERE purge_command_id = 25001 AND is_root = 0
      `).run("f".repeat(64))).toThrow(/immutable/i);
      expect(() => connection.prepare(`
        UPDATE privacy_purge_commands SET lifecycle_target_count = 1
        WHERE id = 25001
      `).run()).toThrow(/invalid privacy purge command transition/i);
      expect(() => connection.prepare(`
        INSERT INTO privacy_purge_lifecycle_targets (
          purge_command_id, subject_generation_id, generation_token,
          research_run_id, is_root
        ) SELECT 25001, subject_generation_id, generation_token,
            research_run_id, 0
          FROM privacy_purge_lifecycle_targets
          WHERE purge_command_id = 25001 AND is_root = 0
      `).run()).toThrow(/freeze|unique/i);

      const finalGenerationId = lifecycleRows.find(
        (row) => row.researchRunId === fixture.finalRunId,
      )!.subjectGenerationId;
      expect(() => connection.prepare(`
        UPDATE privacy_subject_generations SET generation_token = ?
        WHERE id = ?
      `).run("e".repeat(64), finalGenerationId)).toThrow(/immutable/i);
      expect(() => connection.prepare(`
        INSERT INTO privacy_purge_commands (
          id, idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, deletion_target_count,
          deletion_plan_digest, lifecycle_target_count,
          lifecycle_plan_digest, status, created_at
        ) VALUES (
          25002, ?, ?, 'run', ?, NULL, 0, ?, 1, ?, 'pending', ?
        )
      `).run(
        "1".repeat(64),
        "2".repeat(64),
        finalGenerationId,
        digestPrivacyPurgeExecutionTargets([]),
        "3".repeat(64),
        "2026-08-14T12:00:02.000Z",
      )).toThrow(/SUBJECT_FORGOTTEN_OR_INVALID/i);

      const pageGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 7001
          AND is_active = 1
      `).pluck().get());
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_003,
        targetKind: "run",
        subjectGenerationId: pageGenerationId,
        orderedTargets: [],
        createdAt: "2026-08-14T12:00:02.000Z",
      })).toThrow(/SUBJECT_FORGOTTEN_OR_INVALID/i);

      const frozenBeforeGraphMutation = connection.prepare(`
        SELECT * FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25001 ORDER BY subject_generation_id
      `).all();
      expect(() => connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (25001, ?, ?, 'assembling', ?)
      `).run(
        fixture.rootGenerationId,
        fixture.finalRunId,
        "2026-08-14T12:00:02.000Z",
      )).toThrow(/directed handoff|unique/i);
      expect(() => connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (25002, ?, ?, 'assembling', ?)
      `).run(
        finalGenerationId,
        fixture.coordinatorRunId,
        "2026-08-14T12:00:02.000Z",
      )).toThrow(/directed handoff|unique/i);
      expect(connection.prepare(`
        SELECT * FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25001 ORDER BY subject_generation_id
      `).all()).toEqual(frozenBeforeGraphMutation);
    } finally {
      database.close();
    }
  });

  it("accepts a singleton run graph with an exact one-target lifecycle digest", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      seedCapturedResearchSource(connection);
      const generation = connection.prepare(`
        SELECT id, generation_token FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9001
          AND is_active = 1
      `).get() as { id: number; generation_token: string };

      insertPrivacyPurgeCommand(connection, {
        id: 25_008,
        targetKind: "run",
        subjectGenerationId: generation.id,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: "2026-08-14T12:00:02.000Z",
      });

      const lifecycleRows = connection.prepare(`
        SELECT subject_generation_id AS subjectGenerationId,
          generation_token AS generationToken, research_run_id AS researchRunId,
          is_root
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25008 ORDER BY subject_generation_id
      `).all() as Array<{
        subjectGenerationId: number;
        generationToken: string;
        researchRunId: number;
        is_root: 0 | 1;
      }>;
      const command = connection.prepare(`
        SELECT lifecycle_target_count, lifecycle_plan_digest
        FROM privacy_purge_commands WHERE id = 25008
      `).get() as {
        lifecycle_target_count: number;
        lifecycle_plan_digest: string;
      };

      expect(lifecycleRows).toEqual([{
        subjectGenerationId: generation.id,
        generationToken: generation.generation_token,
        researchRunId: 9001,
        is_root: 1,
      }]);
      expect(command.lifecycle_target_count).toBe(1);
      expect(command.lifecycle_plan_digest).toBe(
        digestPrivacyPurgeLifecycleTargets(lifecycleRows.map((row) => ({
          subjectGenerationId: row.subjectGenerationId,
          generationToken: row.generationToken,
          researchRunId: row.researchRunId,
        }))),
      );

    } finally {
      database.close();
    }
  });

  it("freezes every active run bound to a resource-history epoch", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:01.000Z";
      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (8801, ?, ?)",
      ).run("website:epoch-lifecycle.example", at);
      const epochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8801 AND is_active = 1
      `).pluck().get());
      const generationIds = [
        seedEpochBoundRun(connection, 88_011, 8801, epochId, at, true),
        seedEpochBoundRun(connection, 88_012, 8801, epochId, at, true),
        seedEpochBoundRun(connection, 88_013, 8801, epochId, at, false),
      ];
      const targets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 88_001,
        targetKind: "resource_history",
        historyEpochId: epochId,
        orderedTargets: targets,
        createdAt: at,
      });

      const lifecycleRows = connection.prepare(`
        SELECT subject_generation_id AS subjectGenerationId,
          generation_token AS generationToken, research_run_id AS researchRunId,
          is_root
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 88001 ORDER BY subject_generation_id
      `).all() as Array<{
        subjectGenerationId: number;
        generationToken: string;
        researchRunId: number;
        is_root: 0 | 1;
      }>;
      const command = connection.prepare(`
        SELECT lifecycle_target_count, lifecycle_plan_digest
        FROM privacy_purge_commands WHERE id = 88001
      `).get() as { lifecycle_target_count: number; lifecycle_plan_digest: string };
      expect(lifecycleRows.map(({ subjectGenerationId }) => subjectGenerationId))
        .toEqual([...generationIds].sort((left, right) => left - right));
      expect(lifecycleRows.every(({ is_root }) => is_root === 0)).toBe(true);
      expect(command.lifecycle_target_count).toBe(3);
      expect(command.lifecycle_plan_digest).toBe(
        digestPrivacyPurgeLifecycleTargets(lifecycleRows.map((row) => ({
          subjectGenerationId: row.subjectGenerationId,
          generationToken: row.generationToken,
          researchRunId: row.researchRunId,
        }))),
      );
      const plan = completedPrivacyPurgePlan(88_001, targets, at, "7");
      executePrivacyPurgePlan(connection, plan);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id IN (${generationIds.map(() => "?").join(",")})
          AND subject_kind = 'research_run' AND research_run_id IS NULL
          AND is_active = 0 AND retired_at = ?
      `).pluck().get(...generationIds, at)).toBe(3);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = 88001 AND history_epoch_id = ?
          AND subject_generation_id IS NOT NULL
      `).pluck().get(epochId)).toBe(3);
      expect(connection.prepare(`
        SELECT epoch_no FROM research_history_epochs
        WHERE resource_id = 8801 AND is_active = 1
      `).pluck().get()).toBe(2);
      const replayFingerprint = privacyPurgeStateFingerprint(connection, 88_001);
      executePrivacyPurgePlan(connection, plan);
      expect(privacyPurgeStateFingerprint(connection, 88_001))
        .toBe(replayFingerprint);
    } finally {
      database.close();
    }
  });

  it("requires resource-history plans to match every frozen run row for zero and N runs", () => {
    const at = "2026-08-14T12:00:01.000Z";
    for (const drift of ["omitted", "extra"] as const) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      try {
        const connection = database.connection;
        connection.prepare(
          "INSERT INTO resources (id, resource_key, created_at) VALUES (8891, ?, ?)",
        ).run("website:epoch-plan-equality.example", at);
        const epochId = Number(connection.prepare(`
          SELECT id FROM research_history_epochs
          WHERE resource_id = 8891 AND is_active = 1
        `).pluck().get());
        seedEpochBoundRun(connection, 88_911, 8891, epochId, at, true);
        seedEpochBoundRun(connection, 88_912, 8891, epochId, at, false);
        const completeTargets = everyExistingPurgeTarget(connection);
        const omittedRunPk = encodePrivacyPurgePrimaryKeyV1([{
          type: "integer",
          value: 88_912,
        }]);
        let malformedTargets: readonly PrivacyPurgeExecutionTarget[] =
          completeTargets.filter((target) =>
          target.tableName !== "research_runs" || target.pkV1 !== omittedRunPk
          );
        if (drift === "extra") {
          connection.prepare(
            "INSERT INTO resources (id, resource_key, created_at) VALUES (8892, ?, ?)",
          ).run("website:epoch-plan-extra.example", at);
          const otherEpochId = Number(connection.prepare(`
            SELECT id FROM research_history_epochs
            WHERE resource_id = 8892 AND is_active = 1
          `).pluck().get());
          seedEpochBoundRun(connection, 88_921, 8892, otherEpochId, at, false);
          malformedTargets = everyExistingPurgeTarget(connection);
        }
        const commandId = drift === "omitted" ? 88_901 : 88_902;
        insertPrivacyPurgeCommand(connection, {
          id: commandId,
          targetKind: "resource_history",
          historyEpochId: epochId,
          orderedTargets: malformedTargets,
          createdAt: at,
        });
        const before = privacyPurgeStateFingerprint(connection, commandId);
        expect(() => executePrivacyPurgePlan(
          connection,
          completedPrivacyPurgePlan(commandId, malformedTargets, at, "8"),
        )).toThrow(/exactly match the lifecycle commitment/i);
        expect(privacyPurgeStateFingerprint(connection, commandId)).toBe(before);
      } finally {
        database.close();
      }
    }

    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (8893, ?, ?)",
      ).run("website:epoch-plan-zero.example", at);
      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (8894, ?, ?)",
      ).run("website:epoch-plan-zero-extra.example", at);
      const emptyEpochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8893 AND is_active = 1
      `).pluck().get());
      const otherEpochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8894 AND is_active = 1
      `).pluck().get());
      seedEpochBoundRun(connection, 88_941, 8894, otherEpochId, at, false);
      const extraRunTarget = {
        tableName: "research_runs",
        pkV1: encodePrivacyPurgePrimaryKeyV1([{
          type: "integer" as const,
          value: 88_941,
        }]),
      };
      insertPrivacyPurgeCommand(connection, {
        id: 88_903,
        targetKind: "resource_history",
        historyEpochId: emptyEpochId,
        orderedTargets: [extraRunTarget],
        createdAt: at,
      });
      const before = privacyPurgeStateFingerprint(connection, 88_903);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(88_903, [extraRunTarget], at, "9"),
      )).toThrow(/exactly match the lifecycle commitment/i);
      expect(privacyPurgeStateFingerprint(connection, 88_903)).toBe(before);
    } finally {
      database.close();
    }
  });

  it("fences a zero-run history epoch against runs inserted after lifecycle freeze", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:01.000Z";
      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (8895, ?, ?)",
      ).run("website:epoch-open-purge-fence.example", at);
      const epochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8895 AND is_active = 1
      `).pluck().get());
      insertPrivacyPurgeCommand(connection, {
        id: 88_950,
        targetKind: "resource_history",
        historyEpochId: epochId,
        orderedTargets: [],
        createdAt: at,
      });
      const insertLateRun = connection.transaction(() =>
        seedEpochBoundRun(connection, 88_951, 8895, epochId, at, false)
      );
      expect(insertLateRun).toThrow(/history epoch.*purge|open.*purge/i);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_runs WHERE id = 88951",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 88951
      `).pluck().get()).toBe(0);

      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(88_950, [], at, "a"),
      );
      expect(connection.prepare(`
        SELECT COUNT(*) FROM research_history_epochs
        WHERE id = ? AND is_active = 0
      `).pluck().get(epochId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM research_runs WHERE history_epoch_id = ?
      `).pluck().get(epochId)).toBe(0);

      const freshEpochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8895 AND is_active = 1
      `).pluck().get());
      const generationId = seedEpochBoundRun(
        connection,
        88_952,
        8895,
        freshEpochId,
        at,
        false,
      );
      insertPrivacyPurgeCommand(connection, {
        id: 88_953,
        targetKind: "resource_history",
        historyEpochId: freshEpochId,
        orderedTargets: [],
        createdAt: at,
      });
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 88_954,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/overlap/i);
    } finally {
      database.close();
    }
  });

  it("blocks run-history overlap both ways and retries failed history after rollback", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:01.000Z";
      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (8811, ?, ?)",
      ).run("website:epoch-overlap.example", at);
      const epochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 8811 AND is_active = 1
      `).pluck().get());
      const generationIds = [
        seedEpochBoundRun(connection, 88_111, 8811, epochId, at, true),
        seedEpochBoundRun(connection, 88_112, 8811, epochId, at, false),
      ];

      insertPrivacyPurgeCommand(connection, {
        id: 88_110,
        targetKind: "run",
        subjectGenerationId: generationIds[0]!,
        orderedTargets: [],
        createdAt: at,
      });
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 88_111,
        targetKind: "resource_history",
        historyEpochId: epochId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/overlap/i);
      executePrivacyPurgePlan(connection, {
        version: "privacy_purge_execution:v1",
        commandId: 88_110,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "1".repeat(64),
        completedAt: at,
      });

      insertPrivacyPurgeCommand(connection, {
        id: 88_112,
        targetKind: "resource_history",
        historyEpochId: epochId,
        orderedTargets: [],
        createdAt: at,
      });
      executePrivacyPurgePlan(connection, {
        version: "privacy_purge_execution:v1",
        commandId: 88_112,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "2".repeat(64),
        completedAt: at,
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id IN (?, ?) AND is_active = 1 AND research_run_id IS NOT NULL
      `).pluck().get(...generationIds)).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = 88112
      `).pluck().get()).toBe(0);

      const retryTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 88_113,
        targetKind: "resource_history",
        historyEpochId: epochId,
        orderedTargets: retryTargets,
        createdAt: at,
      });
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 88_114,
        targetKind: "run",
        subjectGenerationId: generationIds[1]!,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/overlap/i);
      const retryPlan = completedPrivacyPurgePlan(88_113, retryTargets, at, "3");
      const beforeInjectedFailure = privacyPurgeStateFingerprint(connection, 88_113);
      expect(() => executePrivacyPurgePlan(connection, retryPlan, {
        testOnlyFailurePoint: "after_first_retirement",
      })).toThrow(/injected privacy purge execution failure/i);
      expect(privacyPurgeStateFingerprint(connection, 88_113))
        .toBe(beforeInjectedFailure);
      executePrivacyPurgePlan(connection, retryPlan);
      expect(connection.prepare(
        "SELECT status FROM privacy_purge_commands WHERE id = 88113",
      ).pluck().get()).toBe("completed");
    } finally {
      database.close();
    }
  });

  it("accepts a singleton C90 coordinator with no handoff", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      seedCapturedResearchSource(connection, "research_acquisition:c90:v1");
      const generation = connection.prepare(`
        SELECT id, generation_token FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9001
          AND is_active = 1
      `).get() as { id: number; generation_token: string };
      insertPrivacyPurgeCommand(connection, {
        id: 25_010,
        targetKind: "run",
        subjectGenerationId: generation.id,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: "2026-08-14T12:00:02.000Z",
      });
      const lifecycleRows = connection.prepare(`
        SELECT subject_generation_id AS subjectGenerationId,
          generation_token AS generationToken, research_run_id AS researchRunId
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25010 ORDER BY subject_generation_id
      `).all() as Array<{
        subjectGenerationId: number;
        generationToken: string;
        researchRunId: number;
      }>;
      const command = connection.prepare(`
        SELECT lifecycle_target_count, lifecycle_plan_digest
        FROM privacy_purge_commands WHERE id = 25010
      `).get() as {
        lifecycle_target_count: number;
        lifecycle_plan_digest: string;
      };
      expect(lifecycleRows).toEqual([{
        subjectGenerationId: generation.id,
        generationToken: generation.generation_token,
        researchRunId: 9001,
      }]);
      expect(command.lifecycle_target_count).toBe(1);
      expect(command.lifecycle_plan_digest).toBe(
        digestPrivacyPurgeLifecycleTargets(lifecycleRows),
      );
    } finally {
      database.close();
    }
  });

  it("rejects a reverse-only C81-to-C90 handoff inside command freeze", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (8810, 'website:reverse-semantic.example', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          8810, 'resource_research', 'resource', 8810, 'resource:8810',
          'user', 'manual', 'reverse-semantic-c90', '${"a".repeat(64)}',
          '${"b".repeat(64)}', 'research_acquisition:c90:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          8810, 8810, 8810, 'resource:8810', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_acquisition:c90:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 8810 AND is_active = 1)
        );
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (8810, 1, 'queued', 'queued', 'reverse-semantic-c90-queued', '${at}');
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (8810, 2, 'superseded', 'queued', 'superseded', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          8811, 'resource_research', 'resource', 8810, 'resource:8810',
          'user', 'manual', 'reverse-semantic-c81', '${"e".repeat(64)}',
          '${"f".repeat(64)}', 'research_workflow:c81:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          8811, 8811, 8810, 'resource:8810', '${"1".repeat(64)}', '{}',
          '${"f".repeat(64)}', '${"2".repeat(64)}', '${"e".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 8810 AND is_active = 1)
        );
        DROP TRIGGER live_acquisition_handoffs_insert_guard;
      `);
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (8810, 8811)
          AND is_active = 1 ORDER BY research_run_id
      `).all() as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (8810, ?, 8810, 'assembling', ?)
      `).run(byRun.get(8811), at);

      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_011,
        targetKind: "run",
        subjectGenerationId: byRun.get(8811)!,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25011
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25011
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects an assembling C90-to-C81 handoff without a terminal receipt", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (8820, 'website:assembling-semantic.example', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          8820, 'resource_research', 'resource', 8820, 'resource:8820',
          'user', 'manual', 'assembling-semantic-c90', '${"a".repeat(64)}',
          '${"b".repeat(64)}', 'research_acquisition:c90:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          8820, 8820, 8820, 'resource:8820', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_acquisition:c90:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 8820 AND is_active = 1)
        );
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (8820, 1, 'queued', 'queued', 'assembling-semantic-c90-queued', '${at}');
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (8820, 2, 'superseded', 'queued', 'superseded', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          8821, 'resource_research', 'resource', 8820, 'resource:8820',
          'user', 'manual', 'assembling-semantic-c81', '${"e".repeat(64)}',
          '${"f".repeat(64)}', 'research_workflow:c81:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          8821, 8821, 8820, 'resource:8820', '${"1".repeat(64)}', '{}',
          '${"f".repeat(64)}', '${"2".repeat(64)}', '${"e".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 8820 AND is_active = 1)
        );
      `);
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (8820, 8821)
          AND is_active = 1 ORDER BY research_run_id
      `).all() as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (8820, ?, 8821, 'assembling', ?)
      `).run(byRun.get(8820), at);

      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_012,
        targetKind: "run",
        subjectGenerationId: byRun.get(8820)!,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25012
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25012
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("accepts a completed receipt-backed handoff after the final job starts", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, 1, 'semantic-final-running', 'semantic-worker', ?, 'running')
      `).run(fixture.finalJobId, "2026-08-14T12:00:02.000Z");
      expect(connection.prepare(`
        SELECT status FROM ai_jobs WHERE id = ?
      `).pluck().get(fixture.finalJobId)).toBe("running");
      const rootGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));

      insertPrivacyPurgeCommand(connection, {
        id: 25_013,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: "2026-08-14T12:00:02.000Z",
      });
      const lifecycleRows = connection.prepare(`
        SELECT subject_generation_id AS subjectGenerationId,
          generation_token AS generationToken, research_run_id AS researchRunId
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25013 ORDER BY subject_generation_id
      `).all() as Array<{
        subjectGenerationId: number;
        generationToken: string;
        researchRunId: number;
      }>;
      const command = connection.prepare(`
        SELECT lifecycle_target_count, lifecycle_plan_digest
        FROM privacy_purge_commands WHERE id = 25013
      `).get() as {
        lifecycle_target_count: number;
        lifecycle_plan_digest: string;
      };
      expect(lifecycleRows).toHaveLength(2);
      expect(command.lifecycle_target_count).toBe(2);
      expect(command.lifecycle_plan_digest).toBe(
        digestPrivacyPurgeLifecycleTargets(lifecycleRows),
      );
    } finally {
      database.close();
    }
  });

  it("rejects an over-cap corrupt cyclic run graph and rolls the command freeze back", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const at = "2026-08-14T12:00:02.000Z";
      connection.exec(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (
          ${fixture.finalJobId}, 2, 'superseded', 'queued', 'superseded', '${at}'
        );
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          7003, 'resource_research', 'resource', 7001, 'resource:7001',
          'user', 'manual', 'corrupt-cycle-final', '${"a".repeat(64)}',
          '${"b".repeat(64)}', 'research_workflow:c81:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          7003, 7003, 7001, 'resource:7001', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 7001 AND is_active = 1)
        );
        DROP TRIGGER live_acquisition_handoffs_insert_guard;
      `);
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (7001, 7002, 7003)
          AND is_active = 1 ORDER BY research_run_id
      `).all() as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (2, ?, 7003, 'assembling', ?)
      `).run(byRun.get(fixture.finalRunId), at);
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (3, ?, 7001, 'assembling', ?)
      `).run(byRun.get(7003), at);

      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_004,
        targetKind: "run",
        subjectGenerationId: byRun.get(fixture.coordinatorJobId)!,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25004
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25004
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects a two-node reverse edge even when the normal handoff guard is absent", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const at = "2026-08-14T12:00:02.000Z";
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (?, ?)
          AND is_active = 1 ORDER BY research_run_id
      `).all(
        fixture.coordinatorJobId,
        fixture.finalRunId,
      ) as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      connection.exec("DROP TRIGGER live_acquisition_handoffs_insert_guard");
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (2, ?, ?, 'assembling', ?)
      `).run(
        byRun.get(fixture.finalRunId),
        fixture.coordinatorJobId,
        at,
      );

      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_005,
        targetKind: "run",
        subjectGenerationId: byRun.get(fixture.coordinatorJobId)!,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25005
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25005
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps handoff cardinality unique and rejects final outgoing extensions", () => {
    const at = "2026-08-14T12:00:02.000Z";
    const openThreeRunGraph = () => {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, at);
      const additionalGenerationId = seedAdditionalResearchRun(
        connection,
        7_003,
        at,
      );
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (?, ?)
          AND is_active = 1 ORDER BY research_run_id
      `).all(
        fixture.coordinatorJobId,
        fixture.finalRunId,
      ) as Array<{ research_run_id: number; id: number }>;
      return {
        database,
        connection,
        fixture,
        additionalGenerationId,
        byRun: new Map(generations.map((row) => [row.research_run_id, row.id])),
      };
    };

    const cardinality = openThreeRunGraph();
    try {
      cardinality.connection.exec(
        "DROP TRIGGER live_acquisition_handoffs_insert_guard",
      );
      expect(() => cardinality.connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (2, ?, 7003, 'assembling', ?)
      `).run(
        cardinality.byRun.get(cardinality.fixture.coordinatorJobId),
        at,
      )).toThrow(/unique/i);
      expect(() => cardinality.connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (3, ?, ?, 'assembling', ?)
      `).run(
        cardinality.additionalGenerationId,
        cardinality.fixture.finalRunId,
        at,
      )).toThrow(/unique/i);
    } finally {
      cardinality.database.close();
    }

    const extension = openThreeRunGraph();
    try {
      extension.connection.exec(
        "DROP TRIGGER live_acquisition_handoffs_insert_guard",
      );
      extension.connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (2, ?, 7003, 'assembling', ?)
      `).run(extension.byRun.get(extension.fixture.finalRunId), at);

      expect(() => insertPrivacyPurgeCommand(extension.connection, {
        id: 25_009,
        targetKind: "run",
        subjectGenerationId: extension.byRun.get(
          extension.fixture.coordinatorJobId,
        )!,
        orderedTargets: everyExistingPurgeTarget(extension.connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(extension.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25009
      `).pluck().get()).toBe(0);
      expect(extension.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25009
      `).pluck().get()).toBe(0);
    } finally {
      extension.database.close();
    }
  });

  it("rejects self-loop and inactive-descendant run graphs inside command freeze", () => {
    const at = "2026-08-14T12:00:02.000Z";
    const selfLoopDatabase = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = selfLoopDatabase.connection;
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (8800, 'website:self-loop.example', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          8800, 'resource_research', 'resource', 8800, 'resource:8800',
          'user', 'manual', 'self-loop-job', '${"a".repeat(64)}',
          '${"b".repeat(64)}', 'research_workflow:c81:v1', 1, 0, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          8800, 8800, 8800, 'resource:8800', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 8800 AND is_active = 1)
        );
        DROP TRIGGER live_acquisition_handoffs_insert_guard;
      `);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 8800
          AND is_active = 1
      `).pluck().get());
      connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (8800, ?, 8800, 'assembling', ?)
      `).run(generationId, at);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_006,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25006
      `).pluck().get()).toBe(0);
    } finally {
      selfLoopDatabase.close();
    }

    const inactiveDatabase = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = inactiveDatabase.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (?, ?)
          AND is_active = 1 ORDER BY research_run_id
      `).all(
        fixture.coordinatorJobId,
        fixture.finalRunId,
      ) as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      connection.exec("DROP TRIGGER privacy_subject_generations_validate_update");
      connection.prepare(`
        UPDATE privacy_subject_generations
        SET is_active = 0, retired_at = ? WHERE id = ?
      `).run(at, byRun.get(fixture.finalRunId));
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_007,
        targetKind: "run",
        subjectGenerationId: byRun.get(fixture.coordinatorJobId)!,
        orderedTargets: everyExistingPurgeTarget(connection),
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id = 25007
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 25007
      `).pluck().get()).toBe(0);
    } finally {
      inactiveDatabase.close();
    }
  });

  it("rejects parent-first live-action purge plans before mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-action-purge-order-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
      const rootGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));
      const orderedTargets = [...everyExistingPurgeTarget(connection)];
      const actionRows = connection.prepare(`
        SELECT id, depth, discovered_from_action_id
        FROM live_acquisition_actions ORDER BY depth DESC, id
      `).all() as Array<{
        id: number;
        depth: number;
        discovered_from_action_id: number | null;
      }>;
      expect(actionRows).toHaveLength(2);
      expect(actionRows.map(({ depth }) => depth)).toEqual([1, 0]);
      const actionPk = (id: number) => encodePrivacyPurgePrimaryKeyV1([
        { type: "integer", value: id },
      ]);
      const childPk = actionPk(actionRows[0]!.id);
      const parentPk = actionPk(actionRows[1]!.id);
      const childIndex = orderedTargets.findIndex((target) =>
        target.tableName === "live_acquisition_actions" && target.pkV1 === childPk
      );
      const parentIndex = orderedTargets.findIndex((target) =>
        target.tableName === "live_acquisition_actions" && target.pkV1 === parentPk
      );
      expect(childIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeGreaterThan(childIndex);
      [orderedTargets[childIndex], orderedTargets[parentIndex]] = [
        orderedTargets[parentIndex]!,
        orderedTargets[childIndex]!,
      ];
      const at = "2026-08-14T12:00:03.000Z";
      insertPrivacyPurgeCommand(connection, {
        id: 149,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets,
        createdAt: at,
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(149, orderedTargets, at, "e"),
      )).toThrow(/descendants before parents/i);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_actions",
      ).pluck().get()).toBe(2);
      expect(connection.prepare(`
        SELECT is_active FROM privacy_subject_generations WHERE id = ?
      `).pluck().get(rootGenerationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 149
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = 149
      `).pluck().get()).toBe(0);
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects a live-action purge plan that retains a discovered child", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-action-purge-child-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
      const rootGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));
      const actionsBefore = connection.prepare(`
        SELECT id, state, sequence_no, depth, discovered_from_action_id
        FROM live_acquisition_actions ORDER BY id
      `).all();
      expect(actionsBefore).toHaveLength(2);
      const childId = Number(connection.prepare(`
        SELECT id FROM live_acquisition_actions
        WHERE discovered_from_action_id IS NOT NULL
      `).pluck().get());
      const childPk = encodePrivacyPurgePrimaryKeyV1([
        { type: "integer", value: childId },
      ]);
      const orderedTargets = everyExistingPurgeTarget(connection).filter((target) =>
        target.tableName !== "live_acquisition_actions" || target.pkV1 !== childPk
      );
      expect(orderedTargets.some((target) =>
        target.tableName === "live_acquisition_actions"
      )).toBe(true);
      const at = "2026-08-14T12:00:04.000Z";
      insertPrivacyPurgeCommand(connection, {
        id: 150,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets,
        createdAt: at,
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(150, orderedTargets, at, "f"),
      )).toThrow(/cannot retain.*child/i);
      expect(connection.prepare(`
        SELECT id, state, sequence_no, depth, discovered_from_action_id
        FROM live_acquisition_actions ORDER BY id
      `).all()).toEqual(actionsBefore);
      expect(connection.prepare(`
        SELECT is_active FROM privacy_subject_generations WHERE id = ?
      `).pluck().get(rootGenerationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 150
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = 150
      `).pluck().get()).toBe(0);
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("retires the whole run graph before deletion and rolls every fault back", () => {
    const at = "2026-08-14T12:00:02.000Z";
    for (const [index, failurePoint] of ([
      "after_first_retirement",
      "mid_delete",
      "before_result_status",
    ] as const).entries()) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      try {
        const connection = database.connection;
        const commandId = 25_100 + index;
        const fixture = seedCommittedRunGraphPurge(connection, commandId);
        const before = privacyPurgeStateFingerprint(connection, commandId);
        expect(() => executePrivacyPurgePlan(
          connection,
          completedPrivacyPurgePlan(
            commandId,
            fixture.orderedTargets,
            at,
            String(index + 1),
          ),
          { testOnlyFailurePoint: failurePoint },
        )).toThrow(new RegExp(failurePoint, "i"));
        expect(privacyPurgeStateFingerprint(connection, commandId)).toBe(before);
        expect(connection.inTransaction).toBe(false);
      } finally {
        database.close();
      }
    }

    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const commandId = 25_200;
      const fixture = seedCommittedRunGraphPurge(connection, commandId);
      const plan = completedPrivacyPurgePlan(
        commandId,
        fixture.orderedTargets,
        at,
        "7",
      );
      executePrivacyPurgePlan(connection, plan);

      expect(connection.prepare(`
        SELECT COUNT(*) FROM research_runs WHERE id IN (?, ?)
      `).pluck().get(fixture.coordinatorRunId, fixture.finalRunId)).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations AS generation
        JOIN privacy_purge_lifecycle_targets AS target
          ON target.subject_generation_id = generation.id
        WHERE target.purge_command_id = ? AND generation.is_active = 0
          AND generation.research_run_id IS NULL
          AND generation.generation_token = target.generation_token
      `).pluck().get(commandId)).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = ?
      `).pluck().get(commandId)).toBe(2);
      expect(connection.prepare(
        "SELECT status FROM privacy_purge_commands WHERE id = ?",
      ).pluck().get(commandId)).toBe("completed");
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = ?
      `).pluck().get(commandId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = ?
      `).pluck().get(commandId)).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_transaction_fences",
      ).pluck().get()).toBe(0);

      const retiredRoot = connection.prepare(`
        SELECT generation_token FROM privacy_subject_generations
        WHERE id = ? AND is_active = 0 AND research_run_id IS NULL
      `).get(fixture.rootGenerationId) as { generation_token: string };
      const descendantTombstoneId = Number(connection.prepare(`
        SELECT tombstone.id FROM privacy_subject_tombstones AS tombstone
        JOIN privacy_purge_lifecycle_targets AS target
          ON target.purge_command_id = tombstone.purge_command_id
          AND target.subject_generation_id = tombstone.subject_generation_id
        WHERE tombstone.purge_command_id = ? AND target.is_root = 0
      `).pluck().get(commandId));
      expect(() => connection.prepare(`
        DELETE FROM privacy_subject_tombstones WHERE id = ?
      `).run(descendantTombstoneId)).toThrow(/permanent/i);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 25_201,
        targetKind: "run",
        subjectGenerationId: fixture.rootGenerationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/SUBJECT_FORGOTTEN_OR_INVALID/i);
      expect(() => connection.prepare(`
        INSERT INTO privacy_subject_generations (
          subject_kind, research_run_id, generation_token,
          is_active, created_at, retired_at
        ) VALUES ('research_run', NULL, ?, 0, ?, ?)
      `).run(retiredRoot.generation_token, at, at)).toThrow(/unique/i);
      connection.exec(`
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          ${fixture.coordinatorRunId}, 'resource_research', 'resource', 7001,
          'resource:7001', 'user', 'manual', 'reused-run-new-job',
          '${"a".repeat(64)}', '${"b".repeat(64)}',
          'research_acquisition:c90:v1', 1, 0, '${at}', 10, 1000, 1,
          60000, '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          ${fixture.coordinatorRunId}, ${fixture.coordinatorRunId}, 7001,
          'resource:7001', '${"c".repeat(64)}', '{}', '${"b".repeat(64)}',
          '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_acquisition:c90:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 7001 AND is_active = 1)
        );
      `);
      const successor = connection.prepare(`
        SELECT id, generation_token FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).get(fixture.coordinatorRunId) as {
        id: number;
        generation_token: string;
      };
      expect(successor.id).not.toBe(fixture.rootGenerationId);
      expect(successor.generation_token).not.toBe(retiredRoot.generation_token);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = ?
      `).pluck().get(commandId)).toBe(2);
    } finally {
      database.close();
    }
  });

  it("fails closed on lifecycle-plan drift and replays an exact terminal plan without writes", () => {
    const at = "2026-08-14T12:00:02.000Z";
    for (const drift of ["omitted", "extra"] as const) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      try {
        const connection = database.connection;
        const fixture = seedReceiptBackedLiveResearchRun(connection);
        connection.prepare(`
          INSERT INTO ai_job_events (
            job_id, sequence_no, event_type, from_status, to_status, occurred_at
          ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
        `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
        const rootGenerationId = Number(connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'research_run' AND research_run_id = ?
            AND is_active = 1
        `).pluck().get(fixture.coordinatorJobId));
        const completeTargets = everyExistingPurgeTarget(connection);
        const malformedTargets = drift === "omitted"
          ? completeTargets.filter((target) =>
            target.tableName !== "research_runs" ||
            target.pkV1 !== encodePrivacyPurgePrimaryKeyV1([
              { type: "integer", value: fixture.finalRunId },
            ])
          )
          : [...completeTargets, {
            tableName: "research_runs",
            pkV1: encodePrivacyPurgePrimaryKeyV1([
              { type: "integer", value: 987_654_321 },
            ]),
          }];
        const commandId = drift === "omitted" ? 25_301 : 25_302;
        insertPrivacyPurgeCommand(connection, {
          id: commandId,
          targetKind: "run",
          subjectGenerationId: rootGenerationId,
          orderedTargets: malformedTargets,
          createdAt: at,
        });
        const before = privacyPurgeStateFingerprint(connection, commandId);
        expect(() => executePrivacyPurgePlan(
          connection,
          completedPrivacyPurgePlan(commandId, malformedTargets, at, "8"),
        )).toThrow(/exactly match the lifecycle commitment/i);
        expect(privacyPurgeStateFingerprint(connection, commandId)).toBe(before);
      } finally {
        database.close();
      }
    }

    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const commandId = 25_303;
      const fixture = seedCommittedRunGraphPurge(connection, commandId);
      const plan = completedPrivacyPurgePlan(
        commandId,
        fixture.orderedTargets,
        at,
        "9",
      );
      executePrivacyPurgePlan(connection, plan);
      const beforeReplay = privacyPurgeStateFingerprint(connection, commandId);
      const changesBeforeReplay = Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get());
      executePrivacyPurgePlan(connection, plan);
      expect(Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get())).toBe(changesBeforeReplay);
      expect(privacyPurgeStateFingerprint(connection, commandId)).toBe(beforeReplay);

      const divergentTargets = fixture.orderedTargets.slice(1);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(commandId, divergentTargets, at, "9"),
      )).toThrow(/replay conflicts/i);
      expect(Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get())).toBe(changesBeforeReplay);
      expect(privacyPurgeStateFingerprint(connection, commandId)).toBe(beforeReplay);

      expect(() => digestPrivacyPurgeExecutionTargets([
        fixture.orderedTargets[0]!,
        fixture.orderedTargets[0]!,
      ])).toThrow(/duplicated/i);
    } finally {
      database.close();
    }
  });

  it("retries a failed singleton run while preserving its exact failed history", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      seedCapturedResearchSource(connection);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9001
          AND is_active = 1
      `).pluck().get());
      insertPrivacyPurgeCommand(connection, {
        id: 26_001,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: [],
        createdAt: at,
      });
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 26_002,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/unique|overlap/i);

      const failedPlan: PrivacyPurgeExecutionPlan = {
        version: "privacy_purge_execution:v1",
        commandId: 26_001,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "3".repeat(64),
        completedAt: at,
      };
      executePrivacyPurgePlan(connection, failedPlan);
      expect(connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = 26001
      `).pluck().get()).toBe("failed");
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26001 AND subject_generation_id = ?
      `).pluck().get(generationId)).toBe(1);
      expect(connection.prepare(`
        SELECT is_active FROM privacy_subject_generations WHERE id = ?
      `).pluck().get(generationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = 26001
      `).pluck().get()).toBe(0);

      const failedFingerprint = privacyPurgeStateFingerprint(connection, 26_001);
      const changesBeforeReplay = Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get());
      executePrivacyPurgePlan(connection, failedPlan);
      expect(Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get())).toBe(changesBeforeReplay);
      expect(privacyPurgeStateFingerprint(connection, 26_001)).toBe(
        failedFingerprint,
      );

      const retryTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 26_003,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: retryTargets,
        createdAt: at,
      });
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(26_003, retryTargets, at, "4"),
      );
      expect(connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = 26003
      `).pluck().get()).toBe("completed");
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE subject_generation_id = ?
      `).pluck().get(generationId)).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26001
      `).pluck().get()).toBe(1);
      expect(() => connection.prepare(`
        DELETE FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26001
      `).run()).toThrow(/permanent/i);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 26_004,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/SUBJECT_FORGOTTEN_OR_INVALID/i);
    } finally {
      database.close();
    }
  });

  it("retries a failed root-final graph without allowing open overlap", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const generations = connection.prepare(`
        SELECT research_run_id, id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id IN (?, ?)
          AND is_active = 1 ORDER BY research_run_id
      `).all(
        fixture.coordinatorJobId,
        fixture.finalRunId,
      ) as Array<{ research_run_id: number; id: number }>;
      const byRun = new Map(generations.map((row) => [row.research_run_id, row.id]));
      const rootGenerationId = byRun.get(fixture.coordinatorJobId)!;
      const finalGenerationId = byRun.get(fixture.finalRunId)!;
      insertPrivacyPurgeCommand(connection, {
        id: 26_101,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets: [],
        createdAt: at,
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26101
      `).pluck().get()).toBe(2);
      expect(() => connection.prepare(`
        DELETE FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26101
      `).run()).toThrow(/permanent/i);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 26_102,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/unique|overlap/i);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 26_103,
        targetKind: "run",
        subjectGenerationId: finalGenerationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/invalid privacy purge run lifecycle graph|overlap/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands WHERE id IN (26102, 26103)
      `).pluck().get()).toBe(0);

      const failedPlan: PrivacyPurgeExecutionPlan = {
        version: "privacy_purge_execution:v1",
        commandId: 26_101,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "5".repeat(64),
        completedAt: at,
      };
      executePrivacyPurgePlan(connection, failedPlan);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26101
      `).pluck().get()).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id IN (?, ?) AND is_active = 1
      `).pluck().get(rootGenerationId, finalGenerationId)).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = 26101
      `).pluck().get()).toBe(0);
      const failedFingerprint = privacyPurgeStateFingerprint(connection, 26_101);
      const changesBeforeReplay = Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get());
      executePrivacyPurgePlan(connection, failedPlan);
      expect(Number(connection.prepare(
        "SELECT total_changes()",
      ).pluck().get())).toBe(changesBeforeReplay);
      expect(privacyPurgeStateFingerprint(connection, 26_101)).toBe(
        failedFingerprint,
      );

      const retryTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 26_104,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets: retryTargets,
        createdAt: at,
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id IN (26101, 26104)
      `).pluck().get()).toBe(4);
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(26_104, retryTargets, at, "6"),
      );
      expect(connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = 26104
      `).pluck().get()).toBe("completed");
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = 26104
      `).pluck().get()).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id IN (?, ?) AND is_active = 0 AND research_run_id IS NULL
      `).pluck().get(rootGenerationId, finalGenerationId)).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = 26101
      `).pluck().get()).toBe(2);
      expect(() => insertPrivacyPurgeCommand(connection, {
        id: 26_105,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets: [],
        createdAt: at,
      })).toThrow(/SUBJECT_FORGOTTEN_OR_INVALID/i);
    } finally {
      database.close();
    }
  });

  it("backfills direct immutable history-epoch membership while opening schema 24 as 25", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const schema24 = new Database(databasePath);
    try {
      seedCapturedResearchSource(schema24);
    } finally {
      schema24.close();
    }

    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      expect(database.schemaVersion).toBe(25);
      expect(
        database.connection.pragma("foreign_keys", { simple: true }),
      ).toBe(1);
      expect(database.connection.prepare(`
        SELECT run.history_epoch_id
        FROM research_runs AS run
        JOIN research_history_epochs AS history
          ON history.id = run.history_epoch_id
        WHERE run.id = 9001
          AND history.resource_id = run.target_resource_id
          AND history.is_active = 1
      `).pluck().get()).toEqual(expect.any(Number));
      expect(database.connection.pragma("foreign_key_list(research_runs)"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            from: "history_epoch_id",
            table: "research_history_epochs",
            to: "id",
            on_delete: "RESTRICT",
          }),
        ]));
      const insertUnboundResourceRun = database.connection.prepare(`
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at
        ) VALUES (
          99001, 99001, 9001, 'resource:9001', ?, '{}', ?, ?, ?,
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, ?
        )
      `);
      expect(() => insertUnboundResourceRun.run(
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
        "2026-08-14T11:00:00.000Z",
      )).toThrow(/bind its target resource history epoch/i);
      expect(
        database.connection
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name IN (
               'privacy_subject_generations',
               'research_history_epochs',
               'live_acquisition_runtime_state'
             ) ORDER BY name`,
          )
          .pluck()
          .all(),
      ).toEqual([
        "live_acquisition_runtime_state",
        "privacy_subject_generations",
        "research_history_epochs",
      ]);
      expect(
        database.connection
          .prepare(
            `SELECT runtime_epoch, off_recovery_marker
             FROM live_acquisition_runtime_state WHERE singleton_id = 1`,
          )
          .get(),
      ).toEqual({
        runtime_epoch: 1,
        off_recovery_marker: "pending",
      });
      const schema25Tables = [
        "privacy_subject_generations",
        "research_history_epochs",
        "live_acquisition_runtime_state",
        "live_acquisition_handoffs",
        "live_acquisition_handoff_receipts",
        "live_acquisition_source_receipts",
        "research_sources",
        "live_acquisition_consents",
        "live_acquisition_consent_payloads",
        "live_acquisition_digest_keys",
        "live_acquisition_actions",
        "live_acquisition_page_reservations",
        "live_acquisition_action_authorizations",
        "live_acquisition_action_events",
        "live_acquisition_url_payloads",
        "live_acquisition_dns_payloads",
        "live_acquisition_body_payloads",
        "live_acquisition_checkpoints",
        "live_acquisition_origin_courtesy_state",
        "live_acquisition_capture_manifests",
        "live_acquisition_provider_reservation_adoptions",
        "live_acquisition_provider_reservations",
        "live_acquisition_workflow_outcomes",
        "privacy_purge_commands",
        "privacy_purge_transaction_fence_roots",
        "privacy_purge_transaction_fences",
        "privacy_purge_authorities",
        "privacy_purge_lifecycle_targets",
        "privacy_purge_results",
        "privacy_subject_tombstones",
        "privacy_purge_deletion_manifest",
        "privacy_purge_target_catalog",
      ];
      const strictTables = database.connection.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND sql LIKE '% STRICT'
         ORDER BY name`,
      ).pluck().all() as string[];
      expect(strictTables).toEqual([...schema25Tables].sort());
      expect(() => database.connection.prepare(
        `UPDATE live_acquisition_runtime_state
         SET runtime_epoch = 1.5 WHERE singleton_id = 1`,
      ).run()).toThrow(/cannot store REAL value in INTEGER column/i);
      expect(() => database.connection.prepare(
        `UPDATE live_acquisition_runtime_state
         SET updated_at = x'7b7d' WHERE singleton_id = 1`,
      ).run()).toThrow(/cannot store BLOB value in TEXT column/i);
    } finally {
      database.close();
    }
  });

  it("rolls back an injected migration failure and restores foreign keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-rollback-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const connection = new Database(databasePath);
    sqliteVec.load(connection);
    connection.function("tabhub_migration_now", () =>
      "2026-08-14T11:00:00.000Z",
    );
    connection.pragma("foreign_keys = ON");

    try {
      const migrationSql = readFileSync(
        join(process.cwd(), "migrations", "025_live_acquisition.sql"),
        "utf8",
      );
      expect(() =>
        runLiveAcquisitionMigration(connection, migrationSql, {
          failurePoint: "after_sql",
        }),
      ).toThrow(/injected live acquisition migration failure/i);
      expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(connection.pragma("user_version", { simple: true })).toBe(24);
      expect(
        connection
          .prepare(
            `SELECT COUNT(*) FROM sqlite_schema
             WHERE name = 'privacy_subject_generations'`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(connection.pragma("foreign_key_check")).toEqual([]);
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      connection.close();
    }
  });

  it("rejects affinity-corrupt schema-24 source rows before changing schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-preflight-type-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const connection = new Database(databasePath);
    try {
      sqliteVec.load(connection);
      connection.function("tabhub_migration_now", () =>
        "2026-08-14T11:00:00.000Z"
      );
      connection.pragma("foreign_keys = ON");
      seedCapturedResearchSource(connection, undefined, Buffer.alloc(64, 0x61));
      const schemaBefore = connection.prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all();
      const migrationSql = readFileSync(
        join(process.cwd(), "migrations", "025_live_acquisition.sql"),
        "utf8",
      );
      expect(() => runLiveAcquisitionMigration(connection, migrationSql))
        .toThrow(/research_sources storage-class corruption at id 9001/i);
      expect(connection.pragma("user_version", { simple: true })).toBe(24);
      expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(connection.prepare(
        "SELECT typeof(content_digest) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe("blob");
      expect(connection.prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all()).toEqual(schemaBefore);
    } finally {
      connection.close();
    }
  }, 15_000);

  it("rejects migration SQL transaction control before any schema change", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-transaction-sql-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const connection = new Database(databasePath);
    sqliteVec.load(connection);
    connection.function("tabhub_migration_now", () =>
      "2026-08-14T11:00:00.000Z",
    );
    connection.pragma("foreign_keys = ON");

    try {
      const migrationSql = readFileSync(
        join(process.cwd(), "migrations", "025_live_acquisition.sql"),
        "utf8",
      );
      for (const transactionControl of [
        "COMMIT;",
        "COMMIT; BEGIN IMMEDIATE;",
        "END;",
      ]) {
        expect(() =>
          runLiveAcquisitionMigration(
            connection,
            `${migrationSql}\n${transactionControl}`,
          ),
        ).toThrow(/migration fingerprint mismatch/i);
        expect(connection.inTransaction).toBe(false);
        expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(connection.pragma("user_version", { simple: true })).toBe(24);
        expect(connection.prepare(`
          SELECT COUNT(*) FROM sqlite_schema
          WHERE name = 'privacy_subject_generations'
        `).pluck().get()).toBe(0);
        expect(connection.pragma("foreign_key_check")).toEqual([]);
        expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
      }
    } finally {
      connection.close();
    }
  });

  it("distinguishes a trigger END from top-level transaction END", () => {
    expect(() => assertNoMigrationTransactionControl(`
      CREATE TRIGGER accepted AFTER INSERT ON sample
      BEGIN
        SELECT CASE WHEN NEW.id = 1 THEN 'END;' ELSE 'BEGIN;' END;
        -- END; in a comment is inert
        SELECT 1;
      END;
    `)).not.toThrow();
    for (const sql of [
      "END;",
      "/* an inert END; */ END TRANSACTION;",
      "-- an inert END;\nEND;",
      "SELECT 1; END;",
      `CREATE TABLE t(foo$case INT);
       CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT NEW.foo$case; END;
       COMMIT;`,
      `CREATE TABLE unicode_t(fooЖCASE INT);
       CREATE TRIGGER unicode_tr AFTER INSERT ON unicode_t
       BEGIN SELECT NEW.fooЖCASE; END; END;`,
    ]) {
      expect(() => assertNoMigrationTransactionControl(sql))
        .toThrow(/must not contain transaction control/i);
    }
  });

  it("copy-swaps only research_sources and preserves every child schema and FK", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-swap-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const childTables = [
      "research_source_state_events",
      "research_source_payloads",
      "research_report_sources",
      "research_claim_evidence",
    ];
    const before = new Database(databasePath);
    const childSchemas = new Map(
      childTables.map((table) => [
        table,
        {
          sql: before
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .pluck()
            .get(table),
          foreignKeys: before.pragma(`foreign_key_list('${table}')`),
        },
      ]),
    );
    before.close();

    const database = openDatabase(databasePath);
    try {
      const columns = (
        database.connection.pragma("table_info('research_sources')") as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(columns).toContain("source_kind");
      expect(columns).toContain("handoff_source_receipt_id");

      for (const table of childTables) {
        expect(
          database.connection
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .pluck()
            .get(table),
        ).toBe(childSchemas.get(table)?.sql);
        expect(database.connection.pragma(`foreign_key_list('${table}')`)).toEqual(
          childSchemas.get(table)?.foreignKeys,
        );
      }

      const externalTriggers = database.connection
        .prepare(
          `SELECT name, sql FROM sqlite_schema
           WHERE type = 'trigger' AND name IN (
             'research_source_payloads_insert_guard',
             'research_report_sources_same_run',
             'research_claim_evidence_same_run',
             'contents_invalidate_research_sources_after_update',
             'contents_invalidate_research_sources_after_delete'
           ) ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(externalTriggers.map(({ name }) => name)).toEqual([
        "contents_invalidate_research_sources_after_delete",
        "contents_invalidate_research_sources_after_update",
        "research_claim_evidence_same_run",
        "research_report_sources_same_run",
        "research_source_payloads_insert_guard",
      ]);
      expect(
        externalTriggers.find(
          ({ name }) => name === "research_source_payloads_insert_guard",
        )?.sql,
      ).toContain("source.source_kind = 'live_acquisition'");
    } finally {
      database.close();
    }
  });

  it("rejects and rolls back a copy-swap that loses a captured source row", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-checksum-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const connection = new Database(databasePath);
    sqliteVec.load(connection);
    connection.function("tabhub_migration_now", () =>
      "2026-08-14T11:00:00.000Z",
    );
    connection.pragma("foreign_keys = ON");

    try {
      seedCapturedResearchSource(connection);
      const migrationSql = readFileSync(
        join(process.cwd(), "migrations", "025_live_acquisition.sql"),
        "utf8",
      );
      expect(() =>
        runLiveAcquisitionMigration(connection, migrationSql, {
          testOnlyValidationProbe: "delete_captured_source",
        }),
      ).toThrow(/research_sources (row count|checksum)/i);
      expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(connection.pragma("user_version", { simple: true })).toBe(24);
      expect(
        connection.prepare("SELECT COUNT(*) FROM research_sources").pluck().get(),
      ).toBe(1);
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("rejects rogue guards, semantic replacements, and complete schema drift", () => {
    const cases = [
      {
        name: "post-delete-guard",
        probe: "post_delete_guard",
        expected: /Schema-25 blocking deletion trigger inventory drifted/i,
      },
      {
        name: "source-column",
        probe: "source_column",
        expected: /research_sources table fingerprint drifted/i,
      },
      {
        name: "manifest-pk",
        probe: "manifest_pk",
        expected: /purge catalog guard binding drifted|Deletion manifest aggregate fingerprint drifted/i,
      },
      {
        name: "external-trigger-semantic-replacement",
        probe: "external_trigger_semantic_replacement",
        expected: /External research_sources trigger fingerprint drifted/i,
      },
      {
        name: "manifest-self-consistent-replacement",
        probe: "manifest_self_consistent_replacement",
        expected: /purge catalog guard binding drifted|Deletion manifest aggregate fingerprint drifted/i,
      },
      {
        name: "c90-table-column",
        probe: "c90_table_column",
        expected: /Schema-25 owned schema aggregate fingerprint drifted/i,
      },
      {
        name: "modified-existing-trigger-drop",
        probe: "modified_existing_trigger_drop",
        expected: /Schema-25 owned schema aggregate fingerprint drifted/i,
      },
      {
        name: "existing-view-drop",
        probe: "existing_view_drop",
        expected: /Schema-25 owned schema aggregate fingerprint drifted/i,
      },
      {
        name: "new-external-dependency-drop",
        probe: "new_external_dependency_drop",
        expected: /External research_sources dependency inventory changed/i,
      },
    ] as const;
    for (const testCase of cases) {
      const directory = mkdtempSync(
        join(tmpdir(), `tabhub-live-${testCase.name}-`),
      );
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "tabhub.sqlite");
      createSchema24(databasePath);
      const connection = new Database(databasePath);
      try {
        sqliteVec.load(connection);
        connection.function("tabhub_migration_now", () =>
          "2026-08-14T11:30:00.000Z",
        );
        connection.pragma("foreign_keys = ON");
        const migrationSql = readFileSync(
          join(process.cwd(), "migrations", "025_live_acquisition.sql"),
          "utf8",
        );
        expect(() =>
          runLiveAcquisitionMigration(connection, migrationSql, {
            testOnlyValidationProbe: testCase.probe,
          }),
        ).toThrow(testCase.expected);
        expect(connection.pragma("user_version", { simple: true })).toBe(24);
        expect(connection.pragma("foreign_key_check")).toEqual([]);
      } finally {
        connection.close();
      }
    }

    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-pre-guard-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seed.exec(`CREATE TRIGGER rogue_schema24_delete_guard
        BEFORE DELETE ON tabs BEGIN
          SELECT RAISE(ABORT, 'rogue schema-24 guard');
        END;`);
    } finally {
      seed.close();
    }
    expect(() => openDatabase(databasePath)).toThrow(
      /Schema-24 blocking deletion trigger inventory drifted/i,
    );
    const verification = new Database(databasePath, { readonly: true });
    try {
      expect(verification.pragma("user_version", { simple: true })).toBe(24);
    } finally {
      verification.close();
    }
  }, 60_000);

  it("creates the complete direct-FK noncycle live-acquisition privacy graph", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-graph-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath);
    try {
      const requiredTables = [
        "live_acquisition_action_authorizations",
        "live_acquisition_action_events",
        "live_acquisition_actions",
        "live_acquisition_body_payloads",
        "live_acquisition_capture_manifests",
        "live_acquisition_checkpoints",
        "live_acquisition_consent_payloads",
        "live_acquisition_consents",
        "live_acquisition_digest_keys",
        "live_acquisition_dns_payloads",
        "live_acquisition_handoff_receipts",
        "live_acquisition_handoffs",
        "live_acquisition_origin_courtesy_state",
        "live_acquisition_page_reservations",
        "live_acquisition_provider_reservation_adoptions",
        "live_acquisition_provider_reservations",
        "live_acquisition_runtime_state",
        "live_acquisition_source_receipts",
        "live_acquisition_url_payloads",
        "live_acquisition_workflow_outcomes",
        "privacy_purge_authorities",
        "privacy_purge_commands",
        "privacy_purge_deletion_manifest",
        "privacy_purge_lifecycle_targets",
        "privacy_purge_target_catalog",
        "privacy_purge_results",
        "privacy_purge_transaction_fence_roots",
        "privacy_purge_transaction_fences",
        "privacy_subject_generations",
        "privacy_subject_tombstones",
        "research_history_epochs",
      ].sort();
      const actualTables = database.connection
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND (
             name LIKE 'live_acquisition_%'
             OR name LIKE 'privacy_purge_%'
             OR name IN (
               'privacy_subject_generations',
               'privacy_subject_tombstones',
               'research_history_epochs'
             )
           ) ORDER BY name`,
        )
        .pluck()
        .all();
      expect(actualTables).toEqual(requiredTables);

      const requiredSet = new Set(requiredTables);
      const edges = new Map<string, string[]>();
      for (const table of requiredTables) {
        edges.set(
          table,
          (
            database.connection.pragma(
              `foreign_key_list('${table}')`,
            ) as Array<{ table: string }>
          )
            .map((row) => row.table)
            .filter((target) => target !== table && requiredSet.has(target)),
        );
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (table: string): void => {
        expect(visiting.has(table), `FK cycle at ${table}`).toBe(false);
        if (visited.has(table)) return;
        visiting.add(table);
        for (const target of edges.get(table) ?? []) visit(target);
        visiting.delete(table);
        visited.add(table);
      };
      for (const table of requiredTables) visit(table);
      const courtesyForeignKeys = new Set(
        (
          database.connection.pragma(
            "foreign_key_list('live_acquisition_origin_courtesy_state')",
          ) as Array<{ table: string }>
        ).map((row) => row.table),
      );
      expect(courtesyForeignKeys).toEqual(
        new Set([
          "live_acquisition_consents",
          "privacy_subject_generations",
          "research_runs",
        ]),
      );
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
      const sourceTableSql = database.connection
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'research_sources'",
        )
        .pluck()
        .get() as string;
      expect(createHash("sha256").update(sourceTableSql).digest("hex")).toBe(
        "084d854b923f6a3b926b8c40940c946d9edcc294f588d7f1f9358a32a8b02b06",
      );
    } finally {
      database.close();
    }
  });

  it("freezes the complete guarded and ordinary purge-target catalog in FK-safe layers", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-purge-catalog-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath);
    try {
      const rows = database.connection.prepare(`
        SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank,
          requires_authority, guard_trigger_name
        FROM privacy_purge_target_catalog
        ORDER BY table_name
      `).all() as Array<{
        table_name: string;
        pk_columns_json: string;
        pk_expression_sql: string;
        delete_rank: number;
        requires_authority: number;
        guard_trigger_name: string | null;
      }>;
      const ordinaryTables = [
        "ai_jobs",
        "context_entries",
        "context_entry_reviews",
        "logical_page_activity_daily",
        "logical_page_importance_migration_audit",
        "logical_page_preferences",
        "tab_session_intents",
      ];
      expect(rows).toHaveLength(65);
      expect(rows.filter(({ requires_authority }) => requires_authority === 1))
        .toHaveLength(58);
      expect(rows.filter(({ requires_authority }) => requires_authority === 0)
        .map(({ table_name }) => table_name)).toEqual(ordinaryTables);

      const byTable = new Map(rows.map((row) => [row.table_name, row]));
      for (const row of rows) {
        const primaryKey = (
          database.connection.pragma(`table_info('${row.table_name}')`) as Array<{
            name: string;
            pk: number;
          }>
        ).filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk)
          .map(({ name }) => name);
        expect(JSON.parse(row.pk_columns_json)).toEqual(primaryKey);
        expect(row.pk_expression_sql).toMatch(/^'pk:v1\|[1-9][0-9]*\|'/);
        expect(Number.isInteger(row.delete_rank)).toBe(true);
        if (row.requires_authority === 1) {
          expect(row.guard_trigger_name).not.toBeNull();
          expect(database.connection.prepare(`
            SELECT table_name, pk_columns_json, pk_expression_sql
            FROM privacy_purge_deletion_manifest WHERE trigger_name = ?
          `).get(row.guard_trigger_name)).toEqual({
            table_name: row.table_name,
            pk_columns_json: row.pk_columns_json,
            pk_expression_sql: row.pk_expression_sql,
          });
        } else {
          expect(row.guard_trigger_name).toBeNull();
          expect(database.connection.prepare(`
            SELECT 1 FROM privacy_purge_deletion_manifest WHERE table_name = ?
          `).get(row.table_name)).toBeUndefined();
        }
      }

      for (const row of rows) {
        const foreignKeys = database.connection.pragma(
          `foreign_key_list('${row.table_name}')`,
        ) as Array<{ table: string }>;
        for (const { table } of foreignKeys) {
          const parent = byTable.get(table);
          if (parent !== undefined && parent.table_name !== row.table_name) {
            const isResearchRunReportCycle = new Set([
              row.table_name,
              parent.table_name,
            ]).size === 2 && [row.table_name, parent.table_name].every((name) =>
              name === "research_runs" || name === "research_reports"
            );
            expect(
              row.delete_rank > parent.delete_rank ||
                (isResearchRunReportCycle && row.delete_rank === parent.delete_rank),
              `${row.table_name} must delete before ${parent.table_name}`,
            ).toBe(true);
          }
        }
      }
      for (const operation of [
        "INSERT INTO privacy_purge_target_catalog (table_name, pk_columns_json, pk_expression_sql, delete_rank, requires_authority) VALUES ('rogue', '[\"id\"]', 'placeholder', 0, 0)",
        "UPDATE privacy_purge_target_catalog SET delete_rank = 99 WHERE table_name = 'ai_jobs'",
        "DELETE FROM privacy_purge_target_catalog WHERE table_name = 'ai_jobs'",
      ]) {
        expect(() => database.connection.exec(operation)).toThrow(/catalog is frozen/i);
      }
    } finally {
      database.close();
    }
  });

  it("deletes guarded and ordinary exact targets in one executor-owned transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-mixed-purge-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed);
      seed.prepare(`
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (9001, 3, 'user', 'manual', ?, ?)
      `).run("2026-08-14T12:00:00.000Z", "2026-08-14T12:00:00.000Z");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:01.000Z";
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
          AND is_active = 1
      `).pluck().get());
      const targets = [
        {
          tableName: "research_sources",
          pkV1: encodePrivacyPurgePrimaryKeyV1([
            { type: "integer", value: 9001 },
          ]),
        },
        {
          tableName: "logical_page_preferences",
          pkV1: encodePrivacyPurgePrimaryKeyV1([
            { type: "integer", value: 9001 },
          ]),
        },
      ] as const;
      insertPrivacyPurgeCommand(connection, {
        id: 99,
        targetKind: "logical_page",
        subjectGenerationId: generationId,
        orderedTargets: targets,
        createdAt: at,
      });

      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(99, targets, at, "e"),
      );

      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM logical_page_preferences WHERE logical_page_id = 9001
      `).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = 99",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id = ? AND is_active = 0
      `).pluck().get(generationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
          AND is_active = 1 AND id <> ?
      `).pluck().get(generationId)).toBe(1);
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("allocates purge authority only when the frozen predicate matches the exact row", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      const liveFixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(liveFixture.finalJobId, liveResearchFixtureCompletedAt);
      connection.prepare(`
        INSERT OR IGNORE INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, '["https://example.com"]')
      `).run();
      connection.prepare(`
        INSERT OR IGNORE INTO live_acquisition_digest_keys (consent_id, digest_key)
        VALUES (1, randomblob(32))
      `).run();
      connection.prepare(`
        UPDATE live_acquisition_consents
        SET status = 'consumed', terminal_at = ? WHERE id = 1
      `).run(at);
      const rootGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).pluck().get(liveFixture.coordinatorJobId));
      const orderedTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 27_100,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets,
        createdAt: at,
      });
      const expectedAuthorities: Array<{ tableName: string; pkV1: string }> = [];
      const guardedTargets: Array<{ tableName: string; pkV1: string }> = [];
      for (const target of orderedTargets) {
        const catalog = connection.prepare(`
          SELECT catalog.pk_expression_sql, catalog.requires_authority,
            manifest.predicate_sql
          FROM privacy_purge_target_catalog AS catalog
          LEFT JOIN privacy_purge_deletion_manifest AS manifest
            ON manifest.trigger_name = catalog.guard_trigger_name
          WHERE catalog.table_name = ?
        `).get(target.tableName) as {
          pk_expression_sql: string;
          requires_authority: number;
          predicate_sql: string | null;
        };
        if (catalog.requires_authority !== 1) continue;
        guardedTargets.push({ tableName: target.tableName, pkV1: target.pkV1 });
        const tableIdentifier = `"${target.tableName.replaceAll('"', '""')}"`;
        const primaryKeyExpression = catalog.pk_expression_sql.replaceAll(
          "OLD.",
          "target.",
        );
        const predicateExpression = catalog.predicate_sql!.replaceAll(
          "OLD.",
          "target.",
        );
        const matches = Number(connection.prepare(`
          SELECT CASE WHEN (${predicateExpression}) THEN 1 ELSE 0 END
          FROM ${tableIdentifier} AS target
          WHERE (${primaryKeyExpression}) = ? LIMIT 1
        `).pluck().get(target.pkV1)) === 1;
        if (matches) {
          expectedAuthorities.push({ tableName: target.tableName, pkV1: target.pkV1 });
        }
      }
      expect(expectedAuthorities.length).toBeGreaterThan(0);
      expect(expectedAuthorities.length).toBeLessThan(guardedTargets.length);

      connection.exec(`
        CREATE TABLE test_exact_row_authority_audit (
          table_name TEXT NOT NULL, pk_v1 TEXT NOT NULL,
          live_authority_count INTEGER NOT NULL
        );
        CREATE TRIGGER test_exact_row_authority_audit_insert
        AFTER INSERT ON privacy_purge_authorities
        BEGIN
          INSERT INTO test_exact_row_authority_audit (
            table_name, pk_v1, live_authority_count
          ) VALUES (
            NEW.table_name, NEW.pk_v1,
            (SELECT COUNT(*) FROM privacy_purge_authorities)
          );
        END;
      `);
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(27_100, orderedTargets, at, "7"),
      );
      expect(connection.prepare(`
        SELECT table_name AS tableName, pk_v1 AS pkV1
        FROM test_exact_row_authority_audit ORDER BY table_name, pk_v1
      `).all()).toEqual(expectedAuthorities.sort((left, right) =>
        left.tableName.localeCompare(right.tableName, "en") ||
        left.pkV1.localeCompare(right.pkV1, "en")
      ));
      expect(connection.prepare(`
        SELECT MAX(live_authority_count) FROM test_exact_row_authority_audit
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fails closed when a frozen exact-row predicate drifts before its delete", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
      connection.prepare(`
        INSERT INTO research_privacy_requests (
          idempotency_key, request_fingerprint, target_type, target_key,
          reason, created_at
        ) VALUES ('predicate-drift', ?, 'target', 'resource:7001',
          'test exact predicate drift', ?)
      `).run("f".repeat(64), at);
      connection.prepare(`
        INSERT INTO research_privacy_run_bindings (idempotency_key, run_id)
        VALUES ('predicate-drift', ?)
      `).run(fixture.finalRunId);
      const rootGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
          AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));
      const orderedTargets = everyExistingPurgeTarget(connection);
      const bindingIndex = orderedTargets.findIndex(
        ({ tableName }) => tableName === "research_privacy_run_bindings",
      );
      const payloadIndex = orderedTargets.findIndex(
        ({ tableName }) => tableName === "research_run_payloads",
      );
      expect(bindingIndex).toBeGreaterThanOrEqual(0);
      expect(payloadIndex).toBeGreaterThan(bindingIndex);
      insertPrivacyPurgeCommand(connection, {
        id: 27_101,
        targetKind: "run",
        subjectGenerationId: rootGenerationId,
        orderedTargets,
        createdAt: at,
      });
      const before = privacyPurgeStateFingerprint(connection, 27_101);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(27_101, orderedTargets, at, "8"),
      )).toThrow(/predicate drift/i);
      expect(privacyPurgeStateFingerprint(connection, 27_101)).toBe(before);
    } finally {
      database.close();
    }
  });

  it("rejects deletion-manifest predicate drift before allocating authority", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:02.000Z";
      seedCapturedResearchSource(connection);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9001
          AND is_active = 1
      `).pluck().get());
      const orderedTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 27_102,
        targetKind: "run",
        subjectGenerationId: generationId,
        orderedTargets,
        createdAt: at,
      });
      expect(() => connection.prepare(`
        UPDATE privacy_purge_deletion_manifest
        SET predicate_sql = '1=1'
        WHERE trigger_name = 'research_runs_immutable_delete'
      `).run()).toThrow(/manifest is frozen/i);

      connection.exec("DROP TRIGGER privacy_purge_deletion_manifest_immutable_update");
      connection.prepare(`
        UPDATE privacy_purge_deletion_manifest
        SET predicate_sql = '1=1'
        WHERE trigger_name = 'research_runs_immutable_delete'
      `).run();
      const before = privacyPurgeStateFingerprint(connection, 27_102);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(27_102, orderedTargets, at, "9"),
      )).toThrow(/deletion manifest.*fingerprint|manifest.*drift/i);
      expect(privacyPurgeStateFingerprint(connection, 27_102)).toBe(before);
    } finally {
      database.close();
    }
  });

  it("purges every logical-page category child-to-parent while retaining page and foreign report identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-complete-page-purge-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:10:00.000Z";
      seedCompleteLogicalPagePurgeFixture(connection, at);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9400
          AND is_active = 1
      `).pluck().get());
      const pageJobEventId = Number(connection.prepare(`
        SELECT id FROM ai_job_events WHERE job_id = 9420
      `).pluck().get());
      const integerTarget = (tableName: string, value: number) => ({
        tableName,
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer" as const, value },
        ]),
      });
      const textTarget = (tableName: string, value: string) => ({
        tableName,
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "text" as const, value },
        ]),
      });
      const targets = [
        // rank 2
        integerTarget("ai_job_events", pageJobEventId),
        integerTarget("research_page_context_snapshots", 9501),
        integerTarget("resource_resolution_heads", 9400),
        // rank 1
        textTarget("ai_job_idempotency_receipts", "complete-purge-page-job"),
        integerTarget("context_entry_reviews", 9402),
        integerTarget("logical_page_resource_heads", 9400),
        integerTarget("priority_feedback", 9411),
        integerTarget("resource_resolution_events", 9603),
        integerTarget("tab_session_intents", 9403),
        // rank 0
        textTarget("agent_user_importance_receipts", "c".repeat(64)),
        integerTarget("ai_jobs", 9420),
        integerTarget("context_entries", 9401),
        {
          tableName: "logical_page_activity_daily",
          pkV1: encodePrivacyPurgePrimaryKeyV1([
            { type: "integer", value: 9400 },
            { type: "text", value: "2026-08-14" },
          ]),
        },
        integerTarget("logical_page_importance_migration_audit", 9400),
        integerTarget("logical_page_preferences", 9400),
        integerTarget("logical_page_resource_assignments", 9602),
        integerTarget("priority_assessments", 9410),
        integerTarget("priority_exclusions", 9412),
      ] as const satisfies readonly PrivacyPurgeExecutionTarget[];
      const pageOwnedCatalogTables = new Set([
        "ai_jobs",
        "context_entries",
        "context_entry_reviews",
        "logical_page_activity_daily",
        "logical_page_importance_migration_audit",
        "logical_page_preferences",
        "logical_page_resource_assignments",
        "logical_page_resource_heads",
        "priority_assessments",
        "priority_exclusions",
        "priority_feedback",
        "resource_resolution_events",
        "resource_resolution_heads",
        "tab_session_intents",
      ]);
      expect(targets.filter(({ tableName }) => pageOwnedCatalogTables.has(tableName))
        .map(({ tableName }) => tableName).sort())
        .toEqual([...pageOwnedCatalogTables].sort());
      const guardedTargets = targets.filter(({ tableName }) =>
        connection.prepare(`
          SELECT requires_authority FROM privacy_purge_target_catalog
          WHERE table_name = ?
        `).pluck().get(tableName) === 1
      );
      expect(guardedTargets.map(({ tableName }) => tableName).sort()).toEqual([
        "agent_user_importance_receipts",
        "ai_job_events",
        "ai_job_idempotency_receipts",
        "logical_page_resource_assignments",
        "logical_page_resource_heads",
        "priority_assessments",
        "priority_exclusions",
        "priority_feedback",
        "research_page_context_snapshots",
        "resource_resolution_events",
        "resource_resolution_heads",
      ]);

      const exactTargetExists = (target: PrivacyPurgeExecutionTarget): boolean => {
        const expression = String(connection.prepare(`
          SELECT pk_expression_sql FROM privacy_purge_target_catalog
          WHERE table_name = ?
        `).pluck().get(target.tableName)).replaceAll("OLD.", "target.");
        const tableIdentifier = `"${target.tableName.replaceAll('"', '""')}"`;
        return connection.prepare(`
          SELECT 1 FROM ${tableIdentifier} AS target
          WHERE (${expression}) = ? LIMIT 1
        `).get(target.pkV1) !== undefined;
      };
      for (const target of targets) {
        expect(
          exactTargetExists(target),
          `seeded target ${target.tableName}:${target.pkV1}`,
        ).toBe(true);
      }

      for (const unauthorizedDelete of [
        "DELETE FROM priority_assessments WHERE id = 9410",
        "DELETE FROM priority_exclusions WHERE id = 9412",
        "DELETE FROM priority_feedback WHERE id = 9411",
        "DELETE FROM logical_page_resource_assignments WHERE id = 9602",
        "DELETE FROM logical_page_resource_heads WHERE logical_page_id = 9400",
        "DELETE FROM resource_resolution_events WHERE id = 9603",
        "DELETE FROM resource_resolution_heads WHERE logical_page_id = 9400",
      ]) {
        expect(() => connection.exec(unauthorizedDelete))
          .toThrow(/privacy deletion|cannot be deleted|append-only/i);
      }

      connection.exec(`
        CREATE TABLE test_purge_authority_audit (
          table_name TEXT NOT NULL, pk_v1 TEXT NOT NULL
        );
        CREATE TRIGGER test_purge_authority_audit_insert
        AFTER INSERT ON privacy_purge_authorities
        BEGIN
          INSERT INTO test_purge_authority_audit (table_name, pk_v1)
          VALUES (NEW.table_name, NEW.pk_v1);
        END;
        CREATE TABLE test_purge_fence_audit (nonce_digest TEXT NOT NULL);
        CREATE TRIGGER test_purge_fence_audit_insert
        AFTER INSERT ON privacy_purge_transaction_fences
        BEGIN
          INSERT INTO test_purge_fence_audit (nonce_digest)
          VALUES (NEW.nonce_digest);
        END;
      `);
      insertPrivacyPurgeCommand(connection, {
        id: 140,
        targetKind: "logical_page",
        subjectGenerationId: generationId,
        orderedTargets: targets,
        createdAt: at,
      });
      const safeCounts = {
        cancelled_jobs: 1,
        deleted_rows: targets.length,
        redacted_rows: 1,
        removed_activity_records: 1,
        removed_context_entries: 3,
        removed_priority_records: 5,
        removed_relations: 4,
        removed_reports: 0,
        retired_generations: 1,
      } as const;
      const plan = {
        version: "privacy_purge_execution:v1",
        commandId: 140,
        outcome: "completed",
        orderedTargets: targets,
        tombstoneDigest: "a".repeat(64),
        safeCounts,
        resultDigest: "b".repeat(64),
        completedAt: at,
      } as const;

      expect(() => executePrivacyPurgePlan(connection, plan, {
        testOnlyFailurePoint: "recreate_first_target",
      })).toThrow(/injected privacy purge execution failure/i);
      for (const target of targets) {
        expect(
          exactTargetExists(target),
          `rolled-back target ${target.tableName}:${target.pkV1}`,
        ).toBe(true);
      }
      expect(connection.prepare(
        "SELECT COUNT(*) FROM test_purge_authority_audit",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM test_purge_fence_audit",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = 140",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_transaction_fences",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 140",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT status FROM privacy_purge_commands WHERE id = 140",
      ).pluck().get()).toBe("pending");
      expect(connection.prepare(
        "SELECT is_active FROM privacy_subject_generations WHERE id = ?",
      ).pluck().get(generationId)).toBe(1);

      executePrivacyPurgePlan(connection, plan);
      for (const target of targets) {
        expect(
          exactTargetExists(target),
          `completed target ${target.tableName}:${target.pkV1}`,
        ).toBe(false);
      }
      expect(connection.prepare(`
        SELECT table_name FROM test_purge_authority_audit ORDER BY table_name
      `).pluck().all()).toEqual(
        guardedTargets.map(({ tableName }) => tableName).sort(),
      );
      expect(connection.prepare(
        "SELECT COUNT(*) FROM test_purge_fence_audit",
      ).pluck().get()).toBe(guardedTargets.length + 1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = 140",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_transaction_fences",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id = 9400",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_reports WHERE id = 9500",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_runs WHERE id = 9500",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM resources WHERE id IN (9500, 9600)",
      ).pluck().get()).toBe(2);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id = ? AND is_active = 0
      `).pluck().get(generationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9400
          AND is_active = 1 AND id <> ?
      `).pluck().get(generationId)).toBe(1);
      expect(JSON.parse(String(connection.prepare(`
        SELECT safe_counts_json FROM privacy_purge_results WHERE command_id = 140
      `).pluck().get()))).toEqual(safeCounts);
      expect(connection.pragma("foreign_key_check")).toEqual([]);
      expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects unknown, FK-misordered, and drifted purge targets before mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-purge-negative-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed);
      seed.prepare(`
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (9001, NULL, NULL, NULL, NULL, ?)
      `).run("2026-08-14T10:00:00.000Z");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:00:03.000Z";
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
          AND is_active = 1
      `).pluck().get());
      const preferenceTarget = {
        tableName: "logical_page_preferences",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9001 },
        ]),
      } as const;
      const sourceTarget = {
        tableName: "research_sources",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9001 },
        ]),
      } as const;
      const misorderedTargets = [preferenceTarget, sourceTarget] as const;
      insertPrivacyPurgeCommand(connection, {
        id: 120,
        targetKind: "logical_page",
        subjectGenerationId: generationId,
        orderedTargets: misorderedTargets,
        createdAt: at,
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(120, misorderedTargets, at, "1"),
      )).toThrow(/order is not FK-safe/i);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM logical_page_preferences WHERE logical_page_id = 9001",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 120",
      ).pluck().get()).toBe(0);

      const createPageGeneration = (pageId: number): number => {
        const url = `https://negative-${pageId}.example/page`;
        connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(pageId, url, url, url, at, at);
        return Number(connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'logical_page' AND logical_page_id = ?
            AND is_active = 1
        `).pluck().get(pageId));
      };
      const unknownTarget = {
        tableName: "not_a_purge_table",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 1 },
        ]),
      } as const;
      const unknownGenerationId = createPageGeneration(9121);
      insertPrivacyPurgeCommand(connection, {
        id: 121,
        targetKind: "logical_page",
        subjectGenerationId: unknownGenerationId,
        orderedTargets: [unknownTarget],
        createdAt: at,
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(121, [unknownTarget], at, "2"),
      )).toThrow(/not uniquely frozen/i);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 121",
      ).pluck().get()).toBe(0);

      connection.exec(`
        DROP TRIGGER privacy_purge_target_catalog_immutable_update;
        UPDATE privacy_purge_target_catalog
        SET requires_authority = 0, guard_trigger_name = NULL
        WHERE table_name = 'research_sources';
      `);
      const driftGenerationId = createPageGeneration(9122);
      insertPrivacyPurgeCommand(connection, {
        id: 122,
        targetKind: "logical_page",
        subjectGenerationId: driftGenerationId,
        orderedTargets: [sourceTarget],
        createdAt: at,
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(122, [sourceTarget], at, "3"),
      )).toThrow(/catalog fingerprint drifted/i);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 122",
      ).pluck().get()).toBe(0);
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rolls back a real ordinary-target recreation trigger with no leaked authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-ordinary-recreate-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    const at = "2026-08-14T12:00:04.000Z";
    try {
      seed.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9130, 'https://ordinary-recreate.example/page',
          'https://ordinary-recreate.example/page',
          'https://ordinary-recreate.example/page', '${at}', '${at}'
        );
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (9130, 2, 'user', 'manual', '${at}', '${at}');
      `);
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T12:00:04.000Z"),
    });
    try {
      const connection = database.connection;
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9130
          AND is_active = 1
      `).pluck().get());
      const target = {
        tableName: "logical_page_preferences",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9130 },
        ]),
      } as const;
      insertPrivacyPurgeCommand(connection, {
        id: 130,
        targetKind: "logical_page",
        subjectGenerationId: generationId,
        orderedTargets: [target],
        createdAt: at,
      });
      connection.exec(`
        CREATE TRIGGER test_recreate_logical_page_preference
        AFTER DELETE ON logical_page_preferences
        WHEN OLD.logical_page_id = 9130
        BEGIN
          INSERT INTO logical_page_preferences (
            logical_page_id, user_importance, recorded_by, record_method,
            importance_updated_at, updated_at
          ) VALUES (
            OLD.logical_page_id, OLD.user_importance, OLD.recorded_by,
            OLD.record_method, OLD.importance_updated_at, OLD.updated_at
          );
        END;
      `);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(130, [target], at, "4"),
      )).toThrow(/target was recreated/i);
      expect(connection.prepare(`
        SELECT user_importance FROM logical_page_preferences
        WHERE logical_page_id = 9130
      `).pluck().get()).toBe(2);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = 130",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 130",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT is_active FROM privacy_subject_generations WHERE id = ?",
      ).pluck().get(generationId)).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_transaction_fences",
      ).pluck().get()).toBe(0);
      expect(connection.inTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("executes only a committed plain exact-row purge plan", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-executor-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed);
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      expect("withPrivacyPurgeAuthorization" in liveAcquisitionMigration).toBe(false);
      expect("withPrivacyPurgeFinalization" in liveAcquisitionMigration).toBe(false);
      const ids = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS run_generation_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id,
          (SELECT id FROM ai_job_events ORDER BY id LIMIT 1) AS job_event_id
      `).get() as {
        run_generation_id: number;
        resource_generation_id: number;
        history_epoch_id: number;
        job_event_id: number;
      };
      const at = "2026-08-14T12:00:02.000Z";
      const sourceTarget = {
        tableName: "research_sources",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9001 },
        ]),
      } as const;
      const eventTarget = {
        tableName: "ai_job_events",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: ids.job_event_id },
        ]),
      } as const;
      insertPrivacyPurgeCommand(connection, {
        id: 100,
        targetKind: "resource_history",
        historyEpochId: ids.history_epoch_id,
        orderedTargets: [sourceTarget],
        createdAt: at,
      });
      const committedPlan = completedPrivacyPurgePlan(100, [sourceTarget], at, "1");

      expect(() => connection.prepare(`
        INSERT INTO privacy_subject_tombstones (
          history_epoch_id, purge_command_id, tombstone_digest, created_at
        ) VALUES (?, 100, ?, ?)
      `).run(ids.history_epoch_id, "2".repeat(64), at))
        .toThrow(/tombstone does not match|finalization/i);
      expect(() => connection.prepare(`
        INSERT INTO privacy_purge_authorities (
          command_id, table_name, pk_v1, nonce_digest, created_at
        ) VALUES (100, 'research_sources', ?, ?, ?)
      `).run(sourceTarget.pkV1, "3".repeat(64), at))
        .toThrow(/invalid or completed privacy purge authority/i);

      let invoked = 0;
      const functionPlan = (() => {
        invoked += 1;
      }) as unknown as PrivacyPurgeExecutionPlan;
      expect(() => executePrivacyPurgePlan(connection, functionPlan))
        .toThrow(/plain data object/i);
      const thenablePlan = {
        ...committedPlan,
        then() {
          invoked += 1;
          connection.prepare(`
            INSERT INTO logical_pages (
              id, identity_key, url_normalized, representative_url,
              created_at, updated_at
            ) VALUES (9299, 'https://forbidden.example', 'https://forbidden.example',
              'https://forbidden.example', ?, ?)
          `).run(at, at);
        },
      } as unknown as PrivacyPurgeExecutionPlan;
      expect(() => executePrivacyPurgePlan(connection, thenablePlan))
        .toThrow(/invalid data shape/i);
      const accessorPlan = { ...committedPlan } as Record<string, unknown>;
      Object.defineProperty(accessorPlan, "outcome", {
        configurable: true,
        enumerable: true,
        get() {
          invoked += 1;
          return "completed";
        },
      });
      expect(() => executePrivacyPurgePlan(
        connection,
        accessorPlan as unknown as PrivacyPurgeExecutionPlan,
      )).toThrow(/own data property/i);
      const proxyPlan = new Proxy(committedPlan, {
        get(target, key, receiver) {
          invoked += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      expect(() => executePrivacyPurgePlan(connection, proxyPlan))
        .toThrow(/plain data object/i);
      expect(invoked).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id = 9299",
      ).pluck().get()).toBe(0);
      expect(connection.inTransaction).toBe(false);

      connection.exec("BEGIN IMMEDIATE");
      expect(() => executePrivacyPurgePlan(connection, committedPlan))
        .toThrow(/autocommit/i);
      connection.exec("ROLLBACK");
      connection.pragma("foreign_keys = OFF");
      expect(() => executePrivacyPurgePlan(connection, committedPlan))
        .toThrow(/foreign_keys=ON/i);
      connection.pragma("foreign_keys = ON");

      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(100, [], at, "2"),
      )).toThrow(/durable commitment/i);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(100, [
          sourceTarget,
          {
            tableName: "research_sources",
            pkV1: encodePrivacyPurgePrimaryKeyV1([
              { type: "integer", value: 9998 },
            ]),
          },
        ], at, "2"),
      )).toThrow(/durable commitment/i);

      const createPageCommand = (
        commandId: number,
        pageId: number,
        orderedTargets: readonly PrivacyPurgeExecutionTarget[],
      ): number => {
        const url = `https://purge-${pageId}.example/page`;
        connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(pageId, url, url, url, at, at);
        const generationId = Number(connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'logical_page' AND logical_page_id = ?
            AND is_active = 1
        `).pluck().get(pageId));
        insertPrivacyPurgeCommand(connection, {
          id: commandId,
          targetKind: "logical_page",
          subjectGenerationId: generationId,
          orderedTargets,
          createdAt: at,
        });
        return generationId;
      };

      createPageCommand(101, 9201, [eventTarget, sourceTarget]);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(101, [sourceTarget, eventTarget], at, "3"),
      )).toThrow(/durable commitment/i);
      const missingTarget = {
        tableName: "research_sources",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9999 },
        ]),
      } as const;
      createPageCommand(102, 9202, [missingTarget]);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(102, [missingTarget], at, "4"),
      )).toThrow(/exact target is absent/i);

      for (const [commandId, pageId, failurePoint] of [
        [103, 9203, "after_tombstone"],
        [104, 9204, "result_before_authorities"],
        [105, 9205, "missing_last_authority"],
        [106, 9206, "recreate_first_target"],
      ] as const) {
        createPageCommand(commandId, pageId, [sourceTarget]);
        expect(() => executePrivacyPurgePlan(
          connection,
          completedPrivacyPurgePlan(commandId, [sourceTarget], at, "5"),
          { testOnlyFailurePoint: failurePoint },
        )).toThrow();
        expect(connection.prepare(
          "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
        ).pluck().get()).toBe(1);
        expect(connection.prepare(
          "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = ?",
        ).pluck().get(commandId)).toBe(0);
        expect(connection.prepare(
          "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = ?",
        ).pluck().get(commandId)).toBe(0);
        expect(connection.inTransaction).toBe(false);
      }

      createPageCommand(107, 9207, [sourceTarget]);
      connection.exec(`
        CREATE TRIGGER test_recreate_research_source
        AFTER DELETE ON research_sources
        WHEN OLD.id = 9001
        BEGIN
          INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, tab_id,
            captured_tab_id_snapshot, content_revision, content_digest,
            extracted_at, acquisition_method, access_class_snapshot,
            eligibility, inclusion_state, included_order, created_at
          ) VALUES (
            OLD.id, OLD.run_id, OLD.ordinal, OLD.logical_page_id, OLD.tab_id,
            OLD.captured_tab_id_snapshot, OLD.content_revision, OLD.content_digest,
            OLD.extracted_at, OLD.acquisition_method, OLD.access_class_snapshot,
            OLD.eligibility, OLD.inclusion_state, OLD.included_order, OLD.created_at
          );
        END;
      `);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(107, [sourceTarget], at, "6"),
      )).toThrow(/target was recreated/i);
      connection.exec("DROP TRIGGER test_recreate_research_source");
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe(1);

      const beforeIncompleteHistoryPlan = privacyPurgeStateFingerprint(connection, 100);
      expect(() => executePrivacyPurgePlan(connection, committedPlan))
        .toThrow(/exactly match the lifecycle commitment/i);
      expect(privacyPurgeStateFingerprint(connection, 100))
        .toBe(beforeIncompleteHistoryPlan);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = 9001",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT status FROM privacy_purge_commands WHERE id = 100",
      ).pluck().get()).toBe("pending");
      expect(connection.prepare(
        "SELECT epoch_no FROM research_history_epochs WHERE resource_id = 9001 AND is_active = 1",
      ).pluck().get()).toBe(1);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = 100",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_transaction_fences",
      ).pluck().get()).toBe(0);

      const zeroGenerationId = createPageCommand(108, 9208, []);
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(108, [], at, "7"),
      );
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE id = ? AND is_active = 0
      `).pluck().get(zeroGenerationId)).toBe(1);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE logical_page_id = 9208 AND is_active = 1 AND id <> ?
      `).pluck().get(zeroGenerationId)).toBe(1);

      const failedGenerationId = createPageCommand(109, 9209, []);
      executePrivacyPurgePlan(connection, {
        version: "privacy_purge_execution:v1",
        commandId: 109,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "9".repeat(64),
        completedAt: at,
      });
      expect(connection.prepare(
        "SELECT status FROM privacy_purge_commands WHERE id = 109",
      ).pluck().get()).toBe("failed");
      expect(connection.prepare(
        "SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = 109",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(
        "SELECT is_active FROM privacy_subject_generations WHERE id = ?",
      ).pluck().get(failedGenerationId)).toBe(1);

      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9300, 'purge-run.example', '${at}');
        INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          created_at, updated_at
        ) VALUES (
          9300, 'resource_research', 'resource', 9300, 'resource:9300', 'user',
          'manual', 'purge-run-job', '${"a".repeat(64)}', '${"b".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, '${at}', 10, 1000, 1, 60000,
          '${at}', '${at}'
        );
        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest,
          scope_json, approval_fingerprint, corpus_fingerprint,
          submission_fingerprint, workflow_id, workflow_version, max_steps,
          max_tokens, max_cost_usd, max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9300, 9300, 9300, 'resource:9300', '${"c".repeat(64)}', '{}',
          '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, '${at}',
          (SELECT id FROM research_history_epochs WHERE resource_id = 9300 AND is_active = 1)
        );
      `);
      const runGenerationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9300
          AND is_active = 1
      `).pluck().get());
      const runTarget = {
        tableName: "research_runs",
        pkV1: encodePrivacyPurgePrimaryKeyV1([
          { type: "integer", value: 9300 },
        ]),
      } as const;
      insertPrivacyPurgeCommand(connection, {
        id: 110,
        targetKind: "run",
        subjectGenerationId: runGenerationId,
        orderedTargets: [runTarget],
        createdAt: at,
      });
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(110, [runTarget], at, "c"),
      );
      expect(connection.prepare(
        "SELECT COUNT(*) FROM research_runs WHERE id = 9300",
      ).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT is_active, research_run_id FROM privacy_subject_generations
        WHERE id = ?
      `).get(runGenerationId)).toEqual({
        is_active: 0,
        research_run_id: null,
      });
    } finally {
      database.close();
    }
  });

  it("keeps committed purge receipts, tombstones, identities, and manifest permanent", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-retained-purge-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed);
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T11:00:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:20:00.000Z";
      const ids = connection.prepare(`
        SELECT
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
             AND is_active = 1) AS page_generation_id
      `).get() as { history_epoch_id: number; page_generation_id: number };
      const orderedTargets = everyExistingPurgeTarget(connection);
      insertPrivacyPurgeCommand(connection, {
        id: 8001,
        targetKind: "resource_history",
        historyEpochId: ids.history_epoch_id,
        orderedTargets,
        createdAt: at,
      });
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(8001, orderedTargets, at, "a"),
      );
      const tombstoneId = Number(connection.prepare(
        "SELECT id FROM privacy_subject_tombstones WHERE purge_command_id = 8001",
      ).pluck().get());
      const manifestTrigger = String(connection.prepare(`
        SELECT trigger_name FROM privacy_purge_deletion_manifest
        ORDER BY trigger_name LIMIT 1
      `).pluck().get());
      for (const statement of [
        "DELETE FROM privacy_purge_commands WHERE id = 8001",
        `DELETE FROM privacy_subject_generations WHERE id = ${ids.page_generation_id}`,
        `DELETE FROM research_history_epochs WHERE id = ${ids.history_epoch_id}`,
        `DELETE FROM privacy_subject_tombstones WHERE id = ${tombstoneId}`,
        "DELETE FROM privacy_purge_results WHERE command_id = 8001",
      ]) {
        expect(() => connection.prepare(statement).run())
          .toThrow(/permanent|immutable/i);
      }
      expect(() => connection.prepare(`
        DELETE FROM privacy_purge_deletion_manifest WHERE trigger_name = ?
      `).run(manifestTrigger)).toThrow(/frozen/i);
      expect(() => connection.prepare(`
        UPDATE privacy_purge_commands SET deletion_target_count = 1 WHERE id = 8001
      `).run()).toThrow(/invalid privacy purge command transition/i);
      expect(() => connection.prepare(`
        UPDATE privacy_purge_results SET safe_counts_json = '{}'
        WHERE command_id = 8001
      `).run()).toThrow(/immutable/i);
      expect(() => connection.prepare(`
        UPDATE privacy_subject_tombstones SET tombstone_digest = ? WHERE id = ?
      `).run("b".repeat(64), tombstoneId)).toThrow(/permanent/i);
      insertPrivacyPurgeCommand(connection, {
        id: 8002,
        targetKind: "logical_page",
        subjectGenerationId: ids.page_generation_id,
        orderedTargets: [],
        createdAt: at,
      });
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => executePrivacyPurgePlan(connection, {
          version: "privacy_purge_execution:v1",
          commandId: 8002,
          outcome: "failed",
          safeCounts: JSON.parse(unsafeJson) as Record<string, number>,
          resultDigest: "f".repeat(64),
          completedAt: at,
        })).toThrow(/safeCounts/i);
      }
    } finally {
      database.close();
    }
  });

  it("allocates non-reused generations and rolls Resource history epochs", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-generation-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const database = openDatabase(databasePath, {
      migrationClock: () => new Date("2026-08-14T12:30:00.000Z"),
    });
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:30:00.000Z";
      const rawConnection = new Database(databasePath);
      try {
        rawConnection.pragma("foreign_keys = ON");
        rawConnection.prepare(
          `INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (9902, ?, ?, ?, ?, ?)`,
        ).run(
          "https://generation.example/raw-delete",
          "https://generation.example/raw-delete",
          "https://generation.example/raw-delete",
          at,
          at,
        );
      } finally {
        rawConnection.close();
      }
      const rawActiveGeneration = connection.prepare(
        `SELECT id, generation_token, created_at
         FROM privacy_subject_generations
         WHERE subject_kind = 'logical_page' AND logical_page_id = 9902
           AND is_active = 1`,
      ).get() as { id: number; generation_token: string; created_at: string };
      expect(rawActiveGeneration.generation_token).toMatch(/^[0-9a-f]{64}$/);
      expect(rawActiveGeneration.created_at).toBe(at);
      connection.prepare("DELETE FROM logical_pages WHERE id = 9902").run();
      const rawRetiredGeneration = connection.prepare(
        `SELECT id, logical_page_id, is_active, retired_at
         FROM privacy_subject_generations
         WHERE subject_kind = 'logical_page'
           AND id = ?`,
      ).get(rawActiveGeneration.id) as {
        id: number;
        logical_page_id: null;
        is_active: number;
        retired_at: string;
      };
      expect(rawRetiredGeneration.logical_page_id).toBeNull();
      expect(rawRetiredGeneration.is_active).toBe(0);
      expect(rawRetiredGeneration.retired_at).toMatch(/Z$/);
      connection.prepare(
        `INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (9902, ?, ?, ?, ?, ?)`,
      ).run(
        "https://generation.example/raw-delete-reused",
        "https://generation.example/raw-delete-reused",
        "https://generation.example/raw-delete-reused",
        at,
        at,
      );
      expect(Number(connection.prepare(
        `SELECT id FROM privacy_subject_generations
         WHERE subject_kind = 'logical_page' AND logical_page_id = 9902
           AND is_active = 1`,
      ).pluck().get())).toBeGreaterThan(rawRetiredGeneration.id);
      connection.prepare(
        `INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (9901, ?, ?, ?, ?, ?)`,
      ).run(
        "https://generation.example/page",
        "https://generation.example/page",
        "https://generation.example/page",
        at,
        at,
      );
      const first = connection
        .prepare(
          `SELECT id, generation_token FROM privacy_subject_generations
           WHERE subject_kind = 'logical_page' AND logical_page_id = 9901
             AND is_active = 1`,
        )
        .get() as { id: number; generation_token: string };
      expect(() => connection.prepare(
        `UPDATE privacy_subject_generations
         SET is_active = 0, retired_at = ? WHERE id = ?`,
      ).run(at, first.id)).toThrow(/immutable/i);

      connection.prepare(
        "INSERT INTO resources (id, resource_key, created_at) VALUES (9901, ?, ?)",
      ).run("generation.example", at);
      const resourceGenerationId = Number(
        connection
          .prepare(
            `SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'resource' AND resource_id = 9901
               AND is_active = 1`,
          )
          .pluck()
          .get(),
      );
      const epoch1 = Number(
        connection
          .prepare(
            `SELECT id FROM research_history_epochs
             WHERE resource_id = 9901 AND is_active = 1`,
          )
          .pluck()
          .get(),
      );
      const alienResourceGenerationId = Number(
        connection.prepare(
          `SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id <> 9901
             AND is_active = 1 ORDER BY id LIMIT 1`,
        ).pluck().get(),
      );
      expect(() =>
        connection.prepare(
          `INSERT INTO research_history_epochs (
            resource_id, resource_generation_id, epoch_no, is_active, created_at
          ) VALUES (9901, ?, 2, 1, ?)`,
        ).run(alienResourceGenerationId, at),
      ).toThrow(/generation must own/i);
      expect(() => connection.prepare(
        `UPDATE research_history_epochs
         SET is_active = 0, retired_at = ? WHERE id = ?`,
      ).run(at, epoch1)).toThrow(/immutable/i);
      insertPrivacyPurgeCommand(connection, {
        id: 9902,
        targetKind: "resource_history",
        historyEpochId: epoch1,
        orderedTargets: [],
        createdAt: at,
      });
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(9902, [], at, "3"),
      );
      expect(
        connection
          .prepare(
            `SELECT epoch_no FROM research_history_epochs
             WHERE resource_id = 9901 AND is_active = 1`,
          )
          .pluck()
          .get(),
      ).toBe(2);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_history_epochs (
            resource_id, resource_generation_id, epoch_no, is_active,
            created_at, retired_at
          ) VALUES (9901, ?, 1, 0, ?, ?)`,
        ).run(resourceGenerationId, at, at),
      ).toThrow(/UNIQUE/);

      expect(() =>
        connection.prepare(
          `UPDATE privacy_subject_generations
           SET logical_page_id = NULL WHERE id = ?`,
        ).run(first.id),
      ).toThrow(/immutable/i);
      insertPrivacyPurgeCommand(connection, {
        id: 9901,
        targetKind: "logical_page",
        subjectGenerationId: first.id,
        orderedTargets: [],
        createdAt: at,
      });
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(9901, [], at, "6"),
      );
      connection.prepare("DELETE FROM logical_pages WHERE id = 9901").run();
      connection.prepare(
        `INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (9901, ?, ?, ?, ?, ?)`,
      ).run(
        "https://generation.example/page-reused",
        "https://generation.example/page-reused",
        "https://generation.example/page-reused",
        at,
        at,
      );
      const second = connection
        .prepare(
          `SELECT id, generation_token FROM privacy_subject_generations
           WHERE subject_kind = 'logical_page' AND logical_page_id = 9901
             AND is_active = 1`,
        )
        .get() as { id: number; generation_token: string };
      expect(second.id).toBeGreaterThan(first.id);
      expect(second.generation_token).not.toBe(first.generation_token);
      expect(
        connection.prepare(
          `SELECT COUNT(*) FROM privacy_subject_tombstones
           WHERE subject_generation_id = ?`,
        ).pluck().get(first.id),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects consent attached to a non-C90 research workflow", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-consent-workflow-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed);
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const ids = connection.prepare(
        `SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS run_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id`,
      ).get() as {
        resource_generation_id: number;
        run_generation_id: number;
        history_epoch_id: number;
      };
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_consents (
            id, resource_generation_id, history_epoch_id, coordinator_job_id,
            coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
            origin_set_digest, limits_json, status, created_at, expires_at
          ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, '${frozenConsentLimitsJson}', 'active', ?, ?)`,
        ).run(
          ids.resource_generation_id,
          ids.history_epoch_id,
          ids.run_generation_id,
          "a".repeat(64),
          "b".repeat(64),
          "2026-08-14T12:45:00.000Z",
          "2026-08-14T13:00:00.000Z",
        ),
      ).toThrow(/consent ownership/i);
    } finally {
      database.close();
    }
  });

  it("requires consent and directed handoff runs to share the exact history epoch", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-same-history-epoch-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_acquisition:c90:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2099-08-14T12:48:00.000Z";
      const ownership = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS coordinator_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS original_history_epoch_id
      `).get() as {
        resource_generation_id: number;
        coordinator_generation_id: number;
        original_history_epoch_id: number;
      };
      const historyUpdateGuardSql = connection.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'research_history_epochs_validate_update'
      `).pluck().get() as string;
      connection.exec("DROP TRIGGER research_history_epochs_validate_update");
      connection.prepare(`
        UPDATE research_history_epochs
        SET is_active = 0, retired_at = ? WHERE id = ?
      `).run(at, ownership.original_history_epoch_id);
      connection.prepare(`
        INSERT INTO research_history_epochs (
          resource_id, resource_generation_id, epoch_no, is_active, created_at
        ) VALUES (9001, ?, 2, 1, ?)
      `).run(ownership.resource_generation_id, at);
      connection.exec(`${historyUpdateGuardSql};`);
      const successorHistoryEpochId = Number(connection.prepare(`
        SELECT id FROM research_history_epochs
        WHERE resource_id = 9001 AND is_active = 1
      `).pluck().get());

      expect(() => connection.prepare(`
        INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).run(
        ownership.resource_generation_id,
        successorHistoryEpochId,
        ownership.coordinator_generation_id,
        "a".repeat(64),
        "b".repeat(64),
        frozenConsentLimitsJson,
        at,
        "2099-08-14T12:53:00.000Z",
      )).toThrow(/consent ownership/i);

      connection.prepare(`
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9001, 1, 'queued', 'queued', 'same-epoch-coordinator-queued', ?)
      `).run(at);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (9001, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(at);
      seedEpochBoundRun(
        connection,
        9002,
        9001,
        successorHistoryEpochId,
        at,
        false,
      );
      expect(() => connection.prepare(`
        INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (1, ?, 9002, 'assembling', ?)
      `).run(ownership.coordinator_generation_id, at))
        .toThrow(/directed handoff header/i);
    } finally {
      database.close();
    }
  });

  it("accepts only the exact typed terminal outcome for an unknown research workflow", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-unknown-workflow-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_future:c999:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:50:00.000Z";
      connection.prepare(`
        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9001, 1, 'queued', 'queued', 'unknown-workflow-queued', ?)
      `).run(at);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (9001, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(at);
      const ids = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS unknown_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id
      `).get() as { unknown_generation_id: number; history_epoch_id: number };
      const insertOutcome = connection.prepare(`
        INSERT INTO live_acquisition_workflow_outcomes (
          id, coordinator_job_id, coordinator_run_generation_id,
          outcome, outcome_code, safe_details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, '{}', ?)
      `);
      expect(() => insertOutcome.run(
        1,
        9001,
        ids.unknown_generation_id,
        "ambiguous",
        "RESEARCH_WORKFLOW_UNSUPPORTED",
        at,
      )).toThrow(/outcome ownership/i);
      expect(() => insertOutcome.run(
        1,
        9001,
        ids.unknown_generation_id,
        "superseded",
        "WORKFLOW_CANCELLED",
        at,
      )).toThrow(/outcome ownership/i);
      insertOutcome.run(
        1,
        9001,
        ids.unknown_generation_id,
        "superseded",
        "RESEARCH_WORKFLOW_UNSUPPORTED",
        at,
      );

      const knownGenerationId = seedEpochBoundRun(
        connection,
        9002,
        9001,
        ids.history_epoch_id,
        at,
        true,
        "research_acquisition:c90:v1",
      );
      expect(() => insertOutcome.run(
        2,
        9002,
        knownGenerationId,
        "superseded",
        "RESEARCH_WORKFLOW_UNSUPPORTED",
        at,
      )).toThrow(/outcome ownership/i);
    } finally {
      database.close();
    }
  });

  it("queues at most 1,000 planned pages without pre-materializing logical pages", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-planned-queue-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_acquisition:c90:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:55:00.000Z";
      const ids = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS run_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id
      `).get() as {
        resource_generation_id: number;
        run_generation_id: number;
        history_epoch_id: number;
      };
      connection.prepare(`
        INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).run(
        ids.resource_generation_id,
        ids.history_epoch_id,
        ids.run_generation_id,
        "a".repeat(64),
        "b".repeat(64),
        frozenConsentLimitsJson,
        at,
        "2026-08-14T13:00:00.000Z",
      );
      connection.prepare(`
        INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, '["https://example.com"]')
      `).run();
      connection.prepare(`
        INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
        VALUES (1, zeroblob(32))
      `).run();
      const insertAction = connection.prepare(`
        INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch,
          action_kind, depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          @id, 1, @runGenerationId, @resourceGenerationId, @historyEpochId, 1,
          'page', 0, NULL, @urlFingerprint, NULL, @actionKey,
          'planned', @at
        )
      `);
      for (let id = 1; id <= 1_000; id += 1) {
        const exactUrl = `https://example.com/planned/${id}`;
        insertAction.run({
          id,
          runGenerationId: ids.run_generation_id,
          resourceGenerationId: ids.resource_generation_id,
          historyEpochId: ids.history_epoch_id,
          urlFingerprint: createHash("sha256").update(exactUrl).digest("hex"),
          actionKey: createHash("sha256").update(`planned:${id}`).digest("hex"),
          at,
        });
      }
      expect(() => insertAction.run({
        id: 1_001,
        runGenerationId: ids.run_generation_id,
        resourceGenerationId: ids.resource_generation_id,
        historyEpochId: ids.history_epoch_id,
        urlFingerprint: createHash("sha256")
          .update("https://example.com/planned/1001").digest("hex"),
        actionKey: createHash("sha256").update("planned:1001").digest("hex"),
        at,
      })).toThrow(/planned page queue limit/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions
        WHERE consent_id = 1 AND action_kind = 'page' AND state = 'planned'
      `).pluck().get()).toBe(1_000);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM logical_pages
        WHERE identity_key LIKE 'https://example.com/planned/%'
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("reserves page budget atomically and terminalizes unreserved leftovers pre-network", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-page-reservation-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_acquisition:c90:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2026-08-14T12:56:00.000Z";
      const limits = JSON.stringify({
        ...JSON.parse(frozenConsentLimitsJson) as Record<string, unknown>,
        max_pages: 2,
      });
      const ids = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS run_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id
      `).get() as {
        resource_generation_id: number;
        run_generation_id: number;
        history_epoch_id: number;
      };
      connection.prepare(`
        INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).run(
        ids.resource_generation_id,
        ids.history_epoch_id,
        ids.run_generation_id,
        "a".repeat(64),
        "b".repeat(64),
        limits,
        at,
        "2026-08-14T13:01:00.000Z",
      );
      connection.exec(`
        INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, '["https://example.com"]');
        INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
        VALUES (1, zeroblob(32));
      `);
      const insertAction = connection.prepare(`
        INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch,
          action_kind, depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (?, 1, ?, ?, ?, 1, 'page', 0, NULL, ?, NULL, ?, 'planned', ?)
      `);
      const insertEvent = connection.prepare(`
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, '{}', ?)
      `);
      for (let id = 1; id <= 3; id += 1) {
        const url = `https://example.com/reserved/${id}`;
        insertAction.run(
          id,
          ids.run_generation_id,
          ids.resource_generation_id,
          ids.history_epoch_id,
          createHash("sha256").update(url).digest("hex"),
          createHash("sha256").update(`reserved:${id}`).digest("hex"),
          at,
        );
        connection.prepare(`
          INSERT INTO live_acquisition_url_payloads (
            action_id, exact_url, keyed_url_digest
          ) VALUES (?, ?, ?)
        `).run(id, url, createHash("sha256").update(`keyed:${id}`).digest("hex"));
        insertEvent.run(id, 1, "planned", "planned", null, at);
      }
      expect(() => insertEvent.run(
        1,
        2,
        "planned",
        "resolution_started",
        null,
        "2026-08-14T12:56:01.000Z",
      )).toThrow(/page reservation/i);

      const insertReservation = connection.prepare(`
        INSERT INTO live_acquisition_page_reservations (
          consent_id, action_id, reservation_sequence, reserved_at
        ) VALUES (1, ?, ?, ?)
      `);
      connection.exec("SAVEPOINT url_payload_required");
      const urlLessAction = "https://example.com/reserved/no-payload";
      insertAction.run(
        4,
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        createHash("sha256").update(urlLessAction).digest("hex"),
        createHash("sha256").update("reserved:4").digest("hex"),
        at,
      );
      insertEvent.run(4, 1, "planned", "planned", null, at);
      expect(() => insertReservation.run(
        4,
        1,
        "2026-08-14T12:56:00.500Z",
      )).toThrow(/invalid live acquisition page reservation/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_page_reservations
        WHERE action_id = 4
      `).pluck().get()).toBe(0);
      expect(connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = 4
      `).get()).toEqual({ state: "planned", sequence_no: 1 });
      connection.exec("ROLLBACK TO url_payload_required");
      connection.exec("RELEASE url_payload_required");

      expect(() => insertEvent.run(
        3,
        2,
        "planned",
        "blocked",
        "BUDGET_EXHAUSTED",
        "2026-08-14T12:56:00.500Z",
      )).toThrow(/invalid live acquisition action transition/i);
      expect(connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = 3
      `).get()).toEqual({ state: "planned", sequence_no: 1 });

      connection.exec("SAVEPOINT reservation_rollback");
      insertReservation.run(1, 1, "2026-08-14T12:56:01.000Z");
      expect(connection.prepare(
        "SELECT state FROM live_acquisition_actions WHERE id = 1",
      ).pluck().get()).toBe("resolution_started");
      connection.exec("ROLLBACK TO reservation_rollback");
      connection.exec("RELEASE reservation_rollback");
      expect(connection.prepare(
        "SELECT state FROM live_acquisition_actions WHERE id = 1",
      ).pluck().get()).toBe("planned");
      expect(connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_page_reservations",
      ).pluck().get()).toBe(0);

      insertReservation.run(1, 1, "2026-08-14T12:56:01.000Z");
      const reservationBeforeMutation = connection.prepare(`
        SELECT id, consent_id, action_id, reservation_sequence, reserved_at
        FROM live_acquisition_page_reservations WHERE action_id = 1
      `).get();
      for (const mutation of [
        "UPDATE live_acquisition_page_reservations SET reservation_sequence = 2 WHERE action_id = 1",
        "UPDATE live_acquisition_page_reservations SET action_id = 2 WHERE action_id = 1",
        `UPDATE live_acquisition_page_reservations
         SET reserved_at = '2026-08-14T12:56:09.000Z' WHERE action_id = 1`,
      ]) {
        expect(() => connection.prepare(mutation).run())
          .toThrow(/page reservations are immutable/i);
        expect(connection.prepare(`
          SELECT id, consent_id, action_id, reservation_sequence, reserved_at
          FROM live_acquisition_page_reservations WHERE id = 1
        `).get()).toEqual(reservationBeforeMutation);
      }
      insertReservation.run(2, 2, "2026-08-14T12:56:02.000Z");
      expect(() => insertReservation.run(
        3,
        3,
        "2026-08-14T12:56:03.000Z",
      )).toThrow(/page reservation budget/i);
      insertEvent.run(
        3,
        2,
        "planned",
        "blocked",
        "BUDGET_EXHAUSTED",
        "2026-08-14T12:56:03.000Z",
      );
      expect(connection.prepare(`
        SELECT id, state, sequence_no FROM live_acquisition_actions ORDER BY id
      `).all()).toEqual([
        { id: 1, state: "resolution_started", sequence_no: 2 },
        { id: 2, state: "resolution_started", sequence_no: 2 },
        { id: 3, state: "blocked", sequence_no: 2 },
      ]);
      expect(connection.prepare(`
        SELECT action_id, reservation_sequence
        FROM live_acquisition_page_reservations ORDER BY reservation_sequence
      `).all()).toEqual([
        { action_id: 1, reservation_sequence: 1 },
        { action_id: 2, reservation_sequence: 2 },
      ]);
      expect(connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_page_reservations
           WHERE action_id = 3) AS reservations,
          (SELECT COUNT(*) FROM live_acquisition_dns_payloads
           WHERE action_id = 3) AS dns,
          (SELECT COUNT(*) FROM live_acquisition_action_authorizations
           WHERE action_id = 3) AS authorizations,
          (SELECT COUNT(*) FROM live_acquisition_body_payloads
           WHERE action_id = 3) AS bodies,
          (SELECT COUNT(*) FROM live_acquisition_capture_manifests
           WHERE action_id = 3) AS captures,
          (SELECT COUNT(*) FROM live_acquisition_action_events
           WHERE action_id = 3 AND to_state = 'started') AS starts
      `).get()).toEqual({
        reservations: 0,
        dns: 0,
        authorizations: 0,
        bodies: 0,
        captures: 0,
        starts: 0,
      });
    } finally {
      database.close();
    }
  });

  it("linearizes action states and forbids DNS or request replay after terminalization", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-action-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_acquisition:c90:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2026-08-14T13:00:00.000Z";
      const ids = connection
        .prepare(
          `SELECT
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'resource' AND resource_id = 9001
               AND is_active = 1) AS resource_generation_id,
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
               AND is_active = 1) AS page_generation_id,
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'research_run' AND research_run_id = 9001
               AND is_active = 1) AS run_generation_id,
            (SELECT id FROM research_history_epochs
             WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id`,
        )
        .get() as {
          resource_generation_id: number;
          page_generation_id: number;
          run_generation_id: number;
          history_epoch_id: number;
        };
      const historyEpochCreatedAt = String(connection.prepare(
        "SELECT created_at FROM research_history_epochs WHERE id = ?",
      ).pluck().get(ids.history_epoch_id));
      const purgeAt = new Date(
        Date.parse(historyEpochCreatedAt) + 1_000,
      ).toISOString();
      const alienHistoryEpochId = Number(
        connection
          .prepare(
            `SELECT id FROM research_history_epochs
             WHERE resource_id <> 9001 ORDER BY id LIMIT 1`,
          )
          .pluck()
          .get(),
      );
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_consents (
            id, resource_generation_id, history_epoch_id, coordinator_job_id,
            coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
            origin_set_digest, limits_json, status, created_at, expires_at
          ) VALUES (98, ?, ?, 9001, ?, 1, ?, ?, '${frozenConsentLimitsJson}', 'active', ?, ?)`,
        ).run(
          ids.resource_generation_id,
          alienHistoryEpochId,
          ids.run_generation_id,
          "8".repeat(64),
          "9".repeat(64),
          at,
          "2026-08-14T13:05:00.000Z",
        ),
      ).toThrow(/consent ownership/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_consents (
            id, resource_generation_id, history_epoch_id, coordinator_job_id,
            coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
            origin_set_digest, limits_json, status, created_at, expires_at
          ) VALUES (99, ?, ?, 9001, ?, 2, ?, ?, '${frozenConsentLimitsJson}', 'active', ?, ?)`,
        ).run(
          ids.resource_generation_id,
          ids.history_epoch_id,
          ids.run_generation_id,
          "6".repeat(64),
          "7".repeat(64),
          at,
          "2026-08-14T13:05:00.000Z",
        ),
      ).toThrow(/consent ownership/i);
      const insertConsentWithLimits = connection.prepare(
        `INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, ?, 'active', ?, ?)`,
      );
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => insertConsentWithLimits.run(
          ids.resource_generation_id,
          ids.history_epoch_id,
          ids.run_generation_id,
          "a".repeat(64),
          "b".repeat(64),
          unsafeJson,
          at,
          "2026-08-14T13:05:00.000Z",
        )).toThrow(/consent limits are not safe/i);
      }
      expect(() => insertConsentWithLimits.run(
        ids.resource_generation_id,
        ids.history_epoch_id,
        ids.run_generation_id,
        "a".repeat(64),
        "b".repeat(64),
        frozenConsentLimitsJson,
        at,
        "2026-08-14T13:05:00.001Z",
      )).toThrow(/CHECK constraint failed/i);
      connection.prepare(
        `INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, '${frozenConsentLimitsJson}', 'active', ?, ?)`,
      ).run(
        ids.resource_generation_id,
        ids.history_epoch_id,
        ids.run_generation_id,
        "a".repeat(64),
        "b".repeat(64),
        at,
        "2026-08-14T13:05:00.000Z",
      );
      const insertPlannedAction = connection.prepare(
        `INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
          depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          1, 1, ?, ?, ?, 1, 'page', 0, NULL, ?, NULL, ?, 'planned', ?
        )`,
      );
      expect(() => insertPlannedAction.run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "c".repeat(64),
        "d".repeat(64),
        at,
      )).toThrow(/invalid live acquisition planned action/i);
      const insertConsentPayload = connection.prepare(
        `INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, ?)`,
      );
      for (const invalidOrigins of [
        "[]",
        '["https://example.com","https://second.example"]',
        '["https://example.com","https://example.com"]',
        "[1]",
        '["http://example.com"]',
        '["https://example.com/path"]',
        '["https://EXAMPLE.com"]',
      ]) {
        expect(() => insertConsentPayload.run(invalidOrigins))
          .toThrow(/unique canonical HTTPS origins/i);
      }
      expect(() => connection.prepare(`
        INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, x'5b5d')
      `).run()).toThrow(/cannot store BLOB value in TEXT column/i);
      connection.prepare(
        `INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, '["https://example.com"]')`,
      ).run();
      expect(() => insertPlannedAction.run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "c".repeat(64),
        "d".repeat(64),
        at,
      )).toThrow(/invalid live acquisition planned action/i);
      expect(() => connection.prepare(
        `INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
         VALUES (1, ?)` ,
      ).run("x".repeat(32))).toThrow(/cannot store TEXT value in BLOB column/i);
      connection.prepare(
        `INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
         VALUES (1, zeroblob(32))`,
      ).run();
      connection.exec(`
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class,
          assigned_by, assignment_method, source_fingerprint, created_at
        ) VALUES (
          9990, 9001, 'assigned', 9001, 'user_manual', 'user', 'manual',
          'live-capture-assignment', '${at}'
        );
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (9001, 9990);
        INSERT INTO resource_resolution_events (
          id, logical_page_id, state, reason, resource_id, assignment_id,
          candidate_resource_ids_json, source_fingerprint, research_eligible,
          created_at
        ) VALUES (
          9991, 9001, 'matched', 'user_manual', 9001, 9990, '[9001]',
          'live-capture-resolution', 1, '${at}'
        );
        INSERT INTO resource_resolution_heads (
          logical_page_id, resolution_event_id
        ) VALUES (9001, 9991);
      `);
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_consent_payloads
           SET approved_origins_json = '[]' WHERE consent_id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_origin_courtesy_state (
            coordinator_run_id, coordinator_run_generation_id, consent_id,
            canonical_origin_digest, origin_digest, updated_at
          ) VALUES (9001, ?, 1, ?, ?, ?)`,
        ).run(
          ids.page_generation_id,
          "4".repeat(64),
          "5".repeat(64),
          at,
        ),
      ).toThrow(/courtesy owner/i);
      connection.prepare(
        `INSERT INTO live_acquisition_origin_courtesy_state (
          coordinator_run_id, coordinator_run_generation_id, consent_id,
          canonical_origin_digest, origin_digest, updated_at
        ) VALUES (9001, ?, 1, ?, ?, ?)`,
      ).run(
        ids.run_generation_id,
        "4".repeat(64),
        "5".repeat(64),
        at,
      );
      connection.prepare(
        `INSERT INTO live_acquisition_origin_courtesy_state (
          coordinator_run_id, coordinator_run_generation_id, consent_id,
          canonical_origin_digest, origin_digest, updated_at
        ) VALUES (9001, ?, 1, ?, ?, ?)`,
      ).run(
        ids.run_generation_id,
        "6".repeat(64),
        "7".repeat(64),
        at,
      );
      for (const unsafeTimeMutation of [
        { column: "last_request_at", value: "https://secret.example/private" },
        { column: "next_allowed_at", value: "authorization: Bearer secret-token" },
        { column: "retry_after_until", value: "private response body" },
      ] as const) {
        expect(() => connection.prepare(
          `UPDATE live_acquisition_origin_courtesy_state
           SET ${unsafeTimeMutation.column} = ?
           WHERE coordinator_run_id = 9001 AND canonical_origin_digest = ?`,
        ).run(unsafeTimeMutation.value, "4".repeat(64)))
          .toThrow(/invalid live acquisition origin courtesy update/i);
      }
      connection.prepare(
        `UPDATE live_acquisition_origin_courtesy_state
         SET last_request_at = ?, next_allowed_at = ?, updated_at = ?
         WHERE coordinator_run_id = 9001 AND canonical_origin_digest = ?`,
      ).run(
        at,
        "2026-08-14T13:00:01.000Z",
        "2026-08-14T13:00:01.000Z",
        "4".repeat(64),
      );
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_origin_courtesy_state
           SET coordinator_run_generation_id = ?
           WHERE coordinator_run_id = 9001 AND canonical_origin_digest = ?`,
        ).run(ids.page_generation_id, "4".repeat(64)),
      ).toThrow(/courtesy update/i);
      connection.prepare(
        `INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9001, 1, 'queued', 'queued', 'action-coordinator-queued', ?)`,
      ).run(at);
      connection.prepare(
        `INSERT INTO ai_job_attempts (
          id, job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (9001, 9001, 1, 'live-acq-lease-9001', 'migration-test', ?, 'running')`,
      ).run(at);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_checkpoints (
            attempt_id, coordinator_job_id, consent_id, runtime_epoch,
            checkpoint_json, checkpoint_digest, updated_at
          ) VALUES (9001, 9001, 1, 2, '{}', ?, ?)`,
        ).run("2".repeat(64), at),
      ).toThrow(/checkpoint ownership/i);
      connection.prepare(
        `INSERT INTO live_acquisition_checkpoints (
          attempt_id, coordinator_job_id, consent_id, runtime_epoch,
          checkpoint_json, checkpoint_digest, updated_at
        ) VALUES (9001, 9001, 1, 1, '{}', ?, ?)`,
      ).run("2".repeat(64), at);
      connection.prepare(
        `UPDATE live_acquisition_checkpoints
         SET checkpoint_json = '{"next":1}', checkpoint_digest = ?, updated_at = ?
         WHERE attempt_id = 9001`,
      ).run("3".repeat(64), "2026-08-14T13:00:01.000Z");
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_checkpoints
           SET runtime_epoch = 2, updated_at = ? WHERE attempt_id = 9001`,
        ).run("2026-08-14T13:00:02.000Z"),
      ).toThrow(/checkpoint update/i);
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_digest_keys
           SET digest_key = randomblob(32) WHERE consent_id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      insertPlannedAction.run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "c".repeat(64),
        "d".repeat(64),
        at,
      );
      connection.prepare(
        `INSERT INTO live_acquisition_url_payloads (
          action_id, exact_url, keyed_url_digest
        ) VALUES (1, 'https://example.com/page', ?)`,
      ).run("6".repeat(64));
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_url_payloads
           SET exact_url = 'https://example.com/changed' WHERE action_id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_action_authorizations (
            action_id, runtime_epoch, selected_ipv4_digest,
            authorization_digest, authorized_at, expires_at
          ) VALUES (1, 1, ?, ?, ?, ?)`,
        ).run(
          "7".repeat(64),
          "8".repeat(64),
          at,
          "2026-08-14T13:05:00.000Z",
        ),
      ).toThrow(/invalid live acquisition action authorization/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_dns_payloads (
            action_id, answers_json, selected_ipv4, resolved_at
          ) VALUES (1, '[]', NULL, ?)`,
        ).run(at),
      ).toThrow(/owner or state/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_actions (
            id, consent_id, coordinator_run_generation_id,
            resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
            depth, discovered_from_action_id,
            canonical_fetch_url_fingerprint, canonical_origin_digest,
            action_key_digest, state, created_at
          ) VALUES (
            2, 1, ?, ?, ?, 1, 'page', 0, NULL, ?, NULL, ?, 'planned', ?
          )`,
        ).run(
          ids.run_generation_id,
          ids.resource_generation_id,
          ids.history_epoch_id,
          "c".repeat(64),
          "e".repeat(64),
          at,
        ),
      ).toThrow(/UNIQUE/);
      connection.prepare(
        `INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
          depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          2, 1, ?, ?, ?, 1, 'robots', NULL, NULL, NULL, ?, ?, 'planned', ?
        )`,
      ).run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "f".repeat(64),
        "1".repeat(64),
        at,
      );
      expect(() => connection.prepare(
        `INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
          depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          4, 1, ?, ?, ?, 1, 'robots', NULL, NULL, NULL, ?, ?, 'planned', ?
        )`,
      ).run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "9".repeat(64),
        "8".repeat(64),
        at,
      )).toThrow(/invalid live acquisition planned action/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_actions (
            id, consent_id, coordinator_run_generation_id,
            resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
            depth, discovered_from_action_id,
            canonical_fetch_url_fingerprint, canonical_origin_digest,
            action_key_digest, state, created_at
          ) VALUES (
            3, 1, ?, ?, ?, 1, 'robots', 0, NULL, NULL, ?, ?, 'planned', ?
          )`,
        ).run(
          ids.run_generation_id,
          ids.resource_generation_id,
          ids.history_epoch_id,
          "f".repeat(64),
          "2".repeat(64),
          at,
        ),
      ).toThrow();
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_actions (
            id, consent_id, coordinator_run_generation_id,
            resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
            depth, discovered_from_action_id,
            canonical_fetch_url_fingerprint, canonical_origin_digest,
            action_key_digest, state, created_at
          ) VALUES (
            3, 1, ?, ?, ?, 1, 'robots', NULL, NULL, NULL, ?, ?, 'planned', ?
          )`,
        ).run(
          ids.run_generation_id,
          ids.resource_generation_id,
          ids.history_epoch_id,
          "f".repeat(64),
          "3".repeat(64),
          at,
        ),
      ).toThrow(/invalid live acquisition planned action/i);
      const insertEvent = connection.prepare(
        `INSERT INTO live_acquisition_action_events (
          id, action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (?, 1, ?, ?, ?, ?, '{}', ?)`,
      );
      const insertUnsafeEvent = connection.prepare(
        `INSERT INTO live_acquisition_action_events (
          id, action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (99, 1, 1, 'planned', 'planned', NULL, ?, ?)`,
      );
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => insertUnsafeEvent.run(unsafeJson, at))
          .toThrow(/action event details are not safe/i);
      }
      for (const unsafeCode of [
        "https://secret.example/private",
        "authorization: Bearer secret-token",
      ]) {
        expect(() => connection.prepare(
          `INSERT INTO live_acquisition_action_events (
            id, action_id, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          ) VALUES (99, 1, 1, 'planned', 'planned', ?, '{}', ?)`,
        ).run(unsafeCode, at)).toThrow(/invalid live acquisition action transition/i);
      }
      insertEvent.run(1, 1, "planned", "planned", null, at);
      expect(() =>
        connection
          .prepare("UPDATE live_acquisition_actions SET state = 'resolved' WHERE id = 1")
          .run(),
      ).toThrow(/event-owned/i);
      connection.prepare(`
        INSERT INTO live_acquisition_page_reservations (
          consent_id, action_id, reservation_sequence, reserved_at
        ) VALUES (1, 1, 1, ?)
      `).run("2026-08-14T13:00:01.000Z");
      connection.prepare(
        `INSERT INTO live_acquisition_dns_payloads (
          action_id, answers_json, selected_ipv4, resolved_at
        ) VALUES (1, '[]', NULL, ?)`,
      ).run("2026-08-14T13:00:01.000Z");
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_dns_payloads
           SET answers_json = '["127.0.0.1"]' WHERE action_id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() =>
        insertEvent.run(
          3,
          3,
          "resolution_started",
          "resolution_started",
          null,
          "2026-08-14T13:00:02.000Z",
        ),
      ).toThrow(/invalid live acquisition action transition/i);

      connection.prepare(
        `INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch, action_kind,
          depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          3, 1, ?, ?, ?, 1, 'page', 0, NULL, ?, NULL, ?, 'planned', ?
        )`,
      ).run(
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        "4".repeat(64),
        "5".repeat(64),
        at,
      );
      connection.prepare(
        `INSERT INTO live_acquisition_url_payloads (
          action_id, exact_url, keyed_url_digest
        ) VALUES (3, 'https://example.com/source', ?)`,
      ).run("a".repeat(64));
      const insertCompletedEvent = connection.prepare(
        `INSERT INTO live_acquisition_action_events (
          id, action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (?, 3, ?, ?, ?, ?, '{}', ?)`,
      );
      insertCompletedEvent.run(10, 1, "planned", "planned", null, at);
      connection.prepare(`
        INSERT INTO live_acquisition_page_reservations (
          consent_id, action_id, reservation_sequence, reserved_at
        ) VALUES (1, 3, 2, ?)
      `).run("2026-08-14T13:00:03.000Z");
      connection.prepare(
        `INSERT INTO live_acquisition_dns_payloads (
          action_id, answers_json, selected_ipv4, resolved_at
        ) VALUES (3, '["203.0.113.1"]', '203.0.113.1', ?)`,
      ).run("2026-08-14T13:00:03.000Z");
      insertCompletedEvent.run(
        12,
        3,
        "resolution_started",
        "resolved",
        null,
        "2026-08-14T13:00:04.000Z",
      );
      expect(() =>
        insertCompletedEvent.run(
          13,
          4,
          "resolved",
          "authorized",
          null,
          "2026-08-14T13:00:05.000Z",
        ),
      ).toThrow(/invalid live acquisition action transition/i);
      connection.prepare(
        `INSERT INTO live_acquisition_action_authorizations (
          action_id, runtime_epoch, selected_ipv4_digest,
          authorization_digest, authorized_at, expires_at
        ) VALUES (3, 1, ?, ?, ?, ?)`,
      ).run(
        "b".repeat(64),
        "c".repeat(64),
        "2026-08-14T13:00:04.000Z",
        "2026-08-14T13:05:00.000Z",
      );
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_action_authorizations
           SET runtime_epoch = 2 WHERE action_id = 3`,
        ).run(),
      ).toThrow(/immutable/i);
      insertCompletedEvent.run(
        13,
        4,
        "resolved",
        "authorized",
        null,
        "2026-08-14T13:00:05.000Z",
      );
      insertCompletedEvent.run(
        14,
        5,
        "authorized",
        "started",
        null,
        "2026-08-14T13:00:06.000Z",
      );
      const insertBodyPayload = connection.prepare(
        `INSERT INTO live_acquisition_body_payloads (
          action_id, raw_body, extracted_text, body_digest,
          response_metadata_json, acquired_at
        ) VALUES (3, ?, ?, ?, '{}', ?)`,
      );
      connection.exec("SAVEPOINT body_at_source_cap");
      insertBodyPayload.run(
        Buffer.alloc(65536),
        "a",
        "d".repeat(64),
        "2026-08-14T13:00:06.000Z",
      );
      connection.exec("ROLLBACK TO body_at_source_cap");
      connection.exec("RELEASE body_at_source_cap");
      expect(() => insertBodyPayload.run(
        Buffer.alloc(65537),
        "a",
        "d".repeat(64),
        "2026-08-14T13:00:06.000Z",
      )).toThrow(/invalid live acquisition body payload owner or state/i);
      expect(() => insertBodyPayload.run(
        Buffer.from([1]),
        "a".repeat(65537),
        "d".repeat(64),
        "2026-08-14T13:00:06.000Z",
      )).toThrow(/invalid live acquisition body payload owner or state/i);
      connection.prepare(
        `INSERT INTO live_acquisition_body_payloads (
          action_id, raw_body, extracted_text, body_digest,
          response_metadata_json, acquired_at
        ) VALUES (3, x'0102', 'captured body', ?, '{}', ?)`,
      ).run("d".repeat(64), "2026-08-14T13:00:06.000Z");
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_body_payloads
           SET extracted_text = 'changed' WHERE action_id = 3`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() => insertCompletedEvent.run(
        15,
        6,
        "started",
        "completed",
        "FETCH_COMPLETED",
        "2026-08-14T13:00:07.000Z",
      )).toThrow(/invalid live acquisition action transition/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_capture_manifests (
            id, consent_id, logical_page_generation_id, action_id,
            reservation_id, depth, capture_sequence,
            url_digest, content_digest, manifest_json, created_at
          ) VALUES (98, 1, ?, 3, 2, 0, 1, ?, ?, '{}', ?)`,
        ).run(
          ids.run_generation_id,
          "a".repeat(64),
          "d".repeat(64),
          "2026-08-14T13:00:07.000Z",
        ),
      ).toThrow(/ownership/i);
      const insertCaptureManifestWithDetails = connection.prepare(
        `INSERT INTO live_acquisition_capture_manifests (
          id, consent_id, logical_page_generation_id, action_id,
          reservation_id, depth, capture_sequence,
          url_digest, content_digest, manifest_json, created_at
        ) VALUES (99, 1, ?, 3, 2, 0, 1, ?, ?, ?, ?)`,
      );
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => insertCaptureManifestWithDetails.run(
          ids.page_generation_id,
          "a".repeat(64),
          "d".repeat(64),
          unsafeJson,
          "2026-08-14T13:00:07.000Z",
        )).toThrow(/capture manifest is not digest-only/i);
      }
      const insertExactCapture = connection.prepare(
        `INSERT INTO live_acquisition_capture_manifests (
          id, consent_id, logical_page_generation_id, action_id,
          reservation_id, depth, capture_sequence,
          url_digest, content_digest, manifest_json, created_at
        ) VALUES (1, 1, ?, 3, 2, 0, 1, ?, ?, '{}', ?)`,
      );
      const exactCaptureArgs = [
        ids.page_generation_id,
        "a".repeat(64),
        "d".repeat(64),
        "2026-08-14T13:00:07.000Z",
      ] as const;
      connection.exec("SAVEPOINT capture_completion_rollback");
      insertExactCapture.run(...exactCaptureArgs);
      insertCompletedEvent.run(
        15,
        6,
        "started",
        "completed",
        "FETCH_COMPLETED",
        "2026-08-14T13:00:07.000Z",
      );
      connection.exec("ROLLBACK TO capture_completion_rollback");
      connection.exec("RELEASE capture_completion_rollback");
      expect(connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = 3
      `).pluck().get()).toBe("started");
      expect(connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_capture_manifests
        WHERE action_id = 3
      `).pluck().get()).toBe(0);
      insertExactCapture.run(...exactCaptureArgs);
      insertCompletedEvent.run(
        15,
        6,
        "started",
        "completed",
        "FETCH_COMPLETED",
        "2026-08-14T13:00:07.000Z",
      );
      const insertDiscoveredChild = connection.prepare(`
        INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch,
          action_kind, depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          ?, 1, ?, ?, ?, 1, 'page', ?, 3, ?, NULL, ?, 'planned', ?
        )
      `);
      expect(() => insertDiscoveredChild.run(
        4,
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        2,
        "7".repeat(64),
        "8".repeat(64),
        "2026-08-14T13:00:08.000Z",
      )).toThrow(/invalid live acquisition planned action/i);
      insertDiscoveredChild.run(
        4,
        ids.run_generation_id,
        ids.resource_generation_id,
        ids.history_epoch_id,
        1,
        "7".repeat(64),
        "8".repeat(64),
        "2026-08-14T13:00:08.000Z",
      );
      expect(connection.prepare(`
        SELECT on_delete FROM pragma_foreign_key_list('live_acquisition_actions')
        WHERE "from" = 'discovered_from_action_id'
      `).pluck().get()).toBe("RESTRICT");
      const actionUpdateGuardSql = String(connection.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'live_acquisition_actions_validate_update'
      `).pluck().get());
      connection.exec("DROP TRIGGER live_acquisition_actions_validate_update");
      try {
        expect(() => connection.prepare(`
          UPDATE live_acquisition_actions
          SET discovered_from_action_id = 999999 WHERE id = 4
        `).run()).toThrow(/FOREIGN KEY constraint failed/i);
      } finally {
        connection.exec(`${actionUpdateGuardSql};`);
      }
      expect(connection.prepare(`
        SELECT discovered_from_action_id FROM live_acquisition_actions WHERE id = 4
      `).pluck().get()).toBe(3);
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_capture_manifests
           SET manifest_json = '{"changed":true}' WHERE id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_workflow_outcomes (
            id, coordinator_job_id, coordinator_run_generation_id,
            outcome, outcome_code, safe_details_json, created_at
          ) VALUES (98, 9001, ?, 'ambiguous', 'WORKFLOW_AMBIGUOUS', '{}', ?)`,
        ).run(ids.page_generation_id, "2026-08-14T13:00:08.000Z"),
      ).toThrow(/outcome ownership/i);
      const insertWorkflowOutcomeWithDetails = connection.prepare(
        `INSERT INTO live_acquisition_workflow_outcomes (
          id, coordinator_job_id, coordinator_run_generation_id,
          outcome, outcome_code, safe_details_json, created_at
        ) VALUES (99, 9001, ?, 'ambiguous', 'WORKFLOW_AMBIGUOUS', ?, ?)`,
      );
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => insertWorkflowOutcomeWithDetails.run(
          ids.run_generation_id,
          unsafeJson,
          "2026-08-14T13:00:08.000Z",
        )).toThrow(/workflow outcome details are not safe/i);
      }
      for (const unsafeCode of [
        "https://secret.example/private",
        "authorization: Bearer secret-token",
      ]) {
        expect(() => connection.prepare(
          `INSERT INTO live_acquisition_workflow_outcomes (
            id, coordinator_job_id, coordinator_run_generation_id,
            outcome, outcome_code, safe_details_json, created_at
          ) VALUES (99, 9001, ?, 'ambiguous', ?, '{}', ?)`,
        ).run(
          ids.run_generation_id,
          unsafeCode,
          "2026-08-14T13:00:08.000Z",
        )).toThrow(/CHECK constraint failed/i);
      }
      connection.prepare(
        `INSERT INTO live_acquisition_workflow_outcomes (
          id, coordinator_job_id, coordinator_run_generation_id,
          outcome, outcome_code, safe_details_json, created_at
        ) VALUES (1, 9001, ?, 'ambiguous', 'WORKFLOW_AMBIGUOUS', '{}', ?)`,
      ).run(ids.run_generation_id, "2026-08-14T13:00:08.000Z");
      expect(() =>
        connection.prepare(
          `UPDATE live_acquisition_workflow_outcomes
           SET outcome_code = 'CHANGED' WHERE id = 1`,
        ).run(),
      ).toThrow(/immutable/i);
      expect(() =>
        connection.prepare(
          "DELETE FROM live_acquisition_checkpoints WHERE attempt_id = 9001",
        ).run(),
      ).toThrow(/immutable|exact purge authority/i);

      const courtesyPk = encodePrivacyPurgePrimaryKeyV1([
        { type: "integer", value: 9001 },
        { type: "text", value: "4".repeat(64) },
      ]);
      const courtesyTarget = {
        tableName: "live_acquisition_origin_courtesy_state",
        pkV1: courtesyPk,
      } as const;
      insertPrivacyPurgeCommand(connection, {
        id: 7001,
        targetKind: "logical_page",
        subjectGenerationId: ids.page_generation_id,
        orderedTargets: [courtesyTarget],
        createdAt: "2026-08-14T13:00:09.000Z",
      });
      expect(() =>
        connection.prepare(
          `DELETE FROM live_acquisition_origin_courtesy_state
           WHERE coordinator_run_id = 9001 AND canonical_origin_digest = ?`,
        ).run("4".repeat(64)),
      ).toThrow(/immutable|exact purge authority/i);
      expect(() => executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(7001, [{
          tableName: "live_acquisition_origin_courtesy_state",
          pkV1: encodePrivacyPurgePrimaryKeyV1([
            { type: "text", value: "4".repeat(64) },
            { type: "integer", value: 9001 },
          ]),
        }], purgeAt, "3"),
      )).toThrow(/durable commitment/i);
      executePrivacyPurgePlan(
        connection,
        completedPrivacyPurgePlan(7001, [courtesyTarget], purgeAt, "3"),
      );
      expect(
        connection.prepare(
          "SELECT COUNT(*) FROM live_acquisition_origin_courtesy_state",
        ).pluck().get(),
      ).toBe(1);
      expect(connection.prepare(`
        SELECT canonical_origin_digest
        FROM live_acquisition_origin_courtesy_state
      `).pluck().get()).toBe("6".repeat(64));
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_body_payloads (
            action_id, raw_body, extracted_text, body_digest,
            response_metadata_json, acquired_at
          ) VALUES (1, x'01', 'late body', ?, '{}', ?)`,
        ).run("9".repeat(64), "2026-08-14T13:00:03.000Z"),
      ).toThrow(/owner or state/i);
      insertEvent.run(
        3,
        3,
        "resolution_started",
        "ambiguous",
        "DNS_RESULT_UNKNOWN",
        "2026-08-14T13:00:02.000Z",
      );
      expect(
        connection
          .prepare(
            "SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = 1",
          )
          .get(),
      ).toEqual({
        state: "ambiguous",
        sequence_no: 3,
        terminal_at: "2026-08-14T13:00:02.000Z",
      });
      expect(() =>
        insertEvent.run(
          4,
          4,
          "ambiguous",
          "started",
          null,
          "2026-08-14T13:00:03.000Z",
        ),
      ).toThrow(/invalid live acquisition action transition/i);
    } finally {
      database.close();
    }
  });

  it("rechecks the schema-25 attempt cap when ordinary C81 providers bind", () => {
    const database = openDatabase(":memory:");
    let now = new Date("2026-08-15T09:00:00.000Z");
    let tokenNo = 0;
    try {
      const connection = database.connection;
      const ledger = createAiJobLedger(connection, {
        clock: () => now,
        token: () => `ordinary-bind-${String(++tokenNo).padStart(4, "0")}`,
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => now }),
      });
      const seedOrdinary = (id: number) => {
        const at = now.toISOString();
        connection.prepare(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, `https://ordinary-${id}.example/`, `https://ordinary-${id}.example/`,
          `https://ordinary-${id}.example/`, at, at);
        connection.prepare(`
          INSERT INTO ai_jobs (
            id, kind, subject_type, logical_page_id, subject_key, requested_by,
            request_method, idempotency_key, submission_fingerprint,
            input_fingerprint, workflow_id, workflow_version, scheduling_priority,
            progress_total, available_at, max_steps, max_tokens, max_cost_usd,
            max_wall_time_ms, created_at, updated_at
          ) VALUES (
            ?, 'resource_research', 'page', ?, ?, 'system', 'scheduled', ?, ?, ?,
            'research_workflow:c81:v1', 1, 100, 1, ?, 10, 1000, 0,
            60000, ?, ?
          )
        `).run(
          id, id, `page:${id}`, `ordinary-bind-${id}`,
          createHash("sha256").update(`ordinary-submit:${id}`).digest("hex"),
          createHash("sha256").update(`ordinary-input:${id}`).digest("hex"),
          at, at, at,
        );
        connection.prepare(`
          INSERT INTO research_runs (
            id, job_id, target_logical_page_id, target_key, question_digest,
            scope_json, approval_fingerprint, corpus_fingerprint,
            submission_fingerprint, workflow_id, workflow_version, max_steps,
            max_tokens, max_cost_usd, max_wall_time_ms, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'research_workflow:c81:v1', 1,
            10, 1000, 0, 60000, ?
          )
        `).run(
          id, id, id, `page:${id}`,
          createHash("sha256").update(`ordinary-question:${id}`).digest("hex"),
          createHash("sha256").update(`ordinary-input:${id}`).digest("hex"),
          createHash("sha256").update(`ordinary-corpus:${id}`).digest("hex"),
          createHash("sha256").update(`ordinary-submit:${id}`).digest("hex"), at,
        );
        connection.prepare(`
          INSERT INTO research_run_events (
            run_id, sequence_no, event_type, status, idempotency_key, occurred_at
          ) VALUES (?, 1, 'queued', 'queued', ?, ?)
        `).run(id, `ordinary-bind-${id}-queued`, at);
      };
      const limits = {
        maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2,
      } as const;
      for (let index = 1; index <= 9; index += 1) {
        const id = 10_000 + index;
        seedOrdinary(id);
        const claim = ledger.claimNext(
          "resource_research", "ordinary-worker", limits, undefined,
          [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (claim === undefined) throw new Error(`missing ordinary claim ${index}`);
        ledger.bindAttemptProvider(claim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        ledger.fail(claim, {
          progress: { ...claim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
          },
        }, { code: "JOB_INPUT_UNAVAILABLE" });
        now = new Date(now.getTime() + 1);
      }
      seedOrdinary(10_010);
      seedOrdinary(10_011);
      for (const [id, token] of [[10_010, "ordinary-race-token-10"],
        [10_011, "ordinary-race-token-11"]] as const) {
        connection.prepare(`
          INSERT INTO ai_job_attempts (
            job_id, attempt_no, lease_token, worker_id, started_at, outcome
          ) VALUES (?, 1, ?, 'ordinary-race-worker', ?, 'running')
        `).run(id, token, now.toISOString());
      }
      const attempts = connection.prepare(`
        SELECT id, job_id FROM ai_job_attempts
        WHERE job_id IN (10010, 10011) ORDER BY job_id
      `).all() as Array<{ id: number; job_id: number }>;
      expect(attempts).toHaveLength(2);
      connection.prepare(`
        UPDATE ai_job_attempts
        SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
          pricing_version = 'pricing-v1', provider_bound_at = ?
        WHERE id = ?
      `).run(now.toISOString(), attempts[0]!.id);
      const beforeEleventh = connection.prepare(`
        SELECT * FROM ai_job_attempts WHERE id = ?
      `).get(attempts[1]!.id);
      expect(() => connection.prepare(`
        UPDATE ai_job_attempts
        SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
          pricing_version = 'pricing-v1', provider_bound_at = ?
        WHERE id = ?
      `).run(now.toISOString(), attempts[1]!.id)).toThrow(/exceeds daily caps/i);
      expect(connection.prepare(`
        SELECT * FROM ai_job_attempts WHERE id = ?
      `).get(attempts[1]!.id)).toEqual(beforeEleventh);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE provider IS NOT NULL
      `).pluck().get()).toBe(10);
    } finally {
      database.close();
    }
  });

  it("keeps receipt-backed final adoption and bind caps inclusive and race-safe", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    let now = new Date("2026-08-14T12:00:02.000Z");
    let tokenNo = 0;
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const ledger = createAiJobLedger(connection, {
        clock: () => now,
        token: () => `final-cap-token-${String(++tokenNo).padStart(4, "0")}`,
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => now }),
      });
      const limits = {
        maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2,
      } as const;
      let paidAttemptId = 0;
      for (let index = 1; index <= 9; index += 1) {
        const id = 11_000 + index;
        seedOrdinaryC81ResearchJob(connection, id, now.toISOString(), index === 1 ? 1 : 0);
        const claim = ledger.claimNext(
          "resource_research", "final-cap-competitor", limits, undefined,
          [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (claim === undefined || claim.id !== id) {
          throw new Error(`missing final-cap competitor ${index}`);
        }
        ledger.bindAttemptProvider(claim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        if (index === 1) {
          paidAttemptId = claim.attemptId;
          ledger.checkpoint(claim, {
            progress: { ...claim.progress, stage: "claimed" },
            checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
            usage: {
              steps: 0, inputTokens: 0, outputTokens: 0,
              costUsd: 1, wallTimeMs: 0,
            },
          });
        }
        ledger.fail(claim, {
          progress: { ...claim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
          },
        }, { code: index === 1 ? "JOB_BUDGET_EXHAUSTED" : "JOB_INPUT_UNAVAILABLE" });
        now = new Date(now.getTime() + 1);
      }
      expect(connection.prepare(`
        SELECT SUM(cost_usd) FROM ai_job_attempts WHERE provider IS NOT NULL
      `).pluck().get()).toBe(1);
      expect(connection.prepare(`
        SELECT reserved_usd - consumed_usd
        FROM live_acquisition_provider_reservations WHERE final_job_id = ?
      `).pluck().get(fixture.finalJobId)).toBe(1);

      const finalClaim = ledger.claimNext(
        "resource_research", "receipt-final-worker", limits, undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      );
      if (finalClaim === undefined || finalClaim.id !== fixture.finalJobId) {
        throw new Error("missing receipt-backed final claim at exact committed cap");
      }

      connection.exec("SAVEPOINT exact_tenth_final_bind");
      try {
        ledger.bindAttemptProvider(finalClaim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        expect(connection.prepare(`
          SELECT COUNT(*) FROM ai_job_attempts WHERE provider IS NOT NULL
        `).pluck().get()).toBe(10);
        expect(connection.prepare(`
          SELECT utc_date, adopted_at
          FROM live_acquisition_provider_reservation_adoptions
          WHERE attempt_id = ?
        `).get(finalClaim.attemptId)).toEqual({
          utc_date: "2026-08-14", adopted_at: now.toISOString(),
        });
      } finally {
        connection.exec("ROLLBACK TO exact_tenth_final_bind");
        connection.exec("RELEASE exact_tenth_final_bind");
      }

      const insertFinalAdoption = () => connection.prepare(`
        INSERT INTO live_acquisition_provider_reservation_adoptions (
          attempt_id, reservation_id, final_job_id, utc_date, adopted_at
        ) VALUES (?, 1, ?, '2026-08-14', ?)
      `).run(finalClaim.attemptId, fixture.finalJobId, now.toISOString());

      connection.exec("SAVEPOINT final_bind_attempt_race");
      try {
        insertFinalAdoption();
        seedOrdinaryC81ResearchJob(connection, 11_010, now.toISOString(), 0);
        connection.prepare(`
          INSERT INTO ai_job_attempts (
            job_id, attempt_no, lease_token, worker_id, started_at, outcome
          ) VALUES (11010, 1, 'final-race-token-10', 'final-race-worker', ?, 'running')
        `).run(now.toISOString());
        const tenthOrdinaryAttempt = connection.prepare(`
          SELECT id FROM ai_job_attempts WHERE job_id = 11010
        `).pluck().get() as number;
        connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
            pricing_version = 'pricing-v1', provider_bound_at = ?
          WHERE id = ?
        `).run(now.toISOString(), tenthOrdinaryAttempt);
        const beforeRejectedBind = {
          job: connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
            .get(fixture.finalJobId),
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
          `).pluck().get(fixture.finalJobId),
        };
        expect(() => ledger.bindAttemptProvider(finalClaim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        })).toThrow(/exceeds daily caps/i);
        expect({
          job: connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
            .get(fixture.finalJobId),
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
          `).pluck().get(fixture.finalJobId),
        }).toEqual(beforeRejectedBind);
      } finally {
        connection.exec("ROLLBACK TO final_bind_attempt_race");
        connection.exec("RELEASE final_bind_attempt_race");
      }

      connection.exec("SAVEPOINT final_bind_cost_race");
      try {
        insertFinalAdoption();
        connection.exec("DROP TRIGGER ai_job_attempts_terminal_once");
        connection.prepare(`
          UPDATE ai_job_attempts SET cost_usd = cost_usd + 0.000001 WHERE id = ?
        `).run(paidAttemptId);
        const beforeRejectedBind = {
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
          `).pluck().get(fixture.finalJobId),
        };
        expect(() => ledger.bindAttemptProvider(finalClaim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        })).toThrow(/exceeds daily caps/i);
        expect({
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
          `).pluck().get(fixture.finalJobId),
        }).toEqual(beforeRejectedBind);
      } finally {
        connection.exec("ROLLBACK TO final_bind_cost_race");
        connection.exec("RELEASE final_bind_cost_race");
      }

      connection.exec("SAVEPOINT paired_tamper_adoption");
      try {
        connection.exec("DROP TRIGGER live_acquisition_provider_reservations_validate_update");
        connection.prepare(`
          UPDATE live_acquisition_provider_reservations
          SET reserved_usd = 1.1, consumed_usd = 0.1 WHERE id = 1
        `).run();
        const beforePairedAdoption = {
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE id = 1
          `).get(),
          adoptionCount: connection.prepare(`
            SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).pluck().get(finalClaim.attemptId),
        };
        expect(insertFinalAdoption).toThrow(/provider reservation adoption/i);
        expect({
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE id = 1
          `).get(),
          adoptionCount: connection.prepare(`
            SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).pluck().get(finalClaim.attemptId),
        }).toEqual(beforePairedAdoption);
      } finally {
        connection.exec("ROLLBACK TO paired_tamper_adoption");
        connection.exec("RELEASE paired_tamper_adoption");
      }

      connection.exec("SAVEPOINT paired_tamper_final_bind");
      try {
        insertFinalAdoption();
        connection.exec("DROP TRIGGER live_acquisition_provider_reservations_validate_update");
        connection.prepare(`
          UPDATE live_acquisition_provider_reservations
          SET reserved_usd = 1.1, consumed_usd = 0.1 WHERE id = 1
        `).run();
        const beforePairedBind = {
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE id = 1
          `).get(),
        };
        expect(() => connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
            pricing_version = 'pricing-v1', provider_bound_at = ?
          WHERE id = ?
        `).run(now.toISOString(), finalClaim.attemptId)).toThrow(/adoption is not current/i);
        expect({
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(finalClaim.attemptId),
          adoption: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE attempt_id = ?
          `).get(finalClaim.attemptId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE id = 1
          `).get(),
        }).toEqual(beforePairedBind);
      } finally {
        connection.exec("ROLLBACK TO paired_tamper_final_bind");
        connection.exec("RELEASE paired_tamper_final_bind");
      }

      for (const mode of ["attempt", "cost"] as const) {
        connection.exec(`SAVEPOINT final_adoption_${mode}_over_cap`);
        let adoptionError: unknown;
        try {
          if (mode === "attempt") {
            seedOrdinaryC81ResearchJob(connection, 11_011, now.toISOString(), 0);
            connection.prepare(`
              INSERT INTO ai_job_attempts (
                job_id, attempt_no, lease_token, worker_id, started_at, outcome
              ) VALUES (
                11011, 1, 'final-adoption-token-10', 'final-adoption-worker', ?, 'running'
              )
            `).run(now.toISOString());
            const attemptId = connection.prepare(`
              SELECT id FROM ai_job_attempts WHERE job_id = 11011
            `).pluck().get() as number;
            connection.prepare(`
              UPDATE ai_job_attempts
              SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
                pricing_version = 'pricing-v1', provider_bound_at = ?
              WHERE id = ?
            `).run(now.toISOString(), attemptId);
          } else {
            connection.exec("DROP TRIGGER ai_job_attempts_terminal_once");
            connection.prepare(`
              UPDATE ai_job_attempts SET cost_usd = cost_usd + 0.000001 WHERE id = ?
            `).run(paidAttemptId);
          }
          insertFinalAdoption();
        } catch (error) {
          adoptionError = error;
        } finally {
          connection.exec(`ROLLBACK TO final_adoption_${mode}_over_cap`);
          connection.exec(`RELEASE final_adoption_${mode}_over_cap`);
        }
        expect(() => {
          if (adoptionError !== undefined) throw adoptionError;
        }).toThrow(/provider reservation adoption/i);
        expect(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
          WHERE attempt_id = ?
        `).pluck().get(finalClaim.attemptId)).toBe(0);
      }
    } finally {
      database.close();
    }
  });

  it("fails public final binds closed for missing, inactive, or tampered reservations", () => {
    for (const mode of [
      "missing_receipt", "missing_reservation", "inactive_reservation",
      "tampered_reservation",
    ] as const) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      const now = new Date("2026-08-14T12:00:02.000Z");
      try {
        const connection = database.connection;
        const fixture = seedReceiptBackedLiveResearchRun(connection);
        const ledger = createAiJobLedger(connection, {
          clock: () => now,
          token: () => `unavailable-final-${mode}`,
          kindAvailable: (kind) => kind === "resource_research",
          research: createResearchStore(connection, { clock: () => now }),
        });
        const claim = ledger.claimNext(
          "resource_research", `unavailable-${mode}`,
          { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
          undefined, [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (claim === undefined || claim.id !== fixture.finalJobId) {
          throw new Error(`missing final claim for ${mode}`);
        }
        if (mode === "missing_receipt") {
          connection.exec("DROP TRIGGER live_acquisition_handoff_receipts_immutable_delete");
          connection.prepare(`
            DELETE FROM live_acquisition_handoff_receipts WHERE handoff_id = ?
          `).run(fixture.handoffId);
        } else if (mode === "missing_reservation") {
          connection.exec("DROP TRIGGER live_acquisition_provider_reservations_immutable_delete");
          connection.prepare(`
            DELETE FROM live_acquisition_provider_reservations WHERE final_job_id = ?
          `).run(fixture.finalJobId);
        } else {
          connection.exec("DROP TRIGGER live_acquisition_provider_reservations_validate_update");
          if (mode === "inactive_reservation") {
            connection.prepare(`
              UPDATE live_acquisition_provider_reservations
              SET status = 'released', terminal_at = ? WHERE final_job_id = ?
            `).run(now.toISOString(), fixture.finalJobId);
          } else {
            connection.prepare(`
              UPDATE live_acquisition_provider_reservations
              SET reserved_usd = 1.1, consumed_usd = 0.1 WHERE final_job_id = ?
            `).run(fixture.finalJobId);
          }
        }
        const before = {
          job: connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
            .get(fixture.finalJobId),
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(claim.attemptId),
          adoptions: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE final_job_id = ? ORDER BY attempt_id
          `).all(fixture.finalJobId),
          events: connection.prepare(`
            SELECT * FROM ai_job_events WHERE job_id = ? ORDER BY sequence_no
          `).all(fixture.finalJobId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE final_job_id = ?
          `).get(fixture.finalJobId),
        };
        expect(() => ledger.bindAttemptProvider(claim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        }), mode).toThrow(/final provider reservation is unavailable/i);
        expect({
          job: connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
            .get(fixture.finalJobId),
          attempt: connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
            .get(claim.attemptId),
          adoptions: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservation_adoptions
            WHERE final_job_id = ? ORDER BY attempt_id
          `).all(fixture.finalJobId),
          events: connection.prepare(`
            SELECT * FROM ai_job_events WHERE job_id = ? ORDER BY sequence_no
          `).all(fixture.finalJobId),
          reservation: connection.prepare(`
            SELECT * FROM live_acquisition_provider_reservations WHERE final_job_id = ?
          `).get(fixture.finalJobId),
        }, mode).toEqual(before);
      } finally {
        database.close();
      }
    }
  });

  it("rolls an active final reservation at bind time across midnight in-lease", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    let now = new Date("2026-08-14T23:59:30.000Z");
    try {
      const connection = database.connection;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      const ledger = createAiJobLedger(connection, {
        clock: () => now,
        token: () => "midnight-final-token-0001",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => now }),
      });
      const claim = ledger.claimNext(
        "resource_research", "midnight-final-worker",
        { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
        undefined, [{ id: "research_workflow:c81:v1", version: 1 }],
      );
      if (claim === undefined || claim.id !== fixture.finalJobId) {
        throw new Error("missing midnight final claim");
      }
      const eventsBeforeBind = connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(fixture.finalJobId);
      now = new Date("2026-08-15T00:00:00.000Z");
      ledger.bindAttemptProvider(claim, {
        provider: "openai", model: "gpt-5", promptVersion: "v1",
        pricingVersion: "pricing-v1",
      });
      expect(connection.prepare(`
        SELECT reservation.utc_date, adoption.utc_date AS adoption_date,
          adoption.adopted_at, attempt.provider_bound_at
        FROM live_acquisition_provider_reservations AS reservation
        JOIN live_acquisition_provider_reservation_adoptions AS adoption
          ON adoption.reservation_id = reservation.id
        JOIN ai_job_attempts AS attempt ON attempt.id = adoption.attempt_id
        WHERE reservation.final_job_id = ?
      `).get(fixture.finalJobId)).toEqual({
        utc_date: "2026-08-15",
        adoption_date: "2026-08-15",
        adopted_at: "2026-08-15T00:00:00.000Z",
        provider_bound_at: "2026-08-15T00:00:00.000Z",
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(fixture.finalJobId)).toBe(eventsBeforeBind);
    } finally {
      database.close();
    }
  });

  it("attributes post-midnight schema-25 usage to the provider or adoption day", () => {
    for (const mode of ["ordinary", "receipt_final"] as const) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      let now = new Date("2026-08-14T23:59:30.000Z");
      try {
        const connection = database.connection;
        const fixture = mode === "receipt_final"
          ? seedReceiptBackedLiveResearchRun(connection)
          : undefined;
        if (mode === "ordinary") {
          seedOrdinaryC81ResearchJob(connection, 12_001, now.toISOString(), 1);
        }
        let tokenNo = 0;
        const ledger = createAiJobLedger(connection, {
          clock: () => now,
          token: () => `attribution-token-${mode}-${String(++tokenNo).padStart(4, "0")}`,
          kindAvailable: (kind) => kind === "resource_research",
          research: createResearchStore(connection, { clock: () => now }),
        });
        const limits = {
          maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2,
        } as const;
        const paid = ledger.claimNext(
          "resource_research", `attribution-${mode}`, limits, undefined,
          [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (paid === undefined || paid.id !== (fixture?.finalJobId ?? 12_001)) {
          throw new Error(`missing ${mode} attribution claim`);
        }
        ledger.bindAttemptProvider(paid, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        now = new Date("2026-08-15T00:00:00.000Z");
        ledger.checkpoint(paid, {
          progress: { ...paid.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 1, wallTimeMs: 0,
          },
        });
        ledger.fail(paid, {
          progress: { ...paid.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
          },
        }, { code: "JOB_BUDGET_EXHAUSTED" });
        expect(connection.prepare(`
          SELECT attempt.provider_bound_at,
            adoption.utc_date AS adoption_date,
            attempt.cost_usd
          FROM ai_job_attempts AS attempt
          LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
            ON adoption.attempt_id = attempt.id
          WHERE attempt.id = ?
        `).get(paid.attemptId)).toEqual({
          provider_bound_at: "2026-08-14T23:59:30.000Z",
          adoption_date: mode === "receipt_final" ? "2026-08-14" : null,
          cost_usd: 1,
        });
        now = new Date("2026-08-15T00:00:01.000Z");
        seedOrdinaryC81ResearchJob(connection, 12_002, now.toISOString(), 2);
        const exactNextDay = ledger.claimNext(
          "resource_research", `next-day-${mode}`, limits, undefined,
          [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        expect(exactNextDay?.id, mode).toBe(12_002);
      } finally {
        database.close();
      }
    }
  });

  it("closes final reservations for every terminal status but not retry transitions", () => {
    const terminalCases = [
      { status: "succeeded", costUsd: 1, expected: "consumed" },
      { status: "partial", costUsd: 0, expected: "released" },
      { status: "failed", costUsd: 1, expected: "consumed" },
      { status: "cancelled", costUsd: 0, expected: "released" },
      { status: "superseded", costUsd: 1, expected: "consumed" },
    ] as const;
    for (const terminal of terminalCases) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      const now = new Date("2026-08-14T12:00:02.000Z");
      try {
        const connection = database.connection;
        const fixture = seedReceiptBackedLiveResearchRun(connection);
        const ledger = createAiJobLedger(connection, {
          clock: () => now,
          token: () => `terminal-final-${terminal.status}`,
          kindAvailable: (kind) => kind === "resource_research",
          research: createResearchStore(connection, { clock: () => now }),
        });
        const claim = ledger.claimNext(
          "resource_research", `terminal-${terminal.status}`,
          { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
          undefined, [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (claim === undefined || claim.id !== fixture.finalJobId) {
          throw new Error(`missing terminal claim for ${terminal.status}`);
        }
        ledger.bindAttemptProvider(claim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        const claimedCheckpoint = {
          progress: { ...claim.progress, stage: "claimed" },
          checkpoint: { version: 1 as const, nextStep: 0, stage: "claimed" as const },
          usage: {
            steps: 0, inputTokens: 0, outputTokens: 0,
            costUsd: terminal.costUsd, wallTimeMs: 0,
          },
        };
        if (terminal.status === "succeeded" || terminal.status === "partial") {
          const digests = {
            corpusDigest: "1".repeat(64), parentDigest: null,
            providerInputDigest: "2".repeat(64), quoteDigest: "3".repeat(64),
          } as const;
          ledger.checkpoint(claim, {
            progress: { ...claim.progress, stage: "claimed" },
            checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
            usage: {
              steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
            },
          });
          ledger.checkpoint(claim, {
            progress: { completed: 0, total: 1, stage: "provider_ready" },
            checkpoint: {
              version: 1, nextStep: 1, stage: "provider_ready", ...digests,
            },
            usage: {
              steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
            },
          });
          ledger.completeResearch(claim, {
            progress: { completed: 1, total: 1, stage: "terminal_publication" },
            checkpoint: {
              version: 1, nextStep: 2, stage: "terminal_publication", ...digests,
              providerOutputDigest: "4".repeat(64),
            },
            usage: {
              steps: 1, inputTokens: 0, outputTokens: 0,
              costUsd: terminal.costUsd, wallTimeMs: 1,
            },
          }, {
            version: 1,
            status: terminal.status,
            reason: terminal.status === "partial" ? "budget_exhausted" : null,
            corpusFingerprint: fixture.draft.corpusFingerprint,
            inputFingerprint: fixture.draft.approvalFingerprint,
            coverage: {
              discovered: 1, captured: 1, eligible: 1,
              used: 0, missing: 0, failed: 0,
            },
            usedSourceIds: [],
            provenance: {
              provider: "openai", model: "gpt-5", promptVersion: "v1",
              pricingVersion: "pricing-v1", requestId: null,
              generatedAt: now.toISOString(),
              usage: {
                steps: 1, inputTokens: 0, outputTokens: 0,
                costUsd: terminal.costUsd, wallTimeMs: 1,
              },
            },
            dossier: {
              executiveSummary: `${terminal.status} summary`,
              valueForUser: `${terminal.status} value`, capabilities: [],
              limitations: [], risks: [], unknowns: [], nextSteps: [],
            },
            claims: [],
          });
        } else if (terminal.status === "failed") {
          ledger.checkpoint(claim, claimedCheckpoint);
          ledger.fail(claim, {
            ...claimedCheckpoint,
            usage: { ...claimedCheckpoint.usage, costUsd: 0 },
          }, { code: "JOB_BUDGET_EXHAUSTED" });
        } else if (terminal.status === "cancelled") {
          ledger.cancel("resource_research", claim.id, "user");
          ledger.checkpoint(claim, claimedCheckpoint);
        } else {
          ledger.checkpoint(claim, claimedCheckpoint);
          const sequence = connection.prepare(`
            SELECT event_sequence + 1 FROM ai_jobs WHERE id = ?
          `).pluck().get(fixture.finalJobId);
          connection.prepare(`
            INSERT INTO ai_job_events (
              job_id, sequence_no, event_type, from_status, to_status,
              attempt_id, lease_token, occurred_at
            ) VALUES (?, ?, 'superseded', 'running', 'superseded', ?, ?, ?)
          `).run(
            fixture.finalJobId, sequence, claim.attemptId, claim.leaseToken,
            now.toISOString(),
          );
        }
        expect(connection.prepare(`
          SELECT status, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE final_job_id = ?
        `).get(fixture.finalJobId), terminal.status).toEqual({
          status: terminal.expected,
          consumed_usd: terminal.costUsd,
          terminal_at: now.toISOString(),
        });
      } finally {
        database.close();
      }
    }

    for (const retry of ["retry_scheduled", "recovered"] as const) {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      let now = new Date("2026-08-14T12:00:02.000Z");
      try {
        const connection = database.connection;
        const fixture = seedReceiptBackedLiveResearchRun(connection);
        const ledger = createAiJobLedger(connection, {
          clock: () => now,
          token: () => `retry-final-token-${retry}`,
          kindAvailable: (kind) => kind === "resource_research",
          research: createResearchStore(connection, { clock: () => now }),
        });
        const claim = ledger.claimNext(
          "resource_research", `retry-${retry}`,
          { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
          undefined, [{ id: "research_workflow:c81:v1", version: 1 }],
        );
        if (claim === undefined || claim.id !== fixture.finalJobId) {
          throw new Error(`missing retry claim for ${retry}`);
        }
        ledger.bindAttemptProvider(claim, {
          provider: "openai", model: "gpt-5", promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
        if (retry === "retry_scheduled") {
          ledger.fail(claim, {
            progress: { ...claim.progress, stage: "claimed" },
            checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
            usage: {
              steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
            },
          }, {
            code: "JOB_INPUT_UNAVAILABLE",
            retryAt: "2026-08-14T12:00:03.000Z",
          });
        } else {
          now = new Date(claim.leaseExpiresAt);
          expect(ledger.recoverInterrupted([
            { id: "research_workflow:c81:v1", version: 1 },
          ])).toBe(1);
        }
        expect(connection.prepare(`
          SELECT status, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE final_job_id = ?
        `).get(fixture.finalJobId), retry).toEqual({
          status: "active", consumed_usd: 0, terminal_at: null,
        });
      } finally {
        database.close();
      }
    }
  });

  it("closes directed handoff assembly while preserving lifecycle successors", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-live-handoff-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tabhub.sqlite");
    createSchema24(databasePath);
    const seed = new Database(databasePath);
    try {
      seedCapturedResearchSource(seed, "research_acquisition:c90:v1");
    } finally {
      seed.close();
    }
    const database = openDatabase(databasePath);
    try {
      const connection = database.connection;
      const at = "2026-08-14T14:00:00.000Z";
      const coordinatorIds = connection.prepare(`
        SELECT
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'resource' AND resource_id = 9001
             AND is_active = 1) AS resource_generation_id,
          (SELECT id FROM research_history_epochs
           WHERE resource_id = 9001 AND is_active = 1) AS history_epoch_id,
          (SELECT id FROM privacy_subject_generations
           WHERE subject_kind = 'research_run' AND research_run_id = 9001
             AND is_active = 1) AS run_generation_id
      `).get() as {
        resource_generation_id: number;
        history_epoch_id: number;
        run_generation_id: number;
      };
      connection.prepare(`
        INSERT INTO live_acquisition_consents (
          id, resource_generation_id, history_epoch_id, coordinator_job_id,
          coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
          origin_set_digest, limits_json, status, created_at, expires_at
        ) VALUES (1, ?, ?, 9001, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).run(
        coordinatorIds.resource_generation_id,
        coordinatorIds.history_epoch_id,
        coordinatorIds.run_generation_id,
        "0".repeat(64),
        "1".repeat(64),
        frozenConsentLimitsJson,
        at,
        "2026-08-14T14:05:00.000Z",
      );
      connection.exec(`
        INSERT INTO live_acquisition_consent_payloads (
          consent_id, approved_origins_json
        ) VALUES (1, '["https://example.com"]');
        INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
        VALUES (1, zeroblob(32));
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class,
          assigned_by, assignment_method, source_fingerprint, created_at
        ) VALUES (
          9990, 9001, 'assigned', 9001, 'user_manual', 'user', 'manual',
          'handoff-capture-assignment', '${at}'
        );
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (9001, 9990);
        INSERT INTO resource_resolution_events (
          id, logical_page_id, state, reason, resource_id, assignment_id,
          candidate_resource_ids_json, source_fingerprint, research_eligible,
          created_at
        ) VALUES (
          9991, 9001, 'matched', 'user_manual', 9001, 9990, '[9001]',
          'handoff-capture-resolution', 1, '${at}'
        );
        INSERT INTO resource_resolution_heads (
          logical_page_id, resolution_event_id
        ) VALUES (9001, 9991);
        INSERT INTO live_acquisition_actions (
          id, consent_id, coordinator_run_generation_id,
          resource_generation_id, history_epoch_id, runtime_epoch,
          action_kind, depth, discovered_from_action_id,
          canonical_fetch_url_fingerprint, canonical_origin_digest,
          action_key_digest, state, created_at
        ) VALUES (
          1, 1, ${coordinatorIds.run_generation_id},
          ${coordinatorIds.resource_generation_id},
          ${coordinatorIds.history_epoch_id}, 1,
          'page', 0, NULL, '${"2".repeat(64)}', NULL,
          '${"3".repeat(64)}', 'planned', '${at}'
        );
        INSERT INTO live_acquisition_url_payloads (
          action_id, exact_url, keyed_url_digest
        ) VALUES (1, 'https://example.com/source', '${"4".repeat(64)}');
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (1, 1, 'planned', 'planned', NULL, '{}', '${at}');
        INSERT INTO live_acquisition_page_reservations (
          consent_id, action_id, reservation_sequence, reserved_at
        ) VALUES (1, 1, 1, '${at}');
        INSERT INTO live_acquisition_dns_payloads (
          action_id, answers_json, selected_ipv4, resolved_at
        ) VALUES (1, '["203.0.113.1"]', '203.0.113.1', '${at}');
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (1, 3, 'resolution_started', 'resolved', NULL, '{}', '${at}');
        INSERT INTO live_acquisition_action_authorizations (
          action_id, runtime_epoch, selected_ipv4_digest,
          authorization_digest, authorized_at, expires_at
        ) VALUES (
          1, 1, '${"5".repeat(64)}', '${"6".repeat(64)}', '${at}',
          '2026-08-14T14:05:00.000Z'
        );
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (1, 4, 'resolved', 'authorized', NULL, '{}', '${at}');
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (1, 5, 'authorized', 'started', NULL, '{}', '${at}');
        INSERT INTO live_acquisition_body_payloads (
          action_id, raw_body, extracted_text, body_digest,
          response_metadata_json, acquired_at
        ) VALUES (1, x'01', 'handoff capture', '${"5".repeat(64)}', '{}', '${at}');
        INSERT INTO live_acquisition_capture_manifests (
          id, consent_id, logical_page_generation_id, action_id,
          reservation_id, depth, capture_sequence,
          url_digest, content_digest, manifest_json, created_at
        ) VALUES (
          1, 1, (SELECT id FROM privacy_subject_generations
            WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
              AND is_active = 1),
          1, 1, 0, 1, '${"4".repeat(64)}', '${"5".repeat(64)}', '{}', '${at}'
        );
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) VALUES (
          1, 6, 'started', 'completed', 'FETCH_COMPLETED', '{}', '${at}'
        );
      `);
      connection.prepare(
        `INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9001, 1, 'queued', 'queued', 'handoff-coordinator-queued', ?)`,
      ).run(at);
      connection.exec("SAVEPOINT c90_provider_bind");
      try {
        const coordinatorLedger = createAiJobLedger(connection, {
          clock: () => new Date(at),
          token: () => "c90-provider-bind-token-0001",
          kindAvailable: (kind) => kind === "resource_research",
        });
        const coordinatorClaim = coordinatorLedger.claimNext(
          "resource_research",
          "migration-c90-bind",
          { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
          undefined,
          [{ id: "research_acquisition:c90:v1", version: 1 }],
        );
        if (coordinatorClaim === undefined) throw new Error("missing C90 claim");
        const coordinatorUsageBefore = {
          job: connection.prepare(`
            SELECT status, event_sequence, checkpoint_json, spent_tokens,
              spent_cost_usd, spent_wall_time_ms
            FROM ai_jobs WHERE id = 9001
          `).get(),
          attempt: connection.prepare(`
            SELECT input_tokens, output_tokens, cost_usd
            FROM ai_job_attempts WHERE id = ?
          `).get(coordinatorClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9001
          `).pluck().get(),
        };
        expect(() => coordinatorLedger.checkpoint(coordinatorClaim, {
          progress: { ...coordinatorClaim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
            wallTimeMs: 0,
          },
        })).toThrow(/coordinator provider usage must be zero/i);
        expect({
          job: connection.prepare(`
            SELECT status, event_sequence, checkpoint_json, spent_tokens,
              spent_cost_usd, spent_wall_time_ms
            FROM ai_jobs WHERE id = 9001
          `).get(),
          attempt: connection.prepare(`
            SELECT input_tokens, output_tokens, cost_usd
            FROM ai_job_attempts WHERE id = ?
          `).get(coordinatorClaim.attemptId),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9001
          `).pluck().get(),
        }).toEqual(coordinatorUsageBefore);
        expect(() => connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
            pricing_version = 'pricing-v1', provider_bound_at = ?
          WHERE id = ?
        `).run(at, coordinatorClaim.attemptId)).toThrow(
          /coordinator attempts cannot bind a provider/i,
        );
        expect(connection.prepare(`
          SELECT provider FROM ai_job_attempts WHERE id = ?
        `).pluck().get(coordinatorClaim.attemptId)).toBeNull();
        expect(() => coordinatorLedger.bindAttemptProvider(coordinatorClaim, {
          provider: "openai",
          model: "gpt-5",
          promptVersion: "v1",
          pricingVersion: "pricing-v1",
        })).toThrow(/coordinator attempts cannot bind a provider/i);
        expect(connection.prepare(`
          SELECT provider FROM ai_job_attempts WHERE id = ?
        `).pluck().get(coordinatorClaim.attemptId)).toBeNull();
      } finally {
        connection.exec("ROLLBACK TO c90_provider_bind");
        connection.exec("RELEASE c90_provider_bind");
      }
      connection.prepare(
        `INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (9001, 2, 'superseded', 'queued', 'superseded', ?)`,
      ).run(at);
      expect(
        connection.prepare(
          `SELECT group_concat(event_type, ',') FROM ai_job_events
           WHERE job_id = 9001 ORDER BY sequence_no`,
        ).pluck().get(),
      ).toBe("submitted,superseded");
      expect(
        connection.prepare(
          `SELECT group_concat(event_type, ',') FROM research_run_events
           WHERE run_id = 9001 ORDER BY sequence_no`,
        ).pluck().get(),
      ).toBe("queued,superseded");
      connection.prepare(
        `INSERT INTO ai_jobs (
          id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint,
          input_fingerprint, workflow_id, workflow_version, scheduling_priority,
          available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          progress_total, created_at, updated_at
        ) VALUES (
          9002, 'resource_research', 'resource', 9001, 'resource:9001',
          'user', 'manual', 'migration-final-job', ?, ?,
          'research_workflow:c81:v1', 1, 0, ?, 10, 1000, 1, 60000, 1, ?, ?
        )`,
      ).run("1".repeat(64), "2".repeat(64), at, at, at);
      connection.prepare(
        `INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9002, 9002, 9001, 'resource:9001', ?, '{}', ?, ?, ?,
          'research_workflow:c81:v1', 1, 10, 1000, 1, 60000, ?, ?
        )`,
      ).run(
        "3".repeat(64),
        "2".repeat(64),
        "4".repeat(64),
        "1".repeat(64),
        at,
        coordinatorIds.history_epoch_id,
      );
      const generations = connection
        .prepare(
          `SELECT
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'research_run' AND research_run_id = 9001
               AND is_active = 1) AS coordinator_generation_id,
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'logical_page' AND logical_page_id = 9001
               AND is_active = 1) AS page_generation_id,
            (SELECT id FROM privacy_subject_generations
             WHERE subject_kind = 'research_run' AND research_run_id = 9002
               AND is_active = 1) AS final_generation_id`,
        )
        .get() as {
          coordinator_generation_id: number;
          page_generation_id: number;
          final_generation_id: number;
        };
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_workflow_outcomes (
            id, coordinator_job_id, coordinator_run_generation_id,
            outcome, outcome_code, safe_details_json, created_at
          ) VALUES (99, 9002, ?, 'blocked', 'WORKFLOW_BLOCKED', '{}', ?)`,
        ).run(generations.final_generation_id, at),
      ).toThrow(/outcome ownership/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_handoffs (
            id, coordinator_run_generation_id, final_run_id, status, created_at
          ) VALUES (99, ?, 9002, 'assembling', ?)`,
        ).run(generations.final_generation_id, at),
      ).toThrow(/directed handoff header/i);
      connection.prepare(
        `INSERT INTO live_acquisition_handoffs (
          id, coordinator_run_generation_id, final_run_id, status, created_at
        ) VALUES (1, ?, 9002, 'assembling', ?)`,
      ).run(generations.coordinator_generation_id, at);
      const insertSourceReceiptWithManifest = connection.prepare(
        `INSERT INTO live_acquisition_source_receipts (
          id, handoff_id, final_run_id, ordinal, logical_page_id,
          logical_page_generation_id, capture_manifest_id, depth,
          capture_sequence, inclusion_state, included_order,
          content_revision, content_digest, extracted_at, manifest_json,
          receipt_digest, created_at
        ) VALUES (
          1, 1, 9002, 1, 9001, ?, 1, 0, 1, 'included', 1, 1, ?, ?, ?, ?, ?
        )`,
      );
      for (const unsafeJson of unsafeRetainedJsonPayloads) {
        expect(() => insertSourceReceiptWithManifest.run(
          generations.page_generation_id,
          "5".repeat(64),
          at,
          unsafeJson,
          "6".repeat(64),
          at,
        )).toThrow(/source receipt manifest is not digest-only/i);
      }
      connection.prepare(
        `INSERT INTO live_acquisition_source_receipts (
          id, handoff_id, final_run_id, ordinal, logical_page_id,
          logical_page_generation_id, capture_manifest_id, depth,
          capture_sequence, inclusion_state, included_order,
          content_revision, content_digest, extracted_at, manifest_json,
          receipt_digest, created_at
        ) VALUES (
          1, 1, 9002, 1, 9001, ?, 1, 0, 1, 'included', 1, 1, ?, ?, '{}', ?, ?
        )`,
      ).run(
        generations.page_generation_id,
        "5".repeat(64),
        at,
        "6".repeat(64),
        at,
      );

      connection.exec("SAVEPOINT orphan_handoff");
      connection.prepare(
        `INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9002, 1, 'queued', 'queued', 'handoff-orphan-queued', ?)`,
      ).run(at);
      const seedRunningImplicitResearch = (maxCostUsd: number) => {
        connection.exec(`
          INSERT INTO ai_jobs (
            id, kind, subject_type, logical_page_id, subject_key, requested_by,
            request_method, idempotency_key, submission_fingerprint,
            input_fingerprint, workflow_id, workflow_version, scheduling_priority,
            progress_total, available_at, max_steps, max_tokens, max_cost_usd,
            max_wall_time_ms, created_at, updated_at
          ) VALUES (
            9099, 'resource_research', 'page', 9001, 'page:9001',
            'system', 'scheduled', 'implicit-cap-fixture', '${"1".repeat(64)}',
            '${"2".repeat(64)}', 'research_workflow:c81:v1', 1, 100, 1,
            '${at}', 10, 1000, ${maxCostUsd}, 60000, '${at}', '${at}'
          );
          INSERT INTO research_runs (
            id, job_id, target_logical_page_id, target_key, question_digest, scope_json,
            approval_fingerprint, corpus_fingerprint, submission_fingerprint,
            workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
            max_wall_time_ms, created_at
          ) VALUES (
            9099, 9099, 9001, 'page:9001', '${"3".repeat(64)}', '{}',
            '${"2".repeat(64)}', '${"4".repeat(64)}', '${"1".repeat(64)}',
            'research_workflow:c81:v1', 1, 10, 1000, ${maxCostUsd}, 60000,
            '${at}'
          );
          INSERT INTO research_run_events (
            run_id, sequence_no, event_type, status, idempotency_key, occurred_at
          ) VALUES (9099, 1, 'queued', 'queued', 'implicit-cap-queued', '${at}');
        `);
        const capLedger = createAiJobLedger(connection, {
          clock: () => new Date(at),
          token: () => "implicit-cap-lease-token-0001",
          kindAvailable: (kind) => kind === "resource_research",
          research: createResearchStore(connection, { clock: () => new Date(at) }),
        });
        expect(capLedger.claimNext(
          "resource_research",
          "implicit-cap-worker",
          { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
          undefined,
          [{ id: "research_workflow:c81:v1", version: 1 }],
        )?.id).toBe(9099);
      };
      connection.exec("SAVEPOINT exact_reservation_cap");
      seedRunningImplicitResearch(1);
      connection.prepare(`
        INSERT INTO live_acquisition_provider_reservations (
          id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
        ) VALUES (1, 1, 9002, '2026-08-14', 1, 'active', ?)
      `).run(at);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_provider_reservations WHERE id = 1
      `).pluck().get()).toBe(1);
      connection.exec("ROLLBACK TO exact_reservation_cap");
      connection.exec("RELEASE exact_reservation_cap");
      connection.exec("SAVEPOINT overbooked_reservation_cap");
      seedRunningImplicitResearch(1.000001);
      let overbookedReservationError: unknown;
      try {
        connection.prepare(`
          INSERT INTO live_acquisition_provider_reservations (
            id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
          ) VALUES (1, 1, 9002, '2026-08-14', 1, 'active', ?)
        `).run(at);
      } catch (error) {
        overbookedReservationError = error;
      } finally {
        connection.exec("ROLLBACK TO overbooked_reservation_cap");
        connection.exec("RELEASE overbooked_reservation_cap");
      }
      expect(() => {
        if (overbookedReservationError !== undefined) throw overbookedReservationError;
      }).toThrow(/provider reservation ownership/i);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_provider_reservations WHERE id = 1
      `).pluck().get()).toBe(0);
      for (const unsafeUtcDate of [
        "https://secret.example/private",
        "authorization: Bearer secret-token",
        "2026-8-14",
      ]) {
        expect(() => connection.prepare(
          `INSERT INTO live_acquisition_provider_reservations (
            id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
          ) VALUES (1, 1, 9002, ?, 1, 'active', ?)`,
        ).run(unsafeUtcDate, at)).toThrow(/CHECK constraint failed|provider reservation ownership/i);
      }
      expect(() => connection.prepare(
        `INSERT INTO live_acquisition_provider_reservations (
          id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
        ) VALUES (1, 1, 9002, '2026-08-14', 1.01, 'active', ?)` ,
      ).run(at)).toThrow(/provider reservation ownership/i);
      connection.prepare(
        `INSERT INTO live_acquisition_provider_reservations (
          id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
        ) VALUES (1, 1, 9002, '2026-08-14', 1, 'active', ?)`,
      ).run(at);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_handoff_receipts (
            handoff_id, receipt_digest, completed_at
          ) VALUES (1, ?, ?)`,
        ).run("7".repeat(64), at),
      ).toThrow(/assembly is incomplete/i);
      connection.exec("ROLLBACK TO orphan_handoff");
      connection.exec("RELEASE orphan_handoff");

      expect(() =>
        connection.prepare(
          `INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, content_revision,
            content_digest, extracted_at, source_kind, acquisition_method,
            handoff_source_receipt_id, access_class_snapshot, eligibility,
            inclusion_state, included_order, created_at
          ) VALUES (
            9100, 9001, 2, 9001, 1, ?, ?, 'live_acquisition',
            'safe_public_http_v1', 1, 'public', 'eligible', 'included', 2, ?
          )`,
        ).run("5".repeat(64), at, at),
      ).toThrow(/does not match its open handoff receipt/i);

      connection.prepare(
        `INSERT INTO research_sources (
          id, run_id, ordinal, logical_page_id, content_revision,
          content_digest, extracted_at, source_kind, acquisition_method,
          handoff_source_receipt_id, access_class_snapshot, eligibility,
          inclusion_state, included_order, created_at
        ) VALUES (
          9002, 9002, 1, 9001, 1, ?, ?, 'live_acquisition',
          'safe_public_http_v1', 1, 'public', 'eligible', 'included', 1, ?
        )`,
      ).run("5".repeat(64), at, at);
      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9002, 9002, 1, 'accepted', 'valid', NULL,
          'live-source-accepted', ?)`,
      ).run(at);
      connection.prepare(
        `INSERT INTO research_source_payloads (
          source_id, url_snapshot, title_snapshot, evidence_material,
          chunk_manifest_json, payload_digest
        ) VALUES (9002, 'https://example.com/acquired', 'Acquired',
          'acquired evidence', '{}', ?)`,
      ).run("8".repeat(64));
      connection.prepare(
        `INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, idempotency_key, occurred_at
        ) VALUES (9002, 1, 'queued', 'queued', 'handoff-final-queued', ?)`,
      ).run(at);
      connection.prepare(
        `INSERT INTO live_acquisition_provider_reservations (
          id, handoff_id, final_job_id, utc_date, reserved_usd, status, created_at
        ) VALUES (1, 1, 9002, '2026-08-14', 1, 'active', ?)`,
      ).run(at);
      expect(
        connection.prepare(
          `SELECT group_concat(event_type, ',') FROM ai_job_events
           WHERE job_id = 9002 ORDER BY sequence_no`,
        ).pluck().get(),
      ).toBe("submitted");

      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9004, 'https://example.com/captured-final',
          'https://example.com/captured-final',
          'https://example.com/captured-final', '${at}', '${at}'
        );
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, status, importance, is_open,
          first_seen_at, last_seen_at, logical_page_id
        ) VALUES (
          9004, 'https://example.com/captured-final',
          'https://example.com/captured-final', 'Captured final', 'chrome',
          'inbox', 0, 1, '${at}', '${at}', 9004
        );
        INSERT INTO contents (tab_id, text, extracted_at, content_revision)
        VALUES (9004, 'captured final evidence', '${at}', 1);
      `);
      const insertCapturedFinalSource = connection.prepare(
        `INSERT INTO research_sources (
          id, run_id, ordinal, logical_page_id, tab_id,
          captured_tab_id_snapshot, content_revision, content_digest,
          extracted_at, acquisition_method, access_class_snapshot,
          eligibility, inclusion_state, included_order, created_at
        ) VALUES (
          9004, 9002, 2, 9004, 9004, 9004, 1, ?, ?, 'captured',
          'public', 'eligible', 'included', 2, ?
        )`,
      );
      const incompleteCapturedSources = [
        {
          name: "missing",
          sql: `INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, acquisition_method,
            access_class_snapshot, eligibility, inclusion_state, created_at
          ) VALUES (
            9090, 9002, 2, 9004, 'inventory', 'public',
            'not_captured', 'missing', ?
          )`,
          args: [at],
        },
        {
          name: "failed",
          sql: `INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, acquisition_method,
            access_class_snapshot, eligibility, inclusion_state, failure_code,
            created_at
          ) VALUES (
            9090, 9002, 2, 9004, 'inventory', 'public',
            'not_captured', 'failed', 'CAPTURE_FAILED', ?
          )`,
          args: [at],
        },
        {
          name: "excluded",
          sql: `INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, tab_id,
            captured_tab_id_snapshot, content_revision, content_digest,
            extracted_at, acquisition_method, access_class_snapshot,
            eligibility, inclusion_state, exclusion_reason, created_at
          ) VALUES (
            9090, 9002, 2, 9004, 9004, 9004, 1, ?, ?, 'captured',
            'public', 'privacy_excluded', 'excluded', 'privacy', ?
          )`,
          args: ["f".repeat(64), at, at],
        },
      ] as const;
      for (const incomplete of incompleteCapturedSources) {
        connection.exec(`SAVEPOINT incomplete_${incomplete.name}`);
        connection.prepare(incomplete.sql).run(...incomplete.args);
        expect(() => connection.prepare(
          `INSERT INTO live_acquisition_handoff_receipts (
            handoff_id, receipt_digest, completed_at
          ) VALUES (1, ?, ?)`,
        ).run("d".repeat(64), at)).toThrow(/assembly is incomplete/i);
        connection.exec(`ROLLBACK TO incomplete_${incomplete.name}`);
        connection.exec(`RELEASE incomplete_${incomplete.name}`);
      }
      connection.exec("SAVEPOINT incomplete_captured_source");
      insertCapturedFinalSource.run("c".repeat(64), at, at);
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_handoff_receipts (
            handoff_id, receipt_digest, completed_at
          ) VALUES (1, ?, ?)`,
        ).run("d".repeat(64), at),
      ).toThrow(/assembly is incomplete/i);
      connection.exec("ROLLBACK TO incomplete_captured_source");
      connection.exec("RELEASE incomplete_captured_source");
      insertCapturedFinalSource.run("c".repeat(64), at, at);
      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9010, 9004, 1, 'accepted', 'valid', NULL,
          'captured-final-accepted', ?)`,
      ).run(at);
      connection.prepare(
        `INSERT INTO research_source_payloads (
          source_id, url_snapshot, title_snapshot, evidence_material,
          chunk_manifest_json, payload_digest
        ) VALUES (9004, 'https://example.com/captured-final', 'Captured final',
          'captured final evidence', '{}', ?)`,
      ).run("e".repeat(64));

      connection.exec("SAVEPOINT preterminal_captured_successor");
      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9011, 9004, 2, 'invalidated', 'invalid',
          'premature captured successor', 'premature-captured-successor', ?)`,
      ).run("2026-08-14T14:00:00.001Z");
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_handoff_receipts (
            handoff_id, receipt_digest, completed_at
          ) VALUES (1, ?, ?)`,
        ).run("d".repeat(64), at),
      ).toThrow(/assembly is incomplete/i);
      connection.exec("ROLLBACK TO preterminal_captured_successor");
      connection.exec("RELEASE preterminal_captured_successor");

      connection.exec("SAVEPOINT preterminal_successor");
      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9011, 9002, 2, 'invalidated', 'invalid',
          'premature successor', 'premature-live-successor', ?)`,
      ).run("2026-08-14T14:00:00.001Z");
      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_handoff_receipts (
            handoff_id, receipt_digest, completed_at
          ) VALUES (1, ?, ?)`,
        ).run("d".repeat(64), at),
      ).toThrow(/assembly is incomplete/i);
      connection.exec("ROLLBACK TO preterminal_successor");
      connection.exec("RELEASE preterminal_successor");

      connection.prepare(
        `INSERT INTO live_acquisition_handoff_receipts (
          handoff_id, receipt_digest, completed_at
        ) VALUES (1, ?, ?)`,
      ).run("7".repeat(64), at);
      expect(
        connection.prepare(
          "SELECT status, completed_at FROM live_acquisition_handoffs WHERE id = 1",
        ).get(),
      ).toEqual({ status: "completed", completed_at: at });
      const reservationBeforeUnauthorizedMutation = connection.prepare(`
        SELECT utc_date, consumed_usd, status, terminal_at
        FROM live_acquisition_provider_reservations WHERE id = 1
      `).get();
      connection.exec("SAVEPOINT unauthorized_reservation_consumption");
      let unauthorizedConsumptionError: unknown;
      try {
        connection.prepare(`
          UPDATE live_acquisition_provider_reservations
          SET consumed_usd = consumed_usd + 0.1 WHERE id = 1
        `).run();
      } catch (error) {
        unauthorizedConsumptionError = error;
      } finally {
        connection.exec("ROLLBACK TO unauthorized_reservation_consumption");
        connection.exec("RELEASE unauthorized_reservation_consumption");
      }
      expect(() => {
        if (unauthorizedConsumptionError !== undefined) throw unauthorizedConsumptionError;
      }).toThrow(/provider reservation update/i);
      connection.exec("SAVEPOINT unauthorized_reservation_release");
      let unauthorizedReleaseError: unknown;
      try {
        connection.prepare(`
          UPDATE live_acquisition_provider_reservations
          SET status = 'released', terminal_at = ? WHERE id = 1
        `).run(at);
      } catch (error) {
        unauthorizedReleaseError = error;
      } finally {
        connection.exec("ROLLBACK TO unauthorized_reservation_release");
        connection.exec("RELEASE unauthorized_reservation_release");
      }
      expect(() => {
        if (unauthorizedReleaseError !== undefined) throw unauthorizedReleaseError;
      }).toThrow(/provider reservation update/i);
      expect(connection.prepare(`
        SELECT utc_date, consumed_usd, status, terminal_at
        FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual(reservationBeforeUnauthorizedMutation);
      let ledgerNow = new Date("2026-08-15T00:00:00.000Z");
      let ledgerToken = 0;
      const ledger = createAiJobLedger(connection, {
        clock: () => ledgerNow,
        token: () => `live-provider-lease-${String(++ledgerToken).padStart(4, "0")}`,
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => ledgerNow }),
      });
      const firstProviderClaim = ledger.claimNext(
        "resource_research",
        "migration-test",
        { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      );
      expect(firstProviderClaim?.id).toBe(9002);
      if (firstProviderClaim === undefined) throw new Error("missing final provider claim");
      expect(connection.prepare(`
        SELECT utc_date FROM live_acquisition_provider_reservations WHERE id = 1
      `).pluck().get()).toBe("2026-08-15");
      connection.exec("SAVEPOINT missing_provider_adoption");
      let missingAdoptionError: unknown;
      try {
        connection.prepare(`
          UPDATE ai_job_attempts
          SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
            pricing_version = 'pricing-v1', provider_bound_at = ?
          WHERE id = ?
        `).run(ledgerNow.toISOString(), firstProviderClaim.attemptId);
      } catch (error) {
        missingAdoptionError = error;
      } finally {
        connection.exec("ROLLBACK TO missing_provider_adoption");
        connection.exec("RELEASE missing_provider_adoption");
      }
      expect(() => {
        if (missingAdoptionError !== undefined) throw missingAdoptionError;
      }).toThrow(/provider reservation adoption/i);
      connection.exec("SAVEPOINT stale_provider_adoption");
      try {
        connection.prepare(`
          INSERT INTO live_acquisition_provider_reservation_adoptions (
            attempt_id, reservation_id, final_job_id, utc_date, adopted_at
          ) VALUES (?, 1, 9002, '2026-08-15', ?)
        `).run(firstProviderClaim.attemptId, ledgerNow.toISOString());
        const validationEventsBefore = connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
        `).pluck().get() as number;
        ledger.checkpoint(firstProviderClaim, {
          progress: { ...firstProviderClaim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            wallTimeMs: 1,
          },
        });
        expect(connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
        `).pluck().get()).toBe(validationEventsBefore + 1);
        const beforePrebindUsage = {
          job: connection.prepare(`
            SELECT event_sequence, checkpoint_json, spent_tokens, spent_cost_usd
            FROM ai_jobs WHERE id = 9002
          `).get(),
          attempt: connection.prepare(`
            SELECT provider, input_tokens, output_tokens, cost_usd
            FROM ai_job_attempts WHERE id = ?
          `).get(firstProviderClaim.attemptId),
          reservation: connection.prepare(`
            SELECT utc_date, consumed_usd, status, terminal_at
            FROM live_acquisition_provider_reservations WHERE id = 1
          `).get(),
          events: connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
          `).pluck().get(),
        };
        for (const usage of [
          { inputTokens: 1, outputTokens: 0, costUsd: 0 },
          { inputTokens: 0, outputTokens: 1, costUsd: 0 },
          { inputTokens: 0, outputTokens: 0, costUsd: 0.01 },
        ]) {
          expect(() => ledger.checkpoint(firstProviderClaim, {
            progress: { ...firstProviderClaim.progress, stage: "claimed" },
            checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
            usage: {
              steps: 0,
              ...usage,
              wallTimeMs: 1,
            },
          })).toThrow(/usage requires active reservation adoption/i);
          expect({
            job: connection.prepare(`
              SELECT event_sequence, checkpoint_json, spent_tokens, spent_cost_usd
              FROM ai_jobs WHERE id = 9002
            `).get(),
            attempt: connection.prepare(`
              SELECT provider, input_tokens, output_tokens, cost_usd
              FROM ai_job_attempts WHERE id = ?
            `).get(firstProviderClaim.attemptId),
            reservation: connection.prepare(`
              SELECT utc_date, consumed_usd, status, terminal_at
              FROM live_acquisition_provider_reservations WHERE id = 1
            `).get(),
            events: connection.prepare(`
              SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
            `).pluck().get(),
          }).toEqual(beforePrebindUsage);
        }
        for (const mismatch of [
          { boundAt: "2026-08-15T00:00:00.001Z", exactAdoptionError: true },
          { boundAt: "2026-08-16T00:00:00.000Z", exactAdoptionError: false },
        ] as const) {
          const beforeMismatchedBind = connection.prepare(`
            SELECT * FROM ai_job_attempts WHERE id = ?
          `).get(firstProviderClaim.attemptId);
          connection.exec("SAVEPOINT mismatched_provider_bind_time");
          let mismatchedBindError: unknown;
          try {
            connection.prepare(`
              UPDATE ai_job_attempts
              SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
                pricing_version = 'pricing-v1', provider_bound_at = ?
              WHERE id = ?
            `).run(mismatch.boundAt, firstProviderClaim.attemptId);
          } catch (error) {
            mismatchedBindError = error;
          } finally {
            connection.exec("ROLLBACK TO mismatched_provider_bind_time");
            connection.exec("RELEASE mismatched_provider_bind_time");
          }
          expect(mismatchedBindError).toBeDefined();
          if (mismatch.exactAdoptionError) {
            expect(() => {
              if (mismatchedBindError !== undefined) throw mismatchedBindError;
            }).toThrow(/adoption is not current/i);
          }
          expect(connection.prepare(`
            SELECT * FROM ai_job_attempts WHERE id = ?
          `).get(firstProviderClaim.attemptId)).toEqual(beforeMismatchedBind);
        }
        expect(connection.prepare(`
          SELECT provider FROM ai_job_attempts WHERE id = ?
        `).pluck().get(firstProviderClaim.attemptId)).toBeNull();
      } finally {
        connection.exec("ROLLBACK TO stale_provider_adoption");
        connection.exec("RELEASE stale_provider_adoption");
      }
      const eventsBeforeBind = connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
      `).pluck().get();
      ledger.bindAttemptProvider(firstProviderClaim, {
        provider: "openai",
        model: "gpt-5",
        promptVersion: "v1",
        pricingVersion: "pricing-v1",
      });
      ledger.bindAttemptProvider(firstProviderClaim, {
        provider: "openai",
        model: "gpt-5",
        promptVersion: "v1",
        pricingVersion: "pricing-v1",
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
      `).pluck().get()).toBe(eventsBeforeBind);
      ledger.checkpoint(firstProviderClaim, {
        progress: { ...firstProviderClaim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.4,
          wallTimeMs: 100,
        },
      });
      expect(connection.prepare(`
        SELECT
          (SELECT cost_usd FROM ai_job_attempts WHERE id = ?) AS actual_cost_usd,
          (SELECT consumed_usd FROM live_acquisition_provider_reservations
           WHERE id = 1) AS consumed_usd
      `).get(firstProviderClaim.attemptId)).toEqual({
        actual_cost_usd: 0.4,
        consumed_usd: 0.4,
      });
      ledger.checkpoint(firstProviderClaim, {
        progress: { ...firstProviderClaim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 2,
          outputTokens: 1,
          costUsd: 0.1,
          wallTimeMs: 10,
        },
      });
      expect(connection.prepare(`
        SELECT
          (SELECT cost_usd FROM ai_job_attempts WHERE id = ?) AS actual_cost_usd,
          (SELECT consumed_usd FROM live_acquisition_provider_reservations
           WHERE id = 1) AS consumed_usd
      `).get(firstProviderClaim.attemptId)).toEqual({
        actual_cost_usd: 0.5,
        consumed_usd: 0.5,
      });
      const beforeReservationOverrun = {
        job: connection.prepare(`
          SELECT event_sequence, checkpoint_json, spent_tokens, spent_cost_usd,
            spent_wall_time_ms
          FROM ai_jobs WHERE id = 9002
        `).get(),
        attempt: connection.prepare(`
          SELECT input_tokens, output_tokens, cost_usd
          FROM ai_job_attempts WHERE id = ?
        `).get(firstProviderClaim.attemptId),
        reservation: connection.prepare(`
          SELECT utc_date, consumed_usd, status, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 1
        `).get(),
        events: connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
        `).pluck().get(),
      };
      expect(() => ledger.checkpoint(firstProviderClaim, {
        progress: { ...firstProviderClaim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.500001,
          wallTimeMs: 1,
        },
      })).toThrow(/usage requires active reservation adoption|budget exhausted/i);
      expect({
        job: connection.prepare(`
          SELECT event_sequence, checkpoint_json, spent_tokens, spent_cost_usd,
            spent_wall_time_ms
          FROM ai_jobs WHERE id = 9002
        `).get(),
        attempt: connection.prepare(`
          SELECT input_tokens, output_tokens, cost_usd
          FROM ai_job_attempts WHERE id = ?
        `).get(firstProviderClaim.attemptId),
        reservation: connection.prepare(`
          SELECT utc_date, consumed_usd, status, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 1
        `).get(),
        events: connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = 9002
        `).pluck().get(),
      }).toEqual(beforeReservationOverrun);
      connection.exec("SAVEPOINT terminal_consumed_reservation");
      try {
        ledger.checkpoint(firstProviderClaim, {
          progress: { ...firstProviderClaim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0,
            inputTokens: 2,
            outputTokens: 1,
            costUsd: 0.5,
            wallTimeMs: 10,
          },
        });
        ledger.fail(firstProviderClaim, {
          progress: { ...firstProviderClaim.progress, stage: "claimed" },
          checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
          usage: {
            steps: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            wallTimeMs: 0,
          },
        }, { code: "JOB_INPUT_UNAVAILABLE" });
        expect(connection.prepare(`
          SELECT status, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 1
        `).get()).toEqual({
          status: "consumed",
          consumed_usd: 1,
          terminal_at: "2026-08-15T00:00:00.000Z",
        });
      } finally {
        connection.exec("ROLLBACK TO terminal_consumed_reservation");
        connection.exec("RELEASE terminal_consumed_reservation");
      }
      expect(connection.prepare(`
        SELECT attempt_id, reservation_id, final_job_id, utc_date
        FROM live_acquisition_provider_reservation_adoptions
      `).get()).toEqual({
        attempt_id: firstProviderClaim.attemptId,
        reservation_id: 1,
        final_job_id: 9002,
        utc_date: "2026-08-15",
      });
      expect(() => connection.prepare(`
        UPDATE live_acquisition_provider_reservation_adoptions
        SET utc_date = '2026-08-15' WHERE attempt_id = ${firstProviderClaim.attemptId}
      `).run()).toThrow(/immutable/i);
      expect(() => connection.prepare(`
        DELETE FROM live_acquisition_provider_reservation_adoptions
        WHERE attempt_id = ${firstProviderClaim.attemptId}
      `).run()).toThrow(/exact purge authority/i);
      const retryAt = "2026-08-16T00:01:00.000Z";
      const retrySequence = connection.prepare(`
        SELECT event_sequence + 1 FROM ai_jobs WHERE id = 9002
      `).pluck().get();
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status,
          attempt_id, lease_token, available_at, occurred_at
        ) VALUES (
          9002, ?, 'recovered', 'running', 'queued', ?, ?, ?, ?
        )
      `).run(
        retrySequence,
        firstProviderClaim.attemptId,
        firstProviderClaim.leaseToken,
        retryAt,
        retryAt,
      );
      expect(connection.prepare(`
        SELECT status, consumed_usd, terminal_at
        FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({ status: "active", consumed_usd: 0.5, terminal_at: null });
      ledgerNow = new Date(retryAt);
      const retryProviderClaim = ledger.claimNext(
        "resource_research",
        "migration-test",
        { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      );
      if (retryProviderClaim === undefined) throw new Error("missing retry provider claim");
      expect(connection.prepare(`
        SELECT utc_date, consumed_usd
        FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({ utc_date: "2026-08-16", consumed_usd: 0.5 });
      ledger.bindAttemptProvider(retryProviderClaim, {
        provider: "openai",
        model: "gpt-5",
        promptVersion: "v1",
        pricingVersion: "pricing-v1",
      });
      expect(connection.prepare(`
        SELECT attempt_id, utc_date FROM live_acquisition_provider_reservation_adoptions
        WHERE reservation_id = 1 ORDER BY attempt_id
      `).all()).toEqual([
        { attempt_id: firstProviderClaim.attemptId, utc_date: "2026-08-15" },
        { attempt_id: retryProviderClaim.attemptId, utc_date: "2026-08-16" },
      ]);
      ledgerNow = new Date("2026-08-16T00:01:01.000Z");
      ledger.fail(retryProviderClaim, {
        progress: { ...retryProviderClaim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
      }, { code: "JOB_INPUT_UNAVAILABLE" });
      expect(connection.prepare(`
        SELECT status, consumed_usd, terminal_at
        FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({
        status: "released",
        consumed_usd: 0.5,
        terminal_at: "2026-08-16T00:01:01.000Z",
      });

      expect(() =>
        connection.prepare(
          `INSERT INTO live_acquisition_source_receipts (
            id, handoff_id, final_run_id, ordinal, logical_page_id,
            logical_page_generation_id, capture_manifest_id, depth,
            capture_sequence, inclusion_state, included_order,
            content_revision, content_digest, extracted_at, manifest_json,
            receipt_digest, created_at
          ) VALUES (2, 1, 9002, 2, 9001, ?, 1, 0, 1,
            'included', 2, 1, ?, ?, '{}', ?, ?)`,
        ).run(
          generations.page_generation_id,
          "9".repeat(64),
          at,
          "a".repeat(64),
          at,
        ),
      ).toThrow(/closed|invalid/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_source_payloads (
            source_id, url_snapshot, title_snapshot, evidence_material,
            chunk_manifest_json, payload_digest
          ) VALUES (9002, 'https://example.com/late', 'Late', 'late', '{}', ?)`,
        ).run("b".repeat(64)),
      ).toThrow(/closed/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_source_state_events (
            id, source_id, sequence_no, event_type, state, reason,
            idempotency_key, occurred_at
          ) VALUES (9003, 9002, 1, 'accepted', 'valid', NULL,
            'late-live-source-accepted', ?)`,
        ).run(at),
      ).toThrow(/closed/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_source_payloads (
            source_id, url_snapshot, title_snapshot, evidence_material,
            chunk_manifest_json, payload_digest
          ) VALUES (9004, 'https://example.com/captured-final', 'Late captured',
            'late captured payload', '{}', ?)` ,
        ).run("f".repeat(64)),
      ).toThrow(/closed/i);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_source_state_events (
            id, source_id, sequence_no, event_type, state, reason,
            idempotency_key, occurred_at
          ) VALUES (9012, 9004, 1, 'accepted', 'valid', NULL,
            'late-captured-source-accepted', ?)` ,
        ).run(at),
      ).toThrow(/closed/i);
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9005, 'https://example.com/late-captured',
          'https://example.com/late-captured',
          'https://example.com/late-captured', '${at}', '${at}'
        );
        INSERT INTO tabs (
          id, url, url_normalized, title, browser, status, importance, is_open,
          first_seen_at, last_seen_at, logical_page_id
        ) VALUES (
          9005, 'https://example.com/late-captured',
          'https://example.com/late-captured', 'Late captured', 'chrome',
          'inbox', 0, 1, '${at}', '${at}', 9005
        );
        INSERT INTO contents (tab_id, text, extracted_at, content_revision)
        VALUES (9005, 'late captured evidence', '${at}', 1);
      `);
      expect(() =>
        connection.prepare(
          `INSERT INTO research_sources (
            id, run_id, ordinal, logical_page_id, tab_id,
            captured_tab_id_snapshot, content_revision, content_digest,
            extracted_at, acquisition_method, access_class_snapshot,
            eligibility, inclusion_state, included_order, created_at
          ) VALUES (
            9005, 9002, 3, 9005, 9005, 9005, 1, ?, ?, 'captured',
            'public', 'eligible', 'included', 3, ?
          )`,
        ).run("f".repeat(64), at, at),
      ).toThrow(/closed/i);

      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9003, 9002, 2, 'invalidated', 'invalid',
          'content superseded', 'live-source-invalidated', ?)`,
      ).run("2026-08-14T14:00:01.000Z");
      connection.prepare(
        `INSERT INTO research_source_state_events (
          id, source_id, sequence_no, event_type, state, reason,
          idempotency_key, occurred_at
        ) VALUES (9004, 9002, 3, 'redacted', 'redacted',
          'privacy purge', 'live-source-redacted', ?)`,
      ).run("2026-08-14T14:00:02.000Z");
      connection.prepare(
        "DELETE FROM research_source_payloads WHERE source_id = 9002",
      ).run();
      expect(
        connection.prepare(
          `SELECT source.source_kind, source.acquisition_method,
            receipt.receipt_digest, handoff.status, head.state,
            payload.source_id AS payload_source_id
           FROM research_sources AS source
           JOIN live_acquisition_source_receipts AS receipt
             ON receipt.id = source.handoff_source_receipt_id
           JOIN live_acquisition_handoffs AS handoff ON handoff.id = receipt.handoff_id
           JOIN research_source_heads AS head ON head.source_id = source.id
           LEFT JOIN research_source_payloads AS payload ON payload.source_id = source.id
           WHERE source.id = 9002`,
        ).get(),
      ).toEqual({
        source_kind: "live_acquisition",
        acquisition_method: "safe_public_http_v1",
        receipt_digest: "6".repeat(64),
        status: "completed",
        state: "redacted",
        payload_source_id: null,
      });
      expect(() =>
        connection
          .prepare(
            "UPDATE live_acquisition_source_receipts SET ordinal = 2 WHERE id = 1",
          )
          .run(),
      ).toThrow(/immutable/i);
      expect(() =>
        connection
          .prepare(
            `UPDATE live_acquisition_handoff_receipts
             SET completed_at = '2026-08-14T14:00:03.000Z' WHERE handoff_id = 1`,
          )
          .run(),
      ).toThrow(/immutable/i);
      expect(connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
