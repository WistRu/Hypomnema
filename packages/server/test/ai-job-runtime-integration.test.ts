import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createAiJobLedger, type AiJobLedger } from "../src/ai-job-ledger.js";
import type { AiJobClaim } from "../src/ai-job-ledger.js";
import { createAiJobRuntime, type AiJobRuntimePhysicalAdapter } from
  "../src/ai-job-runtime.js";
import { createAiJobRuntimeCursorStore } from "../src/ai-job-runtime-state.js";
import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";
import { openDatabase } from "../src/database.js";
import { createPriorityAssessmentCoordinator, type PriorityAssessmentCoordinator } from
  "../src/priority-assessment-coordinator.js";
import { priorityCollectionCoverageGuardId } from
  "../src/priority-assessment-coordinator.js";
import { createSummaryCatalog } from "../src/summary-catalog.js";
import { createSummaryWorker } from "../src/summary-worker.js";
import { createResearchStore } from "../src/research-store.js";
import type { SummaryProvider } from "../src/summary-provider.js";

const at = "2026-08-13T01:00:00.000Z";

function seedPage(connection: Database.Database, id: number): void {
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (@id, @url, @url, @url, @at, @at)
  `).run({ id, url: `https://example.com/runtime-${id}`, at });
  connection.prepare(`
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, first_seen_at, last_seen_at,
      logical_page_id
    ) VALUES (@id, @url, @url, @title, 'chrome', @at, @at, @id)
  `).run({ id, url: `https://example.com/runtime-${id}`, title: `Runtime ${id}`, at });
  connection.prepare(`
    INSERT INTO contents (tab_id, text, content_revision, extracted_at)
    VALUES (@id, @text, 1, @at)
  `).run({ id, text: `Captured runtime body ${id}`, at });
}

function priorityAdapter(
  coordinator: PriorityAssessmentCoordinator,
): AiJobRuntimePhysicalAdapter {
  return {
    kind: "priority_assessment",
    recoverInterrupted: () => coordinator.recoverInterrupted(),
    claim(boundary) {
      const claim = coordinator.claim("integration-priority-runtime", boundary);
      return claim === undefined ? undefined : {
        id: `priority_assessment:${claim.id}`,
        execute: () => { coordinator.executeClaim(claim); },
      };
    },
  };
}

function createCoordinator(
  connection: Database.Database,
  clock: () => Date,
  hooks: {
    afterAssess?: Parameters<typeof createPriorityAssessmentCoordinator>[0]["afterAssess"];
    afterFeatureRead?: Parameters<typeof createPriorityAssessmentCoordinator>[0]["afterFeatureRead"];
    afterBatchCheckpoint?: Parameters<typeof createPriorityAssessmentCoordinator>[0]["afterBatchCheckpoint"];
  } = {},
): { coordinator: PriorityAssessmentCoordinator; ledger: AiJobLedger } {
  let ledger!: AiJobLedger;
  const coordinator = createPriorityAssessmentCoordinator({
    connection,
    clock,
    writerEnabled: true,
    ...(hooks.afterBatchCheckpoint === undefined
      ? {}
      : { afterBatchCheckpoint: hooks.afterBatchCheckpoint }),
    ...(hooks.afterAssess === undefined ? {} : { afterAssess: hooks.afterAssess }),
    ...(hooks.afterFeatureRead === undefined
      ? {}
      : { afterFeatureRead: hooks.afterFeatureRead }),
    createLedger(guards) {
      ledger = createAiJobLedger(connection, {
        clock,
        kindAvailable: (kind) => kind === "priority_assessment",
        guards,
      });
      return ledger;
    },
  });
  return { coordinator, ledger };
}

