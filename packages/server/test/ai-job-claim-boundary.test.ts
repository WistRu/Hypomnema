import type { PriorityAssessmentTaskSpec } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { DurableAiJobError } from "../src/durable-ai-jobs.js";
import { createSummaryCatalog } from "../src/summary-catalog.js";

const at = "2026-08-13T01:00:00.000Z";
const clock = () => new Date(at);

function cursor(connection: ReturnType<typeof openDatabase>["connection"]): number {
  return connection.prepare(`
    SELECT cursor FROM ai_job_runtime_state WHERE singleton_id = 1
  `).pluck().get() as number;
}

function seedSummarySubject(
  connection: ReturnType<typeof openDatabase>["connection"],
  id: number,
): void {
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (@id, @url, @url, @url, @at, @at)
  `).run({ id, url: `https://example.com/summary-${id}`, at });
  connection.prepare(`
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
      logical_page_id
    ) VALUES (@id, @url, @url, @title, 'chrome', @at, @at, @id)
  `).run({ id, url: `https://example.com/summary-${id}`, title: `Summary ${id}`, at });
  connection.prepare(`
    INSERT INTO contents (tab_id, text, content_revision, extracted_at)
    VALUES (@id, @text, 1, @at)
  `).run({ id, text: `Captured summary body ${id}`, at });
}

function priorityTask(id: number): PriorityAssessmentTaskSpec {
  return {
    version: 1,
    kind: "priority_assessment",
    subject: { type: "page", logicalPageId: id },
    ruleset: { rulesetId: 1, version: 1 },
    assessmentProvenance: { method: "rule" },
    inputFingerprint: id.toString(16).padStart(64, "0"),
    idempotencyKey: `claim-boundary-${id}`,
    stepBatchSize: 1,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget: {
      maxSteps: 6,
      maxTokens: 0,
      maxCostUsd: 0,
      maxWallTimeMs: 60_000,
    },
  };
}

