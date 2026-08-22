import {
  liveAcquisitionBudgetExhaustedSchema,
  liveAcquisitionPreflightRequestSchema,
  liveAcquisitionPreflightSchema,
  liveAcquisitionRunStatusSchema,
  liveAcquisitionStartReceiptSchema,
  liveAcquisitionStartRequestSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { localAuthError, type LocalCapabilityService } from "./local-capability.js";
import type { LiveAcquisitionWorkflow } from "./live-acquisition-workflow.js";
import type { LiveAcquisitionStatusReader } from "./live-acquisition-status-reader.js";

type MaybePromise<Value> = Value | Promise<Value>;

export interface LiveAcquisitionRouteWorkflow {
  preflight(
    request: Parameters<LiveAcquisitionWorkflow["preflight"]>[0],
  ): MaybePromise<ReturnType<LiveAcquisitionWorkflow["preflight"]>>;
  start(
    request: Parameters<LiveAcquisitionWorkflow["start"]>[0],
  ): MaybePromise<ReturnType<LiveAcquisitionWorkflow["start"]>>;
}

export interface LiveAcquisitionRouteOptions {
  readonly capabilities: LocalCapabilityService;
  readonly enabled: boolean | (() => boolean);
  readonly workflow?: LiveAcquisitionRouteWorkflow;
  readonly statusReader?: LiveAcquisitionStatusReader;
  readonly scheduler?: { wake(): void };
}

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (capabilities.authenticate(request) !== null) return true;
  void reply.code(401).send(localAuthError);
  return false;
}

function isEnabled(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

function routeError(reply: FastifyReply, error: unknown) {
  const code = codeOf(error);
  if (code === "RESEARCH_CAPTURE_REQUIRED" || code === "LIVE_ACQUISITION_RESOURCE_REQUIRED" ||
      code === "LIVE_ACQUISITION_TARGET_UNSUPPORTED") {
    return reply.code(422).send({ error: code });
  }
  if (code === "RESEARCH_PREFLIGHT_STALE" || code === "IDEMPOTENCY_KEY_CONFLICT" ||
      code === "JOB_ACTIVE_CONFLICT" || code === "RESEARCH_PARENT_UNAVAILABLE") {
    return reply.code(409).send({ error: code });
  }
  if (code === "JOB_SUBJECT_NOT_FOUND" || code === "RESEARCH_PARENT_NOT_FOUND") {
    return reply.code(404).send({ error: code });
  }
  if (code === "JOB_BUDGET_EXHAUSTED") {
    const parsed = liveAcquisitionBudgetExhaustedSchema.safeParse({
      error: code,
      dailyStartsRemaining: typeof error === "object" && error !== null &&
          "dailyStartsRemaining" in error ? error.dailyStartsRemaining : undefined,
      dailyStartsResetAt: typeof error === "object" && error !== null &&
          "dailyStartsResetAt" in error ? error.dailyStartsResetAt : undefined,
    });
    return parsed.success
      ? reply.code(429).send(parsed.data)
      : reply.code(500).send({ error: "INTERNAL_ERROR" });
  }
  if (code === "INVALID_JOB_INPUT") {
    return reply.code(400).send({ error: "VALIDATION_ERROR", code });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

export function registerLiveAcquisitionRoutes(
  app: FastifyInstance,
  options: LiveAcquisitionRouteOptions,
): void {
  const gate = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!requireLocal(options.capabilities, request, reply)) return false;
    if (!isEnabled(options.enabled)) {
      void reply.code(409).send({ error: "FEATURE_DISABLED", feature: "liveAcquisition" });
      return false;
    }
    if (options.workflow === undefined) {
      void reply.code(503).send({ error: "LIVE_ACQUISITION_UNAVAILABLE" });
      return false;
    }
    return true;
  };

  app.get("/api/research/live/runs/:jobId", async (request, reply) => {
    if (!requireLocal(options.capabilities, request, reply)) return;
    if (options.statusReader === undefined) {
      return reply.code(503).send({ error: "LIVE_ACQUISITION_UNAVAILABLE" });
    }
    const jobId = typeof request.params === "object" && request.params !== null &&
        "jobId" in request.params && typeof request.params.jobId === "string"
      ? request.params.jobId : "";
    if (!/^resource_research:[1-9][0-9]*$/.test(jobId)) {
      return reply.code(400).send({ error: "VALIDATION_ERROR" });
    }
    try {
      const status = options.statusReader.read(jobId);
      if (status === null) return reply.code(404).send({ error: "LIVE_ACQUISITION_RUN_NOT_FOUND" });
      return liveAcquisitionRunStatusSchema.parse(status);
    } catch {
      return reply.code(503).send({ error: "LIVE_ACQUISITION_STATUS_UNAVAILABLE" });
    }
  });

  app.post("/api/research/live/preflight", async (request, reply) => {
    if (!gate(request, reply)) return;
    const body = liveAcquisitionPreflightRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", issues: body.error.issues });
    }
    try {
      return liveAcquisitionPreflightSchema.parse(
        await options.workflow!.preflight(body.data),
      );
    } catch (error) {
      return routeError(reply, error);
    }
  });

  app.post("/api/research/live/runs", async (request, reply) => {
    if (!gate(request, reply)) return;
    const body = liveAcquisitionStartRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", issues: body.error.issues });
    }
    try {
      const receipt = liveAcquisitionStartReceiptSchema.parse(
        await options.workflow!.start(body.data),
      );
      options.scheduler?.wake();
      return reply.code(202).send(receipt);
    } catch (error) {
      return routeError(reply, error);
    }
  });
}
