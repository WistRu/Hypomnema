import { createHash, randomBytes } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  aiTaskSpecSchema,
  estimateResearchReservationV1,
  liveAcquisitionEffectivePolicy,
  liveAcquisitionPreflightRequestSchema,
  liveAcquisitionPreflightSchema,
  liveAcquisitionStartReceiptSchema,
  liveAcquisitionStartRequestSchema,
  liveAcquisitionWorkflowRef,
  type LiveAcquisitionPreflight,
  type LiveAcquisitionPreflightRequest,
  type LiveAcquisitionStartReceipt,
  type LiveAcquisitionStartRequest,
  type ResearchApprovalRequest,
  type ResearchApprovedDraft,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import type Database from "better-sqlite3";

import type { ResearchLedgerAdapter } from "./ai-job-ledger.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import { classifyLiveAcquisitionUrl } from "./live-acquisition-policy.js";
import { createResourceCatalog, type ResourceUrlPreview } from "./resource-catalog.js";
import type {
  ResearchProviderInput,
  ResearchProviderMetadata,
  ResearchProviderQuote,
} from "./research-provider.js";
import {
  buildCurrentResearchDraft,
  buildCurrentResearchProjection,
  fingerprintResearchApproval,
  ResearchBoundaryError,
} from "./research-store.js";
import { projectResearchPreflight } from "./research-workflow.js";

interface QuoteProvider {
  readonly metadata: Readonly<ResearchProviderMetadata>;
  quote(input: ResearchProviderInput): Readonly<ResearchProviderQuote>;
}

export interface LiveAcquisitionWorkflowOptions {
  readonly connection: Database.Database;
  readonly research: ResearchLedgerAdapter;
  readonly provider: QuoteProvider;
  readonly clock?: () => Date;
  readonly digestKey?: () => Uint8Array;
  readonly maxAttemptsPerUtcDay?: number;
  readonly previewResourceUrl?: (url: string, rulesetVersion: number) => ResourceUrlPreview;
  /** Test-only deterministic fault boundary; production leaves it absent. */
  readonly fault?: (point: "after_job_insert" | "after_research_submission" |
    "after_consent_insert") => void;
}

export class LiveAcquisitionBudgetExhaustedError extends DurableAiJobError {
  readonly dailyStartsRemaining = 0 as const;

  constructor(readonly dailyStartsResetAt: string) {
    super("JOB_BUDGET_EXHAUSTED", "Live acquisition daily attempt limit is exhausted");
    this.name = "LiveAcquisitionBudgetExhaustedError";
  }
}

export interface LiveAcquisitionWorkflow {
  preflight(request: LiveAcquisitionPreflightRequest): LiveAcquisitionPreflight;
  start(request: LiveAcquisitionStartRequest): LiveAcquisitionStartReceipt;
}

interface GenerationState {
  readonly resourceGenerationId: number;
  readonly resourceGenerationDigest: string;
  readonly historyEpochId: number;
  readonly runtimeEpoch: number;
  readonly rulesetVersion: number;
  readonly rulesetGenerationDigest: string;
}

interface FreshPreflight {
  readonly public: LiveAcquisitionPreflight;
  readonly approval: ResearchApprovalRequest;
  readonly taskBudget: ResourceResearchTaskSpec["budget"];
  readonly limitsJson: string;
  readonly generation: GenerationState;
  readonly dailyStartsRemaining: number;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("invalid live acquisition clock");
  }
  return value.toISOString();
}

