import {
  featureFlagsResponseSchema,
  healthResponseSchema,
  tabHubHttpBodyLimitBytes,
  type HealthResponse,
} from "@tabhub/shared";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { openDatabase, type TabHubDatabase } from "./database.js";
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
import { isTopLevelAppNavigation } from "./request-security.js";
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
import { createLogicalPageCatalog } from "./logical-page-catalog.js";
import {
  personalAttentionFeatureFlagsOff,
  resolveAgentUserImportanceFeature,
  resolveEffectivePriorityFeatureFlags,
  resolveEffectiveResearchFeature,
  type PersonalAttentionFeatureFlags,
} from "./attention-feature-flags.js";
import { createContextLedger } from "./context-ledger.js";
import {
  createSessionIntentLedger,
  createSessionIntentReconciler,
} from "./session-intent-ledger.js";
import { createLocalCapabilityService } from "./local-capability.js";
import { registerContextRoutes } from "./context-routes.js";
import { createResourceCatalog } from "./resource-catalog.js";
import { createResourceCommandCatalog } from "./resource-command-catalog.js";
import { createResourceReadCatalog } from "./resource-read-catalog.js";
import { registerResourceRoutes } from "./resource-routes.js";
import { registerLocalCapabilityRoutes } from "./local-capability-routes.js";
import { createAiJobLedger, type AiJobLedger } from "./ai-job-ledger.js";
import { createDurableAiJobs } from "./durable-ai-jobs.js";
import {
  createPriorityAssessmentCoordinator,
  type PriorityAssessmentCoordinator,
} from
  "./priority-assessment-coordinator.js";
import { registerPriorityRoutes } from "./priority-routes.js";
import { createPriorityFeatureCatalog } from "./priority-feature-catalog.js";
import { createPersonalPriorityRulesCatalog } from "./personal-priority-rules.js";
import { registerPersonalPriorityRuleRoutes } from "./personal-priority-rule-routes.js";
import { createSummaryJobAdapter } from "./summary-job-adapter.js";
import { createAiJobRuntime } from "./ai-job-runtime.js";
import { createAiJobRuntimeCursorStore } from "./ai-job-runtime-state.js";
import { createAgentUserImportanceCatalog } from
  "./agent-user-importance-catalog.js";
import { registerAgentUserImportanceRoutes } from
  "./agent-user-importance-routes.js";
import { registerAiJobRoutes } from "./ai-job-routes.js";
import {
  buildCurrentResearchProjection,
  createResearchStore,
  researchParentAvailability,
} from "./research-store.js";
import { createResearchWorkflow } from "./research-workflow.js";
import { createResearchReportCatalog } from "./research-report-catalog.js";
import { registerResearchRoutes } from "./research-routes.js";
import { registerAgentResearchRoutes } from "./agent-research-routes.js";
import type { ResearchProvider } from "./research-provider.js";
import { createResearchCorpusReader } from "./research-corpus.js";
import { createResearchWorker } from "./research-worker.js";
import { createLiveAcquisitionActionLedger } from
  "./live-acquisition-action-ledger.js";
import { createLiveAcquisitionMaterializer } from
  "./live-acquisition-materializer.js";
import { createLiveAcquisitionHandoff } from "./live-acquisition-handoff.js";
import {
  createCompositeResourceResearchAdapter,
  createResearchAcquisitionCoordinator,
  createTrackedC90ClaimExecutor,
  checkpointC90PersistedTerminalPages,
  executeC90DynamicActionPlan,
  selectC90NextPlannedActionId,
  type ResearchAcquisitionCoordinatorOptions,
} from "./research-acquisition-coordinator.js";
import { createLiveAcquisitionWorkflow } from "./live-acquisition-workflow.js";
import { registerLiveAcquisitionRoutes } from "./live-acquisition-routes.js";
import { createLiveAcquisitionStatusReader } from "./live-acquisition-status-reader.js";
import { DurableAiJobError } from "./durable-ai-jobs.js";
import { createPrivacyPurgeCoordinator } from "./privacy-purge-coordinator.js";
import { createPrivacyPurgeRuntime } from "./privacy-purge-runtime.js";
import { registerPrivacyPurgeRoutes } from "./privacy-purge-routes.js";
import type { PrivacyPurgeFinalSettlementVerifier } from
  "./privacy-purge-intent-capabilities.js";
