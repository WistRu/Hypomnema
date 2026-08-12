import {
  healthResponseSchema,
  tabHubHttpBodyLimitBytes,
  type HealthResponse,
} from "@tabhub/shared";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { openDatabase } from "./database.js";
import { createTabCatalog } from "./tab-catalog.js";
import { registerTabRoutes } from "./tab-routes.js";
import { createTabInstanceCatalog } from "./tab-instance-catalog.js";
import { registerTabInstanceRoutes } from "./tab-instance-routes.js";
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
import { createGraphV2Catalog } from "./graph-v2-catalog.js";
import { registerGraphV2Routes } from "./graph-v2-routes.js";
import { createRelationCatalog } from "./relation-catalog.js";
import { registerRelationRoutes } from "./relation-routes.js";
import { registerRequestSecurity } from "./request-security.js";
import { createWorkspaceCatalog } from "./workspace-catalog.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";
import {
  createTabCommandRelay,
  registerTabCommandRelayRoutes,
} from "./tab-command-relay.js";
import type { BrowserForegroundHandoff } from "./browser-foreground.js";
import { createActivityCatalog } from "./activity-catalog.js";
import { registerActivityRoutes } from "./activity-routes.js";
import { createRetentionCatalog } from "./retention-catalog.js";
import { registerRetentionRoutes } from "./retention-routes.js";
import { createRetentionLifecycle } from "./retention-lifecycle.js";

export interface CreateAppOptions {
  browserForegroundHandoff?: BrowserForegroundHandoff | undefined;
  databasePath: string;
  logger?: boolean | FastifyBaseLogger;
  clock?: () => Date;
  webRoot?: string | false;
  summaryProvider?: SummaryProvider;
  summaryDailyLimit?: number;
  summaryMaxAttempts?: number;
  summaryWorkerPollMs?: number;
  embeddingProvider?: EmbeddingProvider;
  tabCommandRelayAppOrigins?: readonly string[];
  tabCommandRelayCommandTimeoutMs?: number;
  tabCommandRelayHeartbeatIntervalMs?: number;
  tabCommandRelayHeartbeatTimeoutMs?: number;
  tabCommandRelayRegistrationTimeoutMs?: number;
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
  void app.register(websocket, {
    options: { maxPayload: tabHubHttpBodyLimitBytes },
  });
  const tabInstanceCatalog = createTabInstanceCatalog(database.connection);
  const tabCatalog = createTabCatalog(
    database.connection,
    tabInstanceCatalog,
    options.clock,
  );
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
  const graphV2Catalog = createGraphV2Catalog(database.connection);
  const relationCatalog = createRelationCatalog(database.connection);
  const workspaceCatalog = createWorkspaceCatalog(
    database.connection,
    options.clock,
  );
  const activityCatalog = createActivityCatalog(
    database.connection,
    options.clock,
  );
  const tabCommandRelay = createTabCommandRelay({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.tabCommandRelayCommandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.tabCommandRelayCommandTimeoutMs }),
    ...(options.tabCommandRelayHeartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.tabCommandRelayHeartbeatIntervalMs }),
    ...(options.tabCommandRelayHeartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.tabCommandRelayHeartbeatTimeoutMs }),
    ...(options.tabCommandRelayRegistrationTimeoutMs === undefined
      ? {}
      : {
          registrationTimeoutMs:
            options.tabCommandRelayRegistrationTimeoutMs,
        }),
  });
  const retentionCatalog = createRetentionCatalog(
    database.connection,
    tabCatalog,
    options.clock,
  );
  const retentionLifecycle = createRetentionLifecycle({
    catalog: retentionCatalog,
    relay: tabCommandRelay,
    tabInstanceCatalog,
  });
  let retentionPurgeTimer: NodeJS.Timeout | undefined;
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
    retentionCatalog.purgeDue();
    retentionPurgeTimer = setInterval(
      () => retentionCatalog.purgeDue(),
      60 * 60 * 1_000,
    );
    retentionPurgeTimer.unref();
    summaryWorker?.start();
  });

  app.addHook("onClose", async () => {
    if (retentionPurgeTimer !== undefined) {
      clearInterval(retentionPurgeTimer);
      retentionPurgeTimer = undefined;
    }
    tabCommandRelay.close();
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
  registerActivityRoutes(app, activityCatalog);
  registerRetentionRoutes(app, retentionLifecycle);
  registerTabInstanceRoutes(app, tabInstanceCatalog, tabCatalog);
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
  registerGraphV2Routes(app, graphV2Catalog);
  registerRelationRoutes(app, relationCatalog);
  registerWorkspaceRoutes(app, workspaceCatalog);
  void app.register(async (relayApp) => {
    registerTabCommandRelayRoutes(relayApp, tabCommandRelay, {
      ...(options.tabCommandRelayAppOrigins === undefined
        ? {}
        : { appOrigins: options.tabCommandRelayAppOrigins }),
      ...(options.browserForegroundHandoff === undefined
        ? {}
        : { browserForegroundHandoff: options.browserForegroundHandoff }),
    });
  });

  return app;
}
