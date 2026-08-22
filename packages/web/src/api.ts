import {
  assignTagsResponseSchema,
  activityWindowSchema,
  deleteResponseSchema,
  duplicateGroupBulkResponseSchema,
  duplicateGroupListResponseSchema,
  featureFlagsResponseSchema,
  graphV2ResponseSchema,
  graphResponseSchema,
  knowledgeRelationSchema,
  contextChangeResultSchema,
  localContextCommandSchema,
  localPageContextViewSchema,
  localPairingChallengeRequestSchema,
  localPairingChallengeResponseSchema,
  localPriorityFeedbackRequestSchema,
  localPriorityRecomputeRequestSchema,
  localSessionIntentCommandSchema,
  localTabListResponseSchema,
  logicalPageViewSchema,
  linkListResponseSchema,
  priorityFeedbackReceiptSchema,
  personalPriorityLifecycleRequestSchema,
  personalPriorityLifecycleResponseSchema,
  personalPriorityPreviewRequestSchema,
  personalPriorityPreviewResponseSchema,
  personalPriorityRequestFingerprint,
  personalPriorityRulesetVersionSchema,
  personalPriorityRulesStateResponseSchema,
  priorityReadBatchRequestSchema,
  priorityReadBatchResponseSchema,
  priorityReviewQueueQuerySchema,
  priorityReviewQueueResponseSchema,
  retentionDecisionResponseSchema,
  retentionForgetResponseSchema,
  retentionReviewResponseSchema,
  retentionTrashResponseSchema,
  localResourceCommandSchema,
  localResourceContextViewSchema,
  resourceCommandReceiptSchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceListResponseSchema,
  resourceResolutionSchema,
  resourceReviewQueueResponseSchema,
  resourceUserEvaluationRequestSchema,
  researchPreflightRequestSchema,
  researchPreflightSchema,
  researchRefineApprovalRequestSchema,
  researchReportDetailSchema,
  researchReportIdParamsSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  researchRunApprovalRequestSchema,
  liveAcquisitionPreflightRequestSchema,
  liveAcquisitionPreflightSchema,
  liveAcquisitionStartRequestSchema,
  liveAcquisitionStartReceiptSchema,
  liveAcquisitionRunStatusSchema,
  privacyPurgeIdSchema,
  privacyPurgeStartBodySchema,
  privacyPurgeStatusResponseSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  setImportanceResponseSchema,
  setStatusResponseSchema,
  sessionIntentBundleSchema,
  sessionIntentChangeResultSchema,
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  tabCommandRelayConnectedScopesResponseSchema,
  tabCommandRelayHttpRequestSchema,
  tabCommandRelayHttpResponseSchema,
  tabBulkIdsResponseSchema,
  tabDetailResponseSchema,
  tabInstanceBulkResponseSchema,
  tabInstanceListResponseSchema,
  tabLinkSchema,
  tabListResponseSchema,
  tagTreeResponseSchema,
  tagRecordSchema,
  workspaceDetailSchema,
  workspaceListResponseSchema,
  type CreateKnowledgeRelation,
  type ActivityWindow,
  type ExactTabScope,
  type LocalContextCommand,
  type LocalSessionIntentCommand,
  type LocalResourceCommand,
  type CreateTag,
  type KnowledgeNodeRef,
  type CreateWorkspace,
  type CreateLink,
  type PatchLink,
  type PatchTab,
  type PatchTag,
  type PersonalPriorityDraft,
  type PersonalPriorityLifecycleRequest,
  type PriorityMode,
  type PriorityRulesetRefContract,
  type PriorityFeedbackReceipt,
  type PrioritySafeRead,
  type PrioritySubjectContract,
  type RetentionDecision,
  type DurableJobId,
  type ResearchPreflightRequest,
  type ResearchRefineApprovalRequest,
  type ResearchRunApprovalRequest,
  type LiveAcquisitionPreflightRequest,
  type LiveAcquisitionStartRequest,
  type PrivacyPurgeStartBody,
  type ResearchTarget,
  type SummaryDepth,
  type SortDirection,
  type TabCommandRelayErrorCode,
  type TabCommandRelayHttpRequest,
  type TabCommandRelayResult,
  type TabImportance,
  type TabSortField,
  type TabStatus,
} from "@tabhub/shared";

export type OpenFilter = "all" | "open" | "closed";

export interface TabListFilters {
  browser: string;
  duplicatesOnly?: boolean;
  importance: "all" | TabImportance;
  openState: OpenFilter;
  page: number;
  q: string;
  resourceId?: number;
  priorityMode?: PriorityMode;
  needsReview?: boolean;
  sortBy?: TabSortField;
  sortDirection?: SortDirection;
  status: "all" | TabStatus;
  tag: string;
}

export type LibraryTabFilters = Omit<
  TabListFilters,
  "page" | "sortBy" | "sortDirection"
>;

export interface OpenTabListFilters {
  browser: string;
  duplicatesOnly: boolean;
  page: number;
  pageSize?: number;
  q: string;
}

export interface DuplicateGroupListFilters {
  browser: string;
  page: number;
  q?: string;
}

export type PatchTabDetails = PatchTab;
export type CreateTabLink = CreateLink;
export type PatchTabLink = PatchLink;
export type CreateTopicInput = CreateTag;
export type UpdateTopicInput = PatchTag;
export type CreateRelationInput = CreateKnowledgeRelation;

export interface KnowledgeGraphFocus {
  depth: number;
  node: KnowledgeNodeRef;
}

export class ApiRequestError extends Error {
  readonly name = "ApiRequestError";

  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
    readonly span?: { readonly start: number; readonly end: number },
    readonly liveAcquisitionBudget?: {
      readonly dailyStartsRemaining: 0;
      readonly dailyStartsResetAt: string;
    },
  ) {
    super(message);
  }
}

export async function preflightLiveAcquisition(
  input: LiveAcquisitionPreflightRequest,
  signal?: AbortSignal,
) {
  const body = liveAcquisitionPreflightRequestSchema.parse(input);
  const payload = await localRequestJson("/api/research/live/preflight", jsonRequest(body, signal),
    "TabHub could not prepare live acquisition",
    "TabHub returned unreadable live acquisition preflight data.");
  const parsed = liveAcquisitionPreflightSchema.safeParse(payload);
  if (!parsed.success || JSON.stringify(parsed.data.target) !== JSON.stringify(body.research.target) ||
      JSON.stringify(parsed.data.approvedOrigins) !== JSON.stringify(body.approvedOrigins) ||
      JSON.stringify(parsed.data.limits) !== JSON.stringify(body.limits)) {
    throw new Error("TabHub returned mismatched live acquisition preflight data.");
  }
  return parsed.data;
}

export async function startLiveAcquisition(input: LiveAcquisitionStartRequest,
  signal?: AbortSignal) {
  const body = liveAcquisitionStartRequestSchema.parse(input);
  const payload = await localRequestJson("/api/research/live/runs", jsonRequest(body, signal),
    "TabHub could not start live acquisition",
    "TabHub returned an unreadable live acquisition receipt.");
  const parsed = liveAcquisitionStartReceiptSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected live acquisition receipt.");
  return parsed.data;
}

