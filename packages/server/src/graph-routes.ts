import { graphQuerySchema, graphResponseSchema } from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { GraphCatalog } from "./graph-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

export function registerGraphRoutes(
  app: FastifyInstance,
  catalog: GraphCatalog,
): void {
  app.get("/api/graph", async (request, reply) => {
    const parsed = graphQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    return graphResponseSchema.parse(catalog.getGraph(parsed.data.root_tag));
  });
}