function researchApproval(
  input: LiveAcquisitionPreflightRequest,
  budget: ResourceResearchTaskSpec["budget"],
  approvalFingerprint: string,
  estimate = estimateResearchReservationV1({
    includedSources: 0,
    includedSourceBytes: 0,
    snapshotBytes: 0,
    questionBytes: 0,
    budget,
  }),
): ResearchApprovalRequest {
  return {
    version: 1,
    target: input.research.target,
    question: input.research.question,
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: input.research.includeShareableContext,
      maxIncludedSources: input.research.maxIncludedSources,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests:
          input.research.confirmedOrigins.authenticatedOriginDigests,
        sensitiveOriginDigests: input.research.confirmedOrigins.sensitiveOriginDigests,
      },
    },
    parentReportId: input.research.parentReportId,
    approvalFingerprint,
    workflowRef: liveAcquisitionWorkflowRef,
    budget,
    estimate,
    captureIntent: input.research.captureIntent,
  };
}

function providerInput(
  draft: ResearchApprovedDraft,
  parent: ResearchProviderInput["parent"],
  worstCaseOrigin: string,
): ResearchProviderInput {
  const sources = draft.sources.flatMap((source) =>
    source.inclusionState === "included" && source.payload !== null
      ? [{ ordinal: source.ordinal, trust: "untrusted_source_material" as const,
          url: source.payload.url, title: source.payload.title,
          evidenceMaterial: source.payload.evidenceMaterial }]
      : []);
  const nextOrdinal = draft.sources.reduce(
    (highest, source) => Math.max(highest, source.ordinal),
    0,
  ) + 1;
  const worstCaseUrlPrefix = `${worstCaseOrigin}/`;
  const worstCaseUrlPrefixBytes = new TextEncoder().encode(worstCaseUrlPrefix).byteLength;
  if (worstCaseUrlPrefixBytes >= 8_192) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Live acquisition origin is too long");
  }
  return {
    version: 1,
    target: draft.target,
    question: draft.question,
    sources: [...sources, {
      ordinal: nextOrdinal,
      trust: "untrusted_source_material",
      url: `${worstCaseUrlPrefix}${"u".repeat(8_192 - worstCaseUrlPrefixBytes)}`,
      title: "t".repeat(8_192),
      evidenceMaterial: "x".repeat(65_536),
    }],
    snapshots: (draft.snapshots ?? []).map((snapshot) => ({
      ordinal: snapshot.ordinal,
      kind: snapshot.kind,
      trust: "untrusted_source_material" as const,
      material: snapshot.material,
    })),
    parent,
  };
}

function validateQuote(value: unknown, budget: ResourceResearchTaskSpec["budget"]):
ResearchProviderQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "calls,costUsd,inputDigest,inputTokens,outputTokens,version,wallTimeMs") {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Live acquisition quote is invalid");
  }
  const quote = value as Record<string, unknown>;
  if (quote.version !== "research_provider_quote:v1" || quote.calls !== 1 ||
      typeof quote.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(quote.inputDigest) ||
      !Number.isSafeInteger(quote.inputTokens) || Number(quote.inputTokens) < 1 ||
      !Number.isSafeInteger(quote.outputTokens) || Number(quote.outputTokens) < 1 ||
      Number(quote.outputTokens) > 200_000 ||
      Number(quote.inputTokens) + Number(quote.outputTokens) > budget.maxTokens ||
      typeof quote.costUsd !== "number" || !Number.isFinite(quote.costUsd) ||
      quote.costUsd <= 0 || quote.costUsd > budget.maxCostUsd ||
      !Number.isSafeInteger(quote.wallTimeMs) || Number(quote.wallTimeMs) < 1 ||
      Number(quote.wallTimeMs) > budget.maxWallTimeMs) {
    throw new DurableAiJobError("INVALID_JOB_INPUT", "Live acquisition quote exceeds consent");
  }
  return quote as unknown as ResearchProviderQuote;
}

