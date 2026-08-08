import { statsResponseSchema } from "@tabhub/shared";
import type { FastifyInstance } from "fastify";

import type { StatsCatalog } from "./stats-catalog.js";

export function registerStatsRoutes(
  app: FastifyInstance,
  statsCatalog: StatsCatalog,
): void {
  app.get("/api/stats", async () =>
    statsResponseSchema.parse(statsCatalog.getStats()),
  );
}
