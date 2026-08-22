import type {
  DurableJobRef,
  DurableJobView,
  PriorityAssessmentTaskSpec,
  SummaryJob,
} from "@tabhub/shared";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDatabase } from "../src/database.js";
import { createAiJobLedger as createBaseAiJobLedger } from "../src/ai-job-ledger.js";
import {
  AI_JOB_LEASE_MS,
  AI_JOB_RENEW_EVERY_MS,
  fingerprintAiJobGuardProjection,
  type AiJobCheckpointInput,
  type AiJobClaim,
  type AiJobGuardedCompletion,
  type AiJobLedger,
} from "../src/ai-job-ledger.js";
import { describe, expect, it } from "vitest";

import {
  createDurableAiJobs,
  DurableAiJobError,
  type NewAiJobAdapter,
} from "../src/durable-ai-jobs.js";
import { createSummaryJobAdapter } from "../src/summary-job-adapter.js";
import type { SummaryCatalog } from "../src/summary-catalog.js";

function openSchema23Database() {
  const connection = new Database(":memory:");
  sqliteVec.load(connection);
  connection.function("tabhub_normalize_url_v2", { deterministic: true },
    (value: string) => value);
  connection.function("tabhub_migration_now", () => "2026-08-13T00:00:00.000Z");
  const migrationsDirectory = join(process.cwd(), "migrations");
  for (const name of readdirSync(migrationsDirectory)
    .filter((entry) => /^\d{3}_.+\.sql$/.test(entry) && Number(entry.slice(0, 3)) <= 23)
    .sort()) {
    connection.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
    connection.pragma(`user_version = ${Number(name.slice(0, 3))}`);
  }
  connection.pragma("foreign_keys = ON");
  return { connection, schemaVersion: 23, close: () => connection.close() };
}

function summaryJob(overrides: Partial<SummaryJob> = {}): SummaryJob {
  return {
    id: 1,
    tabId: 12,
    sourceContentRevision: 1,
    currentContentRevision: 1,
    contentRevisionMatches: true,
    depth: "short",
    status: "failed",
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-08-13T01:00:00.000Z",
    startedAt: "2026-08-13T01:00:01.000Z",
    completedAt: "2026-08-13T01:00:02.000Z",
    nextAttemptAt: null,
    error: "Superseded by opaque legacy behavior",
    result: null,
    ...overrides,
  };
}

function fakeSummaryCatalog(job = summaryJob()): SummaryCatalog {
  return {
    enqueue: () => ({
      jobId: job.id,
      sourceContentRevision: job.sourceContentRevision,
      status: job.status,
    }),
    getJob: (id) => id === job.id ? job : undefined,
    recoverInterrupted: () => 0,
    claimNext: () => undefined,
    complete: () => false,
    fail: () => undefined,
  };
}

function priorityTask(): PriorityAssessmentTaskSpec {
  return {
    version: 1,
    kind: "priority_assessment",
    subject: { type: "collection", scope: "all" },
    ruleset: { rulesetId: 1, version: 1 },
    assessmentProvenance: { method: "rule" },
    inputFingerprint: "a".repeat(64),
    idempotencyKey: "priority-facade-v1",
    stepBatchSize: 100,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 5,
    budget: {
      maxSteps: 100,
      maxTokens: 0,
      maxCostUsd: 0,
      maxWallTimeMs: 60_000,
    },
  };
}

const openClaimLimits = {
  maxConcurrent: 100,
  maxAttemptsPerUtcDay: 1_000,
  maxCostUsdPerUtcDay: null,
} as const;
const AI_JOB_TEST_GUARD_ID = "constant_v1";
const AI_JOB_TEST_GUARD_FINGERPRINT = fingerprintAiJobGuardProjection(
  [{ name: "covered", column: null, table: null, database: null, type: null }],
  [[1]],
);
function createAiJobLedger(
  connection: Parameters<typeof createBaseAiJobLedger>[0],
  options: Parameters<typeof createBaseAiJobLedger>[1],
) {
  return createBaseAiJobLedger(connection, {
    ...options,
    guards: {
      [AI_JOB_TEST_GUARD_ID]: {
        sql: "SELECT 1 AS covered",
        parameters: [],
        usage: { stepsPerRow: 1 },
      },
      ...options.guards,
    },
  });
}

function guardedInput(
  checkpoint: AiJobCheckpointInput,
  matches = true,
): AiJobGuardedCompletion {
  return {
    checkpoint,
    guard: {
      guardId: AI_JOB_TEST_GUARD_ID,
      args: [],
      expectedFingerprint: matches
        ? AI_JOB_TEST_GUARD_FINGERPRINT : "0".repeat(64),
    },
    completion: {
      status: "succeeded",
      result: {
        type: "priority_assessment",
        outputFingerprint: matches
          ? AI_JOB_TEST_GUARD_FINGERPRINT : "0".repeat(64),
      },
    },
  };
}

function completeWithConstantGuard(
  ledger: AiJobLedger,
  claim: AiJobClaim,
  checkpoint: AiJobCheckpointInput,
  matches = true,
) {
  return ledger.completeIf(claim, guardedInput(checkpoint, matches));
}

function zeroCheckpoint(ledger: AiJobLedger, claim: AiJobClaim): AiJobCheckpointInput {
  const progress = ledger.get(claim.kind, claim.id)?.progress ?? claim.progress;
  return {
    progress,
    checkpoint: claim.kind === "priority_assessment"
      ? { version: 1, nextOffset: 0 }
      : { version: 1, nextStep: 0 },
    usage: {
      steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0,
    },
  };
}

function canonicalTestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function testFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalTestJson(value), "utf8").digest("hex");
}

