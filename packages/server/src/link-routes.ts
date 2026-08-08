import {
  createLinkSchema,
  deleteResponseSchema,
  linkIdParamSchema,
  linkListQuerySchema,
  linkListResponseSchema,
  patchLinkSchema,
  tabLinkSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  LinkTabsNotFoundError,
  SelfLinkError,
  type LinkCatalog,
} from "./link-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    issues,
  });
}

function sendMissingLink(reply: FastifyReply, id: number) {
  return reply.code(404).send({
    error: "LINK_NOT_FOUND",
    message: `No link exists with id ${id}`,
  });
}

export function registerLinkRoutes(
  app: FastifyInstance,
  linkCatalog: LinkCatalog,
): void {
  app.get("/api/links", async (request, reply) => {
    const parsed = linkListQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    return linkListResponseSchema.parse(
      linkCatalog.listLinks(parsed.data.tab_id),
    );
  });

  app.post("/api/links", async (request, reply) => {
    const parsed = createLinkSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return reply
        .code(201)
        .send(tabLinkSchema.parse(linkCatalog.createLink(parsed.data)));
    } catch (error) {
      if (error instanceof LinkTabsNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          missingIds: error.missingIds,
        });
      }
      if (error instanceof SelfLinkError) {
        return reply.code(400).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }

      throw error;
    }
  });

  app.patch("/api/links/:id", async (request, reply) => {
    const params = linkIdParamSchema.safeParse(request.params);
    const body = patchLinkSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    const link = linkCatalog.updateLink(params.data.id, body.data);
    if (link === undefined) {
      return sendMissingLink(reply, params.data.id);
    }

    return tabLinkSchema.parse(link);
  });

  app.delete("/api/links/:id", async (request, reply) => {
    const parsed = linkIdParamSchema.safeParse(request.params);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    if (!linkCatalog.deleteLink(parsed.data.id)) {
      return sendMissingLink(reply, parsed.data.id);
    }

    return deleteResponseSchema.parse({ deleted: true });
  });
}
