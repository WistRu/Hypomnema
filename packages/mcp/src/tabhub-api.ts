import {
  agentContextAppendCommandSchema,
  agentContextMutationReceiptSchema,
  agentResearchCancelRequestSchema,
  agentResearchReportDetailSchema,
  agentResearchStartRequestSchema,
  agentResearchStartResponseSchema,
  agentPriorityFeedbackRequestSchema,
  agentPriorityRecomputeRequestSchema,
  agentResourceUserEvaluationRequestSchema,
  agentUserImportanceRequestSchema,
  agentUserImportanceResponseSchema,
  agentSessionIntentMutationReceiptSchema,
  agentSessionIntentSetCommandSchema,
  activityWindowSchema,
  assignTagsResponseSchema,
  clusterInboxResponseSchema,
  contextSearchQuerySchema,
  exactTabScopeSchema,
  featureFlagsResponseSchema,
  durableJobIdSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  logicalPageParamSchema,
  prioritySubjectSchema,
  retentionDecisionResponseSchema,
  retentionForgetResponseSchema,
  retentionReviewResponseSchema,
  retentionTrashResponseSchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceIdParamSchema,
  resourceListQuerySchema,
  resourceListResponseSchema,
  resourcePagesQuerySchema,
  resourcePagesResponseSchema,
  researchJobIdSchema,
  researchReportIdParamsSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  setImportanceResponseSchema,
  setStatusResponseSchema,
  shareableContextBundleSchema,
  shareableContextEntrySchema,
  shareableSessionIntentBundleSchema,
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  statsResponseSchema,
  tabDetailResponseSchema,
  tabLinkSchema,
  tabListResponseSchema,
  tagTreeResponseSchema,
  type AssignTagsResponse,
  type AgentContextAppendCommand,
  type AgentResearchCancelRequest,
  type AgentResearchReportDetail,
  type AgentResearchStartRequest,
  type AgentResearchStartResponse,
  type AgentUserImportanceRequest,
  type AgentUserImportanceResponse,
  type AgentSessionIntentSetCommand,
  type ActivityWindow,
  type ClusterInboxResponse,
  type ExactTabScope,
  type FeatureFlagsResponse,
  type DurableJobId,
  type DurableJobRef,
  type DurableJobView,
  type PriorityFeedbackReceipt,
  type PrioritySafeRead,
  type PrioritySubjectContract,
  type RetentionDecisionResponse,
  type RetentionForgetResponse,
  type RetentionReviewResponse,
  type RetentionTrashResponse,
  type ResourceAccessClass,
  type ResourceDetail,
  type ResourceKind,
  type ResourceLifecycleState,
  type ResourceListResponse,
  type ResourcePagesResponse,
  type ResearchReportListQuery,
  type ResearchReportListResponse,
  type SearchMode,
  type SetImportanceResponse,
  type SetStatusResponse,
  type ShareableContextBundle,
  type ShareableContextEntry,
  type ShareableSessionIntentBundle,
  type SummaryDepth,
  type SummaryEnqueueResponse,
  type SummaryJob,
  type StatsResponse,
  type TabDetailResponse,
  type TabImportance,
  type TabLink,
  type TabListResponse,
  type TabStatus,
  type TagTreeResponse,
} from "@tabhub/shared";

import {
  parseMcpPriorityFeedbackReceipt,
  parseMcpPrioritySafeRead,
} from "./priority-projection.js";

export type AgentContextMutationReceipt = ReturnType<
  typeof agentContextMutationReceiptSchema.parse
>;
export type AgentSessionIntentMutationReceipt = ReturnType<
  typeof agentSessionIntentMutationReceiptSchema.parse
>;
export type ResourceActivityResponse = ReturnType<
  typeof resourceActivityResponseSchema.parse
>;
export type AgentResearchStartInput = Omit<
  AgentResearchStartRequest,
  "confirmedOrigins"
