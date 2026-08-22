import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import {
  createLiveAcquisitionFoundation,
  LIVE_ACQUISITION_WORKFLOW,
} from "../src/live-acquisition-foundation.js";

const c90Workflow = "research_acquisition:c90:v1";
const c81Workflow = "research_workflow:c81:v1";
const outsideWorkflow = "research_workflow:outside:v1";
const day = "2026-08-14T12:00:00.000Z";

function seedWorkflowJob(
  connection: ReturnType<typeof openDatabase>["connection"],
  id: number,
  workflowId: string,
  startedAt?: string,
  bindResearchRun = true,
): void {
  const resourceId = id + 100_000;
  const createdAt = startedAt === undefined || startedAt >= day
    ? day
    : new Date(new Date(startedAt).getTime() - 1_000).toISOString();
  connection.prepare(`
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (@id, @resourceKey, @at)
  `).run({ id: resourceId, resourceKey: `c90a-${id}.example`, at: createdAt });
  connection.prepare(`
    INSERT INTO ai_jobs (
      id, kind, subject_type, logical_page_id, resource_id, collection_scope,
      selection_fingerprint, subject_key,
      requested_by, request_method, idempotency_key,
      submission_fingerprint, input_fingerprint, workflow_id, workflow_version,
      scheduling_priority, progress_total, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, available_at, created_at, updated_at
    ) VALUES (
      @id, 'resource_research', 'resource', NULL, @resourceId, NULL, NULL, @subjectKey,
      'user', 'manual', 'c90a-workflow-' || @id,
      @fingerprint, @fingerprint, @workflowId, 1,
      0, 1, 100, 1, 1, 240000, @at, @at, @at
    )
  `).run({
    id,
    resourceId,
    subjectKey: `resource:${resourceId}`,
    workflowId,
    fingerprint: id.toString(16).padStart(64, "0"),
    at: createdAt,
  });
  if (bindResearchRun) {
    connection.prepare(`
      INSERT INTO research_runs (
        id, job_id, target_resource_id, history_epoch_id, target_key,
        question_digest, scope_json,
        approval_fingerprint, corpus_fingerprint, submission_fingerprint,
        workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
        max_wall_time_ms, created_at
      ) VALUES (
        @id, @id, @resourceId,
        (SELECT id FROM research_history_epochs
         WHERE resource_id = @resourceId AND is_active = 1),
        @subjectKey, @questionDigest, '{}',
        @approvalFingerprint, @corpusFingerprint, @submissionFingerprint,
        @workflowId, 1, 100, 1, 1, 240000, @at
      )
    `).run({
      id,
      resourceId,
      subjectKey: `resource:${resourceId}`,
      questionDigest: (id + 1).toString(16).padStart(64, "0"),
      approvalFingerprint: id.toString(16).padStart(64, "0"),
      corpusFingerprint: (id + 3).toString(16).padStart(64, "0"),
      submissionFingerprint: id.toString(16).padStart(64, "0"),
      workflowId,
      at: createdAt,
    });
    connection.prepare(`
      INSERT INTO research_run_events (
        run_id, sequence_no, event_type, status, report_id,
        idempotency_key, occurred_at
      ) VALUES (
        @id, 1, 'queued', 'queued', NULL, @idempotencyKey, @at
      )
    `).run({ id, idempotencyKey: `c90a-run-queued-${id}`, at: createdAt });
  }
  if (startedAt !== undefined) {
    connection.prepare(`
      INSERT INTO ai_job_attempts (
        job_id, attempt_no, lease_token, worker_id, started_at, outcome
      ) VALUES (@id, 1, @leaseToken, 'c90a-worker', @startedAt, 'running')
    `).run({ id, leaseToken: `c90a-lease-${id}`.padEnd(16, "0"), startedAt });
  }
}

