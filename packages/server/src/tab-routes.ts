import {
  ingestSnapshotResponseSchema,
  ingestSnapshotSchema,
  tabListQuerySchema,
  tabListResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { TabCatalog } from "./tab-catalog.js";

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
      }),
    );
  });
}