export async function fetchLiveAcquisitionStatus(jobId: string, signal?: AbortSignal) {
  const payload = await localRequestJson(`/api/research/live/runs/${encodeURIComponent(jobId)}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read live acquisition status",
    "TabHub returned unreadable live acquisition status.");
  const parsed = liveAcquisitionRunStatusSchema.safeParse(payload);
  if (!parsed.success || parsed.data.jobId !== jobId) {
    throw new Error("TabHub returned mismatched live acquisition status.");
  }
  return parsed.data;
}

export async function startPrivacyPurge(input: PrivacyPurgeStartBody,
  signal?: AbortSignal) {
  const body = privacyPurgeStartBodySchema.parse(input);
  const payload = await localRequestJson("/api/privacy/purges", jsonRequest(body, signal),
    "TabHub could not start privacy purge", "TabHub returned unreadable privacy purge status.");
  const parsed = privacyPurgeStatusResponseSchema.safeParse(payload);
  if (!parsed.success || JSON.stringify(parsed.data.target) !== JSON.stringify(body.target)) {
    throw new Error("TabHub returned mismatched privacy purge status.");
  }
  return parsed.data;
}

export async function fetchPrivacyPurgeStatus(purgeId: string, signal?: AbortSignal) {
  const id = privacyPurgeIdSchema.parse(purgeId);
  const payload = await localRequestJson(`/api/privacy/purges/${encodeURIComponent(id)}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read privacy purge status", "TabHub returned unreadable privacy purge status.");
  const parsed = privacyPurgeStatusResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.purgeId !== id) {
    throw new Error("TabHub returned mismatched privacy purge status.");
  }
  return parsed.data;
}

export async function retryPrivacyPurge(purgeId: string, signal?: AbortSignal) {
  const id = privacyPurgeIdSchema.parse(purgeId);
  const payload = await localRequestJson(`/api/privacy/purges/${encodeURIComponent(id)}/retry`,
    { headers: { Accept: "application/json" }, method: "POST", signal: signal ?? null },
    "TabHub could not retry privacy purge", "TabHub returned unreadable privacy purge status.");
  const parsed = privacyPurgeStatusResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.purgeId !== id) {
    throw new Error("TabHub returned mismatched privacy purge status.");
  }
  return parsed.data;
}

export class TabCommandRelayClientError extends Error {
  readonly code: TabCommandRelayErrorCode;
  readonly outcome: "not-sent" | "unknown";

  constructor(
    message: string,
    options: {
      code: TabCommandRelayErrorCode;
      outcome: "not-sent" | "unknown";
    },
  ) {
    super(message);
    this.name = "TabCommandRelayClientError";
    this.code = options.code;
    this.outcome = options.outcome;
  }
}

let localSessionBootstrap: Promise<void> | undefined;

export function resetLocalSessionBootstrapForTests(): void {
  localSessionBootstrap = undefined;
}

export function ensureLocalSession(): Promise<void> {
  if (localSessionBootstrap !== undefined) return localSessionBootstrap;
  localSessionBootstrap = (async () => {
    const response = await fetch("/api/local/session/bootstrap", {
      headers: { Accept: "application/json" },
      method: "POST",
    });
    // The production server establishes the HttpOnly session during top-level
    // /app navigation and deliberately does not expose the development route.
    if (response.status === 404) return;
    if (!response.ok) {
      throw await responseError(
        response,
        `TabHub could not establish the local session (${response.status}).`,
      );
    }
  })().catch((error) => {
    localSessionBootstrap = undefined;
    throw error;
  });
  return localSessionBootstrap;
}

async function localRequestJson(
  input: RequestInfo | URL,
  init: RequestInit,
  errorMessage: string,
  unreadableMessage: string,
) {
  await ensureLocalSession();
  return requestJson(input, init, errorMessage, unreadableMessage);
}

function jsonRequest(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
    signal: signal ?? null,
  };
}

export async function fetchFeatureFlags(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/features",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load feature settings",
    "TabHub returned unreadable feature settings.",
  );
  const parsed = featureFlagsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected feature settings.");
  }

  return parsed.data;
}

export type PriorityFeedbackVerdict =
  | "accept"
  | "reject"
  | "too_high"
  | "too_low";

export interface PriorityFeedbackInput {
  assessmentId: number;
  idempotencyKey: string;
  note?: string;
  supersedesId?: number;
  verdict: PriorityFeedbackVerdict;
}

function samePrioritySubject(
  left: PrioritySubjectContract,
  right: PrioritySubjectContract,
): boolean {
  return left.type === "page"
    ? right.type === "page" && left.logicalPageId === right.logicalPageId
    : right.type === "resource" && left.resourceId === right.resourceId;
}

/**
 * Reads priority projections in contract-sized chunks. Each response is
 * correlated before it is exposed so an out-of-order or partial server reply
 * cannot attach an AI assessment to the wrong page or Resource.
 */
export async function fetchPriorityReadBatch(
  subjects: readonly PrioritySubjectContract[],
  signal?: AbortSignal,
): Promise<PrioritySafeRead[]> {
  const items: PrioritySafeRead[] = [];
  for (let offset = 0; offset < subjects.length; offset += 100) {
    const expected = subjects.slice(offset, offset + 100);
    const body = priorityReadBatchRequestSchema.parse({ subjects: expected });
    const payload = await requestJson(
      "/api/personalization/priority/read-batch",
      jsonRequest(body, signal),
      "TabHub could not load AI priority",
      "TabHub returned unreadable AI priority.",
    );
    const parsed = priorityReadBatchResponseSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.items.length !== expected.length ||
      parsed.data.items.some(
        (item, index) =>
          expected[index] === undefined ||
          !samePrioritySubject(item.subject, expected[index]),
      )
    ) {
      throw new Error("TabHub returned mismatched AI priority.");
    }
    items.push(...parsed.data.items);
  }
  return items;
}

