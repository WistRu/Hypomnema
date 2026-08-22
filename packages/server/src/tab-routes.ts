import {
  exactInstanceContentIngestErrorSchema,
  exactInstanceContentIngestResponseSchema,
  exactInstanceContentIngestSchema,
  ingestContentResponseSchema,
  ingestContentSchema,
  ingestSnapshotResponseSchema,
  ingestSnapshotSchema,
  legacyImportanceReviewQuerySchema,
  legacyImportanceReviewResponseSchema,
  logicalPageViewSchema,
  localTabListResponseSchema,
  patchTabSchema,
  prioritySearchModeConflictCode,
  prioritySearchModeConflictErrorSchema,
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  EmbeddingNotIndexedError,
  SimilarTabNotFoundError,
  type EmbeddingCatalog,
} from "./embedding-catalog.js";
import { sendEmbeddingError } from "./embedding-routes.js";
import type { LogicalPageCatalog } from "./logical-page-catalog.js";
import {
  ExactInstanceCaptureGrantError,
  type TabCommandRelay,
} from "./tab-command-relay.js";
import {
  ExactInstanceCaptureError,
  TabIdsNotFoundError,
  TabNotFoundError,
  type TabCatalog,
} from "./tab-catalog.js";
import { resolveExtensionOrigin } from "./request-security.js";
import {
  localAuthError,
  type LocalCapabilityService,
} from "./local-capability.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    issues,
  });
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

