import {
  clusterInboxRequestSchema,
  clusterInboxResponseSchema,
  embeddingReindexRequestSchema,
  embeddingReindexResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  EmbeddingProviderUnavailableError,
  InvalidEmbeddingResultError,
  type EmbeddingCatalog,
} from "./embedding-catalog.js";
import { EmbeddingProviderError } from "./embedding-provider.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

export function sendEmbeddingError(reply: FastifyReply, error: unknown) {
  if (error instanceof EmbeddingProviderUnavailableError) {
    return reply.code(503).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof InvalidEmbeddingResultError) {
    return reply.code(502).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof EmbeddingProviderError) {
    return reply.code(error.kind === "unavailable" ? 503 : 502).send({
      error:
        error.kind === "unavailable"
          ? "EMBEDDING_PROVIDER_UNAVAILABLE"
          : "EMBEDDING_PROVIDER_ERROR",
      message: error.message,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { upstreamStatus: error.status }),
    });
  }

  throw error;
}

export function registerEmbeddingRoutes(
  app: FastifyInstance,
  catalog: EmbeddingCatalog,
): void {
  app.post("/api/embeddings/reindex", async (request, reply) => {
    const parsed = embeddingReindexRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return embeddingReindexResponseSchema.parse(
        await catalog.reindex(parsed.data.limit),
      );
    } catch (error) {
      return sendEmbeddingError(reply, error);
    }
  });

  app.post("/api/clusters/inbox", async (request, reply) => {
    const parsed = clusterInboxRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return clusterInboxResponseSchema.parse(
        await catalog.clusterInbox(parsed.data.maxClusters),
      );
    } catch (error) {
      return sendEmbeddingError(reply, error);
    }
  });
}