export async function fetchPriorityReviewQueue(
  input: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
) {
  const query = priorityReviewQueueQuerySchema.parse(input);
  const search = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor !== undefined) search.set("cursor", query.cursor);
  const payload = await requestJson(
    `/api/personalization/priority/review-queue?${search.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the priority review queue",
    "TabHub returned an unreadable priority review queue.",
  );
  const parsed = priorityReviewQueueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected priority review queue.");
  }
  return parsed.data;
}

export async function submitPriorityFeedback(
  subject: PrioritySubjectContract,
  input: PriorityFeedbackInput,
  signal?: AbortSignal,
): Promise<PriorityFeedbackReceipt> {
  const body = localPriorityFeedbackRequestSchema.parse(input);
  const path = subject.type === "page"
    ? `/api/logical-pages/${subject.logicalPageId}/priority-feedback`
    : `/api/resources/${subject.resourceId}/priority-feedback`;
  const payload = await localRequestJson(
    path,
    jsonRequest(body, signal),
    "TabHub could not save priority feedback",
    "TabHub returned unreadable priority feedback.",
  );
  const parsed = priorityFeedbackReceiptSchema.safeParse(payload);
  const expectedNote = body.note ?? null;
  const expectedSupersedesId = body.supersedesId ?? null;
  if (
    !parsed.success ||
    !samePrioritySubject(parsed.data.subject, subject) ||
    parsed.data.assessmentId !== body.assessmentId ||
    parsed.data.verdict !== body.verdict ||
    parsed.data.note !== expectedNote ||
    parsed.data.supersedesId !== expectedSupersedesId
  ) {
    throw new Error("TabHub returned mismatched priority feedback.");
  }
  return parsed.data;
}

export async function fetchPersonalPriorityRules(signal?: AbortSignal) {
  const payload = await localRequestJson(
    "/api/personalization/rules",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load personal priority rules",
    "TabHub returned unreadable personal priority rules.",
  );
  const parsed = personalPriorityRulesStateResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected personal priority rules.");
  return parsed.data;
}

export async function fetchPersonalPriorityRulesVersion(
  ref: PriorityRulesetRefContract,
  signal?: AbortSignal,
) {
  const payload = await localRequestJson(
    `/api/personalization/rules/versions/${ref.rulesetId}/${ref.version}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this priority rules version",
    "TabHub returned an unreadable priority rules version.",
  );
  const parsed = personalPriorityRulesetVersionSchema.safeParse(payload);
  if (!parsed.success || parsed.data.ref.rulesetId !== ref.rulesetId ||
      parsed.data.ref.version !== ref.version) {
    throw new Error("TabHub returned a mismatched priority rules version.");
  }
  return parsed.data;
}

export async function previewPersonalPriorityRules(
  draft: PersonalPriorityDraft,
  signal?: AbortSignal,
) {
  const body = personalPriorityPreviewRequestSchema.parse({ draft });
  const payload = await localRequestJson(
    "/api/personalization/rules/preview",
    jsonRequest(body, signal),
    "TabHub could not preview personal priority rules",
    "TabHub returned an unreadable priority rules preview.",
  );
  const parsed = personalPriorityPreviewResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected priority rules preview.");
  return parsed.data;
}

type PersonalPriorityLifecycleInput =
  PersonalPriorityLifecycleRequest extends infer Request
    ? Request extends PersonalPriorityLifecycleRequest
      ? Omit<Request, "requestFingerprint">
      : never
    : never;

const personalPriorityLifecyclePaths = {
  save: "/api/personalization/rules/versions",
  activate: "/api/personalization/rules/activate",
  disable: "/api/personalization/rules/disable",
  reset: "/api/personalization/rules/reset",
  rollback: "/api/personalization/rules/rollback",
} as const;

export async function changePersonalPriorityRules(
  input: PersonalPriorityLifecycleInput,
  signal?: AbortSignal,
) {
  const requestFingerprint = await personalPriorityRequestFingerprint(input);
  const body = personalPriorityLifecycleRequestSchema.parse({
    ...input,
    requestFingerprint,
  });
  const payload = await localRequestJson(
    personalPriorityLifecyclePaths[body.kind],
    jsonRequest(body, signal),
    "TabHub could not update personal priority rules",
    "TabHub returned an unreadable priority rules update.",
  );
  const parsed = personalPriorityLifecycleResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.operation !== body.kind ||
      parsed.data.requestFingerprint !== requestFingerprint) {
    throw new Error("TabHub returned a mismatched priority rules update.");
  }
  return parsed.data;
}

export async function submitPriorityRecompute(
  input: { readonly idempotencyKey: string; readonly stepBatchSize?: number },
  signal?: AbortSignal,
) {
  const body = localPriorityRecomputeRequestSchema.parse(input);
  const payload = await localRequestJson(
    "/api/personalization/priority/recompute",
    jsonRequest(body, signal),
    "TabHub could not start priority recompute",
    "TabHub returned an unreadable priority recompute job.",
  );
  const parsed = durableJobRefSchema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "priority_assessment") {
    throw new Error("TabHub returned an unexpected priority recompute job.");
  }
  return parsed.data;
}

export async function fetchPriorityRecomputeJob(
  jobId: string,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/ai/jobs/${encodeURIComponent(jobId)}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read priority recompute progress",
    "TabHub returned unreadable priority recompute progress.",
  );
  const parsed = durableJobViewSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== jobId ||
      parsed.data.kind !== "priority_assessment") {
    throw new Error("TabHub returned mismatched priority recompute progress.");
  }
  return parsed.data;
}

export async function preflightResearch(
  input: ResearchPreflightRequest,
  signal?: AbortSignal,
) {
  const body = researchPreflightRequestSchema.parse(input);
  const payload = await localRequestJson(
    "/api/research/preflight",
    jsonRequest(body, signal),
    "TabHub could not prepare this research run",
    "TabHub returned unreadable research preflight data.",
  );
  const parsed = researchPreflightSchema.safeParse(payload);
  if (!parsed.success || JSON.stringify(parsed.data.target) !== JSON.stringify(body.target)) {
    throw new Error("TabHub returned mismatched research preflight data.");
  }
  return parsed.data;
}

export async function fetchLogicalPageResourceResolution(
  logicalPageId: number,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/logical-pages/${encodeURIComponent(String(logicalPageId))}/resource-resolution`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not resolve this page's resource",
    "TabHub returned unreadable resource resolution data.",
  );
  const parsed = resourceResolutionSchema.safeParse(payload);
  if (!parsed.success || parsed.data.logicalPageId !== logicalPageId) {
    throw new Error("TabHub returned mismatched resource resolution data.");
  }
  return parsed.data;
}

export async function submitResearchRun(
  input: ResearchRunApprovalRequest,
  signal?: AbortSignal,
) {
  const body = researchRunApprovalRequestSchema.parse(input);
  const payload = await localRequestJson(
    "/api/research/runs",
    jsonRequest(body, signal),
    "TabHub could not start this research run",
    "TabHub returned an unreadable research job.",
  );
  const parsed = durableJobRefSchema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "resource_research") {
    throw new Error("TabHub returned an unexpected research job.");
  }
  return parsed.data;
}

function sameResearchTarget(left: ResearchTarget, right: ResearchTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function researchTargetQuery(
  target: ResearchTarget,
  pagination: { readonly limit: number; readonly beforeVersion?: number },
): URLSearchParams {
  const parsed = researchReportListQuerySchema.parse({
    targetType: target.type,
    targetId: target.type === "page"
      ? target.logicalPageId
      : target.type === "resource"
        ? target.resourceId
        : target.fingerprint,
    limit: pagination.limit,
    ...(pagination.beforeVersion === undefined
      ? {}
      : { beforeVersion: pagination.beforeVersion }),
  });
  const query = new URLSearchParams({
    targetType: parsed.targetType,
    targetId: String(parsed.targetId),
    limit: String(parsed.limit),
  });
  if (parsed.beforeVersion !== undefined) {
    query.set("beforeVersion", String(parsed.beforeVersion));
  }
  return query;
}

export async function fetchResearchReports(
  target: ResearchTarget,
  pagination: { readonly limit?: number; readonly beforeVersion?: number } = {},
  signal?: AbortSignal,
) {
  const query = researchTargetQuery(target, {
    limit: pagination.limit ?? 50,
    ...(pagination.beforeVersion === undefined
      ? {}
      : { beforeVersion: pagination.beforeVersion }),
  });
  const payload = await localRequestJson(
    `/api/research/reports?${query.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load research report history",
    "TabHub returned unreadable research report history.",
  );
  const parsed = researchReportListResponseSchema.safeParse(payload);
  if (!parsed.success || !sameResearchTarget(parsed.data.target, target)) {
    throw new Error("TabHub returned mismatched research report history.");
  }
  return parsed.data;
}