export function createLiveAcquisitionWorkflow(
  options: LiveAcquisitionWorkflowOptions,
): LiveAcquisitionWorkflow {
  const { connection, research, provider } = options;
  if (research.connection !== connection ||
      (connection.pragma("user_version", { simple: true }) as number) < 25) {
    throw new Error("live acquisition workflow requires one schema-25 research connection");
  }
  const clock = options.clock ?? (() => new Date());
  const digestKey = options.digestKey ?? (() => randomBytes(32));
  const maxAttemptsPerUtcDay = options.maxAttemptsPerUtcDay ?? 20;
  if (!Number.isSafeInteger(maxAttemptsPerUtcDay) || maxAttemptsPerUtcDay < 1 ||
      maxAttemptsPerUtcDay > 100) {
    throw new TypeError("live acquisition daily attempt limit must be between 1 and 100");
  }
  const previewResourceUrl = options.previewResourceUrl ??
    createResourceCatalog(connection).previewResourceUrl;
  const selectReceipt = connection.prepare(`
    SELECT receipt.submission_fingerprint, receipt.job_id, receipt.kind, job.status
    FROM ai_job_idempotency_receipts AS receipt
    JOIN ai_jobs AS job ON job.id = receipt.job_id AND job.kind = receipt.kind
    WHERE receipt.idempotency_key = ?
  `);
  const selectGeneration = connection.prepare(`
    SELECT generation.id AS resource_generation_id,
      generation.generation_token AS resource_generation_digest,
      history.id AS history_epoch_id, runtime.runtime_epoch,
      ruleset_event.id AS ruleset_event_id, ruleset_event.version AS ruleset_version
    FROM privacy_subject_generations AS generation
    JOIN research_history_epochs AS history
      ON history.resource_generation_id = generation.id AND history.is_active = 1
    JOIN live_acquisition_runtime_state AS runtime ON runtime.singleton_id = 1
    JOIN resource_ruleset_heads AS ruleset_head ON ruleset_head.scope = 'global'
    JOIN resource_ruleset_events AS ruleset_event
      ON ruleset_event.id = ruleset_head.ruleset_event_id
    JOIN resource_heads AS resource_head ON resource_head.resource_id = generation.resource_id
    JOIN resource_events AS resource_event
      ON resource_event.id = resource_head.event_id
      AND resource_event.resource_id = generation.resource_id
    WHERE generation.subject_kind = 'resource' AND generation.resource_id = ?
      AND generation.is_active = 1 AND history.resource_id = generation.resource_id
      AND resource_event.lifecycle_state = 'active'
  `);
  const selectRules = connection.prepare(`
    SELECT rule.rule_key, rule.version, rule.host_pattern, rule.path_prefix,
      rule.priority, rule.enabled, rule.resource_id
    FROM resource_match_rule_heads AS head
    JOIN resource_match_rules AS rule ON rule.id = head.rule_id
    ORDER BY rule.rule_key
  `);
  const selectActiveResourceGenerationId = connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'resource' AND resource_id = ? AND is_active = 1
  `);
  const selectAcceptedMembership = connection.prepare(`
    SELECT 1
    FROM resource_resolution_heads AS resolution_head
    JOIN resource_resolution_events AS resolution
      ON resolution.id = resolution_head.resolution_event_id
      AND resolution.logical_page_id = resolution_head.logical_page_id
    JOIN logical_page_resource_heads AS assignment_head
      ON assignment_head.logical_page_id = resolution.logical_page_id
    WHERE resolution.logical_page_id = ? AND resolution.resource_id = ?
      AND resolution.state IN ('matched', 'overridden')
      AND resolution.research_eligible = 1
      AND resolution.assignment_id = assignment_head.assignment_id
  `);
  const selectDailyAttempts = connection.prepare(`
    SELECT COUNT(*)
    FROM ai_job_attempts AS attempt
    JOIN ai_jobs AS job ON job.id = attempt.job_id
    WHERE job.kind = 'resource_research'
      AND job.workflow_id = 'research_acquisition:c90:v1' AND job.workflow_version = 1
      AND attempt.started_at >= ? AND attempt.started_at < ?
  `);
  const selectParent = connection.prepare(`
    SELECT report.id, report.version, report.target_key, head.state,
      payload.report_text
    FROM research_reports AS report
    JOIN research_report_heads AS head ON head.report_id = report.id
    LEFT JOIN research_report_payloads AS payload ON payload.report_id = report.id
    WHERE report.id = ?
  `);
  const insertJob = connection.prepare(`
    INSERT INTO ai_jobs (
      kind, subject_type, resource_id, subject_key,
      requested_by, request_method, idempotency_key,
      submission_fingerprint, input_fingerprint,
      workflow_id, workflow_version, scheduling_priority,
      progress_total, max_steps, max_tokens, max_cost_usd, max_wall_time_ms,
      available_at, created_at, updated_at
    ) VALUES (
      'resource_research', 'resource', @resourceId, @subjectKey,
      'user', 'manual', @idempotencyKey,
      @submissionFingerprint, @inputFingerprint,
      'research_acquisition:c90:v1', 1, 0,
      1, @maxSteps, @maxTokens, @maxCostUsd, @maxWallTimeMs,
      @at, @at, @at
    )
  `);
  const selectRunGeneration = connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `);
  const insertConsent = connection.prepare(`
    INSERT INTO live_acquisition_consents (
      resource_generation_id, history_epoch_id, coordinator_job_id,
      coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
      origin_set_digest, limits_json, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  const insertConsentPayload = connection.prepare(`
    INSERT INTO live_acquisition_consent_payloads (consent_id, approved_origins_json)
    VALUES (?, ?)
  `);
  const insertDigestKey = connection.prepare(`
    INSERT INTO live_acquisition_digest_keys (consent_id, digest_key) VALUES (?, ?)
  `);

  function generationState(resourceId: number): GenerationState {
    const row = selectGeneration.get(resourceId) as {
      resource_generation_id: number;
      resource_generation_digest: string;
      history_epoch_id: number;
      runtime_epoch: number;
      ruleset_event_id: number;
      ruleset_version: number;
    } | undefined;
    if (row === undefined) {
      throw new DurableAiJobError("JOB_SUBJECT_NOT_FOUND", "Live acquisition Resource is unavailable");
    }
    return {
      resourceGenerationId: row.resource_generation_id,
      resourceGenerationDigest: row.resource_generation_digest,
      historyEpochId: row.history_epoch_id,
      runtimeEpoch: row.runtime_epoch,
      rulesetVersion: row.ruleset_version,
      rulesetGenerationDigest: digest(canonicalJson({
        eventId: row.ruleset_event_id,
        version: row.ruleset_version,
        rules: selectRules.all(),
      })),
    };
  }

  function prepareFresh(raw: LiveAcquisitionPreflightRequest): FreshPreflight {
    const input = liveAcquisitionPreflightRequestSchema.parse(raw);
    for (const origin of input.approvedOrigins) {
      const policy = classifyLiveAcquisitionUrl(origin);
      if (policy.kind !== "allowed" || policy.canonicalOrigin !== origin) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Live acquisition origin is not public-safe");
      }
    }
    const generation = generationState(input.research.target.resourceId);
    const currentTimestamp = canonicalTimestamp(clock);
    const utcDate = currentTimestamp.slice(0, 10);
    const dailyStartsResetAt = new Date(
      Date.parse(`${utcDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
    ).toISOString();
    const dayStart = `${utcDate}T00:00:00.000Z`;
    const dailyStartsRemaining = maxAttemptsPerUtcDay - Number(
      selectDailyAttempts.pluck().get(dayStart, dailyStartsResetAt),
    );
    if (dailyStartsRemaining <= 0) {
      throw new LiveAcquisitionBudgetExhaustedError(dailyStartsResetAt);
    }
    const initialBudget = {
      maxSteps: 100,
      maxTokens: 200_000,
      maxCostUsd: input.limits.maxCostUsd,
      maxWallTimeMs: input.limits.durationMs + 120_000,
    };
    const placeholder = researchApproval(input, initialBudget, "0".repeat(64));
    const firstDraft = buildCurrentResearchDraft(connection, placeholder, { clock });
    if (!firstDraft.sources.some((source) => source.inclusionState === "included" &&
        source.sourceKind === "captured")) {
      throw new DurableAiJobError("RESEARCH_CAPTURE_REQUIRED",
        "Live acquisition requires at least one captured seed");
    }
    for (const source of firstDraft.sources) {
      if (source.inclusionState === "included" && source.sourceKind === "captured" &&
          selectAcceptedMembership.get(
            source.logicalPageId,
            input.research.target.resourceId,
          ) === undefined) {
        throw new DurableAiJobError("RESEARCH_PREFLIGHT_STALE",
          "Captured seed lost its accepted Resource membership");
      }
    }
    const previewMatchesTargetGeneration = (url: string): boolean => {
      const preview = previewResourceUrl(url, generation.rulesetVersion);
      return preview.kind === "accepted" &&
        preview.resource.id === input.research.target.resourceId &&
        selectActiveResourceGenerationId.pluck().get(preview.resource.id) ===
          generation.resourceGenerationId;
    };
    for (const origin of input.approvedOrigins) {
      const acceptedByBareOrigin = previewMatchesTargetGeneration(origin);
      const acceptedByCapturedSeed = firstDraft.sources.some((source) => {
        if (source.sourceKind !== "captured" || source.inclusionState !== "included" ||
            source.payload === null) return false;
        const policy = classifyLiveAcquisitionUrl(source.payload.url);
        return policy.kind === "allowed" && policy.canonicalOrigin === origin &&
          previewMatchesTargetGeneration(source.payload.url);
      });
      if (!acceptedByBareOrigin && !acceptedByCapturedSeed) {
        throw new DurableAiJobError("INVALID_JOB_INPUT",
          "Live acquisition origin is outside the approved Resource");
      }
    }
    const includedSources = firstDraft.sources.filter((source) =>
      source.inclusionState === "included" && source.payload !== null
    );
    const includedBytes = includedSources.reduce((total, source) =>
      total + new TextEncoder().encode(source.payload!.evidenceMaterial).byteLength, 0);
    if (includedSources.length >= input.research.maxIncludedSources ||
        includedSources.length >= 100 || firstDraft.sources.length >= 10_000 ||
        includedBytes + 65_536 > 4_194_304) {
      throw new DurableAiJobError(
        "INVALID_JOB_INPUT",
        "Live acquisition requires capacity for one acquired source",
      );
    }
    let parent: ResearchProviderInput["parent"] = null;
    if (input.research.parentReportId !== null) {
      const row = selectParent.get(input.research.parentReportId) as {
        id: number;
        version: number;
        target_key: string;
        state: string;
        report_text: string | null;
      } | undefined;
      if (row === undefined) {
        throw new ResearchBoundaryError(
          "RESEARCH_PARENT_NOT_FOUND",
          "Parent research report does not exist",
        );
      }
      if (row.target_key !== `resource:${input.research.target.resourceId}` ||
          (row.state !== "fresh" && row.state !== "stale") ||
          row.report_text === null) {
        throw new ResearchBoundaryError(
          "RESEARCH_PARENT_UNAVAILABLE",
          "Parent research report is unavailable for this Resource",
        );
      }
      parent = {
        reportId: row.id,
        reportVersion: row.version,
        trust: "untrusted_prior_report",
        reportText: row.report_text,
      };
    }
    const quote = validateQuote(
      provider.quote(providerInput(firstDraft, parent, input.approvedOrigins[0]!)),
      initialBudget,
    );
    const taskBudget = {
      ...initialBudget,
      maxTokens: quote.inputTokens + quote.outputTokens,
    };
    const zeroApproval = researchApproval(input, taskBudget, "0".repeat(64));
    const finalProjection = buildCurrentResearchProjection(connection, zeroApproval, { clock });
    const draft = finalProjection.draft;
    const researchApprovalFingerprint = fingerprintResearchApproval(draft);
    const approval = researchApproval(
      input,
      taskBudget,
      researchApprovalFingerprint,
      draft.estimate,
    );
    const capturedCorpusPreflight = projectResearchPreflight(
      { ...input.research, budget: taskBudget }, finalProjection,
    );
    const capturedCorpus = {
      corpusFingerprint: capturedCorpusPreflight.corpusFingerprint,
      coverage: capturedCorpusPreflight.coverage,
      manifest: capturedCorpusPreflight.manifest,
      snapshots: capturedCorpusPreflight.snapshots,
      estimate: capturedCorpusPreflight.estimate,
    };
    const providerDigest = digest(provider.metadata.provider);
    const modelDigest = digest(provider.metadata.model);
    const pricingDigest = digest(provider.metadata.pricingVersion);
    const limits = {
      max_pages: input.limits.maxPages,
      max_depth: input.limits.maxDepth,
      duration_ms: input.limits.durationMs,
      max_cost_usd: input.limits.maxCostUsd,
      max_origins: input.approvedOrigins.length,
      max_output_tokens: quote.outputTokens,
      provider_digest: providerDigest,
      model_digest: modelDigest,
      pricing_digest: pricingDigest,
      ruleset_generation_digest: generation.rulesetGenerationDigest,
      resource_generation_digest: generation.resourceGenerationDigest,
      max_source_bytes: 65_536,
      max_total_bytes: 4_194_304,
      dns_timeout_ms: 3_000,
      connect_timeout_ms: 5_000,
      headers_timeout_ms: 8_000,
      body_idle_timeout_ms: 3_000,
      request_timeout_ms: 15_000,
      max_header_bytes: 16_384,
    };
    const approvalFingerprint = digest(canonicalJson({
      version: "live_acquisition_approval:v1",
      request: input,
      researchApprovalFingerprint,
      provider: provider.metadata,
      quote,
      generation,
      dailyStartsRemaining,
      dailyStartsResetAt,
      limits,
      capturedCorpus,
    }));
    const startedAt = new Date(currentTimestamp);
    const expiresAt = new Date(startedAt.getTime() + input.limits.durationMs).toISOString();
    return {
      public: liveAcquisitionPreflightSchema.parse({
        version: 1,
        target: input.research.target,
        approvedOrigins: input.approvedOrigins,
        limits: input.limits,
        researchApprovalFingerprint,
        approvalFingerprint,
        expiresAt,
        provider: { ...provider.metadata, maxOutputTokens: quote.outputTokens },
        rulesetVersion: generation.rulesetVersion,
        rulesetGenerationDigest: generation.rulesetGenerationDigest,
        resourceGenerationDigest: generation.resourceGenerationDigest,
        dailyStartsRemaining,
        dailyStartsResetAt,
        effectivePolicy: liveAcquisitionEffectivePolicy(
          input.limits.maxPages, input.approvedOrigins.length,
        ),
        capturedCorpus,
      }),
      approval,
      taskBudget,
      limitsJson: canonicalJson(limits),
      generation,
      dailyStartsRemaining,
    };
  }

  function replay(
    request: LiveAcquisitionStartRequest,
    submissionFingerprint: string,
  ): LiveAcquisitionStartReceipt | undefined {
    const row = selectReceipt.get(request.idempotencyKey) as {
      submission_fingerprint: string;
      job_id: number;
      kind: string;
      status: LiveAcquisitionStartReceipt["status"];
    } | undefined;
    if (row === undefined) return undefined;
    if (row.kind !== "resource_research" || row.submission_fingerprint !== submissionFingerprint) {
      throw new DurableAiJobError("IDEMPOTENCY_KEY_CONFLICT",
        "Live acquisition idempotency key belongs to another start");
    }
    return liveAcquisitionStartReceiptSchema.parse({
      id: `resource_research:${row.job_id}`,
      kind: "resource_research",
      status: row.status,
    });
  }

  const startTransaction = connection.transaction((
    request: LiveAcquisitionStartRequest,
    submissionFingerprint: string,
  ): LiveAcquisitionStartReceipt => {
    const exact = replay(request, submissionFingerprint);
    if (exact !== undefined) return exact;
    const fresh = prepareFresh(request.preflight);
    if (fresh.public.approvalFingerprint !== request.approvalFingerprint ||
        fresh.public.researchApprovalFingerprint !== request.researchApprovalFingerprint) {
      throw new DurableAiJobError("RESEARCH_PREFLIGHT_STALE",
        "Live acquisition preflight is stale");
    }
    const task = aiTaskSpecSchema.parse({
      version: 1,
      kind: "resource_research",
      subject: request.preflight.research.target,
      workflowRef: liveAcquisitionWorkflowRef,
      inputFingerprint: request.researchApprovalFingerprint,
      idempotencyKey: request.idempotencyKey,
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget: fresh.taskBudget,
    }) as ResourceResearchTaskSpec;
    const draft = research.prepareSubmission(task, fresh.approval);
    const at = canonicalTimestamp(clock);
    const jobResult = insertJob.run({
      resourceId: task.subject.type === "resource" ? task.subject.resourceId : null,
      subjectKey: `resource:${request.preflight.research.target.resourceId}`,
      idempotencyKey: request.idempotencyKey,
      submissionFingerprint,
      inputFingerprint: task.inputFingerprint,
      maxSteps: task.budget.maxSteps,
      maxTokens: task.budget.maxTokens,
      maxCostUsd: task.budget.maxCostUsd,
      maxWallTimeMs: task.budget.maxWallTimeMs,
      at,
    });
    const jobId = Number(jobResult.lastInsertRowid);
    options.fault?.("after_job_insert");
    const submission = research.insertSubmission(jobId, task, draft, at);
    options.fault?.("after_research_submission");
    const runGenerationId = selectRunGeneration.pluck().get(submission.runId) as
      number | undefined;
    if (runGenerationId === undefined) {
      throw new Error("research run generation trigger did not materialize ownership");
    }
    const expiresAt = new Date(new Date(at).getTime() + request.preflight.limits.durationMs)
      .toISOString();
    const consentFingerprint = digest(canonicalJson({
      approvalFingerprint: request.approvalFingerprint,
      idempotencyKey: request.idempotencyKey,
    }));
    const consentId = Number(insertConsent.run(
      fresh.generation.resourceGenerationId,
      fresh.generation.historyEpochId,
      jobId,
      runGenerationId,
      fresh.generation.runtimeEpoch,
      consentFingerprint,
      digest(canonicalJson(request.preflight.approvedOrigins)),
      fresh.limitsJson,
      at,
      expiresAt,
    ).lastInsertRowid);
    options.fault?.("after_consent_insert");
    insertConsentPayload.run(consentId, canonicalJson(request.preflight.approvedOrigins));
    const key = digestKey();
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new TypeError("live acquisition digest key is invalid");
    }
    insertDigestKey.run(consentId, Buffer.from(key));
    return liveAcquisitionStartReceiptSchema.parse({
      id: `resource_research:${jobId}`,
      kind: "resource_research",
      status: "queued",
    });
  });

  return Object.freeze({
    preflight(request: LiveAcquisitionPreflightRequest) {
      return prepareFresh(liveAcquisitionPreflightRequestSchema.parse(request)).public;
    },
    start(rawRequest: LiveAcquisitionStartRequest) {
      const request = liveAcquisitionStartRequestSchema.parse(rawRequest);
      const submissionFingerprint = digest(canonicalJson({
        version: "live_acquisition_start:v1",
        preflight: request.preflight,
        approvalFingerprint: request.approvalFingerprint,
        researchApprovalFingerprint: request.researchApprovalFingerprint,
      }));
      // The first storage read is the immutable receipt. Mutable Resource/corpus
      // and provider quote reads occur only inside the fresh transaction branch.
      const exact = replay(request, submissionFingerprint);
      return exact ?? startTransaction.immediate(request, submissionFingerprint);
    },
  });
}
