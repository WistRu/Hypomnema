import {
  agentContextAppendCommandSchema,
  agentContextMutationReceiptSchema,
  contextChangeResultSchema,
  contextLifecycleRequestSchema,
  contextReviewRequestSchema,
  localContextAppendCommandSchema,
  localResourceCommandSchema,
  localResourceContextViewSchema,
  resourceCommandReceiptSchema,
  resourceActivityQuerySchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceIdParamSchema,
  resourceListQuerySchema,
  resourceListResponseSchema,
  resourcePagesQuerySchema,
  resourcePagesResponseSchema,
  resourceResolutionSchema,
  resourceReviewQueueQuerySchema,
  resourceReviewQueueResponseSchema,
  resourceUserEvaluationRequestSchema,
  shareableContextBundleSchema,
  type ContextCommand,
  type ResourceCommand,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ContextLedgerError, type ContextLedger } from "./context-ledger.js";
import { localAuthError, type LocalCapabilityService } from "./local-capability.js";
import type { ResourceCatalog } from "./resource-catalog.js";
import {
  ResourceCommandCatalogError,
  type ResourceCommandCatalog,
} from "./resource-command-catalog.js";
import type { ResourceReadCatalog } from "./resource-read-catalog.js";
import type { ActivityCatalog } from "./activity-catalog.js";

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
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

function resourceError(reply: FastifyReply, error: unknown) {
  if (error instanceof ResourceCommandCatalogError) {
    if (error.code === "RESOURCE_RECEIPT_CORRUPT") throw error;
    const notFound = error.code === "RESOURCE_NOT_FOUND" ||
      error.code === "LOGICAL_PAGE_NOT_FOUND";
    const invalid = error.code === "RESOURCE_KEY_INVALID" ||
      error.code === "RESOURCE_NAME_INVALID" ||
      error.code === "RESOURCE_ALIAS_INVALID";
    return reply.code(notFound ? 404 : invalid ? 400 : 409).send({
      error: notFound ? "NOT_FOUND" : invalid ? "VALIDATION_ERROR" : error.code,
      ...(invalid ? { code: error.code } : {}),
      message: notFound ? "The requested resource was not found" : error.message,
    });
  }
  if (error instanceof ContextLedgerError) {
    const notFound = error.code === "RESOURCE_NOT_FOUND" ||
      error.code === "CONTEXT_ENTRY_NOT_FOUND";
    return reply.code(notFound ? 404 : 409).send({
      error: notFound ? "NOT_FOUND" : error.code,
      message: notFound ? "The requested resource context was not found" : error.message,
    });
  }
  throw error;
}

const localKey = (key: string) => `local:${key}`;
const agentKey = (key: string) => `agent:${key}`;

