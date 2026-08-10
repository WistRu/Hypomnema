import {
  createKnowledgeRelationSchema,
  deleteResponseSchema,
  knowledgeRelationListResponseSchema,
  knowledgeRelationSchema,
  patchKnowledgeRelationSchema,
  relationIdParamSchema,
  relationListQuerySchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  RelationEndpointsNotFoundError,
  SelfRelationError,
  type RelationCatalog,
} from "./relation-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function sendMissingRelation(reply: FastifyReply, id: number) {
  return reply.code(404).send({
    error: "RELATION_NOT_FOUND",
    message: `No relation exists with id ${id}`,
  });
}

export function registerRelationRoutes(
  app: FastifyInstance,
  catalog: RelationCatalog,
): void {
  app.get("/api/relations", async (request, reply) => {
    const parsed = relationListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const node =
      parsed.data.node_type === undefined || parsed.data.node_id === undefined
        ? undefined
        : { type: parsed.data.node_type, id: parsed.data.node_id };
    return knowledgeRelationListResponseSchema.parse(
      catalog.listRelations(node),
    );
  });

  app.post("/api/relations", async (request, reply) => {
    const parsed = createKnowledgeRelationSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return reply
        .code(201)
        .send(knowledgeRelationSchema.parse(catalog.createRelation(parsed.data)));
    } catch (error) {
      if (error instanceof RelationEndpointsNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          missing: error.missing,
        });
      }
      if (error instanceof SelfRelationError) {
        return reply.code(400).send({
          error: error.code,
          message: error.message,
          node: error.node,
        });
      }

      throw error;
    }
  });

  app.patch("/api/relations/:id", async (request, reply) => {
    const params = relationIdParamSchema.safeParse(request.params);
    const body = patchKnowledgeRelationSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    const relation = catalog.updateRelation(params.data.id, body.data);
    if (relation === undefined) {
      return sendMissingRelation(reply, params.data.id);
    }

    return knowledgeRelationSchema.parse(relation);
  });

  app.delete("/api/relations/:id", async (request, reply) => {
    const parsed = relationIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    if (!catalog.deleteRelation(parsed.data.id)) {
      return sendMissingRelation(reply, parsed.data.id);
    }

    return deleteResponseSchema.parse({ deleted: true });
  });
}
