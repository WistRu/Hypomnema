import {
  agentResearchCancelRequestSchema,
  agentResearchPreflightSchema,
  agentResearchReportDetailSchema,
  agentResearchRunApprovalRequestSchema,
  agentResearchStartRequestSchema,
  agentResearchStartResponseSchema,
  durableJobIdParamSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  projectAgentResearchPreflight,
  projectAgentResearchReportDetail,
  researchPreflightRequestSchema,
  researchReportIdParamsSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  type AgentResearchCancelRequest,
  type AgentResearchRunApprovalRequest,
  type AgentResearchStartRequest,
  type AgentResearchStartResponse,
  type DurableJobId,
  type DurableJobRef,
  type DurableJobView,
  type ResearchPreflight,
  type ResearchPreflightRequest,
  type ResearchReportDetail,
  type ResearchReportListQuery,
  type ResearchReportListResponse,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

type MaybePromise<Value> = Value | Promise<Value>;

export interface AgentResearchRouteOptions {
  readonly researchEnabled: boolean | (() => boolean);
  readonly providerAvailable?: boolean | (() => boolean);
  readonly workflow: {
    preflight(request: ResearchPreflightRequest): MaybePromise<ResearchPreflight>;
    replayAgentStart(
      request: AgentResearchStartRequest,
    ): MaybePromise<DurableJobRef | undefined>;
    requestAgentStart(
      request: AgentResearchStartRequest,
    ): MaybePromise<AgentResearchStartResponse>;
    requestAgentRun(request: AgentResearchRunApprovalRequest): MaybePromise<DurableJobRef>;
    cancelAgent(id: DurableJobId, command: AgentResearchCancelRequest): MaybePromise<DurableJobView>;
  };
  readonly reports: {
    list(query: ResearchReportListQuery): MaybePromise<ResearchReportListResponse>;
    get(reportId: number): MaybePromise<ResearchReportDetail | undefined>;
  };
  readonly scheduler?: { wake(): void };
}

function enabled(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function code(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function routeError(reply: FastifyReply, error: unknown) {
  const errorCode = code(error);
  if (errorCode === "RESEARCH_TARGET_NOT_FOUND" ||
      errorCode === "RESEARCH_PARENT_NOT_FOUND" || errorCode === "JOB_NOT_FOUND" ||
      errorCode === "JOB_SUBJECT_NOT_FOUND" || errorCode === "JOB_KIND_UNAVAILABLE") {
    return reply.code(404).send({ error: errorCode });
  }
  if (errorCode === "RESEARCH_SCOPE_TOO_LARGE") {
    return reply.code(413).send({ error: errorCode });
  }
  if (errorCode === "RESEARCH_CAPTURE_REQUIRED" ||
      errorCode === "RESEARCH_SELECTION_INVALID") {
    return reply.code(422).send({ error: errorCode });
  }
  if (errorCode === "RESEARCH_PREFLIGHT_STALE" ||
      errorCode === "IDEMPOTENCY_KEY_CONFLICT" || errorCode === "JOB_ACTIVE_CONFLICT" ||
      errorCode === "JOB_NOT_CANCELLABLE" || errorCode === "RESEARCH_PARENT_UNAVAILABLE" ||
      errorCode === "INVALID_JOB_TRANSITION") {
    return reply.code(409).send({ error: errorCode });
  }
  if (errorCode === "INVALID_JOB_ID" || errorCode === "INVALID_JOB_INPUT" ||
      errorCode === "JOB_INPUT_UNAVAILABLE") {
    return reply.code(400).send({ error: "VALIDATION_ERROR", code: errorCode });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

export function registerAgentResearchRoutes(
  app: FastifyInstance,
  options: AgentResearchRouteOptions,
): void {
  app.post("/api/agent/research/start", async (request, reply) => {
    if (!enabled(options.researchEnabled)) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
    }
    const body = agentResearchStartRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const replay = await options.workflow.replayAgentStart(body.data);
      if (replay !== undefined) {
        const result = agentResearchStartResponseSchema.parse(replay);
        options.scheduler?.wake();
        return reply.code(202).send(result);
      }
      if (options.providerAvailable === undefined || !enabled(options.providerAvailable)) {
        return reply.code(503).send({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
      }
      const result = agentResearchStartResponseSchema.parse(
        await options.workflow.requestAgentStart(body.data),
      );
      if ("id" in result) {
        options.scheduler?.wake();
        return reply.code(202).send(result);
      }
      return reply.code(200).send(result);
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.post("/api/agent/research/preflight", async (request, reply) => {
    if (!enabled(options.researchEnabled)) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
    }
    const body = researchPreflightRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const local = await options.workflow.preflight(body.data);
      return agentResearchPreflightSchema.parse(projectAgentResearchPreflight(local));
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.post("/api/agent/research/runs", async (request, reply) => {
    if (!enabled(options.researchEnabled)) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
    }
    if (options.providerAvailable === undefined || !enabled(options.providerAvailable)) {
      return reply.code(503).send({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
    }
    const body = agentResearchRunApprovalRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const result = durableJobRefSchema.parse(await options.workflow.requestAgentRun(body.data));
      options.scheduler?.wake();
      return reply.code(202).send(result);
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.get("/api/agent/research/reports", async (request, reply) => {
    const query = researchReportListQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error.issues);
    try {
      return researchReportListResponseSchema.parse(await options.reports.list(query.data));
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.get("/api/agent/research/reports/:id", async (request, reply) => {
    const params = researchReportIdParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error.issues);
    try {
      const local = await options.reports.get(params.data.id);
      if (local === undefined) {
        return reply.code(404).send({ error: "RESEARCH_REPORT_NOT_FOUND" });
      }
      return agentResearchReportDetailSchema.parse(projectAgentResearchReportDetail(local));
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.post("/api/agent/ai/jobs/:id/cancel", async (request, reply) => {
    if (!enabled(options.researchEnabled)) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
    }
    const params = durableJobIdParamSchema.safeParse(request.params);
    const body = agentResearchCancelRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(body.success ? [] : body.error.issues),
    ]);
    if (!params.data.id.startsWith("resource_research:")) {
      return reply.code(409).send({ error: "JOB_NOT_CANCELLABLE" });
    }
    try {
      return durableJobViewSchema.parse(
        await options.workflow.cancelAgent(params.data.id, body.data),
      );
    } catch (error) {
      return routeError(reply, error);
    }
  });
}
