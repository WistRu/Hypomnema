import {
  duplicateGroupListQuerySchema,
  duplicateGroupListResponseSchema,
  tabInstanceBulkQuerySchema,
  tabInstanceBulkResponseSchema,
  tabInstanceListQuerySchema,
  tabInstanceListResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import type { TabInstanceCatalog } from "./tab-instance-catalog.js";

export function registerTabInstanceRoutes(
  app: FastifyInstance,
  catalog: TabInstanceCatalog,
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
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  });
}
