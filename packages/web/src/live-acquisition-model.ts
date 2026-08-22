import {
  liveAcquisitionCanonicalOriginSchema,
  liveAcquisitionEffectivePolicySchema,
  liveAcquisitionLimitsSchema,
  liveAcquisitionPreflightRequestSchema,
  liveAcquisitionPreflightSchema,
  liveAcquisitionStartRequestSchema,
  privacyPurgeIdSchema,
  researchCoverageSchema,
  researchEstimateSchema,
  type LiveAcquisitionPreflight,
  type LiveAcquisitionPreflightRequest,
  type LiveAcquisitionRunStatus,
  type LiveAcquisitionStartRequest,
} from "@tabhub/shared";

const encoder = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

export function canonicalizeLiveAcquisitionOrigins(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > 16) {
    throw new Error("Live acquisition requires between 1 and 16 origins.");
  }
  const origins = values.map((value) => liveAcquisitionCanonicalOriginSchema.parse(value));
  if (new Set(origins).size !== origins.length) throw new Error("Live acquisition origins repeat.");
  return origins.sort(compareUtf8);
}

export interface LiveAcquisitionConsentDraft {
  readonly request: LiveAcquisitionPreflightRequest;
  readonly preflight: LiveAcquisitionPreflight;
  readonly signature: string;
}

function consentSignature(preflight: LiveAcquisitionPreflight): string {
  return JSON.stringify(preflight);
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createLiveAcquisitionConsentDraft(
  request: LiveAcquisitionPreflightRequest,
  response: LiveAcquisitionPreflight,
): LiveAcquisitionConsentDraft {
  const parsedRequest = liveAcquisitionPreflightRequestSchema.parse(request);
  const preflight = liveAcquisitionPreflightSchema.parse(response);
  if (JSON.stringify(parsedRequest.research.target) !== JSON.stringify(preflight.target) ||
      JSON.stringify(parsedRequest.approvedOrigins) !== JSON.stringify(preflight.approvedOrigins) ||
      JSON.stringify(parsedRequest.limits) !== JSON.stringify(preflight.limits)) {
    throw new Error("Live acquisition consent does not match its request.");
  }
  return deepFreeze({ request: parsedRequest, preflight,
    signature: consentSignature(preflight) }) as LiveAcquisitionConsentDraft;
}

export function isLiveAcquisitionConsentCurrent(
  draft: LiveAcquisitionConsentDraft,
  response: LiveAcquisitionPreflight,
  now = new Date(),
): boolean {
  const parsed = liveAcquisitionPreflightSchema.safeParse(response);
  return parsed.success && draft.signature === consentSignature(parsed.data) &&
    Date.parse(parsed.data.expiresAt) > now.getTime();
}

export function createLiveAcquisitionStartRequest(
  draft: LiveAcquisitionConsentDraft,
  idempotencyKey: string,
): LiveAcquisitionStartRequest {
  if (!isLiveAcquisitionConsentCurrent(draft, draft.preflight)) {
    throw new Error("Live acquisition consent is stale.");
  }
  return liveAcquisitionStartRequestSchema.parse({ version: 1, preflight: draft.request,
    approvalFingerprint: draft.preflight.approvalFingerprint,
    researchApprovalFingerprint: draft.preflight.researchApprovalFingerprint,
    idempotencyKey });
}

export type LiveAcquisitionFallbackCategory =
  | "capture_required" | "access_barrier" | "content_unusable"
  | "network_unavailable" | "policy_blocked";

const fallbackCategories = {
  SENSITIVE_URL_CAPTURE_REQUIRED: "capture_required",
  AUTH_REQUIRED: "access_barrier", CHALLENGE_PAGE: "access_barrier",
  SPA_SHELL: "content_unusable", INSUFFICIENT_PUBLIC_TEXT: "content_unusable",
  META_REFRESH: "content_unusable", HTTP_REDIRECT: "content_unusable",
  PARTIAL_RESPONSE: "content_unusable", INVALID_UTF8: "content_unusable",
  RESPONSE_SIZE_LIMIT: "content_unusable", IPV4_REQUIRED_V1: "network_unavailable",
  DNS_RESULT_UNKNOWN: "network_unavailable", TRANSPORT_DNS_FAILURE: "network_unavailable",
  TRANSPORT_CONNECT_FAILURE: "network_unavailable", TRANSPORT_TLS_FAILURE: "network_unavailable",
  TRANSPORT_TIMEOUT: "network_unavailable", POLICY_BLOCKED: "policy_blocked",
} as const satisfies Record<string, LiveAcquisitionFallbackCategory>;

export function describeLiveAcquisitionFallback(
  fallback: LiveAcquisitionRunStatus["actions"][number]["fallback"],
) {
  if (fallback === null) return null;
  return Object.freeze({ kind: fallback.recommendedKind, reason: fallback.reason,
    category: fallbackCategories[fallback.reason], label: `liveFallback.${fallback.reason}` as const });
}

type LiveAction = LiveAcquisitionRunStatus["actions"][number];

export interface ExactTabFallbackRequest {
  readonly version: 1;
  readonly jobId: string;
  readonly resourceId: number;
  readonly actionId: number;
  readonly exactUrl: string;
  readonly origin: string;
  readonly reason: NonNullable<LiveAction["fallback"]>["reason"];
}

export function createExactTabFallbackRequest(input: {
  readonly jobId: string;
  readonly resourceId: number;
  readonly action: LiveAction;
}): ExactTabFallbackRequest | null {
  const { action } = input;
  if (!/^resource_research:[1-9][0-9]*$/.test(input.jobId) ||
      !Number.isSafeInteger(input.resourceId) || input.resourceId < 1 ||
      action.kind !== "page" || action.redacted || action.fallback === null ||
      action.exactUrl === null || action.origin === null) return null;
  try {
    const url = new URL(action.exactUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.origin !== action.origin) return null;
    liveAcquisitionCanonicalOriginSchema.parse(action.origin);
    return deepFreeze({ version: 1, jobId: input.jobId, resourceId: input.resourceId,
      actionId: action.id, exactUrl: action.exactUrl, origin: action.origin,
      reason: action.fallback.reason }) as ExactTabFallbackRequest;
  } catch { return null; }
}

export function projectLiveAcquisitionOutcomes(status: LiveAcquisitionRunStatus) {
  return Object.freeze({
    acquisition: status.acquisitionOutcome,
    finalReport: status.final === null
      ? { state: "not_created" as const, reportId: null }
      : status.final.reportId === null
        ? { state: status.final.status === "queued" || status.final.status === "running"
            ? "pending" as const : "not_published" as const, reportId: null }
        : { state: status.final.status === "succeeded" ? "published" as const
            : "partial" as const, reportId: status.final.reportId },
  });
}

export const liveAcquisitionPersistenceKeys = Object.freeze({
  activeJob: "tabhub.live-acquisition.active-job.v1",
  reviewSummary: "tabhub.live-acquisition.review-summary.v1",
  privacyPurge: "tabhub.privacy-purge.active.v1",
});

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void;
  removeItem(key: string): void }

