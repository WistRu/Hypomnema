import {
  assignTagsResponseSchema,
  assignTagsSchema,
  createTagSchema,
  deleteResponseSchema,
  patchTagSchema,
  tagIdParamSchema,
  tagRecordSchema,
  tabTagIdsParamSchema,
  tagTreeResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  TagConflictError,
  TagAssignmentNotFoundError,
  TagHasChildrenError,
  TagHierarchyConflictError,
  TagNotFoundError,
  TabsNotFoundError,
  type TagCatalog,
} from "./tag-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    issues,
  });
}

export function registerTagRoutes(
  app: FastifyInstance,
  tagCatalog: TagCatalog,
): void {
  app.post("/api/tags/assign", async (request, reply) => {
    const parsed = assignTagsSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return assignTagsResponseSchema.parse(tagCatalog.assignTags(parsed.data));
    } catch (error) {
      if (error instanceof TabsNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          missingIds: error.missingIds,
        });
      }

      throw error;
    }
  });

  app.delete("/api/tabs/:tabId/tags/:tagId", async (request, reply) => {
    const parsed = tabTagIdsParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      tagCatalog.unassignTag(parsed.data.tabId, parsed.data.tagId);
      return deleteResponseSchema.parse({ deleted: true });
    } catch (error) {
      if (error instanceof TabsNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          missingIds: error.missingIds,
        });
      }
      if (
        error instanceof TagNotFoundError ||
        error instanceof TagAssignmentNotFoundError
      ) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.post("/api/tags", async (request, reply) => {
    const parsed = createTagSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return reply
        .code(201)
        .send(tagRecordSchema.parse(tagCatalog.createTag(parsed.data)));
    } catch (error) {
      if (error instanceof TagNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof TagConflictError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.patch("/api/tags/:id", async (request, reply) => {
    const params = tagIdParamSchema.safeParse(request.params);
    const body = patchTagSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    try {
      return tagRecordSchema.parse(
        tagCatalog.updateTag(params.data.id, body.data),
      );
    } catch (error) {
      if (error instanceof TagNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }
      if (
        error instanceof TagConflictError ||
        error instanceof TagHierarchyConflictError
      ) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.delete("/api/tags/:id", async (request, reply) => {
    const parsed = tagIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      tagCatalog.deleteTag(parsed.data.id);
      return deleteResponseSchema.parse({ deleted: true });
    } catch (error) {
      if (error instanceof TagNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof TagHasChildrenError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.get("/api/tags", async () =>
    tagTreeResponseSchema.parse(tagCatalog.listTags()),
  );
}
