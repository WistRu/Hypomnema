import { z } from "zod";

import { snapshotTabTitleMaxLength } from "@tabhub/shared/limits";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const canonicalPositiveSafeIntegerInput = z.union([
  positiveSafeInteger,
  z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(positiveSafeInteger),
]);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalFingerprintSet = z.array(fingerprint).max(10_000)
  .superRefine((value, context) => {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index - 1]! >= value[index]!) {
        context.addIssue({
          code: "custom",
          message: "Fingerprint sets must be unique and canonically sorted",
        });
        return;
      }
    }
  });
const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value === value.trim())
  .refine((value) => new TextEncoder().encode(value).byteLength <= maximum);

export const researchTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  });

export const researchTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("page"), logicalPageId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("resource"), resourceId: positiveSafeInteger }),
  z.strictObject({
    type: z.literal("selection"),
    logicalPageIds: z.array(positiveSafeInteger).min(1).max(100),
    fingerprint,
  }).superRefine((value, context) => {
    if (new Set(value.logicalPageIds).size !== value.logicalPageIds.length) {
      context.addIssue({ code: "custom", message: "Selection pages must be unique" });
    }
  }),
]);

export type ResearchTarget = z.infer<typeof researchTargetSchema>;

export function canonicalResearchSelectionIds(ids: readonly number[]): number[] {
  return [...ids].sort((left, right) => left - right);
}

export function researchSelectionFingerprintPayload(ids: readonly number[]): string {
  return JSON.stringify(canonicalResearchSelectionIds(ids));
}

/** Immutable v1 byte contract for SHA-256 content_digest. */
export function researchContentDigestPayloadV1(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Raised when a value cannot be canonicalized without silently changing its meaning. */
export class CanonicalizationError extends TypeError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

/**
 * Canonical UTF-8 bytes that every runtime hashes with SHA-256 (no runtime-specific
 * hash seam). This is the single canonicalization for the whole workspace: object keys
 * are sorted recursively, array order is kept, values carrying a `toJSON` (notably
 * `Date`) are canonicalized through it, and anything JSON would silently drop or
 * distort — `undefined`, `NaN`, `Infinity`, `bigint`, functions, symbols — throws.
 * Callers that need to hash a `bigint` convert it to a decimal string themselves so the
 * conversion is visible at the call site.
 */
export function researchCanonicalSha256PayloadV1(value: unknown): Uint8Array {
  const canonicalize = (input: unknown, path: string): string => {
    if (typeof input === "bigint") {
      throw new CanonicalizationError(
        "Cannot canonicalize bigint (convert it to a decimal string first)", path);
    }
    if (typeof input === "undefined") {
      throw new CanonicalizationError("Cannot canonicalize undefined", path);
    }
    if (typeof input === "function" || typeof input === "symbol") {
      throw new CanonicalizationError(`Cannot canonicalize ${typeof input}`, path);
    }
    if (typeof input === "number" && !Number.isFinite(input)) {
      throw new CanonicalizationError("Cannot canonicalize non-finite number", path);
    }
    if (Array.isArray(input)) {
      return `[${input.map((item, index) =>
        canonicalize(item, `${path}[${index}]`)).join(",")}]`;
    }
    if (input !== null && typeof input === "object") {
      const candidate = input as { toJSON?: unknown };
      if (typeof candidate.toJSON === "function") {
        return canonicalize(
          (candidate.toJSON as (key?: string) => unknown).call(input), path);
      }
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`)
        .join(",")}}`;
    }
    const encoded = JSON.stringify(input);
    if (encoded === undefined) {
      throw new CanonicalizationError("Cannot canonicalize value", path);
    }
    return encoded;
  };
  return new TextEncoder().encode(canonicalize(value, "$"));
}

/**
 * Canonical JSON text for the same byte contract as
 * {@link researchCanonicalSha256PayloadV1}. This is the single canonicalization used
 * across the workspace; no module may keep a private copy.
 */
export function canonicalJsonV1(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

/**
 * Byte mirror of SQLite's `json_object(...)`: key insertion order is preserved and
 * never sorted, because the same bytes are produced inside SQL triggers and both sides
 * must hash identically. This is deliberately NOT a canonicalization — use
 * {@link canonicalJsonV1} for fingerprints that only TypeScript produces. `bigint` is
 * written as a decimal string, matching how SQLite renders an INTEGER in JSON.
 */
export function sqlJsonObjectMirrorV1(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString(10) : item);
}

export const researchCoverageSchema = z.strictObject({
  discovered: nonnegativeSafeInteger.max(10_000),
  captured: nonnegativeSafeInteger.max(10_000),
  eligible: nonnegativeSafeInteger.max(10_000),
  used: nonnegativeSafeInteger.max(100),
  missing: nonnegativeSafeInteger.max(10_000),
  failed: nonnegativeSafeInteger.max(10_000),
}).superRefine((value, context) => {
  if (value.discovered !== value.captured + value.missing + value.failed) {
    context.addIssue({ code: "custom", message: "Coverage arithmetic is inconsistent" });
  }
  if (value.eligible > value.captured || value.used > value.eligible) {
    context.addIssue({ code: "custom", message: "Coverage bounds are inconsistent" });
  }
});

export type ResearchCoverage = z.infer<typeof researchCoverageSchema>;

export const researchBudgetSchema = z.strictObject({
  maxSteps: positiveSafeInteger.max(100),
  maxTokens: nonnegativeSafeInteger.max(200_000),
  maxCostUsd: z.number().finite().nonnegative().max(2),
  maxWallTimeMs: positiveSafeInteger.max(1_800_000),
});

export type ResearchBudget = z.infer<typeof researchBudgetSchema>;

export const researchEstimateInputSchema = z.strictObject({
  includedSources: nonnegativeSafeInteger.max(100),
  includedSourceBytes: nonnegativeSafeInteger.max(4 * 1024 * 1024),
  snapshotBytes: nonnegativeSafeInteger.max(100 * 65_536),
  questionBytes: nonnegativeSafeInteger.max(4000),
  budget: researchBudgetSchema,
});

export type ResearchEstimateInput = z.infer<typeof researchEstimateInputSchema>;

export const researchEstimateSchema = z.strictObject({
  estimateVersion: z.literal("research_estimate:v1"),
  estimateKind: z.literal("reservation_envelope"),
  calls: nonnegativeSafeInteger.max(1),
  inputTokens: nonnegativeSafeInteger,
  outputTokens: nonnegativeSafeInteger.max(8192),
  costUsd: z.number().finite().nonnegative().max(2),
  wallTimeMs: nonnegativeSafeInteger.max(1_800_000),
});

export type ResearchEstimate = z.infer<typeof researchEstimateSchema>;

/** Frozen C81 reservation arithmetic. This is deliberately not a provider quote. */
export function estimateResearchReservationV1(rawInput: ResearchEstimateInput): ResearchEstimate {
  const input = researchEstimateInputSchema.parse(rawInput);
  const calls = input.includedSources === 0 ? 0 : 1;
  if (calls === 0) {
    return {
      estimateVersion: "research_estimate:v1",
      estimateKind: "reservation_envelope",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    };
  }
  const inputBytes = input.includedSourceBytes + input.snapshotBytes + input.questionBytes;
  if (!Number.isSafeInteger(inputBytes)) {
    throw new RangeError("Research estimate byte arithmetic exceeds the safe integer range");
  }
  return researchEstimateSchema.parse({
    estimateVersion: "research_estimate:v1",
    estimateKind: "reservation_envelope",
    calls,
    inputTokens: Math.ceil(inputBytes / 4) + 512,
    outputTokens: Math.min(8192, Math.max(1024, 256 + 64 * input.includedSources)),
    costUsd: input.budget.maxCostUsd,
    wallTimeMs: input.budget.maxWallTimeMs,
  });
}

export function researchEstimateFitsBudgetV1(
  estimate: ResearchEstimate,
  budget: ResearchBudget,
): boolean {
  const parsedEstimate = researchEstimateSchema.parse(estimate);
  const parsedBudget = researchBudgetSchema.parse(budget);
  const requiredTokens = parsedEstimate.inputTokens + parsedEstimate.outputTokens;
  const requiredSteps = parsedEstimate.calls + 2;
  return Number.isSafeInteger(requiredTokens) && Number.isSafeInteger(requiredSteps) &&
    parsedBudget.maxTokens >= requiredTokens && parsedBudget.maxSteps >= requiredSteps;
}

export const researchScopeSchema = z.strictObject({
  acquisitionLevel: z.literal("captured_only"),
  includeShareableContext: z.boolean(),
  maxIncludedSources: positiveSafeInteger.max(100),
  privacyConfirmation: z.strictObject({
    confirmed: z.literal(true),
    authenticatedOriginDigests: canonicalFingerprintSet,
    sensitiveOriginDigests: canonicalFingerprintSet,
  }),
});

export const researchCapturedTextChunkManifestSchema = z.strictObject({
  version: z.literal("captured_text_chunks:v1"),
  byteStart: z.literal(0),
  byteEnd: nonnegativeSafeInteger.max(65_536),
  chunkDigest: fingerprint,
  truncated: z.boolean(),
});

export const researchSourceKindSchema = z.enum(["captured", "live_acquisition"]);
export type ResearchSourceKind = z.infer<typeof researchSourceKindSchema>;

export const researchSourceAcquisitionMethodSchema = z.enum([
  "inventory", "captured", "exact_capture", "safe_public_http_v1",
]);
export type ResearchSourceAcquisitionMethod = z.infer<
  typeof researchSourceAcquisitionMethodSchema
>;

function refineResearchSourceProvenance(
  value: { sourceKind: ResearchSourceKind; acquisitionMethod: ResearchSourceAcquisitionMethod },
  context: z.RefinementCtx,
): void {
  const live = value.sourceKind === "live_acquisition";
  if (live !== (value.acquisitionMethod === "safe_public_http_v1")) {
    context.addIssue({
      code: "custom",
      message: "Research source kind and acquisition method are inconsistent",
    });
  }
}

const researchSourcePayloadSchema = z.strictObject({
  url: boundedText(8192),
  title: z.string().max(snapshotTabTitleMaxLength)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 8192),
  evidenceMaterial: z.string().min(1).max(65_536),
  chunkManifest: researchCapturedTextChunkManifestSchema,
}).superRefine((value, context) => {
  if (new TextEncoder().encode(value.evidenceMaterial).byteLength !==
      value.chunkManifest.byteEnd) {
    context.addIssue({ code: "custom", message: "Captured chunk byte range is inconsistent" });
  }
});