describe("atomic runtime cursor claim boundaries", () => {
  it("advances with a summary claim and never with no claim, defer, or rollback", () => {
    const database = openDatabase(":memory:", { migrationClock: clock });
    const connection = database.connection;
    const catalog = createSummaryCatalog(connection, clock);
    try {
      seedSummarySubject(connection, 1);
      catalog.enqueue(1, "short", {
        maxAttempts: 3,
        requestedBy: "user",
        requestedModel: "summary-model",
      });
      expect(catalog.claimNext(100, { nextCursor: 4 })).toMatchObject({ id: 1 });
      expect(cursor(connection)).toBe(4);
      expect(catalog.claimNext(100, { nextCursor: 5 })).toBeUndefined();
      expect(cursor(connection)).toBe(4);
      expect(() => catalog.claimNext(100, {
        nextCursor: 5,
        extra: true,
      } as never)).toThrow("Invalid AI job claim boundary");
      expect(cursor(connection)).toBe(4);

      seedSummarySubject(connection, 2);
      catalog.enqueue(2, "short", {
        maxAttempts: 3,
        requestedBy: "user",
        requestedModel: "summary-model",
      });
      expect(catalog.claimNext(1, { nextCursor: 5 })).toBeUndefined();
      expect(cursor(connection)).toBe(4);

      seedSummarySubject(connection, 3);
      catalog.enqueue(3, "short", {
        maxAttempts: 3,
        requestedBy: "user",
        requestedModel: "summary-model",
      });
      expect(() => catalog.claimNext(100, {
        nextCursor: 5,
        extra: true,
      } as never)).toThrow("Invalid AI job claim boundary");
      expect(connection.prepare(`
        SELECT status, attempts FROM jobs WHERE tab_id = 3
      `).get()).toEqual({ status: "queued", attempts: 0 });

      connection.prepare(`
        UPDATE ai_job_runtime_state SET updated_at = ? WHERE singleton_id = 1
      `).run("2026-08-13T01:00:01.000Z");
      try {
        catalog.claimNext(100, { nextCursor: 5 });
        throw new Error("expected summary clock regression");
      } catch (error) {
        expect(error).toBeInstanceOf(DurableAiJobError);
        expect((error as DurableAiJobError).code).toBe("JOB_CLOCK_REGRESSION");
      }
      expect(connection.prepare(`
        SELECT status, attempts FROM jobs WHERE tab_id = 3
      `).get()).toEqual({ status: "queued", attempts: 0 });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM summary_job_attempts WHERE job_id =
          (SELECT id FROM jobs WHERE tab_id = 3)
      `).pluck().get()).toBe(0);
      expect(cursor(connection)).toBe(4);

      connection.exec(`
        DROP TRIGGER ai_job_runtime_state_no_delete;
        DELETE FROM ai_job_runtime_state;
      `);
      expect(() => catalog.claimNext(100, { nextCursor: 5 }))
        .toThrow("cursor authority is unavailable");
      expect(connection.prepare(`
        SELECT status, attempts FROM jobs WHERE tab_id = 3
      `).get()).toEqual({ status: "queued", attempts: 0 });
    } finally {
      database.close();
    }
  });

  it("advances with a ledger claim and rolls back blocked or invalid claims", () => {
    let ledgerClock = new Date(at);
    const database = openDatabase(":memory:", { migrationClock: clock });
    const connection = database.connection;
    const ledger = createAiJobLedger(connection, {
      clock: () => ledgerClock,
      kindAvailable: (kind) => kind === "priority_assessment",
    });
    const limits = {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 100,
      maxCostUsdPerUtcDay: null,
    } as const;
    try {
      for (const id of [11, 12, 13]) seedSummarySubject(connection, id);
      const first = ledger.submit(priorityTask(11));
      expect(ledger.claimNext("priority_assessment", "boundary-worker", limits, {
        nextCursor: 5,
      })).toMatchObject({ id: Number(first.id.split(":")[1]) });
      expect(cursor(connection)).toBe(5);

      ledger.submit(priorityTask(12));
      connection.prepare(`
        UPDATE ai_job_runtime_state SET updated_at = ? WHERE singleton_id = 1
      `).run("2026-08-13T01:00:01.000Z");
      try {
        ledger.claimNext("priority_assessment", "boundary-worker", {
          ...limits,
          maxConcurrent: 100,
        }, { nextCursor: 6 });
        throw new Error("expected ledger clock regression");
      } catch (error) {
        expect(error).toBeInstanceOf(DurableAiJobError);
        expect((error as DurableAiJobError).code).toBe("JOB_CLOCK_REGRESSION");
      }
      ledgerClock = new Date("2026-08-13T01:00:01.000Z");
      expect(connection.prepare(`
        SELECT status, attempts, event_sequence FROM ai_jobs
        WHERE subject_key = 'page:12'
      `).get()).toEqual({ status: "queued", attempts: 0, event_sequence: 1 });
      expect(ledger.claimNext("priority_assessment", "boundary-worker", limits, {
        nextCursor: 6,
      })).toBeUndefined();
      expect(cursor(connection)).toBe(5);

      expect(ledger.claimNext("priority_assessment", "boundary-worker", limits, {
        nextCursor: 6,
      })).toBeUndefined();
      expect(cursor(connection)).toBe(5);
      expect(ledger.claimNext("priority_assessment", "boundary-worker", {
        ...limits,
        maxConcurrent: 100,
        maxCostUsdPerUtcDay: 0,
      }, { nextCursor: 6 })).toMatchObject({ id: Number(first.id.split(":")[1]) + 1 });
      expect(cursor(connection)).toBe(6);

      expect(() => ledger.claimNext("priority_assessment", "boundary-worker", {
        ...limits,
        maxConcurrent: 100,
      }, { nextCursor: 6, extra: true } as never))
        .toThrow("Invalid AI job claim boundary");
      expect(connection.prepare(`
        SELECT status, attempts, event_sequence FROM ai_jobs
        WHERE subject_key = 'page:12'
      `).get()).toEqual({ status: "running", attempts: 1, event_sequence: 2 });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE job_id =
          (SELECT id FROM ai_jobs WHERE subject_key = 'page:12')
      `).pluck().get()).toBe(1);
      expect(cursor(connection)).toBe(6);

      ledger.submit(priorityTask(13));
      connection.exec(`
        DROP TRIGGER ai_job_runtime_state_no_delete;
        DELETE FROM ai_job_runtime_state;
      `);
      expect(() => ledger.claimNext("priority_assessment", "boundary-worker", {
        ...limits,
        maxConcurrent: 100,
      }, { nextCursor: 6 })).toThrow("cursor authority is unavailable");
      expect(connection.prepare(`
        SELECT status, attempts FROM ai_jobs WHERE subject_key = 'page:13'
      `).get()).toEqual({ status: "queued", attempts: 0 });
    } finally {
      database.close();
    }
  });

  it("accepts daily cost equality and defers only a greater reservation", () => {
    const database = openDatabase(":memory:", { migrationClock: clock });
    const connection = database.connection;
    const ledger = createAiJobLedger(connection, {
      clock,
      kindAvailable: (kind) => kind === "priority_assessment",
    });
    const limits = {
      maxConcurrent: 10,
      maxAttemptsPerUtcDay: 100,
      maxCostUsdPerUtcDay: 1,
    } as const;
    try {
      seedSummarySubject(connection, 21);
      seedSummarySubject(connection, 22);
      const exact = priorityTask(21);
      ledger.submit({ ...exact, budget: { ...exact.budget, maxCostUsd: 1 } });
      expect(ledger.claimNext("priority_assessment", "equality-worker", limits, {
        nextCursor: 3,
      })).toBeDefined();
      expect(cursor(connection)).toBe(3);

      const greater = priorityTask(22);
      ledger.submit({ ...greater, budget: { ...greater.budget, maxCostUsd: 0.01 } });
      expect(ledger.claimNext("priority_assessment", "greater-worker", limits, {
        nextCursor: 4,
      })).toBeUndefined();
      expect(connection.prepare(`
        SELECT status, attempts, event_sequence FROM ai_jobs WHERE subject_key = 'page:22'
      `).get()).toEqual({ status: "queued", attempts: 0, event_sequence: 2 });
      expect(cursor(connection)).toBe(3);
    } finally {
      database.close();
    }
  });

  it("preserves zero-use priority retry and recovery semantics", () => {
    let ledgerClock = new Date(at);
    const database = openDatabase(":memory:", { migrationClock: clock });
    const connection = database.connection;
    const ledger = createAiJobLedger(connection, {
      clock: () => ledgerClock,
      kindAvailable: (kind) => kind === "priority_assessment",
    });
    const limits = {
      maxConcurrent: 10,
      maxAttemptsPerUtcDay: 100,
      maxCostUsdPerUtcDay: null,
    } as const;
    const zeroCheckpoint = {
      progress: { completed: 0, total: 1, stage: "zero-budget" },
      checkpoint: { version: 1 as const, nextOffset: 0 },
      usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
    };
    try {
      seedSummarySubject(connection, 31);
      seedSummarySubject(connection, 32);
      ledger.submit(priorityTask(31));
      const failedClaim = ledger.claimNext(
        "priority_assessment", "zero-fail-worker", limits,
      )!;
      expect(ledger.fail(failedClaim, zeroCheckpoint, {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-13T01:00:01.000Z",
      }).status).toBe("queued");
      ledger.cancel("priority_assessment", failedClaim.id);

      ledger.submit(priorityTask(32));
      const recoveredClaim = ledger.claimNext(
        "priority_assessment", "zero-recovery-worker", limits,
      )!;
      ledgerClock = new Date("2026-08-13T01:01:01.000Z");
      expect(ledger.recoverInterrupted()).toBe(1);
      expect(ledger.get("priority_assessment", recoveredClaim.id)).toMatchObject({
        status: "queued",
        error: null,
      });
    } finally {
      database.close();
    }
  });
});
