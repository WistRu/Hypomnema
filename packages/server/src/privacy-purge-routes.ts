import {
  privacyPurgeIdSchema,
  privacyPurgeStartBodySchema,
  privacyPurgeStatusResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { localAuthError, type LocalCapabilityService } from "./local-capability.js";
import { PrivacyPurgeCoordinatorError,
  type PrivacyPurgeCoordinator } from "./privacy-purge-coordinator.js";

export interface PrivacyPurgeRouteOptions {
  readonly capabilities: LocalCapabilityService;
  readonly coordinator: PrivacyPurgeCoordinator;
  readonly runtime: { wake(purgeId?: string): void };
  readonly newStartsEnabled: boolean | (() => boolean);
}

function requireLocal(capabilities: LocalCapabilityService, request: FastifyRequest,
  reply: FastifyReply): boolean {
  if (capabilities.authenticate(request) !== null) return true;
  void reply.code(401).send(localAuthError);
  return false;
}

function enabled(value: PrivacyPurgeRouteOptions["newStartsEnabled"]): boolean {
  return typeof value === "function" ? value() : value;
}

function sendStatus(reply: FastifyReply, value: unknown) {
  const parsed = privacyPurgeStatusResponseSchema.safeParse(value);
  if (!parsed.success) return reply.code(503).send({ error: "PURGE_UNAVAILABLE" });
  return reply.code(parsed.data.state === "completed" || parsed.data.state === "failed"
    ? 200 : 202).send(parsed.data);
}

function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof PrivacyPurgeCoordinatorError)) {
    return reply.code(503).send({ error: "PURGE_UNAVAILABLE" });
  }
  if (error.code === "PURGE_INVALID_REQUEST") {
    return reply.code(400).send({ error: error.code });
  }
  if (error.code === "PURGE_NOT_FOUND" || error.code === "PURGE_TARGET_NOT_FOUND") {
    return reply.code(404).send({ error: error.code });
  }
  if (error.code === "PURGE_NEW_START_DISABLED") {
    return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "privacyPurge" });
  }
  if (error.code === "PURGE_IDEMPOTENCY_CONFLICT" ||
      error.code === "PURGE_SUBJECT_BUSY" || error.code === "PURGE_RETRY_NOT_ALLOWED") {
    return reply.code(409).send({ error: error.code });
  }
  return reply.code(503).send({ error: "PURGE_UNAVAILABLE" });
}

export function registerPrivacyPurgeRoutes(app: FastifyInstance,
  options: PrivacyPurgeRouteOptions): void {
  app.post("/api/privacy/purges", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const body = privacyPurgeStartBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "PURGE_INVALID_REQUEST" });
    try {
      const result = await options.coordinator.start(body.data,
        enabled(options.newStartsEnabled) ? undefined : { allowCreate: false });
      options.runtime.wake(result.purgeId);
      return sendStatus(reply, result);
    } catch (error) { return sendError(reply, error); }
  });
  app.get("/api/privacy/purges/:purgeId", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const purgeId = privacyPurgeIdSchema.safeParse(
      (request.params as { purgeId?: unknown }).purgeId,
    );
    if (!purgeId.success) return reply.code(400).send({ error: "PURGE_INVALID_REQUEST" });
    try {
      const result = options.coordinator.read(purgeId.data);
      if (result === null) return reply.code(404).send({ error: "PURGE_NOT_FOUND" });
      return privacyPurgeStatusResponseSchema.parse(result);
    } catch (error) { return sendError(reply, error); }
  });
  app.post("/api/privacy/purges/:purgeId/retry", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    const purgeId = privacyPurgeIdSchema.safeParse(
      (request.params as { purgeId?: unknown }).purgeId,
    );
    if (!purgeId.success) return reply.code(400).send({ error: "PURGE_INVALID_REQUEST" });
    try {
      const result = await options.coordinator.retry(purgeId.data);
      options.runtime.wake(result.purgeId);
      return sendStatus(reply, result);
    } catch (error) { return sendError(reply, error); }
  });
}
