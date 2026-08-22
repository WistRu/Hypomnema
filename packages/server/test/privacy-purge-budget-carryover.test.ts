import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import {
  createLiveAcquisitionFoundation,
  LIVE_ACQUISITION_WORKFLOW,
} from "../src/live-acquisition-foundation.js";
import { executePrivacyPurgePlan } from "../src/live-acquisition-migration.js";
import { createPrivacyLifecycle } from "../src/privacy-lifecycle.js";
import {
  buildPrivacyPurgeDerivedSourceGuards,
  buildPrivacyPurgeExpectedViews,
  buildPrivacyPurgeMutationFences,
  buildPrivacyPurgeRootGuards,
} from "../src/privacy-purge-fence-spec.js";
import {
  adoptLegacy25PrivacyPurgeTerminals,
  createPrivacyPurgeIntentStore,
  installPrivacyPurgeIntentCapabilities,
} from "../src/privacy-purge-intent-capabilities.js";
import { createResearchStore } from "../src/research-store.js";
import {
  liveResearchFixtureAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

const at = "2026-08-21T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function intentStoreAt(
  connection: ReturnType<typeof openDatabase>["connection"],
  ...timestamps: string[]
) {
  let index = 0;
  return createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]!),
  });
}

function installSchema26(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeIntentCapabilities(connection);
  connection.exec(readFileSync(
    new URL("../migrations/026_privacy_purge_intents.sql", import.meta.url),
    "utf8",
  ));
  for (const sql of buildPrivacyPurgeExpectedViews(connection)) connection.exec(sql);
  for (const fence of buildPrivacyPurgeMutationFences(connection)) {
    connection.exec(fence.sql);
  }
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) {
    connection.exec(sql);
  }
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

