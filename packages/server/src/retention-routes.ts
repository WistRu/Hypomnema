import {
  forgetRetentionSchema,
  retentionDecisionResponseSchema,
  retentionForgetResponseSchema,
  retentionReviewQuerySchema,
  retentionReviewResponseSchema,
  retentionTrashResponseSchema,
  restoreRetentionSchema,
  setRetentionDecisionSchema,
  tabIdParamSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  RetentionTabNotFoundError,
  RetentionTabOpenError,
} from "./retention-catalog.js";
import type { RetentionLifecycle } from "./retention-lifecycle.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

export function registerRetentionRoutes(
  app: FastifyInstance,
  retentionLifecycle: RetentionLifecycle,
): void {
  app.get("/api/retention/review", async (request, reply) => {
    const parsed = retentionReviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }
    return retentionReviewResponseSchema.parse(
      retentionLifecycle.review(parsed.data),
    );
  });

  app.get("/api/retention/trash", async (request, reply) => {
    const parsed = retentionReviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }
    return retentionTrashResponseSchema.parse(
      retentionLifecycle.listTrash(parsed.data),
    );
  });

  app.patch("/api/retention/tabs/:id", async (request, reply) => {
    const params = tabIdParamSchema.safeParse(request.params);
    const body = setRetentionDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }
    try {
      return retentionDecisionResponseSchema.parse(
        retentionLifecycle.decide(params.data.id, body.data),
      );
    } catch (error) {
      if (error instanceof RetentionTabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }
      if (error instanceof RetentionTabOpenError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }
      throw error;
    }
  });

  app.post("/api/retention/tabs/:id/forget", async (request, reply) => {
    const params = tabIdParamSchema.safeParse(request.params);
    const body = forgetRetentionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }
    try {
      return retentionForgetResponseSchema.parse(
        await retentionLifecycle.forget(params.data.id, body.data),
      );
    } catch (error) {
      if (error instanceof RetentionTabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }
      throw error;
    }
  });

  app.post("/api/retention/trash/:id/restore", async (request, reply) => {
    const params = tabIdParamSchema.safeParse(request.params);
    const body = restoreRetentionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }
    try {
      return retentionDecisionResponseSchema.parse(
        retentionLifecycle.restore(params.data.id, body.data),
      );
    } catch (error) {
      if (error instanceof RetentionTabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }
      throw error;
    }
  });
}