export const researchCapturedSourceDraftSchema = z.strictObject({
  sourceKind: z.literal("captured").default("captured"),
  ordinal: positiveSafeInteger.max(10_000),
  logicalPageId: positiveSafeInteger,
  tabId: positiveSafeInteger,
  selectedTabId: positiveSafeInteger.nullable().default(null),
  contentRevision: positiveSafeInteger,
  contentDigest: fingerprint,
  extractedAt: boundedText(64),
  acquisitionMethod: z.enum(["captured", "exact_capture"]),
  accessClass: z.enum(["public", "authenticated", "sensitive"]),
  eligibility: z.enum(["eligible", "privacy_excluded", "format_excluded", "size_excluded"]),
  inclusionState: z.enum(["included", "excluded"]),
  exclusionReason: z.enum(["source_limit", "privacy", "format", "size"]).nullable().optional(),
  includedOrder: positiveSafeInteger.max(100).nullable(),
  handoffSourceReceiptId: z.null().default(null),
  handoffSourceReceiptDigest: z.null().default(null),
  payload: researchSourcePayloadSchema.nullable(),
}).superRefine((value, context) => {
  const included = value.inclusionState === "included";
  const expectedReason = value.eligibility === "eligible" ? "source_limit"
    : value.eligibility === "privacy_excluded" ? "privacy"
      : value.eligibility === "format_excluded" ? "format" : "size";
  if ((included && (value.eligibility !== "eligible" || value.exclusionReason != null)) ||
      (!included && value.exclusionReason !== expectedReason) ||
      included !== (value.includedOrder !== null) ||
      included !== (value.payload !== null)) {
    context.addIssue({ code: "custom", message: "Included source fields are inconsistent" });
  }
  if (value.payload !== null &&
      new TextEncoder().encode(value.payload.evidenceMaterial).byteLength > 65_536) {
    context.addIssue({ code: "custom", message: "Evidence material exceeds 64 KiB" });
  }
});

export const researchUnavailableSourceDraftSchema = z.strictObject({
  sourceKind: z.literal("captured").default("captured"),
  ordinal: positiveSafeInteger.max(10_000),
  logicalPageId: positiveSafeInteger,
  tabId: positiveSafeInteger.nullable(),
  selectedTabId: positiveSafeInteger.nullable().default(null),
  contentRevision: z.null(),
  contentDigest: z.null(),
  extractedAt: z.null(),
  acquisitionMethod: z.enum(["inventory", "exact_capture"]),
  accessClass: z.enum(["public", "authenticated", "sensitive"]),
  eligibility: z.literal("not_captured"),
  inclusionState: z.enum(["missing", "failed"]),
  failureCode: boundedText(128).nullable(),
  includedOrder: z.null(),
  handoffSourceReceiptId: z.null().default(null),
  handoffSourceReceiptDigest: z.null().default(null),
  payload: z.null(),
}).superRefine((value, context) => {
  if ((value.inclusionState === "failed") !== (value.failureCode !== null)) {
    context.addIssue({ code: "custom", message: "Capture failure code is inconsistent" });
  }
});

export const researchLiveAcquisitionSourceDraftSchema = z.strictObject({
  sourceKind: z.literal("live_acquisition"),
  ordinal: positiveSafeInteger.max(10_000),
  logicalPageId: positiveSafeInteger,
  tabId: z.null(),
  selectedTabId: z.null(),
  contentRevision: z.literal(1),
  contentDigest: fingerprint,
  extractedAt: researchTimestampSchema,
  acquisitionMethod: z.literal("safe_public_http_v1"),
  accessClass: z.literal("public"),
  eligibility: z.literal("eligible"),
  inclusionState: z.literal("included"),
  includedOrder: positiveSafeInteger.max(100),
  handoffSourceReceiptId: positiveSafeInteger,
  handoffSourceReceiptDigest: fingerprint,
  payload: researchSourcePayloadSchema,
});

export const researchSourceDraftSchema = z.union([
  researchCapturedSourceDraftSchema,
  researchUnavailableSourceDraftSchema,
  researchLiveAcquisitionSourceDraftSchema,
]);

export type ResearchSourceDraft = z.infer<typeof researchSourceDraftSchema>;
export type ResearchSourceDraftInput = z.input<typeof researchSourceDraftSchema>;
export type ResearchCorpusSource = ResearchSourceDraft;

const researchSnapshotCommon = {
  ordinal: positiveSafeInteger.max(10_000),
  snapshotDigest: fingerprint,
  material: z.record(z.string(), z.unknown()).superRefine((value, context) => {
    if (researchCanonicalSha256PayloadV1(value).byteLength > 65_536) {
      context.addIssue({ code: "custom", message: "Snapshot material exceeds 64 KiB" });
    }
  }),
};

export const researchSnapshotDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page_context"), ...researchSnapshotCommon,
    contextEntryId: positiveSafeInteger, logicalPageId: positiveSafeInteger }),
  z.strictObject({ kind: z.literal("resource_context"), ...researchSnapshotCommon,
    contextEntryId: positiveSafeInteger, resourceId: positiveSafeInteger }),
  z.strictObject({ kind: z.literal("activity"), ...researchSnapshotCommon,
    logicalPageId: positiveSafeInteger, activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.strictObject({ kind: z.literal("relation"), ...researchSnapshotCommon,
    relationId: positiveSafeInteger }),
]);

export type ResearchSnapshotDraft = z.infer<typeof researchSnapshotDraftSchema>;

