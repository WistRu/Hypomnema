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

const AT = "2026-08-21T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installSchema26(
  connection: ReturnType<typeof openDatabase>["connection"],
  includeMutationFences = true,
): void {
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeIntentCapabilities(connection);
  connection.exec(readFileSync(
    new URL("../migrations/026_privacy_purge_intents.sql", import.meta.url),
    "utf8",
  ));
  for (const sql of buildPrivacyPurgeExpectedViews(connection)) connection.exec(sql);
  if (includeMutationFences) {
    for (const fence of buildPrivacyPurgeMutationFences(connection)) connection.exec(fence.sql);
  }
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) connection.exec(sql);
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

function fixture(requestBound: boolean) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(AT),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(AT),
    token: () => `job-drain-${requestBound ? "bound" : "unbound"}-token`,
    kindAvailable: (kind) => kind === "resource_research",
    research: createResearchStore(connection, { clock: () => new Date(AT) }),
  });
  const claim = ledger.claimNext(
    "resource_research",
    `job-drain-${requestBound ? "bound" : "unbound"}-worker`,
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
    undefined,
    [{ id: "research_workflow:c81:v1", version: 1 }],
  )!;
  if (requestBound) {
    ledger.bindAttemptProvider(claim, {
      provider: "openai",
      model: "gpt-5",
      promptVersion: "research-v1",
      pricingVersion: "pricing-v1",
    });
    ledger.recordAttemptRequest(claim, "job-drain-provider-request");
  }
  installSchema26(connection, false);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const intentKey = sha256(`job-drain-intent-${requestBound}`);
  let clockCalls = 0;
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: () => {
      clockCalls += 1;
      return new Date(AT);
    },
  });
  expect(store.publishWaiting({
    intentKey,
    idempotencyKeyHash: sha256(`job-drain-idempotency-${requestBound}`),
    requestFingerprint: sha256(`job-drain-request-${requestBound}`),
    target: { kind: "run", subjectGenerationId },
  }).jobWaitCount).toBe(1);
  let fencesInstalled = false;
  const installFences = () => {
    if (fencesInstalled) return;
    for (const fence of buildPrivacyPurgeMutationFences(connection)) {
      connection.exec(fence.sql);
    }
    fencesInstalled = true;
  };
  return {
    database,
    ledger,
    claim,
    live,
    intentKey,
    store,
    clockCalls: () => clockCalls,
    installFences,
  };
}

function settleCancelled(
  value: ReturnType<typeof fixture>,
  knownUsage: boolean,
): void {
  expect(value.ledger.checkpoint(value.claim, {
    progress: { ...value.claim.progress, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: {
      steps: knownUsage ? 1 : 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    },
  }).status).toBe("cancelled");
  value.installFences();
}

function priorityFixture(includeMutationFences = true) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(AT),
  });
  const { connection } = database;
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (8101, @url, @url, @url, @at, @at)
  `).run({ url: "https://example.com/job-terminalization", at: AT });
  let ledgerAt = AT;
  let tokenSequence = 0;
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(ledgerAt),
    token: () => `purge-terminalize-priority-token-${++tokenSequence}`,
    kindAvailable: (kind) => kind === "priority_assessment",
  });
  const submitted = ledger.submit({
    version: 1,
    kind: "priority_assessment",
    subject: { type: "page", logicalPageId: 8101 },
    ruleset: { rulesetId: 1, version: 1 },
    assessmentProvenance: { method: "rule" },
    inputFingerprint: "9".repeat(64),
    idempotencyKey: "purge-terminalize-priority",
    stepBatchSize: 1,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget: {
      maxSteps: 10,
      maxTokens: 0,
      maxCostUsd: 0,
      maxWallTimeMs: 60_000,
    },
  });
  const jobId = Number(submitted.id.split(":")[1]);
  const claim = ledger.claimNext(
    "priority_assessment",
    "purge-terminalize-priority-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
  )!;
  expect(claim.id).toBe(jobId);
  installSchema26(connection, includeMutationFences);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = 8101
      AND is_active = 1
  `).pluck().get());
  const intentKey = sha256("purge-terminalize-priority-intent");
  createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(AT),
  }).publishWaiting({
    intentKey,
    idempotencyKeyHash: sha256("purge-terminalize-priority-idempotency"),
    requestFingerprint: sha256("purge-terminalize-priority-request"),
    target: { kind: "logical_page", subjectGenerationId },
  });
  return {
    database,
    ledger,
    claim,
    intentKey,
    setLedgerAt: (value: string) => {
      ledgerAt = value;
    },
    installFences: () => {
      if (!includeMutationFences) {
        for (const fence of buildPrivacyPurgeMutationFences(connection)) {
          connection.exec(fence.sql);
        }
        includeMutationFences = true;
      }
    },
  };
}