describe("integrated durable AI job runtime", () => {
  it.each([
    ["priority_assessment", "resource_research"],
    ["resource_research", "priority_assessment"],
  ] as const)(
    "applies one physical recovery per interrupted row when %s recovers first",
    async (firstKind, secondKind) => {
      const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
      let nowMs = Date.parse(at);
      const clock = () => new Date(nowMs);
      const research = createResearchStore(database.connection, { clock });
      let ledger!: AiJobLedger;
      const coordinator = createPriorityAssessmentCoordinator({
        connection: database.connection,
        clock,
        writerEnabled: true,
        createLedger(guards) {
          ledger = createAiJobLedger(database.connection, {
            clock,
            kindAvailable: (kind) =>
              kind === "priority_assessment" || kind === "resource_research",
            guards,
            research,
          });
          return ledger;
        },
      });
      try {
        seedPage(database.connection, 1);
        const submitted = coordinator.submit({
          subject: { type: "page", logicalPageId: 1 },
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `global-recovery-${firstKind}`,
          stepBatchSize: 1,
        });
        const jobId = Number(submitted.id.split(":")[1]);
        const interruptedClaim = coordinator.claim("interrupted-runtime", {
          nextCursor: 5,
        })!;
        nowMs += 60_001;

        const recoveryCalls: Array<{
          kind: "priority_assessment" | "resource_research";
          transitions: number;
        }> = [];
        const recoveryAdapter = (
          kind: "priority_assessment" | "resource_research",
        ): AiJobRuntimePhysicalAdapter => ({
          kind,
          recoverInterrupted() {
            const transitions = ledger.recoverInterrupted();
            recoveryCalls.push({ kind, transitions });
            return transitions;
          },
          claim: () => undefined,
        });
        const runtime = createAiJobRuntime({
          cursorStore: createAiJobRuntimeCursorStore(database.connection),
          adapters: [recoveryAdapter(firstKind), recoveryAdapter(secondKind)],
        });

        await expect(runtime.drainAvailable()).resolves.toBe(0);
        expect(recoveryCalls).toEqual([
          { kind: firstKind, transitions: 1 },
          { kind: secondKind, transitions: 0 },
        ]);
        expect(ledger.get("priority_assessment", jobId)).toMatchObject({
          status: "queued",
          attempts: 1,
        });
        expect(database.connection.prepare(`
          SELECT attempt_no, outcome FROM ai_job_attempts WHERE job_id = ?
        `).all(jobId)).toEqual([{ attempt_no: 1, outcome: "interrupted" }]);
        expect(database.connection.prepare(`
          SELECT event_type, from_status, to_status, attempt_id, lease_token
          FROM ai_job_events
          WHERE job_id = ? AND event_type = 'recovered'
        `).all(jobId)).toEqual([{
          event_type: "recovered",
          from_status: "running",
          to_status: "queued",
          attempt_id: interruptedClaim.attemptId,
          lease_token: interruptedClaim.leaseToken,
        }]);
        await runtime.stop();
      } finally {
        database.close();
      }
    },
  );

  it("recovers an initially unexpired priority lease on a later drain after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-runtime-restart-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let nowMs = Date.parse(at);
    const clock = () => new Date(nowMs);
    let firstDatabase: ReturnType<typeof openDatabase> | undefined;
    let restartedDatabase: ReturnType<typeof openDatabase> | undefined;
    try {
      firstDatabase = openDatabase(databasePath, { migrationClock: clock });
      seedPage(firstDatabase.connection, 1);
      seedPage(firstDatabase.connection, 2);
      let crashed = false;
      const first = createCoordinator(firstDatabase.connection, clock, {
        afterBatchCheckpoint() {
          if (crashed) return;
          crashed = true;
          throw new Error("simulated process exit after durable checkpoint");
        },
      });
      const submitted = first.coordinator.submit({
        subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "runtime-restart-priority",
        stepBatchSize: 1,
      });
      const staleClaim = first.coordinator.claim(
        "crashed-priority-runtime",
        { nextCursor: 5 },
      )!;
      expect(() => first.coordinator.executeClaim(staleClaim))
        .toThrow("simulated process exit after durable checkpoint");
      expect(first.ledger.get("priority_assessment", Number(submitted.id.split(":")[1])))
        .toMatchObject({ status: "running", attempts: 1,
          progress: { completed: 1, stage: "scanning" } });
      expect(firstDatabase.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM priority_assessments WHERE logical_page_id=1) +
          (SELECT COUNT(*) FROM priority_exclusions WHERE logical_page_id=1)
      `).pluck().get()).toBe(1);
      firstDatabase.close();
      firstDatabase = undefined;

      const persistedAfterCrash = new Database(databasePath, { readonly: true });
      expect(persistedAfterCrash.prepare(`
        SELECT cursor FROM ai_job_runtime_state
      `).pluck().get()).toBe(5);
      persistedAfterCrash.close();

      nowMs += 30_000;
      restartedDatabase = openDatabase(databasePath);
      const restarted = createCoordinator(restartedDatabase.connection, clock);
      const runtime = createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(restartedDatabase.connection),
        adapters: [priorityAdapter(restarted.coordinator)],
        pollMs: 60_000,
      });
      try {
        runtime.start();
        await expect(runtime.drainAvailable()).resolves.toBe(0);
        expect(restarted.ledger.get(
          "priority_assessment",
          Number(submitted.id.split(":")[1]),
        )).toMatchObject({ status: "running", attempts: 1 });

        nowMs = Date.parse(at) + 61_000;
        await expect(runtime.drainAvailable()).resolves.toBe(1);
        const jobId = Number(submitted.id.split(":")[1]);
        expect(restarted.ledger.get("priority_assessment", jobId))
          .toMatchObject({ status: "succeeded", attempts: 2 });
        expect(restartedDatabase.connection.prepare(`
          SELECT logical_page_id, COUNT(*) AS outcomes FROM (
            SELECT logical_page_id FROM priority_assessments
            UNION ALL
            SELECT logical_page_id FROM priority_exclusions
          ) WHERE logical_page_id IN (1,2)
          GROUP BY logical_page_id ORDER BY logical_page_id
        `).all()).toEqual([
          { logical_page_id: 1, outcomes: 1 },
          { logical_page_id: 2, outcomes: 1 },
        ]);
        const snapshot = {
          job: restartedDatabase.connection.prepare(`
            SELECT status,attempts,event_sequence,result_output_fingerprint
            FROM ai_jobs WHERE id=?
          `).get(jobId),
          events: restartedDatabase.connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id=?
          `).pluck().get(jobId),
          outcomes: restartedDatabase.connection.prepare(`
            SELECT 'assessment' AS kind,logical_page_id,id,revision,superseded_at
            FROM priority_assessments
            UNION ALL
            SELECT 'exclusion',logical_page_id,id,revision,superseded_at
            FROM priority_exclusions ORDER BY logical_page_id,id
          `).all(),
        };
        expect(() => restarted.ledger.refresh(staleClaim)).toThrow("lease was lost");
        const staleCheckpoint = {
          progress: staleClaim.progress,
          checkpoint: { version: 1 as const, nextOffset: 1 },
          usage: { steps: 0, inputTokens: 0, outputTokens: 0,
            costUsd: 0, wallTimeMs: 0 },
        };
        expect(() => restarted.ledger.checkpoint(staleClaim, staleCheckpoint))
          .toThrow("lease was lost");
        expect(() => restarted.ledger.completeIf(staleClaim, {
          checkpoint: staleCheckpoint,
          guard: {
            guardId: priorityCollectionCoverageGuardId,
            args: [jobId],
            expectedFingerprint: "0".repeat(64),
          },
          completion: { status: "succeeded", result: {
            type: "priority_assessment",
            outputFingerprint: "0".repeat(64),
          } },
        })).toThrow("lease was lost");
        expect({
          job: restartedDatabase.connection.prepare(`
            SELECT status,attempts,event_sequence,result_output_fingerprint
            FROM ai_jobs WHERE id=?
          `).get(jobId),
          events: restartedDatabase.connection.prepare(`
            SELECT COUNT(*) FROM ai_job_events WHERE job_id=?
          `).pluck().get(jobId),
          outcomes: restartedDatabase.connection.prepare(`
            SELECT 'assessment' AS kind,logical_page_id,id,revision,superseded_at
            FROM priority_assessments
            UNION ALL
            SELECT 'exclusion',logical_page_id,id,revision,superseded_at
            FROM priority_exclusions ORDER BY logical_page_id,id
          `).all(),
        }).toEqual(snapshot);
      } finally {
        await runtime.stop();
        restartedDatabase.close();
        restartedDatabase = undefined;
      }
    } finally {
      if (firstDatabase?.connection.open === true) firstDatabase.close();
      if (restartedDatabase?.connection.open === true) restartedDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted legacy summary through the common runtime after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-runtime-summary-restart-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const clock = () => new Date(at);
    try {
      const firstDatabase = openDatabase(databasePath, { migrationClock: clock });
      seedPage(firstDatabase.connection, 1);
      const firstCatalog = createSummaryCatalog(firstDatabase.connection, clock);
      const queued = firstCatalog.enqueue(1, "short", {
        maxAttempts: 3,
        requestedBy: "user",
        requestedModel: "restart-summary-model",
      });
      expect(firstCatalog.claimNext(100, { nextCursor: 1 })).toMatchObject({
        id: queued.jobId,
        attempts: 1,
      });
      firstDatabase.close();

      const restartedDatabase = openDatabase(databasePath);
      const restartedCatalog = createSummaryCatalog(restartedDatabase.connection, clock);
      const worker = createSummaryWorker(restartedCatalog, {
        modelFor: () => "restart-summary-model",
        summarize: async () => ({
          summary: "Recovered legacy summary.",
          model: "restart-summary-model",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        }),
      }, { dailyLimit: 100, clock });
      const runtime = createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(restartedDatabase.connection),
        adapters: [{
          kind: "page_summary",
          recoverInterrupted: () => worker.recoverInterrupted(),
          claim(boundary) {
            const claim = worker.claimNext(boundary);
            return claim === undefined ? undefined : {
              id: `summary:${claim.id}`,
              execute: () => worker.executeClaim(claim),
            };
          },
          stop: () => worker.stop(),
        }],
      });
      runtime.start();
      await runtime.drainAvailable();
      expect(restartedCatalog.getJob(queued.jobId)).toMatchObject({
        status: "succeeded",
        attempts: 2,
      });
      expect(restartedDatabase.connection.prepare(`
        SELECT cursor FROM ai_job_runtime_state
      `).pluck().get()).toBe(2);
      await runtime.stop();
      restartedDatabase.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("observes a durable priority cancellation at a bounded collection checkpoint", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    let nowMs = Date.parse(at);
    const clock = () => new Date(nowMs);
    let ledger!: AiJobLedger;
    let assessed = 0;
    const value = createCoordinator(database.connection, clock, {
      afterAssess(claim) {
        assessed += 1;
        nowMs += 21_000;
        ledger.cancel("priority_assessment", claim.id);
      },
    });
    ledger = value.ledger;
    try {
      seedPage(database.connection, 1);
      seedPage(database.connection, 2);
      const submitted = value.coordinator.submit({
        subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "runtime-cancel-priority",
        stepBatchSize: 1,
      });
      const runtime = createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(database.connection),
        adapters: [priorityAdapter(value.coordinator)],
      });
      await expect(runtime.drainAvailable()).resolves.toBe(1);
      expect(ledger.get("priority_assessment", Number(submitted.id.split(":")[1])))
        .toMatchObject({ status: "cancelled", canCancel: false });
      expect(assessed).toBe(1);
      expect(database.connection.prepare(`
        SELECT delta_steps, delta_wall_time_ms, progress_completed
        FROM ai_job_events
        WHERE job_id = ? AND event_type = 'progress'
        ORDER BY sequence_no DESC LIMIT 1
      `).get(Number(submitted.id.split(":")[1]))).toEqual({
        delta_steps: 1,
        delta_wall_time_ms: 21_000,
        progress_completed: 1,
      });
      await runtime.stop();
    } finally {
      database.close();
    }
  });

  it("renews a priority lease after twenty seconds before guarded publication", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    let nowMs = Date.parse(at);
    const clock = () => new Date(nowMs);
    const value = createCoordinator(database.connection, clock, {
      afterAssess() { nowMs += 21_000; },
    });
    try {
      seedPage(database.connection, 1);
      const submitted = value.coordinator.submit({
        subject: { type: "page", logicalPageId: 1 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "runtime-renew-priority",
        stepBatchSize: 1,
      });
      expect(value.coordinator.process("renewal-runtime", { nextCursor: 5 }))
        .toMatchObject({ status: "succeeded" });
      const id = Number(submitted.id.split(":")[1]);
      expect(database.connection.prepare(`
        SELECT event_type, delta_steps, delta_wall_time_ms, occurred_at
        FROM ai_job_events WHERE job_id = ? AND event_type = 'progress'
        ORDER BY sequence_no
      `).all(id)).toContainEqual({
        event_type: "progress",
        delta_steps: 0,
        delta_wall_time_ms: 0,
        occurred_at: "2026-08-13T01:00:21.000Z",
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events
        WHERE job_id = ? AND event_type = 'progress' AND occurred_at = ?
      `).pluck().get(id, at)).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([
    [19_000, 0],
    [20_000, 1],
    [59_000, 1],
  ] as const)("applies the 20-second heartbeat boundary at %dms", (
    elapsedMs,
    expectedRenewals,
  ) => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    let nowMs = Date.parse(at);
    const clock = () => new Date(nowMs);
    const value = createCoordinator(database.connection, clock, {
      afterAssess() { nowMs += elapsedMs; },
    });
    try {
      seedPage(database.connection, 1);
      const submitted = value.coordinator.submit({
        subject: { type: "page", logicalPageId: 1 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: `runtime-heartbeat-${elapsedMs}`,
        stepBatchSize: 1,
      });
      expect(value.coordinator.process("heartbeat-runtime", { nextCursor: 5 }))
        .toMatchObject({ status: "succeeded" });
      const id = Number(submitted.id.split(":")[1]);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events
        WHERE job_id = ? AND event_type = 'progress'
          AND delta_steps = 0 AND delta_wall_time_ms = 0
      `).pluck().get(id)).toBe(expectedRenewals);
    } finally {
      database.close();
    }
  });

  it("treats a sixty-second suspension as lease loss then recovers on the next drain", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    let nowMs = Date.parse(at);
    const clock = () => new Date(nowMs);
    let suspendOnce = true;
    const errors: unknown[] = [];
    const value = createCoordinator(database.connection, clock, {
      afterAssess() {
        if (!suspendOnce) return;
        suspendOnce = false;
        nowMs += 60_000;
      },
    });
    let staleClaim: AiJobClaim | undefined;
    try {
      seedPage(database.connection, 1);
      const submitted = value.coordinator.submit({
        subject: { type: "page", logicalPageId: 1 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "runtime-suspended-priority",
        stepBatchSize: 1,
      });
      const adapter: AiJobRuntimePhysicalAdapter = {
        kind: "priority_assessment",
        recoverInterrupted: () => value.coordinator.recoverInterrupted(),
        claim(boundary) {
          const claim = value.coordinator.claim("suspension-runtime", boundary);
          if (claim === undefined) return undefined;
          staleClaim ??= claim;
          return {
            id: `priority_assessment:${claim.id}`,
            execute: () => { value.coordinator.executeClaim(claim); },
          };
        },
      };
      const runtime = createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(database.connection),
        adapters: [adapter],
        onError: (error) => errors.push(error),
      });
      await expect(runtime.drainAvailable()).resolves.toBe(1);
      const id = Number(submitted.id.split(":")[1]);
      expect(value.ledger.get("priority_assessment", id)).toMatchObject({
        status: "running",
        attempts: 1,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "JOB_LEASE_LOST" });

      await expect(runtime.drainAvailable()).resolves.toBe(1);
      expect(value.ledger.get("priority_assessment", id)).toMatchObject({
        status: "succeeded",
        attempts: 2,
      });
      expect(database.connection.prepare(`
        SELECT cursor FROM ai_job_runtime_state
      `).pluck().get()).toBe(6);
      expect(() => value.ledger.refresh(staleClaim!)).toThrow("lease was lost");
      expect(database.connection.prepare(`
        SELECT attempt_no, outcome FROM ai_job_attempts
        WHERE job_id = ? ORDER BY attempt_no
      `).all(id)).toEqual([
        { attempt_no: 1, outcome: "interrupted" },
        { attempt_no: 2, outcome: "succeeded" },
      ]);
      await runtime.stop();
    } finally {
      database.close();
    }
  });

  it.each(["single", "collection"] as const)(
    "fences an expired %s feature read before semantic assessment",
    async (scenario) => {
      const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
      let nowMs = Date.parse(at);
      const clock = () => new Date(nowMs);
      let suspendOnce = true;
      const errors: unknown[] = [];
      const value = createCoordinator(database.connection, clock, {
        afterFeatureRead() {
          if (!suspendOnce) return;
          suspendOnce = false;
          nowMs += 60_000;
        },
      });
      try {
        seedPage(database.connection, 1);
        if (scenario === "collection") seedPage(database.connection, 2);
        const submitted = value.coordinator.submit({
          subject: scenario === "single"
            ? { type: "page", logicalPageId: 1 }
            : { type: "collection", scope: "all" },
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `runtime-read-expiry-${scenario}`,
          stepBatchSize: 1,
        });
        const runtime = createAiJobRuntime({
          cursorStore: createAiJobRuntimeCursorStore(database.connection),
          adapters: [priorityAdapter(value.coordinator)],
          onError: (error) => errors.push(error),
        });
        await expect(runtime.drainAvailable()).resolves.toBe(1);
        const id = Number(submitted.id.split(":")[1]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ code: "JOB_LEASE_LOST" });
        expect(database.connection.prepare(`
          SELECT
            (SELECT COUNT(*) FROM priority_assessments) +
            (SELECT COUNT(*) FROM priority_exclusions)
        `).pluck().get()).toBe(0);
        expect(database.connection.prepare(`
          SELECT status,spent_steps,spent_wall_time_ms,event_sequence
          FROM ai_jobs WHERE id=?
        `).get(id)).toEqual({
          status: "running",
          spent_steps: 0,
          spent_wall_time_ms: 0,
          event_sequence: 2,
        });

        await expect(runtime.drainAvailable()).resolves.toBe(1);
        expect(value.ledger.get("priority_assessment", id)).toMatchObject({
          status: "succeeded",
          attempts: 2,
        });
        await runtime.stop();
      } finally {
        database.close();
      }
    },
  );

  it("runs real summary and priority adapters in 4:2 borrowed order", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    const clock = () => new Date(at);
    const order: string[] = [];
    const summaryCatalog = createSummaryCatalog(database.connection, clock);
    const summaryWorker = createSummaryWorker(summaryCatalog, {
      modelFor: () => "mixed-summary-model",
      summarize: async (input) => {
        order.push("S");
        return {
          summary: `Mixed summary ${input.tabId}`,
          model: "mixed-summary-model",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    }, { dailyLimit: 100, clock });
    const priority = createCoordinator(database.connection, clock, {
      afterAssess: () => { order.push("P"); },
    });
    try {
      for (let id = 1; id <= 12; id += 1) seedPage(database.connection, id);
      for (let id = 1; id <= 8; id += 1) {
        summaryCatalog.enqueue(id, "short", {
          maxAttempts: 3,
          requestedBy: "user",
          requestedModel: "mixed-summary-model",
        });
      }
      for (let id = 9; id <= 12; id += 1) {
        priority.coordinator.submit({
          subject: { type: "page", logicalPageId: id },
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `mixed-priority-${id}`,
          stepBatchSize: 1,
        });
      }
      const runtime = createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(database.connection),
        adapters: [{
          kind: "page_summary",
          recoverInterrupted: () => summaryWorker.recoverInterrupted(),
          claim(boundary) {
            const claim = summaryWorker.claimNext(boundary);
            return claim === undefined ? undefined : {
              id: `summary:${claim.id}`,
              execute: () => summaryWorker.executeClaim(claim),
            };
          },
          stop: () => summaryWorker.stop(),
        }, priorityAdapter(priority.coordinator)],
      });
      await expect(runtime.drainAvailable()).resolves.toBe(12);
      expect(order).toEqual(["S", "S", "S", "S", "P", "P",
        "S", "S", "S", "S", "P", "P"]);
      expect(database.connection.prepare(`
        SELECT cursor FROM ai_job_runtime_state
      `).pluck().get()).toBe(6);
      await runtime.stop();
    } finally {
      database.close();
    }
  });

  it("keeps feature-off startup write-free and wakes summaries through the common runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-runtime-flags-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const clock = () => new Date(at);
    try {
      const off = createApp({
        databasePath,
        featureFlags: personalAttentionFeatureFlagsOff,
        clock,
        migrationClock: clock,
        logger: false,
      });
      await off.ready();
      await off.close();
      let reader = new Database(databasePath, { readonly: true });
      expect(reader.prepare(`
        SELECT cursor, updated_at FROM ai_job_runtime_state
      `).get()).toEqual({ cursor: 0, updated_at: at });
      expect(reader.prepare(`
        SELECT (SELECT COUNT(*) FROM ai_jobs) AS jobs,
          (SELECT COUNT(*) FROM ai_job_attempts) AS attempts,
          (SELECT COUNT(*) FROM ai_job_events) AS events
      `).get()).toEqual({ jobs: 0, attempts: 0, events: 0 });
      reader.close();

      const provider: SummaryProvider = {
        modelFor: () => "test-summary-model",
        summarize: async () => ({
          summary: "Common runtime summary.",
          model: "test-summary-model",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        }),
      };
      const app = createApp({
        databasePath,
        featureFlags: personalAttentionFeatureFlagsOff,
        clock,
        logger: false,
        summaryProvider: provider,
        summaryWorkerPollMs: 60_000,
      });
      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [{
              url: "https://example.com/common-runtime-summary",
              title: "Summary",
              windowId: 1,
              index: 0,
            }],
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/content",
          payload: {
            browser: "chrome",
            url: "https://example.com/common-runtime-summary",
            text: "Captured summary content.",
            htmlExcerpt: "<article>Captured summary content.</article>",
          },
        });
        const tab = (await app.inject({ method: "GET", url: "/api/tabs" })).json().items[0];
        const queued = await app.inject({
          method: "POST",
          url: `/api/tabs/${tab.id}/summarize`,
          payload: { depth: "short", requestedBy: "user" },
        });
        expect(queued.statusCode).toBe(202);
        const jobId = queued.json().jobId as number;
        let status = "queued";
        for (let attempt = 0; attempt < 50 && status !== "succeeded"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}` }))
            .json().status;
        }
        expect(status).toBe("succeeded");
      } finally {
        await app.close();
      }
      reader = new Database(databasePath, { readonly: true });
      expect(reader.prepare("SELECT cursor FROM ai_job_runtime_state").pluck().get()).toBe(1);
      expect(reader.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      reader.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
