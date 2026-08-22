import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  estimateResearchReservationV1,
  type ResearchApprovalRequest,
  type ResearchCumulativeUsage,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";

import {
  createAiJobLedger,
  type AiJobCheckpointInput,
  type AiJobClaim,
  type AiJobLedger,
} from "../src/ai-job-ledger.js";
import {
  createResearchCorpusReader,
  ResearchCorpusReaderError,
  type ApprovedResearchCorpus,
  type ResearchCorpusAudit,
  type ResearchCorpusReader,
} from "../src/research-corpus.js";
import { openDatabase } from "../src/database.js";
import {
  ResearchProviderError,
  type ResearchProvider,
  type ResearchProviderOutput,
  type ResearchProviderQuote,
} from "../src/research-provider.js";
import {
  buildCurrentResearchDraft,
  createResearchStore,
  fingerprintResearchApproval,
} from "../src/research-store.js";
import { createResearchWorker } from "../src/research-worker.js";
import { DurableAiJobError } from "../src/durable-ai-jobs.js";

const fixedNow = new Date("2026-08-14T10:00:00.000Z");
const zeroUsage: ResearchCumulativeUsage = {
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  wallTimeMs: 0,
};
const providerUsage: ResearchCumulativeUsage = {
  steps: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.1,
  wallTimeMs: 100,
};
const quote: ResearchProviderQuote = {
  version: "research_provider_quote:v1",
  inputDigest: "b".repeat(64),
  calls: 1,
  inputTokens: 20,
  outputTokens: 20,
  costUsd: 0.2,
  wallTimeMs: 500,
};

function makeClaim(overrides: Partial<AiJobClaim> = {}): AiJobClaim {
  return {
    id: 7,
    kind: "resource_research",
    attemptId: 11,
    attemptNo: 1,
    workerId: "worker-1",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-08-14T10:01:00.000Z",
    task: {
      version: 1,
      kind: "resource_research",
      subject: { type: "page", logicalPageId: 3 },
      workflowRef: { id: "research_workflow:c81:v1", version: 1 },
      inputFingerprint: "a".repeat(64),
      idempotencyKey: "worker-test",
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget: {
        maxSteps: 3,
        maxTokens: 100,
        maxCostUsd: 1,
        maxWallTimeMs: 1_000,
      },
    },
    inputFingerprint: "a".repeat(64),
    createdAt: "2026-08-14T09:00:00.000Z",
    progress: { completed: 0, total: 1, stage: "queued" },
    checkpoint: null,
    usage: zeroUsage,
    ...overrides,
  };
}

function makeCorpus(): ApprovedResearchCorpus {
  return {
    version: 1,
    jobId: "resource_research:7",
    runId: 5,
    target: { type: "page", logicalPageId: 3 },
    selectionLogicalPageIds: [],
    question: "What is useful?",
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: true,
      maxIncludedSources: 10,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "c".repeat(64),
    corpusFingerprint: "d".repeat(64),
    workflowRef: { id: "research_workflow:c81:v1", version: 1 },
    budget: { maxSteps: 3, maxTokens: 100, maxCostUsd: 1, maxWallTimeMs: 1_000 },
    estimate: {
      estimateVersion: "research_estimate:v1",
      estimateKind: "reservation_envelope",
      calls: 1,
      inputTokens: 20,
      outputTokens: 20,
      costUsd: 1,
      wallTimeMs: 1_000,
    },
    sources: [{
      sourceKind: "captured",
      sourceId: 41,
      ordinal: 1,
      includedOrder: 1,
      logicalPageId: 3,
      tabId: 9,
      contentRevision: 2,
      contentDigest: "e".repeat(64),
      extractedAt: "2026-08-14T09:30:00.000Z",
      acquisitionMethod: "captured",
      accessClass: "public",
      payload: {
        trust: "untrusted_source_material",
        url: "https://example.com",
        title: "Example",
        evidenceMaterial: "Alpha beta",
        chunkManifest: {
          version: "captured_text_chunks:v1",
          byteStart: 0,
          byteEnd: 10,
          chunkDigest: "f".repeat(64),
          truncated: false,
        },
      },
    }],
    snapshots: [{
      snapshotId: 61,
      kind: "page_context",
      ordinal: 1,
      snapshotDigest: "1".repeat(64),
      contextEntryId: 4,
      logicalPageId: 3,
      material: { intent: "compare" },
    }],
    parent: null,
    corpusDigest: "2".repeat(64),
  };
}