describe("DurableAiJobs facade", () => {
  it.each([
    ["queued", false, 0],
    ["running", false, 0],
    ["succeeded", true, 1],
    ["failed", false, 0],
  ] as const)("maps legacy %s without inventing common states", (
    status,
    hasResult,
    completed,
  ) => {
    const legacy = summaryJob({
      status,
      error: status === "failed" ? "opaque failure" : null,
      result: hasResult ? {
        summary: "Stored summary",
        model: "summary-model",
        usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
      } : null,
      completedAt: status === "succeeded" || status === "failed"
        ? "2026-08-13T01:00:02.000Z" : null,
    });
    const adapter = createSummaryJobAdapter(fakeSummaryCatalog(legacy));
    expect(adapter.get(legacy.id)).toMatchObject({
      id: `summary:${legacy.id}`,
      kind: "page_summary",
      status,
      progress: { completed, total: 1, stage: status },
      canCancel: false,
      result: hasResult ? { type: "page_summary" } : null,
    });
  });

  it("delegates legacy submission and recovery only through SummaryCatalog", () => {
    let enqueueInput: unknown;
    let recoveries = 0;
    let claimDailyLimit: number | undefined;
    const catalog: SummaryCatalog = {
      ...fakeSummaryCatalog(summaryJob({ id: 44, status: "queued" })),
      enqueue: (...args) => {
        enqueueInput = args;
        return { jobId: 44, sourceContentRevision: 1, status: "queued" };
      },
      claimNext: (dailyLimit) => {
        claimDailyLimit = dailyLimit;
        return {
          id: 44,
          tabId: 12,
          depth: "deep",
          attempts: 1,
          maxAttempts: 3,
          attemptId: 9,
          requestedBy: "agent",
          requestedModel: "summary-model",
          sourceContentRevision: 2,
          title: "Page",
          url: "https://example.com",
          text: "captured",
        };
      },
      recoverInterrupted: () => ++recoveries,
    };
    const adapter = createSummaryJobAdapter(catalog);
    expect(adapter.submit({
      version: 1,
      kind: "page_summary",
      subject: { type: "tab", tabId: 12 },
      depth: "deep",
      requestedBy: "agent",
      requestedModel: "summary-model",
      maxAttempts: 3,
    })).toEqual({ id: "summary:44", kind: "page_summary", status: "queued" });
    expect(enqueueInput).toEqual([12, "deep", {
      maxAttempts: 3,
      requestedBy: "agent",
      requestedModel: "summary-model",
    }]);
    expect(adapter.claimNext(37)).toMatchObject({
      kind: "page_summary",
      id: 44,
      task: {
        version: 1,
        kind: "page_summary",
        subject: { type: "tab", tabId: 12 },
        depth: "deep",
        requestedBy: "agent",
        requestedModel: "summary-model",
        maxAttempts: 3,
      },
    });
    expect(claimDailyLimit).toBe(37);
    expect(adapter.recoverInterrupted()).toBe(1);
  });

  it("isolates colliding physical IDs and preserves legacy status meaning", () => {
    const priorityView: DurableJobView = {
      id: "priority_assessment:1",
      kind: "priority_assessment",
      subject: { type: "collection", scope: "all" },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      progress: { completed: 0, total: null, stage: "queued" },
      canCancel: true,
      cancellationRequest: null,
      createdAt: "2026-08-13T01:00:00.000Z",
      startedAt: null,
      completedAt: null,
      nextAttemptAt: "2026-08-13T01:00:00.000Z",
      error: null,
      result: null,
    };
    const newJobs: NewAiJobAdapter = {
      submit: () => ({
        id: priorityView.id,
        kind: priorityView.kind,
        status: priorityView.status,
      }),
      get: (kind, id) => kind === "priority_assessment" && id === 1
        ? priorityView
        : undefined,
      cancel: () => priorityView,
    };
    const jobs = createDurableAiJobs({
      summary: createSummaryJobAdapter(fakeSummaryCatalog()),
      newJobs,
    });

    const legacy = jobs.get("summary:1");
    expect(legacy).toMatchObject({
      id: "summary:1",
      kind: "page_summary",
      status: "failed",
      canCancel: false,
      error: { type: "legacy_summary", message: "Superseded by opaque legacy behavior" },
    });
    expect(jobs.get("priority_assessment:1")).toEqual(priorityView);
    expect(() => jobs.cancel("summary:1")).toThrowError(
      expect.objectContaining({ code: "JOB_NOT_CANCELLABLE" }),
    );
    expect(fakeSummaryCatalog().getJob(1)?.status).toBe("failed");
  });

  it("validates tasks and routes submissions through the three-method seam", () => {
    let submitted: PriorityAssessmentTaskSpec | undefined;
    const ref: DurableJobRef = {
      id: "priority_assessment:2",
      kind: "priority_assessment",
      status: "queued",
    };
    const newJobs: NewAiJobAdapter = {
      submit: (task) => {
        submitted = task as PriorityAssessmentTaskSpec;
        return ref;
      },
      get: () => undefined,
      cancel: () => {
        throw new Error("not used");
      },
    };
    const jobs = createDurableAiJobs({
      summary: createSummaryJobAdapter(fakeSummaryCatalog()),
      newJobs,
    });
    expect(jobs.submit(priorityTask())).toEqual(ref);
    expect(submitted).toEqual(priorityTask());
    expect(() => jobs.get("priority_assessment:01"))
      .toThrowError(expect.objectContaining({ code: "INVALID_JOB_ID" }));
    expect(() => jobs.submit({ ...priorityTask(), stepBatchSize: 101 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
    expect(() => jobs.get("resource_research:3"))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
    expect(DurableAiJobError).toBeDefined();
  });

  it("validates and exposes durable declarative agent research replay", () => {
    const ref = {
      id: "resource_research:7" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    };
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 25,
      budget: { maxSteps: 4, maxTokens: 8_000, maxCostUsd: 0.5,
        maxWallTimeMs: 30_000 },
      confirmedOrigins: {
        authenticatedOriginDigests: [] as string[], sensitiveOriginDigests: [] as string[],
      },
      idempotencyKey: "agent-start-replay",
      authorizationRef: "user-instruction:agent-start-replay",
    };
    const newJobs: NewAiJobAdapter = {
      submit: () => ref,
      replayAgentResearchStart: (value) => value.question === request.question ? ref : undefined,
      get: () => undefined,
      cancel: () => {
        throw new Error("not used");
      },
    };
    const jobs = createDurableAiJobs({
      summary: createSummaryJobAdapter(fakeSummaryCatalog()), newJobs,
    });

    expect(jobs.replayAgentResearchStart(request)).toEqual(ref);
    expect(() => jobs.replayAgentResearchStart({
      ...request, parentReportId: null,
    } as never)).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
  });
});

describe("schema-23 AI job ledger", () => {
  it("makes every research mutation a literal zero-write operation while disabled", () => {
    const database = openSchema23Database();
    let available = true;
    let current = new Date("2026-08-13T01:00:00.000Z");
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: (kind) => kind !== "resource_research" || available,
      clock: () => current,
      token: () => "feature-off-research-lease-token",
    });
    try {
      ledger.submit({
        version: 1, kind: "resource_research",
        subject: { type: "selection", fingerprint: "f".repeat(64) },
        workflowRef: { id: "captured-only", version: 1 },
        inputFingerprint: "a".repeat(64), idempotencyKey: "feature-off-research",
        provenance: { requestedBy: "user", requestMethod: "manual" },
        schedulingPriority: 0,
        budget: { maxSteps: 10, maxTokens: 100, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      });
      const claim = ledger.claimNext("resource_research", "feature-worker", openClaimLimits)!;
      available = false;
      const totalChanges = () => database.connection.prepare(`SELECT total_changes()`).pluck()
        .get() as number;
      const before = totalChanges();
      const mutations = [
        () => ledger.cancel("resource_research", claim.id),
        () => ledger.checkpoint(claim, zeroCheckpoint(ledger, claim)),
        () => ledger.renew(claim),
        () => ledger.complete(claim, zeroCheckpoint(ledger, claim), {
          status: "succeeded" as const,
          result: { type: "resource_research" as const, reportId: 1 },
        }),
        () => ledger.completeResearch(claim, zeroCheckpoint(ledger, claim), {} as never),
        () => ledger.fail(claim, zeroCheckpoint(ledger, claim), {
          code: "JOB_INPUT_UNAVAILABLE" as const,
        }),
        () => ledger.bindAttemptProvider(claim, {
          provider: "test", model: "test", promptVersion: "v1",
        }),
        () => ledger.recordAttemptRequest(claim, "request-1"),
      ];
      for (const mutate of mutations) {
        expect(mutate).toThrowError(expect.objectContaining({ code: "JOB_KIND_UNAVAILABLE" }));
        expect(totalChanges()).toBe(before);
      }
      current = new Date("2026-08-13T01:02:00.000Z");
      expect(ledger.recoverInterrupted()).toBe(0);
      expect(totalChanges()).toBe(before);
      expect(ledger.get("resource_research", claim.id)?.status).toBe("running");
    } finally {
      database.close();
    }
  });
  it("is write-free when a kind is unavailable and applies canonical reuse rules", () => {
    let enabled = false;
    let tick = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date(`2026-08-13T01:00:0${tick++}.000Z`),
      kindAvailable: () => enabled,
      token: () => `lease-token-${String(tick).padStart(8, "0")}`,
    });
    try {
      expect(() => ledger.submit(priorityTask())).toThrowError(
        expect.objectContaining({ code: "JOB_KIND_UNAVAILABLE" }),
      );
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);

      enabled = true;
      const first = ledger.submit(priorityTask());
      expect(first).toMatchObject({
        id: "priority_assessment:1",
        kind: "priority_assessment",
        status: "queued",
      });
      expect(database.connection.prepare(`
        SELECT ruleset_id, ruleset_version, assessment_method,
          assessment_model_provider, assessment_model_name,
          assessment_prompt_version
        FROM ai_jobs WHERE id = 1
      `).get()).toEqual({
        ruleset_id: 1,
        ruleset_version: 1,
        assessment_method: "rule",
        assessment_model_provider: null,
        assessment_model_name: null,
        assessment_prompt_version: null,
      });
      expect(ledger.submit(priorityTask())).toEqual(first);
      expect(ledger.submit({
        ...priorityTask(),
        idempotencyKey: "same-input-other-key",
      })).toEqual(first);
      expect(() => ledger.submit({
        ...priorityTask(),
        schedulingPriority: 6,
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));

      database.connection.exec(`
        INSERT INTO priority_rule_versions (
          ruleset_id, version, rule_ast_json, natural_language_source,
          created_by, created_at
        )
        SELECT ruleset_id, 2, rule_ast_json, natural_language_source,
          created_by, created_at
        FROM priority_rule_versions WHERE ruleset_id = 1 AND version = 1
      `);
      const semanticSuccessorTask = {
        ...priorityTask(),
        idempotencyKey: "priority-model-ruleset-v2",
        ruleset: { rulesetId: 1, version: 2 },
        assessmentProvenance: {
          method: "model",
          model: {
            provider: "openai",
            name: "gpt-5",
            promptVersion: "priority-v2",
          },
        },
      } as const;
      const semanticSuccessor = ledger.submit(semanticSuccessorTask);
      expect(semanticSuccessor).toEqual(first);
      expect(ledger.get("priority_assessment", 1)?.status).toBe("queued");
      expect(database.connection.prepare(`
        SELECT ruleset_version, assessment_method, assessment_model_provider,
          assessment_model_name, assessment_prompt_version
        FROM ai_jobs WHERE id = 1
      `).get()).toEqual({
        ruleset_version: 1,
        assessment_method: "rule",
        assessment_model_provider: null,
        assessment_model_name: null,
        assessment_prompt_version: null,
      });

      enabled = false;
      const beforeDisabledClaim = {
        jobs: database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get(),
        attempts: database.connection.prepare("SELECT COUNT(*) FROM ai_job_attempts").pluck().get(),
        events: database.connection.prepare("SELECT COUNT(*) FROM ai_job_events").pluck().get(),
      };
      expect(() => ledger.claimNext(
        "priority_assessment", "disabled-worker", openClaimLimits,
      ))
        .toThrowError(expect.objectContaining({ code: "JOB_KIND_UNAVAILABLE" }));
      expect({
        jobs: database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get(),
        attempts: database.connection.prepare("SELECT COUNT(*) FROM ai_job_attempts").pluck().get(),
        events: database.connection.prepare("SELECT COUNT(*) FROM ai_job_events").pluck().get(),
      }).toEqual(beforeDisabledClaim);
      enabled = true;

      const successor = ledger.submit({
        ...semanticSuccessorTask,
        idempotencyKey: "changed-priority-input",
        inputFingerprint: "d".repeat(64),
      });
      expect(successor.id).toBe("priority_assessment:2");
      expect(ledger.get("priority_assessment", 1)?.status).toBe("superseded");
      expect(database.connection.prepare(`
        SELECT event_type FROM ai_job_events WHERE job_id = 1 ORDER BY sequence_no DESC LIMIT 1
      `).pluck().get()).toBe("superseded");
    } finally {
      database.close();
    }
  });

  it("reuses identical research but rejects changed active scope or budget", () => {
    const database = openSchema23Database();
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T01:00:00.000Z"),
      kindAvailable: () => true,
      token: () => "lease-token-research-1",
    });
    const task = {
      version: 1,
      kind: "resource_research",
      subject: { type: "selection", fingerprint: "e".repeat(64) },
      workflowRef: { id: "captured-only", version: 1 },
      inputFingerprint: "f".repeat(64),
      idempotencyKey: "research-v1",
      provenance: { requestedBy: "agent", requestMethod: "on_behalf_of_user",
        authorizationRef: "user-request-1" },
      schedulingPriority: 0,
      budget: { maxSteps: 10, maxTokens: 1_000, maxCostUsd: 1,
        maxWallTimeMs: 60_000 },
    } as const;
    try {
      const first = ledger.submit(task);
      expect(ledger.submit(task)).toEqual(first);
      expect(ledger.submit({ ...task, idempotencyKey: "research-identical-v1" }))
        .toEqual(first);
      expect(() => ledger.submit({
        ...task,
        idempotencyKey: "research-budget-v2",
        budget: { ...task.budget, maxCostUsd: 2 },
      })).toThrowError(expect.objectContaining({ code: "JOB_ACTIVE_CONFLICT" }));
      expect(() => ledger.submit({
        ...task,
        idempotencyKey: "research-v2",
        inputFingerprint: "0".repeat(64),
      })).toThrowError(expect.objectContaining({ code: "JOB_ACTIVE_CONFLICT" }));
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(1);
    } finally {
      database.close();
    }
  });

  it("cancels queued work immediately and running work at a fenced checkpoint", () => {
    let now = new Date("2026-08-13T01:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `lease-token-${String(++tokenNo).padStart(8, "0")}`,
    });
    try {
      const queued = ledger.submit(priorityTask());
      const cancelled = ledger.cancel("priority_assessment", 1, "user");
      expect(cancelled).toMatchObject({ status: "cancelled", canCancel: false });
      expect(() => ledger.cancel("priority_assessment", 1, "user"))
        .not.toThrow();
      expect(() => ledger.cancel("priority_assessment", 99, "user"))
        .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
      expect(queued.status).toBe("queued");

      now = new Date("2026-08-13T01:00:01.000Z");
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "running-cancel-v1",
        inputFingerprint: "9".repeat(64),
      });
      const claim = ledger.claimNext(
        "priority_assessment", "worker-one", openClaimLimits,
      );
      expect(claim).toMatchObject({ id: 2, attemptNo: 1, workerId: "worker-one" });
      now = new Date("2026-08-13T01:00:02.000Z");
      const requested = ledger.cancel("priority_assessment", 2, "agent");
      expect(requested).toMatchObject({
        status: "running",
        canCancel: false,
        cancellationRequest: { requestedBy: "agent", requestedAt: now.toISOString() },
      });
      expect(ledger.cancel("priority_assessment", 2, "agent")).toEqual(requested);
      const pendingLease = database.connection.prepare(`
        SELECT lease_expires_at, event_sequence FROM ai_jobs WHERE id = 2
      `).get();
      expect(ledger.renew(claim!)).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT lease_expires_at, event_sequence FROM ai_jobs WHERE id = 2
      `).get()).toEqual(pendingLease);
      now = new Date("2026-08-13T01:00:03.000Z");
      expect(completeWithConstantGuard(ledger, claim!, {
        progress: { completed: 1, total: 1, stage: "verified" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1 },
      })).toMatchObject({ completed: false, view: { status: "cancelled", result: null } });
      expect(() => ledger.checkpoint(claim!, {
        progress: { completed: 1, total: 10, stage: "batch" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 10 },
      })).toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      expect(() => completeWithConstantGuard(ledger, claim!, zeroCheckpoint(ledger, claim!)))
        .toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      expect(() => ledger.cancel("priority_assessment", 2, "user"))
        .not.toThrow();

      now = new Date("2026-08-13T01:00:04.000Z");
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "checkpoint-cancel-v1",
        inputFingerprint: "6".repeat(64),
      });
      const checkpointClaim = ledger.claimNext(
        "priority_assessment", "worker-two", openClaimLimits,
      )!;
      now = new Date("2026-08-13T01:00:05.000Z");
      ledger.cancel("priority_assessment", 3, "user");
      expect(ledger.checkpoint(checkpointClaim, {
        progress: { completed: 1, total: 10, stage: "batch" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 10 },
      })).toMatchObject({ status: "cancelled", canCancel: false });
    } finally {
      database.close();
    }
  });

  it("renews a 60-second fenced lease and recovers an expired attempt once", () => {
    let now = new Date("2026-08-13T02:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `lease-recovery-${String(++tokenNo).padStart(8, "0")}`,
    });
    try {
      expect(AI_JOB_LEASE_MS).toBe(60_000);
      expect(AI_JOB_RENEW_EVERY_MS).toBe(20_000);
      ledger.submit(priorityTask());
      const first = ledger.claimNext(
        "priority_assessment", "worker-a", openClaimLimits,
      )!;
      expect(first.leaseExpiresAt).toBe("2026-08-13T02:01:00.000Z");
      expect(() => ledger.fail(first, zeroCheckpoint(ledger, first),
        { code: "ARBITRARY_FAILURE" } as never))
        .toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.checkpoint({ ...first, attemptId: first.attemptId + 999 }, {
        progress: { completed: 1, total: null, stage: "forged-attempt" },
        checkpoint: { version: 1, nextOffset: 1 },
          usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1 },
      })).toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      now = new Date("2026-08-13T02:00:20.000Z");
      const renewed = ledger.renew(first);
      expect(renewed).toBeDefined();
      if (renewed === undefined) throw new Error("expected renewed lease");
      expect(renewed.leaseExpiresAt).toBe("2026-08-13T02:01:20.000Z");
      expect(renewed.leaseToken).toBe(first.leaseToken);

      now = new Date("2026-08-13T02:01:20.001Z");
      expect(ledger.recoverInterrupted()).toBe(1);
      expect(ledger.recoverInterrupted()).toBe(0);
      expect(ledger.get("priority_assessment", 1)).toMatchObject({ status: "queued" });
      expect(database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(first.attemptId)).toBe("interrupted");
      expect(() => ledger.checkpoint(first, {
        progress: { completed: 1, total: null, stage: "stale" },
        checkpoint: { version: 1, nextOffset: 1 },
          usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1 },
      })).toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      const staleEvents = database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      for (const staleCall of [
        () => ledger.renew(first),
        () => ledger.bindAttemptProvider(first, {
          provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
        }),
        () => ledger.recordAttemptRequest(first, "stale-request"),
        () => ledger.fail(first, zeroCheckpoint(ledger, first), {
          code: "JOB_INPUT_UNAVAILABLE",
        }),
        () => ledger.completePartial(first, {
          checkpoint: zeroCheckpoint(ledger, first),
          manifest: { version: 1, initialDenominator: 1, observedDenominator: 1 },
        }),
        () => completeWithConstantGuard(ledger, first, zeroCheckpoint(ledger, first)),
      ]) {
        expect(staleCall).toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      }
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(staleEvents);

      const second = ledger.claimNext(
        "priority_assessment", "worker-b", openClaimLimits,
      )!;
      expect(second.leaseToken).not.toBe(first.leaseToken);
      expect(second.attemptNo).toBe(2);
      now = new Date("2026-08-13T02:01:21.000Z");
      expect(ledger.fail(second, zeroCheckpoint(ledger, second), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-13T02:01:30.000Z",
      })).toMatchObject({ status: "queued" });
      expect(database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(second.attemptId)).toBe("interrupted");
      now = new Date("2026-08-13T02:01:30.000Z");
      const third = ledger.claimNext(
        "priority_assessment", "worker-c", openClaimLimits,
      )!;
      now = new Date("2026-08-13T02:02:30.001Z");
      expect(ledger.recoverInterrupted()).toBe(1);
      expect(ledger.get("priority_assessment", 1)).toMatchObject({
        status: "failed",
        error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(third.attemptId)).toBe("interrupted");
      expect(() => completeWithConstantGuard(ledger, third, zeroCheckpoint(ledger, third)))
        .toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
    } finally {
      database.close();
    }
  });

  it("refreshes the validated execution envelope without writing ledger state", () => {
    let now = new Date("2026-08-13T02:30:00.000Z");
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "refresh-execution-token-0001",
    });
    try {
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "refresh-worker", openClaimLimits,
      )!;
      const progressed = ledger.checkpoint(claim, {
        progress: { completed: 1, total: null, stage: "batch" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: {
          steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 12,
        },
      });
      expect(progressed.status).toBe("running");
      const eventsBefore = database.connection.prepare(
        "SELECT COUNT(*) FROM ai_job_events WHERE job_id=1",
      ).pluck().get();
      const refreshed = ledger.refresh(claim);
      expect(refreshed).toMatchObject({
        progress: { completed: 1, total: null, stage: "batch" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, wallTimeMs: 12 },
      });
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM ai_job_events WHERE job_id=1",
      ).pluck().get()).toBe(eventsBefore);

      now = new Date("2026-08-13T02:31:00.001Z");
      expect(() => ledger.refresh(claim)).toThrowError(
        expect.objectContaining({ code: "JOB_LEASE_LOST" }),
      );
    } finally {
      database.close();
    }
  });

  it("recovers an expired cancellation once across two connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-recover-cancel-"));
    const path = join(directory, "recover.sqlite");
    let now = new Date("2026-08-13T02:10:00.000Z");
    const firstDatabase = openDatabase(path);
    const secondDatabase = openDatabase(path);
    const first = createAiJobLedger(firstDatabase.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "recover-cancel-token-0001",
    });
    const second = createAiJobLedger(secondDatabase.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "recover-cancel-token-0002",
    });
    try {
      first.submit(priorityTask());
      const claim = first.claimNext(
        "priority_assessment", "recover-cancel-worker", openClaimLimits,
      )!;
      now = new Date("2026-08-13T02:10:01.000Z");
      first.cancel("priority_assessment", claim.id, "user");
      now = new Date("2026-08-13T02:11:00.001Z");
      const recovered = await Promise.all([
        Promise.resolve().then(() => first.recoverInterrupted()),
        Promise.resolve().then(() => second.recoverInterrupted()),
      ]);
      expect(recovered.sort()).toEqual([0, 1]);
      expect(first.get("priority_assessment", claim.id)).toMatchObject({
        status: "cancelled",
        cancellationRequest: { requestedBy: "user" },
      });
      expect(firstDatabase.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(claim.attemptId)).toBe("interrupted");
      expect(firstDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events
        WHERE job_id = ? AND event_type = 'cancelled'
      `).pluck().get(claim.id)).toBe(1);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes only kind-matched typed results and rejects terminal cancellation", () => {
    let now = new Date("2026-08-13T02:30:00.000Z");
    let tokenNo = 0;
    const database = openSchema23Database();
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `typed-result-${String(++tokenNo).padStart(8, "0")}`,
    });
    try {
      ledger.submit(priorityTask());
      const priorityClaim = ledger.claimNext(
        "priority_assessment", "priority-worker", openClaimLimits,
      )!;
      now = new Date("2026-08-13T02:30:01.000Z");
      const beforePlainPriority = database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      expect(() => ledger.complete(priorityClaim, zeroCheckpoint(ledger, priorityClaim), {
        status: "succeeded",
        result: { type: "resource_research", reportId: 1 },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(beforePlainPriority);
      const succeeded = completeWithConstantGuard(ledger, priorityClaim, {
        progress: { completed: 1, total: 1, stage: "verified" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1 },
      });
      expect(succeeded).toMatchObject({
        completed: true,
        view: {
          status: "succeeded",
          result: { type: "priority_assessment",
            outputFingerprint: AI_JOB_TEST_GUARD_FINGERPRINT },
          canCancel: false,
        },
      });
      expect(() => ledger.cancel("priority_assessment", 1, "user"))
        .toThrowError(expect.objectContaining({ code: "JOB_NOT_CANCELLABLE" }));

      now = new Date("2026-08-13T02:30:02.000Z");
      const researchTask = {
        version: 1,
        kind: "resource_research",
        subject: { type: "selection", fingerprint: "4".repeat(64) },
        workflowRef: { id: "captured-only", version: 1 },
        inputFingerprint: "3".repeat(64),
        idempotencyKey: "partial-research-v1",
        provenance: { requestedBy: "system", requestMethod: "scheduled" },
        schedulingPriority: 0,
        budget: { maxSteps: 2, maxTokens: 0, maxCostUsd: 0,
          maxWallTimeMs: 60_000 },
      } as const;
      ledger.submit(researchTask);
      const researchClaim = ledger.claimNext(
        "resource_research", "research-worker", openClaimLimits,
      )!;
      now = new Date("2026-08-13T02:30:03.000Z");
      expect(ledger.complete(researchClaim, zeroCheckpoint(ledger, researchClaim), {
        status: "partial",
        diagnostic: { code: "JOB_BUDGET_EXHAUSTED" },
        result: { type: "resource_research", reportId: 77 },
      })).toMatchObject({
        status: "partial",
        result: { type: "resource_research", reportId: 77 },
        error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(() => ledger.cancel("resource_research", 2, "user"))
        .toThrowError(expect.objectContaining({ code: "JOB_NOT_CANCELLABLE" }));
    } finally {
      database.close();
    }
  });

  it("publishes only ledger-derived priority partials after provable exhaustion", () => {
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T02:45:00.000Z"),
      kindAvailable: () => true,
      token: () => "priority-partial-token-0001",
    });
    try {
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "priority-partial-worker", openClaimLimits,
      )!;
      const checkpoint = {
        progress: { completed: 1, total: 1, stage: "partial" },
        checkpoint: { version: 1 as const, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 1 },
      };
      const before = database.connection.prepare(`
        SELECT event_sequence, spent_steps FROM ai_jobs WHERE id = 1
      `).get();
      expect(() => ledger.completePartial(claim, {
        checkpoint,
        manifest: { version: 1, initialDenominator: 1, observedDenominator: 1 },
        outputFingerprint: "4".repeat(64),
      } as never)).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completePartial(claim, {
        checkpoint,
        manifest: { version: 1, initialDenominator: 1, observedDenominator: 1 },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      expect(database.connection.prepare(`
        SELECT event_sequence, spent_steps FROM ai_jobs WHERE id = 1
      `).get()).toEqual(before);

      const exhaustedCheckpoint = {
        ...checkpoint,
        usage: { ...checkpoint.usage, wallTimeMs: 60_000 },
      };
      const partial = ledger.completePartial(claim, {
        checkpoint: exhaustedCheckpoint,
        manifest: { version: 1, initialDenominator: 1, observedDenominator: 0 },
      });
      expect(partial).toMatchObject({
        status: "partial",
        result: { type: "priority_assessment" },
        error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(partial.result?.type === "priority_assessment" &&
        partial.result.outputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(database.connection.prepare(`
        SELECT event_type, error_code FROM ai_job_events
        WHERE job_id = 1 ORDER BY sequence_no DESC LIMIT 1
      `).get()).toEqual({
        event_type: "partial",
        error_code: "JOB_BUDGET_EXHAUSTED",
      });
    } finally {
      database.close();
    }
  });

  it("publishes a ledger-derived non-coverage partial for a proven guard envelope limit", () => {
    const database = openDatabase(":memory:");
    let leaseNo = 0;
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T02:47:00.000Z"),
      kindAvailable: () => true,
      token: () => `priority-guard-limit-token-${String(++leaseNo).padStart(4, "0")}`,
      guards: {
        guard_limit_rows_v1: {
          sql: `WITH RECURSIVE rows(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM rows WHERE value < ?
          ) SELECT value FROM rows`,
          parameters: ["positive_safe_integer"],
          usage: { stepsPerRow: 1 },
        },
        guard_limit_bytes_v1: {
          sql: "SELECT printf('%.*c', ?, 'x') AS value",
          parameters: ["positive_safe_integer"],
          usage: { stepsPerRow: 1 },
        },
      },
    });
    try {
      ledger.submit({
        ...priorityTask(),
        subject: { type: "collection", scope: "all" },
        idempotencyKey: "priority-guard-limit-partial",
        budget: { ...priorityTask().budget, maxSteps: 120_012 },
      });
      const claim = ledger.claimNext(
        "priority_assessment", "priority-guard-limit-worker", openClaimLimits,
      )!;
      const checkpoint = {
        progress: { completed: 0, total: null, stage: "guard-limit-preflight" },
        checkpoint: { version: 1 as const, nextOffset: 0 },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 1 },
      };
      const partial = ledger.completePartialIfGuardLimit(claim, {
        checkpoint,
        guard: { guardId: "guard_limit_rows_v1", args: [10_001] },
        initialDenominator: 10_001,
        maxCycles: 4,
      });
      expect(partial).toMatchObject({
        completed: true,
        view: {
          status: "partial",
          result: { type: "priority_assessment" },
          error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
        },
      });
      expect(partial.view.result?.type === "priority_assessment" &&
        partial.view.result.outputFingerprint).toMatch(/^[0-9a-f]{64}$/);

      ledger.submit({
        ...priorityTask(),
        subject: { type: "collection", scope: "all" },
        idempotencyKey: "priority-guard-byte-limit-partial",
        inputFingerprint: "b".repeat(64),
        budget: { ...priorityTask().budget, maxSteps: 12 },
      });
      const byteClaim = ledger.claimNext(
        "priority_assessment", "priority-guard-byte-limit-worker", openClaimLimits,
      )!;
      expect(ledger.completePartialIfGuardLimit(byteClaim, {
        checkpoint: {
          progress: { completed: 0, total: null, stage: "guard-limit-preflight" },
          checkpoint: { version: 1, nextOffset: 0 },
          usage: { steps: 0, inputTokens: 0, outputTokens: 0,
            costUsd: 0, wallTimeMs: 1 },
        },
        guard: { guardId: "guard_limit_bytes_v1", args: [4_194_305] },
        initialDenominator: 1,
        maxCycles: 4,
      })).toMatchObject({ completed: true, view: { status: "partial" } });

      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "priority-guard-limit-race-fixpoint",
        inputFingerprint: "d".repeat(64),
        budget: { ...priorityTask().budget, maxSteps: 20 },
      });
      const raceClaim = ledger.claimNext(
        "priority_assessment", "priority-guard-limit-race-worker", openClaimLimits,
      )!;
      const raceInput = {
        checkpoint: {
          progress: { completed: 0, total: null, stage: "guard-limit-preflight" },
          checkpoint: { version: 1 as const, nextOffset: 0 },
          usage: { steps: 0, inputTokens: 0, outputTokens: 0,
            costUsd: 0, wallTimeMs: 0 },
        },
        guard: { guardId: "guard_limit_rows_v1", args: [1] },
        initialDenominator: 10_001,
        maxCycles: 4 as const,
      };
      for (let cycle = 1; cycle < 4; cycle += 1) {
        expect(ledger.completePartialIfGuardLimit(raceClaim, raceInput)).toMatchObject({
          completed: false,
          view: { status: "running", progress: { stage: `ledger:guard-cycle:${cycle}` } },
        });
      }
      expect(ledger.completePartialIfGuardLimit(raceClaim, raceInput)).toMatchObject({
        completed: true,
        view: { status: "partial", progress: { stage: "ledger:guard-cycle:4" } },
      });

      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (9001, 'https://guard-limit.test/', 'https://guard-limit.test/',
          'https://guard-limit.test/', '2026-08-13T02:47:00.000Z',
          '2026-08-13T02:47:00.000Z')
      `);
      ledger.submit({
        ...priorityTask(),
        subject: { type: "page", logicalPageId: 9001 },
        idempotencyKey: "priority-single-cannot-claim-guard-limit",
        inputFingerprint: "c".repeat(64),
      });
      const singleClaim = ledger.claimNext(
        "priority_assessment", "priority-single-limit-worker", openClaimLimits,
      )!;
      expect(() => ledger.completePartialIfGuardLimit(singleClaim, {
        checkpoint: {
          progress: { completed: 0, total: 1, stage: "guard-limit-preflight" },
          checkpoint: { version: 1, nextOffset: 0 },
          usage: { steps: 0, inputTokens: 0, outputTokens: 0,
            costUsd: 0, wallTimeMs: 1 },
        },
        guard: { guardId: "guard_limit_bytes_v1", args: [4_194_305] },
        initialDenominator: 1,
        maxCycles: 4,
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
    } finally {
      database.close();
    }
  });

  it("charges guard rows and elapsed time and derives final mismatch partials", () => {
    let now = new Date("2026-08-13T02:50:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    database.connection.function("guard_tick", () => {
      now = new Date(now.getTime() + 7);
      return 1;
    });
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `guard-usage-token-${String(++tokenNo).padStart(4, "0")}`,
      guards: {
        two_rows: {
          sql: "SELECT guard_tick() AS covered UNION ALL SELECT 2",
          parameters: [],
          usage: { stepsPerRow: 1 },
        },
      },
    });
    const mismatchInput = (completed: number): AiJobGuardedCompletion => ({
      checkpoint: {
        progress: { completed, total: 2, stage: `mismatch-${completed}` },
        checkpoint: { version: 1, nextOffset: completed },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 0 },
      },
      guard: { guardId: "two_rows", args: [], expectedFingerprint: "0".repeat(64) },
      completion: {
        status: "succeeded",
        result: { type: "priority_assessment", outputFingerprint: "0".repeat(64) },
      },
      onMismatch: { terminalPartial: { version: 1, initialDenominator: 2 } },
    });
    try {
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "guard-accounting-final-cycle",
        budget: { ...priorityTask().budget, maxSteps: 4 },
      });
      const claim = ledger.claimNext(
        "priority_assessment", "guard-accounting-worker", openClaimLimits,
      )!;
      expect(ledger.completeIf(claim, mismatchInput(1))).toMatchObject({
        completed: false,
        view: { status: "running", result: null },
      });
      expect(database.connection.prepare(`
        SELECT spent_steps, spent_wall_time_ms FROM ai_jobs WHERE id = 1
      `).get()).toEqual({ spent_steps: 2, spent_wall_time_ms: 7 });

      const terminal = ledger.completeIf(claim, mismatchInput(2));
      const expectedFingerprint = testFingerprint({
        version: 1,
        coverage: false,
        status: "partial",
        diagnostic: { code: "JOB_BUDGET_EXHAUSTED" },
        subject: { type: "collection", scope: "all" },
        ruleset: { rulesetId: 1, version: 1 },
        initialDenominator: 2,
        observedDenominator: 2,
        completedSteps: 4,
        progress: { completed: 2, total: 2, stage: "ledger:guard-cycle:2" },
        checkpoint: { nextOffset: 0, version: 1 },
      });
      expect(terminal).toMatchObject({
        completed: true,
        view: {
          status: "partial",
          result: { type: "priority_assessment", outputFingerprint: expectedFingerprint },
          error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
        },
      });
      expect(database.connection.prepare(`
        SELECT spent_steps, spent_wall_time_ms FROM ai_jobs WHERE id = 1
      `).get()).toEqual({ spent_steps: 4, spent_wall_time_ms: 14 });

      now = new Date("2026-08-13T02:51:00.000Z");
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "guard-accounting-overflow",
        inputFingerprint: "d".repeat(64),
        budget: { ...priorityTask().budget, maxWallTimeMs: 5 },
      });
      const overflowClaim = ledger.claimNext(
        "priority_assessment", "guard-overflow-worker", openClaimLimits,
      )!;
      const before = database.connection.prepare(`
        SELECT event_sequence, spent_steps, spent_wall_time_ms FROM ai_jobs WHERE id = 2
      `).get();
      expect(() => ledger.completeIf(overflowClaim, mismatchInput(1)))
        .toThrowError(expect.objectContaining({ code: "JOB_BUDGET_EXHAUSTED" }));
      expect(database.connection.prepare(`
        SELECT event_sequence, spent_steps, spent_wall_time_ms FROM ai_jobs WHERE id = 2
      `).get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("uses persisted guarded mismatches to enforce the collection fixpoint cycle limit", () => {
    const database = openDatabase(":memory:");
    let leaseNo = 0;
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T02:55:00.000Z"),
      kindAvailable: () => true,
      token: () => `fixpoint-cycle-token-${String(++leaseNo).padStart(4, "0")}`,
      guards: {
        one_row: {
          sql: "SELECT 1 AS covered",
          parameters: [],
          usage: { stepsPerRow: 1 },
        },
      },
    });
    try {
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "fixpoint-cycle-limit",
        budget: { ...priorityTask().budget, maxSteps: 100 },
      });
      const claim = ledger.claimNext(
        "priority_assessment", "fixpoint-cycle-worker", openClaimLimits,
      )!;
      const mismatch = (completed: number): AiJobGuardedCompletion => ({
        checkpoint: {
          progress: { completed, total: 4, stage: "preflight" },
          checkpoint: { version: 1, nextOffset: 0 },
          usage: { steps: 1, inputTokens: 0, outputTokens: 0,
            costUsd: 0, wallTimeMs: 0 },
        },
        guard: { guardId: "one_row", args: [], expectedFingerprint: "0".repeat(64) },
        completion: {
          status: "succeeded",
          result: { type: "priority_assessment", outputFingerprint: "0".repeat(64) },
        },
        onMismatch: { terminalPartial: {
          version: 1, initialDenominator: 100, maxCycles: 4,
        } },
      });
      expect(() => ledger.checkpoint(claim, {
        progress: { completed: 0, total: 4, stage: "ledger:guard-cycle:99" },
        checkpoint: { version: 1, nextOffset: 0 },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 0 },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      for (let cycle = 1; cycle < 4; cycle += 1) {
        expect(ledger.completeIf(claim, mismatch(cycle))).toMatchObject({
          completed: false,
          view: { status: "running", progress: { stage: `ledger:guard-cycle:${cycle}` } },
        });
        if (cycle === 1) {
          for (let renewal = 0; renewal < 5; renewal += 1) {
            expect(ledger.renew(claim)).toBeDefined();
          }
        }
      }
      const terminal = ledger.completeIf(claim, mismatch(4));
      expect(terminal).toMatchObject({
        completed: true,
        view: {
          status: "partial",
          progress: { stage: "ledger:guard-cycle:4" },
          error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
        },
      });
      expect(database.connection.prepare(
        "SELECT spent_steps FROM ai_jobs WHERE id = 1",
      ).pluck().get()).toBe(8);
      const expectedFingerprint = testFingerprint({
        version: 1,
        coverage: false,
        status: "partial",
        diagnostic: { code: "JOB_BUDGET_EXHAUSTED" },
        subject: { type: "collection", scope: "all" },
        ruleset: { rulesetId: 1, version: 1 },
        initialDenominator: 100,
        observedDenominator: 1,
        fixpointLimit: { maxCycles: 4, observedCycles: 4 },
        completedSteps: 8,
        progress: { completed: 4, total: 4, stage: "ledger:guard-cycle:4" },
        checkpoint: { nextOffset: 0, version: 1 },
      });
      expect(terminal.view.result).toEqual({
        type: "priority_assessment", outputFingerprint: expectedFingerprint,
      });
    } finally {
      database.close();
    }
  });

  it("rejects unsafe guard registries and keeps guard data private", () => {
    const database = openDatabase(":memory:");
    const sentinel = "PRIVATE_GUARD_SENTINEL_71c4";
    try {
      for (const definition of [
        { sql: "UPDATE ai_jobs SET status = 'failed'", parameters: [],
          usage: { stepsPerRow: 1 } },
        { sql: "CREATE TABLE leaked_guard(value TEXT)", parameters: [],
          usage: { stepsPerRow: 1 } },
        { sql: "PRAGMA user_version", parameters: [], usage: { stepsPerRow: 1 } },
        { sql: `SELECT 1; SELECT '${sentinel}'`, parameters: [],
          usage: { stepsPerRow: 1 } },
        { sql: "SELECT 1", parameters: [], usage: { stepsPerRow: 2 } },
        { sql: "SELECT 1", parameters: ["unknown"], usage: { stepsPerRow: 1 } },
      ]) {
        let caught: unknown;
        try {
          createBaseAiJobLedger(database.connection, {
            clock: () => new Date("2026-08-13T02:55:00.000Z"),
            kindAvailable: () => true,
            guards: { unsafe: definition as never },
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: "INVALID_JOB_INPUT" });
        expect(String((caught as Error).message)).not.toContain(sentinel);
      }

      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date("2026-08-13T02:55:00.000Z"),
        kindAvailable: () => true,
        token: () => "private-guard-token-0001",
        guards: {
          private_rows: {
            sql: `SELECT '${sentinel}' AS private_value`,
            parameters: [],
            usage: { stepsPerRow: 1 },
          },
        },
      });
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "private-guard-worker", openClaimLimits,
      )!;
      let caught: unknown;
      try {
        ledger.completeIf(claim, {
          ...guardedInput(zeroCheckpoint(ledger, claim), false),
          guard: {
            guardId: "private_rows",
            args: [],
            expectedFingerprint: "0".repeat(64),
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeUndefined();
      const persisted = database.connection.prepare(`
        SELECT group_concat(value, '|') FROM (
          SELECT progress_stage AS value FROM ai_jobs
          UNION ALL SELECT COALESCE(error_message, '') FROM ai_jobs
          UNION ALL SELECT COALESCE(error_code, '') FROM ai_job_events
        )
      `).pluck().get();
      expect(String(persisted)).not.toContain(sentinel);
      expect(String(persisted)).not.toContain("SELECT");
    } finally {
      database.close();
    }
  });

  it("permits model partials before a call or after exact provider binding", () => {
    let now = new Date("2026-08-13T02:57:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `model-partial-token-${String(++tokenNo).padStart(4, "0")}`,
    });
    const task = (key: string, inputFingerprint: string) => ({
      ...priorityTask(),
      idempotencyKey: key,
      inputFingerprint,
      assessmentProvenance: {
        method: "model" as const,
        model: { provider: "openai", name: "gpt-5", promptVersion: "priority-v1" },
      },
      budget: { ...priorityTask().budget, maxSteps: 1 },
    });
    const partialInput = {
      checkpoint: {
        progress: { completed: 1, total: 1, stage: "preflight-exhausted" },
        checkpoint: { version: 1 as const, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 1 },
      },
      manifest: { version: 1 as const, initialDenominator: 1,
        observedDenominator: 1 },
    };
    try {
      ledger.submit(task("model-unbound-partial", "1".repeat(64)));
      const unbound = ledger.claimNext(
        "priority_assessment", "model-unbound-worker", openClaimLimits,
      )!;
      expect(ledger.completePartial(unbound, partialInput)).toMatchObject({
        status: "partial",
        error: { type: "durable", code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(database.connection.prepare(`
        SELECT provider, model, prompt_version, outcome
        FROM ai_job_attempts WHERE id = ?
      `).get(unbound.attemptId)).toEqual({
        provider: null, model: null, prompt_version: null, outcome: "partial",
      });

      now = new Date("2026-08-13T02:57:01.000Z");
      ledger.submit(task("model-bound-partial", "2".repeat(64)));
      const bound = ledger.claimNext(
        "priority_assessment", "model-bound-worker", openClaimLimits,
      )!;
      expect(() => database.connection.prepare(`
        UPDATE ai_job_attempts SET provider = 'partial-only' WHERE id = ?
      `).run(bound.attemptId)).toThrow();
      ledger.bindAttemptProvider(bound, {
        provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
      });
      expect(ledger.completePartial(bound, partialInput)).toMatchObject({ status: "partial" });
      expect(database.connection.prepare(`
        SELECT provider, model, prompt_version, outcome
        FROM ai_job_attempts WHERE id = ?
      `).get(bound.attemptId)).toEqual({
        provider: "openai", model: "gpt-5", prompt_version: "priority-v1",
        outcome: "partial",
      });

      now = new Date("2026-08-13T02:57:02.000Z");
      ledger.submit(task("model-cancel-before-bind", "3".repeat(64)));
      const cancelledBeforeBind = ledger.claimNext(
        "priority_assessment", "model-cancel-before-bind-worker", openClaimLimits,
      )!;
      ledger.cancel("priority_assessment", cancelledBeforeBind.id, "user");
      expect(() => ledger.bindAttemptProvider(cancelledBeforeBind, {
        provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));

      now = new Date("2026-08-13T02:57:03.000Z");
      ledger.checkpoint(cancelledBeforeBind, {
        progress: { completed: 0, total: 1, stage: "cancelled" },
        checkpoint: { version: 1, nextOffset: 0 },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 0 },
      });
      ledger.submit(task("model-cancel-after-bind", "4".repeat(64)));
      const cancelledAfterBind = ledger.claimNext(
        "priority_assessment", "model-cancel-after-bind-worker", openClaimLimits,
      )!;
      ledger.bindAttemptProvider(cancelledAfterBind, {
        provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
      });
      ledger.cancel("priority_assessment", cancelledAfterBind.id, "agent");
      expect(() => ledger.recordAttemptRequest(cancelledAfterBind, "returned-request-id"))
        .not.toThrow();
    } finally {
      database.close();
    }
  });

  it("fails closed on corrupted storage and never persists rejected private payloads", () => {
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T03:00:00.000Z"),
      kindAvailable: () => true,
      token: () => "privacy-lease-token-0001",
    });
    const jobs = createDurableAiJobs({
      summary: createSummaryJobAdapter(fakeSummaryCatalog()),
      newJobs: ledger,
    });
    const sentinel = "PRIVATE_LOCAL_ONLY_SENTINEL_9f0a";
    try {
      let caught: unknown;
      try {
        jobs.submit({ ...priorityTask(), prompt: sentinel } as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "INVALID_JOB_INPUT" });
      expect(String((caught as Error).message)).not.toContain(sentinel);
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(0);

      ledger.submit(priorityTask());
      database.connection.pragma("ignore_check_constraints = ON");
      database.connection.exec("DROP TRIGGER ai_jobs_identity_immutable");
      database.connection.prepare(`
        UPDATE ai_jobs SET subject_key = 'corrupt:subject' WHERE id = 1
      `).run();
      database.connection.pragma("ignore_check_constraints = OFF");
      expect(() => ledger.get("priority_assessment", 1))
        .toThrowError(expect.objectContaining({ code: "JOB_STORAGE_CORRUPT" }));
      const persistedText = database.connection.prepare(`
        SELECT group_concat(value, '|') FROM (
          SELECT idempotency_key AS value FROM ai_jobs
          UNION ALL SELECT progress_stage FROM ai_jobs
          UNION ALL SELECT COALESCE(error_message, '') FROM ai_jobs
        )
      `).pluck().get();
      expect(String(persistedText)).not.toContain(sentinel);
    } finally {
      database.close();
    }
  });

  it("reconstructs a validated execution envelope after process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-restart-"));
    const path = join(directory, "restart.sqlite");
    let now = new Date("2026-08-13T05:00:00.000Z");
    const task = {
      ...priorityTask(),
      idempotencyKey: "restart-model-priority-v1",
      budget: {
        ...priorityTask().budget,
        maxTokens: 100,
        maxCostUsd: 1,
      },
      assessmentProvenance: {
        method: "model",
        model: {
          provider: "openai",
          name: "gpt-5",
          promptVersion: "priority-v1",
        },
      },
    } as const;
    try {
      const firstDatabase = openDatabase(path);
      try {
        const first = createAiJobLedger(firstDatabase.connection, {
          clock: () => now,
          kindAvailable: () => true,
          token: () => "restart-lease-token-0001",
        });
        first.submit(task);
        const claim = first.claimNext(
          "priority_assessment", "restart-worker-1", openClaimLimits,
        )!;
        expect(claim).toMatchObject({
          task,
          inputFingerprint: task.inputFingerprint,
          createdAt: "2026-08-13T05:00:00.000Z",
          progress: { completed: 0, total: null, stage: "queued" },
          checkpoint: null,
          usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
        });
        now = new Date("2026-08-13T05:00:20.000Z");
        first.checkpoint(claim, {
          progress: { completed: 25, total: 100, stage: "priority-batch" },
          checkpoint: { version: 1, nextOffset: 25 },
          usage: { steps: 1, inputTokens: 12, outputTokens: 8, costUsd: 0.01, wallTimeMs: 2_000 },
        });
      } finally {
        firstDatabase.close();
      }

      now = new Date("2026-08-13T05:01:20.001Z");
      const restartedDatabase = openDatabase(path);
      try {
        const restarted = createAiJobLedger(restartedDatabase.connection, {
          clock: () => now,
          kindAvailable: () => true,
          token: () => "restart-lease-token-0002",
        });
        expect(restarted.recoverInterrupted()).toBe(1);
        const resumed = restarted.claimNext(
          "priority_assessment",
          "restart-worker-2",
          openClaimLimits,
        )!;
        expect(resumed).toMatchObject({
          attemptNo: 2,
          task,
          inputFingerprint: task.inputFingerprint,
          createdAt: "2026-08-13T05:00:00.000Z",
          progress: { completed: 25, total: 100, stage: "priority-batch" },
          checkpoint: { version: 1, nextOffset: 25 },
          usage: { steps: 1, inputTokens: 12, outputTokens: 8, costUsd: 0.01, wallTimeMs: 2_000 },
        });
      } finally {
        restartedDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically enforces exact daily cost and attempt caps across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-limits-"));
    const path = join(directory, "limits.sqlite");
    let now = new Date("2026-08-13T23:58:00.000Z");
    const task = {
      ...priorityTask(),
      assessmentProvenance: {
        method: "model" as const,
        model: { provider: "test", name: "model", promptVersion: "v1" },
      },
      idempotencyKey: "daily-limit-priority-v1",
      budget: { ...priorityTask().budget, maxTokens: 100, maxCostUsd: 0.6 },
    };
    try {
      const firstDatabase = openDatabase(path);
      try {
        const first = createAiJobLedger(firstDatabase.connection, {
          clock: () => now,
          kindAvailable: () => true,
          token: () => "daily-limit-token-0001",
        });
        first.submit(task);
        const claim = first.claimNext("priority_assessment", "limit-worker-1", {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 0.7,
        })!;
        first.bindAttemptProvider(claim, {
          provider: "test", model: "model", promptVersion: "v1",
        });
        now = new Date("2026-08-13T23:58:05.000Z");
        first.checkpoint(claim, {
          progress: { completed: 0, total: 2, stage: "paid-attempt-start" },
          checkpoint: { version: 1, nextOffset: 0 },
          usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.2, wallTimeMs: 50 },
        });
        now = new Date("2026-08-13T23:58:10.000Z");
        first.checkpoint(claim, {
          progress: { completed: 1, total: 2, stage: "paid-attempt" },
          checkpoint: { version: 1, nextOffset: 1 },
          usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0.3, wallTimeMs: 50 },
        });
        now = new Date("2026-08-13T23:58:20.000Z");
        first.fail(claim, zeroCheckpoint(first, claim), {
          code: "JOB_INPUT_UNAVAILABLE",
          retryAt: "2026-08-13T23:58:21.000Z",
        });
        expect(firstDatabase.connection.prepare(`
          SELECT outcome, cost_usd FROM ai_job_attempts WHERE id = ?
        `).get(claim.attemptId)).toEqual({ outcome: "interrupted", cost_usd: 0.5 });
      } finally {
        firstDatabase.close();
      }

      now = new Date("2026-08-13T23:58:21.000Z");
      const restartedDatabase = openDatabase(path);
      try {
        const restarted = createAiJobLedger(restartedDatabase.connection, {
          clock: () => now,
          kindAvailable: () => true,
          token: () => "daily-limit-token-0002",
        });
        expect(restarted.claimNext("priority_assessment", "limit-worker-2", {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 10,
          maxCostUsdPerUtcDay: 0.5,
        })).toBeUndefined();
        expect(restartedDatabase.connection.prepare(`
          SELECT status, available_at FROM ai_jobs WHERE id = 1
        `).get()).toEqual({
          status: "queued",
          available_at: "2026-08-14T00:00:00.000Z",
        });
        expect(restartedDatabase.connection.prepare(`
          SELECT event_type FROM ai_job_events
          WHERE job_id = 1 ORDER BY sequence_no DESC LIMIT 1
        `).pluck().get()).toBe("deferred");

        now = new Date("2026-08-14T00:00:00.000Z");
        const second = restarted.claimNext("priority_assessment", "limit-worker-2", {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 1,
          maxCostUsdPerUtcDay: 0.5,
        })!;
        restarted.bindAttemptProvider(second, {
          provider: "test", model: "model", promptVersion: "v1",
        });
        now = new Date("2026-08-14T00:00:01.000Z");
        restarted.fail(second, zeroCheckpoint(restarted, second), {
          code: "JOB_INPUT_UNAVAILABLE",
          retryAt: "2026-08-14T00:00:02.000Z",
        });
        now = new Date("2026-08-14T00:00:02.000Z");
        expect(restarted.claimNext("priority_assessment", "limit-worker-3", {
          maxConcurrent: 1,
          maxAttemptsPerUtcDay: 1,
          maxCostUsdPerUtcDay: null,
        })).toBeUndefined();
        expect(restartedDatabase.connection.prepare(`
          SELECT available_at FROM ai_jobs WHERE id = 1
        `).pluck().get()).toBe("2026-08-15T00:00:00.000Z");
        expect(restartedDatabase.connection.prepare(`
          SELECT SUM(cost_usd) FROM ai_job_attempts WHERE job_id = 1
        `).pluck().get()).toBe(0.5);
      } finally {
        restartedDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("charges post-midnight spend and permits exact-cap equality on the event day", () => {
    let now = new Date("2026-08-13T23:59:30.000Z");
    let tokenNo = 0;
    const database = openSchema23Database();
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `midnight-token-${String(++tokenNo).padStart(4, "0")}`,
    });
    const researchTask = (fingerprint: string, key: string, maxCostUsd: number) => ({
      version: 1 as const,
      kind: "resource_research" as const,
      subject: { type: "selection" as const, fingerprint },
      workflowRef: { id: "captured-only", version: 1 },
      inputFingerprint: fingerprint,
      idempotencyKey: key,
      provenance: { requestedBy: "system" as const, requestMethod: "scheduled" as const },
      schedulingPriority: 0,
      budget: { maxSteps: 10, maxTokens: 100, maxCostUsd, maxWallTimeMs: 60_000 },
    });
    try {
      ledger.submit(researchTask("1".repeat(64), "midnight-running", 0.6));
      const running = ledger.claimNext("resource_research", "midnight-worker-1", {
        maxConcurrent: 2,
        maxAttemptsPerUtcDay: 10,
        maxCostUsdPerUtcDay: 2,
      })!;
      now = new Date("2026-08-14T00:00:01.000Z");
      ledger.checkpoint(running, {
        progress: { completed: 1, total: null, stage: "post-midnight-cost" },
        checkpoint: { version: 1, nextStep: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0.4, wallTimeMs: 1 },
      });
      now = new Date("2026-08-14T00:00:02.000Z");
      ledger.submit(researchTask("2".repeat(64), "midnight-candidate", 0.4));
      expect(ledger.claimNext("resource_research", "midnight-worker-2", {
        maxConcurrent: 2,
        maxAttemptsPerUtcDay: 10,
        maxCostUsdPerUtcDay: 1,
      })).toBeDefined();
      expect(database.connection.prepare(`
        SELECT status, available_at FROM ai_jobs WHERE id = 2
      `).get()).toEqual({
        status: "running",
        available_at: "2026-08-14T00:00:02.000Z",
      });
      expect(database.connection.prepare(`
        SELECT SUM(delta_cost_usd) FROM ai_job_events
        WHERE event_type = 'progress'
          AND occurred_at >= '2026-08-14T00:00:00.000Z'
          AND occurred_at < '2026-08-15T00:00:00.000Z'
      `).pluck().get()).toBe(0.4);
      expect(database.connection.prepare(`
        SELECT max_cost_usd - spent_cost_usd FROM ai_jobs WHERE id = 1
      `).pluck().get()).toBeCloseTo(0.2);
    } finally {
      database.close();
    }
  });

  it("counts only provider-bound schema-25 attempts while preserving schema-23/24 starts", () => {
    const at = new Date("2026-08-14T09:00:00.000Z");
    const limits = {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 1,
      maxCostUsdPerUtcDay: null,
    } as const;
    for (const schema of [23, 24, 25] as const) {
      let now = at;
      let tokenNo = 0;
      const database = schema === 23
        ? openSchema23Database()
        : openDatabase(":memory:", schema === 24 ? { maximumMigrationVersion: 24 } : {});
      const ledger = createAiJobLedger(database.connection, {
        clock: () => now,
        kindAvailable: () => true,
        token: () => `provider-attempt-${schema}-${String(++tokenNo).padStart(4, "0")}`,
      });
      try {
        ledger.submit({
          ...priorityTask(),
          idempotencyKey: `provider-attempt-${schema}`,
        });
        const first = ledger.claimNext("priority_assessment", "provider-worker", limits)!;
        now = new Date("2026-08-14T09:00:01.000Z");
        ledger.fail(first, zeroCheckpoint(ledger, first), {
          code: "JOB_INPUT_UNAVAILABLE",
          retryAt: "2026-08-14T09:00:02.000Z",
        });
        now = new Date("2026-08-14T09:00:02.000Z");
        const second = ledger.claimNext("priority_assessment", "provider-worker", limits);
        expect(second === undefined, `schema ${schema}`).toBe(schema < 25);
      } finally {
        database.close();
      }
    }
  });

  it("admits provider attempt ten and defers attempt eleven on schema 25", () => {
    let now = new Date("2026-08-14T10:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `provider-bound-${String(++tokenNo).padStart(4, "0")}`,
    });
    const limits = {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: null,
    } as const;
    try {
      const submitModelJob = (index: number) => {
        const inputFingerprint = index.toString(16).padStart(64, "0");
        ledger.submit({
          ...priorityTask(),
          assessmentProvenance: {
            method: "model",
            model: { provider: "test", name: "model", promptVersion: "v1" },
          },
          inputFingerprint,
          idempotencyKey: `provider-bound-${index}`,
          budget: {
            ...priorityTask().budget,
            maxTokens: 100,
            maxCostUsd: 0.01,
          },
        });
      };
      for (let index = 1; index <= 10; index += 1) {
        submitModelJob(index);
        const claim = ledger.claimNext("priority_assessment", "provider-worker", limits);
        expect(claim, `attempt ${index}`).toBeDefined();
        ledger.bindAttemptProvider(claim!, {
          provider: "test",
          model: "model",
          promptVersion: "v1",
        });
        now = new Date(now.getTime() + 1_000);
        ledger.fail(claim!, zeroCheckpoint(ledger, claim!), {
          code: "JOB_INPUT_UNAVAILABLE",
        });
        now = new Date(now.getTime() + 1_000);
      }
      submitModelJob(11);
      expect(ledger.claimNext(
        "priority_assessment", "provider-worker", limits,
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE provider IS NOT NULL
      `).pluck().get()).toBe(10);
    } finally {
      database.close();
    }
  });

  it("admits exact committed USD 2.0 and defers the first epsilon above it", () => {
    let now = new Date("2026-08-14T11:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `committed-usd-${String(++tokenNo).padStart(4, "0")}`,
    });
    const limits = {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 2,
    } as const;
    const submitModelJob = (index: number, maxCostUsd: number) => ledger.submit({
      ...priorityTask(),
      assessmentProvenance: {
        method: "model",
        model: { provider: "test", name: "model", promptVersion: "v1" },
      },
      inputFingerprint: index.toString(16).padStart(64, "0"),
      idempotencyKey: `committed-usd-${index}`,
      budget: { ...priorityTask().budget, maxTokens: 100, maxCostUsd },
    });
    const spendAndFail = (claim: AiJobClaim, costUsd: number) => {
      ledger.bindAttemptProvider(claim, {
        provider: "test",
        model: "model",
        promptVersion: "v1",
      });
      now = new Date(now.getTime() + 1_000);
      ledger.checkpoint(claim, {
        progress: { completed: 1, total: null, stage: "paid" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: {
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd,
          wallTimeMs: 1,
        },
      });
      now = new Date(now.getTime() + 1_000);
      ledger.fail(claim, {
        progress: { completed: 1, total: null, stage: "paid" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
      }, { code: "JOB_INPUT_UNAVAILABLE" });
      now = new Date(now.getTime() + 1_000);
    };
    try {
      submitModelJob(1, 0.5);
      const first = ledger.claimNext("priority_assessment", "cost-worker", limits)!;
      spendAndFail(first, 0.5);

      submitModelJob(2, 1.5);
      const exact = ledger.claimNext("priority_assessment", "cost-worker", limits);
      expect(exact).toBeDefined();
      spendAndFail(exact!, 1.5);

      submitModelJob(3, 0.000_001);
      expect(ledger.claimNext(
        "priority_assessment", "cost-worker", limits,
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT SUM(cost_usd) FROM ai_job_attempts WHERE provider IS NOT NULL
      `).pluck().get()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("counts one implicit remainder for a retried running job", () => {
    let now = new Date("2026-08-14T12:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    database.connection.exec(`
      INSERT INTO resources (id, resource_key, created_at) VALUES
        (12001, 'host:retry-one.example', '2026-08-14T12:00:00.000Z'),
        (12002, 'host:retry-two.example', '2026-08-14T12:00:00.000Z');
      INSERT INTO resource_events (
        id, resource_id, version, name, kind, access_class, lifecycle_state,
        created_by, creation_method, created_at
      ) VALUES
        (12001, 12001, 1, 'Retry one', 'website', 'public', 'active',
          'system', 'derived', '2026-08-14T12:00:00.000Z'),
        (12002, 12002, 1, 'Retry two', 'website', 'public', 'active',
          'system', 'derived', '2026-08-14T12:00:00.000Z');
      INSERT INTO resource_heads (resource_id, event_id) VALUES
        (12001, 12001), (12002, 12002);
    `);
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `retry-remainder-${String(++tokenNo).padStart(4, "0")}`,
    });
    const limits = {
      maxConcurrent: 2,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 1.5,
    } as const;
    const modelTask = (resourceId: number, maxCostUsd: number) => ({
      ...priorityTask(),
      subject: { type: "resource" as const, resourceId },
      assessmentProvenance: {
        method: "model" as const,
        model: { provider: "test", name: "model", promptVersion: "v1" },
      },
      inputFingerprint: resourceId.toString(16).padStart(64, "0"),
      idempotencyKey: `retry-remainder-${resourceId}`,
      budget: { ...priorityTask().budget, maxTokens: 100, maxCostUsd },
    });
    try {
      ledger.submit(modelTask(12001, 1));
      const first = ledger.claimNext("priority_assessment", "retry-worker", limits)!;
      ledger.bindAttemptProvider(first, {
        provider: "test", model: "model", promptVersion: "v1",
      });
      now = new Date("2026-08-14T12:00:01.000Z");
      ledger.checkpoint(first, {
        progress: { completed: 0, total: 1, stage: "paid" },
        checkpoint: { version: 1, nextOffset: 0 },
        usage: {
          steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0.25, wallTimeMs: 1,
        },
      });
      now = new Date("2026-08-14T12:00:02.000Z");
      ledger.fail(first, zeroCheckpoint(ledger, first), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-14T12:00:03.000Z",
      });
      now = new Date("2026-08-14T12:00:03.000Z");
      expect(ledger.claimNext(
        "priority_assessment", "retry-worker", limits,
      )).toBeDefined();

      ledger.submit(modelTask(12002, 0.5));
      expect(ledger.claimNext(
        "priority_assessment", "candidate-worker", limits,
      )).toBeDefined();
    } finally {
      database.close();
    }
  });

  it("leaves ready jobs untouched when the atomic concurrency cap is full", () => {
    const database = openSchema23Database();
    const now = new Date("2026-08-13T06:00:00.000Z");
    let tokenNo = 0;
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `concurrency-token-${String(++tokenNo).padStart(4, "0")}`,
    });
    const researchTask = (fingerprint: string, key: string) => ({
      version: 1 as const,
      kind: "resource_research" as const,
      subject: { type: "selection" as const, fingerprint },
      workflowRef: { id: "captured-only", version: 1 },
      inputFingerprint: fingerprint,
      idempotencyKey: key,
      provenance: { requestedBy: "system" as const, requestMethod: "scheduled" as const },
      schedulingPriority: 0,
      budget: { maxSteps: 10, maxTokens: 0, maxCostUsd: 0, maxWallTimeMs: 60_000 },
    });
    const limits = {
      maxConcurrent: 1,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: null,
    } as const;
    try {
      ledger.submit(researchTask("1".repeat(64), "concurrency-research-1"));
      ledger.submit(researchTask("2".repeat(64), "concurrency-research-2"));
      expect(ledger.claimNext("resource_research", "worker-1", limits)).toBeDefined();
      const before = database.connection.prepare(`
        SELECT available_at, event_sequence FROM ai_jobs WHERE id = 2
      `).get();
      expect(ledger.claimNext("resource_research", "worker-2", limits)).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT available_at, event_sequence FROM ai_jobs WHERE id = 2
      `).get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("reserves candidate cost when actual daily spend is still below the cap", () => {
    let now = new Date("2026-08-13T07:00:00.000Z");
    let tokenNo = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `candidate-reservation-${String(++tokenNo).padStart(4, "0")}`,
    });
    const limits = {
      maxConcurrent: 2,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 1,
    } as const;
    try {
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "candidate-reservation-first",
        budget: { ...priorityTask().budget, maxCostUsd: 0.9 },
      });
      const first = ledger.claimNext("priority_assessment", "cost-worker-1", limits)!;
      now = new Date("2026-08-13T07:00:01.000Z");
      ledger.checkpoint(first, {
        progress: { completed: 1, total: 1, stage: "paid" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0.9, wallTimeMs: 1 },
      });
      completeWithConstantGuard(ledger, first, {
        progress: { completed: 1, total: 1, stage: "verified" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 0 },
      });
      now = new Date("2026-08-13T07:00:02.000Z");
      ledger.submit({
        ...priorityTask(),
        idempotencyKey: "candidate-reservation-second",
        inputFingerprint: "8".repeat(64),
        budget: { ...priorityTask().budget, maxCostUsd: 0.2 },
      });
      expect(ledger.claimNext(
        "priority_assessment", "cost-worker-2", limits,
      )).toBeUndefined();
      expect(database.connection.prepare(`
        SELECT status, available_at FROM ai_jobs WHERE id = 2
      `).get()).toEqual({
        status: "queued",
        available_at: "2026-08-14T00:00:00.000Z",
      });
      expect(database.connection.prepare(`
        SELECT SUM(cost_usd) FROM ai_job_attempts
      `).pluck().get()).toBe(0.9);
    } finally {
      database.close();
    }
  });

  it("claims when running plus candidate reservation equals the inclusive cap", () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    let tokenNo = 0;
    const database = openSchema23Database();
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => `running-reservation-${String(++tokenNo).padStart(4, "0")}`,
    });
    const limits = {
      maxConcurrent: 2,
      maxAttemptsPerUtcDay: 10,
      maxCostUsdPerUtcDay: 1,
    } as const;
    const task = (fingerprint: string, key: string) => ({
      version: 1 as const,
      kind: "resource_research" as const,
      subject: { type: "selection" as const, fingerprint },
      workflowRef: { id: "captured-only", version: 1 },
      inputFingerprint: fingerprint,
      idempotencyKey: key,
      provenance: { requestedBy: "system" as const, requestMethod: "scheduled" as const },
      schedulingPriority: 0,
      budget: { maxSteps: 10, maxTokens: 0, maxCostUsd: 0.5,
        maxWallTimeMs: 60_000 },
    });
    try {
      ledger.submit(task("3".repeat(64), "running-reservation-1"));
      ledger.submit(task("4".repeat(64), "running-reservation-2"));
      expect(ledger.claimNext("resource_research", "cost-worker-1", limits))
        .toBeDefined();
      expect(ledger.claimNext("resource_research", "cost-worker-2", limits))
        .toBeDefined();
      expect(database.connection.prepare(`
        SELECT status, available_at FROM ai_jobs WHERE id = 2
      `).get()).toEqual({
        status: "running",
        available_at: "2026-08-13T08:00:00.000Z",
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts
      `).pluck().get()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("rejects quota deferral on clock regression with zero mutations", () => {
    let now = new Date("2026-08-13T12:00:00.000Z");
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "clock-regression-token-0001",
    });
    const snapshot = () => ({
      jobs: database.connection.prepare(`SELECT * FROM ai_jobs ORDER BY id`).all(),
      attempts: database.connection.prepare(`SELECT * FROM ai_job_attempts ORDER BY id`).all(),
      events: database.connection.prepare(`SELECT * FROM ai_job_events ORDER BY id`).all(),
    });
    try {
      ledger.submit({
        ...priorityTask(),
        budget: { ...priorityTask().budget, maxCostUsd: 0.2 },
      });
      database.connection.exec("DROP TRIGGER ai_jobs_projection_requires_event");
      database.connection.prepare(`
        UPDATE ai_jobs SET updated_at = '2026-08-13T12:00:01.000Z' WHERE id = 1
      `).run();
      const beforeCandidateReservation = snapshot();
      expect(() => ledger.claimNext("priority_assessment", "clock-worker", {
        maxConcurrent: 1,
        maxAttemptsPerUtcDay: 10,
        maxCostUsdPerUtcDay: 0.1,
      })).toThrowError(expect.objectContaining({ code: "JOB_CLOCK_REGRESSION" }));
      expect(snapshot()).toEqual(beforeCandidateReservation);

      now = new Date("2026-08-13T12:00:00.000Z");
      database.connection.prepare(`
        UPDATE ai_jobs SET updated_at = '2026-08-13T12:00:00.000Z' WHERE id = 1
      `).run();
      const claim = ledger.claimNext(
        "priority_assessment", "clock-worker", openClaimLimits,
      )!;
      now = new Date("2026-08-13T12:00:01.000Z");
      ledger.fail(claim, zeroCheckpoint(ledger, claim), {
        code: "JOB_INPUT_UNAVAILABLE",
        retryAt: "2026-08-13T12:00:02.000Z",
      });
      database.connection.prepare(`
        UPDATE ai_jobs
        SET updated_at = '2026-08-13T12:00:03.000Z',
          available_at = '2026-08-13T12:00:00.000Z'
        WHERE id = 1
      `).run();
      now = new Date("2026-08-13T12:00:02.000Z");
      const beforeDailyDeferral = snapshot();
      expect(() => ledger.claimNext("priority_assessment", "clock-worker", {
        maxConcurrent: 1,
        maxAttemptsPerUtcDay: 1,
        maxCostUsdPerUtcDay: null,
      })).toThrowError(expect.objectContaining({ code: "JOB_CLOCK_REGRESSION" }));
      expect(snapshot()).toEqual(beforeDailyDeferral);
    } finally {
      database.close();
    }
  });

  it("accounts guarded rejection and fences throw, overflow, cancellation, and stale calls", () => {
    let now = new Date("2026-08-13T09:00:00.000Z");
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "guarded-completion-token-0001",
    });
    try {
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "guarded-worker", openClaimLimits,
      )!;
      const eventsBefore = database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      expect(completeWithConstantGuard(ledger, claim, {
        progress: { completed: 1, total: 2, stage: "guard-rejected" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 10 },
      }, false)).toMatchObject({
        completed: false,
        view: {
          status: "running",
          result: null,
          progress: { completed: 1, total: 2, stage: "ledger:guard-cycle:1" },
        },
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(Number(eventsBefore) + 1);
      expect(database.connection.prepare(`
        SELECT spent_steps, spent_wall_time_ms, result_type FROM ai_jobs WHERE id = 1
      `).get()).toEqual({ spent_steps: 2, spent_wall_time_ms: 10, result_type: null });
      const afterRejected = database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();

      expect(() => ledger.completeIf(claim, {
        ...guardedInput(zeroCheckpoint(ledger, claim)),
        guard: {
          guardId: "missing_guard",
          args: [],
          expectedFingerprint: AI_JOB_TEST_GUARD_FINGERPRINT,
        },
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(ledger.get("priority_assessment", 1)).toMatchObject({
        status: "running",
        result: null,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(afterRejected);
      expect(() => completeWithConstantGuard(ledger, claim, {
        progress: { completed: 2, total: 2, stage: "overflow" },
        checkpoint: { version: 1, nextOffset: 2 },
        usage: { steps: 100, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 1 },
      }, false)).toThrowError(expect.objectContaining({ code: "JOB_BUDGET_EXHAUSTED" }));
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(afterRejected);

      now = new Date("2026-08-13T09:00:01.000Z");
      ledger.cancel("priority_assessment", 1, "user");
      now = new Date("2026-08-13T09:00:02.000Z");
      expect(completeWithConstantGuard(ledger, claim, zeroCheckpoint(ledger, claim)))
        .toMatchObject({ completed: false, view: { status: "cancelled", result: null } });
      expect(() => completeWithConstantGuard(ledger, claim, zeroCheckpoint(ledger, claim)))
        .toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
    } finally {
      database.close();
    }
  });

  it("holds the writer lock from verification through guarded publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-guarded-"));
    const path = join(directory, "guarded.sqlite");
    const firstDatabase = openDatabase(path);
    const secondDatabase = openDatabase(path);
    const now = new Date("2026-08-13T10:00:00.000Z");
    let blockedWriteCode: unknown;
    firstDatabase.connection.function("guard_probe", () => {
      try {
        secondDatabase.connection.prepare(`
          UPDATE priority_ruleset_activations
          SET version = 2, activated_at = ? WHERE scope = 'global'
        `).run(now.toISOString());
      } catch (error) {
        blockedWriteCode = (error as { code?: unknown }).code;
      }
      return 1;
    });
    const ledger = createAiJobLedger(firstDatabase.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "guarded-atomic-token-0001",
      guards: { lock_probe: {
        sql: "SELECT guard_probe() AS covered",
        parameters: [],
        usage: { stepsPerRow: 1 },
      } },
    });
    try {
      firstDatabase.connection.exec(`
        INSERT INTO priority_rule_versions (
          ruleset_id, version, rule_ast_json, natural_language_source,
          created_by, created_at
        )
        SELECT ruleset_id, 2, rule_ast_json, natural_language_source,
          created_by, created_at
        FROM priority_rule_versions WHERE ruleset_id = 1 AND version = 1
      `);
      secondDatabase.connection.pragma("busy_timeout = 0");
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "guarded-atomic-worker", openClaimLimits,
      )!;
      const guarded = guardedInput({
        progress: { completed: 1, total: 1, stage: "verified" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 25 },
      });
      const result = ledger.completeIf(claim, {
        ...guarded,
        guard: { ...guarded.guard, guardId: "lock_probe" },
      });
      expect(blockedWriteCode).toBe("SQLITE_BUSY");
      expect(result).toMatchObject({
        completed: true,
        view: {
          status: "succeeded",
          result: {
            type: "priority_assessment",
            outputFingerprint: AI_JOB_TEST_GUARD_FINGERPRINT,
          },
        },
      });
      expect(secondDatabase.connection.prepare(`
        UPDATE priority_ruleset_activations
        SET version = 2, activated_at = ? WHERE scope = 'global'
      `).run(now.toISOString()).changes).toBe(1);
      expect(firstDatabase.connection.prepare(`
        SELECT status, result_output_fingerprint, spent_steps, spent_wall_time_ms
        FROM ai_jobs WHERE id = 1
      `).get()).toEqual({
        status: "succeeded",
        result_output_fingerprint: AI_JOB_TEST_GUARD_FINGERPRINT,
        spent_steps: 2,
        spent_wall_time_ms: 25,
      });
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks the guarded lease after verification and timestamps from final clock", () => {
    const times = [
      new Date("2026-08-13T10:30:00.000Z"),
      new Date("2026-08-13T10:30:01.000Z"),
      new Date("2026-08-13T10:30:59.000Z"),
    ];
    let timeIndex = 0;
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => times[Math.min(timeIndex++, times.length - 1)]!,
      kindAvailable: () => true,
      token: () => "guarded-clock-token-0001",
    });
    const decision = {
      publish: true as const,
      checkpoint: {
        progress: { completed: 1, total: 1, stage: "verified" },
        checkpoint: { version: 1 as const, nextOffset: 1 },
          usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1 },
      },
      completion: {
        status: "succeeded" as const,
        result: {
          type: "priority_assessment" as const,
          outputFingerprint: "3".repeat(64),
        },
      },
    };
    try {
      ledger.submit(priorityTask());
      const claim = ledger.claimNext(
        "priority_assessment", "guarded-clock-worker", openClaimLimits,
      )!;
      expect(completeWithConstantGuard(ledger, claim, decision.checkpoint)).toMatchObject({
        completed: true,
        view: { status: "succeeded", completedAt: "2026-08-13T10:30:59.000Z" },
      });
      expect(database.connection.prepare(`
        SELECT occurred_at FROM ai_job_events WHERE job_id = 1 AND event_type = 'progress'
      `).pluck().get()).toBe("2026-08-13T10:30:59.000Z");
    } finally {
      database.close();
    }

    const expiredTimes = [
      new Date("2026-08-13T10:40:00.000Z"),
      new Date("2026-08-13T10:40:01.000Z"),
      new Date("2026-08-13T10:41:01.000Z"),
    ];
    let expiredIndex = 0;
    const expiredDatabase = openDatabase(":memory:");
    const expiredLedger = createAiJobLedger(expiredDatabase.connection, {
      clock: () => expiredTimes[Math.min(expiredIndex++, expiredTimes.length - 1)]!,
      kindAvailable: () => true,
      token: () => "guarded-expired-token-0001",
    });
    try {
      expiredLedger.submit(priorityTask());
      const expiredClaim = expiredLedger.claimNext(
        "priority_assessment", "guarded-expired-worker", openClaimLimits,
      )!;
      const before = expiredDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      expect(() => completeWithConstantGuard(
        expiredLedger, expiredClaim, decision.checkpoint,
      ))
        .toThrowError(expect.objectContaining({ code: "JOB_LEASE_LOST" }));
      expect(expiredDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(before);
      expect(expiredLedger.get("priority_assessment", 1)).toMatchObject({
        status: "running",
        result: null,
        progress: { completed: 0, stage: "queued" },
      });
    } finally {
      expiredDatabase.close();
    }

    const regressedTimes = [
      new Date("2026-08-13T10:50:00.000Z"),
      new Date("2026-08-13T10:50:01.000Z"),
      new Date("2026-08-13T10:49:59.000Z"),
    ];
    let regressedIndex = 0;
    const regressedDatabase = openDatabase(":memory:");
    const regressedLedger = createAiJobLedger(regressedDatabase.connection, {
      clock: () => regressedTimes[Math.min(regressedIndex++, regressedTimes.length - 1)]!,
      kindAvailable: () => true,
      token: () => "guarded-regressed-token-0001",
    });
    try {
      regressedLedger.submit(priorityTask());
      const regressedClaim = regressedLedger.claimNext(
        "priority_assessment", "guarded-regressed-worker", openClaimLimits,
      )!;
      const before = regressedDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get();
      expect(() => completeWithConstantGuard(
        regressedLedger, regressedClaim, decision.checkpoint,
      ))
        .toThrowError(expect.objectContaining({ code: "JOB_CLOCK_REGRESSION" }));
      expect(regressedDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events WHERE job_id = 1
      `).pluck().get()).toBe(before);
      expect(regressedLedger.get("priority_assessment", 1)).toMatchObject({
        status: "running",
        result: null,
        progress: { completed: 0, stage: "queued" },
      });
    } finally {
      regressedDatabase.close();
    }
  });

  it("persists alias receipts, phased attempt metadata, and exact usage deltas", () => {
    let now = new Date("2026-08-13T11:00:00.000Z");
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => now,
      kindAvailable: () => true,
      token: () => "phased-metadata-token-0001",
    });
    try {
      const modelTask = {
        ...priorityTask(),
        idempotencyKey: "model-primary-key",
        assessmentProvenance: {
          method: "model" as const,
          model: { provider: "openai", name: "gpt-5", promptVersion: "priority-v1" },
        },
        budget: { ...priorityTask().budget, maxTokens: 100, maxCostUsd: 1 },
      };
      const original = ledger.submit(modelTask);
      const aliasTask = { ...modelTask, idempotencyKey: "model-alias-key" };
      expect(ledger.submit(aliasTask)).toEqual(original);
      expect(database.connection.prepare(`
        SELECT idempotency_key, job_id FROM ai_job_idempotency_receipts ORDER BY idempotency_key
      `).all()).toEqual([
        { idempotency_key: "model-alias-key", job_id: 1 },
        { idempotency_key: "model-primary-key", job_id: 1 },
      ]);

      const claim = ledger.claimNext(
        "priority_assessment", "phased-worker", openClaimLimits,
      )!;
      expect(() => ledger.recordAttemptRequest(claim, "request-1"))
        .toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      expect(() => ledger.bindAttemptProvider(claim, {
        provider: "other", model: "gpt-5", promptVersion: "priority-v1",
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      now = new Date("2026-08-13T11:00:01.000Z");
      ledger.bindAttemptProvider(claim, {
        provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
      });
      ledger.bindAttemptProvider(claim, {
        provider: "openai", model: "gpt-5", promptVersion: "priority-v1",
      });
      const assertClockFloored = (aliasKey: string) => {
        const before = database.connection.prepare(`
          SELECT event_sequence, status, spent_steps FROM ai_jobs WHERE id = 1
        `).get();
        const calls = [
          () => ledger.renew(claim),
          () => ledger.checkpoint(claim, zeroCheckpoint(ledger, claim)),
          () => ledger.completeIf(claim, guardedInput(zeroCheckpoint(ledger, claim))),
          () => ledger.fail(claim, zeroCheckpoint(ledger, claim), {
            code: "JOB_INPUT_UNAVAILABLE",
          }),
          () => ledger.submit({ ...modelTask, idempotencyKey: aliasKey }),
          () => ledger.cancel("priority_assessment", claim.id, "user"),
        ];
        for (const call of calls) {
          expect(call).toThrowError(expect.objectContaining({ code: "JOB_CLOCK_REGRESSION" }));
        }
        expect(database.connection.prepare(`
          SELECT event_sequence, status, spent_steps FROM ai_jobs WHERE id = 1
        `).get()).toEqual(before);
        expect(database.connection.prepare(`
          SELECT COUNT(*) FROM ai_job_idempotency_receipts WHERE idempotency_key = ?
        `).pluck().get(aliasKey)).toBe(0);
      };
      now = new Date("2026-08-13T11:00:00.500Z");
      assertClockFloored("provider-regressed-alias");
      expect(() => ledger.recordAttemptRequest(claim, "regressed-request"))
        .toThrowError(expect.objectContaining({ code: "JOB_CLOCK_REGRESSION" }));
      now = new Date("2026-08-13T11:00:02.000Z");
      ledger.recordAttemptRequest(claim, "request-1");
      ledger.recordAttemptRequest(claim, "request-1");
      now = new Date("2026-08-13T11:00:01.500Z");
      assertClockFloored("request-regressed-alias");
      expect(database.connection.prepare(`
        SELECT provider, model, prompt_version, provider_bound_at,
          request_id, request_bound_at FROM ai_job_attempts WHERE id = ?
      `).get(claim.attemptId)).toEqual({
        provider: "openai",
        model: "gpt-5",
        prompt_version: "priority-v1",
        provider_bound_at: "2026-08-13T11:00:01.000Z",
        request_id: "request-1",
        request_bound_at: "2026-08-13T11:00:02.000Z",
      });

      now = new Date("2026-08-13T11:00:03.000Z");
      ledger.checkpoint(claim, {
        progress: { completed: 1, total: null, stage: "paid" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 1, inputTokens: 3, outputTokens: 2,
          costUsd: 0.1, wallTimeMs: 10 },
      });
      now = new Date("2026-08-13T11:00:04.000Z");
      ledger.checkpoint(claim, {
        progress: { completed: 2, total: null, stage: "paid-again" },
        checkpoint: { version: 1, nextOffset: 2 },
        usage: { steps: 2, inputTokens: 5, outputTokens: 4,
          costUsd: 0.2, wallTimeMs: 20 },
      });
      expect(database.connection.prepare(`
        SELECT delta_steps, delta_input_tokens, delta_output_tokens,
          delta_cost_usd, delta_wall_time_ms
        FROM ai_job_events WHERE job_id = 1 AND event_type = 'progress'
        ORDER BY sequence_no
      `).all()).toEqual([
        { delta_steps: 1, delta_input_tokens: 3, delta_output_tokens: 2,
          delta_cost_usd: 0.1, delta_wall_time_ms: 10 },
        { delta_steps: 2, delta_input_tokens: 5, delta_output_tokens: 4,
          delta_cost_usd: 0.20000000000000004, delta_wall_time_ms: 20 },
      ]);

      now = new Date("2026-08-13T11:00:05.000Z");
      const finished = ledger.completeIf(claim, guardedInput(zeroCheckpoint(ledger, claim)));
      expect(finished.completed).toBe(true);
      expect(ledger.submit(aliasTask)).toEqual({ ...original, status: "succeeded" });
      expect(() => ledger.submit({
        ...aliasTask,
        schedulingPriority: aliasTask.schedulingPriority + 1,
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      database.close();
    }
  });

  it("keeps 50 durable facade reads below the local p95 budget", () => {
    const database = openDatabase(":memory:");
    const ledger = createAiJobLedger(database.connection, {
      clock: () => new Date("2026-08-13T11:00:00.000Z"),
      kindAvailable: () => true,
      token: () => "facade-benchmark-token-0001",
    });
    const jobs = createDurableAiJobs({
      summary: createSummaryJobAdapter(fakeSummaryCatalog()),
      newJobs: ledger,
    });
    try {
      const submitted = jobs.submit(priorityTask());
      const durations: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        const startedAt = performance.now();
        expect(jobs.get(submitted.id).id).toBe(submitted.id);
        durations.push(performance.now() - startedAt);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      process.stdout.write(`C52A_FACADE50_P95_MS=${p95.toFixed(3)}\n`);
      expect(p95).toBeLessThan(500);
    } finally {
      database.close();
    }
  });

  it("allows exactly one claim across two database connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-claim-"));
    const path = join(directory, "claim.sqlite");
    const firstDatabase = openDatabase(path);
    const secondDatabase = openDatabase(path);
    const now = () => new Date("2026-08-13T04:00:00.000Z");
    const first = createAiJobLedger(firstDatabase.connection, {
      clock: now,
      kindAvailable: () => true,
      token: () => "two-connection-token-0001",
    });
    const second = createAiJobLedger(secondDatabase.connection, {
      clock: now,
      kindAvailable: () => true,
      token: () => "two-connection-token-0002",
    });
    try {
      first.submit(priorityTask());
      expect(first.claimNext("priority_assessment", "first-worker", openClaimLimits))
        .toMatchObject({ id: 1, attemptNo: 1, leaseToken: "two-connection-token-0001" });
      expect(second.claimNext(
        "priority_assessment", "second-worker", openClaimLimits,
      )).toBeUndefined();
      expect(secondDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_attempts WHERE job_id = 1
      `).pluck().get()).toBe(1);
      expect(second.get("priority_assessment", 1)).toMatchObject({
        status: "running",
        attempts: 1,
      });
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists one alias receipt across concurrent submitters and terminal restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-ai-job-alias-race-"));
    const path = join(directory, "alias.sqlite");
    const now = () => new Date("2026-08-13T12:00:00.000Z");
    const firstDatabase = openDatabase(path);
    const secondDatabase = openDatabase(path);
    const first = createAiJobLedger(firstDatabase.connection, {
      clock: now,
      kindAvailable: () => true,
      token: () => "alias-race-token-0001",
    });
    const second = createAiJobLedger(secondDatabase.connection, {
      clock: now,
      kindAvailable: () => true,
      token: () => "alias-race-token-0002",
    });
    const task = priorityTask();
    const alias = { ...task, idempotencyKey: "priority-race-alias" };
    try {
      const original = first.submit(task);
      const raced = await Promise.all([
        Promise.resolve().then(() => first.submit(alias)),
        Promise.resolve().then(() => second.submit(alias)),
      ]);
      expect(raced).toEqual([original, original]);
      expect(firstDatabase.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_idempotency_receipts
        WHERE idempotency_key = 'priority-race-alias'
      `).pluck().get()).toBe(1);
      const claim = first.claimNext(
        "priority_assessment", "alias-race-worker", openClaimLimits,
      )!;
      expect(completeWithConstantGuard(first, claim, {
        progress: { completed: 1, total: null, stage: "verified" },
        checkpoint: { version: 1, nextOffset: 1 },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0,
          costUsd: 0, wallTimeMs: 0 },
      })).toMatchObject({ completed: true, view: { status: "succeeded" } });
      expect(second.submit(alias)).toEqual({ ...original, status: "succeeded" });
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
    const restartedDatabase = openDatabase(path);
    try {
      const restarted = createAiJobLedger(restartedDatabase.connection, {
        clock: now,
        kindAvailable: () => true,
        token: () => "alias-race-token-0003",
      });
      expect(restarted.submit(alias)).toEqual({
        id: "priority_assessment:1",
        kind: "priority_assessment",
        status: "succeeded",
      });
      expect(() => restarted.submit({
        ...alias,
        inputFingerprint: "f".repeat(64),
      })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    } finally {
      restartedDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
