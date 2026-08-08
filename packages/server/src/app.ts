import {
  healthResponseSchema,
  tabHubHttpBodyLimitBytes,
  type HealthResponse,
} from "@tabhub/shared";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { openDatabase } from "./database.js";
import { createTabCatalog } from "./tab-catalog.js";
import { registerTabRoutes } from "./tab-routes.js";
import { createTagCatalog } from "./tag-catalog.js";
import { registerTagRoutes } from "./tag-routes.js";
import { createStatsCatalog } from "./stats-catalog.js";
import { registerStatsRoutes } from "./stats-routes.js";
import { createSummaryCatalog } from "./summary-catalog.js";
import type { SummaryProvider } from "./summary-provider.js";
import { registerSummaryRoutes } from "./summary-routes.js";
import { createSummaryWorker } from "./summary-worker.js";
import { createLinkCatalog } from "./link-catalog.js";
import { registerLinkRoutes } from "./link-routes.js";
import { createEmbeddingCatalog } from "./embedding-catalog.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { registerEmbeddingRoutes } from "./embedding-routes.js";
import { createGraphCatalog } from "./graph-catalog.js";
import { registerGraphRoutes } from "./graph-routes.js";
import { registerRequestSecurity } from "./request-security.js";

export interface CreateAppOptions {
  databasePath: string;
  logger?: boolean | FastifyBaseLogger;
  clock?: () => Date;
  webRoot?: string | false;
  summaryProvider?: SummaryProvider;
  summaryDailyLimit?: number;
  summaryMaxAttempts?: number;
  summaryWorkerPollMs?: number;
  embeddingProvider?: EmbeddingProvider;
}

export type TabHubApp = FastifyInstance;

function positiveIntegerOption(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export function createApp(options: CreateAppOptions): TabHubApp {
  const summaryDailyLimit = positiveIntegerOption(
    "summaryDailyLimit",
    options.summaryDailyLimit ?? 100,
  );
  const summaryMaxAttempts = positiveIntegerOption(
    "summaryMaxAttempts",
    options.summaryMaxAttempts ?? 5,
  );
  if (options.summaryWorkerPollMs !== undefined) {
    positiveIntegerOption("summaryWorkerPollMs", options.summaryWorkerPollMs);
  }

  const database = openDatabase(options.databasePath);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: tabHubHttpBodyLimitBytes,
  });
  registerRequestSecurity(app);
  const tabCatalog = createTabCatalog(database.connection, options.clock);
  const tagCatalog = createTagCatalog(database.connection);
  const statsCatalog = createStatsCatalog(database.connection);
  const summaryCatalog = createSummaryCatalog(database.connection, options.clock);
  const linkCatalog = createLinkCatalog(database.connection);
  const embeddingCatalog = createEmbeddingCatalog(
    database.connection,
    options.embeddingProvider,
    options.clock,
  );
  const graphCatalog = createGraphCatalog(database.connection);
  const summaryWorker =
    options.summaryProvider === undefined
      ? undefined
      : createSummaryWorker(summaryCatalog, options.summaryProvider, {
          dailyLimit: summaryDailyLimit,
          ...(options.summaryWorkerPollMs === undefined
            ? {}
            : { pollMs: options.summaryWorkerPollMs }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          onCompleted(job) {
            app.log.info(
              {
                jobId: job.id,
                tabId: job.tabId,
                model: job.result?.model,
                inputTokens: job.result?.usage.inputTokens,
                outputTokens: job.result?.usage.outputTokens,
                costUsd: job.result?.usage.costUsd,
              },
              "summary job completed",
            );
          },
          onFailed(job) {
            app.log.warn(
              { jobId: job.id, tabId: job.tabId, error: job.error },
              "summary job failed",
            );
          },
          onError(error) {
            app.log.error(error, "summary worker loop failed");
          },
        });

  void app.register(cors, {
    origin: [
      /^chrome-extension:\/\//,
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/,
    ],
  });

  if (options.webRoot) {
    void app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: "/app/",
    });
    app.get("/app", async (_request, reply) => reply.redirect("/app/"));
  }

  app.addHook("onReady", async () => {
    summaryWorker?.start();
  });

  app.addHook("onClose", async () => {
    await summaryWorker?.stop();
    database.close();
  });

  app.get("/api/health", async (): Promise<HealthResponse> =>
    healthResponseSchema.parse({
      status: "ok",
      database: "ok",
      schemaVersion: database.schemaVersion,
    }),
  );

  registerTabRoutes(app, tabCatalog, embeddingCatalog);
  registerTagRoutes(app, tagCatalog);
  registerStatsRoutes(app, statsCatalog);
  registerSummaryRoutes(app, {
    catalog: summaryCatalog,
    provider: options.summaryProvider,
    worker: summaryWorker,
    maxAttempts: summaryMaxAttempts,
  });
  registerLinkRoutes(app, linkCatalog);
  registerEmbeddingRoutes(app, embeddingCatalog);
  registerGraphRoutes(app, graphCatalog);

  return app;
}
