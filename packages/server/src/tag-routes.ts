import {
  assignTagsResponseSchema,
  assignTagsSchema,
  tagTreeResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { TabsNotFoundError, type TagCatalog } from "./tag-catalog.js";

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

  app.get("/api/tags", async () =>
    tagTreeResponseSchema.parse(tagCatalog.listTags()),
  );
}