describe("schema026 bounded settled job-wait adoption", () => {
  it("adopts a request-unbound cancelled projection without creating job events", () => {
    const value = fixture(false);
    try {
      settleCancelled(value, false);
      const eventsBefore = Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id));

      expect(value.store.reconcileJobWaits(value.intentKey, { maxJobs: 1 })).toEqual({
        intentKey: value.intentKey,
        processed: 1,
        remaining: 0,
      });
      expect(value.clockCalls()).toBe(1);
      expect(value.database.connection.prepare(`
        SELECT terminal_status, terminal_attempt_outcome,
          terminal_reservation_state, terminal_usage_digest,
          terminal_proof_digest, terminal_at
        FROM privacy_purge_intent_job_waits WHERE intent_key = ?
      `).get(value.intentKey)).toMatchObject({
        terminal_status: "cancelled",
        terminal_attempt_outcome: "cancelled",
        terminal_reservation_state: "released",
        terminal_at: AT,
      });
      expect(Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id))).toBe(eventsBefore);
      expect(value.store.reconcileJobWaits(value.intentKey, { maxJobs: 1 })).toEqual({
        intentKey: value.intentKey,
        processed: 0,
        remaining: 0,
      });
      expect(value.clockCalls()).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("adopts request-bound known usage only after attempt and reservation settle", () => {
    const value = fixture(true);
    try {
      settleCancelled(value, true);
      expect(value.database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(value.claim.attemptId)).toBe("cancelled");
      expect(value.database.connection.prepare(`
        SELECT status FROM live_acquisition_provider_reservations
        WHERE final_job_id = ?
      `).pluck().get(value.claim.id)).toBe("released");

      expect(value.store.reconcileJobWaits(value.intentKey, { maxJobs: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 0 });
      const proof = value.database.connection.prepare(`
        SELECT terminal_status, terminal_attempt_outcome,
          terminal_reservation_state, terminal_usage_digest,
          terminal_proof_digest
        FROM privacy_purge_intent_job_waits WHERE intent_key = ?
      `).get(value.intentKey) as Record<string, unknown>;
      expect(proof).toMatchObject({
        terminal_status: "cancelled",
        terminal_attempt_outcome: "cancelled",
        terminal_reservation_state: "released",
      });
      expect(String(proof.terminal_usage_digest)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(proof.terminal_proof_digest)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      value.database.close();
    }
  });

  it("validates bounds without sampling a clock", () => {
    const value = fixture(false);
    try {
      value.installFences();
      for (const maxJobs of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => value.store.reconcileJobWaits(value.intentKey, { maxJobs }))
          .toThrow(/maxJobs/);
      }
      expect(value.clockCalls()).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("snapshots a changing reconcile maxJobs getter exactly once", () => {
    const value = fixture(false);
    try {
      settleCancelled(value, false);
      let reads = 0;
      const input = {
        get maxJobs() {
          reads += 1;
          return reads === 1 ? 1 : 100;
        },
      };
      expect(value.store.reconcileJobWaits(value.intentKey, input))
        .toMatchObject({ processed: 1, remaining: 0 });
      expect(reads).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("rolls back proof adoption and retries without adding job events", () => {
    const value = fixture(true);
    try {
      settleCancelled(value, true);
      const eventsBefore = Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id));
      value.database.connection.exec(`
        CREATE TEMP TRIGGER fail_job_wait_adoption
        AFTER UPDATE ON privacy_purge_intent_job_waits
        WHEN NEW.terminal_status IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'fixture job adoption failure');
        END;
      `);
      expect(() => value.store.reconcileJobWaits(value.intentKey, { maxJobs: 1 }))
        .toThrow("fixture job adoption failure");
      expect(value.database.connection.prepare(`
        SELECT terminal_status FROM privacy_purge_intent_job_waits
        WHERE intent_key = ?
      `).pluck().get(value.intentKey)).toBeNull();
      value.database.connection.exec("DROP TRIGGER temp.fail_job_wait_adoption");
      expect(value.store.reconcileJobWaits(value.intentKey, { maxJobs: 1 }))
        .toMatchObject({ processed: 1, remaining: 0 });
      expect(Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id))).toBe(eventsBefore);
    } finally {
      value.database.close();
    }
  });
});

describe("schema026 expired unbound job terminalization", () => {
  it("emits one cancelled event and adopts its proof in the same call", () => {
    const value = priorityFixture();
    try {
      const eventsBefore = Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id));
      let clockCalls = 0;
      const store = createPrivacyPurgeIntentStore(value.database.connection, {
        clock: () => {
          clockCalls += 1;
          return new Date("2026-08-21T12:01:00.000Z");
        },
      });
      expect(store.terminalizeJobWaits(value.intentKey, { maxJobs: 1 })).toEqual({
        intentKey: value.intentKey,
        terminalized: 1,
        adopted: 1,
        remaining: 0,
      });
      expect(clockCalls).toBe(1);
      expect(value.database.connection.prepare(`
        SELECT status, event_sequence FROM ai_jobs WHERE id = ?
      `).get(value.claim.id)).toMatchObject({ status: "cancelled" });
      expect(value.database.connection.prepare(`
        SELECT event_type, occurred_at FROM ai_job_events
        WHERE job_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).get(value.claim.id)).toEqual({
        event_type: "cancelled",
        occurred_at: "2026-08-21T12:01:00.000Z",
      });
      expect(Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id))).toBe(eventsBefore + 1);
      expect(value.database.connection.prepare(`
        SELECT terminal_status, terminal_attempt_outcome, terminal_reservation_state
        FROM privacy_purge_intent_job_waits WHERE intent_key = ?
      `).get(value.intentKey)).toEqual({
        terminal_status: "cancelled",
        terminal_attempt_outcome: "interrupted",
        terminal_reservation_state: "none",
      });
      expect(store.terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toMatchObject({ terminalized: 0, adopted: 0, remaining: 0 });
    } finally {
      value.database.close();
    }
  });

  it("is a pre-expiry no-op and validates bounds before sampling clock", () => {
    const value = priorityFixture();
    try {
      let clockCalls = 0;
      const store = createPrivacyPurgeIntentStore(value.database.connection, {
        clock: () => {
          clockCalls += 1;
          return new Date("2026-08-21T12:00:59.999Z");
        },
      });
      for (const maxJobs of [0, -1, 1.5, 101]) {
        expect(() => store.terminalizeJobWaits(value.intentKey, { maxJobs }))
          .toThrow(/maxJobs/);
      }
      expect(clockCalls).toBe(0);
      expect(store.terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toEqual({
          intentKey: value.intentKey,
          terminalized: 0,
          adopted: 0,
          remaining: 1,
        });
      expect(clockCalls).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("snapshots a changing terminalize maxJobs getter before the clock", () => {
    const value = priorityFixture();
    try {
      let reads = 0;
      let clockCalls = 0;
      const input = {
        get maxJobs() {
          reads += 1;
          return reads === 1 ? 1 : 100;
        },
      };
      const store = createPrivacyPurgeIntentStore(value.database.connection, {
        clock: () => {
          clockCalls += 1;
          expect(reads).toBe(1);
          return new Date("2026-08-21T12:01:00.000Z");
        },
      });
      expect(store.terminalizeJobWaits(value.intentKey, input))
        .toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(reads).toBe(1);
      expect(clockCalls).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("fails closed when a post-snapshot renewal makes the lease stale", () => {
    const value = priorityFixture(false);
    try {
      value.database.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status,
          attempt_id, lease_owner, lease_token, lease_expires_at,
          progress_completed, progress_total, progress_stage, checkpoint_json,
          spent_steps, spent_tokens, spent_input_tokens, spent_output_tokens,
          delta_input_tokens, delta_output_tokens, delta_cost_usd, delta_steps,
          delta_wall_time_ms, spent_cost_usd, spent_wall_time_ms, occurred_at
        )
        SELECT job.id, job.event_sequence + 1, 'progress', 'running', 'running',
          @attemptId, job.lease_owner, job.lease_token, @leaseExpiresAt,
          job.progress_completed, job.progress_total, job.progress_stage,
          job.checkpoint_json, job.spent_steps, job.spent_tokens, 0, 0,
          0, 0, 0, 0, 0, job.spent_cost_usd, job.spent_wall_time_ms, @occurredAt
        FROM ai_jobs AS job WHERE job.id = @jobId
      `).run({
        attemptId: value.claim.attemptId,
        leaseExpiresAt: "2026-08-21T12:01:30.000Z",
        occurredAt: "2026-08-21T12:00:30.000Z",
        jobId: value.claim.id,
      });
      value.installFences();
      const before = value.database.connection.prepare(`
        SELECT status, event_sequence, lease_expires_at FROM ai_jobs WHERE id = ?
      `).get(value.claim.id);
      expect(() => createPrivacyPurgeIntentStore(value.database.connection, {
        clock: () => new Date("2026-08-21T12:01:00.000Z"),
      }).terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.database.connection.prepare(`
        SELECT status, event_sequence, lease_expires_at FROM ai_jobs WHERE id = ?
      `).get(value.claim.id)).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  it("rolls back event and AFTER projections when proof adoption fails", () => {
    const value = priorityFixture();
    try {
      const jobBefore = value.database.connection.prepare(`
        SELECT status, event_sequence, lease_owner, lease_token FROM ai_jobs WHERE id = ?
      `).get(value.claim.id);
      const attemptBefore = value.database.connection.prepare(`
        SELECT outcome, completed_at FROM ai_job_attempts WHERE id = ?
      `).get(value.claim.attemptId);
      const eventsBefore = Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id));
      value.database.connection.exec(`
        CREATE TEMP TRIGGER fail_terminal_proof_after_event
        BEFORE UPDATE ON privacy_purge_intent_job_waits
        WHEN NEW.terminal_status IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'fixture terminal proof failure');
        END;
      `);
      const store = createPrivacyPurgeIntentStore(value.database.connection, {
        clock: () => new Date("2026-08-21T12:01:00.000Z"),
      });
      expect(() => store.terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toThrow("fixture terminal proof failure");
      expect(value.database.connection.prepare(`
        SELECT status, event_sequence, lease_owner, lease_token FROM ai_jobs WHERE id = ?
      `).get(value.claim.id)).toEqual(jobBefore);
      expect(value.database.connection.prepare(`
        SELECT outcome, completed_at FROM ai_job_attempts WHERE id = ?
      `).get(value.claim.attemptId)).toEqual(attemptBefore);
      expect(Number(value.database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id))).toBe(eventsBefore);
      value.database.connection.exec("DROP TRIGGER temp.fail_terminal_proof_after_event");
      expect(store.terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
    } finally {
      value.database.close();
    }
  });

  it("rejects an active provider reservation without changing any terminal state", () => {
    const value = priorityFixture(false);
    try {
      const { connection } = value.database;
      connection.pragma("foreign_keys = OFF");
      connection.exec("DROP TRIGGER live_acquisition_provider_reservations_insert_guard");
      connection.prepare(`
        INSERT INTO live_acquisition_provider_reservations (
          id, handoff_id, final_job_id, utc_date, reserved_usd,
          consumed_usd, status, created_at, terminal_at
        ) VALUES (991, 991, ?, '2026-08-21', 1, 0, 'active', ?, NULL)
      `).run(value.claim.id, AT);
      connection.pragma("foreign_keys = ON");
      value.installFences();
      const before = {
        job: connection.prepare(`
          SELECT status, event_sequence, lease_owner, lease_token, lease_expires_at
          FROM ai_jobs WHERE id = ?
        `).get(value.claim.id),
        attempt: connection.prepare(`
          SELECT outcome, completed_at FROM ai_job_attempts WHERE id = ?
        `).get(value.claim.attemptId),
        events: connection.prepare(`
          SELECT sequence_no, event_type FROM ai_job_events
          WHERE job_id = ? ORDER BY sequence_no
        `).all(value.claim.id),
        wait: connection.prepare(`
          SELECT terminal_status, terminal_event_sequence, terminal_proof_digest
          FROM privacy_purge_intent_job_waits
          WHERE intent_key = ? AND job_id = ?
        `).get(value.intentKey, value.claim.id),
        reservation: connection.prepare(`
          SELECT status, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 991
        `).get(),
      };
      expect(() => createPrivacyPurgeIntentStore(connection, {
        clock: () => new Date("2026-08-21T12:01:00.000Z"),
      }).terminalizeJobWaits(value.intentKey, { maxJobs: 1 }))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect({
        job: connection.prepare(`
          SELECT status, event_sequence, lease_owner, lease_token, lease_expires_at
          FROM ai_jobs WHERE id = ?
        `).get(value.claim.id),
        attempt: connection.prepare(`
          SELECT outcome, completed_at FROM ai_job_attempts WHERE id = ?
        `).get(value.claim.attemptId),
        events: connection.prepare(`
          SELECT sequence_no, event_type FROM ai_job_events
          WHERE job_id = ? ORDER BY sequence_no
        `).all(value.claim.id),
        wait: connection.prepare(`
          SELECT terminal_status, terminal_event_sequence, terminal_proof_digest
          FROM privacy_purge_intent_job_waits
          WHERE intent_key = ? AND job_id = ?
        `).get(value.intentKey, value.claim.id),
        reservation: connection.prepare(`
          SELECT status, consumed_usd, terminal_at
          FROM live_acquisition_provider_reservations WHERE id = 991
        `).get(),
      }).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  it("honors maxJobs under the one-active-priority-subject schema bound", () => {
    const value = priorityFixture();
    try {
      const { connection } = value.database;
      expect(String(connection.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'ai_jobs_one_active_priority_subject_idx'
      `).pluck().get())).toContain(
        "WHERE kind = 'priority_assessment' AND status IN ('queued', 'running')",
      );
      expect(connection.prepare(`
        SELECT ordinal, job_id FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? ORDER BY ordinal, job_id
      `).all(value.intentKey)).toEqual([{ ordinal: 0, job_id: value.claim.id }]);
      const eventsBefore = Number(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id));
      const store = createPrivacyPurgeIntentStore(connection, {
        clock: () => new Date("2026-08-21T12:01:00.000Z"),
      });
      expect(store.terminalizeJobWaits(value.intentKey, { maxJobs: 100 })).toEqual({
        intentKey: value.intentKey,
        terminalized: 1,
        adopted: 1,
        remaining: 0,
      });
      expect(Number(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
      `).pluck().get(value.claim.id))).toBe(eventsBefore + 1);
    } finally {
      value.database.close();
    }
  });

  it("adopts proof only after the cancelled event projections are visible", () => {
    const value = priorityFixture();
    try {
      const { connection } = value.database;
      connection.exec(`
        CREATE TEMP TRIGGER require_settled_projection_before_job_proof
        BEFORE UPDATE ON privacy_purge_intent_job_waits
        WHEN NEW.terminal_status IS NOT NULL AND NOT (
          NEW.terminal_status = 'cancelled'
          AND NEW.terminal_event_sequence = (
            SELECT event_sequence FROM ai_jobs
            WHERE id = NEW.job_id AND status = 'cancelled'
          )
          AND EXISTS (
            SELECT 1 FROM ai_job_events
            WHERE job_id = NEW.job_id
              AND sequence_no = NEW.terminal_event_sequence
              AND event_type = 'cancelled'
          )
          AND EXISTS (
            SELECT 1 FROM ai_job_attempts
            WHERE id = NEW.attempt_id AND outcome = 'interrupted'
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'proof preceded cancelled projections');
        END;
      `);
      const result = createPrivacyPurgeIntentStore(connection, {
        clock: () => new Date("2026-08-21T12:01:00.000Z"),
      }).terminalizeJobWaits(value.intentKey, { maxJobs: 1 });
      expect(result).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      const terminalSequence = Number(connection.prepare(`
        SELECT terminal_event_sequence FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? AND job_id = ?
      `).pluck().get(value.intentKey, value.claim.id));
      expect(connection.prepare(`
        SELECT event_type FROM ai_job_events
        WHERE job_id = ? AND sequence_no = ?
      `).all(value.claim.id, terminalSequence)).toEqual([{ event_type: "cancelled" }]);
      expect(Number(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events
        WHERE job_id = ? AND sequence_no = ? AND event_type = 'progress'
      `).pluck().get(value.claim.id, terminalSequence))).toBe(0);
    } finally {
      value.database.close();
    }
  });
});