export async function fetchResearchReport(
  reportId: number,
  expectedTarget: ResearchTarget,
  signal?: AbortSignal,
) {
  const id = researchReportIdParamsSchema.parse({ id: reportId }).id;
  const payload = await localRequestJson(
    `/api/research/reports/${encodeURIComponent(String(id))}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this research report",
    "TabHub returned an unreadable research report.",
  );
  const parsed = researchReportDetailSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== id ||
      !sameResearchTarget(parsed.data.target, expectedTarget)) {
    throw new Error("TabHub returned mismatched research report detail.");
  }
  return parsed.data;
}

export async function submitResearchRefinement(
  parentReportId: number,
  expectedTarget: ResearchTarget,
  input: ResearchRefineApprovalRequest,
  signal?: AbortSignal,
) {
  const id = researchReportIdParamsSchema.parse({ id: parentReportId }).id;
  const body = researchRefineApprovalRequestSchema.parse(input);
  if (!sameResearchTarget(body.target, expectedTarget)) {
    throw new Error("Research refinement target does not match its parent report.");
  }
  const payload = await localRequestJson(
    `/api/research/reports/${encodeURIComponent(String(id))}/refine`,
    jsonRequest(body, signal),
    "TabHub could not start this research refinement",
    "TabHub returned an unreadable research job.",
  );
  const parsed = durableJobRefSchema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "resource_research") {
    throw new Error("TabHub returned an unexpected research refinement job.");
  }
  return parsed.data;
}

export async function fetchResearchLatestRun(
  target: ResearchTarget,
  signal?: AbortSignal,
) {
  return (await fetchResearchReports(target, { limit: 1 }, signal)).latestRun;
}

export async function fetchResearchJob(jobId: DurableJobId, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/ai/jobs/${encodeURIComponent(jobId)}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read research progress",
    "TabHub returned unreadable research progress.",
  );
  const parsed = durableJobViewSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== jobId || parsed.data.kind !== "resource_research") {
    throw new Error("TabHub returned mismatched research progress.");
  }
  return parsed.data;
}

export async function cancelResearchJob(jobId: DurableJobId, signal?: AbortSignal) {
  const payload = await localRequestJson(
    `/api/ai/jobs/${encodeURIComponent(jobId)}/cancel`,
    { headers: { Accept: "application/json" }, method: "POST", signal: signal ?? null },
    "TabHub could not cancel this research run",
    "TabHub returned unreadable research progress.",
  );
  const parsed = durableJobViewSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== jobId || parsed.data.kind !== "resource_research") {
    throw new Error("TabHub returned mismatched research progress.");
  }
  return parsed.data;
}

export interface ResourceListFilters {
  browser: string;
  importance: "all" | TabImportance;
  page?: number;
  pageSize?: number;
  q: string;
  status: "all" | TabStatus;
  tag: string;
  priorityMode?: PriorityMode;
  needsReview?: boolean;
}

export async function fetchResources(
  filters: ResourceListFilters,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    page: String(filters.page ?? 1),
    pageSize: String(filters.pageSize ?? 100),
    sort_by: "name",
    sort_direction: "asc",
  });
  if (filters.browser !== "all") query.set("browser", filters.browser);
  if (filters.importance !== "all") query.set("importance", String(filters.importance));
  if (filters.q) query.set("q", filters.q);
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.tag) query.set("tag", filters.tag);
  if (filters.priorityMode !== undefined) query.set("priority_mode", filters.priorityMode);
  if (filters.needsReview !== undefined) query.set("needs_review", String(filters.needsReview));
  const payload = await requestJson(
    `/api/resources?${query.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load resources",
    "TabHub returned an unreadable resource list.",
  );
  const parsed = resourceListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected resource list.");
  return parsed.data;
}

export async function fetchResourceDetail(resourceId: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/resources/${resourceId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this resource",
    "TabHub returned unreadable resource details.",
  );
  const parsed = resourceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected resource details.");
  return parsed.data;
}

export async function fetchResourceActivity(
  resourceId: number,
  window: ActivityWindow,
  signal?: AbortSignal,
) {
  const validatedWindow = activityWindowSchema.parse(window);
  const payload = await requestJson(
    `/api/resources/${resourceId}/activity?window=${validatedWindow}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load resource activity",
    "TabHub returned unreadable resource activity.",
  );
  const parsed = resourceActivityResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.resourceId !== resourceId ||
    parsed.data.activity.window !== validatedWindow
  ) {
    throw new Error("TabHub returned unexpected resource activity.");
  }
  return parsed.data;
}

export async function fetchResourceReviewQueue(
  page = 1,
  pageSize = 50,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/resources/review-queue?resolution=unmatched_or_ambiguous&page=${page}&pageSize=${pageSize}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the resource review queue",
    "TabHub returned an unreadable resource review queue.",
  );
  const parsed = resourceReviewQueueResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected resource review queue.");
  return parsed.data;
}

export async function changeResource(command: LocalResourceCommand, signal?: AbortSignal) {
  const validated = localResourceCommandSchema.parse(command);
  const payload = await localRequestJson(
    "/api/resources/commands",
    jsonRequest(validated, signal),
    "TabHub could not update this resource",
    "TabHub returned an unreadable resource update.",
  );
  const parsed = resourceCommandReceiptSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected resource update.");
  return parsed.data;
}

export async function setResourceUserEvaluation(
  resourceId: number,
  evaluation: 1 | 2 | 3 | null,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  const body = resourceUserEvaluationRequestSchema.parse({ evaluation, idempotencyKey });
  const payload = await localRequestJson(
    `/api/resources/${resourceId}/user-evaluation`,
    { ...jsonRequest(body, signal), method: "PUT" },
    "TabHub could not save your resource evaluation",
    "TabHub returned an unreadable resource evaluation.",
  );
  const parsed = resourceCommandReceiptSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected resource evaluation.");
  return parsed.data;
}

export async function fetchLocalResourceContext(resourceId: number, signal?: AbortSignal) {
  const payload = await localRequestJson(
    `/api/local/resources/${resourceId}/context`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load resource context",
    "TabHub returned unreadable resource context.",
  );
  const parsed = localResourceContextViewSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected resource context.");
  return parsed.data;
}

export async function appendResourceContext(
  resourceId: number,
  input: {
    entryKind: "note" | "next_action";
    body: string;
    visibility: "local_only" | "share_with_ai";
    idempotencyKey: string;
  },
  signal?: AbortSignal,
) {
  const payload = await localRequestJson(
    `/api/resources/${resourceId}/context`,
    jsonRequest({ kind: "append", staleAt: null, ...input }, signal),
    "TabHub could not save resource context",
    "TabHub returned an unreadable resource-context update.",
  );
  const parsed = contextChangeResultSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected resource-context update.");
  return parsed.data;
}

export async function fetchLocalPageContext(tabId: number, signal?: AbortSignal) {
  const payload = await localRequestJson(
    `/api/local/tabs/${tabId}/context`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load personal context",
    "TabHub returned unreadable personal context.",
  );
  const parsed = localPageContextViewSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected personal context.");
  return parsed.data;
}

export async function changeLocalPageContext(
  logicalPageId: number,
  command: LocalContextCommand,
  signal?: AbortSignal,
) {
  const validated = localContextCommandSchema.parse(command);
  const payload = await localRequestJson(
    `/api/local/pages/${logicalPageId}/context/commands`,
    jsonRequest(validated, signal),
    "TabHub could not update personal context",
    "TabHub returned an unreadable personal-context update.",
  );
  const parsed = contextChangeResultSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected personal-context update.");
  return parsed.data;
}

export async function fetchLocalSessionIntents(
  scope: ExactTabScope,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    browserSessionId: scope.browserSessionId,
    browserTabId: String(scope.browserTabId),
    installationId: scope.installationId,
  });
  const payload = await localRequestJson(
    `/api/local/session-intents?${query.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the open-tab intent",
    "TabHub returned an unreadable open-tab intent.",
  );
  const parsed = sessionIntentBundleSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected open-tab intent.");
  return parsed.data;
}

export async function changeLocalSessionIntent(
  command: LocalSessionIntentCommand,
  signal?: AbortSignal,
) {
  const validated = localSessionIntentCommandSchema.parse(command);
  const payload = await localRequestJson(
    "/api/local/session-intents/commands",
    jsonRequest(validated, signal),
    "TabHub could not update the open-tab intent",
    "TabHub returned an unreadable open-tab intent update.",
  );
  const parsed = sessionIntentChangeResultSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected open-tab intent update.");
  return parsed.data;
}

export async function createLocalPairingChallenge(
  input: { extensionOrigin: string; installationId: string },
  signal?: AbortSignal,
) {
  const validated = localPairingChallengeRequestSchema.parse(input);
  const payload = await localRequestJson(
    "/api/local/pairing/challenges",
    jsonRequest(validated, signal),
    "TabHub could not start browser pairing",
    "TabHub returned an unreadable pairing challenge.",
  );
  const parsed = localPairingChallengeResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected pairing challenge.");
  return parsed.data;
}

export function isRelayedTabCommandOutcomeUnknown(
  error: unknown,
): error is TabCommandRelayClientError {
  return (
    error instanceof TabCommandRelayClientError && error.outcome === "unknown"
  );
}

function unknownRelayOutcomeError(
  message: string,
  code: TabCommandRelayErrorCode = "INVALID_COMMAND_RECEIPT",
): TabCommandRelayClientError {
  return new TabCommandRelayClientError(message, {
    code,
    outcome: "unknown",
  });
}

function hasExactRelayTargetPartition(
  targets: readonly { tabId: number }[],
  result: {
    failed: readonly { tabId: number }[];
    requested: number;
    skipped: readonly { tabId: number }[];
    succeededTabIds: readonly number[];
  },
): boolean {
  if (result.requested !== targets.length) return false;
  const expectedIds = new Set(targets.map(({ tabId }) => tabId));
  const actualIds = [
    ...result.succeededTabIds,
    ...result.skipped.map(({ tabId }) => tabId),
    ...result.failed.map(({ tabId }) => tabId),
  ];
  return (
    actualIds.length === targets.length &&
    new Set(actualIds).size === actualIds.length &&
    actualIds.every((tabId) => expectedIds.has(tabId))
  );
}

function isCorrelatedRelayResult(
  command: TabCommandRelayHttpRequest["command"],
  result: TabCommandRelayResult,
): boolean {
  switch (command.kind) {
    case "get-browser-state":
      return result.kind === "get-browser-state";
    case "capture-tab-content":
      return (
        result.kind === "capture-tab-content" &&
        result.target.instanceId === command.target.instanceId &&
        result.target.tabId === command.target.tabId &&
        result.target.expectedUrl === command.target.expectedUrl &&
        result.target.expectedInstanceRevision ===
          command.target.expectedInstanceRevision &&
        result.target.expectedFirstSeenAt ===
          command.target.expectedFirstSeenAt &&
        (result.outcome.status === "failed" ||
          (result.outcome.receipt.instanceId === command.target.instanceId &&
            result.outcome.receipt.browserTabId === command.target.tabId &&
            result.outcome.receipt.capturedUrl === command.target.expectedUrl &&
            result.outcome.receipt.instanceRevision ===
              command.target.expectedInstanceRevision &&
            result.outcome.receipt.firstSeenAt ===
              command.target.expectedFirstSeenAt))
      );
    case "activate-tab":
      return result.kind === "activate-tab" && result.tabId === command.tabId;
    case "close-preview":
      return (
        result.kind === "close-preview" &&
        hasExactRelayTargetPartition(command.targets, {
          failed: [],
          requested: result.requested,
          skipped: result.skipped,
          succeededTabIds: result.candidateTabIds,
        })
      );
    case "close":
      return result.kind === "close";
    case "undo-close":
      return result.kind === "undo-close";
    case "set-pinned":
      return (
        result.kind === "set-pinned" &&
        hasExactRelayTargetPartition(command.targets, result)
      );
    case "set-muted":
      return (
        result.kind === "set-muted" &&
        hasExactRelayTargetPartition(command.targets, result)
      );
    case "discard":
      return (
        result.kind === "discard" &&
        hasExactRelayTargetPartition(command.targets, result)
      );
    case "reload":
      return (
        result.kind === "reload" &&
        hasExactRelayTargetPartition(command.targets, result)
      );
    case "move":
      return (
        result.kind === "move" &&
        hasExactRelayTargetPartition(command.targets, result) &&
        (command.destination.kind !== "window" ||
          result.destinationWindowId === undefined ||
          result.destinationWindowId === command.destination.windowId)
      );
    case "open-workspace": {
      if (result.kind !== "open-workspace") return false;
      const failedIndices = result.failed.map(({ index }) => index);
      return (
        result.requested === command.tabs.length &&
        result.openedTabIds.length <= command.tabs.length &&
        new Set(result.openedTabIds).size === result.openedTabIds.length &&
        new Set(failedIndices).size === failedIndices.length &&
        failedIndices.every((index) => index < command.tabs.length) &&
        result.openedTabIds.length + failedIndices.length >= command.tabs.length
      );
    }
  }
}

function appendLibraryTabFilters(
  searchParams: URLSearchParams,
  filters: LibraryTabFilters,
  includePriorityMode = true,
): void {
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }

  if (filters.duplicatesOnly) {
    searchParams.set("duplicates_only", "true");
  }

  if (filters.openState !== "all") {
    searchParams.set("is_open", String(filters.openState === "open"));
  }

  if (filters.status !== "all") {
    searchParams.set("status", filters.status);
  }

  if (filters.importance !== "all") {
    searchParams.set("importance", String(filters.importance));
  }

  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  if (filters.tag) {
    searchParams.set("tag", filters.tag);
  }

  if (filters.resourceId !== undefined) {
    searchParams.set("resource_id", String(filters.resourceId));
  }

  if (includePriorityMode && filters.priorityMode !== undefined) {
    searchParams.set("priority_mode", filters.priorityMode);
  }

  if (filters.needsReview !== undefined) {
    searchParams.set("needs_review", String(filters.needsReview));
  }
}

async function responsePayload(response: Response, unreadableMessage: string) {
  if (response.status === 204) return null;

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(unreadableMessage);
  }
}