export const researchApprovedDraftSchema = z.strictObject({
  version: z.literal(1),
  target: researchTargetSchema,
  question: boundedText(4000),
  scope: researchScopeSchema,
  parentReportId: positiveSafeInteger.nullable(),
  approvalFingerprint: fingerprint,
  corpusFingerprint: fingerprint,
  workflowRef: z.strictObject({ id: boundedText(128), version: positiveSafeInteger }),
  budget: researchBudgetSchema,
  estimate: researchEstimateSchema,
  sources: z.array(researchSourceDraftSchema).max(10_000),
  snapshots: z.array(researchSnapshotDraftSchema).max(100).optional(),
}).superRefine((value, context) => {
  if (value.sources.length === 0 && value.target.type !== "resource") {
    context.addIssue({
      code: "custom",
      message: "Only a Resource preflight may have an empty source manifest",
    });
  }
  const ordinals = value.sources.map((source) => source.ordinal);
  const pages = value.sources.map((source) => source.logicalPageId);
  const included = value.sources.filter((source) => source.inclusionState === "included");
  if (new Set(ordinals).size !== ordinals.length ||
      ordinals.some((ordinal, index) => ordinal !== index + 1) ||
      new Set(pages).size !== pages.length) {
    context.addIssue({ code: "custom", message: "Research source manifest must be unique" });
  }
  if (included.length > value.scope.maxIncludedSources ||
      new Set(included.map((source) => source.includedOrder)).size !== included.length ||
      included.some((source, index) => source.includedOrder !== index + 1)) {
    context.addIssue({ code: "custom", message: "Included source ordering is invalid" });
  }
  const payloadBytes = included.reduce((total, source) => total +
    new TextEncoder().encode(source.payload?.evidenceMaterial ?? "").byteLength, 0);
  if (payloadBytes > 4 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Research corpus exceeds 4 MiB" });
  }
  const snapshots = value.snapshots ?? [];
  const snapshotKeys = snapshots.map((snapshot) => snapshot.kind === "page_context"
    ? `${snapshot.kind}:${snapshot.contextEntryId}`
    : snapshot.kind === "resource_context" ? `${snapshot.kind}:${snapshot.contextEntryId}`
      : snapshot.kind === "activity"
        ? `${snapshot.kind}:${snapshot.logicalPageId}:${snapshot.activityDate}`
        : `${snapshot.kind}:${snapshot.relationId}`);
  if (new Set(snapshotKeys).size !== snapshotKeys.length ||
      new Set(snapshots.map((snapshot) => snapshot.ordinal)).size !== snapshots.length ||
      snapshots.some((snapshot, index) => snapshot.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Research snapshots must be unique" });
  }
});

export type ResearchApprovedDraft = z.infer<typeof researchApprovedDraftSchema>;
export type ResearchApprovedDraftInput = z.input<typeof researchApprovedDraftSchema>;

export const researchCaptureIntentSchema = z.strictObject({
  selectedTabIds: z.array(positiveSafeInteger).max(100),
  knownFailures: z.array(z.strictObject({
    logicalPageId: positiveSafeInteger,
    tabId: positiveSafeInteger,
    failureCode: boundedText(128),
  })).max(100),
}).superRefine((value, context) => {
  if (new Set(value.selectedTabIds).size !== value.selectedTabIds.length) {
    context.addIssue({ code: "custom", message: "Selected tab IDs must be unique" });
  }
  const failurePages = value.knownFailures.map((failure) => failure.logicalPageId);
  const failureTabs = value.knownFailures.map((failure) => failure.tabId);
  if (new Set(failurePages).size !== failurePages.length ||
      new Set(failureTabs).size !== failureTabs.length) {
    context.addIssue({ code: "custom", message: "Known capture failures must be unique" });
  }
  if (new Set([...value.selectedTabIds, ...failureTabs]).size > 100) {
    context.addIssue({ code: "custom", message: "Exact capture intent exceeds 100 tabs" });
  }
});

export type ResearchCaptureIntent = z.infer<typeof researchCaptureIntentSchema>;

const researchOriginDigestSetSchema = canonicalFingerprintSet.refine(
  (value) => value.length <= 100,
  { message: "Origin digest sets cannot exceed 100 entries" },
);

// Run approval must admit noncanonical order/duplicates so the workflow can
// return the frozen typed stale-preflight conflict instead of a generic 400.
const researchRunOriginDigestListSchema = z.array(fingerprint).max(100);

export const researchConfirmedOriginsSchema = z.strictObject({
  authenticatedOriginDigests: researchOriginDigestSetSchema,
  sensitiveOriginDigests: researchOriginDigestSetSchema,
});

export const researchOriginConfirmationRequirementsSchema =
  researchConfirmedOriginsSchema;

export type ResearchConfirmedOrigins = z.infer<typeof researchConfirmedOriginsSchema>;
export type ResearchOriginConfirmationRequirements = z.infer<
  typeof researchOriginConfirmationRequirementsSchema
>;

const emptyConfirmedOrigins = (): ResearchConfirmedOrigins => ({
  authenticatedOriginDigests: [],
  sensitiveOriginDigests: [],
});

/** Public, write-free preflight input. Workflow and durable-job fields are server-owned. */
export const researchPreflightRequestSchema = z.strictObject({
  version: z.literal(1),
  target: researchTargetSchema,
  question: boundedText(4000),
  includeShareableContext: z.boolean(),
  maxIncludedSources: positiveSafeInteger.max(100),
  parentReportId: positiveSafeInteger.nullable(),
  budget: researchBudgetSchema,
  captureIntent: researchCaptureIntentSchema,
  confirmedOrigins: researchConfirmedOriginsSchema.optional().default(emptyConfirmedOrigins),
});

export type ResearchPreflightRequest = z.infer<typeof researchPreflightRequestSchema>;

/**
 * Trusted-loopback agent start-or-replay command. Mutable/derived workflow
 * fields are deliberately absent so a durable receipt can be checked before
 * the current corpus is inspected.
 */
export const agentResearchStartRequestSchema = z.strictObject({
  version: z.literal(1),
  target: researchTargetSchema,
  question: boundedText(4000),
  includeShareableContext: z.boolean(),
  maxIncludedSources: positiveSafeInteger.max(100),
  budget: researchBudgetSchema,
  confirmedOrigins: researchConfirmedOriginsSchema.optional().default(emptyConfirmedOrigins),
  idempotencyKey: boundedText(200),
  authorizationRef: boundedText(256),
});

export type AgentResearchStartRequest = z.infer<
  typeof agentResearchStartRequestSchema
>;

/** Public approval input; the workflow derives all durable task/provenance fields. */
export const researchRunApprovalRequestSchema = z.strictObject({
  version: z.literal(1),
  target: researchTargetSchema,
  question: boundedText(4000),
  includeShareableContext: z.boolean(),
  maxIncludedSources: positiveSafeInteger.max(100),
  parentReportId: positiveSafeInteger.nullable(),
  budget: researchBudgetSchema,
  estimate: researchEstimateSchema,
  captureIntent: researchCaptureIntentSchema,
  confirmedOrigins: z.strictObject({
    authenticatedOriginDigests: researchRunOriginDigestListSchema,
    sensitiveOriginDigests: researchRunOriginDigestListSchema,
  }),
  approvalFingerprint: fingerprint,
  idempotencyKey: boundedText(200),
});

export type ResearchRunApprovalRequest = z.infer<typeof researchRunApprovalRequestSchema>;

/** Agent callers use the same explicit approval envelope plus a bounded user authorization. */
export const agentResearchRunApprovalRequestSchema = researchRunApprovalRequestSchema.extend({
  authorizationRef: boundedText(256),
}).strict();

export type AgentResearchRunApprovalRequest = z.infer<
  typeof agentResearchRunApprovalRequestSchema
>;

export const agentResearchCancelRequestSchema = z.strictObject({
  authorizationRef: boundedText(256),
  idempotencyKey: boundedText(200),
});

export type AgentResearchCancelRequest = z.infer<typeof agentResearchCancelRequestSchema>;

function agentResearchStartFingerprintPayloadV1(
  request: Pick<AgentResearchStartRequest,
    | "version" | "target" | "question" | "includeShareableContext"
    | "maxIncludedSources" | "budget" | "confirmedOrigins">,
) {
  return {
    version: "agent_research_start:v1",
    target: request.target,
    question: request.question,
    includeShareableContext: request.includeShareableContext,
    maxIncludedSources: request.maxIncludedSources,
    parentReportId: null,
    budget: request.budget,
    captureIntent: { selectedTabIds: [], knownFailures: [] },
    confirmedOrigins: request.confirmedOrigins,
  };
}

/** Stable declarative bytes for durable start-or-replay receipt lookup. */
export function agentResearchStartRequestFingerprintPayloadV1(
  request: AgentResearchStartRequest,
): Uint8Array {
  const parsed = agentResearchStartRequestSchema.parse(request);
  return researchCanonicalSha256PayloadV1(agentResearchStartFingerprintPayloadV1(parsed));
}

/** Stable agent command bytes deliberately exclude derived preflight values and secrets. */
export function agentResearchStartCommandFingerprintPayloadV1(
  request: AgentResearchRunApprovalRequest,
): Uint8Array {
  const parsed = agentResearchRunApprovalRequestSchema.parse(request);
  return researchCanonicalSha256PayloadV1({
    ...agentResearchStartFingerprintPayloadV1(parsed),
    parentReportId: parsed.parentReportId,
    captureIntent: parsed.captureIntent,
  });
}

export function agentResearchCancelCommandFingerprintPayloadV1(jobId: string): Uint8Array {
  if (!/^resource_research:[1-9][0-9]*$/.test(jobId)) {
    throw new TypeError("Invalid resource research job ID");
  }
  return researchCanonicalSha256PayloadV1({
    version: "agent_research_cancel:v1",
    jobId,
  });
}

/** Refine binds the immutable parent from the route path, never from caller input. */
export const researchRefineApprovalRequestSchema = researchRunApprovalRequestSchema.omit({
  parentReportId: true,
});

export type ResearchRefineApprovalRequest = z.infer<
  typeof researchRefineApprovalRequestSchema
>;

/** Caller-safe approval: declarative identities only; captured text is rebuilt by the store. */
export const researchApprovalRequestSchema = z.strictObject({
  version: z.literal(1), target: researchTargetSchema, question: boundedText(4000),
  scope: researchScopeSchema, parentReportId: positiveSafeInteger.nullable(),
  approvalFingerprint: fingerprint,
  workflowRef: z.strictObject({ id: boundedText(128), version: positiveSafeInteger }),
  budget: researchBudgetSchema,
  estimate: researchEstimateSchema,
  captureIntent: researchCaptureIntentSchema,
});
export type ResearchApprovalRequest = z.infer<typeof researchApprovalRequestSchema>;

export const researchAccessClassSchema = z.enum(["public", "authenticated", "sensitive"]);
export type ResearchAccessClass = z.infer<typeof researchAccessClassSchema>;

export const researchExclusionReasonSchema = z.enum([
  "invalid_url",
  "browser_internal",
  "extension",
  "file",
  "data",
  "unsupported_scheme",
  "embedded_credentials",
  "localhost",
  "private_ip",
  "private_hostname",
  "registrable_domain_unavailable",
  "weak_sensitive_signal",
  "empty_captured_text",
  "source_limit",
  "corpus_byte_limit",
]);
export type ResearchExclusionReason = z.infer<typeof researchExclusionReasonSchema>;

export const researchExclusionCategorySchema = z.enum(["format", "privacy", "size", "limit"]);
export type ResearchExclusionCategory = z.infer<typeof researchExclusionCategorySchema>;

const researchExclusionCategories: Readonly<Record<
ResearchExclusionReason, ResearchExclusionCategory
>> = {
  invalid_url: "format",
  browser_internal: "format",
  extension: "format",
  file: "format",
  data: "format",
  unsupported_scheme: "format",
  embedded_credentials: "privacy",
  localhost: "privacy",
  private_ip: "privacy",
  private_hostname: "privacy",
  registrable_domain_unavailable: "privacy",
  weak_sensitive_signal: "privacy",
  empty_captured_text: "size",
  source_limit: "limit",
  corpus_byte_limit: "limit",
};

export function researchExclusionCategoryForReason(
  reason: ResearchExclusionReason,
): ResearchExclusionCategory {
  return researchExclusionCategories[researchExclusionReasonSchema.parse(reason)];
}

const researchSafePageManifestCommon = {
  ordinal: positiveSafeInteger.max(10_000),
  logicalPageId: positiveSafeInteger,
  selectedTabId: positiveSafeInteger.nullable(),
  contentRevision: positiveSafeInteger.nullable(),
  contentDigest: fingerprint.nullable(),
  state: z.enum(["captured", "missing", "failed", "excluded"]),
  exclusionReason: researchExclusionReasonSchema.nullable(),
  exclusionCategory: researchExclusionCategorySchema.nullable(),
  accessClass: researchAccessClassSchema,
  originDigest: fingerprint.nullable(),
  requiresConfirmation: z.boolean(),
  failureCode: boundedText(128).nullable(),
  capturedChunkManifest: researchCapturedTextChunkManifestSchema.nullable(),
};

const researchSafeCapturedPageManifestEntrySchema = z.strictObject({
  sourceKind: z.literal("captured"),
  acquisitionMethod: z.enum(["inventory", "captured", "exact_capture"]),
  ...researchSafePageManifestCommon,
}).superRefine((value, context) => {
  const isCaptured = value.state === "captured" || value.state === "excluded";
  const hasCapturedIdentity = value.selectedTabId !== null && value.contentRevision !== null &&
    value.contentDigest !== null;
  const isFailed = value.state === "failed";
  if (isCaptured !== hasCapturedIdentity || isFailed !== (value.failureCode !== null) ||
      (!isCaptured && value.capturedChunkManifest !== null)) {
    context.addIssue({ code: "custom", message: "Safe page manifest field matrix is invalid" });
  }
  if ((value.state === "excluded") !== (value.exclusionReason !== null) ||
      (value.exclusionReason === null) !== (value.exclusionCategory === null)) {
    context.addIssue({ code: "custom", message: "Safe page exclusion is inconsistent" });
  } else if (value.exclusionReason !== null &&
      value.exclusionCategory !== researchExclusionCategoryForReason(value.exclusionReason)) {
    context.addIssue({ code: "custom", message: "Safe page exclusion category is incorrect" });
  }
  const confirmationExpected = value.state === "captured" && value.accessClass !== "public";
  if (value.requiresConfirmation !== confirmationExpected ||
      (value.requiresConfirmation && value.originDigest === null)) {
    context.addIssue({ code: "custom", message: "Safe page confirmation fields are inconsistent" });
  }
});

const researchSafeLivePageManifestEntrySchema = z.strictObject({
  sourceKind: z.literal("live_acquisition"),
  acquisitionMethod: z.literal("safe_public_http_v1"),
  ...researchSafePageManifestCommon,
  selectedTabId: z.null(),
  contentRevision: z.literal(1),
  state: z.literal("captured"),
  exclusionReason: z.null(),
  exclusionCategory: z.null(),
  accessClass: z.literal("public"),
  originDigest: z.null(),
  requiresConfirmation: z.literal(false),
  failureCode: z.null(),
  capturedChunkManifest: researchCapturedTextChunkManifestSchema,
});

const researchSafePageManifestDiscriminatedSchema = z.discriminatedUnion("sourceKind", [
  researchSafeCapturedPageManifestEntrySchema,
  researchSafeLivePageManifestEntrySchema,
]);

/**
 * Schema-24 callers may omit the new discriminator while feature-off historical
 * reads are rolling forward. Parsing always returns the explicit schema-25
 * captured/live union.
 */
export const researchSafePageManifestEntrySchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      "sourceKind" in value) {
    return value;
  }
  const legacy = value as Record<string, unknown>;
  const state = legacy.state;
  return {
    ...legacy,
    sourceKind: "captured",
    acquisitionMethod: legacy.acquisitionMethod ?? (state === "missing" ? "inventory" :
      state === "failed" && legacy.selectedTabId === null ? "inventory" : "captured"),
  };
}, researchSafePageManifestDiscriminatedSchema);