function makeAudit(): ResearchCorpusAudit {
  return {
    version: 1,
    jobId: "resource_research:7",
    runId: 5,
    target: { type: "page", logicalPageId: 3 },
    corpusFingerprint: "d".repeat(64),
    coverage: { discovered: 2, captured: 1, eligible: 1, used: 0, missing: 1, failed: 0 },
    digest: "3".repeat(64),
  };
}

function makeOutput(overrides: Partial<ResearchProviderOutput> = {}): ResearchProviderOutput {
  return {
    version: 1,
    dossier: {
      executiveSummary: "Useful summary",
      valueForUser: "Useful value",
      capabilities: ["Capability"],
      limitations: [],
      risks: [],
      unknowns: [],
      nextSteps: ["Review"],
    },
    claims: [{
      claim: "Alpha is present.",
      confidence: 0.9,
      isInference: false,
      rationale: null,
      evidence: [{
        kind: "tab_content",
        sourceOrdinal: 1,
        locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 5 },
      }],
    }],
    usage: providerUsage,
    stopReason: "complete",
    ...overrides,
  };
}

interface LedgerHarness {
  ledger: AiJobLedger;
  readonly checkpoints: AiJobCheckpointInput[];
  readonly events: string[];
  readonly completed: Array<{ checkpoint: AiJobCheckpointInput; draft: unknown }>;
  readonly failures: Array<{ checkpoint: AiJobCheckpointInput; failure: unknown }>;
  readonly binds: unknown[];
  readonly requests: string[];
  usage: ResearchCumulativeUsage;
  checkpointStatus: (input: AiJobCheckpointInput, call: number) => "running" | "cancelled";
  renewResult: "renewed" | "cancelled" | "lost";
}

function nextStep(input: AiJobCheckpointInput): number {
  return "nextStep" in input.checkpoint ? input.checkpoint.nextStep : -1;
}

function makeLedger(claim = makeClaim()): LedgerHarness {
  const harness: LedgerHarness = {
    ledger: undefined as unknown as AiJobLedger,
    checkpoints: [],
    events: [],
    completed: [],
    failures: [],
    binds: [],
    requests: [],
    usage: { ...claim.usage },
    checkpointStatus: () => "running",
    renewResult: "renewed",
  };
  harness.ledger = {
    recoverInterrupted: vi.fn(() => 2),
    claimNext: vi.fn(() => claim),
    renew: vi.fn(() => {
      harness.events.push("renew");
      if (harness.renewResult === "lost") {
        throw new Error("raw lease error must not escape");
      }
      return harness.renewResult === "cancelled" ? undefined : claim;
    }),
    refresh: vi.fn(() => ({ ...claim, usage: { ...harness.usage } })),
    checkpoint: vi.fn((_claim: AiJobClaim, input: AiJobCheckpointInput) => {
      harness.events.push(`checkpoint:${nextStep(input)}`);
      harness.checkpoints.push(input);
      harness.usage = {
        steps: harness.usage.steps + input.usage.steps,
        inputTokens: harness.usage.inputTokens + input.usage.inputTokens,
        outputTokens: harness.usage.outputTokens + input.usage.outputTokens,
        costUsd: harness.usage.costUsd + input.usage.costUsd,
        wallTimeMs: harness.usage.wallTimeMs + input.usage.wallTimeMs,
      };
      return { status: harness.checkpointStatus(input, harness.checkpoints.length) };
    }),
    bindAttemptProvider: vi.fn((_claim: AiJobClaim, metadata: unknown) => {
      harness.events.push("bind");
      harness.binds.push(metadata);
    }),
    recordAttemptRequest: vi.fn((_claim: AiJobClaim, requestId: string) => {
      harness.events.push("request");
      harness.requests.push(requestId);
    }),
    completeResearch: vi.fn((_claim: AiJobClaim, checkpoint: AiJobCheckpointInput, draft: unknown) => {
      harness.events.push("complete");
      harness.completed.push({ checkpoint, draft });
      return { status: "succeeded" };
    }),
    fail: vi.fn((_claim: AiJobClaim, checkpoint: AiJobCheckpointInput, failure: unknown) => {
      harness.events.push("fail");
      harness.failures.push({ checkpoint, failure });
      return { status: "failed" };
    }),
    cancel: vi.fn(() => ({ status: "running" })),
  } as unknown as AiJobLedger;
  return harness;
}