async function responseError(response: Response, fallbackMessage: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiRequestError(fallbackMessage, undefined, response.status);
  }

  const responseCode =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : undefined;
  const responseMessage =
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
      ? payload.message
      : fallbackMessage;
  const rawSpan = typeof payload === "object" && payload !== null && "span" in payload
    ? payload.span : undefined;
  const span = typeof rawSpan === "object" && rawSpan !== null &&
      "start" in rawSpan && typeof rawSpan.start === "number" &&
      Number.isInteger(rawSpan.start) && rawSpan.start >= 0 &&
      "end" in rawSpan && typeof rawSpan.end === "number" &&
      Number.isInteger(rawSpan.end) && rawSpan.end > rawSpan.start
    ? { start: rawSpan.start, end: rawSpan.end }
    : undefined;
  const liveAcquisitionBudget = response.status === 429 && responseCode === "JOB_BUDGET_EXHAUSTED" &&
      typeof payload === "object" && payload !== null &&
      "dailyStartsRemaining" in payload && payload.dailyStartsRemaining === 0 &&
      "dailyStartsResetAt" in payload && typeof payload.dailyStartsResetAt === "string" &&
      !Number.isNaN(Date.parse(payload.dailyStartsResetAt))
    ? { dailyStartsRemaining: 0 as const, dailyStartsResetAt: payload.dailyStartsResetAt }
    : undefined;

  return new ApiRequestError(responseMessage, responseCode, response.status, span,
    liveAcquisitionBudget);
}