function seedLegacy25Completion(
  connection: ReturnType<typeof openDatabase>["connection"],
  pageId: number,
): void {
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    pageId,
    `https://legacy-carryover-${pageId}.example/page`,
    `https://legacy-carryover-${pageId}.example/page`,
    `https://legacy-carryover-${pageId}.example/page`,
    at,
    at,
  );
  const generationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = ? AND is_active = 1
  `).pluck().get(pageId));
  expect(createPrivacyLifecycle(connection, {
    clock: () => new Date("2026-08-21T12:00:01.000Z"),
  }).purge({
    idempotencyKey: `legacy25-owned-carryover-${pageId}`,
    target: { kind: "logical_page", subjectGenerationId: generationId },
  }).status).toBe("completed");
}

function seedOwnedCarryover(
  connection: ReturnType<typeof openDatabase>["connection"],
  options: {
    baseId: number;
    workflow: { id: string; version: number };
    costUsd?: number;
    activate?: boolean;
  },
): string {
  const { baseId, workflow } = options;
  const costUsd = options.costUsd ?? 0;
  const maxCostUsd = Math.min(2, Math.max(costUsd + 0.1, 0.5));
  connection.prepare(`
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (?, ?, ?)
  `).run(baseId, `owned-carryover-${baseId}.example`, at);
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, logical_page_id, resource_id, collection_scope,
      selection_fingerprint, subject_key, requested_by, request_method,
      idempotency_key, submission_fingerprint, input_fingerprint,
      workflow_id, workflow_version, scheduling_priority, progress_total,
      max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      available_at, created_at, updated_at
    ) VALUES (
      @jobId, 'resource_research', 'resource', NULL, @resourceId, NULL, NULL,
      @subjectKey, 'user', 'manual', @jobKey, @fingerprint, @fingerprint,
      @workflowId, @workflowVersion, 0, 1, 10, 1000, @maxCostUsd, 240000,
      @at, @at, @at
    )
  `).run({
    jobId: baseId + 1,
    resourceId: baseId,
    subjectKey: `resource:${baseId}`,
    jobKey: `owned-carryover-job-${baseId}`,
    fingerprint: sha256(`owned-carryover-fingerprint-${baseId}`),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    maxCostUsd,
    at,
  });
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_resource_id, target_key, question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, history_epoch_id
    ) VALUES (
      @runId, @jobId, @resourceId, @subjectKey, @questionDigest, '{}',
      @fingerprint, @corpusFingerprint, @fingerprint,
      @workflowId, @workflowVersion, 10, 1000, @maxCostUsd, 240000, @at,
      (SELECT id FROM research_history_epochs
       WHERE resource_id = @resourceId AND is_active = 1)
    )
  `).run({
    runId: baseId + 2,
    jobId: baseId + 1,
    resourceId: baseId,
    subjectKey: `resource:${baseId}`,
    questionDigest: sha256(`owned-carryover-question-${baseId}`),
    fingerprint: sha256(`owned-carryover-fingerprint-${baseId}`),
    corpusFingerprint: sha256(`owned-carryover-corpus-${baseId}`),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    maxCostUsd,
    at,
  });
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, report_id,
      idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', NULL, ?, ?)
  `).run(baseId + 2, `owned-carryover-run-${baseId}`, at);

  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(at),
    token: () => `owned-carryover-token-${baseId}`,
    kindAvailable: (kind) => kind === "resource_research",
    ...(workflow.id === LIVE_ACQUISITION_WORKFLOW.id
      ? {}
      : { research: createResearchStore(connection, { clock: () => new Date(at) }) }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    `owned-carryover-worker-${baseId}`,
    {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 20,
      maxCostUsdPerUtcDay: workflow.id === LIVE_ACQUISITION_WORKFLOW.id ? null : 2,
    },
    undefined,
    [workflow],
  )!;
  expect(claim).toBeDefined();
  if (workflow.id !== LIVE_ACQUISITION_WORKFLOW.id) {
    ledger.bindAttemptProvider(claim, {
      provider: "openai",
      model: "gpt-5",
      promptVersion: "v1",
      pricingVersion: "pricing-v1",
    });
    ledger.checkpoint(claim, {
      progress: { ...claim.progress, stage: "claimed" },
      checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
      usage: {
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd,
        wallTimeMs: 0,
      },
    });
  }
  expect(ledger.fail(claim, {
    progress: { ...claim.progress, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: {
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    },
  }, { code: "JOB_INPUT_UNAVAILABLE" }).status).toBe("failed");

  const generationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(baseId + 2));
  const target = { kind: "run" as const, subjectGenerationId: generationId };
  const idempotencyKey = `owned-carryover-purge-${baseId}`;
  const intentKey = sha256(`owned-carryover-intent-${baseId}`);
  const intentStore = intentStoreAt(
    connection,
    "2026-08-21T12:00:01.000Z",
    "2026-08-21T12:00:02.000Z",
  );
  intentStore.publishWaiting({
    intentKey,
    idempotencyKeyHash: sha256(
      `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
    ),
    requestFingerprint: sha256(
      `tabhub:privacy-purge:request:v1\0run:${generationId}`,
    ),
    target,
  });
  intentStore.freezeReady(intentKey);
  if (options.activate !== false) {
    expect(createPrivacyLifecycle(connection, {
      clock: () => new Date("2026-08-21T12:00:03.000Z"),
    }).purge({ idempotencyKey, target }).status).toBe("completed");
  }
  return intentKey;
}

describe("schema026 privacy-purge budget carryover", () => {
  it("rejects a direct carryover insert without an exact owned capability", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9000, 'https://direct-carryover.example/page',
          'https://direct-carryover.example/page',
          'https://direct-carryover.example/page', '${at}', '${at}'
        )
      `);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9000
          AND is_active = 1
      `).pluck().get());
      intentStoreAt(connection, at).publishWaiting({
        intentKey: "a".repeat(64),
        idempotencyKeyHash: "c".repeat(64),
        requestFingerprint: "d".repeat(64),
        target: { kind: "logical_page", subjectGenerationId: generationId },
      });
      const directInsert = connection.transaction(() => connection.exec(`
        INSERT INTO privacy_purge_budget_carryover_days (
          intent_key, utc_date, budget_class,
          job_kind, workflow_id, workflow_version, coordinator_starts,
          provider_attempts, charged_cost_nanos, active_exposure_nanos,
          legacy25_day_block, state, payload_digest, frozen_at, activated_at
        ) VALUES (
          '${"a".repeat(64)}', '2026-08-21', 'c90_coordinator',
          'resource_research', 'research_acquisition:c90:v1', 1, 1,
          0, 0, 0, 0, 'frozen', '${"b".repeat(64)}',
          '2026-08-21T11:00:00.000Z', NULL
        )
      `));
      expect(() => directInsert.immediate()).toThrowError(
        "privacy purge budget carryover insert requires exact local capability",
      );
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("adds active C90 coordinator starts and excludes frozen carryover", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      seedOwnedCarryover(connection, {
        baseId: 9010,
        workflow: LIVE_ACQUISITION_WORKFLOW,
      });
      seedOwnedCarryover(connection, {
        baseId: 9020,
        workflow: LIVE_ACQUISITION_WORKFLOW,
        activate: false,
      });

      expect(
        createLiveAcquisitionFoundation(connection).readWorkflowUsageUtcDay(at),
      ).toEqual({ running: 0, attemptsStarted: 2 });
    } finally {
      database.close();
    }
  });

  it("blocks a C90 claim when active carryover consumes the daily attempt cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      seedOwnedCarryover(connection, {
        baseId: 9110,
        workflow: LIVE_ACQUISITION_WORKFLOW,
      });
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9101, 'carryover-claim.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9103, 'resource_research', 'resource', NULL, 9101, NULL, NULL,
          'resource:9101', 'user', 'manual', 'carryover-c90-claim',
          '${"3".repeat(64)}', '${"3".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          0, 1, 10, 1, 1, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9104, 9103, 9101, 'resource:9101', '${"4".repeat(64)}', '{}',
          '${"3".repeat(64)}', '${"6".repeat(64)}', '${"3".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          10, 1, 1, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9101 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9104, 1, 'queued', 'queued', NULL, 'carryover-c90-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-c90-claim-token",
        kindAvailable: (kind) => kind === "resource_research",
      });

      expect(ledger.claimNext(
        "resource_research",
        "carryover-c90-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 1,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("blocks a provider claim when active carryover cost exhausts its cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      seedOwnedCarryover(connection, {
        baseId: 9210,
        workflow: { id: "research_workflow:c81:v1", version: 1 },
        costUsd: 1.5,
      });
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9201, 'carryover-provider.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9202, 'resource_research', 'resource', NULL, 9201, NULL, NULL,
          'resource:9201', 'user', 'manual', 'carryover-provider-claim',
          '${"b".repeat(64)}', '${"c".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.6, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9203, 9202, 9201, 'resource:9201', '${"d".repeat(64)}', '{}',
          '${"c".repeat(64)}', '${"e".repeat(64)}', '${"b".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.6, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9201 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9203, 1, 'queued', 'queued', NULL,
          'carryover-provider-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-provider-claim-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });

      expect(ledger.claimNext(
        "resource_research",
        "carryover-provider-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 2,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      )).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("blocks a provider claim when active carryover consumes its daily attempt cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      seedLegacy25Completion(connection, 9310);
      installSchema26(connection);
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9301, 'carryover-provider-attempt.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9302, 'resource_research', 'resource', NULL, 9301, NULL, NULL,
          'resource:9301', 'user', 'manual', 'carryover-provider-attempt-claim',
          '${"4".repeat(64)}', '${"5".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.6, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9303, 9302, 9301, 'resource:9301', '${"6".repeat(64)}', '{}',
          '${"5".repeat(64)}', '${"7".repeat(64)}', '${"4".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.6, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9301 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9303, 1, 'queued', 'queued', NULL,
          'carryover-provider-attempt-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-provider-attempt-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });

      expect(ledger.claimNext(
        "resource_research",
        "carryover-provider-attempt-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 2,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      )).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("commits an explicit empty carryover manifest when no accounting rows exist", () => {
    const database = openDatabase(":memory:", { maximumMigrationVersion: 25 });
    try {
      const { connection } = database;
      installSchema26(connection);
      connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        9390,
        "https://empty-manifest.example/page",
        "https://empty-manifest.example/page",
        "https://empty-manifest.example/page",
        at,
        at,
      );
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9390
          AND is_active = 1
      `).pluck().get());
      const intentKey = "9".repeat(64);
      const store = intentStoreAt(connection, at, "2026-08-21T12:00:01.000Z");
      store.publishWaiting({
        intentKey,
        idempotencyKeyHash: "8".repeat(64),
        requestFingerprint: "7".repeat(64),
        target: { kind: "logical_page", subjectGenerationId: generationId },
      });
      store.freezeReady(intentKey);
      expect(connection.prepare(`
        SELECT carryover_manifest_count, carryover_manifest_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        carryover_manifest_count: 0,
        carryover_manifest_digest: sha256("[]"),
      });
    } finally {
      database.close();
    }
  });

  it("rolls back ready proof when an expected carryover insert is omitted", () => {
    const database = openDatabase(":memory:", { maximumMigrationVersion: 25 });
    try {
      const { connection } = database;
      installSchema26(connection);
      connection.exec(`
        CREATE TEMP TRIGGER omit_expected_carryover
        BEFORE INSERT ON privacy_purge_budget_carryover_days
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      expect(() => seedOwnedCarryover(connection, {
        baseId: 9395,
        workflow: LIVE_ACQUISITION_WORKFLOW,
        activate: false,
      })).toThrow();
      const intentKey = sha256("owned-carryover-intent-9395");
      expect(connection.prepare(`
        SELECT status, carryover_manifest_count, carryover_manifest_digest,
          terminal_evidence_digest, result_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "waiting",
        carryover_manifest_count: null,
        carryover_manifest_digest: null,
        terminal_evidence_digest: null,
        result_digest: null,
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ?
      `).pluck().get(intentKey)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("freezes exact C90 coordinator carryover before an intent becomes ready", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9401, 'carryover-freeze.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9402, 'resource_research', 'resource', NULL, 9401, NULL, NULL,
          'resource:9401', 'user', 'manual', 'carryover-freeze-c90',
          '${"8".repeat(64)}', '${"9".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          0, 1, 10, 1000, 0.5, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9403, 9402, 9401, 'resource:9401', '${"a".repeat(64)}', '{}',
          '${"9".repeat(64)}', '${"b".repeat(64)}', '${"8".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          10, 1000, 0.5, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9401 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9403, 1, 'queued', 'queued', NULL,
          'carryover-freeze-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-freeze-c90-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      const claim = ledger.claimNext(
        "resource_research",
        "carryover-freeze-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )!;
      expect(ledger.fail(claim, {
        progress: { completed: 0, total: 1, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
      }, { code: "JOB_INPUT_UNAVAILABLE" }).status).toBe("failed");

      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9403
          AND is_active = 1
      `).pluck().get());
      const intentKey = "c".repeat(64);
      const intentStore = intentStoreAt(
        connection,
        "2026-08-21T12:00:01.000Z",
        "2026-08-21T12:00:02.000Z",
      );
      const published = intentStore.publishWaiting({
        intentKey,
        idempotencyKeyHash: "d".repeat(64),
        requestFingerprint: "e".repeat(64),
        target: { kind: "run", subjectGenerationId: generationId },
      });
      expect(published).toMatchObject({ status: "waiting", jobWaitCount: 0 });
      expect(intentStore.freezeReady(intentKey).status).toBe("ready");

      const frozen = connection.prepare(`
        SELECT utc_date, budget_class, job_kind, workflow_id, workflow_version,
          coordinator_starts, provider_attempts, charged_cost_nanos,
          active_exposure_nanos, legacy25_day_block, state,
          payload_digest, frozen_at, activated_at
        FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ?
      `).get(intentKey) as Record<string, unknown> | undefined;
      expect(frozen).toEqual({
        utc_date: "2026-08-21",
        budget_class: "c90_coordinator",
        job_kind: "resource_research",
        workflow_id: LIVE_ACQUISITION_WORKFLOW.id,
        workflow_version: LIVE_ACQUISITION_WORKFLOW.version,
        coordinator_starts: 1,
        provider_attempts: 0,
        charged_cost_nanos: 0,
        active_exposure_nanos: 0,
        legacy25_day_block: 0,
        state: "frozen",
        payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        frozen_at: "2026-08-21T12:00:02.000Z",
        activated_at: null,
      });
      const manifestRow = {
        intentKey,
        utcDate: frozen!.utc_date,
        budgetClass: frozen!.budget_class,
        jobKind: frozen!.job_kind,
        workflowId: frozen!.workflow_id,
        workflowVersion: frozen!.workflow_version,
        coordinatorStarts: frozen!.coordinator_starts,
        providerAttempts: frozen!.provider_attempts,
        chargedCostNanos: frozen!.charged_cost_nanos,
        activeExposureNanos: frozen!.active_exposure_nanos,
        legacy25DayBlock: frozen!.legacy25_day_block,
        payloadDigest: frozen!.payload_digest,
        frozenAt: frozen!.frozen_at,
      };
      const manifestDigest = sha256(JSON.stringify([manifestRow]));
      const waitTerminalDigest = sha256(JSON.stringify({ actions: [], jobs: [] }));
      const terminalEvidenceDigest = sha256(JSON.stringify({
        waitTerminalDigest,
        settlementProofGeneration: 0,
        settlementEvidenceDigest: null,
      }));
      const proof = connection.prepare(`
        SELECT execution_plan_digest, carryover_manifest_count,
          carryover_manifest_digest, action_quiescence_digest,
          terminal_evidence_digest, result_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey) as Record<string, unknown>;
      expect(proof).toMatchObject({
        carryover_manifest_count: 1,
        carryover_manifest_digest: manifestDigest,
        terminal_evidence_digest: terminalEvidenceDigest,
      });
      const expectedResult = sha256(JSON.stringify({
        version: "tabhub:privacy-purge:result:v3",
        intentKey,
        planDigest: proof.execution_plan_digest,
        actionQuiescenceDigest: proof.action_quiescence_digest,
        carryoverManifestCount: 1,
        carryoverManifestDigest: manifestDigest,
        terminalEvidenceDigest,
      }));
      expect(proof.result_digest).toBe(expectedResult);
      expect(sha256(JSON.stringify({
        version: "tabhub:privacy-purge:result:v3",
        intentKey,
        planDigest: proof.execution_plan_digest,
        actionQuiescenceDigest: proof.action_quiescence_digest,
        carryoverManifestCount: 1,
        carryoverManifestDigest: sha256(JSON.stringify([
          { ...manifestRow, coordinatorStarts: 2 },
        ])),
        terminalEvidenceDigest,
      }))).not.toBe(expectedResult);
      const alternateEvidence = sha256(JSON.stringify({
        waitTerminalDigest,
        settlementProofGeneration: 1,
        settlementEvidenceDigest: "f".repeat(64),
      }));
      expect(sha256(JSON.stringify({
        version: "tabhub:privacy-purge:result:v3",
        intentKey,
        planDigest: proof.execution_plan_digest,
        actionQuiescenceDigest: proof.action_quiescence_digest,
        carryoverManifestCount: 1,
        carryoverManifestDigest: manifestDigest,
        terminalEvidenceDigest: alternateEvidence,
      }))).not.toBe(expectedResult);
      expect(sha256(JSON.stringify({
        version: "tabhub:privacy-purge:result:v3",
        intentKey,
        planDigest: proof.execution_plan_digest,
        actionQuiescenceDigest: "f".repeat(64),
        carryoverManifestCount: 1,
        carryoverManifestDigest: manifestDigest,
        terminalEvidenceDigest,
      }))).not.toBe(expectedResult);
    } finally {
      database.close();
    }
  });

  it("atomically hands source accounting to active carryover through public purge", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9501, 'carryover-handoff.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9502, 'resource_research', 'resource', NULL, 9501, NULL, NULL,
          'resource:9501', 'user', 'manual', 'carryover-handoff-c90',
          '${"f".repeat(64)}', '${"0".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          0, 1, 10, 1000, 0.5, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9503, 9502, 9501, 'resource:9501', '${"1".repeat(64)}', '{}',
          '${"0".repeat(64)}', '${"2".repeat(64)}', '${"f".repeat(64)}',
          '${LIVE_ACQUISITION_WORKFLOW.id}', ${LIVE_ACQUISITION_WORKFLOW.version},
          10, 1000, 0.5, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9501 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9503, 1, 'queued', 'queued', NULL,
          'carryover-handoff-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-handoff-c90-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      const claim = ledger.claimNext(
        "resource_research",
        "carryover-handoff-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )!;
      expect(ledger.fail(claim, {
        progress: { completed: 0, total: 1, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
      }, { code: "JOB_INPUT_UNAVAILABLE" }).status).toBe("failed");

      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9503
          AND is_active = 1
      `).pluck().get());
      const target = { kind: "run" as const, subjectGenerationId: generationId };
      const idempotencyKey = "carryover-handoff-public-purge";
      const intentKey = "3".repeat(64);
      const intentStore = intentStoreAt(
        connection,
        "2026-08-21T12:00:01.000Z",
        "2026-08-21T12:00:02.000Z",
      );
      intentStore.publishWaiting({
        intentKey,
        idempotencyKeyHash: sha256(
          `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
        ),
        requestFingerprint: sha256(
          `tabhub:privacy-purge:request:v1\0run:${generationId}`,
        ),
        target,
      });
      expect(intentStore.freezeReady(intentKey).status).toBe("ready");

      const foundation = createLiveAcquisitionFoundation(connection);
      expect(connection.prepare(`
        SELECT state, activated_at
        FROM privacy_purge_budget_carryover_days WHERE intent_key = ?
      `).get(intentKey)).toEqual({ state: "frozen", activated_at: null });
      expect(foundation.readWorkflowUsageUtcDay(at)).toEqual({
        running: 0,
        attemptsStarted: 1,
      });

      const completedAt = "2026-08-21T12:00:03.000Z";
      const result = createPrivacyLifecycle(connection, {
        clock: () => new Date(completedAt),
      }).purge({ idempotencyKey, target });
      expect(result.status).toBe("completed");

      expect({
        sourceAttempts: connection.prepare(`
          SELECT COUNT(*) FROM ai_job_attempts WHERE job_id = 9502
        `).pluck().get(),
        carryover: connection.prepare(`
          SELECT state, activated_at FROM privacy_purge_budget_carryover_days
          WHERE intent_key = ?
        `).get(intentKey),
        intent: connection.prepare(`
          SELECT status FROM privacy_purge_intents WHERE intent_key = ?
        `).get(intentKey),
        receipt: connection.prepare(`
          SELECT outcome, origin FROM privacy_purge_intent_receipts
          WHERE intent_key = ?
        `).get(intentKey),
        usage: foundation.readWorkflowUsageUtcDay(at),
      }).toEqual({
        sourceAttempts: 0,
        carryover: { state: "active", activated_at: completedAt },
        intent: { status: "completed" },
        receipt: { outcome: "completed", origin: "schema26" },
        usage: { running: 0, attemptsStarted: 1 },
      });
      const active = connection.prepare(`
        SELECT utc_date, budget_class, job_kind, workflow_id, workflow_version,
          coordinator_starts, provider_attempts, charged_cost_nanos,
          active_exposure_nanos, legacy25_day_block, payload_digest, frozen_at
        FROM privacy_purge_budget_carryover_days WHERE intent_key = ?
      `).get(intentKey) as Record<string, unknown>;
      const committed = connection.prepare(`
        SELECT carryover_manifest_count, carryover_manifest_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey) as Record<string, unknown>;
      expect(committed.carryover_manifest_count).toBe(1);
      expect(committed.carryover_manifest_digest).toBe(sha256(JSON.stringify([{
        intentKey,
        utcDate: active.utc_date,
        budgetClass: active.budget_class,
        jobKind: active.job_kind,
        workflowId: active.workflow_id,
        workflowVersion: active.workflow_version,
        coordinatorStarts: active.coordinator_starts,
        providerAttempts: active.provider_attempts,
        chargedCostNanos: active.charged_cost_nanos,
        activeExposureNanos: active.active_exposure_nanos,
        legacy25DayBlock: active.legacy25_day_block,
        payloadDigest: active.payload_digest,
        frozenAt: active.frozen_at,
      }])));
    } finally {
      database.close();
    }
  });

  it("keeps active budget carryover immutable and permanent", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      const originalIntentKey = seedOwnedCarryover(connection, {
        baseId: 9610,
        workflow: LIVE_ACQUISITION_WORKFLOW,
      });
      const originalDigest = String(connection.prepare(`
        SELECT payload_digest FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ?
      `).pluck().get(originalIntentKey));
      const selectRow = connection.prepare(`
        SELECT intent_key, utc_date, budget_class, job_kind, workflow_id,
          workflow_version, coordinator_starts, provider_attempts,
          charged_cost_nanos, active_exposure_nanos, legacy25_day_block,
          state, payload_digest, frozen_at, activated_at
        FROM privacy_purge_budget_carryover_days
      `);
      const before = selectRow.get();
      const changedIntentKey = "6".repeat(64);
      const changedDigest = "7".repeat(64);
      const errors: Array<string | null> = [];
      try {
        connection.prepare(`
          UPDATE privacy_purge_budget_carryover_days
          SET intent_key = ?, utc_date = '2026-08-22', budget_class = 'provider',
            workflow_id = 'research_workflow:c81:v1', workflow_version = 2,
            coordinator_starts = 0, provider_attempts = 1,
            charged_cost_nanos = 2, active_exposure_nanos = 3,
            legacy25_day_block = 1, state = 'frozen', payload_digest = ?,
            frozen_at = '2026-08-22T10:00:00.000Z', activated_at = NULL
          WHERE intent_key = ?
        `).run(changedIntentKey, changedDigest, originalIntentKey);
        errors.push(null);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        connection.prepare(`
          DELETE FROM privacy_purge_budget_carryover_days
          WHERE payload_digest IN (?, ?)
        `).run(originalDigest, changedDigest);
        errors.push(null);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      expect.soft(errors).toEqual([
        "privacy purge budget carryover rows are immutable",
        "privacy purge budget carryover rows are permanent",
      ]);
      expect(selectRow.get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("freezes exact terminal provider accounting for an intent-owned C81 attempt", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9601, 'carryover-provider-freeze.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9602, 'resource_research', 'resource', NULL, 9601, NULL, NULL,
          'resource:9601', 'user', 'manual', 'carryover-provider-freeze',
          '${"8".repeat(64)}', '${"9".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.5, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9603, 9602, 9601, 'resource:9601', '${"a".repeat(64)}', '{}',
          '${"9".repeat(64)}', '${"b".repeat(64)}', '${"8".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.5, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9601 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9603, 1, 'queued', 'queued', NULL,
          'carryover-provider-freeze-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-provider-freeze-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });
      const claim = ledger.claimNext(
        "resource_research",
        "carryover-provider-freeze-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 2,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      )!;
      ledger.bindAttemptProvider(claim, {
        provider: "openai",
        model: "gpt-5",
        promptVersion: "v1",
        pricingVersion: "pricing-v1",
      });
      ledger.checkpoint(claim, {
        progress: { ...claim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0.1234567891,
          wallTimeMs: 0,
        },
      });
      expect(ledger.fail(claim, {
        progress: { ...claim.progress, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
      }, { code: "JOB_INPUT_UNAVAILABLE" }).status).toBe("failed");

      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = 9603
          AND is_active = 1
      `).pluck().get());
      const intentKey = "d".repeat(64);
      const intentStore = intentStoreAt(
        connection,
        "2026-08-21T12:00:01.000Z",
        "2026-08-21T12:00:02.000Z",
      );
      expect(intentStore.publishWaiting({
        intentKey,
        idempotencyKeyHash: "e".repeat(64),
        requestFingerprint: "f".repeat(64),
        target: { kind: "run", subjectGenerationId: generationId },
      })).toMatchObject({ status: "waiting", jobWaitCount: 0 });
      expect(intentStore.freezeReady(intentKey).status).toBe("ready");

      const provider = connection.prepare(`
        SELECT utc_date, budget_class, job_kind, workflow_id, workflow_version,
          coordinator_starts, provider_attempts, charged_cost_nanos,
          active_exposure_nanos, legacy25_day_block, state,
          payload_digest, frozen_at, activated_at
        FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ? AND budget_class = 'provider'
      `).get(intentKey);
      const c90Rows = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ? AND budget_class = 'c90_coordinator'
      `).pluck().get(intentKey));
      expect({ provider, c90Rows }).toEqual({
        provider: {
          utc_date: "2026-08-21",
          budget_class: "provider",
          job_kind: "resource_research",
          workflow_id: "research_workflow:c81:v1",
          workflow_version: 1,
          coordinator_starts: 0,
          provider_attempts: 1,
          charged_cost_nanos: 123456790,
          active_exposure_nanos: 0,
          legacy25_day_block: 0,
          state: "frozen",
          payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          frozen_at: "2026-08-21T12:00:02.000Z",
          activated_at: null,
        },
        c90Rows: 0,
      });
    } finally {
      database.close();
    }
  });

  it("blocks provider binding when active carryover fills the C81 daily cost cap after claim", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9701, 'carryover-bind-cap.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9702, 'resource_research', 'resource', NULL, 9701, NULL, NULL,
          'resource:9701', 'user', 'manual', 'carryover-bind-cap',
          '${"1".repeat(64)}', '${"2".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.5, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9703, 9702, 9701, 'resource:9701', '${"3".repeat(64)}', '{}',
          '${"2".repeat(64)}', '${"4".repeat(64)}', '${"1".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.5, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9701 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9703, 1, 'queued', 'queued', NULL,
          'carryover-bind-cap-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-bind-cap-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });
      const claim = ledger.claimNext(
        "resource_research",
        "carryover-bind-cap-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 2,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      )!;
      expect(claim).toBeDefined();
      seedLegacy25Completion(connection, 9710);
      installSchema26(connection);
      const bindingLedger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "unused-schema26-bind-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });
      const sideEffectsBefore = {
        reservations: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservations
        `).pluck().get()),
        adoptions: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
        `).pluck().get()),
      };

      let error: unknown;
      try {
        bindingLedger.bindAttemptProvider(claim, {
          provider: "openai",
          model: "gpt-5",
          promptVersion: "v1",
          pricingVersion: "pricing-v1",
        });
      } catch (caught) {
        error = caught;
      }

      const attempt = connection.prepare(`
        SELECT provider, model, prompt_version, pricing_version,
          provider_bound_at, request_id, request_bound_at
        FROM ai_job_attempts WHERE id = ? AND job_id = ?
      `).get(claim.attemptId, claim.id);
      const sideEffectsAfter = {
        reservations: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservations
        `).pluck().get()),
        adoptions: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
        `).pluck().get()),
      };
      expect({
        error: error instanceof Error
          ? { name: error.name, code: Reflect.get(error, "code") }
          : error,
        attempt,
        sideEffectsBefore,
        sideEffectsAfter,
      }).toEqual({
        error: {
          name: "DurableAiJobError",
          code: "JOB_BUDGET_EXHAUSTED",
        },
        attempt: {
          provider: null,
          model: null,
          prompt_version: null,
          pricing_version: null,
          provider_bound_at: null,
          request_id: null,
          request_bound_at: null,
        },
        sideEffectsBefore: { reservations: 0, adoptions: 0 },
        sideEffectsAfter: { reservations: 0, adoptions: 0 },
      });
    } finally {
      database.close();
    }
  });

  it("rejects a raw provider bind that exceeds the schema26 combined daily cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (9801, 'carryover-raw-bind-cap.example', '${at}');

        INSERT INTO ai_jobs (
          id, kind, subject_type, logical_page_id, resource_id, collection_scope,
          selection_fingerprint, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
          available_at, created_at, updated_at
        ) VALUES (
          9802, 'resource_research', 'resource', NULL, 9801, NULL, NULL,
          'resource:9801', 'user', 'manual', 'carryover-raw-bind-cap',
          '${"7".repeat(64)}', '${"8".repeat(64)}',
          'research_workflow:c81:v1', 1, 0, 1,
          10, 1000, 0.5, 240000, '${at}', '${at}', '${at}'
        );

        INSERT INTO research_runs (
          id, job_id, target_resource_id, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at, history_epoch_id
        ) VALUES (
          9803, 9802, 9801, 'resource:9801', '${"9".repeat(64)}', '{}',
          '${"8".repeat(64)}', '${"a".repeat(64)}', '${"7".repeat(64)}',
          'research_workflow:c81:v1', 1, 10, 1000, 0.5, 240000, '${at}', (
            SELECT id FROM research_history_epochs
            WHERE resource_id = 9801 AND is_active = 1
          )
        );

        INSERT INTO research_run_events (
          run_id, sequence_no, event_type, status, report_id,
          idempotency_key, occurred_at
        ) VALUES (
          9803, 1, 'queued', 'queued', NULL,
          'carryover-raw-bind-cap-run-queued', '${at}'
        );
      `);

      const ledger = createAiJobLedger(connection, {
        clock: () => new Date(at),
        token: () => "carryover-raw-bind-cap-token",
        kindAvailable: (kind) => kind === "resource_research",
        research: createResearchStore(connection, { clock: () => new Date(at) }),
      });
      const claim = ledger.claimNext(
        "resource_research",
        "carryover-raw-bind-cap-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 2,
        },
        undefined,
        [{ id: "research_workflow:c81:v1", version: 1 }],
      )!;
      expect(claim).toBeDefined();
      seedLegacy25Completion(connection, 9810);
      installSchema26(connection);

      const rawBind = connection.transaction(() => connection.prepare(`
        UPDATE ai_job_attempts
        SET provider = 'openai', model = 'gpt-5', prompt_version = 'v1',
          pricing_version = 'pricing-v1', provider_bound_at = ?
        WHERE id = ? AND job_id = ?
      `).run(at, claim.attemptId, claim.id));
      expect(() => rawBind.immediate()).toThrowError(
        "schema26 provider bind exceeds combined daily caps",
      );

      expect(connection.prepare(`
        SELECT provider, model, prompt_version, pricing_version,
          provider_bound_at, request_id, request_bound_at
        FROM ai_job_attempts WHERE id = ? AND job_id = ?
      `).get(claim.attemptId, claim.id)).toEqual({
        provider: null,
        model: null,
        prompt_version: null,
        pricing_version: null,
        provider_bound_at: null,
        request_id: null,
        request_bound_at: null,
      });
      expect(connection.prepare(`SELECT status FROM ai_jobs WHERE id = ?`)
        .pluck().get(claim.id)).toBe("running");
      expect(connection.prepare("SELECT 1").pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects an otherwise-valid provider reservation when carryover leaves insufficient daily capacity", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      installSchema26(connection);
      seedOwnedCarryover(connection, {
        baseId: 9910,
        workflow: { id: "research_workflow:c81:v1", version: 1 },
        costUsd: 1.5,
      });
      connection.exec(`
        CREATE TEMP TRIGGER stop_fixture_before_provider_reservation
        BEFORE INSERT ON live_acquisition_provider_reservations
        BEGIN
          SELECT RAISE(ABORT, 'fixture stop before provider reservation');
        END;
      `);
      let fixtureStopError: unknown;
      try {
        seedReceiptBackedLiveResearchRun(connection);
      } catch (error) {
        fixtureStopError = error;
      } finally {
        connection.exec("DROP TRIGGER temp.stop_fixture_before_provider_reservation");
      }
      expect(() => {
        if (fixtureStopError !== undefined) throw fixtureStopError;
      }).toThrowError("fixture stop before provider reservation");
      expect(connection.prepare(`
        SELECT handoff.status AS handoff_status, job.status AS job_status,
          job.event_sequence
        FROM live_acquisition_handoffs AS handoff
        JOIN research_runs AS run ON run.id = handoff.final_run_id
        JOIN ai_jobs AS job ON job.id = run.job_id
        WHERE handoff.id = 1 AND job.id = 7002
      `).get()).toEqual({
        handoff_status: "assembling",
        job_status: "queued",
        event_sequence: 1,
      });

      let reservationError: unknown;
      try {
        connection.prepare(`
          INSERT INTO live_acquisition_provider_reservations (
            id, handoff_id, final_job_id, utc_date, reserved_usd,
            status, created_at
          ) VALUES (1, 1, 7002, '2026-08-21', 1, 'active', ?)
        `).run(at);
      } catch (error) {
        reservationError = error;
      }
      expect({
        error: reservationError instanceof Error
          ? reservationError.message
          : reservationError,
        reservationRows: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservations
          WHERE id = 1 OR handoff_id = 1 OR final_job_id = 7002
        `).pluck().get()),
        databaseProbe: connection.prepare("SELECT 1").pluck().get(),
      }).toEqual({
        error: "schema26 provider reservation exceeds combined daily caps",
        reservationRows: 0,
        databaseProbe: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects an otherwise-valid provider reservation adoption when carryover exceeds the daily cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        UPDATE live_acquisition_provider_reservations
        SET utc_date = '2026-08-21' WHERE id = 1
      `).run();
      seedLegacy25Completion(connection, 9920);
      installSchema26(connection);
      const startedAt = "2026-08-21T12:00:02.000Z";
      const attemptInsert = connection.prepare(`
        INSERT INTO ai_job_attempts (
          job_id, attempt_no, lease_token, worker_id, provider, model,
          prompt_version, pricing_version, provider_bound_at, request_id,
          request_bound_at, started_at, outcome
        )
        SELECT @jobId, @attemptNo, @leaseToken, @workerId,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, @startedAt, 'running'
        FROM ai_jobs AS claim_candidate
        WHERE claim_candidate.id = @jobId
          AND claim_candidate.kind = 'resource_research'
          AND claim_candidate.status = 'queued'
          AND claim_candidate.cancellation_requested_at IS NULL
          AND claim_candidate.available_at <= @startedAt
          AND claim_candidate.attempts < claim_candidate.max_attempts
          AND @attemptNo = claim_candidate.attempts + 1
          AND @startedAt >= claim_candidate.updated_at
          AND claim_candidate.spent_steps < claim_candidate.max_steps
          AND (claim_candidate.max_tokens = 0 OR
            claim_candidate.spent_tokens < claim_candidate.max_tokens)
          AND (claim_candidate.max_cost_usd = 0 OR
            claim_candidate.spent_cost_usd < claim_candidate.max_cost_usd)
          AND claim_candidate.spent_wall_time_ms < claim_candidate.max_wall_time_ms
          AND claim_candidate.workflow_id = 'research_workflow:c81:v1'
          AND claim_candidate.workflow_version = 1
      `).run({
        jobId: fixture.finalJobId,
        attemptNo: 1,
        leaseToken: "carryover-adoption-token-0001",
        workerId: "carryover-adoption-worker",
        startedAt,
      });
      expect(attemptInsert.changes).toBe(1);
      const attemptId = Number(connection.prepare(`
        SELECT id FROM ai_job_attempts WHERE job_id = ? AND attempt_no = 1
      `).pluck().get(fixture.finalJobId));
      expect(connection.prepare(`
        SELECT status, attempts, lease_token FROM ai_jobs WHERE id = ?
      `).get(fixture.finalJobId)).toEqual({
        status: "running",
        attempts: 1,
        lease_token: "carryover-adoption-token-0001",
      });

      let adoptionError: unknown;
      try {
        connection.prepare(`
          INSERT INTO live_acquisition_provider_reservation_adoptions (
            attempt_id, reservation_id, final_job_id, utc_date, adopted_at
          ) VALUES (?, 1, ?, '2026-08-21', '2026-08-21T12:00:03.000Z')
        `).run(attemptId, fixture.finalJobId);
      } catch (error) {
        adoptionError = error;
      }
      expect({
        error: adoptionError instanceof Error ? adoptionError.message : adoptionError,
        adoptionRows: Number(connection.prepare(`
          SELECT COUNT(*) FROM live_acquisition_provider_reservation_adoptions
          WHERE attempt_id = ?
        `).pluck().get(attemptId)),
        reservation: connection.prepare(`
          SELECT status, reserved_usd, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 1
        `).get(),
        attempt: connection.prepare(`
          SELECT provider, model, prompt_version, pricing_version,
            provider_bound_at, request_id, request_bound_at, outcome
          FROM ai_job_attempts WHERE id = ?
        `).get(attemptId),
        databaseProbe: connection.prepare("SELECT 1").pluck().get(),
      }).toEqual({
        error: "schema26 provider reservation adoption exceeds combined daily caps",
        adoptionRows: 0,
        reservation: {
          status: "active",
          reserved_usd: 1,
          consumed_usd: 0,
          terminal_at: null,
        },
        attempt: {
          provider: null,
          model: null,
          prompt_version: null,
          pricing_version: null,
          provider_bound_at: null,
          request_id: null,
          request_bound_at: null,
          outcome: "running",
        },
        databaseProbe: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects an active provider reservation rollover when target-day carryover exceeds the daily cap", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });

    try {
      const { connection } = database;
      const fixture = seedReceiptBackedLiveResearchRun(connection);
      seedLegacy25Completion(connection, 9930);
      installSchema26(connection);

      let rolloverError: unknown;
      try {
        connection.prepare(`
          UPDATE live_acquisition_provider_reservations
          SET utc_date = '2026-08-21'
          WHERE id = 1 AND handoff_id = ? AND final_job_id = ?
        `).run(fixture.handoffId, fixture.finalJobId);
      } catch (error) {
        rolloverError = error;
      }
      expect({
        error: rolloverError instanceof Error ? rolloverError.message : rolloverError,
        reservation: connection.prepare(`
          SELECT handoff_id, final_job_id, utc_date, reserved_usd,
            consumed_usd, status, created_at, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 1
        `).get(),
        databaseProbe: connection.prepare("SELECT 1").pluck().get(),
      }).toEqual({
        error: "schema26 provider reservation rollover exceeds combined daily caps",
        reservation: {
          handoff_id: fixture.handoffId,
          final_job_id: fixture.finalJobId,
          utc_date: "2026-08-14",
          reserved_usd: 1,
          consumed_usd: 0,
          status: "active",
          created_at: liveResearchFixtureAt,
          terminal_at: null,
        },
        databaseProbe: 1,
      });
    } finally {
      database.close();
    }
  });

  it("adopts a same-UTC-day legacy25 completion with fail-closed active carryover", () => {
    const completedAt = "2026-08-21T12:00:01.000Z";
    const migrateLegacyCompletion = () => {
      const database = openDatabase(":memory:", {
        maximumMigrationVersion: 25,
        migrationClock: () => new Date(at),
      });
      try {
        const { connection } = database;
        connection.exec(`
          INSERT INTO logical_pages (
            id, identity_key, url_normalized, representative_url,
            created_at, updated_at
          ) VALUES (
            9901, 'https://legacy-same-day.example/page',
            'https://legacy-same-day.example/page',
            'https://legacy-same-day.example/page', '${at}', '${at}'
          );
        `);
        const generationId = Number(connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'logical_page' AND logical_page_id = 9901
            AND is_active = 1
        `).pluck().get());
        const purge = createPrivacyLifecycle(connection, {
          clock: () => new Date(completedAt),
        }).purge({
          idempotencyKey: "legacy25-same-day-empty-page",
          target: { kind: "logical_page", subjectGenerationId: generationId },
        });
        expect(purge).toMatchObject({ status: "completed", deletedRows: 0 });
        installSchema26(connection);
        expect(adoptLegacy25PrivacyPurgeTerminals(connection)).toBe(0);

        const consistency = connection.prepare(`
          SELECT intent.origin, intent.status, receipt.origin AS receipt_origin,
            receipt.outcome AS receipt_outcome,
            intent.purge_command_id = command.id AS command_linked,
            receipt.purge_command_id = command.id AS receipt_command_linked,
            intent.target_kind = command.target_kind AS target_kind_matches,
            intent.subject_generation_id IS command.subject_generation_id
              AS subject_generation_matches,
            intent.execution_target_count = command.deletion_target_count
              AS target_count_matches,
            intent.execution_plan_digest = command.deletion_plan_digest
              AS plan_digest_matches,
            receipt.execution_target_count = command.deletion_target_count
              AS receipt_target_count_matches,
            receipt.execution_plan_digest = command.deletion_plan_digest
              AS receipt_plan_digest_matches,
            intent.result_digest = result.result_digest AS result_digest_matches,
            receipt.result_digest = result.result_digest
              AS receipt_result_digest_matches,
            receipt.safe_counts_json = result.safe_counts_json
              AS safe_counts_match,
            intent.updated_at = result.completed_at AS completion_matches,
            receipt.completed_at = result.completed_at
              AS receipt_completion_matches,
            intent.wait_snapshot_digest = receipt.wait_terminal_digest
              AS wait_digest_matches,
            intent.intent_key
          FROM privacy_purge_intents AS intent
          JOIN privacy_purge_commands AS command
            ON command.id = intent.purge_command_id
          JOIN privacy_purge_results AS result
            ON result.command_id = command.id
          JOIN privacy_purge_intent_receipts AS receipt
            ON receipt.intent_key = intent.intent_key
        `).get() as Record<string, unknown> | undefined;
        const carryover = connection.prepare(`
          SELECT * FROM privacy_purge_budget_carryover_days
          ORDER BY budget_class
        `).all() as Array<Record<string, unknown>>;
        const identifyingColumns = carryover.length === 0
          ? []
          : Object.keys(carryover[0]!).filter((column) =>
            /(?:logical_page|resource_id|subject|job_id|attempt_id|command_id|url)/
              .test(column));
        return {
          consistency,
          carryover,
          identifyingColumns,
          digests: {
            intentKey: consistency?.intent_key,
            waitDigest: connection.prepare(`
              SELECT wait_snapshot_digest FROM privacy_purge_intents
            `).pluck().get(),
            payloadDigests: carryover.map((row) => row.payload_digest),
          },
        };
      } finally {
        database.close();
      }
    };

    const first = migrateLegacyCompletion();
    const second = migrateLegacyCompletion();
    expect({
      consistency: first.consistency,
      carryover: first.carryover,
      identifyingColumns: first.identifyingColumns,
      deterministicDigests:
        JSON.stringify(first.digests) === JSON.stringify(second.digests),
    }).toEqual({
      consistency: {
        origin: "legacy25",
        status: "completed",
        receipt_origin: "legacy25",
        receipt_outcome: "completed",
        command_linked: 1,
        receipt_command_linked: 1,
        target_kind_matches: 1,
        subject_generation_matches: 1,
        target_count_matches: 1,
        plan_digest_matches: 1,
        receipt_target_count_matches: 1,
        receipt_plan_digest_matches: 1,
        result_digest_matches: 1,
        receipt_result_digest_matches: 1,
        safe_counts_match: 1,
        completion_matches: 1,
        receipt_completion_matches: 1,
        wait_digest_matches: 1,
        intent_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      carryover: [
        {
          intent_key: expect.stringMatching(/^[0-9a-f]{64}$/),
          utc_date: "2026-08-21",
          budget_class: "c90_coordinator",
          job_kind: "resource_research",
          workflow_id: "research_acquisition:c90:v1",
          workflow_version: 1,
          coordinator_starts: 100,
          provider_attempts: 0,
          charged_cost_nanos: 0,
          active_exposure_nanos: 0,
          legacy25_day_block: 1,
          state: "active",
          payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          frozen_at: completedAt,
          activated_at: completedAt,
        },
        {
          intent_key: expect.stringMatching(/^[0-9a-f]{64}$/),
          utc_date: "2026-08-21",
          budget_class: "provider",
          job_kind: "resource_research",
          workflow_id: "research_workflow:c81:v1",
          workflow_version: 1,
          coordinator_starts: 0,
          provider_attempts: 10,
          charged_cost_nanos: 2000000000,
          active_exposure_nanos: 0,
          legacy25_day_block: 1,
          state: "active",
          payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          frozen_at: completedAt,
          activated_at: completedAt,
        },
      ],
      identifyingColumns: [],
      deterministicDigests: true,
    });
  });

  it("adopts a prior-day legacy25 completion without current-day carryover", () => {
    const createdAt = "2026-08-19T12:00:00.000Z";
    const completedAt = "2026-08-20T12:00:01.000Z";
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });
    try {
      const { connection } = database;
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9902, 'https://legacy-prior-day.example/page',
          'https://legacy-prior-day.example/page',
          'https://legacy-prior-day.example/page', '${createdAt}', '${createdAt}'
        )
      `);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9902
          AND is_active = 1
      `).pluck().get());
      createPrivacyLifecycle(connection, {
        clock: () => new Date(completedAt),
      }).purge({
        idempotencyKey: "legacy25-prior-day-empty-page",
        target: { kind: "logical_page", subjectGenerationId: generationId },
      });

      installSchema26(connection);
      expect({
        terminal: connection.prepare(`
          SELECT intent.origin, intent.status,
            receipt.origin AS receipt_origin,
            receipt.outcome AS receipt_outcome
          FROM privacy_purge_intents AS intent
          JOIN privacy_purge_intent_receipts AS receipt
            ON receipt.intent_key = intent.intent_key
        `).get(),
        carryoverRows: Number(connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        `).pluck().get()),
        replayAdoptions: adoptLegacy25PrivacyPurgeTerminals(connection),
      }).toEqual({
        terminal: {
          origin: "legacy25",
          status: "completed",
          receipt_origin: "legacy25",
          receipt_outcome: "completed",
        },
        carryoverRows: 0,
        replayAdoptions: 0,
      });
    } finally {
      database.close();
    }
  });

  it("adopts a failed legacy25 terminal proof without carryover", () => {
    const completedAt = "2026-08-21T12:00:02.000Z";
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(at),
    });
    try {
      const { connection } = database;
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          9903, 'https://legacy-failed.example/page',
          'https://legacy-failed.example/page',
          'https://legacy-failed.example/page', '${at}', '${at}'
        )
      `);
      const generationId = Number(connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 9903
          AND is_active = 1
      `).pluck().get());
      const idempotencyKey = "legacy25-failed-empty-page";
      const idempotencyKeyHash = sha256(
        `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
      );
      const requestFingerprint = sha256(
        `tabhub:privacy-purge:request:v1\0logical_page:${generationId}`,
      );
      const deletionPlanDigest = sha256("[]");
      const inserted = connection.prepare(`
        INSERT INTO privacy_purge_commands (
          idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, deletion_target_count,
          deletion_plan_digest, status, created_at
        ) VALUES (?, ?, 'logical_page', ?, NULL, 0, ?, 'pending', ?)
      `).run(
        idempotencyKeyHash,
        requestFingerprint,
        generationId,
        deletionPlanDigest,
        completedAt,
      );
      const commandId = Number(inserted.lastInsertRowid);
      executePrivacyPurgePlan(connection, {
        version: "privacy_purge_execution:v1",
        commandId,
        outcome: "failed",
        safeCounts: {},
        resultDigest: sha256(
          `tabhub:privacy-purge:failed-test:v1\0${commandId}\0${deletionPlanDigest}`,
        ),
        completedAt,
      });

      installSchema26(connection);
      expect({
        terminal: connection.prepare(`
          SELECT intent.origin, intent.status,
            receipt.origin AS receipt_origin,
            receipt.outcome AS receipt_outcome
          FROM privacy_purge_intents AS intent
          JOIN privacy_purge_intent_receipts AS receipt
            ON receipt.intent_key = intent.intent_key
        `).get(),
        carryoverRows: Number(connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        `).pluck().get()),
        replayAdoptions: adoptLegacy25PrivacyPurgeTerminals(connection),
      }).toEqual({
        terminal: {
          origin: "legacy25",
          status: "failed",
          receipt_origin: "legacy25",
          receipt_outcome: "failed",
        },
        carryoverRows: 0,
        replayAdoptions: 0,
      });
    } finally {
      database.close();
    }
  });
});
