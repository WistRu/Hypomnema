import {
  durableJobIdParamSchema,
  durableJobViewSchema,
  type DurableJobId,
  type DurableJobView,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { localAuthError, type LocalCapabilityService } from "./local-capability.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface AiJobRouteStore {
  get(id: DurableJobId): MaybePromise<DurableJobView>;
  cancel(id: DurableJobId): MaybePromise<DurableJobView>;
}

export interface AiJobRouteOptions {
  readonly capabilities: LocalCapabilityService;
  readonly researchEnabled: boolean | (() => boolean);
  readonly jobs: AiJobRouteStore;
  readonly researchWorkflow?: {
    cancel(id: DurableJobId): MaybePromise<DurableJobView>;
  };
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

function isEnabled(value: AiJobRouteOptions["researchEnabled"]): boolean {
  return typeof value === "function" ? value() : value;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function aiJobRouteError(reply: FastifyReply, error: unknown) {
  const code = errorCode(error);
  if (code === "JOB_NOT_FOUND" || code === "JOB_SUBJECT_NOT_FOUND" ||
      code === "JOB_KIND_UNAVAILABLE") {
    return reply.code(404).send({ error: code });
  }
  if (code === "INVALID_JOB_ID" || code === "INVALID_JOB_INPUT" ||
      code === "JOB_INPUT_UNAVAILABLE") {
    return reply.code(400).send({ error: "VALIDATION_ERROR", code });
  }
  if (code === "JOB_NOT_CANCELLABLE" || code === "JOB_ACTIVE_CONFLICT" ||
      code === "IDEMPOTENCY_KEY_CONFLICT" || code === "INVALID_JOB_TRANSITION") {
    return reply.code(409).send({ error: code });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

export function registerAiJobRoutes(
  app: FastifyInstance,
  options: AiJobRouteOptions,
): void {
  // The shared namespaced route is registered here exactly once. The legacy
  // numeric summary route remains an independent compatibility surface.
  app.get("/api/ai/jobs/:id", async (request, reply) => {
    const params = durableJobIdParamSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error.issues);
    try {
      return durableJobViewSchema.parse(await options.jobs.get(params.data.id));
    } catch (error) {
      return aiJobRouteError(reply, error);
    }
  });

  app.post("/api/ai/jobs/:id/cancel", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const params = durableJobIdParamSchema.safeParse(request.params);
    if (!params.success) return validationError(reply, params.error.issues);
    if (params.data.id.startsWith("resource_research:") &&
        !isEnabled(options.researchEnabled)) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "research" });
    }
    try {
      const result = params.data.id.startsWith("resource_research:")
        ? await options.researchWorkflow?.cancel(params.data.id)
        : await options.jobs.cancel(params.data.id);
      if (result === undefined) {
        throw new Error("Research workflow cancellation is unavailable");
      }
      return durableJobViewSchema.parse(result);
    } catch (error) {
      return aiJobRouteError(reply, error);
    }
  });
}