> & {
  confirmedOrigins?: AgentResearchStartRequest["confirmedOrigins"];
};

export interface ListTabsInput {
  browser?: string;
  status?: TabStatus;
  importance?: TabImportance;
  isOpen?: boolean;
  tag?: string;
  q?: string;
  searchMode?: SearchMode;
  similarTo?: number;
  page: number;
  pageSize: number;
}

export interface RetentionPageInput {
  page: number;
  pageSize: number;
}

export interface SearchPageContextInput {
  logicalPageId: number;
  query: string;
  limit: number;
}

export interface SetPageContextInput {
  logicalPageId: number;
  command: AgentContextAppendCommand;
}

export interface ListResourcesInput {
  q?: string;
  kind?: ResourceKind;
  accessClass?: ResourceAccessClass;
  lifecycleState?: ResourceLifecycleState;
  browser?: string;
  status?: TabStatus;
  importance?: TabImportance;
  tag?: string;
  page: number;
  pageSize: number;
  sortBy?: "name" | "logical_pages" | "activity" | "updated_at";
  sortDirection?: "asc" | "desc";
}

export interface ListResourcePagesInput {
  resourceId: number;
  browser?: string;
  status?: TabStatus;
  importance?: TabImportance;
  tag?: string;
  page: number;
  pageSize: number;
}

export interface SetResourceContextInput {
  resourceId: number;
  command: AgentContextAppendCommand;
}

export interface SetResourceEvaluationInput {
  resourceId: number;
  evaluation: 1 | 2 | 3 | null;
  authorizationRef: string;
  idempotencyKey: string;
}

const recordPriorityFeedbackInputSchema = agentPriorityFeedbackRequestSchema
  .extend({ subject: prioritySubjectSchema })
  .strict();

export type RecordPriorityFeedbackInput = ReturnType<
  typeof recordPriorityFeedbackInputSchema.parse
>;

export type RecomputePriorityInput = ReturnType<
  typeof agentPriorityRecomputeRequestSchema.parse
>;