describe("live acquisition C90a foundation", () => {
  it("attributes daily attempts only to the C90 workflow", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 1, c90Workflow, day);
      seedWorkflowJob(database.connection, 2, c81Workflow, day);
      const foundation = createLiveAcquisitionFoundation(database.connection);
      expect(foundation.readWorkflowUsageUtcDay(day))
        .toEqual({ running: 1, attemptsStarted: 1 });
    } finally {
      database.close();
    }
  });

  it("exposes only C90 claim and expired-recovery candidates", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 11, c90Workflow);
      seedWorkflowJob(database.connection, 12, c81Workflow);
      seedWorkflowJob(
        database.connection,
        13,
        c90Workflow,
        "2026-08-14T11:58:00.000Z",
      );
      seedWorkflowJob(
        database.connection,
        14,
        c81Workflow,
        "2026-08-14T11:58:00.000Z",
      );
      const foundation = createLiveAcquisitionFoundation(database.connection);
      expect(foundation.readWorkflowQueue(day)).toEqual({
        claimableJobIds: [11],
        recoverableJobIds: [13],
      });
    } finally {
      database.close();
    }
  });

  it("claims C90 without consuming an earlier C81 job", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 21, c81Workflow);
      seedWorkflowJob(database.connection, 22, c90Workflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        token: () => "c90a-filtered-claim-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      const claim = ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      );
      expect(claim?.id).toBe(22);
      expect(database.connection.prepare(`
        SELECT id, status, attempts FROM ai_jobs WHERE id IN (21, 22) ORDER BY id
      `).all()).toEqual([
        { id: 21, status: "queued", attempts: 0 },
        { id: 22, status: "running", attempts: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("refuses to claim a C90 job without its coordinator research run", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 25, c90Workflow, undefined, false);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        token: () => "c90a-unbound-claim-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(() => ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )).toThrow(/bound coordinator run/i);
    } finally {
      database.close();
    }
  });

  it("does not count a running C81 attempt against C90 concurrency", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(
        database.connection,
        23,
        c81Workflow,
        "2026-08-14T11:59:30.000Z",
      );
      seedWorkflowJob(database.connection, 24, c90Workflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        token: () => "c90a-concurrent-claim-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )?.id).toBe(24);
      expect(database.connection.prepare(`
        SELECT id, status FROM ai_jobs WHERE id IN (23, 24) ORDER BY id
      `).all()).toEqual([
        { id: 23, status: "running" },
        { id: 24, status: "running" },
      ]);
    } finally {
      database.close();
    }
  });

  it("applies the UTC-day attempt cap only to the filtered C90 workflow", () => {
    const database = openDatabase(":memory:");
    try {
      for (let id = 40; id < 60; id += 1) {
        seedWorkflowJob(database.connection, id, c90Workflow, day);
      }
      seedWorkflowJob(database.connection, 60, c90Workflow);
      seedWorkflowJob(database.connection, 61, c81Workflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT id, available_at FROM ai_jobs WHERE id IN (60, 61) ORDER BY id
      `).all()).toEqual([
        { id: 60, available_at: "2026-08-15T00:00:00.000Z" },
        { id: 61, available_at: day },
      ]);
    } finally {
      database.close();
    }
  });

  it("recovers only expired C90 attempts when workflow-filtered", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(
        database.connection,
        31,
        c81Workflow,
        "2026-08-14T11:58:00.000Z",
      );
      seedWorkflowJob(
        database.connection,
        32,
        c90Workflow,
        "2026-08-14T11:58:00.000Z",
      );
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.recoverInterrupted([LIVE_ACQUISITION_WORKFLOW])).toBe(1);
      expect(database.connection.prepare(`
        SELECT id, status, attempts FROM ai_jobs WHERE id IN (31, 32) ORDER BY id
      `).all()).toEqual([
        { id: 31, status: "running", attempts: 1 },
        { id: 32, status: "queued", attempts: 1 },
      ]);
      expect(database.connection.prepare(`
        SELECT job_id, outcome FROM ai_job_attempts
        WHERE job_id IN (31, 32) ORDER BY job_id
      `).all()).toEqual([
        { job_id: 31, outcome: "running" },
        { job_id: 32, outcome: "interrupted" },
      ]);
    } finally {
      database.close();
    }
  });

  it("claims from a canonical C81/C90 allowlist without consuming an outside workflow", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 71, outsideWorkflow);
      seedWorkflowJob(database.connection, 72, c90Workflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        token: () => "c90a-union-allowlist-token",
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [
          LIVE_ACQUISITION_WORKFLOW,
          { id: c81Workflow, version: 1 },
        ],
      )?.id).toBe(72);
      expect(database.connection.prepare(`
        SELECT status FROM ai_jobs WHERE id = 71
      `).pluck().get()).toBe("queued");
    } finally {
      database.close();
    }
  });

  it("returns no claim when every ready job is outside the workflow allowlist", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 73, outsideWorkflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT status, attempts FROM ai_jobs WHERE id = 73
      `).get()).toEqual({ status: "queued", attempts: 0 });
    } finally {
      database.close();
    }
  });

  it("accounts and defers across every workflow in the allowlist only", () => {
    const database = openDatabase(":memory:");
    try {
      for (let id = 80; id < 90; id += 1) {
        seedWorkflowJob(database.connection, id, c81Workflow, day);
      }
      for (let id = 90; id < 100; id += 1) {
        seedWorkflowJob(database.connection, id, c90Workflow, day);
      }
      seedWorkflowJob(database.connection, 100, c90Workflow);
      seedWorkflowJob(database.connection, 101, outsideWorkflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [
          LIVE_ACQUISITION_WORKFLOW,
          { id: c81Workflow, version: 1 },
        ],
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT id, available_at FROM ai_jobs WHERE id IN (100, 101) ORDER BY id
      `).all()).toEqual([
        { id: 100, available_at: "2026-08-15T00:00:00.000Z" },
        { id: 101, available_at: day },
      ]);
    } finally {
      database.close();
    }
  });

  it("recovers the C81/C90 allowlist without touching an outside workflow", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 102, c81Workflow, "2026-08-14T11:58:00.000Z");
      seedWorkflowJob(database.connection, 103, c90Workflow, "2026-08-14T11:58:00.000Z");
      seedWorkflowJob(database.connection, 104, outsideWorkflow, "2026-08-14T11:58:00.000Z");
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.recoverInterrupted([
        { id: c81Workflow, version: 1 },
        LIVE_ACQUISITION_WORKFLOW,
      ])).toBe(2);
      expect(database.connection.prepare(`
        SELECT id, status FROM ai_jobs WHERE id IN (102, 103, 104) ORDER BY id
      `).all()).toEqual([
        { id: 102, status: "queued" },
        { id: 103, status: "queued" },
        { id: 104, status: "running" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects empty or duplicate workflow allowlists", () => {
    const database = openDatabase(":memory:");
    try {
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        kindAvailable: (kind) => kind === "resource_research",
      });
      const claim = (allowlist: never) => ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        allowlist,
      );
      expect(() => claim([] as never)).toThrow(/workflow allowlist/i);
      expect(() => claim([
        LIVE_ACQUISITION_WORKFLOW,
        LIVE_ACQUISITION_WORKFLOW,
      ] as never)).toThrow(/workflow allowlist/i);
    } finally {
      database.close();
    }
  });

  it("rechecks allowlist membership at the final claim mutation boundary", () => {
    const database = openDatabase(":memory:");
    try {
      seedWorkflowJob(database.connection, 105, c90Workflow);
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(day),
        token: () => {
          database.connection.exec(`
            DROP TRIGGER ai_jobs_identity_immutable;
            UPDATE ai_jobs
            SET workflow_id = '${outsideWorkflow}'
            WHERE id = 105;
          `);
          return "c90a-boundary-race-token";
        },
        kindAvailable: (kind) => kind === "resource_research",
      });
      expect(ledger.claimNext(
        "resource_research",
        "c90a-worker",
        {
          maxConcurrent: 100,
          maxAttemptsPerUtcDay: 20,
          maxCostUsdPerUtcDay: null,
        },
        undefined,
        [LIVE_ACQUISITION_WORKFLOW],
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT status, attempts, workflow_id FROM ai_jobs WHERE id = 105
      `).get()).toEqual({
        status: "queued",
        attempts: 0,
        workflow_id: outsideWorkflow,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE job_id = 105
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
