import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
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
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const PUBLISHED_AT = "2026-08-14T12:00:02.000Z";
const TERMINAL_AT = "2026-08-14T12:01:03.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  for (const fence of buildPrivacyPurgeMutationFences(connection)) connection.exec(fence.sql);
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) connection.exec(sql);
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

function seedOrdinaryC81(
  connection: ReturnType<typeof openDatabase>["connection"],
  id = 8_101,
  workflowId = "research_workflow:c81:v1",
): void {
  const url = `https://ordinary-${id}.example/`;
  const submission = sha256(`ordinary-submit:${id}`);
  const approval = sha256(`ordinary-input:${id}`);
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, url, url, url, PUBLISHED_AT, PUBLISHED_AT);
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, logical_page_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      progress_total, available_at, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at, updated_at
    ) VALUES (
      ?, 'resource_research', 'page', ?, ?, 'user', 'manual', ?, ?, ?, ?, 1,
      100, 1, ?, 10, 1000, 1, 60000, ?, ?
    )
  `).run(
    id, id, `page:${id}`, `ordinary-${id}`, submission, approval, workflowId,
    PUBLISHED_AT, PUBLISHED_AT, PUBLISHED_AT,
  );
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_logical_page_id, target_key, question_digest,
      scope_json, approval_fingerprint, corpus_fingerprint,
      submission_fingerprint, workflow_id, workflow_version, max_steps,
      max_tokens, max_cost_usd, max_wall_time_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 1, 10, 1000, 1, 60000, ?)
  `).run(
    id, id, id, `page:${id}`, sha256(`ordinary-question:${id}`), approval,
    sha256(`ordinary-corpus:${id}`), submission, workflowId, PUBLISHED_AT,
  );
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', ?, ?)
  `).run(id, `ordinary-${id}-queued`, PUBLISHED_AT);
}

function publishRun(
  connection: ReturnType<typeof openDatabase>["connection"],
  runId: number,
  seed: string,
): {
  readonly intentKey: string;
  readonly store: ReturnType<typeof createPrivacyPurgeIntentStore>;
} {
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(runId));
  const intentKey = sha256(`${seed}:intent`);
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(PUBLISHED_AT),
  });
  expect(store.publishWaiting({
    intentKey,
    idempotencyKeyHash: sha256(`${seed}:idempotency`),
    requestFingerprint: sha256(`${seed}:request`),
    target: { kind: "run", subjectGenerationId },
  }).jobWaitCount).toBe(1);
  return { intentKey, store };
}

function directFixture(input: {
  readonly workflowId?: string;
  readonly requestBound?: boolean;
  readonly terminalClock?: () => Date;
} = {}) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const { connection } = database;
  const jobId = 8_101;
  const workflowId = input.workflowId ?? "research_workflow:c81:v1";
  seedOrdinaryC81(connection, jobId, workflowId);
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "direct-c81-unbound-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(PUBLISHED_AT) }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    "direct-c81-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    undefined,
    [{ id: workflowId, version: 1 }],
  )!;
  if (input.requestBound === true) {
    ledger.bindAttemptProvider(claim, {
      provider: "openai",
      model: "gpt-5",
      promptVersion: "research-v1",
      pricingVersion: "pricing-v1",
    });
    ledger.recordAttemptRequest(claim, "direct-c81-request");
  }
  installSchema26(connection);
  const published = publishRun(connection, jobId, `direct:${workflowId}:${input.requestBound}`);
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: input.terminalClock ?? (() => new Date(TERMINAL_AT)),
  });
  return { database, connection, ledger, claim, jobId, ...published, store };
}

function finalFixture(assembling = false, fullyConsumed = false) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "c90-final-unbound-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(PUBLISHED_AT) }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    "c90-final-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    undefined,
    [{ id: "research_workflow:c81:v1", version: 1 }],
  )!;
  expect(claim.id).toBe(live.finalJobId);
  if (fullyConsumed) {
    ledger.bindAttemptProvider(claim, {
      provider: "openai",
      model: "gpt-5",
      promptVersion: "research-v1",
      pricingVersion: "pricing-v1",
    });
    ledger.checkpoint(claim, {
      progress: { ...claim.progress, stage: "claimed" },
      checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
      usage: {
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 1,
        wallTimeMs: 0,
      },
    });
  }
  if (assembling) {
    connection.exec(`
      DROP TRIGGER live_acquisition_handoff_receipts_immutable_delete;
      DROP TRIGGER live_acquisition_handoffs_validate_update;
      DELETE FROM live_acquisition_handoff_receipts WHERE handoff_id = ${live.handoffId};
      UPDATE live_acquisition_handoffs
      SET status = 'assembling', completed_at = NULL WHERE id = ${live.handoffId};
    `);
  }
  installSchema26(connection);
  let published: ReturnType<typeof publishRun>;
  try {
    published = publishRun(connection, live.coordinatorJobId, `final:${assembling}`);
  } catch (error) {
    if (assembling) database.close();
    throw error;
  }
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(TERMINAL_AT),
  });
  return { database, connection, live, claim, ...published, store };
}

function coordinatorFixture(withAction: boolean) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const { connection } = database;
  seedReceiptBackedLiveResearchRun(connection);
  const jobId = 8_901;
  const resourceId = 7_001;
  connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status,
      cancellation_requested_by, occurred_at
    ) SELECT id, event_sequence + 1, 'cancelled', 'queued', 'cancelled',
      'user', ? FROM ai_jobs WHERE id = 7002 AND status = 'queued'
  `).run(PUBLISHED_AT);
  const submission = sha256("coordinator-submission");
  const approval = sha256("coordinator-approval");
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint, input_fingerprint,
      workflow_id, workflow_version, scheduling_priority, progress_total,
      available_at, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      created_at, updated_at
    ) VALUES (?, 'resource_research', 'resource', ?, ?, 'user', 'manual', ?, ?, ?,
      'research_acquisition:c90:v1', 1, 100, 1, ?, 10, 2000, 1, 60000, ?, ?)
  `).run(jobId, resourceId, `resource:${resourceId}`, `c90-${jobId}`, submission,
    approval, PUBLISHED_AT, PUBLISHED_AT, PUBLISHED_AT);
  connection.prepare(`
    INSERT INTO research_runs (
      id, job_id, target_resource_id, history_epoch_id, target_key,
      question_digest, scope_json, approval_fingerprint, corpus_fingerprint,
      submission_fingerprint, workflow_id, workflow_version, max_steps,
      max_tokens, max_cost_usd, max_wall_time_ms, created_at
    ) VALUES (?, ?, ?, (SELECT id FROM research_history_epochs
      WHERE resource_id = ? AND is_active = 1), ?, ?, '{}', ?, ?, ?,
      'research_acquisition:c90:v1', 1, 10, 2000, 1, 60000, ?)
  `).run(jobId, jobId, resourceId, resourceId, `resource:${resourceId}`,
    sha256("coordinator-question"), approval, sha256("coordinator-corpus"),
    submission, PUBLISHED_AT);
  connection.prepare(`
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (?, 1, 'queued', 'queued', 'coordinator-queued', ?)
  `).run(jobId, PUBLISHED_AT);
  const generationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(jobId));
  connection.prepare(`
    INSERT INTO live_acquisition_consents (
      id, resource_generation_id, history_epoch_id, coordinator_job_id,
      coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
      origin_set_digest, limits_json, status, created_at, expires_at
    ) SELECT 89, resource_generation_id, history_epoch_id, ?, ?, runtime_epoch,
      ?, ?, limits_json, 'active', ?, '2026-08-14T12:05:02.000Z'
    FROM live_acquisition_consents WHERE id = 1
  `).run(jobId, generationId, "9".repeat(64), "a".repeat(64), PUBLISHED_AT);
  connection.prepare(`
    INSERT INTO live_acquisition_consent_payloads (consent_id, approved_origins_json)
    SELECT 89, approved_origins_json FROM live_acquisition_consent_payloads WHERE consent_id = 1
  `).run();
  connection.prepare(`
    INSERT INTO live_acquisition_digest_keys (consent_id, digest_key)
    SELECT 89, digest_key FROM live_acquisition_digest_keys WHERE consent_id = 1
  `).run();
  if (withAction) {
    connection.prepare(`
      INSERT INTO live_acquisition_actions (
        id, consent_id, coordinator_run_generation_id, resource_generation_id,
        history_epoch_id, runtime_epoch, action_kind, depth,
        discovered_from_action_id, canonical_fetch_url_fingerprint,
        canonical_origin_digest, action_key_digest, state, created_at
      ) SELECT 8901, 89, ?, resource_generation_id, history_epoch_id,
        runtime_epoch, 'page', 0, NULL, ?, NULL, ?, 'planned', ?
      FROM live_acquisition_consents WHERE id = 89
    `).run(generationId, sha256("coordinator-fetch"), sha256("coordinator-action"),
      PUBLISHED_AT);
    connection.prepare(`
      INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
      VALUES (8901, 'https://www.cloudflare.com/c90', ?)
    `).run(sha256("coordinator-url"));
    connection.prepare(`
      INSERT INTO live_acquisition_action_events (
        action_id, sequence_no, from_state, to_state, safe_details_json, occurred_at
      ) VALUES (8901, 1, 'planned', 'planned', '{}', ?)
    `).run(PUBLISHED_AT);
  }
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(PUBLISHED_AT),
    token: () => "c90-coordinator-token",
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(PUBLISHED_AT) }),
  });
  const claim = ledger.claimNext(
    "resource_research", "c90-coordinator-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    undefined, [{ id: "research_acquisition:c90:v1", version: 1 }],
  )!;
  expect(claim.id).toBe(jobId);
  installSchema26(connection);
  const published = publishRun(connection, jobId, `coordinator:${withAction}`);
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(TERMINAL_AT),
  });
  return { database, connection, jobId, generationId, claim, ...published, store };
}

function appendSyntheticBarrierWait(
  connection: ReturnType<typeof openDatabase>["connection"],
  intentKey: string,
  jobId: number,
  requestBound = false,
): void {
  connection.exec(`DROP TRIGGER IF EXISTS privacy_purge_intent_job_waits_insert_guard;`);
  connection.prepare(`
    INSERT INTO privacy_purge_intent_job_waits (
      intent_key, ordinal, job_id, status, event_sequence,
      cancellation_requested_by, cancellation_requested_at,
      cancellation_snapshot_digest, attempt_id, attempt_no, worker_id,
      lease_token_digest, lease_expires_at, request_bound,
      request_id_digest, request_bound_at, provider, model,
      prompt_version, pricing_version, provider_adoption_utc_date,
      provider_adopted_at, provider_reservation_id,
      provider_reservation_utc_date, provider_reserved_usd,
      provider_consumed_usd, provider_reservation_status,
      settlement_deadline_at, provider_usage_state, row_digest
    )
    SELECT intent_key,
      (SELECT MAX(ordinal) + 1 FROM privacy_purge_intent_job_waits WHERE intent_key = ?),
      ?, status, event_sequence, cancellation_requested_by,
      cancellation_requested_at, cancellation_snapshot_digest,
      attempt_id, attempt_no, worker_id, lease_token_digest, lease_expires_at,
      ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      ?, ?, ?
    FROM privacy_purge_intent_job_waits
    WHERE intent_key = ? ORDER BY ordinal LIMIT 1
  `).run(
    intentKey,
    jobId,
    requestBound ? 1 : 0,
    requestBound ? "b".repeat(64) : null,
    requestBound ? PUBLISHED_AT : null,
    requestBound ? "2026-08-14T12:05:00.000Z" : null,
    requestBound ? "pending" : "none",
    "c".repeat(64),
    intentKey,
  );
}

describe("schema026 running-unbound resource-research drain", () => {
  it("event-owns direct C81 job, attempt, and research-run cancellation", () => {
    const value = directFixture();
    try {
      const priorResearchSequence = Number(value.connection.prepare(`
        SELECT MAX(sequence_no) FROM research_run_events WHERE run_id = ?
      `).pluck().get(value.jobId));
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toEqual({ intentKey: value.intentKey, terminalized: 1, adopted: 1, remaining: 0 });
      expect(value.connection.prepare(`SELECT status FROM ai_jobs WHERE id = ?`)
        .pluck().get(value.jobId)).toBe("cancelled");
      expect(value.connection.prepare(`SELECT outcome FROM ai_job_attempts WHERE id = ?`)
        .pluck().get(value.claim.attemptId)).toBe("interrupted");
      expect(value.connection.prepare(`
        SELECT status FROM research_run_heads WHERE run_id = ?
      `).pluck().get(value.jobId)).toBe("cancelled");
      const aiTerminal = value.connection.prepare(`
        SELECT id, sequence_no, event_type, to_status
        FROM ai_job_events WHERE job_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).get(value.jobId) as {
        id: number; sequence_no: number; event_type: string; to_status: string;
      };
      expect(aiTerminal).toMatchObject({ event_type: "cancelled", to_status: "cancelled" });
      expect(value.connection.prepare(`
        SELECT sequence_no, event_type, status, idempotency_key
        FROM research_run_events WHERE run_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).get(value.jobId)).toEqual({
        sequence_no: priorResearchSequence + 1,
        event_type: "cancelled",
        status: "cancelled",
        idempotency_key: `ai-job-event:${aiTerminal.id}`,
      });
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 0, adopted: 0, remaining: 0 });
    } finally { value.database.close(); }
  });

  it("rolls back the whole direct C81 event cascade when proof adoption fails", () => {
    const value = directFixture();
    try {
      const before = {
        job: value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`).get(value.jobId),
        attempt: value.connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
          .get(value.claim.attemptId),
        aiEvents: value.connection.prepare(`SELECT * FROM ai_job_events WHERE job_id = ?`)
          .all(value.jobId),
        runEvents: value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
          .all(value.jobId),
      };
      value.connection.exec(`
        CREATE TEMP TRIGGER fail_resource_terminal_proof
        BEFORE UPDATE ON privacy_purge_intent_job_waits
        WHEN NEW.terminal_status IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'resource terminal proof failure'); END;
      `);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("resource terminal proof failure");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId)).toEqual(before.job);
      expect(value.connection.prepare(`SELECT * FROM ai_job_attempts WHERE id = ?`)
        .get(value.claim.attemptId)).toEqual(before.attempt);
      expect(value.connection.prepare(`SELECT * FROM ai_job_events WHERE job_id = ?`)
        .all(value.jobId)).toEqual(before.aiEvents);
      expect(value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
        .all(value.jobId)).toEqual(before.runEvents);
    } finally { value.database.close(); }
  });

  it("rejects a direct C81 wait cross-wired to a non-root frozen run target", () => {
    const value = directFixture();
    try {
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_run_targets_immutable_update;
        UPDATE privacy_purge_intent_run_targets
        SET is_root = 0
        WHERE intent_key = '${value.intentKey}' AND research_run_id = ${value.jobId};
      `);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("releases a completed-handoff C90 final reservation in the terminal event", () => {
    const value = finalFixture();
    try {
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(value.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_provider_reservations
        WHERE final_job_id = ?
      `).get(value.live.finalJobId)).toEqual({ status: "released", terminal_at: TERMINAL_AT });
      expect(value.connection.prepare(`
        SELECT status FROM live_acquisition_handoffs WHERE id = ?
      `).pluck().get(value.live.handoffId)).toBe("completed");
    } finally { value.database.close(); }
  });

  it("consumes a fully-used completed-handoff C90 final reservation", () => {
    const value = finalFixture(false, true);
    try {
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(value.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_provider_reservations
        WHERE final_job_id = ?
      `).get(value.live.finalJobId)).toEqual({ status: "consumed", terminal_at: TERMINAL_AT });
    } finally { value.database.close(); }
  });

  it("rejects a C90 final wait whose frozen handoff target was cross-wired", () => {
    const value = finalFixture();
    try {
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_run_targets_immutable_update;
        UPDATE privacy_purge_intent_run_targets
        SET handoff_id = NULL, handoff_status = NULL,
          handoff_receipt_digest = NULL, handoff_receipt_completed_at = NULL
        WHERE intent_key = '${value.intentKey}'
          AND research_run_id = ${value.live.finalRunId};
      `);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("throws with zero mutation when the first candidate has a missing frozen target", () => {
    const value = finalFixture();
    try {
      appendSyntheticBarrierWait(
        value.connection, value.intentKey, value.live.coordinatorJobId,
      );
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_run_targets_delete_guard;
        DELETE FROM privacy_purge_intent_run_targets
        WHERE intent_key = '${value.intentKey}'
          AND research_run_id = ${value.live.finalRunId};
      `);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("rolls back C90 final cancellation when reservation terminalization fails", () => {
    const value = finalFixture();
    try {
      const before = {
        job: value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
          .get(value.live.finalJobId),
        reservation: value.connection.prepare(`
          SELECT * FROM live_acquisition_provider_reservations WHERE final_job_id = ?
        `).get(value.live.finalJobId),
        runEvents: value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
          .all(value.live.finalRunId),
      };
      value.connection.exec(`
        CREATE TEMP TRIGGER fail_provider_reservation_terminalization
        AFTER UPDATE ON live_acquisition_provider_reservations
        BEGIN SELECT RAISE(ABORT, 'reservation terminalization failure'); END;
      `);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("reservation terminalization failure");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId)).toEqual(before.job);
      expect(value.connection.prepare(`
        SELECT * FROM live_acquisition_provider_reservations WHERE final_job_id = ?
      `).get(value.live.finalJobId)).toEqual(before.reservation);
      expect(value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
        .all(value.live.finalRunId)).toEqual(before.runEvents);
    } finally { value.database.close(); }
  });

  it("terminalizes an eligible prefix before a later malformed request-bound wait", () => {
    const value = finalFixture();
    try {
      appendSyntheticBarrierWait(
        value.connection, value.intentKey, value.live.coordinatorJobId, true,
      );
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toEqual({ intentKey: value.intentKey, terminalized: 1, adopted: 1, remaining: 1 });
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
    } finally { value.database.close(); }
  });

  it("preclassifies a request-bound first barrier with maxJobs greater than one", () => {
    const value = directFixture({ requestBound: true });
    try {
      appendSyntheticBarrierWait(value.connection, value.intentKey, 999_999);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("commits an eligible prefix before a later stale/cross-wired safety barrier", () => {
    const value = finalFixture();
    try {
      appendSyntheticBarrierWait(
        value.connection, value.intentKey, value.live.coordinatorJobId,
      );
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toEqual({ intentKey: value.intentKey, terminalized: 1, adopted: 1, remaining: 1 });
      expect(value.connection.prepare(`SELECT status FROM ai_jobs WHERE id = ?`)
        .pluck().get(value.live.finalJobId)).toBe("cancelled");
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
    } finally { value.database.close(); }
  });

  it("throws with zero mutation when a first C90 final reservation snapshot mismatches", () => {
    const value = finalFixture();
    try {
      appendSyntheticBarrierWait(
        value.connection, value.intentKey, value.live.coordinatorJobId,
      );
      value.connection.exec(`DROP TRIGGER privacy_purge_intent_job_waits_terminal_update;`);
      value.connection.prepare(`
        UPDATE privacy_purge_intent_job_waits
        SET provider_reserved_usd = provider_reserved_usd + 0.25
        WHERE intent_key = ? AND job_id = ?
      `).run(value.intentKey, value.live.finalJobId);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.live.finalJobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("fails closed for a running final job whose handoff is still assembling", () => {
    expect(() => finalFixture(true)).toThrow(
      /privacy purge intent publication requires exact local capability/,
    );
  });

  it("requires C90 action waits to terminalize before cancelling its coordinator", () => {
    const value = coordinatorFixture(true);
    try {
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_WAITING_FOR_ACTION");
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 256 }))
        .toMatchObject({ processed: 1, remaining: 0 });
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(value.connection.prepare(`
        SELECT outcome, outcome_code, safe_details_json
        FROM live_acquisition_workflow_outcomes WHERE coordinator_job_id = ?
      `).get(value.jobId)).toEqual({
        outcome: "blocked",
        outcome_code: "WORKFLOW_CANCELLED",
        safe_details_json: JSON.stringify({ outcome_class: "cancelled", attempt_count: 1 }),
      });
      expect(value.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_consents
        WHERE coordinator_job_id = ?
      `).get(value.jobId)).toEqual({ status: "revoked", terminal_at: TERMINAL_AT });
    } finally { value.database.close(); }
  });

  it("preclassifies a pending-action first barrier with maxJobs greater than one", () => {
    const value = coordinatorFixture(true);
    try {
      appendSyntheticBarrierWait(value.connection, value.intentKey, 7_002, true);
      const before = value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 2 },
      )).toThrow("PURGE_WAITING_FOR_ACTION");
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it.each([
    ["outcome insert", `
      CREATE TEMP TRIGGER fail_coordinator_outcome_insert
      BEFORE INSERT ON live_acquisition_workflow_outcomes
      BEGIN SELECT RAISE(ABORT, 'coordinator outcome failure'); END;
    `, "coordinator outcome failure"],
    ["consent revocation", `
      CREATE TEMP TRIGGER fail_coordinator_consent_revoke
      BEFORE UPDATE ON live_acquisition_consents
      BEGIN SELECT RAISE(ABORT, 'coordinator consent failure'); END;
    `, "coordinator consent failure"],
  ])("rolls back C90 coordinator cancellation when %s fails", (_label, triggerSql, error) => {
    const value = coordinatorFixture(false);
    try {
      const before = {
        job: value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`).get(value.jobId),
        consent: value.connection.prepare(`
          SELECT * FROM live_acquisition_consents WHERE coordinator_job_id = ?
        `).get(value.jobId),
        outcomes: value.connection.prepare(`
          SELECT * FROM live_acquisition_workflow_outcomes WHERE coordinator_job_id = ?
        `).all(value.jobId),
        runEvents: value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
          .all(value.jobId),
      };
      value.connection.exec(triggerSql);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow(error);
      expect(value.connection.prepare(`SELECT * FROM ai_jobs WHERE id = ?`)
        .get(value.jobId)).toEqual(before.job);
      expect(value.connection.prepare(`
        SELECT * FROM live_acquisition_consents WHERE coordinator_job_id = ?
      `).get(value.jobId)).toEqual(before.consent);
      expect(value.connection.prepare(`
        SELECT * FROM live_acquisition_workflow_outcomes WHERE coordinator_job_id = ?
      `).all(value.jobId)).toEqual(before.outcomes);
      expect(value.connection.prepare(`SELECT * FROM research_run_events WHERE run_id = ?`)
        .all(value.jobId)).toEqual(before.runEvents);
    } finally { value.database.close(); }
  });

  it.each([
    ["unsupported workflow", () => directFixture({ workflowId: "research_unknown:v1" })],
    ["request-bound attempt", () => directFixture({ requestBound: true })],
  ])("rejects %s without terminal mutation", (_label, build) => {
    const value = build();
    try {
      const before = value.connection.prepare(`
        SELECT status, event_sequence FROM ai_jobs WHERE id = ?
      `).get(value.jobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`
        SELECT status, event_sequence FROM ai_jobs WHERE id = ?
      `).get(value.jobId)).toEqual(before);
    } finally { value.database.close(); }
  });

  it("rejects a post-snapshot lease renewal as stale", () => {
    const value = directFixture();
    try {
      value.connection.exec(`
        DROP TRIGGER privacy_purge26_ai_job_events_insert_fence;
        DROP TRIGGER privacy_purge26_ai_jobs_update_fence;
        DROP TRIGGER privacy_purge26_ai_job_attempts_update_fence;
      `);
      value.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status,
          attempt_id, lease_owner, lease_token, lease_expires_at,
          progress_completed, progress_total, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          delta_input_tokens, delta_output_tokens, delta_cost_usd, delta_steps,
          delta_wall_time_ms, spent_cost_usd, spent_wall_time_ms, occurred_at
        ) SELECT job.id, job.event_sequence + 1, 'progress', 'running', 'running',
          ?, job.lease_owner, job.lease_token, '2026-08-14T12:01:30.000Z',
          0, 1, 'claimed',
          '{"nextStep":0,"stage":"claimed","version":1}',
          job.spent_steps, job.spent_tokens, 0, 0,
          0, 0, 0, 0, 0, job.spent_cost_usd, job.spent_wall_time_ms,
          '2026-08-14T12:00:30.000Z'
        FROM ai_jobs AS job WHERE job.id = ?
      `).run(value.claim.attemptId, value.jobId);
      expect(() => value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
    } finally { value.database.close(); }
  });

  it("validates bounds before reading the clock and replays as a no-op", () => {
    let clockReads = 0;
    const value = directFixture({
      terminalClock: () => {
        clockReads += 1;
        return new Date(TERMINAL_AT);
      },
    });
    try {
      for (const maxJobs of [0, -1, 1.5, 257]) {
        let getterReads = 0;
        const input = {
          get maxJobs() {
            getterReads += 1;
            return maxJobs;
          },
        };
        expect(() => value.store.terminalizeResourceResearchJobWaits(
          value.intentKey, input,
        )).toThrow(/maxJobs/);
        expect(getterReads).toBe(1);
        expect(clockReads).toBe(0);
      }
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(clockReads).toBe(1);
      expect(value.store.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 256 },
      )).toEqual({ intentKey: value.intentKey, terminalized: 0, adopted: 0, remaining: 0 });
      expect(clockReads).toBe(2);
    } finally { value.database.close(); }
  });
});
