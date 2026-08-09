import {
  ingestContentResponseSchema,
  ingestContentSchema,
  ingestSnapshotResponseSchema,
  ingestSnapshotSchema,
  patchTabSchema,
  setImportanceResponseSchema,
  setImportanceSchema,
  setStatusResponseSchema,
  setStatusSchema,
  tabBulkIdsQuerySchema,
  tabBulkIdsResponseSchema,
  tabDetailResponseSchema,
  tabIdParamSchema,
  tabListQuerySchema,
  tabListResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  EmbeddingNotIndexedError,
  SimilarTabNotFoundError,
  type EmbeddingCatalog,
} from "./embedding-catalog.js";
import { sendEmbeddingError } from "./embedding-routes.js";
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
  embeddingCatalog: EmbeddingCatalog,
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

    try {
      const embeddingFilters = {
        ...(parsed.data.browser === undefined
          ? {}
          : { browser: parsed.data.browser }),
        ...(parsed.data.is_open === undefined
          ? {}
          : { isOpen: parsed.data.is_open }),
        ...(parsed.data.status === undefined
          ? {}
          : { status: parsed.data.status }),
        ...(parsed.data.importance === undefined
          ? {}
          : { importance: parsed.data.importance }),
        ...(parsed.data.tag === undefined ? {} : { tag: parsed.data.tag }),
      };
      const rankedPage =
        parsed.data.similar_to !== undefined
          ? embeddingCatalog.similarTabs(
              parsed.data.similar_to,
              parsed.data.page,
              parsed.data.pageSize,
              embeddingFilters,
            )
          : parsed.data.search_mode === "semantic" &&
              parsed.data.q !== undefined
            ? await embeddingCatalog.semanticSearch(
                parsed.data.q,
                parsed.data.page,
                parsed.data.pageSize,
                embeddingFilters,
              )
            : undefined;

      return tabListResponseSchema.parse(
        tabCatalog.listTabs({
          browser: parsed.data.browser,
          isOpen: parsed.data.is_open,
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          q:
            parsed.data.search_mode === "fulltext"
              ? parsed.data.q
              : undefined,
          status: parsed.data.status,
          importance: parsed.data.importance,
          tag: parsed.data.tag,
          ...(rankedPage === undefined ? {} : { rankedPage }),
        }),
      );
    } catch (error) {
      if (error instanceof SimilarTabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }
      if (error instanceof EmbeddingNotIndexedError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
          tabId: error.tabId,
        });
      }

      return sendEmbeddingError(reply, error);
    }
  });

  app.get("/api/tabs/bulk-ids", async (request, reply) => {
    const parsed = tabBulkIdsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    return tabBulkIdsResponseSchema.parse(
      tabCatalog.listTabIds({
        browser: parsed.data.browser,
        isOpen: parsed.data.is_open,
        q: parsed.data.q,
        status: parsed.data.status,
        importance: parsed.data.importance,
        tag: parsed.data.tag,
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

  app.patch("/api/tabs/importance", async (request, reply) => {
    const parsed = setImportanceSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return setImportanceResponseSchema.parse(
        tabCatalog.updateImportances(parsed.data),
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
    const body = patchTabSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    const result = tabCatalog.updateTab(params.data.id, body.data);

    if (result === undefined) {
      return reply.code(404).send({
        error: "TAB_NOT_FOUND",
        message: `No tab exists with id ${params.data.id}`,
      });
    }

    return tabDetailResponseSchema.parse(result);
  });
}