function makeReader(overrides: Partial<ResearchCorpusReader> = {}): ResearchCorpusReader {
  const corpus = makeCorpus();
  const audit = makeAudit();
  return {
    readForJob: vi.fn(() => corpus),
    readAuditForJob: vi.fn(() => audit),
    ...overrides,
  };
}

function makeProvider(
  output = makeOutput(),
  requestId = "request-7",
): ResearchProvider & { starts: number } {
  let starts = 0;
  return {
    metadata: {
      provider: "anthropic",
      model: "claude-test",
      promptVersion: "research-v1",
      pricingVersion: "test-pricing-v1",
    },
    quote: vi.fn(() => quote),
    async start(_input, _quote, _signal) {
      starts += 1;
      return {
        requestId,
        async read() {
          return output;
        },
      };
    },
    get starts() {
      return starts;
    },
  };
}

const restartBudget = {
  maxSteps: 4,
  maxTokens: 2_000,
  maxCostUsd: 1,
  maxWallTimeMs: 60_000,
} as const;

function seedRestartCorpus(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      3, 'https://research.openai.com/page', 'https://research.openai.com/page',
      'https://research.openai.com/page',
      '${fixedNow.toISOString()}', '${fixedNow.toISOString()}'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (
      9, 'https://research.openai.com/page', 'https://research.openai.com/page', 'Example',
      'chrome', 'inbox', 0, 1,
      '${fixedNow.toISOString()}', '${fixedNow.toISOString()}', 3
    );
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (9, 'Alpha beta', '${fixedNow.toISOString()}', 2);
  `);
}

function restartSubmission(): {
  readonly requestSeed: ResearchApprovalRequest;
  readonly taskFor: (approvalFingerprint: string) => ResourceResearchTaskSpec;
} {
  const question = "What is useful?";
  const workflowRef = { id: "captured-only", version: 1 } as const;
  const requestSeed: ResearchApprovalRequest = {
    version: 1,
    target: { type: "page", logicalPageId: 3 },
    question,
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: false,
      maxIncludedSources: 10,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    workflowRef,
    budget: restartBudget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength("Alpha beta", "utf8"),
      snapshotBytes: 0,
      questionBytes: Buffer.byteLength(question, "utf8"),
      budget: restartBudget,
    }),
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
  return {
    requestSeed,
    taskFor: (approvalFingerprint): ResourceResearchTaskSpec => ({
      version: 1,
      kind: "resource_research",
      subject: { type: "page", logicalPageId: 3 },
      workflowRef,
      inputFingerprint: approvalFingerprint,
      idempotencyKey: "research-worker-restart-resume-v1",
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget: restartBudget,
    }),
  };
}

describe("ResearchWorker", () => {
  it("claims only research with the frozen scheduler limits and delegates recovery", () => {
    const claim = makeClaim();
    const ledger = makeLedger(claim);
    const worker = createResearchWorker(ledger.ledger, makeReader(), makeProvider());

    expect(worker.recoverInterrupted()).toBe(2);
    expect(worker.claim("worker-1", { nextCursor: 6 })).toBe(claim);
    expect(ledger.ledger.claimNext).toHaveBeenCalledWith(
      "resource_research",
      "worker-1",
      { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 },
      { nextCursor: 6 },
    );
  });

  it("executes one call, records request before read, derives evidence, and atomically publishes", async () => {
    const ledger = makeLedger();
    const provider = makeProvider();
    const worker = createResearchWorker(ledger.ledger, makeReader(), provider, {
      clock: () => fixedNow,
    });

    await worker.executeClaim(makeClaim());

    expect(provider.starts).toBe(1);
    expect(ledger.events.indexOf("request")).toBeLessThan(ledger.events.indexOf("complete"));
    expect(ledger.completed).toHaveLength(1);
    const completion = ledger.completed[0]!;
    expect(completion.checkpoint).toMatchObject({
      progress: { completed: 1, total: 1, stage: "terminal_publication" },
      checkpoint: { nextStep: 2, stage: "terminal_publication" },
      usage: { steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    const draft = completion.draft as {
      usedSourceIds: number[];
      coverage: { used: number };
      claims: Array<{ evidence: Array<{ sourceId: number; excerptHash: string }> }>;
      provenance: { requestId: string; usage: ResearchCumulativeUsage };
    };
    expect(draft.usedSourceIds).toEqual([41]);
    expect(draft.coverage.used).toBe(1);
    expect(draft.claims[0]!.evidence[0]).toEqual(expect.objectContaining({
      sourceId: 41,
      excerptHash: createHash("sha256").update("Alpha").digest("hex"),
    }));
    expect(draft.provenance).toMatchObject({
      requestId: "request-7",
      usage: { steps: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.1, wallTimeMs: 100 },
    });
    expect(ledger.checkpoints.some((entry) => nextStep(entry) === 1 &&
      entry.usage.steps === 1)).toBe(true);
    expect(ledger.checkpoints.some((entry) => nextStep(entry) === 1 &&
      entry.usage.inputTokens === 10)).toBe(true);
  });

  it("recovers a persisted provider-ready attempt and charges repeated known usage after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-worker-restart-"));
    const databasePath = join(directory, "restart.sqlite");
    let now = new Date(fixedNow);
    const firstProvider = makeProvider(makeOutput(), "restart-request-1");
    const secondProvider = makeProvider(makeOutput(), "restart-request-2");
    try {
      const firstDatabase = openDatabase(databasePath);
      try {
        seedRestartCorpus(firstDatabase.connection);
        const firstResearch = createResearchStore(firstDatabase.connection, { clock: () => now });
        const firstLedger = createAiJobLedger(firstDatabase.connection, {
          clock: () => now,
          token: () => "restart-lease-token-0001",
          kindAvailable: () => true,
          research: firstResearch,
        });
        const { requestSeed, taskFor } = restartSubmission();
        const initialDraft = buildCurrentResearchDraft(firstDatabase.connection, requestSeed, {
          clock: () => now,
        });
        const approvalFingerprint = fingerprintResearchApproval(initialDraft);
        const request = {
          ...requestSeed,
          approvalFingerprint,
          estimate: initialDraft.estimate,
        };
        const submitted = firstLedger.submitResearch(taskFor(approvalFingerprint), request);
        let simulatedCrash = false;
        const crashAfterKnownUsage: AiJobLedger = {
          ...firstLedger,
          checkpoint(claim, input) {
            const view = firstLedger.checkpoint(claim, input);
            if (!simulatedCrash && input.usage.inputTokens === providerUsage.inputTokens) {
              simulatedCrash = true;
              throw new DurableAiJobError(
                "JOB_LEASE_LOST",
                "simulated process loss after durable provider usage",
              );
            }
            return view;
          },
        };
        const firstWorker = createResearchWorker(
          crashAfterKnownUsage,
          createResearchCorpusReader(firstDatabase.connection),
          firstProvider,
          { clock: () => now },
        );
        const firstClaim = firstWorker.claim("restart-worker-1")!;

        await firstWorker.executeClaim(firstClaim);

        expect(simulatedCrash).toBe(true);
        expect(firstProvider.starts).toBe(1);
        expect(firstLedger.refresh(firstClaim)).toMatchObject({
          attemptNo: 1,
          checkpoint: { version: 1, nextStep: 1, stage: "provider_ready" },
          usage: {
            steps: 2,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.1,
            wallTimeMs: 100,
          },
        });
        expect(submitted.id).toBe(`resource_research:${firstClaim.id}`);
        expect(firstLedger.get("resource_research", firstClaim.id)).toMatchObject({
          status: "running",
          attempts: 1,
          progress: { completed: 0, total: 1, stage: "provider_ready" },
        });
      } finally {
        firstDatabase.close();
      }

      now = new Date(fixedNow.getTime() + 60_001);
      const restartedDatabase = openDatabase(databasePath);
      try {
        const restartedResearch = createResearchStore(restartedDatabase.connection, {
          clock: () => now,
        });
        const restartedLedger = createAiJobLedger(restartedDatabase.connection, {
          clock: () => now,
          token: () => "restart-lease-token-0002",
          kindAvailable: () => true,
          research: restartedResearch,
        });
        const restartedWorker = createResearchWorker(
          restartedLedger,
          createResearchCorpusReader(restartedDatabase.connection),
          secondProvider,
          { clock: () => now },
        );

        expect(restartedWorker.recoverInterrupted()).toBe(1);
        const resumed = restartedWorker.claim("restart-worker-2")!;
        expect(resumed).toMatchObject({
          attemptNo: 2,
          checkpoint: { version: 1, nextStep: 1, stage: "provider_ready" },
          usage: {
            steps: 2,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.1,
            wallTimeMs: 100,
          },
        });

        await restartedWorker.executeClaim(resumed);

        expect(firstProvider.starts + secondProvider.starts).toBe(2);
        const completed = restartedLedger.get("resource_research", resumed.id);
        expect(completed?.error).toBeNull();
        expect(completed).toMatchObject({
          status: "succeeded",
          attempts: 2,
          progress: { completed: 1, total: 1, stage: "terminal_publication" },
          result: { type: "resource_research" },
        });
        expect(restartedDatabase.connection.prepare(`
          SELECT spent_steps, max_steps, spent_tokens, max_tokens,
            spent_cost_usd, max_cost_usd, spent_wall_time_ms, max_wall_time_ms
          FROM ai_jobs WHERE id = ?
        `).get(resumed.id)).toEqual({
          spent_steps: 4,
          max_steps: 4,
          spent_tokens: 30,
          max_tokens: 2_000,
          spent_cost_usd: 0.2,
          max_cost_usd: 1,
          spent_wall_time_ms: 200,
          max_wall_time_ms: 60_000,
        });
        expect(restartedDatabase.connection.prepare(`
          SELECT attempt_no, outcome, request_id, input_tokens, output_tokens, cost_usd
          FROM ai_job_attempts WHERE job_id = ? ORDER BY attempt_no
        `).all(resumed.id)).toEqual([
          {
            attempt_no: 1,
            outcome: "interrupted",
            request_id: "restart-request-1",
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: 0.1,
          },
          {
            attempt_no: 2,
            outcome: "succeeded",
            request_id: "restart-request-2",
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: 0.1,
          },
        ]);
        expect(restartedDatabase.connection.prepare(`
          SELECT COUNT(*) FROM research_reports WHERE run_id = 1
        `).pluck().get()).toBe(1);
        expect(restartedDatabase.connection.prepare(`
          SELECT
            json_extract(provenance_json, '$.requestId') AS request_id,
            json_extract(provenance_json, '$.usage.steps') AS spent_steps,
            json_extract(provenance_json, '$.usage.inputTokens') AS input_tokens,
            json_extract(provenance_json, '$.usage.outputTokens') AS output_tokens,
            json_extract(provenance_json, '$.usage.costUsd') AS cost_usd,
            json_extract(provenance_json, '$.usage.wallTimeMs') AS wall_time_ms
          FROM research_reports WHERE run_id = 1
        `).get()).toEqual({
          request_id: "restart-request-2",
          spent_steps: 4,
          input_tokens: 20,
          output_tokens: 10,
          cost_usd: 0.2,
          wall_time_ms: 200,
        });
        expect(restartedDatabase.connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events
          WHERE job_id = ? AND event_type = 'recovered'
        `).pluck().get(resumed.id)).toBe(1);
      } finally {
        restartedDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps provider input to ordinals and trust labels without database IDs", async () => {
    const ledger = makeLedger();
    const provider = makeProvider();
    await createResearchWorker(ledger.ledger, makeReader(), provider, {
      clock: () => fixedNow,
    }).executeClaim(makeClaim());

    const input = vi.mocked(provider.quote).mock.calls[0]![0];
    expect(input.sources[0]).toEqual({
      ordinal: 1,
      trust: "untrusted_source_material",
      url: "https://example.com",
      title: "Example",
      evidenceMaterial: "Alpha beta",
    });
    expect(JSON.stringify(input)).not.toContain("sourceId");
    expect(JSON.stringify(input)).not.toContain("snapshotId");
  });

  it("hard-refuses a call when quote plus validation/publication does not fit", async () => {
    const claim = makeClaim({
      task: { ...makeClaim().task, budget: { maxSteps: 2, maxTokens: 100, maxCostUsd: 1,
        maxWallTimeMs: 1_000 } },
    });
    const ledger = makeLedger(claim);
    const provider = makeProvider();
    await createResearchWorker(ledger.ledger, makeReader(), provider).executeClaim(claim);

    expect(provider.starts).toBe(0);
    expect(ledger.failures).toHaveLength(1);
    expect(ledger.failures[0]!.failure).toEqual({ code: "JOB_BUDGET_EXHAUSTED" });
  });

  it("schedules retryable provider errors with max(jitter, retry-after)", async () => {
    const ledger = makeLedger();
    const provider = makeProvider();
    provider.start = vi.fn(async () => {
      throw new ResearchProviderError("RESEARCH_PROVIDER_HTTP", true, 429, 7_000);
    });
    const worker = createResearchWorker(ledger.ledger, makeReader(), provider, {
      clock: () => fixedNow,
      jitter: () => 2_500,
    });

    await worker.executeClaim(makeClaim());

    expect(ledger.failures[0]!.failure).toEqual({
      code: "JOB_INPUT_UNAVAILABLE",
      retryAt: "2026-08-14T10:00:07.000Z",
    });
  });

  it("checkpoints provider-known usage before scheduling its retry", async () => {
    const ledger = makeLedger();
    const provider = makeProvider();
    provider.start = vi.fn(async () => ({
      requestId: "request-with-usage",
      async read() {
        throw new ResearchProviderError(
          "RESEARCH_PROVIDER_HTTP",
          true,
          503,
          undefined,
          providerUsage,
        );
      },
    }));
    await createResearchWorker(ledger.ledger, makeReader(), provider, {
      clock: () => fixedNow,
      jitter: () => 1_000,
    }).executeClaim(makeClaim());

    const usageIndex = ledger.checkpoints.findIndex((entry) => entry.usage.inputTokens === 10);
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(ledger.events.indexOf("fail")).toBeGreaterThan(usageIndex);
    expect(ledger.failures[0]!.failure).toEqual({
      code: "JOB_INPUT_UNAVAILABLE",
      retryAt: "2026-08-14T10:00:01.000Z",
    });
  });

  it("retries a corpus mismatch without consuming a completed logical step", async () => {
    const ledger = makeLedger();
    const reader = makeReader({
      readForJob: vi.fn(() => {
        throw new ResearchCorpusReaderError("RESEARCH_CORPUS_MISMATCH", "private detail");
      }),
    });
    await createResearchWorker(ledger.ledger, reader, makeProvider(), {
      clock: () => fixedNow,
      jitter: () => 1_000,
    }).executeClaim(makeClaim());

    expect(ledger.failures[0]).toMatchObject({
      checkpoint: { checkpoint: { nextStep: 0 }, usage: { steps: 0 } },
      failure: { code: "JOB_INPUT_UNAVAILABLE", retryAt: "2026-08-14T10:00:01.000Z" },
    });
  });

  it("does not call or bind a provider when cancellation is observed at provider-ready", async () => {
    const ledger = makeLedger();
    ledger.checkpointStatus = (input, call) =>
      nextStep(input) === 1 && call >= 2 ? "cancelled" : "running";
    const provider = makeProvider();
    await createResearchWorker(ledger.ledger, makeReader(), provider).executeClaim(makeClaim());

    expect(provider.starts).toBe(0);
    expect(ledger.binds).toHaveLength(0);
    expect(ledger.failures).toHaveLength(0);
  });

  it("rechecks cancellation after provider binding and before the remote call", async () => {
    const ledger = makeLedger();
    ledger.ledger.bindAttemptProvider = vi.fn((_claim, metadata) => {
      ledger.events.push("bind");
      ledger.binds.push(metadata);
      ledger.checkpointStatus = () => "cancelled";
    });
    const provider = makeProvider();

    await createResearchWorker(ledger.ledger, makeReader(), provider)
      .executeClaim(makeClaim());

    expect(ledger.binds).toHaveLength(1);
    expect(provider.starts).toBe(0);
    expect(ledger.failures).toHaveLength(0);
  });

  it("makes zero provider calls when reservation adoption rejects provider binding", async () => {
    const ledger = makeLedger();
    ledger.ledger.bindAttemptProvider = vi.fn(() => {
      throw new DurableAiJobError(
        "INVALID_JOB_TRANSITION",
        "Live acquisition provider reservation adoption is invalid",
      );
    });
    const provider = makeProvider();

    await createResearchWorker(ledger.ledger, makeReader(), provider)
      .executeClaim(makeClaim());

    expect(ledger.ledger.bindAttemptProvider).toHaveBeenCalledOnce();
    expect(provider.starts).toBe(0);
  });

  it("aborts a started response when recording its request loses the lease", async () => {
    const ledger = makeLedger();
    ledger.ledger.recordAttemptRequest = vi.fn(() => {
      throw new DurableAiJobError("JOB_LEASE_LOST", "lost after response headers");
    });
    let requestSignal: AbortSignal | undefined;
    const provider = makeProvider();
    provider.start = vi.fn(async (_input, _quote, signal) => {
      requestSignal = signal;
      return {
        requestId: "request-after-lease-loss",
        async read() {
          return makeOutput();
        },
      };
    });

    await createResearchWorker(ledger.ledger, makeReader(), provider)
      .executeClaim(makeClaim());

    expect(requestSignal?.aborted).toBe(true);
    expect(ledger.completed).toHaveLength(0);
    expect(ledger.failures).toHaveLength(0);
  });

  it("aborts on renewal cancellation and checkpoints the cancellation fence", async () => {
    const claim = makeClaim();
    const ledger = makeLedger(claim);
    ledger.renewResult = "cancelled";
    let tick: (() => void) | undefined;
    let sawAbort = false;
    const provider = makeProvider();
    provider.start = vi.fn((_input, _quote, signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new ResearchProviderError("RESEARCH_PROVIDER_ABORTED", true));
      }, { once: true });
    }));
    const worker = createResearchWorker(ledger.ledger, makeReader(), provider, {
      setInterval(callback) {
        tick = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    });
    const running = worker.executeClaim(claim);
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalledOnce());
    tick!();
    await running;

    expect(sawAbort).toBe(true);
    expect(nextStep(ledger.checkpoints.at(-1)!)).toBe(1);
    expect(ledger.failures).toHaveLength(0);
  });

  it("persists returned usage before a cancellation prevents publication", async () => {
    const ledger = makeLedger();
    ledger.checkpointStatus = (input) =>
      input.usage.inputTokens === providerUsage.inputTokens ? "cancelled" : "running";
    await createResearchWorker(ledger.ledger, makeReader(), makeProvider(), {
      clock: () => fixedNow,
    }).executeClaim(makeClaim());

    expect(ledger.checkpoints.some((entry) => entry.usage.inputTokens === 10)).toBe(true);
    expect(ledger.completed).toHaveLength(0);
  });

  it("persists known usage then fails closed on forged evidence", async () => {
    const ledger = makeLedger();
    const output = makeOutput({
      claims: [{
        claim: "Forged",
        confidence: 1,
        isInference: false,
        rationale: null,
        evidence: [{
          kind: "tab_content",
          sourceOrdinal: 99,
          locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 1 },
        }],
      }],
    });
    await createResearchWorker(ledger.ledger, makeReader(), makeProvider(output), {
      clock: () => fixedNow,
    }).executeClaim(makeClaim());

    expect(ledger.checkpoints.some((entry) => entry.usage.inputTokens === 10)).toBe(true);
    expect(ledger.completed).toHaveLength(0);
    expect(ledger.failures[0]!.failure).toEqual({ code: "JOB_INPUT_UNAVAILABLE" });
  });

  it("prevents fresh publication when the corpus changes on the terminal reread", async () => {
    const ledger = makeLedger();
    const initial = makeCorpus();
    let reads = 0;
    const reader = makeReader({
      readForJob: vi.fn(() => {
        reads += 1;
        return reads === 1 ? initial : { ...initial, corpusDigest: "9".repeat(64) };
      }),
    });
    await createResearchWorker(ledger.ledger, reader, makeProvider(), {
      clock: () => fixedNow,
      jitter: () => 1_000,
    }).executeClaim(makeClaim());

    expect(ledger.completed).toHaveLength(0);
    expect(ledger.failures[0]!.failure).toEqual({
      code: "JOB_INPUT_UNAVAILABLE",
      retryAt: "2026-08-14T10:00:01.000Z",
    });
  });

  it("keeps selection progress total nullable through terminal publication", async () => {
    const base = makeClaim();
    if (base.task.kind !== "resource_research") throw new Error("invalid fixture");
    const claim = makeClaim({
      task: {
        ...base.task,
        subject: { type: "selection", fingerprint: "8".repeat(64) },
      },
    });
    const corpus = makeCorpus();
    const selectionCorpus: ApprovedResearchCorpus = {
      ...corpus,
      target: {
        type: "selection",
        logicalPageIds: [3],
        fingerprint: "8".repeat(64),
      },
      selectionLogicalPageIds: [3],
    };
    const audit = makeAudit();
    const ledger = makeLedger(claim);
    await createResearchWorker(ledger.ledger, makeReader({
      readForJob: vi.fn(() => selectionCorpus),
      readAuditForJob: vi.fn(() => ({
        ...audit,
        target: selectionCorpus.target,
      })),
    }), makeProvider(), { clock: () => fixedNow }).executeClaim(claim);

    expect(ledger.checkpoints.every((entry) => entry.progress.total === null)).toBe(true);
    expect(ledger.completed[0]!.checkpoint.progress).toEqual({
      completed: 1,
      total: null,
      stage: "terminal_publication",
    });
  });

  it("publishes only an audit stale guard on an attempt-three corpus mismatch", async () => {
    const claim = makeClaim({ attemptNo: 3 });
    const ledger = makeLedger(claim);
    const reader = makeReader({
      readForJob: vi.fn(() => {
        throw new ResearchCorpusReaderError("RESEARCH_CORPUS_MISMATCH", "raw secret");
      }),
    });
    const provider = makeProvider();
    await createResearchWorker(ledger.ledger, reader, provider, {
      clock: () => fixedNow,
    }).executeClaim(claim);

    expect(provider.starts).toBe(0);
    expect(ledger.binds).toEqual([{
      provider: "tabhub",
      model: "research-stale-guard",
      promptVersion: "v1",
      pricingVersion: "tabhub-no-charge-v1",
    }]);
    const draft = ledger.completed[0]!.draft as {
      status: string; reason: string; claims: unknown[]; usedSourceIds: number[];
      provenance: { requestId: string | null };
    };
    expect(draft).toMatchObject({
      status: "partial",
      reason: "corpus_became_stale",
      claims: [],
      usedSourceIds: [],
      provenance: { requestId: null },
    });
  });

  it("lets redaction win without a report", async () => {
    const ledger = makeLedger();
    const reader = makeReader({
      readForJob: vi.fn(() => {
        throw new ResearchCorpusReaderError("RESEARCH_REDACTION_REQUIRED", "raw secret");
      }),
    });
    await createResearchWorker(ledger.ledger, reader, makeProvider()).executeClaim(makeClaim());

    expect(ledger.ledger.cancel).toHaveBeenCalledWith("resource_research", 7, "agent");
    expect(ledger.completed).toHaveLength(0);
    expect(ledger.failures).toHaveLength(0);
  });

  it("stop aborts and awaits active provider work", async () => {
    const ledger = makeLedger();
    let aborted = false;
    const provider = makeProvider();
    provider.start = vi.fn((_input, _quote, signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new ResearchProviderError("RESEARCH_PROVIDER_ABORTED", true));
      }, { once: true });
    }));
    const worker = createResearchWorker(ledger.ledger, makeReader(), provider);
    const execution = worker.executeClaim(makeClaim());
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalledOnce());
    await worker.stop();
    await execution;

    expect(aborted).toBe(true);
    expect(worker.claim("after-stop")).toBeUndefined();
    expect(ledger.failures).toHaveLength(0);
  });
});
