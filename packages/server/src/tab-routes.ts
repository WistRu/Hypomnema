import {
  ingestContentResponseSchema,
  ingestContentSchema,
  ingestSnapshotResponseSchema,
  ingestSnapshotSchema,
  patchTabStatusResponseSchema,
  patchTabStatusSchema,
  setStatusResponseSchema,
  setStatusSchema,
  tabDetailResponseSchema,
  tabIdParamSchema,
  tabListQuerySchema,
  tabListResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  TabIdsNotFoundError,
  TabNotFoundError,
  type TabCatalog,
} from "./tab-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    issues,
  });
}

export function registerTabRoutes(
  app: FastifyInstance,
  tabCatalog: TabCatalog,
): void {
  app.post("/api/ingest/content", async (request, reply) => {
    const parsed = ingestContentSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return ingestContentResponseSchema.parse(
        tabCatalog.ingestContent(parsed.data),
      );
    } catch (error) {
      if (error instanceof TabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.post("/api/ingest/snapshot", async (request, reply) => {
    const parsed = ingestSnapshotSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    return ingestSnapshotResponseSchema.parse(
      tabCatalog.ingestSnapshot(parsed.data),
    );
  });

  app.get("/api/tabs", async (request, reply) => {
    const parsed = tabListQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    return tabListResponseSchema.parse(
      tabCatalog.listTabs({
        browser: parsed.data.browser,
        isOpen: parsed.data.is_open,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        q: parsed.data.q,
        status: parsed.data.status,
        importance: parsed.data.importance,
      }),
    );
  });

  app.get("/api/tabs/:id", async (request, reply) => {
    const parsed = tabIdParamSchema.safeParse(request.params);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const tab = tabCatalog.getTab(parsed.data.id);

    if (tab === undefined) {
      return reply.code(404).send({
        error: "TAB_NOT_FOUND",
        message: `No tab exists with id ${parsed.data.id}`,
      });
    }

    return tabDetailResponseSchema.parse(tab);
  });

  app.patch("/api/tabs/status", async (request, reply) => {
    const parsed = setStatusSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return setStatusResponseSchema.parse(
        tabCatalog.updateStatuses(parsed.data),
      );
    } catch (error) {
      if (error instanceof TabIdsNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          missingIds: error.missingIds,
        });
      }

      throw error;
    }
  });

  app.patch("/api/tabs/:id", async (request, reply) => {
    const params = tabIdParamSchema.safeParse(request.params);
    const body = patchTabStatusSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    const result = tabCatalog.updateStatus(params.data.id, body.data.status);

    if (result === undefined) {
      return reply.code(404).send({
        error: "TAB_NOT_FOUND",
        message: `No tab exists with id ${params.data.id}`,
      });
    }

    return patchTabStatusResponseSchema.parse(result);
  });
}