export type ResearchSafePageManifestEntry = z.infer<
  typeof researchSafePageManifestEntrySchema
>;

const researchSafeSnapshotManifestCommon = {
  ordinal: positiveSafeInteger.max(100),
  snapshotDigest: fingerprint,
  materialBytes: nonnegativeSafeInteger.max(65_536),
  truncated: z.boolean(),
};

export const researchSafeSnapshotManifestEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("page_context"),
    ...researchSafeSnapshotManifestCommon,
    contextEntryId: positiveSafeInteger,
    logicalPageId: positiveSafeInteger,
  }),
  z.strictObject({
    kind: z.literal("resource_context"),
    ...researchSafeSnapshotManifestCommon,
    contextEntryId: positiveSafeInteger,
    resourceId: positiveSafeInteger,
  }),
  z.strictObject({
    kind: z.literal("activity"),
    ...researchSafeSnapshotManifestCommon,
    logicalPageId: positiveSafeInteger,
    activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    ...researchSafeSnapshotManifestCommon,
    relationId: positiveSafeInteger,
  }),
]);

export type ResearchSafeSnapshotManifestEntry = z.infer<
  typeof researchSafeSnapshotManifestEntrySchema
>;

const researchLimitationSchema = z.array(researchExclusionReasonSchema).max(15)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: "custom", message: "Research limitations must be deduplicated" });
    }
  });

const researchPreflightShape = {
  version: z.literal(1),
  target: researchTargetSchema,
  approvalFingerprint: fingerprint.nullable(),
  corpusFingerprint: fingerprint,
  coverage: researchCoverageSchema,
  approvedBudget: researchBudgetSchema,
  acquisitionLevel: z.literal("captured_only"),
  manifest: z.array(researchSafePageManifestEntrySchema).max(10_000),
  snapshots: z.array(researchSafeSnapshotManifestEntrySchema).max(100),
  confirmationRequirements: researchOriginConfirmationRequirementsSchema,
  estimate: researchEstimateSchema,
  requiresConfirmation: z.boolean(),
  limitations: researchLimitationSchema,
};
const researchAgentPreflightBaseSchema = z.strictObject(researchPreflightShape);
type ResearchAgentPreflightBase = z.infer<typeof researchAgentPreflightBaseSchema>;