async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit,
  errorMessage: string,
  unreadableMessage: string,
) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await responseError(response, `${errorMessage} (${response.status}).`);
  }

  return responsePayload(response, unreadableMessage);
}

export async function fetchTabs(
  filters: TabListFilters,
  signal?: AbortSignal,
  access: "public" | "local" = "public",
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: "50",
  });
  if (filters.sortBy !== undefined) {
    searchParams.set("sort_by", filters.sortBy);
    if (filters.sortDirection !== undefined) {
      searchParams.set("sort_direction", filters.sortDirection);
    }
  }
  appendLibraryTabFilters(searchParams, filters);

  const path = `${access === "local" ? "/api/local/tabs" : "/api/tabs"}?${searchParams.toString()}`;
  const payload = await (access === "local" ? localRequestJson : requestJson)(
    path,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load tabs",
    "TabHub returned an unreadable tab list.",
  );
  const parsed = (access === "local"
    ? localTabListResponseSchema
    : tabListResponseSchema
  ).safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tab list.");
  }

  return parsed.data;
}

export async function fetchRetentionReview(
  page: number,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(page),
    pageSize: "50",
  });
  const payload = await requestJson(
    `/api/retention/review?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load pages suggested for review",
    "TabHub returned an unreadable retention review queue.",
  );
  const parsed = retentionReviewResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected retention review queue.");
  }
  return parsed.data;
}

export async function fetchRetentionTrash(
  page: number,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(page),
    pageSize: "50",
  });
  const payload = await requestJson(
    `/api/retention/trash?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load retention trash",
    "TabHub returned unreadable retention trash.",
  );
  const parsed = retentionTrashResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected retention trash.");
  }
  return parsed.data;
}

export async function setRetentionDecision(
  tabId: number,
  decision: Exclude<RetentionDecision, "trash">,
) {
  const payload = await requestJson(
    `/api/retention/tabs/${tabId}`,
    {
      body: JSON.stringify({ decision, decidedBy: "user" }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "PATCH",
    },
    "TabHub could not save this retention decision",
    "TabHub returned an unreadable retention decision.",
  );
  const parsed = retentionDecisionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected retention decision.");
  }
  return parsed.data;
}

export async function forgetRetentionTab(tabId: number) {
  const payload = await requestJson(
    `/api/retention/tabs/${tabId}/forget`,
    {
      body: JSON.stringify({ decidedBy: "user", confirmed: true }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    "TabHub could not close and forget this page",
    "TabHub returned an unreadable close-and-forget result.",
  );
  const parsed = retentionForgetResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected close-and-forget result.");
  }
  return parsed.data;
}

export async function restoreRetentionTab(tabId: number) {
  const payload = await requestJson(
    `/api/retention/trash/${tabId}/restore`,
    {
      body: JSON.stringify({ decidedBy: "user" }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    "TabHub could not restore this page",
    "TabHub returned an unreadable restore result.",
  );
  const parsed = retentionDecisionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected restore result.");
  }
  return parsed.data;
}

export async function fetchAllLibraryTabSelection(
  filters: LibraryTabFilters,
  signal?: AbortSignal,
  access: "public" | "local" = "public",
) {
  const searchParams = new URLSearchParams();
  appendLibraryTabFilters(searchParams, filters, false);
  const query = searchParams.toString();
  const path = `${access === "local" ? "/api/local/tabs/bulk-ids" : "/api/tabs/bulk-ids"}${query ? `?${query}` : ""}`;
  const payload = await (access === "local" ? localRequestJson : requestJson)(
    path,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load all filtered Library tabs",
    "TabHub returned an unreadable Library tab selection.",
  );
  const parsed = tabBulkIdsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected Library tab selection.");
  }
  return parsed.data;
}

export async function fetchAllLibraryTabIds(
  filters: LibraryTabFilters,
  signal?: AbortSignal,
  access: "public" | "local" = "public",
) {
  const selection = await fetchAllLibraryTabSelection(filters, signal, access);
  return Object.defineProperty(selection.ids, "logicalPageCount", {
    configurable: false,
    enumerable: false,
    value: selection.logicalPageCount,
  }) as number[] & { readonly logicalPageCount: number };
}

export async function fetchLibraryOpenTabSelection(
  filters: LibraryTabFilters,
  signal?: AbortSignal,
  access: "public" | "local" = "public",
) {
  const searchParams = new URLSearchParams();
  appendLibraryTabFilters(searchParams, filters, false);
  const query = searchParams.toString();
  const path = `${access === "local" ? "/api/local/tab-instances/library-bulk" : "/api/tab-instances/library-bulk"}${query ? `?${query}` : ""}`;
  const payload = await (access === "local" ? localRequestJson : requestJson)(
    path,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load the Library's open physical tabs",
    "TabHub returned an unreadable Library open-tab selection.",
  );
  const parsed = tabInstanceBulkResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected Library open-tab selection.");
  }
  return parsed.data;
}