export function registerResourceRoutes(
  app: FastifyInstance,
  options: {
    capabilities: LocalCapabilityService;
    catalog: ResourceCatalog;
    commands: ResourceCommandCatalog;
    context: ContextLedger;
    reads: ResourceReadCatalog;
    activity: ActivityCatalog;
    activityWindows: boolean;
    priorityPersonalization: boolean;
  },
): void {
  app.get("/api/resources", async (request, reply) => {
    const parsed = resourceListQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    if ((parsed.data.priority_mode !== undefined ||
        parsed.data.needs_review !== undefined) &&
        !options.priorityPersonalization) {
      return reply.code(409).send({
        error: "FEATURE_DISABLED", feature: "priorityPersonalization",
      });
    }
    return resourceListResponseSchema.parse(options.reads.list(parsed.data));
  });

  app.get("/api/logical-pages/:id/resource-resolution", async (request, reply) => {
    const parsed = resourceIdParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const resolution = options.catalog.getResolution(parsed.data.id);
    return resolution === undefined
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : resourceResolutionSchema.parse(resolution);
  });

  app.get("/api/resources/review-queue", async (request, reply) => {
    const parsed = resourceReviewQueueQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    return resourceReviewQueueResponseSchema.parse(options.catalog.list(parsed.data));
  });

  app.post("/api/resources/commands", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = localResourceCommandSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return resourceCommandReceiptSchema.parse(options.commands.change({
        ...parsed.data,
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: localKey(parsed.data.idempotencyKey),
      } as ResourceCommand));
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  app.get("/api/resources/:id", async (request, reply) => {
    const parsed = resourceIdParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const resource = options.reads.get(parsed.data.id);
    return resource === undefined
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : resourceDetailSchema.parse(resource);
  });

  app.get("/api/resources/:id/pages", async (request, reply) => {
    const params = resourceIdParamSchema.safeParse(request.params);
    const query = resourcePagesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(query.success ? [] : query.error.issues),
    ]);
    const pages = options.reads.pages(params.data.id, query.data);
    return pages === undefined
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : resourcePagesResponseSchema.parse(pages);
  });

  app.get("/api/resources/:id/activity", async (request, reply) => {
    const params = resourceIdParamSchema.safeParse(request.params);
    const query = resourceActivityQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(query.success ? [] : query.error.issues),
    ]);
    if (!options.activityWindows && query.data.window !== "all") {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    const activity = options.activity.resourceActivity(params.data.id, query.data.window);
    return activity === undefined
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : resourceActivityResponseSchema.parse({
          resourceId: params.data.id,
          activity,
        });
  });

  app.put("/api/resources/:id/user-evaluation", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const params = resourceIdParamSchema.safeParse(request.params);
    const body = resourceUserEvaluationRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(body.success ? [] : body.error.issues),
    ]);
    try {
      return resourceCommandReceiptSchema.parse(options.commands.change({
        kind: "set_user_evaluation",
        resourceId: params.data.id,
        evaluation: body.data.evaluation,
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: localKey(body.data.idempotencyKey),
      }));
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  app.get("/api/local/resources/:id/context", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = resourceIdParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const detail = options.reads.get(parsed.data.id);
    if (detail === undefined) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      return localResourceContextViewSchema.parse({
        context: options.context.readLocal({ type: "resource", resourceId: parsed.data.id }),
        counts: detail.counts,
      });
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  app.get("/api/agent/resources/:id/context", async (request, reply) => {
    const parsed = resourceIdParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return shareableContextBundleSchema.parse(
        options.context.readShareable({ type: "resource", resourceId: parsed.data.id }),
      );
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  app.post("/api/resources/:id/context", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const params = resourceIdParamSchema.safeParse(request.params);
    const body = localContextAppendCommandSchema.safeParse(request.body);
    if (!params.success || !body.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(body.success ? [] : body.error.issues),
    ]);
    try {
      return contextChangeResultSchema.parse(options.context.change({
        ...body.data,
        subject: { type: "resource", resourceId: params.data.id },
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: localKey(body.data.idempotencyKey),
      }));
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  app.post("/api/agent/resources/:id/context", async (request, reply) => {
    const params = resourceIdParamSchema.safeParse(request.params);
    const body = agentContextAppendCommandSchema.safeParse(request.body);
    if (!params.success || !body.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(body.success ? [] : body.error.issues),
    ]);
    const provenance = body.success && body.data.provenance.method === "on_behalf_of_user"
      ? { actor: "agent" as const, method: "on_behalf_of_user" as const }
      : { actor: "agent" as const, ...body.data.provenance };
    try {
      const result = options.context.change({
        ...body.data,
        subject: { type: "resource", resourceId: params.data.id },
        visibility: "share_with_ai",
        provenance,
        idempotencyKey: agentKey(body.data.idempotencyKey),
      });
      if (result.kind !== "changed") throw new Error("Invalid append receipt");
      return agentContextMutationReceiptSchema.parse({
        kind: "appended",
        entry: {
          entryKind: result.entry.entryKind,
          body: result.entry.body,
          provenance: result.entry.provenance,
          visibility: "share_with_ai",
          staleAt: result.entry.staleAt,
          state: result.entry.state,
          createdAt: result.entry.createdAt,
          reviewVerdict: null,
        },
      });
    } catch (error) {
      return resourceError(reply, error);
    }
  });

  const lifecycle = (kind: "withdraw" | "restore") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (requireLocal(options.capabilities, request, reply) === null) return;
      const params = resourceIdParamSchema.extend({
        entryId: resourceIdParamSchema.shape.id,
      }).safeParse(request.params);
      const body = contextLifecycleRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) return validationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
      try {
        return contextChangeResultSchema.parse(options.context.change({
          kind,
          subject: { type: "resource", resourceId: params.data.id },
          entryId: params.data.entryId,
          provenance: { actor: "user", method: "manual" },
          idempotencyKey: localKey(body.data.idempotencyKey),
        }));
      } catch (error) {
        return resourceError(reply, error);
      }
    };

  app.post("/api/resources/:id/context/:entryId/withdraw", lifecycle("withdraw"));
  app.post("/api/resources/:id/context/:entryId/restore", lifecycle("restore"));
  app.post("/api/resources/:id/context/:entryId/reviews", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const params = resourceIdParamSchema.extend({
      entryId: resourceIdParamSchema.shape.id,
    }).safeParse(request.params);
    const body = contextReviewRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return validationError(reply, [
      ...(params.success ? [] : params.error.issues),
      ...(body.success ? [] : body.error.issues),
    ]);
    try {
      return contextChangeResultSchema.parse(options.context.change({
        kind: "review",
        subject: { type: "resource", resourceId: params.data.id },
        entryId: params.data.entryId,
        verdict: body.data.verdict,
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: localKey(body.data.idempotencyKey),
      } as ContextCommand));
    } catch (error) {
      return resourceError(reply, error);
    }
  });
}
