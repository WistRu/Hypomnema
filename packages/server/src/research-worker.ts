import { createHash } from "node:crypto";

import {
  researchCanonicalSha256PayloadV1,
  researchClaimListSchema,
  researchCumulativeUsageSchema,
  researchDossierSchema,
  researchPublicationDraftSchema,
  type ResearchClaimDraft,
  type ResearchCumulativeUsage,
  type ResearchEvidenceDraft,
  type ResearchPublicationDraft,
} from "@tabhub/shared";

import {
  AI_JOB_RENEW_EVERY_MS,
  RESEARCH_STALE_GUARD_DOSSIER,
  RESEARCH_STALE_GUARD_METADATA,
  type AiJobCheckpointInput,
  type AiJobClaim,
  type AiJobLedger,
  type AiJobResearchCheckpoint,
} from "./ai-job-ledger.js";
import type { AiJobClaimBoundary } from "./ai-job-runtime-state.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import {
  ResearchCorpusReaderError,
  type ApprovedResearchCorpus,
  type ResearchCorpusAudit,
  type ResearchCorpusReader,
} from "./research-corpus.js";
import {
  ResearchProviderError,
  type ResearchProvider,
  type ResearchProviderInput,
  type ResearchProviderOutput,
  type ResearchProviderQuote,
} from "./research-provider.js";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const emptyUsage = Object.freeze({
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  wallTimeMs: 0,
});
const publicationUsage = Object.freeze({ ...emptyUsage, steps: 1 });
const researchClaimLimits = Object.freeze({
  maxConcurrent: 1,
  maxAttemptsPerUtcDay: 10,
  maxCostUsdPerUtcDay: 2,
});

type TimerHandle = ReturnType<typeof setInterval>;

export interface ResearchWorkerOptions {
  readonly clock?: () => Date;
  readonly random?: () => number;
  readonly jitter?: (baseDelayMs: number, maximumDelayMs: number) => number;
  readonly renewEveryMs?: number;
  readonly setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
}

export interface ResearchWorker {
  recoverInterrupted(): number;
  claim(workerId: string, boundary?: AiJobClaimBoundary): AiJobClaim | undefined;
  executeClaim(claim: AiJobClaim): Promise<void>;
  stop(): Promise<void>;
}

type ResearchProgress = AiJobCheckpointInput["progress"];

