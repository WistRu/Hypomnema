import { z } from "zod";

import {
  researchCoverageSchema,
  researchEstimateSchema,
  researchPreflightRequestSchema,
  researchSafePageManifestEntrySchema,
  researchSafeSnapshotManifestEntrySchema,
} from "./research-contracts.ts";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value === value.trim())
  .refine((value) => new TextEncoder().encode(value).byteLength <= maximum);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const liveAcquisitionWorkflowRef = Object.freeze({
  id: "research_acquisition:c90:v1" as const,
  version: 1 as const,
});

export const liveAcquisitionResourceTargetSchema = z.strictObject({
  type: z.literal("resource"),
  resourceId: positiveSafeInteger,
});

export const liveAcquisitionCanonicalOriginSchema = z.string().max(2_048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
          url.origin !== value || url.pathname !== "/" || url.search !== "" ||
          url.hash !== "" || url.hostname === "localhost" || !url.hostname.includes(".")) {
        context.addIssue({ code: "custom", message: "Origin must be canonical HTTPS" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Origin must be canonical HTTPS" });
    }
  });

export const liveAcquisitionLimitsSchema = z.strictObject({
  maxPages: z.number().int().min(1).max(50).default(10),
  maxDepth: z.number().int().min(0).max(3).default(1),
  durationMs: z.number().int().min(30_000).max(900_000).default(300_000),
  maxCostUsd: z.number().finite().gt(0).max(2).default(1),
});

export const liveAcquisitionEffectivePolicySchema = z.strictObject({
  egress: z.literal("local_tabhub_server"),
  browserNetworkMayDiffer: z.literal(true),
  method: z.literal("GET"),
  sendsCookies: z.literal(false),
  sendsCredentials: z.literal(false),
  followsRedirects: z.literal(false),
  robotsRequired: z.literal(true),
  minCadenceMs: z.literal(2_000),
  maxSourceBytes: z.literal(65_536),
  maxTotalBytes: z.literal(4_194_304),
  dnsTimeoutMs: z.literal(3_000),
  connectTimeoutMs: z.literal(5_000),
  headersTimeoutMs: z.literal(8_000),
  bodyIdleTimeoutMs: z.literal(3_000),
  requestTimeoutMs: z.literal(15_000),
  maxHeaderBytes: z.literal(16_384),
  maxNetworkActions: z.number().int().min(2).max(66),
  requestPolicyVersion: z.literal("safe_public_http_request:v1"),
  ipPolicyVersion: z.literal("public_ip_policy:v1"),
});

export function liveAcquisitionEffectivePolicy(maxPages: number, originCount: number) {
  return liveAcquisitionEffectivePolicySchema.parse({
    egress: "local_tabhub_server", browserNetworkMayDiffer: true, method: "GET",
    sendsCookies: false, sendsCredentials: false, followsRedirects: false,
    robotsRequired: true, minCadenceMs: 2_000, maxSourceBytes: 65_536,
    maxTotalBytes: 4_194_304, dnsTimeoutMs: 3_000, connectTimeoutMs: 5_000,
    headersTimeoutMs: 8_000, bodyIdleTimeoutMs: 3_000, requestTimeoutMs: 15_000,
    maxHeaderBytes: 16_384, maxNetworkActions: maxPages + originCount,
    requestPolicyVersion: "safe_public_http_request:v1", ipPolicyVersion: "public_ip_policy:v1",
  });
}

const resourceResearchPreflightRequestSchema = researchPreflightRequestSchema.extend({
  target: liveAcquisitionResourceTargetSchema,
}).strict();

const approvedOriginsSchema = z.array(liveAcquisitionCanonicalOriginSchema).min(1).max(16)
  .superRefine((origins, context) => {
    if (new Set(origins).size !== origins.length ||
        origins.some((origin, index) => index > 0 && origins[index - 1]! >= origin)) {
      context.addIssue({ code: "custom", message: "Origins must be unique and sorted" });
    }
  });

export const liveAcquisitionPreflightRequestSchema = z.strictObject({
  version: z.literal(1),
  research: resourceResearchPreflightRequestSchema,
  approvedOrigins: approvedOriginsSchema,
  limits: liveAcquisitionLimitsSchema,
});

export const liveAcquisitionStartRequestSchema = z.strictObject({
  version: z.literal(1),
  preflight: liveAcquisitionPreflightRequestSchema,
  approvalFingerprint: fingerprint,
  researchApprovalFingerprint: fingerprint,
  idempotencyKey: boundedText(200),
});