function validateResearchPreflight(
  value: ResearchAgentPreflightBase,
  context: z.RefinementCtx,
): void {
  const pageIds = value.manifest.map((entry) => entry.logicalPageId);
  if (new Set(pageIds).size !== pageIds.length ||
      value.manifest.some((entry, index) => entry.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Preflight manifest pages must be unique" });
  }
  let captured = 0;
  let eligible = 0;
  let missing = 0;
  let failed = 0;
  for (const entry of value.manifest) {
    if (entry.state === "captured" || entry.state === "excluded") captured += 1;
    if (entry.state === "captured" || entry.exclusionReason === "source_limit" ||
        entry.exclusionReason === "corpus_byte_limit") eligible += 1;
    if (entry.state === "missing") missing += 1;
    if (entry.state === "failed") failed += 1;
  }
  const expected = {
    discovered: value.manifest.length,
    captured,
    eligible,
    missing,
    failed,
  };
  if (value.coverage.discovered !== expected.discovered ||
      value.coverage.captured !== expected.captured ||
      value.coverage.eligible !== expected.eligible ||
      value.coverage.missing !== expected.missing ||
      value.coverage.failed !== expected.failed) {
    context.addIssue({ code: "custom", message: "Preflight coverage does not match manifest" });
  }
  if (value.coverage.used !== 0) {
    context.addIssue({ code: "custom", message: "Preflight coverage used must be zero" });
  }
  const snapshotOrdinals = value.snapshots.map((entry) => entry.ordinal);
  if (new Set(snapshotOrdinals).size !== snapshotOrdinals.length ||
      value.snapshots.some((entry, index) => entry.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Preflight snapshots must be uniquely ordered" });
  }
  const hasConfirmations = value.confirmationRequirements.authenticatedOriginDigests.length > 0 ||
    value.confirmationRequirements.sensitiveOriginDigests.length > 0;
  if (value.requiresConfirmation !== hasConfirmations) {
    context.addIssue({ code: "custom", message: "Preflight confirmation requirement is inconsistent" });
  }
  const limitationSet = new Set(value.limitations);
  if (value.manifest.some((entry) => entry.exclusionReason !== null &&
      !limitationSet.has(entry.exclusionReason))) {
    context.addIssue({ code: "custom", message: "Preflight limitations omit an exclusion" });
  }
}

export const researchConfirmationDisplayEntrySchema = z.strictObject({
  accessClass: z.enum(["authenticated", "sensitive"]),
  originDigest: fingerprint,
  origin: z.string().min(1).max(2048).superRefine((value, context) => {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.username !== "" || parsed.password !== "" || parsed.origin !== value ||
          parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
        context.addIssue({ code: "custom", message: "Confirmation display must be an HTTP(S) origin" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Confirmation display origin is invalid" });
    }
  }),
});

export type ResearchConfirmationDisplayEntry = z.infer<
  typeof researchConfirmationDisplayEntrySchema
>;

export const agentResearchPreflightSchema = researchAgentPreflightBaseSchema
  .superRefine(validateResearchPreflight);

export type AgentResearchPreflight = z.infer<typeof agentResearchPreflightSchema>;

export const researchPreflightSchema = z.strictObject({
  ...researchPreflightShape,
  confirmationDisplay: z.array(researchConfirmationDisplayEntrySchema).max(200),
}).superRefine((value, context) => {
  validateResearchPreflight(value, context);
  const expected = [
    ...value.confirmationRequirements.authenticatedOriginDigests.map((originDigest) => ({
      accessClass: "authenticated" as const,
      originDigest,
    })),
    ...value.confirmationRequirements.sensitiveOriginDigests.map((originDigest) => ({
      accessClass: "sensitive" as const,
      originDigest,
    })),
  ];
  const display = value.confirmationDisplay;
  if (display.length !== expected.length ||
      display.some((entry, index) =>
        entry.accessClass !== expected[index]?.accessClass ||
        entry.originDigest !== expected[index]?.originDigest)) {
    context.addIssue({
      code: "custom",
      message: "Confirmation display must exactly match the required origin digest sets",
    });
  }
});

export type ResearchPreflight = z.infer<typeof researchPreflightSchema>;

export function projectAgentResearchPreflight(value: ResearchPreflight): AgentResearchPreflight {
  const { confirmationDisplay: _localOnly, ...agent } = researchPreflightSchema.parse(value);
  return agentResearchPreflightSchema.parse(agent);
}

/**
 * Canonical C81 approval bytes. The caller approves the complete public-safe
 * preflight projection, while the corpus fingerprint binds the redactable
 * URL/title/text material that the projection intentionally does not expose.
 */
export function researchWorkflowApprovalFingerprintPayloadV1(
  request: ResearchPreflightRequest,
  preflight: Omit<ResearchPreflight, "approvalFingerprint">,
): Uint8Array {
  const { confirmationDisplay: _localOnly, ...approvalProjection } = preflight;
  return researchCanonicalSha256PayloadV1({
    version: "research_workflow_approval:v1",
    workflowRef: { id: "research_workflow:c81:v1", version: 1 },
    request,
    preflight: approvalProjection,
  });
}

/** Canonical low-level C80 approval bytes retained for pre-C81 ledger callers. */
export function researchApprovalFingerprintPayloadV1(
  value: Omit<ResearchApprovedDraftInput, "approvalFingerprint" | "corpusFingerprint"> & {
    readonly approvalFingerprint?: string;
    readonly corpusFingerprint?: string;
  },
): Uint8Array {
  return researchCanonicalSha256PayloadV1({
    version: 1,
    target: value.target,
    question: value.question,
    scope: value.scope,
    parentReportId: value.parentReportId,
    workflowRef: value.workflowRef,
    budget: value.budget,
    estimate: value.estimate,
    sources: value.sources.map((source) => {
      const {
        sourceKind,
        selectedTabId,
        handoffSourceReceiptId,
        handoffSourceReceiptDigest,
        ...legacySource
      } = source;
      const identity = sourceKind === "live_acquisition"
        ? {
            ...legacySource,
            sourceKind,
            selectedTabId,
            handoffSourceReceiptId,
            handoffSourceReceiptDigest,
          }
        : legacySource;
      if (source.inclusionState === "missing" || source.inclusionState === "failed") {
        return identity;
      }
      const { payload: _payload, ...sourceWithoutPayload } = identity;
      return sourceWithoutPayload;
    }),
    snapshots: (value.snapshots ?? []).map((snapshot) => {
      const { material: _material, ...identity } = snapshot;
      return identity;
    }),
  });
}

export const researchUtf8RangeLocatorSchema = z.strictObject({
  version: z.literal("utf8_range:v1"),
  byteStart: nonnegativeSafeInteger.max(65_535),
  byteEnd: positiveSafeInteger.max(65_536),
}).superRefine((value, context) => {
  if (value.byteEnd <= value.byteStart) {
    context.addIssue({ code: "custom", message: "UTF-8 evidence range must be non-empty" });
  }
});

export type ResearchUtf8RangeLocator = z.infer<typeof researchUtf8RangeLocatorSchema>;

export const researchWholeSnapshotLocatorSchema = z.strictObject({
  version: z.literal("whole_snapshot:v1"),
});

export type ResearchWholeSnapshotLocator = z.infer<typeof researchWholeSnapshotLocatorSchema>;

export const researchEvidenceDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tab_content"),
    sourceId: positiveSafeInteger,
    locator: researchUtf8RangeLocatorSchema,
    excerptHash: fingerprint,
  }),
  z.strictObject({
    kind: z.literal("page_context"),
    snapshotId: positiveSafeInteger,
    locator: researchWholeSnapshotLocatorSchema,
    excerptHash: fingerprint,
  }),
  z.strictObject({
    kind: z.literal("resource_context"),
    snapshotId: positiveSafeInteger,
    locator: researchWholeSnapshotLocatorSchema,
    excerptHash: fingerprint,
  }),
  z.strictObject({
    kind: z.literal("activity"),
    snapshotId: positiveSafeInteger,
    locator: researchWholeSnapshotLocatorSchema,
    excerptHash: fingerprint,
  }),
  z.strictObject({
    kind: z.literal("relation"),
    snapshotId: positiveSafeInteger,
    locator: researchWholeSnapshotLocatorSchema,
    excerptHash: fingerprint,
  }),
]);

export type ResearchEvidenceDraft = z.infer<typeof researchEvidenceDraftSchema>;

export const researchClaimDraftSchema = z.strictObject({
  claim: boundedText(16_384),
  confidence: z.number().finite().min(0).max(1),
  isInference: z.boolean(),
  rationale: boundedText(4096).nullable(),
  evidence: z.array(researchEvidenceDraftSchema).max(100),
}).superRefine((value, context) => {
  if (!value.isInference && value.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Non-inference claim requires evidence" });
  }
  if (value.isInference !== (value.rationale !== null)) {
    context.addIssue({ code: "custom", message: "Inference rationale is inconsistent" });
  }
});

export type ResearchClaimDraft = z.infer<typeof researchClaimDraftSchema>;

