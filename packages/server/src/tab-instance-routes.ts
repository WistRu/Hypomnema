import {
  duplicateGroupBulkQuerySchema,
  duplicateGroupBulkResponseSchema,
  duplicateGroupListQuerySchema,
  duplicateGroupListResponseSchema,
  tabInstanceBulkQuerySchema,
  tabInstanceBulkResponseSchema,
  tabInstanceListQuerySchema,
  tabInstanceListResponseSchema,
  tabBulkIdsQuerySchema,
  tabIdParamSchema,
} from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import type { TabInstanceCatalog } from "./tab-instance-catalog.js";
import type { TabCatalog } from "./tab-catalog.js";

export function registerTabInstanceRoutes(
  app: FastifyInstance,
  catalog: TabInstanceCatalog,
  tabCatalog: TabCatalog,
): void {
  app.get("/api/tab-instances", async (request, reply) => {
    const parsed = tabInstanceListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    return tabInstanceListResponseSchema.parse(
      catalog.listInstances({
        browser: parsed.data.browser,
        q: parsed.data.q,
        duplicatesOnly: parsed.data.duplicates_only,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  });

  app.get("/api/tab-instances/bulk", async (request, reply) => {
    const parsed = tabInstanceBulkQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    return tabInstanceBulkResponseSchema.parse(
      catalog.listAllInstances({
        browser: parsed.data.browser,
        q: parsed.data.q,
        duplicatesOnly: parsed.data.duplicates_only,
      }),
    );
  });

  app.get("/api/tab-instances/library-bulk", async (request, reply) => {
    const parsed = tabBulkIdsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    const canonicalTabs = tabCatalog.listTabIds({
      browser: parsed.data.browser,
      duplicatesOnly: parsed.data.duplicates_only,
      isOpen: parsed.data.is_open,
      q: parsed.data.q,
      status: parsed.data.status,
      importance: parsed.data.importance,
      tag: parsed.data.tag,
    });
    return tabInstanceBulkResponseSchema.parse(
      catalog.listInstancesForCanonicalTabs(canonicalTabs.ids),
    );
  });

  app.get("/api/tabs/:id/instances", async (request, reply) => {
    const parsed = tabIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    return tabInstanceBulkResponseSchema.parse(
      catalog.listAllInstances({
        browser: undefined,
        canonicalTabId: parsed.data.id,
        q: undefined,
        duplicatesOnly: false,
      }),
    );
  });

  app.get("/api/duplicate-groups", async (request, reply) => {
    const parsed = duplicateGroupListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    return duplicateGroupListResponseSchema.parse(
      catalog.listDuplicateGroups({
        browser: parsed.data.browser,
        q: parsed.data.q,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  });

  app.get("/api/duplicate-groups/bulk", async (request, reply) => {
    const parsed = duplicateGroupBulkQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues,
      });
    }

    return duplicateGroupBulkResponseSchema.parse(
      catalog.listAllDuplicateGroups({
        browser: parsed.data.browser,
        q: parsed.data.q,
      }),
    );
  });
}