interface ActiveExecution {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

interface ExecutionFence {
  reason: "cancelled" | "lease_lost" | "shutdown" | null;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(researchCanonicalSha256PayloadV1(value))
    .digest("hex");
}

function addUsage(
  left: ResearchCumulativeUsage,
  right: ResearchCumulativeUsage,
): ResearchCumulativeUsage {
  return researchCumulativeUsageSchema.parse({
    steps: left.steps + right.steps,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  });
}

function progressFor(claim: AiJobClaim, checkpoint: AiJobResearchCheckpoint): ResearchProgress {
  return {
    completed: checkpoint.nextStep === 2 ? 1 : 0,
    total: claim.task.subject.type === "selection" ? null : 1,
    stage: checkpoint.stage,
  };
}

function checkpointInput(
  claim: AiJobClaim,
  checkpoint: AiJobResearchCheckpoint,
  usage: ResearchCumulativeUsage = emptyUsage,
): AiJobCheckpointInput {
  return { progress: progressFor(claim, checkpoint), checkpoint, usage };
}

function providerInputFor(corpus: ApprovedResearchCorpus): ResearchProviderInput {
  return {
    version: 1,
    target: corpus.target,
    question: corpus.question,
    sources: corpus.sources.map((source) => ({
      ordinal: source.ordinal,
      trust: "untrusted_source_material" as const,
      url: source.payload.url,
      title: source.payload.title,
      evidenceMaterial: source.payload.evidenceMaterial,
    })),
    snapshots: corpus.snapshots.map((snapshot) => ({
      ordinal: snapshot.ordinal,
      kind: snapshot.kind,
      trust: "untrusted_source_material" as const,
      material: snapshot.material,
    })),
    parent: corpus.parent === null ? null : {
      reportId: corpus.parent.reportId,
      reportVersion: corpus.parent.reportVersion,
      trust: "untrusted_prior_report" as const,
      reportText: corpus.parent.reportText,
    },
  };
}

function isValidQuote(value: ResearchProviderQuote): boolean {
  return value !== null && typeof value === "object" &&
    Object.keys(value).sort().join(",") ===
      "calls,costUsd,inputDigest,inputTokens,outputTokens,version,wallTimeMs" &&
    value.version === "research_provider_quote:v1" &&
    /^[0-9a-f]{64}$/.test(value.inputDigest) && value.calls === 1 &&
    Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 &&
    Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 &&
    typeof value.costUsd === "number" && Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 && Number.isSafeInteger(value.wallTimeMs) && value.wallTimeMs >= 0;
}

function fitsBudget(
  claim: AiJobClaim,
  quote: ResearchProviderQuote,
  validationSteps: number,
): boolean {
  if (claim.task.kind !== "resource_research") return false;
  const budget = claim.task.budget;
  const remainingSteps = budget.maxSteps - claim.usage.steps;
  const remainingTokens = budget.maxTokens - claim.usage.inputTokens - claim.usage.outputTokens;
  const remainingCost = budget.maxCostUsd - claim.usage.costUsd;
  const remainingWallTime = budget.maxWallTimeMs - claim.usage.wallTimeMs;
  const requiredSteps = validationSteps + quote.calls + publicationUsage.steps;
  const requiredTokens = quote.inputTokens + quote.outputTokens;
  return remainingSteps > 0 && remainingTokens > 0 && remainingCost > 0 &&
    remainingWallTime > 0 && requiredSteps <= remainingSteps &&
    requiredTokens <= remainingTokens && quote.costUsd <= remainingCost &&
    quote.wallTimeMs <= remainingWallTime;
}

function publicationFits(claim: AiJobClaim): boolean {
  if (claim.task.kind !== "resource_research") return false;
  return claim.usage.steps < claim.task.budget.maxSteps &&
    claim.usage.inputTokens <= claim.task.budget.maxTokens &&
    claim.usage.outputTokens <= claim.task.budget.maxTokens - claim.usage.inputTokens &&
    claim.usage.costUsd <= claim.task.budget.maxCostUsd &&
    claim.usage.wallTimeMs <= claim.task.budget.maxWallTimeMs;
}

function sameReadyCheckpoint(
  checkpoint: AiJobResearchCheckpoint,
  expected: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>,
): boolean {
  return checkpoint.nextStep === 1 && checkpoint.corpusDigest === expected.corpusDigest &&
    checkpoint.parentDigest === expected.parentDigest &&
    checkpoint.providerInputDigest === expected.providerInputDigest &&
    checkpoint.quoteDigest === expected.quoteDigest;
}

function validateOutputShape(output: ResearchProviderOutput): void {
  if (output === null || typeof output !== "object" ||
      Object.keys(output).sort().join(",") !== "claims,dossier,stopReason,usage,version" ||
      output.version !== 1 ||
      !["complete", "max_output_tokens", "refusal"].includes(output.stopReason)) {
    throw new TypeError("invalid provider output");
  }
  researchDossierSchema.parse(output.dossier);
  researchCumulativeUsageSchema.parse(output.usage);
}

function validateUsageAgainstQuote(
  usage: ResearchCumulativeUsage,
  quote: ResearchProviderQuote,
): void {
  if (usage.steps !== quote.calls || usage.inputTokens > quote.inputTokens ||
      usage.outputTokens > quote.outputTokens || usage.costUsd > quote.costUsd ||
      usage.wallTimeMs > quote.wallTimeMs) {
    throw new TypeError("provider usage exceeds quote");
  }
}

function deriveClaims(
  output: ResearchProviderOutput,
  corpus: ApprovedResearchCorpus,
): { claims: ResearchClaimDraft[]; usedSourceIds: number[] } {
  const sources = new Map(corpus.sources.map((source) => [source.ordinal, source]));
  const snapshots = new Map(corpus.snapshots.map((snapshot) => [snapshot.ordinal, snapshot]));
  const usedSourceIds = new Set<number>();
  const claims = output.claims.map((claim): ResearchClaimDraft => {
    const evidence = claim.evidence.map((item): ResearchEvidenceDraft => {
      if (item.kind === "tab_content") {
        const source = sources.get(item.sourceOrdinal);
        if (source === undefined) throw new TypeError("unknown source ordinal");
        const bytes = encoder.encode(source.payload.evidenceMaterial);
        const { byteStart, byteEnd } = item.locator;
        if (byteStart < 0 || byteEnd <= byteStart || byteEnd > bytes.byteLength) {
          throw new TypeError("invalid evidence range");
        }
        const excerpt = bytes.slice(byteStart, byteEnd);
        fatalDecoder.decode(excerpt);
        usedSourceIds.add(source.sourceId);
        return {
          kind: "tab_content",
          sourceId: source.sourceId,
          locator: item.locator,
          excerptHash: createHash("sha256").update(excerpt).digest("hex"),
        };
      }
      const snapshot = snapshots.get(item.snapshotOrdinal);
      if (snapshot === undefined || snapshot.kind !== item.kind) {
        throw new TypeError("unknown snapshot ordinal");
      }
      return {
        kind: item.kind,
        snapshotId: snapshot.snapshotId,
        locator: item.locator,
        excerptHash: createHash("sha256")
          .update(researchCanonicalSha256PayloadV1(snapshot.material))
          .digest("hex"),
      };
    });
    return {
      claim: claim.claim,
      confidence: claim.confidence,
      isInference: claim.isInference,
      rationale: claim.rationale,
      evidence,
    };
  });
  const parsed = researchClaimListSchema.parse(claims);
  return { claims: parsed, usedSourceIds: [...usedSourceIds].sort((a, b) => a - b) };
}

function terminalCheckpoint(
  ready: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>,
  providerOutputDigest: string,
): Extract<AiJobResearchCheckpoint, { readonly nextStep: 2 }> {
  return {
    ...ready,
    nextStep: 2,
    stage: "terminal_publication",
    providerOutputDigest,
  };
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof DurableAiJobError && error.code === "JOB_LEASE_LOST";
}

function isRedaction(error: unknown): boolean {
  return error instanceof ResearchCorpusReaderError &&
    error.code === "RESEARCH_REDACTION_REQUIRED";
}

function isCorpusMismatch(error: unknown): boolean {
  return error instanceof ResearchCorpusReaderError &&
    error.code === "RESEARCH_CORPUS_MISMATCH";
}

export function createResearchWorker(
  ledger: AiJobLedger,
  corpusReader: ResearchCorpusReader,
  provider: ResearchProvider,
  options: ResearchWorkerOptions = {},
): ResearchWorker {
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const jitter = options.jitter ?? ((baseDelayMs: number, maximumDelayMs: number) =>
    Math.min(maximumDelayMs, baseDelayMs + Math.floor(random() * baseDelayMs)));
  const renewEveryMs = options.renewEveryMs ?? AI_JOB_RENEW_EVERY_MS;
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelInterval = options.clearInterval ?? clearInterval;
  if (!Number.isSafeInteger(renewEveryMs) || renewEveryMs <= 0) {
    throw new TypeError("renewEveryMs must be a positive safe integer");
  }

  let stopping = false;
  let active: ActiveExecution | null = null;

  function retryAt(attemptNo: number, retryAfterMs?: number): string {
    const exponent = Math.max(0, Math.min(30, attemptNo - 1));
    const baseDelayMs = Math.min(300_000, 1_000 * 2 ** exponent);
    const candidate = jitter(baseDelayMs, 300_000);
    const boundedJitter = Number.isFinite(candidate)
      ? Math.max(1_000, Math.min(300_000, Math.floor(candidate)))
      : baseDelayMs;
    const boundedRetryAfter = typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.floor(retryAfterMs) : 0;
    const delayMs = Math.max(boundedJitter, boundedRetryAfter);
    return new Date(clock().getTime() + delayMs).toISOString();
  }

  function currentResearchCheckpoint(claim: AiJobClaim): AiJobResearchCheckpoint {
    const checkpoint = claim.checkpoint;
    if (checkpoint !== null && "stage" in checkpoint) return checkpoint;
    return { version: 1, nextStep: 0, stage: "claimed" };
  }

  function tryRefresh(claim: AiJobClaim): AiJobClaim | undefined {
    try {
      return ledger.refresh(claim);
    } catch (error) {
      if (isLeaseLost(error)) return undefined;
      throw error;
    }
  }

  function cancelForRedaction(
    claim: AiJobClaim,
    checkpoint: AiJobResearchCheckpoint,
  ): void {
    try {
      ledger.cancel("resource_research", claim.id, "agent");
    } catch {
      // Redaction may already have cancelled and fenced the row.
    }
    try {
      ledger.checkpoint(claim, checkpointInput(claim, checkpoint));
    } catch {
      // A completed privacy transaction is already the stronger fence.
    }
  }

  function fail(
    claim: AiJobClaim,
    checkpoint: AiJobResearchCheckpoint,
    code: "JOB_INPUT_UNAVAILABLE" | "JOB_BUDGET_EXHAUSTED" | "INVALID_JOB_TRANSITION",
    retryable = false,
    retryAfterMs?: number,
    usage: ResearchCumulativeUsage = emptyUsage,
  ): void {
    try {
      ledger.fail(claim, checkpointInput(claim, checkpoint, usage), {
        code,
        ...(retryable ? { retryAt: retryAt(claim.attemptNo, retryAfterMs) } : {}),
      });
    } catch (error) {
      if (!isLeaseLost(error)) throw error;
    }
  }

  function beginRenewal(
    claim: AiJobClaim,
    controller: AbortController,
    fence: ExecutionFence,
  ): TimerHandle {
    return scheduleInterval(() => {
      if (fence.reason !== null) return;
      try {
        if (ledger.renew(claim) === undefined) {
          fence.reason = "cancelled";
          controller.abort();
        }
      } catch {
        fence.reason = "lease_lost";
        controller.abort();
      }
    }, renewEveryMs);
  }

  function checkpointKnownUsage(
    claim: AiJobClaim,
    ready: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>,
    usage: ResearchCumulativeUsage,
  ): boolean {
    const view = ledger.checkpoint(claim, checkpointInput(claim, ready, usage));
    return view.status === "running";
  }

  function settleFence(
    claim: AiJobClaim,
    checkpoint: AiJobResearchCheckpoint,
    fence: ExecutionFence,
  ): void {
    if (fence.reason !== "cancelled") return;
    try {
      ledger.checkpoint(claim, checkpointInput(claim, checkpoint));
    } catch {
      // Cancellation/redaction or lease loss is already a stronger terminal fence.
    }
  }

  function completePublication(
    claim: AiJobClaim,
    ready: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>,
    providerOutputDigest: string,
    draftWithoutProvenance: Omit<ResearchPublicationDraft, "provenance">,
    provenance: Omit<ResearchPublicationDraft["provenance"], "generatedAt" | "usage">,
  ): void {
    const refreshed = ledger.refresh(claim);
    const terminal = terminalCheckpoint(ready, providerOutputDigest);
    const generatedAt = clock().toISOString();
    const draft = researchPublicationDraftSchema.parse({
      ...draftWithoutProvenance,
      provenance: {
        ...provenance,
        generatedAt,
        usage: addUsage(refreshed.usage, publicationUsage),
      },
    });
    ledger.completeResearch(
      claim,
      checkpointInput(claim, terminal, publicationUsage),
      draft,
    );
  }

  function publishStaleGuard(
    claim: AiJobClaim,
    current: AiJobResearchCheckpoint,
  ): void {
    const refreshed = ledger.refresh(claim);
    if (!publicationFits(refreshed)) {
      fail(claim, current, "JOB_BUDGET_EXHAUSTED");
      return;
    }
    let audit: ResearchCorpusAudit;
    try {
      audit = corpusReader.readAuditForJob(`resource_research:${claim.id}`);
    } catch (error) {
      if (isRedaction(error)) cancelForRedaction(claim, current);
      else fail(claim, current, "JOB_INPUT_UNAVAILABLE");
      return;
    }
    const staleInput = {
      version: "research_stale_guard_input:v1",
      auditDigest: audit.digest,
      corpusFingerprint: audit.corpusFingerprint,
      target: audit.target,
    };
    const staleQuote = {
      version: "research_stale_guard_quote:v1",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    };
    let ready: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>;
    if (current.nextStep === 1) {
      ready = current;
    } else if (current.nextStep === 0) {
      ready = {
        version: 1,
        nextStep: 1,
        stage: "provider_ready",
        corpusDigest: audit.digest,
        parentDigest: null,
        providerInputDigest: canonicalDigest(staleInput),
        quoteDigest: canonicalDigest(staleQuote),
      };
      const view = ledger.checkpoint(claim, checkpointInput(claim, ready));
      if (view.status !== "running") return;
    } else {
      fail(claim, current, "INVALID_JOB_TRANSITION");
      return;
    }
    try {
      const cancellable = ledger.checkpoint(claim, checkpointInput(claim, ready));
      if (cancellable.status !== "running") return;
      ledger.bindAttemptProvider(claim, RESEARCH_STALE_GUARD_METADATA);
    } catch (error) {
      if (isLeaseLost(error)) return;
      try {
        const refreshedAfterBind = ledger.checkpoint(claim, checkpointInput(claim, ready));
        if (refreshedAfterBind.status !== "running") return;
      } catch (checkpointError) {
        if (isLeaseLost(checkpointError)) return;
      }
      fail(claim, ready, "INVALID_JOB_TRANSITION");
      return;
    }
    try {
      completePublication(
        claim,
        ready,
        canonicalDigest({ version: "research_stale_guard_output:v1", auditDigest: audit.digest }),
        {
          version: 1,
          status: "partial",
          reason: "corpus_became_stale",
          corpusFingerprint: audit.corpusFingerprint,
          inputFingerprint: claim.inputFingerprint,
          coverage: audit.coverage,
          usedSourceIds: [],
          dossier: RESEARCH_STALE_GUARD_DOSSIER,
          claims: [],
        },
        { ...RESEARCH_STALE_GUARD_METADATA, requestId: null },
      );
    } catch (error) {
      if (isLeaseLost(error)) return;
      fail(claim, ready, "JOB_INPUT_UNAVAILABLE");
    }
  }

  async function runClaim(claim: AiJobClaim, controller: AbortController): Promise<void> {
    if (claim.kind !== "resource_research" || claim.task.kind !== "resource_research") {
      throw new DurableAiJobError("INVALID_JOB_INPUT", "Research worker received another kind");
    }
    let current = currentResearchCheckpoint(claim);
    if (current.nextStep === 2) {
      fail(claim, current, "INVALID_JOB_TRANSITION");
      return;
    }
    if (claim.checkpoint === null) {
      const view = ledger.checkpoint(claim, checkpointInput(claim, current));
      if (view.status !== "running") return;
    }
    if (stopping) return;

    let corpus: ApprovedResearchCorpus;
    try {
      corpus = corpusReader.readForJob(`resource_research:${claim.id}`);
    } catch (error) {
      if (isRedaction(error)) {
        cancelForRedaction(claim, current);
      } else if (isCorpusMismatch(error) && claim.attemptNo >= 3) {
        publishStaleGuard(claim, current);
      } else {
        fail(claim, current, "JOB_INPUT_UNAVAILABLE", isCorpusMismatch(error));
      }
      return;
    }

    const providerInput = providerInputFor(corpus);
    const providerInputDigest = canonicalDigest(providerInput);
    let quote: ResearchProviderQuote;
    try {
      quote = provider.quote(providerInput);
    } catch {
      fail(claim, current, "JOB_INPUT_UNAVAILABLE");
      return;
    }
    if (!isValidQuote(quote)) {
      fail(claim, current, "JOB_INPUT_UNAVAILABLE");
      return;
    }
    const expectedReady: Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }> = {
      version: 1,
      nextStep: 1,
      stage: "provider_ready",
      corpusDigest: corpus.corpusDigest,
      parentDigest: corpus.parent?.digest ?? null,
      providerInputDigest,
      quoteDigest: canonicalDigest(quote),
    };
    if (current.nextStep === 1 && !sameReadyCheckpoint(current, expectedReady)) {
      const corpusOrParentChanged = current.corpusDigest !== expectedReady.corpusDigest ||
        current.parentDigest !== expectedReady.parentDigest;
      if (corpusOrParentChanged && claim.attemptNo >= 3) {
        publishStaleGuard(claim, current);
      } else {
        fail(claim, current, "JOB_INPUT_UNAVAILABLE", corpusOrParentChanged);
      }
      return;
    }
    const refreshedForBudget = tryRefresh(claim);
    if (refreshedForBudget === undefined) return;
    const validationSteps = current.nextStep === 0 ? 1 : 0;
    if (!fitsBudget(refreshedForBudget, quote, validationSteps)) {
      fail(claim, current, "JOB_BUDGET_EXHAUSTED");
      return;
    }
    if (current.nextStep === 0) {
      const view = ledger.checkpoint(
        claim,
        checkpointInput(claim, expectedReady, { ...emptyUsage, steps: 1 }),
      );
      if (view.status !== "running") return;
      current = expectedReady;
    }
    const ready = current as Extract<AiJobResearchCheckpoint, { readonly nextStep: 1 }>;

    const preBind = ledger.checkpoint(claim, checkpointInput(claim, ready));
    if (preBind.status !== "running") return;
    try {
      ledger.bindAttemptProvider(claim, provider.metadata);
    } catch (error) {
      const afterBindFailure = tryRefresh(claim);
      if (afterBindFailure === undefined) return;
      fail(claim, ready, "INVALID_JOB_TRANSITION");
      return;
    }
    const preCall = ledger.checkpoint(claim, checkpointInput(claim, ready));
    if (preCall.status !== "running") return;

    const fence: ExecutionFence = { reason: null };
    const renewal = beginRenewal(claim, controller, fence);
    try {
      if (stopping) {
        fence.reason = "shutdown";
        controller.abort();
        return;
      }
      let started;
      try {
        started = await provider.start(providerInput, quote, controller.signal);
        try {
          ledger.recordAttemptRequest(claim, started.requestId);
        } catch (error) {
          // A response now exists. Fence its body immediately if the durable
          // request binding lost the lease or observed cancellation.
          controller.abort();
          throw error;
        }
        if (fence.reason !== null) {
          settleFence(claim, ready, fence);
          return;
        }
        const output = await started.read();
        const running = checkpointKnownUsage(claim, ready, output.usage);
        if (!running) return;
        if (fence.reason !== null) {
          settleFence(claim, ready, fence);
          return;
        }
        validateOutputShape(output);
        validateUsageAgainstQuote(output.usage, quote);
        if (output.stopReason !== "complete") {
          fail(claim, ready, "JOB_INPUT_UNAVAILABLE");
          return;
        }
        const derived = deriveClaims(output, corpus);
        let audit: ResearchCorpusAudit;
        let finalCorpus: ApprovedResearchCorpus;
        try {
          audit = corpusReader.readAuditForJob(`resource_research:${claim.id}`);
          finalCorpus = corpusReader.readForJob(`resource_research:${claim.id}`);
        } catch (error) {
          if (isRedaction(error)) cancelForRedaction(claim, ready);
          else if (isCorpusMismatch(error)) {
            // This attempt is provider-bound, so the internal stale guard cannot
            // safely replace its provenance tuple. Retry or fail without a report.
            fail(claim, ready, "JOB_INPUT_UNAVAILABLE", claim.attemptNo < 3);
          } else fail(claim, ready, "JOB_INPUT_UNAVAILABLE");
          return;
        }
        if (finalCorpus.corpusDigest !== corpus.corpusDigest ||
            (finalCorpus.parent?.digest ?? null) !== (corpus.parent?.digest ?? null) ||
            audit.corpusFingerprint !== corpus.corpusFingerprint) {
          fail(claim, ready, "JOB_INPUT_UNAVAILABLE", claim.attemptNo < 3);
          return;
        }
        const coverage = { ...audit.coverage, used: derived.usedSourceIds.length };
        completePublication(
          claim,
          ready,
          canonicalDigest(output),
          {
            version: 1,
            status: "succeeded",
            reason: null,
            corpusFingerprint: corpus.corpusFingerprint,
            inputFingerprint: claim.inputFingerprint,
            coverage,
            usedSourceIds: derived.usedSourceIds,
            dossier: output.dossier,
            claims: derived.claims,
          },
          { ...provider.metadata, requestId: started.requestId },
        );
      } catch (error) {
        if (fence.reason !== null) {
          settleFence(claim, ready, fence);
          return;
        }
        if (stopping || isLeaseLost(error)) return;
        if (error instanceof ResearchProviderError) {
          if (error.knownUsage !== undefined) {
            try {
              const running = checkpointKnownUsage(claim, ready, error.knownUsage);
              if (!running) return;
            } catch (usageError) {
              if (isLeaseLost(usageError)) return;
              fail(
                claim,
                ready,
                usageError instanceof DurableAiJobError &&
                  usageError.code === "JOB_BUDGET_EXHAUSTED"
                  ? "JOB_BUDGET_EXHAUSTED" : "JOB_INPUT_UNAVAILABLE",
              );
              return;
            }
          }
          fail(
            claim,
            ready,
            "JOB_INPUT_UNAVAILABLE",
            error.retryable,
            error.retryAfterMs,
          );
          return;
        }
        fail(
          claim,
          ready,
          error instanceof DurableAiJobError && error.code === "JOB_BUDGET_EXHAUSTED"
            ? "JOB_BUDGET_EXHAUSTED" : "JOB_INPUT_UNAVAILABLE",
        );
      }
    } finally {
      cancelInterval(renewal);
    }
  }

  const worker: ResearchWorker = {
    recoverInterrupted() {
      return ledger.recoverInterrupted();
    },
    claim(workerId, boundary) {
      if (stopping) return undefined;
      return ledger.claimNext(
        "resource_research",
        workerId,
        researchClaimLimits,
        boundary,
      );
    },
    async executeClaim(claim) {
      if (stopping) return;
      if (active !== null) {
        throw new DurableAiJobError(
          "INVALID_JOB_TRANSITION",
          "Research worker already has an active claim",
        );
      }
      const abortController = new AbortController();
      const promise = runClaim(claim, abortController);
      active = { abortController, promise };
      try {
        await promise;
      } finally {
        if (active?.promise === promise) active = null;
      }
    },
    async stop() {
      stopping = true;
      const execution = active;
      execution?.abortController.abort();
      await execution?.promise;
    },
  };
  return worker;
}