export const liveAcquisitionPreflightSchema = z.strictObject({
  version: z.literal(1),
  target: liveAcquisitionResourceTargetSchema,
  approvedOrigins: approvedOriginsSchema,
  limits: liveAcquisitionLimitsSchema,
  researchApprovalFingerprint: fingerprint,
  approvalFingerprint: fingerprint,
  expiresAt: z.string().datetime({ offset: false }),
  provider: z.strictObject({
    provider: boundedText(128),
    model: boundedText(200),
    promptVersion: boundedText(128),
    pricingVersion: boundedText(128),
    maxOutputTokens: z.number().int().min(1).max(200_000),
  }),
  rulesetVersion: positiveSafeInteger,
  rulesetGenerationDigest: fingerprint,
  resourceGenerationDigest: fingerprint,
  dailyStartsRemaining: z.number().int().min(0).max(100),
  dailyStartsResetAt: z.string().datetime({ offset: false }),
  effectivePolicy: liveAcquisitionEffectivePolicySchema,
  capturedCorpus: z.strictObject({
    corpusFingerprint: fingerprint,
    coverage: researchCoverageSchema,
    manifest: z.array(researchSafePageManifestEntrySchema).max(10_000),
    snapshots: z.array(researchSafeSnapshotManifestEntrySchema).max(100),
    estimate: researchEstimateSchema,
  }),
});

export const liveAcquisitionActionStateSchema = z.enum([
  "planned", "resolution_started", "resolved", "authorized", "started",
  "completed", "blocked", "ambiguous",
]);
export const liveAcquisitionActionOutcomeCodeSchema = z.enum([
  "DNS_RESULT_UNKNOWN", "RUNTIME_RESTARTED_BEFORE_REQUEST", "IPV4_REQUIRED_V1",
  "PARTIAL_RESPONSE", "META_REFRESH", "AUTH_REQUIRED", "CHALLENGE_PAGE", "SPA_SHELL",
  "INSUFFICIENT_PUBLIC_TEXT", "INVALID_UTF8", "CONSENT_EXPIRED_IN_FLIGHT",
  "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH", "SENSITIVE_URL_CAPTURE_REQUIRED",
  "LIVE_ACQUISITION_DISABLED", "LIVE_ACQUISITION_DISABLED_IN_FLIGHT", "POLICY_BLOCKED",
  "TRANSPORT_DNS_FAILURE", "TRANSPORT_CONNECT_FAILURE", "TRANSPORT_TLS_FAILURE",
  "TRANSPORT_TIMEOUT", "HTTP_INFORMATIONAL", "HTTP_SUCCESS", "HTTP_REDIRECT",
  "HTTP_CLIENT_ERROR", "HTTP_SERVER_ERROR", "RESPONSE_SIZE_LIMIT", "FETCH_COMPLETED",
  "CANCELLED", "BUDGET_EXHAUSTED",
]);
export const liveAcquisitionExactTabFallbackReasonSchema = z.enum([
  "SENSITIVE_URL_CAPTURE_REQUIRED", "AUTH_REQUIRED", "CHALLENGE_PAGE", "SPA_SHELL",
  "INSUFFICIENT_PUBLIC_TEXT", "META_REFRESH", "HTTP_REDIRECT", "IPV4_REQUIRED_V1",
  "DNS_RESULT_UNKNOWN", "TRANSPORT_DNS_FAILURE", "TRANSPORT_CONNECT_FAILURE",
  "TRANSPORT_TLS_FAILURE", "TRANSPORT_TIMEOUT", "PARTIAL_RESPONSE", "INVALID_UTF8",
  "RESPONSE_SIZE_LIMIT", "POLICY_BLOCKED",
]);
export const liveAcquisitionWorkflowOutcomeSchema = z.enum([
  "handoff", "captured_only", "blocked", "ambiguous", "superseded",
]);
export const liveAcquisitionWorkflowOutcomeCodeSchema = z.enum([
  "LIVE_ACQUISITION_RESOURCE_REQUIRED", "LIVE_ACQUISITION_TARGET_UNSUPPORTED",
  "RESEARCH_WORKFLOW_UNSUPPORTED", "LIVE_ACQUISITION_DISABLED",
  "LIVE_ACQUISITION_DISABLED_IN_FLIGHT", "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH",
  "SENSITIVE_URL_CAPTURE_REQUIRED", "CONSENT_EXPIRED_IN_FLIGHT",
  "PURGE_WAITING_FOR_ACTION", "SUBJECT_FORGOTTEN", "WORKFLOW_COMPLETED",
  "WORKFLOW_BLOCKED", "WORKFLOW_AMBIGUOUS", "WORKFLOW_FAILED", "WORKFLOW_CANCELLED",
  "NO_ELIGIBLE_SOURCE", "BUDGET_EXHAUSTED", "POLICY_BLOCKED", "PROVIDER_UNAVAILABLE",
]);
const statusTimestamp = z.string().datetime({ offset: false });
const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const liveAcquisitionStatusActionSchema = z.strictObject({ id: safeId,
    kind: z.enum(["page", "robots"]),
    depth: z.number().int().min(0).max(3).nullable(), state: liveAcquisitionActionStateSchema,
    latestOutcome: liveAcquisitionActionOutcomeCodeSchema.nullable(), createdAt: statusTimestamp,
    terminalAt: statusTimestamp.nullable(), exactUrl: z.string().url().max(8192).nullable(),
    origin: liveAcquisitionCanonicalOriginSchema.nullable(), redacted: z.boolean(),
    usability: z.enum(["usable", "unusable", "pending"]).nullable(),
    sourceUsable: z.boolean().nullable(),
    omissionReason: liveAcquisitionActionOutcomeCodeSchema.nullable(),
    fallback: z.strictObject({ recommendedKind: z.literal("exact_tab_capture"),
      reason: liveAcquisitionExactTabFallbackReasonSchema }).nullable(),
    capture: z.strictObject({ manifestId: safeId, logicalPageId: safeId,
      captureSequence: z.number().int().min(1).max(50), contentDigest: fingerprint }).nullable(),
    finalInclusion: z.strictObject({ sourceReceiptId: safeId, finalRunId: safeId,
      includedOrder: z.number().int().min(1).max(100), sourceKind: z.literal("live_acquisition"),
      acquisitionMethod: z.literal("safe_public_http_v1") }).nullable(),
  });