export interface LiveAcquisitionReviewSummary {
  readonly version: 1;
  readonly resourceId: number;
  readonly expiresAt: string;
  readonly dailyStartsRemaining: number;
  readonly dailyStartsResetAt: string;
  readonly limits: LiveAcquisitionPreflight["limits"];
  readonly effectivePolicy: LiveAcquisitionPreflight["effectivePolicy"];
  readonly capturedCorpus: Pick<LiveAcquisitionPreflight["capturedCorpus"], "coverage" | "estimate">;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function persistLiveAcquisitionReviewSummary(
  storage: StorageLike,
  resourceId: number,
  preflight: LiveAcquisitionPreflight | null,
): void {
  if (preflight === null) return storage.removeItem(liveAcquisitionPersistenceKeys.reviewSummary);
  const parsed = liveAcquisitionPreflightSchema.parse(preflight);
  if (!Number.isSafeInteger(resourceId) || resourceId < 1 ||
      parsed.target.resourceId !== resourceId) throw new Error("Invalid live review target.");
  const safe: LiveAcquisitionReviewSummary = {
    version: 1, resourceId, expiresAt: parsed.expiresAt,
    dailyStartsRemaining: parsed.dailyStartsRemaining,
    dailyStartsResetAt: parsed.dailyStartsResetAt, limits: parsed.limits,
    effectivePolicy: parsed.effectivePolicy,
    capturedCorpus: { coverage: parsed.capturedCorpus.coverage,
      estimate: parsed.capturedCorpus.estimate },
  };
  storage.setItem(liveAcquisitionPersistenceKeys.reviewSummary, JSON.stringify(safe));
}

export function readLiveAcquisitionReviewSummary(
  storage: StorageLike,
  resourceId: number,
  now = new Date(),
): LiveAcquisitionReviewSummary | null {
  const fail = () => {
    storage.removeItem(liveAcquisitionPersistenceKeys.reviewSummary);
    return null;
  };
  try {
    const raw = storage.getItem(liveAcquisitionPersistenceKeys.reviewSummary);
    if (raw === null) return null;
    const value = record(JSON.parse(raw));
    if (value === null || !exactKeys(value, ["version", "resourceId", "expiresAt",
      "dailyStartsRemaining", "dailyStartsResetAt", "limits", "effectivePolicy",
      "capturedCorpus"]) || value.version !== 1 || value.resourceId !== resourceId ||
      !Number.isSafeInteger(value.resourceId) || !validDateTime(value.expiresAt) ||
      Date.parse(value.expiresAt) <= now.getTime() || !validDateTime(value.dailyStartsResetAt) ||
      !Number.isSafeInteger(value.dailyStartsRemaining) || Number(value.dailyStartsRemaining) < 0 ||
      Number(value.dailyStartsRemaining) > 100) return fail();
    const corpus = record(value.capturedCorpus);
    if (corpus === null ||
      !exactKeys(corpus, ["coverage", "estimate"])) return fail();
    const limits = liveAcquisitionLimitsSchema.safeParse(value.limits);
    const policy = liveAcquisitionEffectivePolicySchema.safeParse(value.effectivePolicy);
    const coverage = researchCoverageSchema.safeParse(corpus.coverage);
    const estimate = researchEstimateSchema.safeParse(corpus.estimate);
    if (!limits.success || !policy.success || !coverage.success || !estimate.success) return fail();
    return deepFreeze({ version: 1, resourceId, expiresAt: value.expiresAt,
      dailyStartsRemaining: Number(value.dailyStartsRemaining),
      dailyStartsResetAt: value.dailyStartsResetAt, limits: limits.data,
      effectivePolicy: policy.data,
      capturedCorpus: { coverage: coverage.data, estimate: estimate.data },
    }) as LiveAcquisitionReviewSummary;
  } catch { return fail(); }
}

export function persistActiveLiveAcquisition(storage: StorageLike,
  value: { readonly jobId: string; readonly resourceId: number } | null): void {
  if (value === null) return storage.removeItem(liveAcquisitionPersistenceKeys.activeJob);
  if (!/^resource_research:[1-9][0-9]*$/.test(value.jobId) ||
      !Number.isSafeInteger(value.resourceId) || value.resourceId < 1) throw new Error("Invalid live job ref.");
  storage.setItem(liveAcquisitionPersistenceKeys.activeJob, JSON.stringify(value));
}

export function persistActivePrivacyPurge(storage: StorageLike,
  value: { readonly purgeId: string; readonly idempotencyKey: string } | null): void {
  if (value === null) return storage.removeItem(liveAcquisitionPersistenceKeys.privacyPurge);
  const purgeId = privacyPurgeIdSchema.parse(value.purgeId);
  if (value.idempotencyKey.trim() !== value.idempotencyKey || value.idempotencyKey.length < 1 ||
      value.idempotencyKey.length > 200) throw new Error("Invalid purge ref.");
  storage.setItem(liveAcquisitionPersistenceKeys.privacyPurge,
    JSON.stringify({ purgeId, idempotencyKey: value.idempotencyKey }));
}

export function readActiveLiveAcquisition(storage: StorageLike) {
  try {
    const raw = storage.getItem(liveAcquisitionPersistenceKeys.activeJob);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "jobId,resourceId" ||
        typeof value.jobId !== "string" || !/^resource_research:[1-9][0-9]*$/.test(value.jobId) ||
        !Number.isSafeInteger(value.resourceId) || Number(value.resourceId) < 1) return null;
    return { jobId: value.jobId, resourceId: Number(value.resourceId) };
  } catch { return null; }
}

export function readActivePrivacyPurge(storage: StorageLike) {
  try {
    const raw = storage.getItem(liveAcquisitionPersistenceKeys.privacyPurge);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "idempotencyKey,purgeId" ||
        typeof value.purgeId !== "string" || !privacyPurgeIdSchema.safeParse(value.purgeId).success ||
        typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim() !== value.idempotencyKey ||
        value.idempotencyKey.length < 1 || value.idempotencyKey.length > 200) return null;
    return { purgeId: value.purgeId, idempotencyKey: value.idempotencyKey };
  } catch { return null; }
}