export interface TabHubApi {
  getFeatures(): Promise<FeatureFlagsResponse>;
  listResources(input: ListResourcesInput): Promise<ResourceListResponse>;
  getResource(resourceId: number): Promise<ResourceDetail>;
  listResourcePages(input: ListResourcePagesInput): Promise<ResourcePagesResponse>;
  getResourceActivity(
    resourceId: number,
    window?: ActivityWindow,
  ): Promise<ResourceActivityResponse>;
  getResourceContext(resourceId: number): Promise<ShareableContextBundle>;
  setResourceContext(
    input: SetResourceContextInput,
  ): Promise<AgentContextMutationReceipt>;
  setResourceEvaluation(
    input: SetResourceEvaluationInput,
  ): Promise<AgentUserImportanceResponse>;
  explainPriority(subject: PrioritySubjectContract): Promise<PrioritySafeRead>;
  recordPriorityFeedback(
    input: RecordPriorityFeedbackInput,
  ): Promise<PriorityFeedbackReceipt>;
  recomputePriority(input: RecomputePriorityInput): Promise<DurableJobRef>;
  getJobStatus(id: DurableJobId): Promise<DurableJobView>;
  startResearch(
    input: AgentResearchStartInput,
  ): Promise<AgentResearchStartResponse>;
  getAiJob(id: DurableJobId): Promise<DurableJobView>;
  cancelAiJob(
    id: DurableJobId,
    command: AgentResearchCancelRequest,
  ): Promise<DurableJobView>;
  listResearchReports(
    input: ResearchReportListQuery,
  ): Promise<ResearchReportListResponse>;
  getResearchReport(id: number): Promise<AgentResearchReportDetail>;
  setUserImportance(
    input: AgentUserImportanceRequest,
  ): Promise<AgentUserImportanceResponse>;
  getPageContext(logicalPageId: number): Promise<ShareableContextBundle>;
  searchPageContext(
    input: SearchPageContextInput,
  ): Promise<ShareableContextEntry[]>;
  setPageContext(input: SetPageContextInput): Promise<AgentContextMutationReceipt>;
  getTabSessionIntent(
    scope: ExactTabScope,
  ): Promise<ShareableSessionIntentBundle>;
  setTabSessionIntent(
    command: AgentSessionIntentSetCommand,
  ): Promise<AgentSessionIntentMutationReceipt>;
  reviewDisposablePages(
    input: RetentionPageInput,
  ): Promise<RetentionReviewResponse>;
  listRetentionTrash(
    input: RetentionPageInput,
  ): Promise<RetentionTrashResponse>;
  setRetentionDecision(input: {
    tabId: number;
    decision: "keep" | "later";
  }): Promise<RetentionDecisionResponse>;
  closeAndForgetPage(input: {
    tabId: number;
    confirmed: true;
  }): Promise<RetentionForgetResponse>;
  restoreRetentionPage(tabId: number): Promise<RetentionDecisionResponse>;
  listTabs(input: ListTabsInput): Promise<TabListResponse>;
  getTab(id: number): Promise<TabDetailResponse>;
  setStatus(input: {
    ids: number[];
    status: TabStatus;
  }): Promise<SetStatusResponse>;
  setImportance(input: {
    ids: number[];
    importance: TabImportance;
  }): Promise<SetImportanceResponse>;
  tagTabs(input: {
    ids: number[];
    tagPath: string;
  }): Promise<AssignTagsResponse>;
  linkTabs(input: {
    from: number;
    to: number;
    kind: string;
    note?: string | null;
  }): Promise<TabLink>;
  summarizeTab(id: number, depth: SummaryDepth): Promise<SummaryEnqueueResponse>;
  getSummaryJob(id: number): Promise<SummaryJob>;
  clusterInbox(maxClusters: number): Promise<ClusterInboxResponse>;
  listTags(): Promise<TagTreeResponse>;
  getStats(): Promise<StatsResponse>;
}

export interface TabHubApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

const serverErrorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const serverErrorMessagePattern =
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]{1,1024}$/u;

function serverErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return [record.code, record.error].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && serverErrorCodePattern.test(candidate),
  );
}

function serverErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const code = serverErrorCode(value);
  const rawMessage = record.message;
  const trimmedMessage = typeof rawMessage === "string" ? rawMessage.trim() : undefined;
  const message = trimmedMessage !== undefined &&
      serverErrorMessagePattern.test(trimmedMessage)
    ? trimmedMessage
    : undefined;

  if (code !== undefined && message !== undefined && message !== code) {
    return `${code}: ${message}`;
  }
  return code ?? message;
}

