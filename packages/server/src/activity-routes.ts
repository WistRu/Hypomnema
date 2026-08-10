import {
  ingestActivityResponseSchema,
  ingestActivitySchema,
} from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import {
  ActivityEventConflictError,
  type ActivityCatalog,
} from "./activity-catalog.js";

export function registerActivityRoutes(
  app: FastifyInstance,
  catalog: ActivityCatalog,
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
      throw error;
    }
  });
}