export async function fetchLibraryOpenTabs(
  filters: LibraryTabFilters,
  signal?: AbortSignal,
  access: "public" | "local" = "public",
) {
  const selection = await fetchLibraryOpenTabSelection(filters, signal, access);
  return Object.defineProperty(selection.items, "logicalPageCount", {
    configurable: false,
    enumerable: false,
    value: selection.logicalPageCount,
  }) as typeof selection.items & { readonly logicalPageCount: number };
}

export async function fetchAllOpenTabs(
  filters: Omit<OpenTabListFilters, "page" | "pageSize">,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams();
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.duplicatesOnly) {
    searchParams.set("duplicates_only", "true");
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const query = searchParams.toString();
  const payload = await requestJson(
    `/api/tab-instances/bulk${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load all open tabs",
    "TabHub returned an unreadable bulk open-tab list.",
  );
  const parsed = tabInstanceBulkResponseSchema.safeParse(
    payload !== null && typeof payload === "object" &&
      !("logicalPageCount" in payload)
      ? { ...payload, logicalPageCount: 0 }
      : payload,
  );
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected bulk open-tab list.");
  }

  return parsed.data.items;
}

export async function fetchCanonicalTabInstances(
  canonicalTabId: number,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/tabs/${canonicalTabId}/instances`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not resolve this open tab",
    "TabHub returned an unreadable open-tab target.",
  );
  const parsed = tabInstanceBulkResponseSchema.safeParse(
    payload !== null && typeof payload === "object" &&
      !("logicalPageCount" in payload)
      ? { ...payload, logicalPageCount: 0 }
      : payload,
  );
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected open-tab target.");
  }
  if (
    parsed.data.items.some(
      (instance) => instance.canonicalTabId !== canonicalTabId,
    )
  ) {
    throw new Error("TabHub returned an open-tab target for a different Library page.");
  }

  return parsed.data.items;
}

export async function fetchResourceOpenTabs(
  resourceId: number,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/tab-instances/bulk?resource_id=${encodeURIComponent(String(resourceId))}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this resource's open pages",
    "TabHub returned unreadable open pages for this resource.",
  );
  const parsed = tabInstanceBulkResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected open pages for this resource.");
  }
  return parsed.data.items;
}

export async function fetchAllDuplicateGroups(
  filters: Omit<DuplicateGroupListFilters, "page">,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams();
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }
  const query = searchParams.toString();
  const payload = await requestJson(
    `/api/duplicate-groups/bulk${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load every exact duplicate group",
    "TabHub returned an unreadable bulk duplicate-group list.",
  );
  const parsed = duplicateGroupBulkResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected bulk duplicate-group list.");
  }
  return parsed.data.items;
}

export async function fetchOpenTabs(
  filters: OpenTabListFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize ?? 50),
  });

  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.duplicatesOnly) {
    searchParams.set("duplicates_only", "true");
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const payload = await requestJson(
    `/api/tab-instances?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load open tabs",
    "TabHub returned an unreadable open-tab list.",
  );
  const parsed = tabInstanceListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected open-tab list.");
  }

  return parsed.data;
}

export async function fetchDuplicateGroups(
  filters: DuplicateGroupListFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: "50",
  });
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const payload = await requestJson(
    `/api/duplicate-groups?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load exact duplicate groups",
    "TabHub returned an unreadable duplicate-group list.",
  );
  const parsed = duplicateGroupListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected duplicate-group list.");
  }

  return parsed.data;
}

export async function fetchConnectedTabCommandScopes(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/tab-command-relay/scopes",
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not read connected browser sessions",
    "TabHub returned unreadable connected browser sessions.",
  );
  const parsed = tabCommandRelayConnectedScopesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected connected browser sessions.");
  }
  return parsed.data.items;
}

export async function executeRelayedTabCommand(
  request: TabCommandRelayHttpRequest,
  signal?: AbortSignal,
): Promise<TabCommandRelayResult> {
  const validatedRequest = tabCommandRelayHttpRequestSchema.safeParse(request);
  if (!validatedRequest.success) {
    throw new Error("Invalid addressed browser command.");
  }

  let response: Response;
  try {
    response = await fetch("/api/tab-command-relay/commands", {
      body: JSON.stringify(validatedRequest.data),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: signal ?? null,
    });
  } catch {
    throw unknownRelayOutcomeError(
      "TabHub could not confirm the browser-command result.",
      "EXTENSION_DISCONNECTED",
    );
  }
  let payload: unknown;
  try {
    payload = await responsePayload(
      response,
      "TabHub returned an unreadable browser-command result.",
    );
  } catch {
    throw unknownRelayOutcomeError(
      "TabHub returned an unreadable browser-command result.",
    );
  }
  const parsed = tabCommandRelayHttpResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw unknownRelayOutcomeError(
      "TabHub returned an unexpected browser-command result.",
    );
  }
  if (!parsed.data.ok) {
    throw new TabCommandRelayClientError(parsed.data.message, {
      code: parsed.data.error,
      outcome: parsed.data.outcome,
    });
  }
  if (!response.ok) {
    throw unknownRelayOutcomeError(
      `TabHub returned a successful browser-command result with HTTP ${response.status}.`,
    );
  }
  if (
    parsed.data.scope.browser !== validatedRequest.data.browser ||
    parsed.data.scope.browserSessionId !==
      validatedRequest.data.browserSessionId ||
    parsed.data.scope.installationId !== validatedRequest.data.installationId
  ) {
    throw unknownRelayOutcomeError(
      "TabHub returned a browser-command receipt for a different browser session.",
    );
  }
  if (
    !isCorrelatedRelayResult(
      validatedRequest.data.command,
      parsed.data.result,
    )
  ) {
    throw unknownRelayOutcomeError(
      "TabHub returned a result that does not match the browser command.",
    );
  }
  return parsed.data.result;
}

export async function fetchWorkspaces(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/workspaces",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load saved workspaces",
    "TabHub returned unreadable saved workspaces.",
  );
  const parsed = workspaceListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected saved workspaces.");
  return parsed.data;
}

export async function fetchWorkspace(id: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/workspaces/${id}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function createWorkspace(input: CreateWorkspace) {
  const payload = await requestJson(
    "/api/workspaces",
    {
      body: JSON.stringify(input),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    },
    "TabHub could not save this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function renameWorkspace(id: number, name: string) {
  const payload = await requestJson(
    `/api/workspaces/${id}`,
    {
      body: JSON.stringify({ name }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "PATCH",
    },
    "TabHub could not rename this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function deleteWorkspace(id: number) {
  await requestJson(
    `/api/workspaces/${id}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    "TabHub could not delete this workspace",
    "TabHub returned an unreadable deletion result.",
  );
}

export async function fetchTagTree(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/tags",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load tags",
    "TabHub returned an unreadable tag tree.",
  );
  const parsed = tagTreeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag tree.");
  }

  return parsed.data;
}