export const researchClaimListSchema = z.array(researchClaimDraftSchema).max(10_000)
  .superRefine((claims, context) => {
    const materialBytes = claims.reduce((total, claim) => total +
      new TextEncoder().encode(claim.claim).byteLength +
      new TextEncoder().encode(claim.rationale ?? "").byteLength, 0);
    if (materialBytes > 512 * 1024) {
      context.addIssue({ code: "custom", message: "Research claim material exceeds 512 KiB" });
    }
  });

export const researchDossierSchema = z.strictObject({
  executiveSummary: boundedText(65_536),
  valueForUser: boundedText(65_536),
  capabilities: z.array(boundedText(4096)).max(100),
  limitations: z.array(boundedText(4096)).max(100),
  risks: z.array(boundedText(4096)).max(100),
  unknowns: z.array(boundedText(4096)).max(100),
  nextSteps: z.array(boundedText(4096)).max(100),
}).superRefine((dossier, context) => {
  const values = [
    dossier.executiveSummary,
    dossier.valueForUser,
    ...dossier.capabilities,
    ...dossier.limitations,
    ...dossier.risks,
    ...dossier.unknowns,
    ...dossier.nextSteps,
  ];
  const materialBytes = values.reduce((total, value) =>
    total + new TextEncoder().encode(value).byteLength, 0);
  if (materialBytes > 256 * 1024) {
    context.addIssue({ code: "custom", message: "Research dossier exceeds 256 KiB" });
  }
});

export type ResearchDossier = z.infer<typeof researchDossierSchema>;

export const researchCumulativeUsageSchema = z.strictObject({
  steps: nonnegativeSafeInteger.max(100),
  inputTokens: nonnegativeSafeInteger.max(200_000),
  outputTokens: nonnegativeSafeInteger.max(200_000),
  costUsd: z.number().finite().nonnegative().max(2),
  wallTimeMs: nonnegativeSafeInteger.max(1_800_000),
});

export type ResearchCumulativeUsage = z.infer<typeof researchCumulativeUsageSchema>;

export const researchPublicationProvenanceSchema = z.strictObject({
  provider: boundedText(128),
  model: boundedText(200),
  promptVersion: boundedText(128),
  pricingVersion: boundedText(128),
  requestId: boundedText(256).nullable(),
  generatedAt: researchTimestampSchema,
  usage: researchCumulativeUsageSchema,
});

export type ResearchPublicationProvenance = z.infer<
  typeof researchPublicationProvenanceSchema
>;

export const researchPublicationReasonSchema = z.enum([
  "budget_exhausted",
  "corpus_became_stale",
]);

export type ResearchPublicationReason = z.infer<typeof researchPublicationReasonSchema>;

export const researchPublicationDraftSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["succeeded", "partial"]),
  reason: researchPublicationReasonSchema.nullable(),
  corpusFingerprint: fingerprint,
  inputFingerprint: fingerprint,
  coverage: researchCoverageSchema,
  usedSourceIds: z.array(positiveSafeInteger).max(100),
  provenance: researchPublicationProvenanceSchema,
  dossier: researchDossierSchema,
  claims: researchClaimListSchema,
}).superRefine((value, context) => {
  if ((value.status === "succeeded") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "Publication reason is inconsistent" });
  }
  if (value.usedSourceIds.some((sourceId, index) =>
      index > 0 && value.usedSourceIds[index - 1]! >= sourceId)) {
    context.addIssue({ code: "custom", message: "Used sources must be unique and sorted" });
  }
  if (value.coverage.used !== value.usedSourceIds.length) {
    context.addIssue({ code: "custom", message: "Used source count must match coverage" });
  }
  const usedSourceIds = new Set(value.usedSourceIds);
  if (value.claims.some((claim) => claim.evidence.some((evidence) =>
      evidence.kind === "tab_content" && !usedSourceIds.has(evidence.sourceId)))) {
    context.addIssue({
      code: "custom",
      message: "Tab-content evidence must reference a used source",
    });
  }
});

export type ResearchPublicationDraft = z.infer<typeof researchPublicationDraftSchema>;

export const researchReportStateSchema = z.enum([
  "fresh", "stale", "redacted", "superseded",
]);

export const researchReportSchema = z.strictObject({
  id: positiveSafeInteger,
  runId: positiveSafeInteger,
  target: researchTargetSchema,
  version: positiveSafeInteger,
  parentReportId: positiveSafeInteger.nullable(),
  publishStatus: z.enum(["succeeded", "partial"]),
  state: researchReportStateSchema,
  reason: researchPublicationReasonSchema.nullable(),
  coverage: researchCoverageSchema,
  createdAt: researchTimestampSchema,
}).superRefine((value, context) => {
  if ((value.publishStatus === "succeeded") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "Report reason is inconsistent" });
  }
});

export type ResearchReport = z.infer<typeof researchReportSchema>;

const researchReportQueryPagination = {
  limit: canonicalPositiveSafeIntegerInput.pipe(z.number().max(100)).default(50),
  beforeVersion: canonicalPositiveSafeIntegerInput.optional(),
};

export const researchReportListQuerySchema = z.discriminatedUnion("targetType", [
  z.strictObject({
    targetType: z.literal("page"),
    targetId: canonicalPositiveSafeIntegerInput,
    ...researchReportQueryPagination,
  }),
  z.strictObject({
    targetType: z.literal("resource"),
    targetId: canonicalPositiveSafeIntegerInput,
    ...researchReportQueryPagination,
  }),
  z.strictObject({
    targetType: z.literal("selection"),
    targetId: fingerprint,
    ...researchReportQueryPagination,
  }),
]);

export type ResearchReportListQuery = z.infer<typeof researchReportListQuerySchema>;

export const researchReportIdParamsSchema = z.strictObject({
  id: canonicalPositiveSafeIntegerInput,
});

export type ResearchReportIdParams = z.infer<typeof researchReportIdParamsSchema>;

export const researchReportHeadSchema = z.strictObject({
  latestPublishedReportId: positiveSafeInteger.nullable(),
  currentFreshReportId: positiveSafeInteger.nullable(),
  lastSuccessfulReportId: positiveSafeInteger.nullable(),
});

export type ResearchReportHead = z.infer<typeof researchReportHeadSchema>;

export const researchReportHeadFlagsSchema = z.strictObject({
  isLatestPublished: z.boolean(),
  isCurrentFresh: z.boolean(),
  isLastSuccessful: z.boolean(),
});

export type ResearchReportHeadFlags = z.infer<typeof researchReportHeadFlagsSchema>;

export const researchRunStatusSchema = z.enum([
  "queued", "running", "succeeded", "partial", "failed", "cancelled", "superseded",
]);

export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>;

export const researchJobIdSchema = z.string().regex(/^resource_research:[1-9][0-9]*$/)
  .superRefine((value, context) => {
    const suffix = Number(value.slice("resource_research:".length));
    if (!Number.isSafeInteger(suffix)) {
      context.addIssue({ code: "custom", message: "Research job ID is not safe" });
    }
  });

export const researchLatestRunSchema = z.strictObject({
  runId: positiveSafeInteger,
  jobId: researchJobIdSchema,
  status: researchRunStatusSchema,
  parentReportId: positiveSafeInteger.nullable(),
  reportId: positiveSafeInteger.nullable(),
  createdAt: researchTimestampSchema,
}).superRefine((value, context) => {
  const published = value.status === "succeeded" || value.status === "partial";
  if (published !== (value.reportId !== null)) {
    context.addIssue({ code: "custom", message: "Latest run report identity is inconsistent" });
  }
});

export type ResearchLatestRun = z.infer<typeof researchLatestRunSchema>;

export const researchReportSummarySchema = z.strictObject({
  id: positiveSafeInteger,
  runId: positiveSafeInteger,
  jobId: researchJobIdSchema,
  version: positiveSafeInteger,
  parentReportId: positiveSafeInteger.nullable(),
  publishStatus: z.enum(["succeeded", "partial"]),
  state: researchReportStateSchema,
  reason: researchPublicationReasonSchema.nullable(),
  coverage: researchCoverageSchema,
  createdAt: researchTimestampSchema,
  executiveSummary: boundedText(65_536).nullable(),
  headFlags: researchReportHeadFlagsSchema,
}).superRefine((value, context) => {
  if ((value.publishStatus === "succeeded") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "Report reason is inconsistent" });
  }
  if ((value.state === "redacted") !== (value.executiveSummary === null)) {
    context.addIssue({ code: "custom", message: "Redacted report summary material is inconsistent" });
  }
  if (value.publishStatus === "partial" && value.state === "fresh") {
    context.addIssue({ code: "custom", message: "Partial report cannot be fresh" });
  }
  if (value.headFlags.isCurrentFresh &&
      (value.state !== "fresh" || value.publishStatus !== "succeeded")) {
    context.addIssue({ code: "custom", message: "Current report flag requires fresh success" });
  }
  if (value.headFlags.isLastSuccessful && value.publishStatus !== "succeeded") {
    context.addIssue({ code: "custom", message: "Last-successful flag requires success" });
  }
});