export function registerTabRoutes(
  app: FastifyInstance,
  tabCatalog: TabCatalog,
  embeddingCatalog: EmbeddingCatalog,
  logicalPageCatalog: LogicalPageCatalog,
  logicalImportanceEnabled: boolean,
  localCapabilities?: LocalCapabilityService,
  resourcesEnabled = false,
  priorityPersonalizationEnabled = false,
  tabCommandRelay?: TabCommandRelay,
  pageSummaryCaptureEnabled = false,
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

  if (pageSummaryCaptureEnabled) {
    app.post("/api/ingest/exact-instance-content", async (request, reply) => {
    if (resolveExtensionOrigin(request.headers) === undefined) {
      return reply.code(403).send({
        error: "EXTENSION_ORIGIN_REQUIRED",
        message: "Exact-instance capture ingest requires a browser extension origin.",
      });
    }
    const parsed = exactInstanceContentIngestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      if (tabCommandRelay === undefined) {
        throw new ExactInstanceCaptureGrantError(
          "CAPTURE_COMMAND_NOT_ACTIVE",
          "The exact-instance capture relay is unavailable.",
        );
      }
      return exactInstanceContentIngestResponseSchema.parse(
        tabCommandRelay.consumeExactInstanceCaptureGrant(
          parsed.data,
          () => tabCatalog.ingestExactInstanceContent(parsed.data),
        ),
      );
    } catch (error) {
      if (error instanceof ExactInstanceCaptureGrantError) {
        return reply.code(409).send(
          exactInstanceContentIngestErrorSchema.parse({
            error: error.code,
            message: error.message,
            recoverable: error.recoverable,
          }),
        );
      }
      if (error instanceof ExactInstanceCaptureError) {
        const statusCode = error.code === "CAPTURE_INSTANCE_MISSING"
          ? 404
          : error.code === "CAPTURE_PAGE_UNSUPPORTED"
            ? 422
            : 409;
        return reply.code(statusCode).send(
          exactInstanceContentIngestErrorSchema.parse({
            error: error.code,
            message: error.message,
            recoverable: error.recoverable,
            ...(error.observedUrl === undefined
              ? {}
              : { observedUrl: error.observedUrl }),
          }),
        );
      }
      throw error;
    }
    });
  }

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
      if (parsed.error.issues.some((issue) =>
        issue.message === prioritySearchModeConflictCode)) {
        return reply.code(409).send(prioritySearchModeConflictErrorSchema.parse({
          error: prioritySearchModeConflictCode,
          message: "Priority mode cannot be combined with relevance pagination",
        }));
      }
      return sendValidationError(reply, parsed.error.issues);
    }
    if (parsed.data.resource_id !== undefined && !resourcesEnabled) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "resources" });
    }
    if ((parsed.data.priority_mode !== undefined ||
        parsed.data.needs_review !== undefined) &&
        !priorityPersonalizationEnabled) {
      return reply.code(409).send({
        error: "FEATURE_DISABLED",
        feature: "priorityPersonalization",
      });
    }

    try {
      const embeddingFilters = {
        ...(parsed.data.browser === undefined
          ? {}
          : { browser: parsed.data.browser }),
        ...(parsed.data.duplicates_only
          ? { duplicatesOnly: true }
          : {}),
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
        ...(parsed.data.resource_id === undefined ? {} : { resourceId: parsed.data.resource_id }),
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
          duplicatesOnly: parsed.data.duplicates_only,
          isOpen: parsed.data.is_open,
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          priorityMode: parsed.data.priority_mode,
          needsReview: parsed.data.needs_review,
          sortBy: parsed.data.sort_by,
          sortDirection: parsed.data.sort_direction ?? "asc",
          q:
            parsed.data.search_mode === "fulltext"
              ? parsed.data.q
              : undefined,
          status: parsed.data.status,
          importance: parsed.data.importance,
          tag: parsed.data.tag,
          resourceId: parsed.data.resource_id,
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

  if (localCapabilities !== undefined) {
    app.get("/api/local/tabs", async (request, reply) => {
      if (!requireLocal(localCapabilities, request, reply)) return;
      const parsed = tabListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        if (parsed.error.issues.some((issue) =>
          issue.message === prioritySearchModeConflictCode)) {
          return reply.code(409).send(prioritySearchModeConflictErrorSchema.parse({
            error: prioritySearchModeConflictCode,
            message: "Priority mode cannot be combined with relevance pagination",
          }));
        }
        return sendValidationError(reply, parsed.error.issues);
      }
      if (parsed.data.resource_id !== undefined && !resourcesEnabled) {
        return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "resources" });
      }
      if ((parsed.data.priority_mode !== undefined ||
          parsed.data.needs_review !== undefined) &&
          !priorityPersonalizationEnabled) {
        return reply.code(409).send({
          error: "FEATURE_DISABLED",
          feature: "priorityPersonalization",
        });
      }
      try {
        const embeddingFilters = {
          ...(parsed.data.browser === undefined ? {} : { browser: parsed.data.browser }),
          ...(parsed.data.duplicates_only ? { duplicatesOnly: true } : {}),
          ...(parsed.data.is_open === undefined ? {} : { isOpen: parsed.data.is_open }),
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.importance === undefined ? {} : { importance: parsed.data.importance }),
          ...(parsed.data.tag === undefined ? {} : { tag: parsed.data.tag }),
          ...(parsed.data.resource_id === undefined ? {} : { resourceId: parsed.data.resource_id }),
        };
        const rankedPage =
          parsed.data.similar_to !== undefined
            ? embeddingCatalog.similarTabs(
                parsed.data.similar_to,
                parsed.data.page,
                parsed.data.pageSize,
                embeddingFilters,
              )
            : parsed.data.search_mode === "semantic" && parsed.data.q !== undefined
              ? await embeddingCatalog.semanticSearch(
                  parsed.data.q,
                  parsed.data.page,
                  parsed.data.pageSize,
                  embeddingFilters,
                )
              : undefined;
        return localTabListResponseSchema.parse(
          tabCatalog.listLocalTabs({
            browser: parsed.data.browser,
            duplicatesOnly: parsed.data.duplicates_only,
            isOpen: parsed.data.is_open,
            page: parsed.data.page,
            pageSize: parsed.data.pageSize,
            priorityMode: parsed.data.priority_mode,
            needsReview: parsed.data.needs_review,
            sortBy: parsed.data.sort_by,
            sortDirection: parsed.data.sort_direction ?? "asc",
            q: parsed.data.search_mode === "fulltext" ? parsed.data.q : undefined,
            status: parsed.data.status,
            importance: parsed.data.importance,
            tag: parsed.data.tag,
            resourceId: parsed.data.resource_id,
            ...(rankedPage === undefined ? {} : { rankedPage }),
          }),
        );
      } catch (error) {
        if (error instanceof SimilarTabNotFoundError) {
          return reply.code(404).send({ error: error.code, message: error.message, tabId: error.tabId });
        }
        if (error instanceof EmbeddingNotIndexedError) {
          return reply.code(409).send({ error: error.code, message: error.message, tabId: error.tabId });
        }
        return sendEmbeddingError(reply, error);
      }
    });

    app.get("/api/local/tabs/bulk-ids", async (request, reply) => {
      if (!requireLocal(localCapabilities, request, reply)) return;
      const parsed = tabBulkIdsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }
      if (parsed.data.resource_id !== undefined && !resourcesEnabled) {
        return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "resources" });
      }
      if (parsed.data.needs_review !== undefined && !priorityPersonalizationEnabled) {
        return reply.code(409).send({
          error: "FEATURE_DISABLED",
          feature: "priorityPersonalization",
        });
      }

      return tabBulkIdsResponseSchema.parse(
        tabCatalog.listLocalTabIds({
          browser: parsed.data.browser,
          duplicatesOnly: parsed.data.duplicates_only,
          isOpen: parsed.data.is_open,
          q: parsed.data.q,
          status: parsed.data.status,
          importance: parsed.data.importance,
          tag: parsed.data.tag,
          resourceId: parsed.data.resource_id,
          needsReview: parsed.data.needs_review,
        }),
      );
    });
  }

  app.get("/api/tabs/bulk-ids", async (request, reply) => {
    const parsed = tabBulkIdsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }
    if (parsed.data.resource_id !== undefined && !resourcesEnabled) {
      return reply.code(409).send({ error: "FEATURE_DISABLED", feature: "resources" });
    }
    if (parsed.data.needs_review !== undefined && !priorityPersonalizationEnabled) {
      return reply.code(409).send({
        error: "FEATURE_DISABLED",
        feature: "priorityPersonalization",
      });
    }

    return tabBulkIdsResponseSchema.parse(
      tabCatalog.listTabIds({
        browser: parsed.data.browser,
        duplicatesOnly: parsed.data.duplicates_only,
        isOpen: parsed.data.is_open,
        q: parsed.data.q,
        status: parsed.data.status,
        importance: parsed.data.importance,
        tag: parsed.data.tag,
        resourceId: parsed.data.resource_id,
        needsReview: parsed.data.needs_review,
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

  if (logicalImportanceEnabled) {
    app.get("/api/logical-pages/by-tab/:id", async (request, reply) => {
      const parsed = tabIdParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }

      const logicalPage = logicalPageCatalog.getByTabId(parsed.data.id);
      if (logicalPage === undefined) {
        return reply.code(404).send({
          error: "TAB_NOT_FOUND",
          message: `No tab exists with id ${parsed.data.id}`,
        });
      }
      return logicalPageViewSchema.parse(logicalPage);
    });

    app.get(
      "/api/logical-pages/importance-reviews",
      async (request, reply) => {
        const parsed = legacyImportanceReviewQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          return sendValidationError(reply, parsed.error.issues);
        }
        return legacyImportanceReviewResponseSchema.parse(
          logicalPageCatalog.listLegacyImportanceReviews(parsed.data),
        );
      },
    );
  }

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

  if (logicalImportanceEnabled) {
    app.patch("/api/agent/tabs/importance", async (request, reply) => {
      const parsed = setImportanceSchema.safeParse(request.body);

      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }

      try {
        return setImportanceResponseSchema.parse(
          tabCatalog.updateImportancesOnBehalfOfUser(parsed.data),
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
  }

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