export function createTabHubApi(
  options: TabHubApiOptions = {},
): TabHubApi {
  const baseUrl = new URL(
    options.baseUrl ?? process.env.TABHUB_API_URL ?? "http://127.0.0.1:7717",
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: RequestInit,
    privacy: { errorCodeOnly?: boolean } = {},
  ): Promise<T> {
    const response = await fetchImpl(new URL(path, baseUrl).href, init);
    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      const detail = privacy.errorCodeOnly
        ? serverErrorCode(body)
        : serverErrorDetail(body);
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      );
    }

    try {
      return schema.parse(body);
    } catch {
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned an invalid response`,
      );
    }
  }

  async function getFeatures(): Promise<FeatureFlagsResponse> {
    const path = "/api/features";
    const response = await fetchImpl(new URL(path, baseUrl).href, {
      method: "GET",
    });

    // Schema 17 has no feature-discovery route. Only that exact compatibility
    // signal may expose the accepted feature-disabled MCP surface.
    if (response.status === 404) {
      return { context: false, logicalImportance: false };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `TabHub API GET ${path} returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      const detail = serverErrorDetail(body);
      throw new Error(
        `TabHub API GET ${path} returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      );
    }

    try {
      return featureFlagsResponseSchema.parse(body);
    } catch {
      throw new Error(`TabHub API GET ${path} returned an invalid response`);
    }
  }

  async function importanceMutationPath(): Promise<
    "/api/agent/tabs/importance" | "/api/tabs/importance"
  > {
    const features = await getFeatures();
    return features.logicalImportance
      ? "/api/agent/tabs/importance"
      : "/api/tabs/importance";
  }

  function prioritySubjectPath(
    subject: PrioritySubjectContract,
    suffix: "priority" | "priority-feedback",
    audience: "public" | "agent" = "public",
  ): string {
    if (subject.type === "page") {
      return audience === "agent"
        ? `/api/agent/logical-pages/${subject.logicalPageId}/${suffix}`
        : `/api/logical-pages/${subject.logicalPageId}/${suffix}`;
    }
    return audience === "agent"
      ? `/api/agent/resources/${subject.resourceId}/${suffix}`
      : `/api/resources/${subject.resourceId}/${suffix}`;
  }

  function samePrioritySubject(
    left: PrioritySubjectContract,
    right: PrioritySubjectContract,
  ): boolean {
    if (left.type === "page" && right.type === "page") {
      return left.logicalPageId === right.logicalPageId;
    }
    if (left.type === "resource" && right.type === "resource") {
      return left.resourceId === right.resourceId;
    }
    return false;
  }

  return {
    getFeatures,

    async listResources(input) {
      const query = resourceListQuerySchema.parse({
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.accessClass === undefined
          ? {}
          : { accessClass: input.accessClass }),
        ...(input.lifecycleState === undefined
          ? {}
          : { lifecycleState: input.lifecycleState }),
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.importance === undefined
          ? {}
          : { importance: input.importance }),
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        page: input.page,
        pageSize: input.pageSize,
        ...(input.sortBy === undefined ? {} : { sort_by: input.sortBy }),
        ...(input.sortDirection === undefined
          ? {}
          : { sort_direction: input.sortDirection }),
      });
      const searchParams = new URLSearchParams();
      if (query.q !== undefined) searchParams.set("q", query.q);
      if (query.kind !== undefined) searchParams.set("kind", query.kind);
      if (query.accessClass !== undefined) {
        searchParams.set("accessClass", query.accessClass);
      }
      searchParams.set("lifecycleState", query.lifecycleState);
      if (query.browser !== undefined) searchParams.set("browser", query.browser);
      if (query.status !== undefined) searchParams.set("status", query.status);
      if (query.importance !== undefined) {
        searchParams.set("importance", String(query.importance));
      }
      if (query.tag !== undefined) searchParams.set("tag", query.tag);
      searchParams.set("page", String(query.page));
      searchParams.set("pageSize", String(query.pageSize));
      searchParams.set("sort_by", query.sort_by);
      searchParams.set("sort_direction", query.sort_direction);
      return request(
        `/api/resources?${searchParams.toString()}`,
        resourceListResponseSchema,
        { method: "GET" },
      );
    },

    async getResource(resourceId) {
      const params = resourceIdParamSchema.parse({ id: resourceId });
      return request(`/api/resources/${params.id}`, resourceDetailSchema, {
        method: "GET",
      });
    },

    async listResourcePages(input) {
      const params = resourceIdParamSchema.parse({ id: input.resourceId });
      const query = resourcePagesQuerySchema.parse({
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.importance === undefined
          ? {}
          : { importance: input.importance }),
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        page: input.page,
        pageSize: input.pageSize,
      });
      const searchParams = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
      });
      if (query.browser !== undefined) searchParams.set("browser", query.browser);
      if (query.status !== undefined) searchParams.set("status", query.status);
      if (query.importance !== undefined) {
        searchParams.set("importance", String(query.importance));
      }
      if (query.tag !== undefined) searchParams.set("tag", query.tag);
      return request(
        `/api/resources/${params.id}/pages?${searchParams.toString()}`,
        resourcePagesResponseSchema,
        { method: "GET" },
      );
    },

    async getResourceActivity(resourceId, window = "all") {
      const params = resourceIdParamSchema.parse({ id: resourceId });
      const activityWindow = activityWindowSchema.parse(window);
      const path =
        `/api/resources/${params.id}/activity?window=${activityWindow}`;
      const response = await request(
        path,
        resourceActivityResponseSchema,
        { method: "GET" },
      );
      if (
        response.resourceId !== params.id ||
        response.activity.window !== activityWindow
      ) {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return response;
    },

    async getResourceContext(resourceId) {
      const params = resourceIdParamSchema.parse({ id: resourceId });
      return request(
        `/api/agent/resources/${params.id}/context`,
        shareableContextBundleSchema,
        { method: "GET" },
      );
    },

    async setResourceContext(input) {
      const params = resourceIdParamSchema.parse({ id: input.resourceId });
      const command = agentContextAppendCommandSchema.parse(input.command);
      return request(
        `/api/agent/resources/${params.id}/context`,
        agentContextMutationReceiptSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
      );
    },

    async setResourceEvaluation(input) {
      const params = resourceIdParamSchema.parse({ id: input.resourceId });
      const body = agentResourceUserEvaluationRequestSchema.parse({
        evaluation: input.evaluation,
        authorizationRef: input.authorizationRef,
        idempotencyKey: input.idempotencyKey,
      });
      const path = `/api/agent/resources/${params.id}/user-evaluation`;
      const result = await request(
        path,
        agentUserImportanceResponseSchema,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (
        result.subject.type !== "resource" ||
        result.subject.resourceId !== params.id ||
        result.value !== body.evaluation
      ) {
        throw new Error(`TabHub API PUT ${path} returned a mismatched response`);
      }
      return result;
    },

    async explainPriority(input) {
      const subject = prioritySubjectSchema.parse(input);
      const path = prioritySubjectPath(subject, "priority");
      const result = await request(path, { parse: parseMcpPrioritySafeRead }, {
        method: "GET",
      });
      if (!samePrioritySubject(result.subject, subject)) {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return result;
    },

    async recordPriorityFeedback(input) {
      const command = recordPriorityFeedbackInputSchema.parse(input);
      const { subject, ...body } = command;
      const path = prioritySubjectPath(subject, "priority-feedback", "agent");
      const result = await request(path, { parse: parseMcpPriorityFeedbackReceipt }, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (
        !samePrioritySubject(result.subject, subject) ||
        result.assessmentId !== body.assessmentId ||
        result.verdict !== body.verdict ||
        result.note !== (body.note ?? null) ||
        result.supersedesId !== (body.supersedesId ?? null) ||
        result.provenance.actor !== "agent" ||
        result.provenance.method !== "on_behalf_of_user"
      ) {
        throw new Error(`TabHub API POST ${path} returned a mismatched response`);
      }
      return result;
    },

    async recomputePriority(input) {
      const command = agentPriorityRecomputeRequestSchema.parse(input);
      const path = "/api/agent/personalization/priority/recompute";
      const result = await request(
        path,
        durableJobRefSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      if (result.kind !== "priority_assessment") {
        throw new Error(`TabHub API POST ${path} returned a mismatched response`);
      }
      return result;
    },

    async getJobStatus(id) {
      const jobId = durableJobIdSchema.refine(
        (value) => value.startsWith("priority_assessment:"),
      ).parse(id);
      const path = `/api/ai/jobs/${jobId}`;
      const result = await request(path, durableJobViewSchema, {
        method: "GET",
      });
      if (result.id !== jobId || result.kind !== "priority_assessment") {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return result;
    },

    async startResearch(input) {
      const command = agentResearchStartRequestSchema.parse(input);
      const path = "/api/agent/research/start";
      return request(path, agentResearchStartResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }, { errorCodeOnly: true });
    },

    async getAiJob(id) {
      const jobId = researchJobIdSchema.parse(id);
      const path = `/api/ai/jobs/${jobId}`;
      const result = await request(
        path,
        durableJobViewSchema,
        { method: "GET" },
        { errorCodeOnly: true },
      );
      if (result.id !== jobId || result.kind !== "resource_research") {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return result;
    },

    async cancelAiJob(id, command) {
      const jobId = researchJobIdSchema.parse(id);
      const body = agentResearchCancelRequestSchema.parse(command);
      const path = `/api/agent/ai/jobs/${jobId}/cancel`;
      const result = await request(path, durableJobViewSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, { errorCodeOnly: true });
      if (result.id !== jobId || result.kind !== "resource_research") {
        throw new Error(`TabHub API POST ${path} returned a mismatched response`);
      }
      return result;
    },

    async listResearchReports(input) {
      const query = researchReportListQuerySchema.parse(input);
      const searchParams = new URLSearchParams({
        targetType: query.targetType,
        targetId: String(query.targetId),
        limit: String(query.limit),
      });
      if (query.beforeVersion !== undefined) {
        searchParams.set("beforeVersion", String(query.beforeVersion));
      }
      const path = `/api/agent/research/reports?${searchParams.toString()}`;
      const result = await request(path, researchReportListResponseSchema, {
        method: "GET",
      }, { errorCodeOnly: true });
      const targetMatches = query.targetType === "page"
        ? result.target.type === "page" && result.target.logicalPageId === query.targetId
        : query.targetType === "resource"
          ? result.target.type === "resource" && result.target.resourceId === query.targetId
          : result.target.type === "selection" &&
            result.target.fingerprint === query.targetId;
      if (!targetMatches) {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return result;
    },

    async getResearchReport(id) {
      const params = researchReportIdParamsSchema.parse({ id });
      const path = `/api/agent/research/reports/${params.id}`;
      const result = await request(path, agentResearchReportDetailSchema, {
        method: "GET",
      }, { errorCodeOnly: true });
      if (result.id !== params.id) {
        throw new Error(`TabHub API GET ${path} returned a mismatched response`);
      }
      return result;
    },

    async setUserImportance(input) {
      const command = agentUserImportanceRequestSchema.parse(input);
      const path = "/api/agent/user-importance";
      const result = await request(path, agentUserImportanceResponseSchema, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (
        !samePrioritySubject(result.subject, command.subject) ||
        result.value !== command.value ||
        result.provenance.actor !== "agent" ||
        result.provenance.method !== "on_behalf_of_user"
      ) {
        throw new Error(`TabHub API PUT ${path} returned a mismatched response`);
      }
      return result;
    },

    async getPageContext(logicalPageId) {
      const params = logicalPageParamSchema.parse({ logicalPageId });
      return request(
        `/api/agent/pages/${params.logicalPageId}/context`,
        shareableContextBundleSchema,
        { method: "GET" },
      );
    },

    async searchPageContext(input) {
      const query = contextSearchQuerySchema.parse({
        q: input.query,
        logicalPageId: input.logicalPageId,
        limit: input.limit,
      });
      const searchParams = new URLSearchParams({
        q: query.q,
        logicalPageId: String(query.logicalPageId),
        limit: String(query.limit),
      });
      return request(
        `/api/agent/context/search?${searchParams.toString()}`,
        shareableContextEntrySchema.array(),
        { method: "GET" },
      );
    },

    async getTabSessionIntent(scope) {
      const exactScope = exactTabScopeSchema.parse(scope);
      const searchParams = new URLSearchParams({
        installationId: exactScope.installationId,
        browserSessionId: exactScope.browserSessionId,
        browserTabId: String(exactScope.browserTabId),
      });
      return request(
        `/api/agent/session-intents?${searchParams.toString()}`,
        shareableSessionIntentBundleSchema,
        { method: "GET" },
      );
    },

    async setPageContext(input) {
      const params = logicalPageParamSchema.parse({
        logicalPageId: input.logicalPageId,
      });
      const command = agentContextAppendCommandSchema.parse(input.command);
      return request(
        `/api/agent/pages/${params.logicalPageId}/context`,
        agentContextMutationReceiptSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
      );
    },

    async setTabSessionIntent(command) {
      const payload = agentSessionIntentSetCommandSchema.parse(command);
      return request(
        "/api/agent/session-intents",
        agentSessionIntentMutationReceiptSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },

    async reviewDisposablePages(input) {
      const searchParams = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize),
      });

      return request(
        `/api/retention/review?${searchParams.toString()}`,
        retentionReviewResponseSchema,
        { method: "GET" },
      );
    },

    async listRetentionTrash(input) {
      const searchParams = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize),
      });

      return request(
        `/api/retention/trash?${searchParams.toString()}`,
        retentionTrashResponseSchema,
        { method: "GET" },
      );
    },

    async setRetentionDecision(input) {
      return request(
        `/api/retention/tabs/${input.tabId}`,
        retentionDecisionResponseSchema,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: input.decision,
            decidedBy: "agent",
          }),
        },
      );
    },

    async closeAndForgetPage(input) {
      return request(
        `/api/retention/tabs/${input.tabId}/forget`,
        retentionForgetResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedBy: "agent",
            confirmed: input.confirmed,
          }),
        },
      );
    },

    async restoreRetentionPage(tabId) {
      return request(
        `/api/retention/trash/${tabId}/restore`,
        retentionDecisionResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decidedBy: "agent" }),
        },
      );
    },

    async listTabs(input) {
      const searchParams = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize),
      });

      if (input.browser !== undefined) {
        searchParams.set("browser", input.browser);
      }
      if (input.status !== undefined) {
        searchParams.set("status", input.status);
      }
      if (input.importance !== undefined) {
        searchParams.set("importance", String(input.importance));
      }
      if (input.isOpen !== undefined) {
        searchParams.set("is_open", String(input.isOpen));
      }
      if (input.tag !== undefined) {
        searchParams.set("tag", input.tag);
      }
      if (input.q !== undefined) {
        searchParams.set("q", input.q);
      }
      if (input.searchMode !== undefined) {
        searchParams.set("search_mode", input.searchMode);
      }
      if (input.similarTo !== undefined) {
        searchParams.set("similar_to", String(input.similarTo));
      }

      return request(
        `/api/tabs?${searchParams.toString()}`,
        tabListResponseSchema,
        { method: "GET" },
      );
    },

    async getTab(id) {
      return request(`/api/tabs/${id}`, tabDetailResponseSchema, {
        method: "GET",
      });
    },

    async setStatus(input) {
      return request("/api/tabs/status", setStatusResponseSchema, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    async setImportance(input) {
      const path = await importanceMutationPath();
      return request(
        path,
        setImportanceResponseSchema,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ids: input.ids,
            importance: input.importance,
          }),
        },
      );
    },

    async tagTabs(input) {
      return request("/api/tags/assign", assignTagsResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, assignedBy: "agent" }),
      });
    },

    async linkTabs(input) {
      return request("/api/links", tabLinkSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, createdBy: "agent" }),
      });
    },

    async summarizeTab(id, depth) {
      return request(
        `/api/tabs/${id}/summarize`,
        summaryEnqueueResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ depth, requestedBy: "agent" }),
        },
      );
    },

    async getSummaryJob(id) {
      return request(`/api/jobs/${id}`, summaryJobSchema, { method: "GET" });
    },

    async clusterInbox(maxClusters) {
      return request("/api/clusters/inbox", clusterInboxResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxClusters }),
      });
    },

    async listTags() {
      return request("/api/tags", tagTreeResponseSchema, { method: "GET" });
    },

    async getStats() {
      return request("/api/stats", statsResponseSchema, { method: "GET" });
    },
  };
}