import { startRuntimeStack, stopRuntimeStack, wakeAfterC90Settlement } from
  "./privacy-purge-app-lifecycle.js";

export interface CreateAppOptions {
  browserForegroundHandoff?: BrowserForegroundHandoff | undefined;
  databasePath: string;
  featureFlags?: PersonalAttentionFeatureFlags;
  logger?: boolean | FastifyBaseLogger;
  clock?: () => Date;
  migrationClock?: () => Date;
  /** Internal-only ceiling used by immutable historical baseline runners. */
  maximumMigrationVersion?: number;
  webRoot?: string | false;
  summaryProvider?: SummaryProvider;
  researchProvider?: ResearchProvider;
  /** Internal dependency seam; production uses the closed default safe client. */
  liveAcquisitionClientFactory?: () =>
    NonNullable<ResearchAcquisitionCoordinatorOptions["client"]>;
  liveAcquisitionMaxAttemptsPerUtcDay?: number;
  summaryDailyLimit?: number;
  summaryMaxAttempts?: number;
  summaryWorkerPollMs?: number;
  embeddingProvider?: EmbeddingProvider;
  tabCommandRelayAppOrigins?: readonly string[];
  tabCommandRelayCommandTimeoutMs?: number;
  tabCommandRelayHeartbeatIntervalMs?: number;
  tabCommandRelayHeartbeatTimeoutMs?: number;
  tabCommandRelayRegistrationTimeoutMs?: number;
  localDevProxySecret?: string;
  sessionIntentMaintenanceIntervalMs?: number;
  finalSettlementVerifier?: PrivacyPurgeFinalSettlementVerifier;
}

export type TabHubApp = FastifyInstance;

function positiveIntegerOption(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function boundedIntegerOption(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Frozen schema-17 reader used only by the immutable G0/Q10K-base harness.
 * Current runtime never selects this branch because it omits the internal
 * migration ceiling and therefore opens the latest schema.
 */
function createG0HistoricalBaselineApp(
  database: TabHubDatabase,
): TabHubApp {
  const app = Fastify({ logger: false, bodyLimit: tabHubHttpBodyLimitBytes });
  app.get("/api/tabs", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const parsedPage = Number(query.page ?? 1);
    const parsedPageSize = Number(query.pageSize ?? 50);
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0
      ? parsedPage
      : 1;
    const pageSize = Number.isSafeInteger(parsedPageSize) &&
        parsedPageSize > 0 && parsedPageSize <= 200
      ? parsedPageSize
      : 50;
    const search = query.q?.trim() ?? "";
    const isOpen = query.is_open === "true"
      ? 1
      : query.is_open === "false"
        ? 0
        : null;
    const parameters = {
      isOpen,
      limit: pageSize,
      needle: `%${search}%`,
      offset: (page - 1) * pageSize,
      search,
    };
    const where = `
      WHERE (@isOpen IS NULL OR tabs.is_open = @isOpen)
        AND (
          @search = '' OR
          tabs.title LIKE @needle COLLATE NOCASE OR
          tabs.url LIKE @needle COLLATE NOCASE
        )
    `;
    const orderBy = query.sort_by === "activity"
      ? `COALESCE(activity.foreground_ms, 0) DESC, tabs.id ASC`
      : `tabs.last_seen_at DESC, tabs.id DESC`;
    const items = database.connection.prepare(`
      SELECT tabs.*,
        COALESCE(activity.foreground_ms, 0) AS foreground_ms,
        COALESCE(activity.engaged_ms, 0) AS engaged_ms
      FROM tabs
      LEFT JOIN tab_page_activity_totals AS activity
        ON activity.browser = tabs.browser
       AND activity.url_normalized = tabs.url_normalized
      ${where}
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `).all(parameters);
    const total = Number(database.connection.prepare(`
      SELECT COUNT(*)
      FROM tabs
      ${where}
    `).pluck().get(parameters));
    return { items, page, pageSize, total };
  });
  app.get("/api/tabs/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const tab = Number.isSafeInteger(id) && id > 0
      ? database.connection.prepare("SELECT * FROM tabs WHERE id = ?").get(id)
      : undefined;
    if (tab === undefined) return reply.code(404).send({ error: "TAB_NOT_FOUND" });
    return tab;
  });
  app.addHook("onClose", async () => database.close());
  return app;
}

