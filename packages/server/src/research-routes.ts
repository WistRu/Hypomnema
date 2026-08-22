import {
  durableJobRefSchema,
  researchPreflightRequestSchema,
  researchPreflightSchema,
  researchRefineApprovalRequestSchema,
  researchReportDetailSchema,
  researchReportIdParamsSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  researchRedactionReceiptSchema,
  researchRedactionRequestSchema,
  researchRunApprovalRequestSchema,
  type DurableJobRef,
  type ResearchPreflight,
  type ResearchPreflightRequest,
  type ResearchReportDetail,
  type ResearchReportListQuery,
  type ResearchReportListResponse,
  type ResearchRedactionReceipt,
  type ResearchRedactionRequest,
  type ResearchRunApprovalRequest,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { localAuthError, type LocalCapabilityService } from "./local-capability.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ResearchRouteWorkflow {
  preflight(request: ResearchPreflightRequest): MaybePromise<ResearchPreflight>;
  requestRun(request: ResearchRunApprovalRequest): MaybePromise<DurableJobRef>;
  redact(request: ResearchRedactionRequest): MaybePromise<ResearchRedactionReceipt>;
}

export interface ResearchRouteReportCatalog {
  list(query: ResearchReportListQuery): MaybePromise<ResearchReportListResponse>;
  get(reportId: number): MaybePromise<ResearchReportDetail | undefined>;
}

export interface ResearchRouteOptions {
  readonly capabilities: LocalCapabilityService;
  readonly researchEnabled: boolean | (() => boolean);
  readonly providerAvailable?: boolean | (() => boolean);
  readonly workflow: ResearchRouteWorkflow;
  readonly reports: ResearchRouteReportCatalog;
  readonly scheduler?: { wake(): void };
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (capabilities.authenticate(request) !== null) return true;
  void reply.code(401).send(localAuthError);
  return false;
}

function isEnabled(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

function featureDisabled(reply: FastifyReply) {
  return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
}

function providerUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function researchRouteError(reply: FastifyReply, error: unknown) {
  const code = errorCode(error);
  if (code === "RESEARCH_TARGET_NOT_FOUND" || code === "RESEARCH_PARENT_NOT_FOUND" ||
      code === "JOB_NOT_FOUND" || code === "JOB_SUBJECT_NOT_FOUND" ||
      code === "JOB_KIND_UNAVAILABLE") {
    return reply.code(404).send({ error: code });
  }
  if (code === "RESEARCH_SCOPE_TOO_LARGE") {
    return reply.code(413).send({ error: code });
  }
  if (code === "RESEARCH_CAPTURE_REQUIRED" || code === "RESEARCH_SELECTION_INVALID") {
    return reply.code(422).send({ error: code });
  }
  if (code === "RESEARCH_PREFLIGHT_STALE" || code === "IDEMPOTENCY_KEY_CONFLICT" ||
      code === "JOB_ACTIVE_CONFLICT" || code === "JOB_NOT_CANCELLABLE" ||
      code === "RESEARCH_PARENT_UNAVAILABLE" || code === "INVALID_JOB_TRANSITION") {
    return reply.code(409).send({ error: code });
  }
  if (code === "INVALID_JOB_ID" || code === "INVALID_JOB_INPUT" ||
      code === "JOB_INPUT_UNAVAILABLE") {
    return reply.code(400).send({ error: "VALIDATION_ERROR", code });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

export function registerResearchRoutes(
  app: FastifyInstance,
  options: ResearchRouteOptions,
): void {
  app.get("/api/research/reports", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const query = researchReportListQuerySchema.safeParse(request.query);
    if (!query.success) return validationError(reply, query.error.issues);
    try {
      return researchReportListResponseSchema.parse(await options.reports.list(query.data));
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });

  app.get("/api/research/reports/:id", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const params = researchReportIdParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error.issues);
    try {
      const result = await options.reports.get(params.data.id);
      if (result === undefined) return reply.code(404).send({ error: "RESEARCH_REPORT_NOT_FOUND" });
      return researchReportDetailSchema.parse(result);
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });

  app.post("/api/research/preflight", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    if (!isEnabled(options.researchEnabled)) return featureDisabled(reply);
    const body = researchPreflightRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      return researchPreflightSchema.parse(await options.workflow.preflight(body.data));
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });

  app.post("/api/research/runs", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    if (!isEnabled(options.researchEnabled)) return featureDisabled(reply);
    if (options.providerAvailable === undefined || !isEnabled(options.providerAvailable)) {
      return providerUnavailable(reply);
    }
    const body = researchRunApprovalRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const result = durableJobRefSchema.parse(await options.workflow.requestRun(body.data));
      options.scheduler?.wake();
      return reply.code(202).send(result);
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });

  app.post("/api/research/reports/:id/refine", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    if (!isEnabled(options.researchEnabled)) return featureDisabled(reply);
    if (options.providerAvailable === undefined || !isEnabled(options.providerAvailable)) {
      return providerUnavailable(reply);
    }
    const params = researchReportIdParamsSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error.issues);
    const body = researchRefineApprovalRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const result = durableJobRefSchema.parse(await options.workflow.requestRun({
        ...body.data,
        parentReportId: params.data.id,
      }));
      options.scheduler?.wake();
      return reply.code(202).send(result);
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });

  app.post("/api/research/redactions", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const body = researchRedactionRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      return researchRedactionReceiptSchema.parse(await options.workflow.redact(body.data));
    } catch (error) {
      return researchRouteError(reply, error);
    }
  });
}