export async function createTopic(input: CreateTopicInput) {
  const payload = await requestJson(
    "/api/tags",
    {
      body: JSON.stringify(input),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    },
    "TabHub could not create this topic",
    "TabHub returned an unreadable topic.",
  );
  const parsed = tagRecordSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected topic.");
  }
  return parsed.data;
}

export async function updateTopic(id: number, input: UpdateTopicInput) {
  const payload = await requestJson(
    `/api/tags/${id}`,
    {
      body: JSON.stringify(input),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "PATCH",
    },
    "TabHub could not update this topic",
    "TabHub returned an unreadable topic update.",
  );
  const parsed = tagRecordSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected topic update.");
  }
  return parsed.data;
}

export async function deleteTopic(id: number) {
  const payload = await requestJson(
    `/api/tags/${id}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    "TabHub could not delete this topic",
    "TabHub returned an unreadable topic deletion.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected topic deletion.");
  }
  return parsed.data;
}

export async function fetchGraph(rootTag: string, signal?: AbortSignal) {
  const searchParams = new URLSearchParams();
  if (rootTag) searchParams.set("root_tag", rootTag);
  const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  const payload = await requestJson(
    `/api/graph${query}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the graph",
    "TabHub returned an unreadable graph.",
  );
  const parsed = graphResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected graph.");
  }

  return parsed.data;
}

export async function fetchKnowledgeGraph(
  rootTopicId: number | null,
  signal?: AbortSignal,
  focus?: KnowledgeGraphFocus,
) {
  const searchParams = new URLSearchParams();
  if (rootTopicId !== null) {
    searchParams.set("root_topic_id", String(rootTopicId));
  }
  if (focus !== undefined) {
    searchParams.set("focus_node_type", focus.node.type);
    searchParams.set("focus_node_id", String(focus.node.id));
    searchParams.set("focus_depth", String(focus.depth));
  }
  const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  const payload = await requestJson(
    `/api/graph/v2${query}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the knowledge graph",
    "TabHub returned an unreadable knowledge graph.",
  );
  const parsed = graphV2ResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected knowledge graph.");
  }
  return parsed.data;
}

export async function createRelation(input: CreateRelationInput) {
  const payload = await requestJson(
    "/api/relations",
    {
      body: JSON.stringify(input),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    },
    "TabHub could not create this relation",
    "TabHub returned an unreadable relation.",
  );
  const parsed = knowledgeRelationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected relation.");
  }
  return parsed.data;
}

export async function deleteRelation(id: number) {
  const payload = await requestJson(
    `/api/relations/${id}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    "TabHub could not delete this relation",
    "TabHub returned an unreadable relation deletion.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected relation deletion.");
  }
  return parsed.data;
}

export async function fetchTabDetail(tabId: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/tabs/${tabId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this tab",
    "TabHub returned unreadable tab details.",
  );
  const parsed = tabDetailResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected tab details.");
  }

  return parsed.data;
}

export async function fetchLogicalPageByTabId(
  tabId: number,
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/logical-pages/by-tab/${tabId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this page's importance",
    "TabHub returned unreadable logical page details.",
  );
  const parsed = logicalPageViewSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected logical page details.");
  }

  return parsed.data;
}

export async function setUserImportance(
  ids: number[],
  importance: TabImportance,
) {
  const payload = await requestJson(
    "/api/tabs/importance",
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids, importance }),
    },
    "TabHub could not update this page's importance",
    "TabHub returned an unreadable importance update.",
  );
  const parsed = setImportanceResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected importance update.");
  }

  return parsed.data;
}

export async function patchTabDetails(tabId: number, patch: PatchTabDetails) {
  const payload = await requestJson(
    `/api/tabs/${tabId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
    "TabHub could not update this tab",
    "TabHub returned an unreadable tab update.",
  );
  const parsed = tabDetailResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tab update.");
  }

  return parsed.data;
}

export async function updateTabStatuses(ids: number[], status: TabStatus) {
  const payload = await requestJson(
    "/api/tabs/status",
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids, status }),
    },
    "TabHub could not update the selected tabs",
    "TabHub returned an unreadable bulk update.",
  );
  const parsed = setStatusResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected bulk update.");
  }

  return parsed.data;
}

export async function assignTag(ids: number[], tagPath: string) {
  const payload = await requestJson(
    "/api/tags/assign",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids, tagPath, assignedBy: "user" }),
    },
    "TabHub could not assign this tag",
    "TabHub returned an unreadable tag update.",
  );
  const parsed = assignTagsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag update.");
  }

  return parsed.data;
}

export async function unassignTag(tabId: number, tagId: number) {
  const payload = await requestJson(
    `/api/tabs/${tabId}/tags/${tagId}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
    "TabHub could not remove this tag",
    "TabHub returned an unreadable tag removal.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag removal.");
  }

  return parsed.data;
}

export async function fetchLinks(tabId: number, signal?: AbortSignal) {
  const searchParams = new URLSearchParams({ tab_id: String(tabId) });
  const payload = await requestJson(
    `/api/links?${searchParams.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load links",
    "TabHub returned unreadable links.",
  );
  const parsed = linkListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected links.");
  }

  return parsed.data;
}

export async function createLink(link: CreateTabLink) {
  const payload = await requestJson(
    "/api/links",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(link),
    },
    "TabHub could not create this link",
    "TabHub returned an unreadable link.",
  );
  const parsed = tabLinkSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link.");
  }

  return parsed.data;
}

export async function patchLink(linkId: number, patch: PatchTabLink) {
  const payload = await requestJson(
    `/api/links/${linkId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
    "TabHub could not update this link",
    "TabHub returned an unreadable link update.",
  );
  const parsed = tabLinkSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link update.");
  }

  return parsed.data;
}

export async function deleteLink(linkId: number) {
  const payload = await requestJson(
    `/api/links/${linkId}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
    "TabHub could not delete this link",
    "TabHub returned an unreadable link deletion.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link deletion.");
  }

  return parsed.data;
}

export async function enqueueSummary(
  tabId: number,
  input: {
    depth: SummaryDepth;
    expectedContentRevision: number;
  },
  signal?: AbortSignal,
) {
  const payload = await requestJson(
    `/api/tabs/${tabId}/summarize`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: signal ?? null,
    },
    "TabHub could not queue this summary",
    "TabHub returned an unreadable summary response.",
  );
  const parsed = summaryEnqueueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary response.");
  }

  return parsed.data;
}

export async function enqueueShortSummary(tabId: number) {
  const payload = await requestJson(
    `/api/tabs/${tabId}/summarize`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ depth: "short" }),
    },
    "TabHub could not queue this summary",
    "TabHub returned an unreadable summary response.",
  );
  const parsed = summaryEnqueueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary response.");
  }

  return parsed.data;
}

export async function fetchSummaryJob(jobId: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/jobs/${jobId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read this summary job",
    "TabHub returned an unreadable summary job.",
  );
  const parsed = summaryJobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary job.");
  }

  return parsed.data;
}
