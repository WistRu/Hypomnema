import {
  localCapabilityInstallationParamSchema,
  localCredentialResponseSchema,
  localPairingChallengeRequestSchema,
  localPairingChallengeResponseSchema,
  localPairingConsumeRequestSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  localAuthError,
  safeEqualSecret,
  type LocalCapabilityService,
} from "./local-capability.js";

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const identity = capabilities.authenticate(request);
  if (identity === null) void reply.code(401).send(localAuthError);
  return identity;
}

export function registerLocalCapabilityRoutes(
  app: FastifyInstance,
  options: {
    capabilities: LocalCapabilityService;
    devProxySecret?: string;
  },
): void {
  if (options.devProxySecret !== undefined) {
    app.post("/api/local/session/bootstrap", async (request, reply) => {
      const secret = request.headers["x-tabhub-dev-proxy-secret"];
      if (typeof secret !== "string" || !safeEqualSecret(secret, options.devProxySecret!)) {
        return reply.code(401).send(localAuthError);
      }
      options.capabilities.issueWebSession(reply);
      return reply.code(204).send();
    });
  }

  app.post("/api/local/pairing/challenges", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = localPairingChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return localPairingChallengeResponseSchema.parse(
        options.capabilities.createPairingChallenge(parsed.data),
      );
    } catch {
      return reply.code(409).send(localAuthError);
    }
  });

  app.post("/api/local/pairing/consume", async (request, reply) => {
    const parsed = localPairingConsumeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send(localAuthError);
    const result = options.capabilities.consumePairingChallenge({
      ...parsed.data,
      extensionOrigin: request.headers.origin,
    });
    return result === null
      ? reply.code(401).send(localAuthError)
      : localCredentialResponseSchema.parse(result);
  });

  app.delete("/api/local/capabilities/:installationId", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = localCapabilityInstallationParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const identity = options.capabilities.authenticate(request);
    if (identity === null ||
      (identity.kind === "extension" && identity.installationId !== parsed.data.installationId)) {
      return reply.code(401).send(localAuthError);
    }
    options.capabilities.revoke(parsed.data.installationId);
    return reply.code(204).send();
  });
}
