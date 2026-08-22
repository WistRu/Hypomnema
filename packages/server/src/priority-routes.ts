import { createHash } from "node:crypto";

import {
  agentPriorityFeedbackRequestSchema,
  agentPriorityRecomputeRequestSchema,
  durableJobRefSchema,
  localPriorityFeedbackRequestSchema,
  localPriorityRecomputeRequestSchema,
  logicalPageParamSchema,
  priorityFeedbackReceiptSchema,
  priorityReadBatchRequestSchema,
  priorityReadBatchResponseSchema,
  priorityReviewQueueQuerySchema,
  priorityReviewQueueResponseSchema,
  prioritySafeReadSchema,
  resourceIdParamSchema,
  type PrioritySubjectContract,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { DurableAiJobError } from "./durable-ai-jobs.js";
import { localAuthError, type LocalCapabilityService } from "./local-capability.js";
import type { PriorityAssessmentCoordinator } from
  "./priority-assessment-coordinator.js";
import { PriorityEngineError } from "./priority-engine.js";
import {
  PriorityFeatureCatalogError,
  type PriorityFeatureRead,
} from "./priority-feature-catalog.js";

type PriorityReader = Pick<
  PriorityAssessmentCoordinator,
  "read" | "readBatch" | "reviewQueue"
>;
type PriorityWriter = Pick<
  PriorityAssessmentCoordinator,
  "submit" | "recordFeedback"
>;

export interface PriorityRouteOptions {
  readonly capabilities?: LocalCapabilityService;
  readonly reader?: PriorityReader;
  readonly writer?: PriorityWriter;
  readonly scheduler?: { wake(): void };
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function internalError(error: unknown): never {
  const wrapped = new Error("Priority operation failed", { cause: error });
  wrapped.name = "PriorityRouteError";
  throw wrapped;
}

function deriveIdempotencyKey(audience: "local" | "agent", value: string): string {
  const digest = createHash("sha256")
    .update(`${audience}\0${value}`, "utf8")
    .digest("hex");
  return `${audience}:${digest}`;
}

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const identity = capabilities.authenticate(request);
  if (identity === null) void reply.code(401).send(localAuthError);
  return identity;
}

function routeError(reply: FastifyReply, error: unknown) {
  if (error instanceof PriorityFeatureCatalogError) {
    if (error.code === "PRIORITY_FEATURE_STORAGE_CORRUPT") return internalError(error);
    const notFound = error.code === "PRIORITY_FEATURE_SUBJECT_NOT_FOUND" ||
      error.code === "PRIORITY_FEATURE_RESOURCE_NOT_ACTIVE";
    return reply.code(notFound ? 404 : 400).send({
      error: notFound ? "NOT_FOUND" : "VALIDATION_ERROR",
      code: error.code,
      message: notFound
        ? "The requested priority subject was not found"
        : "The priority cursor or anchor is invalid",
    });
  }
  if (error instanceof PriorityEngineError) {
    if (error.code === "PRIORITY_STORAGE_CORRUPT") return internalError(error);
    const notFound = error.code === "PRIORITY_SUBJECT_NOT_FOUND" ||
      error.code === "PRIORITY_RESOURCE_NOT_ACTIVE" ||
      error.code === "PRIORITY_OUTCOME_NOT_FOUND";
    const invalid = error.code === "INVALID_PRIORITY_INPUT" ||
      error.code === "INVALID_PRIORITY_RULESET" ||
      error.code === "PRIORITY_BATCH_TOO_LARGE" ||
      error.code === "PRIORITY_DUPLICATE_SUBJECT";
    return reply.code(notFound ? 404 : invalid ? 400 : 409).send({
      error: notFound ? "NOT_FOUND" : invalid ? "VALIDATION_ERROR" : error.code,
      ...(!notFound && !invalid ? {} : { code: error.code }),
      message: notFound
        ? "The requested priority outcome was not found"
        : invalid
          ? "The priority request is invalid"
          : "The priority mutation conflicts with current state",
    });
  }
  if (error instanceof DurableAiJobError) {
    if (error.code === "JOB_STORAGE_CORRUPT") return internalError(error);
    const notFound = error.code === "JOB_NOT_FOUND" ||
      error.code === "JOB_SUBJECT_NOT_FOUND" ||
      error.code === "JOB_KIND_UNAVAILABLE";
    const invalid = error.code === "INVALID_JOB_ID" ||
      error.code === "INVALID_JOB_INPUT" ||
      error.code === "JOB_INPUT_UNAVAILABLE";
    return reply.code(notFound ? 404 : invalid ? 400 : 409).send({
      error: notFound ? error.code : invalid ? "VALIDATION_ERROR" : error.code,
      ...(!notFound && invalid ? { code: error.code } : {}),
      message: notFound
        ? "The requested AI job is unavailable"
        : invalid
          ? "The AI job request is invalid"
          : "The AI job request conflicts with current state",
    });
  }
  return internalError(error);
}

function safeRead(value: PriorityFeatureRead) {
  return prioritySafeReadSchema.parse({
    subject: value.subject,
    outcome: value.currentOutcome,
    isCurrent: value.isCurrent,
    dirty: value.dirty,
    needsReview: value.needsReview,
  });
}

function subjectFromParams(
  kind: "page" | "resource",
  params: unknown,
  reply: FastifyReply,
): PrioritySubjectContract | undefined {
  if (kind === "page") {
    const parsed = logicalPageParamSchema.safeParse(params);
    if (!parsed.success) {
      validationError(reply, parsed.error.issues);
      return undefined;
    }
    return { type: "page", logicalPageId: parsed.data.logicalPageId };
  }
  const parsed = resourceIdParamSchema.safeParse(params);
  if (!parsed.success) {
    validationError(reply, parsed.error.issues);
    return undefined;
  }
  return { type: "resource", resourceId: parsed.data.id };
}

function feedbackReceipt(value: ReturnType<PriorityWriter["recordFeedback"]>) {
  return priorityFeedbackReceiptSchema.parse({
    id: value.id,
    subject: value.subject,
    assessmentId: value.assessmentId,
    verdict: value.verdict,
    note: value.note,
    provenance: { actor: value.actor, method: value.method },
    supersedesId: value.supersedesId,
    supersededAt: value.supersededAt,
    revision: value.revision,
    createdAt: value.createdAt,
  });
}

export function registerPriorityRoutes(
  app: FastifyInstance,
  options: PriorityRouteOptions,
): void {
  const reader = options.reader;
  if (reader !== undefined) {
    app.post("/api/personalization/priority/read-batch", async (request, reply) => {
      const body = priorityReadBatchRequestSchema.safeParse(request.body);
      if (!body.success) return validationError(reply, body.error.issues);
      try {
        return priorityReadBatchResponseSchema.parse({
          items: reader.readBatch(body.data.subjects).map(safeRead),
        });
      } catch (error) {
        return routeError(reply, error);
      }
    });

    app.get("/api/personalization/priority/review-queue", async (request, reply) => {
      const query = priorityReviewQueueQuerySchema.safeParse(request.query);
      if (!query.success) return validationError(reply, query.error.issues);
      try {
        const result = reader.reviewQueue({
          limit: query.data.limit,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        });
        return priorityReviewQueueResponseSchema.parse({
          items: result.items.map(safeRead),
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        return routeError(reply, error);
      }
    });

    app.get("/api/logical-pages/:logicalPageId/priority", async (request, reply) => {
      const subject = subjectFromParams("page", request.params, reply);
      if (subject === undefined) return;
      try {
        return safeRead(reader.read(subject));
      } catch (error) {
        return routeError(reply, error);
      }
    });

    app.get("/api/resources/:id/priority", async (request, reply) => {
      const subject = subjectFromParams("resource", request.params, reply);
      if (subject === undefined) return;
      try {
        return safeRead(reader.read(subject));
      } catch (error) {
        return routeError(reply, error);
      }
    });
  }

  const writer = options.writer;
  if (writer === undefined) return;
  const capabilities = options.capabilities;
  if (capabilities === undefined) {
    throw new Error("Priority writer local capability unavailable");
  }

  const registerFeedback = (
    audience: "local" | "agent",
    kind: "page" | "resource",
    path: string,
  ) => {
    app.post(path, async (request, reply) => {
      if (audience === "local" &&
          requireLocal(capabilities, request, reply) === null) return;
      const subject = subjectFromParams(kind, request.params, reply);
      const body = (audience === "local"
        ? localPriorityFeedbackRequestSchema
        : agentPriorityFeedbackRequestSchema).safeParse(request.body);
      if (subject === undefined) return;
      if (!body.success) return validationError(reply, body.error.issues);
      try {
        const { assessmentId, verdict, note, supersedesId, idempotencyKey } = body.data;
        const authorizationRef = "authorizationRef" in body.data &&
          typeof body.data.authorizationRef === "string"
          ? body.data.authorizationRef
          : undefined;
        const provenance = audience === "local"
          ? { actor: "user" as const, method: "manual" as const }
          : authorizationRef === undefined
            ? internalError(new Error("Validated agent authorization is missing"))
            : { actor: "agent" as const, method: "on_behalf_of_user" as const,
                authorizationRef };
        return feedbackReceipt(writer.recordFeedback({
          expectedSubject: subject,
          assessmentId,
          verdict,
          ...(note === undefined ? {} : { note }),
          provenance,
          idempotencyKey: deriveIdempotencyKey(audience, idempotencyKey),
          ...(supersedesId === undefined ? {} : { supersedesId }),
        }));
      } catch (error) {
        return routeError(reply, error);
      }
    });
  };

  registerFeedback("local", "page", "/api/logical-pages/:logicalPageId/priority-feedback");
  registerFeedback("local", "resource", "/api/resources/:id/priority-feedback");
  registerFeedback("agent", "page",
    "/api/agent/logical-pages/:logicalPageId/priority-feedback");
  registerFeedback("agent", "resource", "/api/agent/resources/:id/priority-feedback");

  app.post("/api/personalization/priority/recompute", async (request, reply) => {
    if (requireLocal(capabilities, request, reply) === null) return;
    const body = localPriorityRecomputeRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const result = durableJobRefSchema.parse(writer.submit({
        subject: body.data.subject ?? { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: deriveIdempotencyKey("local", body.data.idempotencyKey),
        stepBatchSize: body.data.stepBatchSize,
      }));
      options.scheduler?.wake();
      return result;
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.post("/api/agent/personalization/priority/recompute", async (request, reply) => {
    const body = agentPriorityRecomputeRequestSchema.safeParse(request.body);
    if (!body.success) return validationError(reply, body.error.issues);
    try {
      const result = durableJobRefSchema.parse(writer.submit({
        subject: body.data.subject ?? { type: "collection", scope: "all" },
        provenance: {
          requestedBy: "agent",
          requestMethod: "on_behalf_of_user",
          authorizationRef: body.data.authorizationRef,
        },
        idempotencyKey: deriveIdempotencyKey("agent", body.data.idempotencyKey),
        stepBatchSize: body.data.stepBatchSize,
      }));
      options.scheduler?.wake();
      return result;
    } catch (error) {
      return routeError(reply, error);
    }
  });
}
