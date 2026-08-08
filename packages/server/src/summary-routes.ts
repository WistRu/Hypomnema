import {
  jobIdParamSchema,
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  summarizeTabSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  SummaryContentMissingError,
  SummaryTabNotFoundError,
  type SummaryCatalog,
} from "./summary-catalog.js";
import type { SummaryProvider } from "./summary-provider.js";
import type { SummaryWorker } from "./summary-worker.js";

export interface SummaryRouteOptions {
  catalog: SummaryCatalog;
  provider: SummaryProvider | undefined;
  worker: SummaryWorker | undefined;
  maxAttempts: number;
}

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

export function registerSummaryRoutes(
  app: FastifyInstance,
  options: SummaryRouteOptions,
): void {
  app.post("/api/tabs/:id/summarize", async (request, reply) => {
    const params = jobIdParamSchema.safeParse(request.params);
    const body = summarizeTabSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    if (options.provider === undefined || options.worker === undefined) {
      return reply.code(503).send({
        error: "SUMMARY_PROVIDER_UNAVAILABLE",
        message:
          "Configure ANTHROPIC_API_KEY before requesting summaries",
      });
    }

    try {
      const result = options.catalog.enqueue(params.data.id, body.data.depth, {
        maxAttempts: options.maxAttempts,
        requestedBy: body.data.requestedBy,
        requestedModel: options.provider.modelFor(body.data.depth),
      });
      options.worker.wake();
      return reply.code(202).send(summaryEnqueueResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof SummaryTabNotFoundError) {
        return reply.code(404).send({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof SummaryContentMissingError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const params = jobIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return sendValidationError(reply, params.error.issues);
    }

    const job = options.catalog.getJob(params.data.id);
    if (job === undefined) {
      return reply.code(404).send({
        error: "SUMMARY_JOB_NOT_FOUND",
        message: `No summary job exists with id ${params.data.id}`,
      });
    }

    return summaryJobSchema.parse(job);
  });
}
