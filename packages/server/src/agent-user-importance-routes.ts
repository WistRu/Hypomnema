import {
  agentResourceUserEvaluationRequestSchema,
  agentUserImportanceRequestSchema,
  agentUserImportanceResponseSchema,
  resourceIdParamSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AgentUserImportanceCatalogError,
  type AgentUserImportanceCatalog,
} from "./agent-user-importance-catalog.js";
import { ResourceCommandCatalogError } from "./resource-command-catalog.js";

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function mutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentUserImportanceCatalogError) {
    switch (error.code) {
      case "FEATURE_DISABLED":
        return reply.code(404).send({
          error: "FEATURE_DISABLED",
          feature: error.feature,
        });
      case "SCHEMA_UNAVAILABLE":
        return reply.code(503).send({
          error: "SCHEMA_UNAVAILABLE",
          requiredSchemaVersion: 23,
          actualSchemaVersion: error.actualSchemaVersion,
        });
      case "SUBJECT_NOT_FOUND":
        return reply.code(404).send({ error: "SUBJECT_NOT_FOUND" });
      case "IDEMPOTENCY_KEY_CONFLICT":
        return reply.code(409).send({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      case "USER_IMPORTANCE_RECEIPT_CORRUPT":
        return reply.code(500).send({
          error: "USER_IMPORTANCE_RECEIPT_CORRUPT",
        });
    }
  }
  if (error instanceof ResourceCommandCatalogError) {
    if (error.code === "RESOURCE_RECEIPT_CORRUPT") {
      return reply.code(500).send({ error: "RESOURCE_RECEIPT_CORRUPT" });
    }
    return reply.code(409).send({ error: error.code });
  }
  throw error;
}

export function registerAgentUserImportanceRoutes(
  app: FastifyInstance,
  catalog: AgentUserImportanceCatalog,
): void {
  app.put("/api/agent/user-importance", async (request, reply) => {
    const parsed = agentUserImportanceRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return agentUserImportanceResponseSchema.parse(catalog.change(parsed.data));
    } catch (error) {
      return mutationError(reply, error);
    }
  });

  app.put(
    "/api/agent/resources/:id/user-evaluation",
    async (request, reply) => {
      const params = resourceIdParamSchema.safeParse(request.params);
      const body = agentResourceUserEvaluationRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validationError(reply, [
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues),
        ]);
      }
      try {
        return agentUserImportanceResponseSchema.parse(catalog.change({
          subject: { type: "resource", resourceId: params.data.id },
          value: body.data.evaluation,
          authorizationRef: body.data.authorizationRef,
          idempotencyKey: body.data.idempotencyKey,
        }));
      } catch (error) {
        return mutationError(reply, error);
      }
    },
  );
}