export function createApp(options: CreateAppOptions): TabHubApp {
  const featureFlags = options.featureFlags ?? personalAttentionFeatureFlagsOff;
  const summaryDailyLimit = positiveIntegerOption(
    "summaryDailyLimit",
    options.summaryDailyLimit ?? 100,
  );
  const summaryMaxAttempts = positiveIntegerOption(
    "summaryMaxAttempts",
    options.summaryMaxAttempts ?? 5,
  );
  const liveAcquisitionMaxAttemptsPerUtcDay = boundedIntegerOption(
    "liveAcquisitionMaxAttemptsPerUtcDay",
    options.liveAcquisitionMaxAttemptsPerUtcDay ?? 20,
    1,
    100,
  );
  if (options.summaryWorkerPollMs !== undefined) {
    positiveIntegerOption("summaryWorkerPollMs", options.summaryWorkerPollMs);
  }
  const sessionIntentMaintenanceIntervalMs = positiveIntegerOption(
    "sessionIntentMaintenanceIntervalMs",
    options.sessionIntentMaintenanceIntervalMs ?? 60 * 60 * 1_000,
  );

  const database = openDatabase(options.databasePath, {
    ...(options.migrationClock === undefined
      ? {}
      : { migrationClock: options.migrationClock }),
    ...(options.maximumMigrationVersion === undefined
      ? {}
      : { maximumMigrationVersion: options.maximumMigrationVersion }),
  });
  if (options.maximumMigrationVersion === 17) {
    return createG0HistoricalBaselineApp(database);
  }
  const activityWindowsEnabled =
    featureFlags.activityWindows === true &&
    featureFlags.activityDailyWriter === true &&
    featureFlags.resources &&
    database.schemaVersion >= 21;
  const effectivePriorityFlags = resolveEffectivePriorityFeatureFlags(
    featureFlags,
    database.schemaVersion,
  );
  const agentUserImportanceEnabled = resolveAgentUserImportanceFeature(
    featureFlags,
    database.schemaVersion,
  );
  const researchFoundationAvailable = database.schemaVersion >= 24;
  const researchEnabled = resolveEffectiveResearchFeature(
    featureFlags,
    database.schemaVersion,
  );
  const researchRuntimeEnabled = researchEnabled &&
    options.researchProvider !== undefined;
  const liveAcquisitionFoundationAvailable = database.schemaVersion >= 25;
  const liveAcquisitionWriterEnabled = liveAcquisitionFoundationAvailable &&
    featureFlags.liveAcquisition === true && featureFlags.resources &&
    researchRuntimeEnabled;
  const priorityAssessmentWriterEnabled =
    effectivePriorityFlags.priorityAssessmentWriter;
  const priorityRoutesEnabled = effectivePriorityFlags.priorityReaders ||
    priorityAssessmentWriterEnabled;
  const app = Fastify({
    ...(typeof options.logger === "object"
      ? { loggerInstance: options.logger }
      : { logger: options.logger ?? false }),
    bodyLimit: tabHubHttpBodyLimitBytes,
    logController: new LogController({ disableRequestLogging: true }),
  });
  registerRequestSecurity(app);
  app.addHook("onResponse", async (request, reply) => {
    app.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
  });
  app.addHook("onError", async (request, reply, error) => {
    app.log.error(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        errorName: error.name,
      },
      "request failed",
    );
  });
  void app.register(websocket, {
    options: { maxPayload: tabHubHttpBodyLimitBytes },
  });
  const contextLedger = featureFlags.context || featureFlags.resources
    ? createContextLedger(database.connection, {
        ...(options.clock === undefined
          ? {}
          : { now: () => options.clock!().toISOString() }),
      })
    : undefined;
  const sessionIntentLedger =
    !featureFlags.context || contextLedger === undefined
      ? undefined
      : createSessionIntentLedger(database.connection, contextLedger, {
          ...(options.clock === undefined
            ? {}
            : { now: () => options.clock!().toISOString() }),
        });
  const localCapabilities =
    !featureFlags.context && !featureFlags.resources &&
      !priorityRoutesEnabled &&
      !effectivePriorityFlags.priorityPersonalization &&
      !researchFoundationAvailable
      ? undefined
      : createLocalCapabilityService(database.connection, {
          ...(options.clock === undefined ? {} : { now: options.clock }),
        });
  const tabInstanceCatalog = createTabInstanceCatalog(database.connection, {
    ...(featureFlags.context
      ? {
          sessionIntentReconciler: createSessionIntentReconciler(
            database.connection,
          ),
        }
      : {}),
  });
  let priorityCoordinator: PriorityAssessmentCoordinator | undefined;
  let priorityFeatureCatalog: ReturnType<typeof createPriorityFeatureCatalog> | undefined;
  const resourceCatalog = featureFlags.resources
    ? createResourceCatalog(database.connection, options.clock)
    : undefined;
  const resourceCommandCatalog = featureFlags.resources
    ? createResourceCommandCatalog(database.connection, options.clock)
    : undefined;
  const resourceReadCatalog = featureFlags.resources
    ? createResourceReadCatalog(database.connection, () => priorityCoordinator,
        options.clock)
    : undefined;
  const logicalPageCatalog = createLogicalPageCatalog(
    database.connection,
    options.clock,
    resourceCatalog === undefined
      ? undefined
      : (logicalPageId) => resourceCatalog.resolvePage(logicalPageId),
  );
  resourceCatalog?.backfill();
  const tabCatalog = createTabCatalog(
    database.connection,
    tabInstanceCatalog,
    logicalPageCatalog,
    featureFlags.logicalImportance,
    options.clock,
    featureFlags.context ? contextLedger : undefined,
    () => priorityCoordinator,
  );
  const agentUserImportanceCatalog = database.schemaVersion < 23
    ? undefined
    : createAgentUserImportanceCatalog(database.connection, {
      schemaVersion: database.schemaVersion,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      logicalImportanceEnabled: featureFlags.logicalImportance,
      resourcesEnabled: featureFlags.resources,
      logicalPages: logicalPageCatalog,
      ...(resourceCommandCatalog === undefined
        ? {}
        : { resourceCommands: resourceCommandCatalog }),
    });
  const tagCatalog = createTagCatalog(database.connection);
  const statsCatalog = createStatsCatalog(database.connection);
  const summaryCatalog = createSummaryCatalog(database.connection, options.clock, {
    ...(!featureFlags.context || contextLedger === undefined
      ? {}
      : {
          readShareableContext: (logicalPageId: number) =>
            contextLedger.readShareable({ type: "page", logicalPageId }),
        }),
  });
  const researchStore = researchFoundationAvailable
    ? createResearchStore(database.connection, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      })
    : undefined;
  const researchReportCatalog = researchFoundationAvailable
    ? createResearchReportCatalog(database.connection)
    : undefined;
  const researchCorpusReader = !researchRuntimeEnabled
    ? undefined
    : createResearchCorpusReader(database.connection);
  let aiJobLedger: AiJobLedger | undefined;
  const createUnifiedAiJobLedger = (
    guards: Parameters<typeof createAiJobLedger>[1]["guards"] = {},
  ): AiJobLedger => {
    if (aiJobLedger !== undefined) {
      throw new Error("AI job ledger composition attempted more than once");
    }
    aiJobLedger = createAiJobLedger(database.connection, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      kindAvailable: (kind) => kind === "priority_assessment"
        ? priorityAssessmentWriterEnabled
        : kind === "resource_research" && researchRuntimeEnabled,
      ...(guards === undefined ? {} : { guards }),
      ...(researchStore === undefined ? {} : { research: researchStore }),
      researchCorpusReader: researchCorpusReader ?? null,
    });
    return aiJobLedger;
  };
  if (priorityRoutesEnabled) {
    priorityFeatureCatalog = createPriorityFeatureCatalog(database.connection);
  }
  priorityCoordinator = !priorityRoutesEnabled
    ? undefined
    : createPriorityAssessmentCoordinator({
        connection: database.connection,
        catalog: priorityFeatureCatalog!,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        writerEnabled: priorityAssessmentWriterEnabled,
        createLedger: createUnifiedAiJobLedger,
      });
  if (researchFoundationAvailable && aiJobLedger === undefined) {
    createUnifiedAiJobLedger();
  }
  const durableAiJobs = aiJobLedger === undefined
    ? undefined
    : createDurableAiJobs({
        summary: createSummaryJobAdapter(summaryCatalog),
        newJobs: aiJobLedger,
      });
  const researchWorkflow = researchStore === undefined || durableAiJobs === undefined
    ? undefined
    : createResearchWorkflow({
          current: (request) => buildCurrentResearchProjection(
            database.connection,
            request,
            options.clock === undefined ? {} : { clock: options.clock },
          ),
          parentAvailability: (target, parentReportId) =>
            researchParentAvailability(database.connection, target, parentReportId),
          submitResearch: (task, approval) =>
            durableAiJobs.submitResearch(task, approval),
          replayAgentResearchStart: (request) =>
            durableAiJobs.replayAgentResearchStart(request),
          submitAgentResearch: (task, approval, command) =>
            durableAiJobs.submitAgentResearch(task, approval, command),
          cancelResearch: (jobId) => durableAiJobs.cancel(jobId),
          cancelAgentResearch: (jobId, command) =>
            durableAiJobs.cancelAgentResearch(jobId, command),
          redactResearch: (request) => researchStore.redactResearch(request),
        });
  const researchWorker = aiJobLedger === undefined ||
      researchCorpusReader === undefined || options.researchProvider === undefined
    ? undefined
    : createResearchWorker(
        aiJobLedger,
        researchCorpusReader,
        options.researchProvider,
        options.clock === undefined ? {} : { clock: options.clock },
      );
  const liveAcquisitionActionLedger = !liveAcquisitionFoundationAvailable
    ? undefined
    : createLiveAcquisitionActionLedger(database.connection, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(resourceCatalog === undefined
          ? {}
          : { previewResourceUrl: resourceCatalog.previewResourceUrl }),
      });
  const liveAcquisitionMaterializer = liveAcquisitionActionLedger === undefined ||
      resourceCatalog === undefined
    ? undefined
    : createLiveAcquisitionMaterializer(database.connection, {
        actionLedger: liveAcquisitionActionLedger,
        previewResourceUrl: resourceCatalog.previewResourceUrl,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
  const liveAcquisitionStatusReader = !liveAcquisitionFoundationAvailable
    ? undefined : createLiveAcquisitionStatusReader(database.connection);
  const liveAcquisitionWorkflow = !liveAcquisitionWriterEnabled ||
      researchStore === undefined || options.researchProvider === undefined
    ? undefined
    : createLiveAcquisitionWorkflow({
        connection: database.connection,
        research: researchStore,
        provider: options.researchProvider,
        maxAttemptsPerUtcDay: liveAcquisitionMaxAttemptsPerUtcDay,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
  const liveAcquisitionCoordinator = !liveAcquisitionWriterEnabled ||
      liveAcquisitionActionLedger === undefined
    ? undefined
    : createResearchAcquisitionCoordinator({
        actionLedger: liveAcquisitionActionLedger,
        ...(options.liveAcquisitionClientFactory === undefined
          ? {}
          : { client: options.liveAcquisitionClientFactory() }),
      });
  const liveAcquisitionHandoff = !liveAcquisitionWriterEnabled ||
      options.researchProvider === undefined
    ? undefined
    : createLiveAcquisitionHandoff(database.connection, {
        provider: options.researchProvider,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
  let wakeAiJobRuntime: () => void = () => undefined;
  let wakePrivacyPurgeRuntime: () => void = () => undefined;
  const trackedC90Executor = !liveAcquisitionFoundationAvailable ||
      aiJobLedger === undefined
    ? undefined
    : createTrackedC90ClaimExecutor({
        ledger: aiJobLedger,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        async executeClaim(claim, signal, control) {
          if (!liveAcquisitionWriterEnabled || liveAcquisitionCoordinator === undefined ||
              liveAcquisitionHandoff === undefined) {
            throw new DurableAiJobError(
              "JOB_INPUT_UNAVAILABLE",
              "Live acquisition writer is unavailable",
            );
          }
          liveAcquisitionMaterializer?.admitSeedOriginsForClaim(claim.id);
          await executeC90DynamicActionPlan({
            claim,
            signal,
            nextActionId: () => selectC90NextPlannedActionId(
              database.connection,
              claim.id,
            ),
            executeAction: (actionId, actionSignal) =>
              liveAcquisitionCoordinator.executeAction(actionId, actionSignal),
            reconcile: (currentClaim) => checkpointC90PersistedTerminalPages(
              database.connection,
              aiJobLedger!,
              currentClaim,
            ),
            renewLease: () => control.renewLease(),
          });
          liveAcquisitionHandoff.completeClaim(claim);
        },
        onSettled: () => {
          wakeAfterC90Settlement(
            { wake: wakePrivacyPurgeRuntime }, { wake: wakeAiJobRuntime },
          );
        },
      });
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
    logicalPageCatalog,
    options.clock,
    { dailyWriterEnabled: featureFlags.activityDailyWriter === true },
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
    featureFlags.context,
    options.clock,
  );
  const retentionLifecycle = createRetentionLifecycle({
    catalog: retentionCatalog,
    relay: tabCommandRelay,
    tabInstanceCatalog,
  });
  let retentionPurgeTimer: NodeJS.Timeout | undefined;
  let sessionIntentMaintenanceTimer: NodeJS.Timeout | undefined;
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
  const researchRuntimeAdapter = researchWorker === undefined
    ? undefined
    : liveAcquisitionFoundationAvailable && trackedC90Executor !== undefined &&
        aiJobLedger !== undefined
      ? createCompositeResourceResearchAdapter({
          connection: database.connection,
          ledger: aiJobLedger,
          c90: trackedC90Executor,
          c81: researchWorker,
          c90Enabled: liveAcquisitionWriterEnabled,
          maxC90AttemptsPerUtcDay: liveAcquisitionMaxAttemptsPerUtcDay,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        })
      : {
          kind: "resource_research" as const,
          recoverInterrupted: () => researchWorker.recoverInterrupted(),
          claim: (boundary: Parameters<typeof researchWorker.claim>[1]) => {
            const claim = researchWorker.claim("tabhub-research-runtime", boundary);
            return claim === undefined ? undefined : {
              id: `resource_research:${claim.id}`,
              execute: () => researchWorker.executeClaim(claim),
            };
          },
          stop: () => researchWorker.stop(),
        };
  const aiJobRuntimeAdapters = [
    ...(summaryWorker === undefined ? [] : [{
      kind: "page_summary" as const,
      recoverInterrupted: () => summaryWorker.recoverInterrupted(),
      claim: (boundary: Parameters<typeof summaryWorker.claimNext>[0]) => {
        const claim = summaryWorker.claimNext(boundary);
        return claim === undefined ? undefined : {
          id: `summary:${claim.id}`,
          execute: () => summaryWorker.executeClaim(claim),
        };
      },
      stop: () => summaryWorker.stop(),
    }]),
    ...(!priorityAssessmentWriterEnabled || priorityCoordinator === undefined ? [] : [{
      kind: "priority_assessment" as const,
      recoverInterrupted: () => priorityCoordinator.recoverInterrupted(),
      claim: (boundary: Parameters<typeof priorityCoordinator.claim>[1]) => {
        const claim = priorityCoordinator.claim("tabhub-priority-runtime", boundary);
        return claim === undefined ? undefined : {
          id: `priority_assessment:${claim.id}`,
          execute: () => { priorityCoordinator.executeClaim(claim); },
        };
      },
    }]),
    ...(researchRuntimeAdapter === undefined ? [] : [researchRuntimeAdapter]),
  ];
  const aiJobRuntime = aiJobRuntimeAdapters.length === 0
    ? undefined
    : createAiJobRuntime({
        cursorStore: createAiJobRuntimeCursorStore(database.connection),
        adapters: aiJobRuntimeAdapters,
        ...(options.summaryWorkerPollMs === undefined
          ? {}
          : { pollMs: options.summaryWorkerPollMs }),
        onError(error) {
          app.log.error(error, "AI job runtime loop failed");
        },
      });
  wakeAiJobRuntime = () => aiJobRuntime?.wake();
  const privacyPurgeFoundationAvailable = database.schemaVersion >= 26;
  const privacyPurgeCoordinator = !privacyPurgeFoundationAvailable
    ? undefined
    : createPrivacyPurgeCoordinator(database.connection, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(trackedC90Executor === undefined ? {} : { trackedC90Executor }),
        ...(options.finalSettlementVerifier === undefined
          ? {} : { finalSettlementVerifier: options.finalSettlementVerifier }),
      });
  const privacyPurgeRuntime = privacyPurgeCoordinator === undefined
    ? undefined
    : createPrivacyPurgeRuntime({
        coordinator: privacyPurgeCoordinator,
        listActivePurgeIds: () => (database.connection.prepare(`
          SELECT intent_key FROM privacy_purge_intents
          WHERE status IN ('waiting', 'ready', 'committed') ORDER BY created_at, intent_key
        `).all() as Array<{ intent_key: string }>).map(({ intent_key }) =>
          `purge_${intent_key}`),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        onError(code) { app.log.error({ code }, "privacy purge runtime unavailable"); },
      });
  wakePrivacyPurgeRuntime = () => privacyPurgeRuntime?.wake();

  void app.register(cors, {
    origin: [
      /^chrome-extension:\/\//,
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/,
    ],
  });

  if (localCapabilities !== undefined) {
    app.addHook("onRequest", async (request, reply) => {
      if (isTopLevelAppNavigation(request)) {
        localCapabilities.issueWebSession(reply);
      }
    });
    registerLocalCapabilityRoutes(app, {
      capabilities: localCapabilities,
      ...(options.localDevProxySecret === undefined
        ? {}
        : { devProxySecret: options.localDevProxySecret }),
    });
  }

  if (featureFlags.context && contextLedger !== undefined && sessionIntentLedger !== undefined) {
    if (localCapabilities === undefined) throw new Error("Local capability unavailable");
    registerContextRoutes(app, {
      capabilities: localCapabilities,
      connection: database.connection,
      contextLedger,
      sessionIntentLedger,
    });
  }

  if (featureFlags.resources) {
    if (contextLedger === undefined || localCapabilities === undefined ||
      resourceCatalog === undefined || resourceCommandCatalog === undefined ||
      resourceReadCatalog === undefined) {
      throw new Error("Resource dependencies unavailable");
    }
    registerResourceRoutes(app, {
      capabilities: localCapabilities,
      catalog: resourceCatalog,
      commands: resourceCommandCatalog,
      context: contextLedger,
      reads: resourceReadCatalog,
      activity: activityCatalog,
      activityWindows: activityWindowsEnabled,
      priorityPersonalization: effectivePriorityFlags.priorityPersonalization,
    });
  }

  if (agentUserImportanceCatalog !== undefined) {
    registerAgentUserImportanceRoutes(app, agentUserImportanceCatalog);
  }

  if (priorityCoordinator !== undefined) {
    registerPriorityRoutes(app, {
      ...(effectivePriorityFlags.priorityReaders
        ? { reader: priorityCoordinator }
        : {}),
      ...(priorityAssessmentWriterEnabled
        ? { writer: priorityCoordinator, capabilities: localCapabilities! }
        : {}),
      ...(aiJobRuntime === undefined ? {} : { scheduler: aiJobRuntime }),
    });
  }

  if (durableAiJobs !== undefined && localCapabilities !== undefined) {
    registerAiJobRoutes(app, {
      capabilities: localCapabilities,
      researchEnabled,
      jobs: durableAiJobs,
      ...(researchWorkflow === undefined ? {} : { researchWorkflow }),
    });
  }

  if (researchWorkflow !== undefined && researchReportCatalog !== undefined &&
      localCapabilities !== undefined) {
    registerResearchRoutes(app, {
      capabilities: localCapabilities,
      researchEnabled,
      providerAvailable: options.researchProvider !== undefined,
      workflow: researchWorkflow,
      reports: researchReportCatalog,
      ...(aiJobRuntime === undefined ? {} : { scheduler: aiJobRuntime }),
    });
    registerAgentResearchRoutes(app, {
      researchEnabled,
      providerAvailable: options.researchProvider !== undefined,
      workflow: researchWorkflow,
      reports: researchReportCatalog,
      ...(aiJobRuntime === undefined ? {} : { scheduler: aiJobRuntime }),
    });
  }

  if (liveAcquisitionFoundationAvailable && localCapabilities !== undefined) {
    registerLiveAcquisitionRoutes(app, {
      capabilities: localCapabilities,
      enabled: liveAcquisitionWriterEnabled,
      ...(liveAcquisitionStatusReader === undefined
        ? {}
        : { statusReader: liveAcquisitionStatusReader }),
      ...(liveAcquisitionWorkflow === undefined
        ? {}
        : { workflow: liveAcquisitionWorkflow }),
      ...(aiJobRuntime === undefined ? {} : { scheduler: aiJobRuntime }),
    });
  }

  if (privacyPurgeCoordinator !== undefined && privacyPurgeRuntime !== undefined &&
      localCapabilities !== undefined) {
    registerPrivacyPurgeRoutes(app, {
      capabilities: localCapabilities,
      coordinator: privacyPurgeCoordinator,
      runtime: privacyPurgeRuntime,
      newStartsEnabled: featureFlags.privacyPurge === true,
    });
  }

  if (effectivePriorityFlags.priorityPersonalization) {
    if (priorityCoordinator === undefined || localCapabilities === undefined) {
      throw new Error("Personal priority rules dependencies unavailable");
    }
    registerPersonalPriorityRuleRoutes(app, {
      capabilities: localCapabilities,
      catalog: createPersonalPriorityRulesCatalog(database.connection, {
        ...(options.clock === undefined
          ? {}
          : { now: () => options.clock!().toISOString() }),
        featureCatalog: priorityFeatureCatalog!,
        writerEnabled: priorityAssessmentWriterEnabled,
      }),
    });
  }

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
    if (sessionIntentLedger !== undefined) {
      const maintainSessionIntents = () => {
        const at = (options.clock ?? (() => new Date()))().toISOString();
        // Two phases deliberately preserve newly-expired rows until the next
        // maintenance cycle, while purging rows expired by an earlier cycle.
        sessionIntentLedger.purgeExpired({ before: at });
        sessionIntentLedger.change({ kind: "expire_due", now: at });
      };
      maintainSessionIntents();
      sessionIntentMaintenanceTimer = setInterval(
        maintainSessionIntents,
        sessionIntentMaintenanceIntervalMs,
      );
      sessionIntentMaintenanceTimer.unref();
    }
    startRuntimeStack(
      () => { liveAcquisitionActionLedger?.advanceRuntimeEpochAndRecover(
        liveAcquisitionWriterEnabled,
      ); },
      privacyPurgeRuntime,
      aiJobRuntime,
    );
  });

  app.addHook("onClose", async () => {
    if (retentionPurgeTimer !== undefined) {
      clearInterval(retentionPurgeTimer);
      retentionPurgeTimer = undefined;
    }
    if (sessionIntentMaintenanceTimer !== undefined) {
      clearInterval(sessionIntentMaintenanceTimer);
      sessionIntentMaintenanceTimer = undefined;
    }
    tabCommandRelay.close();
    await stopRuntimeStack(privacyPurgeRuntime, aiJobRuntime, () => database.close());
  });

  app.get("/api/health", async (): Promise<HealthResponse> =>
    healthResponseSchema.parse({
      status: "ok",
      database: "ok",
      schemaVersion: database.schemaVersion,
    }),
  );

  app.get("/api/features", async () =>
    featureFlagsResponseSchema.parse({
      context: featureFlags.context,
      logicalImportance: featureFlags.logicalImportance,
      liveAcquisition: liveAcquisitionWriterEnabled,
      resources: featureFlags.resources,
      activityWindows: activityWindowsEnabled,
      agentUserImportance: agentUserImportanceEnabled,
      pageSummaryCapture: featureFlags.pageSummaryCapture === true,
      priorityAssessmentWriter: effectivePriorityFlags.priorityAssessmentWriter,
      priorityPersonalization: effectivePriorityFlags.priorityPersonalization,
      priorityReaders: effectivePriorityFlags.priorityReaders,
      priorityShadow: effectivePriorityFlags.priorityShadow,
      privacyPurge: privacyPurgeFoundationAvailable && featureFlags.privacyPurge === true,
      research: researchEnabled,
    }),
  );

  registerTabRoutes(
    app,
    tabCatalog,
    embeddingCatalog,
    logicalPageCatalog,
    featureFlags.logicalImportance,
    featureFlags.context ? localCapabilities : undefined,
    featureFlags.resources,
    effectivePriorityFlags.priorityPersonalization,
    tabCommandRelay,
    featureFlags.pageSummaryCapture === true,
  );
  registerActivityRoutes(
    app,
    activityCatalog,
    activityWindowsEnabled,
  );
  registerRetentionRoutes(app, retentionLifecycle);
  registerTabInstanceRoutes(
    app,
    tabInstanceCatalog,
    tabCatalog,
    featureFlags.context ? localCapabilities : undefined,
    featureFlags.resources,
    effectivePriorityFlags.priorityPersonalization,
  );
  registerTagRoutes(app, tagCatalog);
  registerStatsRoutes(app, statsCatalog);
  registerSummaryRoutes(app, {
    catalog: summaryCatalog,
    provider: options.summaryProvider,
    worker: aiJobRuntime,
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
      pageSummaryCaptureEnabled: featureFlags.pageSummaryCapture === true,
    });
  });

  return app;
}