export const liveAcquisitionStatusActionsSchema = z.array(liveAcquisitionStatusActionSchema)
  .max(1_016);

export const liveAcquisitionRunStatusSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.string().regex(/^resource_research:[1-9][0-9]*$/),
  target: liveAcquisitionResourceTargetSchema,
  coordinator: z.strictObject({ runId: safeId, status: z.enum([
    "queued", "running", "succeeded", "partial", "failed", "cancelled", "superseded",
  ]) }),
  final: z.strictObject({ jobId: z.string().regex(/^resource_research:[1-9][0-9]*$/),
    runId: safeId, status: z.enum(["queued", "running", "succeeded", "partial", "failed",
      "cancelled", "superseded"]), reportId: safeId.nullable() }).nullable(),
  consent: z.strictObject({ state: z.enum(["active", "expired", "consumed", "revoked"]),
    createdAt: statusTimestamp, expiresAt: statusTimestamp, terminalAt: statusTimestamp.nullable(),
    approvedOrigins: z.array(liveAcquisitionCanonicalOriginSchema).max(16),
    limits: z.strictObject({ maxPages: z.number().int().min(1).max(50),
      maxDepth: z.number().int().min(0).max(3), durationMs: z.number().int(),
      maxCostUsd: z.number().finite(), maxOrigins: z.number().int(),
      maxOutputTokens: z.number().int() }), effectivePolicy: liveAcquisitionEffectivePolicySchema }),
  runLiveSuccess: z.boolean().nullable(),
  workflowOutcome: liveAcquisitionWorkflowOutcomeSchema.nullable(),
  workflowOutcomeCode: liveAcquisitionWorkflowOutcomeCodeSchema.nullable(),
  acquisitionOutcome: z.enum(["running", "live_complete", "mixed", "zero_usable",
    "blocked", "ambiguous", "cancelled", "failed", "purging", "redacted"]),
  counters: z.strictObject({ reservedPages: z.number().int().nonnegative(),
    visitedPages: z.number().int().nonnegative(), capturedPages: z.number().int().nonnegative(),
    blockedPages: z.number().int().nonnegative(), ambiguousPages: z.number().int().nonnegative(),
    robotsActions: z.number().int().nonnegative(), networkActions: z.number().int().nonnegative(),
    plannedActions: z.number().int().nonnegative(), activeActions: z.number().int().nonnegative() }),
  actions: liveAcquisitionStatusActionsSchema,
}).superRefine((value, context) => {
  if ((value.workflowOutcome === null) !== (value.workflowOutcomeCode === null)) {
    context.addIssue({ code: "custom", message: "Workflow outcome and code must coexist" });
  }
});

export const liveAcquisitionStartReceiptSchema = z.strictObject({
  id: z.string().regex(/^resource_research:[1-9][0-9]*$/),
  kind: z.literal("resource_research"),
  status: z.enum(["queued", "running", "succeeded", "partial", "failed", "cancelled",
    "superseded"]),
});

export const liveAcquisitionBudgetExhaustedSchema = z.strictObject({
  error: z.literal("JOB_BUDGET_EXHAUSTED"),
  dailyStartsRemaining: z.literal(0),
  dailyStartsResetAt: z.string().datetime({ offset: false }),
});

export type LiveAcquisitionLimits = z.infer<typeof liveAcquisitionLimitsSchema>;
export type LiveAcquisitionPreflightRequest = z.infer<
  typeof liveAcquisitionPreflightRequestSchema
>;
export type LiveAcquisitionStartRequest = z.infer<typeof liveAcquisitionStartRequestSchema>;
export type LiveAcquisitionPreflight = z.infer<typeof liveAcquisitionPreflightSchema>;
export type LiveAcquisitionRunStatus = z.infer<typeof liveAcquisitionRunStatusSchema>;
export type LiveAcquisitionStartReceipt = z.infer<typeof liveAcquisitionStartReceiptSchema>;
export type LiveAcquisitionBudgetExhausted = z.infer<
  typeof liveAcquisitionBudgetExhaustedSchema
>;