export type ResearchReportSummary = z.infer<typeof researchReportSummarySchema>;

export const researchReportListResponseSchema = z.strictObject({
  target: researchTargetSchema,
  head: researchReportHeadSchema,
  latestRun: researchLatestRunSchema.nullable(),
  items: z.array(researchReportSummarySchema).max(100),
  nextBeforeVersion: positiveSafeInteger.nullable(),
}).superRefine((value, context) => {
  for (let index = 1; index < value.items.length; index += 1) {
    if (value.items[index - 1]!.version <= value.items[index]!.version) {
      context.addIssue({ code: "custom", message: "Report summaries must be descending" });
      break;
    }
  }
  for (const item of value.items) {
    const expected = {
      isLatestPublished: value.head.latestPublishedReportId === item.id,
      isCurrentFresh: value.head.currentFreshReportId === item.id,
      isLastSuccessful: value.head.lastSuccessfulReportId === item.id,
    };
    if (item.headFlags.isLatestPublished !== expected.isLatestPublished ||
        item.headFlags.isCurrentFresh !== expected.isCurrentFresh ||
        item.headFlags.isLastSuccessful !== expected.isLastSuccessful) {
      context.addIssue({ code: "custom", message: "Report summary head flags are inconsistent" });
      break;
    }
  }
});

export type ResearchReportListResponse = z.infer<typeof researchReportListResponseSchema>;

export const researchReportProvenanceSchema = researchPublicationProvenanceSchema.extend({
  inputFingerprint: fingerprint,
  terminalAttemptId: positiveSafeInteger,
});

export type ResearchReportProvenance = z.infer<typeof researchReportProvenanceSchema>;

export const researchEvidenceStateSchema = z.enum(["valid", "invalid", "redacted"]);

const researchEvidenceExcerptSchema = z.string().min(1).max(65_536)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536);
const researchEvidenceTitleSchema = z.string().max(snapshotTabTitleMaxLength)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 8192);

const researchTabEvidenceDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(100),
  kind: z.literal("tab_content"),
  sourceId: positiveSafeInteger,
  sourceKind: researchSourceKindSchema,
  acquisitionMethod: researchSourceAcquisitionMethodSchema,
  contentRevision: positiveSafeInteger,
  contentDigest: fingerprint,
  state: researchEvidenceStateSchema,
  stateReason: boundedText(512).nullable(),
  locatorDigest: fingerprint,
  locator: researchUtf8RangeLocatorSchema.nullable(),
  excerptHash: fingerprint,
  excerpt: researchEvidenceExcerptSchema.nullable(),
  url: boundedText(8192).nullable(),
  title: researchEvidenceTitleSchema.nullable(),
}).superRefine((value, context) => {
  const materialIsNull = value.locator === null && value.excerpt === null &&
    value.url === null && value.title === null;
  if ((value.state === "redacted") !== materialIsNull) {
    context.addIssue({ code: "custom", message: "Redacted tab evidence material is inconsistent" });
  }
  refineResearchSourceProvenance(value, context);
});

const researchSnapshotEvidenceCommon = {
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(100),
  snapshotId: positiveSafeInteger,
  state: researchEvidenceStateSchema,
  stateReason: boundedText(512).nullable(),
  locatorDigest: fingerprint,
  locator: researchWholeSnapshotLocatorSchema.nullable(),
  excerptHash: fingerprint,
  excerpt: researchEvidenceExcerptSchema.nullable(),
};

function refineSnapshotEvidenceMaterial(
  value: { state: "valid" | "invalid" | "redacted"; locator: unknown; excerpt: unknown },
  context: z.RefinementCtx,
): void {
  const materialIsNull = value.locator === null && value.excerpt === null;
  if ((value.state === "redacted") !== materialIsNull) {
    context.addIssue({ code: "custom", message: "Redacted snapshot evidence material is inconsistent" });
  }
}

export const researchEvidenceDetailSchema = z.discriminatedUnion("kind", [
  researchTabEvidenceDetailSchema,
  z.strictObject({ kind: z.literal("page_context"), ...researchSnapshotEvidenceCommon })
    .superRefine(refineSnapshotEvidenceMaterial),
  z.strictObject({ kind: z.literal("resource_context"), ...researchSnapshotEvidenceCommon })
    .superRefine(refineSnapshotEvidenceMaterial),
  z.strictObject({ kind: z.literal("activity"), ...researchSnapshotEvidenceCommon })
    .superRefine(refineSnapshotEvidenceMaterial),
  z.strictObject({ kind: z.literal("relation"), ...researchSnapshotEvidenceCommon })
    .superRefine(refineSnapshotEvidenceMaterial),
]);

export type ResearchEvidenceDetail = z.infer<typeof researchEvidenceDetailSchema>;

export const researchClaimDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(10_000),
  claimDigest: fingerprint,
  claimText: boundedText(16_384).nullable(),
  confidence: z.number().finite().min(0).max(1),
  isInference: z.boolean(),
  rationaleDigest: fingerprint.nullable(),
  rationale: boundedText(4096).nullable(),
  evidence: z.array(researchEvidenceDetailSchema).max(100),
}).superRefine((value, context) => {
  if (value.claimText === null && value.rationale !== null) {
    context.addIssue({ code: "custom", message: "Redacted claim material is inconsistent" });
  }
  if (value.claimText !== null && value.isInference !== (value.rationale !== null)) {
    context.addIssue({ code: "custom", message: "Inference rationale is inconsistent" });
  }
  if (value.isInference !== (value.rationaleDigest !== null)) {
    context.addIssue({ code: "custom", message: "Inference rationale digest is inconsistent" });
  }
  if (!value.isInference && value.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Non-inference claim requires evidence" });
  }
  if (value.evidence.some((evidence, index) => evidence.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Claim evidence must be uniquely ordered" });
  }
});

export type ResearchClaimDetail = z.infer<typeof researchClaimDetailSchema>;

export const researchReportDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  runId: positiveSafeInteger,
  jobId: researchJobIdSchema,
  runStatus: researchRunStatusSchema,
  target: researchTargetSchema,
  version: positiveSafeInteger,
  parentReportId: positiveSafeInteger.nullable(),
  publishStatus: z.enum(["succeeded", "partial"]),
  state: researchReportStateSchema,
  reason: researchPublicationReasonSchema.nullable(),
  coverage: researchCoverageSchema,
  createdAt: researchTimestampSchema,
  headFlags: researchReportHeadFlagsSchema,
  dossier: researchDossierSchema.nullable(),
  reportText: boundedText(1_000_000).nullable(),
  provenance: researchReportProvenanceSchema,
  claims: z.array(researchClaimDetailSchema).max(10_000),
}).superRefine((value, context) => {
  if ((value.publishStatus === "succeeded") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "Report reason is inconsistent" });
  }
  const redacted = value.state === "redacted";
  if (redacted !== (value.dossier === null && value.reportText === null)) {
    context.addIssue({ code: "custom", message: "Redacted report material is inconsistent" });
  }
  if (!redacted && (value.dossier === null || value.reportText === null)) {
    context.addIssue({ code: "custom", message: "Non-redacted report requires material" });
  }
  if (value.publishStatus === "partial" && value.state === "fresh") {
    context.addIssue({ code: "custom", message: "Partial report cannot be fresh" });
  }
  if (value.runStatus !== value.publishStatus) {
    context.addIssue({ code: "custom", message: "Report run status is inconsistent" });
  }
  if (value.headFlags.isCurrentFresh &&
      (value.state !== "fresh" || value.publishStatus !== "succeeded")) {
    context.addIssue({ code: "custom", message: "Current report flag requires fresh success" });
  }
  if (value.headFlags.isLastSuccessful && value.publishStatus !== "succeeded") {
    context.addIssue({ code: "custom", message: "Last-successful flag requires success" });
  }
  if (value.claims.some((claim, index) => claim.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Report claims must be uniquely ordered" });
  }
  const hasExposedRedactedMaterial = value.claims.some((claim) =>
    redacted && (claim.claimText !== null || claim.rationale !== null ||
      claim.evidence.some((evidence) => evidence.state !== "redacted")));
  const hasMissingLiveMaterial = value.claims.some((claim) =>
    !redacted && claim.claimText === null);
  if (hasExposedRedactedMaterial || hasMissingLiveMaterial) {
    context.addIssue({ code: "custom", message: "Report claim material conflicts with report state" });
  }
});

export type ResearchReportDetail = z.infer<typeof researchReportDetailSchema>;

const agentResearchTabEvidenceDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(100),
  kind: z.literal("tab_content"),
  sourceId: positiveSafeInteger,
  sourceKind: researchSourceKindSchema,
  acquisitionMethod: researchSourceAcquisitionMethodSchema,
  contentRevision: positiveSafeInteger,
  contentDigest: fingerprint,
  state: researchEvidenceStateSchema,
  stateReason: boundedText(512).nullable(),
  locatorDigest: fingerprint,
  excerptHash: fingerprint,
}).superRefine(refineResearchSourceProvenance);

const agentResearchSnapshotEvidenceCommon = {
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(100),
  snapshotId: positiveSafeInteger,
  state: researchEvidenceStateSchema,
  stateReason: boundedText(512).nullable(),
  locatorDigest: fingerprint,
  excerptHash: fingerprint,
};

export const agentResearchEvidenceDetailSchema = z.discriminatedUnion("kind", [
  agentResearchTabEvidenceDetailSchema,
  z.strictObject({ kind: z.literal("page_context"), ...agentResearchSnapshotEvidenceCommon }),
  z.strictObject({ kind: z.literal("resource_context"), ...agentResearchSnapshotEvidenceCommon }),
  z.strictObject({ kind: z.literal("activity"), ...agentResearchSnapshotEvidenceCommon }),
  z.strictObject({ kind: z.literal("relation"), ...agentResearchSnapshotEvidenceCommon }),
]);

export const agentResearchClaimDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  ordinal: positiveSafeInteger.max(10_000),
  claimDigest: fingerprint,
  claimText: boundedText(16_384).nullable(),
  confidence: z.number().finite().min(0).max(1),
  isInference: z.boolean(),
  rationaleDigest: fingerprint.nullable(),
  rationale: boundedText(4096).nullable(),
  evidence: z.array(agentResearchEvidenceDetailSchema).max(100),
}).superRefine((value, context) => {
  if (value.claimText === null && value.rationale !== null) {
    context.addIssue({ code: "custom", message: "Redacted claim material is inconsistent" });
  }
  if (value.claimText !== null && value.isInference !== (value.rationale !== null)) {
    context.addIssue({ code: "custom", message: "Inference rationale is inconsistent" });
  }
  if (value.isInference !== (value.rationaleDigest !== null)) {
    context.addIssue({ code: "custom", message: "Inference rationale digest is inconsistent" });
  }
  if (!value.isInference && value.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Non-inference claim requires evidence" });
  }
  if (value.evidence.some((evidence, index) => evidence.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Claim evidence must be uniquely ordered" });
  }
});

export const agentResearchReportDetailSchema = z.strictObject({
  id: positiveSafeInteger,
  runId: positiveSafeInteger,
  jobId: researchJobIdSchema,
  runStatus: researchRunStatusSchema,
  target: researchTargetSchema,
  version: positiveSafeInteger,
  parentReportId: positiveSafeInteger.nullable(),
  publishStatus: z.enum(["succeeded", "partial"]),
  state: researchReportStateSchema,
  reason: researchPublicationReasonSchema.nullable(),
  coverage: researchCoverageSchema,
  createdAt: researchTimestampSchema,
  headFlags: researchReportHeadFlagsSchema,
  dossier: researchDossierSchema.nullable(),
  reportText: boundedText(1_000_000).nullable(),
  provenance: researchReportProvenanceSchema,
  claims: z.array(agentResearchClaimDetailSchema).max(10_000),
}).superRefine((value, context) => {
  if ((value.publishStatus === "succeeded") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "Report reason is inconsistent" });
  }
  const redacted = value.state === "redacted";
  if (redacted !== (value.dossier === null && value.reportText === null) ||
      value.claims.some((claim) => redacted &&
        (claim.claimText !== null || claim.rationale !== null))) {
    context.addIssue({ code: "custom", message: "Agent report redaction is inconsistent" });
  }
  if (!redacted && (value.dossier === null || value.reportText === null ||
      value.claims.some((claim) => claim.claimText === null))) {
    context.addIssue({ code: "custom", message: "Agent report material is incomplete" });
  }
  if (value.publishStatus === "partial" && value.state === "fresh") {
    context.addIssue({ code: "custom", message: "Partial report cannot be fresh" });
  }
  if (value.runStatus !== value.publishStatus) {
    context.addIssue({ code: "custom", message: "Report run status is inconsistent" });
  }
  if (value.headFlags.isCurrentFresh &&
      (value.state !== "fresh" || value.publishStatus !== "succeeded")) {
    context.addIssue({ code: "custom", message: "Current report flag requires fresh success" });
  }
  if (value.headFlags.isLastSuccessful && value.publishStatus !== "succeeded") {
    context.addIssue({ code: "custom", message: "Last-successful flag requires success" });
  }
  if (value.claims.some((claim, index) => claim.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "Report claims must be uniquely ordered" });
  }
});

export type AgentResearchReportDetail = z.infer<typeof agentResearchReportDetailSchema>;

export function projectAgentResearchReportDetail(
  value: ResearchReportDetail,
): AgentResearchReportDetail {
  const local = researchReportDetailSchema.parse(value);
  return agentResearchReportDetailSchema.parse({
    ...local,
    claims: local.claims.map((claim) => ({
      id: claim.id,
      ordinal: claim.ordinal,
      claimDigest: claim.claimDigest,
      claimText: claim.claimText,
      confidence: claim.confidence,
      isInference: claim.isInference,
      rationaleDigest: claim.rationaleDigest,
      rationale: claim.rationale,
      evidence: claim.evidence.map((evidence) => evidence.kind === "tab_content"
        ? {
            id: evidence.id,
            ordinal: evidence.ordinal,
            kind: evidence.kind,
            sourceId: evidence.sourceId,
            sourceKind: evidence.sourceKind,
            acquisitionMethod: evidence.acquisitionMethod,
            contentRevision: evidence.contentRevision,
            contentDigest: evidence.contentDigest,
            state: evidence.state,
            stateReason: evidence.stateReason,
            locatorDigest: evidence.locatorDigest,
            excerptHash: evidence.excerptHash,
          }
        : {
            id: evidence.id,
            ordinal: evidence.ordinal,
            kind: evidence.kind,
            snapshotId: evidence.snapshotId,
            state: evidence.state,
            stateReason: evidence.stateReason,
            locatorDigest: evidence.locatorDigest,
            excerptHash: evidence.excerptHash,
          }),
    })),
  });
}

export const researchErrorCodeSchema = z.enum([
  "RESEARCH_SCOPE_TOO_LARGE",
  "RESEARCH_SELECTION_INVALID",
  "RESEARCH_PREFLIGHT_STALE",
  "RESEARCH_CAPTURE_REQUIRED",
  "RESEARCH_TARGET_NOT_FOUND",
  "RESEARCH_PARENT_NOT_FOUND",
  "RESEARCH_PARENT_UNAVAILABLE",
  "RESEARCH_PROVIDER_UNAVAILABLE",
  "RESEARCH_CORPUS_MISMATCH",
  "RESEARCH_PUBLICATION_INVALID",
  "RESEARCH_EVIDENCE_INVALID",
  "RESEARCH_REDACTION_REQUIRED",
]);

export type ResearchErrorCode = z.infer<typeof researchErrorCodeSchema>;

export const researchPrivacyTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("source"), sourceId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("snapshot"), kind: z.enum([
    "page_context", "resource_context", "activity", "relation",
  ]), snapshotId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("report"), reportId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("logical_page"), logicalPageId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("target"), target: researchTargetSchema }),
]);
export const researchPrivacyRequestSchema = z.strictObject({
  target: researchPrivacyTargetSchema,
  reason: boundedText(512),
  idempotencyKey: boundedText(200),
});
export type ResearchPrivacyRequest = z.infer<typeof researchPrivacyRequestSchema>;

/** Public privacy target excludes direct snapshots; those remain internal cascade details. */
export const researchRedactionTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("source"), sourceId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("report"), reportId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("logical_page"), logicalPageId: positiveSafeInteger }),
  z.strictObject({ type: z.literal("target"), target: researchTargetSchema }),
]);

export const researchRedactionRequestSchema = z.strictObject({
  target: researchRedactionTargetSchema,
  reason: boundedText(512),
  idempotencyKey: boundedText(200),
});

export type ResearchRedactionRequest = z.infer<typeof researchRedactionRequestSchema>;

export const researchRedactionReceiptSchema = z.strictObject({
  sources: nonnegativeSafeInteger,
  snapshots: nonnegativeSafeInteger,
  evidence: nonnegativeSafeInteger,
  reports: nonnegativeSafeInteger,
  runs: nonnegativeSafeInteger,
  cancelledJobs: nonnegativeSafeInteger,
});

export type ResearchRedactionReceipt = z.infer<typeof researchRedactionReceiptSchema>;
