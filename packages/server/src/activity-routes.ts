import {
  activityIngestMetricsResponseSchema,
  activityWindowQuerySchema,
  ingestActivityResponseSchema,
  ingestActivitySchema,
  logicalPageActivityResponseSchema,
  logicalPageParamSchema,
} from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import {
  ActivityEventConflictError,
  ActivityEventInFutureError,
  type ActivityCatalog,
} from "./activity-catalog.js";

export function registerActivityRoutes(
  app: FastifyInstance,
  catalog: ActivityCatalog,
  windowReadersEnabled = false,
): void {
  app.post("/api/ingest/activity", async (request, reply) => {
    const parsed = ingestActivitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_ACTIVITY",
        message: parsed.error.message,
      });
    }

    try {
      return ingestActivityResponseSchema.parse(
        catalog.ingestActivity(parsed.data),
      );
    } catch (error) {
      if (error instanceof ActivityEventConflictError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof ActivityEventInFutureError) {
        return reply.code(400).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  if (!windowReadersEnabled) return;

  app.get("/api/activity/metrics", async () =>
    activityIngestMetricsResponseSchema.parse(catalog.metrics()),
  );

  app.get("/api/logical-pages/:logicalPageId/activity", async (request, reply) => {
    const params = logicalPageParamSchema.safeParse(request.params);
    const query = activityWindowQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: "INVALID_ACTIVITY_QUERY",
        issues: [
          ...(params.success ? [] : params.error.issues),
          ...(query.success ? [] : query.error.issues),
        ],
      });
    }
    const activity = catalog.pageActivity(params.data.logicalPageId, query.data.window);
    return activity === undefined
      ? reply.code(404).send({ error: "NOT_FOUND" })
      : logicalPageActivityResponseSchema.parse({
          logicalPageId: params.data.logicalPageId,
          activity,
        });
  });
}
