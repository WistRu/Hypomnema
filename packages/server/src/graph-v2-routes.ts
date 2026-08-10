import { graphV2QuerySchema, graphV2ResponseSchema } from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { GraphV2Catalog } from "./graph-v2-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

export function registerGraphV2Routes(
  app: FastifyInstance,
  catalog: GraphV2Catalog,
): void {
  app.get("/api/graph/v2", async (request, reply) => {
    const parsed = graphV2QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const { focus_node_type, focus_node_id, focus_depth } = parsed.data;
    const focus =
      focus_node_type !== undefined &&
      focus_node_id !== undefined &&
      focus_depth !== undefined
        ? {
            node: { type: focus_node_type, id: focus_node_id },
            depth: focus_depth,
          }
        : undefined;

    return graphV2ResponseSchema.parse(
      catalog.getGraph(parsed.data.root_topic_id, focus),
    );
  });
}
