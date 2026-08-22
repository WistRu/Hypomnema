import {
  personalPriorityLifecycleRequestSchema,
  personalPriorityLifecycleResponseSchema,
  personalPriorityPreviewRequestSchema,
  personalPriorityPreviewResponseSchema,
  personalPriorityRuleErrorResponseSchema,
  personalPriorityRulesetVersionSchema,
  personalPriorityRulesStateResponseSchema,
} from "@tabhub/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { localAuthError, type LocalCapabilityService } from "./local-capability.js";
import {
  PersonalPriorityRulesError,
  type createPersonalPriorityRulesCatalog,
} from "./personal-priority-rules.js";

type RulesCatalog = ReturnType<typeof createPersonalPriorityRulesCatalog>;

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const identity = capabilities.authenticate(request);
  if (identity === null) void reply.code(401).send(localAuthError);
  return identity;
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function rulesError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof PersonalPriorityRulesError)) throw error;
  const notFound = error.code === "PRIORITY_RULESET_NOT_FOUND" ||
    error.code === "PRIORITY_RULESET_VERSION_NOT_FOUND";
  const status = notFound ? 404 : error.code === "PRIORITY_FEATURE_UNAVAILABLE" ? 404
    : error.code === "PRIORITY_RULESET_CONFLICT" ? 409 : 400;
  return reply.code(status).send(personalPriorityRuleErrorResponseSchema.parse({
    error: error.code,
    message: error.message,
    ...(error.span === undefined ? {} : { span: error.span }),
  }));
}

export function registerPersonalPriorityRuleRoutes(
  app: FastifyInstance,
  options: {
    readonly capabilities: LocalCapabilityService;
    readonly catalog: RulesCatalog;
  },
): void {
  app.get("/api/personalization/rules", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    try {
      return personalPriorityRulesStateResponseSchema.parse(options.catalog.read());
    } catch (error) {
      return rulesError(reply, error);
    }
  });

  app.get("/api/personalization/rules/versions/:rulesetId/:version", async (
    request,
    reply,
  ) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const params = request.params as { rulesetId?: string; version?: string };
    const rulesetId = Number(params.rulesetId);
    const version = Number(params.version);
    if (!Number.isSafeInteger(rulesetId) || rulesetId < 1 ||
        !Number.isSafeInteger(version) || version < 1) {
      return validationError(reply, [{ message: "Expected positive ruleset/version" }]);
    }
    try {
      return personalPriorityRulesetVersionSchema.parse(
        options.catalog.readVersion({ rulesetId, version }),
      );
    } catch (error) {
      return rulesError(reply, error);
    }
  });

  app.post("/api/personalization/rules/preview", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = personalPriorityPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return personalPriorityPreviewResponseSchema.parse(
        options.catalog.preview(parsed.data.draft),
      );
    } catch (error) {
      return rulesError(reply, error);
    }
  });

  app.post("/api/personalization/rules/versions", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = personalPriorityLifecycleRequestSchema.safeParse(request.body);
    if (!parsed.success || parsed.success && parsed.data.kind !== "save") {
      return validationError(reply, parsed.success ? [{ message: "Expected save" }]
        : parsed.error.issues);
    }
    try {
      return personalPriorityLifecycleResponseSchema.parse(
        options.catalog.change(parsed.data),
      );
    } catch (error) {
      return rulesError(reply, error);
    }
  });

  const mutate = (
    path: string,
    kind: "activate" | "disable" | "reset" | "rollback",
  ) => app.post(path, async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = personalPriorityLifecycleRequestSchema.safeParse(request.body);
    if (!parsed.success || parsed.success && parsed.data.kind !== kind) {
      return validationError(reply, parsed.success ? [{ message: `Expected ${kind}` }]
        : parsed.error.issues);
    }
    try {
      return personalPriorityLifecycleResponseSchema.parse(
        options.catalog.change(parsed.data),
      );
    } catch (error) {
      return rulesError(reply, error);
    }
  });

  mutate("/api/personalization/rules/activate", "activate");
  mutate("/api/personalization/rules/disable", "disable");
  mutate("/api/personalization/rules/reset", "reset");
  mutate("/api/personalization/rules/rollback", "rollback");
}
