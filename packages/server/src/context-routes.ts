import {
  agentContextAppendCommandSchema,
  agentContextMutationReceiptSchema,
  agentSessionIntentSetCommandSchema,
  agentSessionIntentMutationReceiptSchema,
  contextBundleSchema,
  contextChangeResultSchema,
  contextEntrySchema,
  contextSearchQuerySchema,
  exactTabScopeQuerySchema,
  localContextCommandSchema,
  localPageContextViewSchema,
  localSessionIntentCommandSchema,
  localScopedContextAppendCommandSchema,
  logicalPageParamSchema,
  sessionIntentBundleSchema,
  sessionIntentChangeResultSchema,
  sessionIntentPageSchema,
  sessionIntentQuerySchema,
  shareableContextBundleSchema,
  shareableContextEntrySchema,
  shareableSessionIntentBundleSchema,
  tabIdParamSchema,
  type ContextCommand,
  type ExactTabScope,
  type SessionIntentCommand,
} from "@tabhub/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type Database from "better-sqlite3";

import {
  ContextLedgerError,
  type ContextLedger,
} from "./context-ledger.js";
import {
  localAuthError,
  type LocalCapabilityService,
} from "./local-capability.js";
import {
  SessionIntentLedgerError,
  type SessionIntentLedger,
} from "./session-intent-ledger.js";

interface PhysicalPageRow {
  logical_page_id: number;
  url: string;
  url_normalized: string;
  navigation_revision: number;
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function ledgerError(reply: FastifyReply, error: unknown) {
  if (
    error instanceof ContextLedgerError ||
    error instanceof SessionIntentLedgerError
  ) {
    const notFound =
      error.code === "LOGICAL_PAGE_NOT_FOUND" ||
      error.code === "CONTEXT_ENTRY_NOT_FOUND" ||
      error.code === "SESSION_INTENT_NOT_FOUND";
    return reply.code(notFound ? 404 : 409).send({
      error: notFound ? "NOT_FOUND" : error.code,
      message: notFound ? "The requested context was not found" : error.message,
    });
  }
  throw error;
}

function requireLocal(
  capabilities: LocalCapabilityService,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const identity = capabilities.authenticate(request);
  if (identity === null) {
    void reply.code(401).send(localAuthError);
  }
  return identity;
}

function namespacedKey(audience: "agent" | "local", key: string): string {
  return `${audience}:${key}`;
}

export function registerContextRoutes(
  app: FastifyInstance,
  options: {
    capabilities: LocalCapabilityService;
    connection: Database.Database;
    contextLedger: ContextLedger;
    sessionIntentLedger: SessionIntentLedger;
  },
): void {
  const physicalPage = options.connection.prepare(`
    SELECT tabs.logical_page_id, instances.url, tabs.url_normalized,
      instances.navigation_revision
    FROM tab_instances AS instances
    JOIN tabs ON tabs.id = instances.tab_id
    WHERE instances.installation_id = @installationId
      AND instances.browser_session_id = @browserSessionId
      AND instances.browser_tab_id = @browserTabId
  `);
  const pageForTab = options.connection.prepare(`
    SELECT logical_page_id FROM tabs WHERE id = ?
  `);
  const browserPageCount = options.connection.prepare(`
    SELECT COUNT(*) FROM tabs WHERE logical_page_id = ?
  `);
  const intentOwner = options.connection.prepare(`
    SELECT installation_id, browser_session_id, browser_tab_id, visibility,
      logical_page_id, expected_url, expected_url_normalized,
      expected_instance_revision
    FROM tab_session_intents WHERE id = ?
  `);

  const readLocalContext = (logicalPageId: number) =>
    localPageContextViewSchema.parse({
      context: contextBundleSchema.parse(
        options.contextLedger.readLocal({ type: "page", logicalPageId }),
      ),
      affectedBrowserPageCount: Number(
        browserPageCount.pluck().get(logicalPageId),
      ),
    });

  app.get(
    "/api/local/pages/:logicalPageId/context",
    async (request, reply) => {
      if (requireLocal(options.capabilities, request, reply) === null) return;
      const parsed = logicalPageParamSchema.safeParse(request.params);
      if (!parsed.success) return validationError(reply, parsed.error.issues);
      try {
        return readLocalContext(parsed.data.logicalPageId);
      } catch (error) {
        return ledgerError(reply, error);
      }
    },
  );

  app.get("/api/local/tabs/:id/context", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = tabIdParamSchema.safeParse(request.params);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const row = pageForTab.get(parsed.data.id) as
      | { logical_page_id: number | null }
      | undefined;
    if (row?.logical_page_id == null) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    return readLocalContext(row.logical_page_id);
  });

  app.post(
    "/api/local/pages/:logicalPageId/context/commands",
    async (request, reply) => {
      const identity = requireLocal(options.capabilities, request, reply);
      if (identity === null) return;
      const params = logicalPageParamSchema.safeParse(request.params);
      const body = localContextCommandSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validationError(reply, [
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues),
        ]);
      }
      const command = {
        ...body.data,
        subject: { type: "page", logicalPageId: params.data.logicalPageId },
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: namespacedKey("local", body.data.idempotencyKey),
      } as ContextCommand;
      try {
        return contextChangeResultSchema.parse(
          options.contextLedger.change(command),
        );
      } catch (error) {
        return ledgerError(reply, error);
      }
    },
  );

  app.post("/api/local/page-context", async (request, reply) => {
    const identity = requireLocal(options.capabilities, request, reply);
    if (identity === null) return;
    const parsed = localScopedContextAppendCommandSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    if (
      identity.kind === "extension" &&
      identity.installationId !== parsed.data.scope.installationId
    ) {
      return reply.code(401).send(localAuthError);
    }
    const physical = physicalPage.get(parsed.data.scope) as
      | PhysicalPageRow
      | undefined;
    if (physical === undefined || physical.url !== parsed.data.expectedUrl) {
      return reply.code(409).send({ error: "SESSION_SCOPE_STALE" });
    }
    const { scope: _scope, expectedUrl: _expectedUrl, ...body } = parsed.data;
    try {
      return contextChangeResultSchema.parse(
        options.contextLedger.change({
          ...body,
          subject: { type: "page", logicalPageId: physical.logical_page_id },
          provenance: { actor: "user", method: "manual" },
          idempotencyKey: namespacedKey("local", body.idempotencyKey),
        }),
      );
    } catch (error) {
      return ledgerError(reply, error);
    }
  });

  app.get("/api/local/context/search", async (request, reply) => {
    if (requireLocal(options.capabilities, request, reply) === null) return;
    const parsed = contextSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    return contextEntrySchema.array().parse(
      options.contextLedger.searchLocal({
        query: parsed.data.q,
        logicalPageId: parsed.data.logicalPageId,
        limit: parsed.data.limit,
      }),
    );
  });

  app.get("/api/local/session-intents", async (request, reply) => {
    const identity = requireLocal(options.capabilities, request, reply);
    if (identity === null) return;
    const exact = exactTabScopeQuerySchema.safeParse(request.query);
    if (exact.success) {
      if (
        identity.kind === "extension" &&
        identity.installationId !== exact.data.installationId
      ) {
        return reply.code(401).send(localAuthError);
      }
      return sessionIntentBundleSchema.parse(
        options.sessionIntentLedger.readLocal(exact.data),
      );
    }
    if (identity.kind !== "web") return reply.code(401).send(localAuthError);
    const history = sessionIntentQuerySchema.safeParse(request.query);
    if (!history.success) return validationError(reply, history.error.issues);
    return sessionIntentPageSchema.parse(
      options.sessionIntentLedger.listLocal(history.data),
    );
  });

  app.post("/api/local/session-intents/commands", async (request, reply) => {
    const identity = requireLocal(options.capabilities, request, reply);
    if (identity === null) return;
    const parsed = localSessionIntentCommandSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    let command: SessionIntentCommand;
    if (parsed.data.kind === "set") {
      if (
        identity.kind === "extension" &&
        identity.installationId !== parsed.data.scope.installationId
      ) {
        return reply.code(401).send(localAuthError);
      }
      const physical = physicalPage.get(parsed.data.scope) as
        | PhysicalPageRow
        | undefined;
      if (physical === undefined || physical.url !== parsed.data.expectedUrl) {
        return reply.code(409).send({ error: "SESSION_SCOPE_STALE" });
      }
      command = {
        kind: "set",
        scope: parsed.data.scope,
        expectedPage: {
          logicalPageId: physical.logical_page_id,
          url: physical.url,
          urlNormalized: physical.url_normalized,
          instanceRevision: physical.navigation_revision,
        },
        body: parsed.data.body,
        provenance: { actor: "user", method: "manual" },
        visibility: parsed.data.visibility,
        staleAt: parsed.data.staleAt,
        idempotencyKey: namespacedKey("local", parsed.data.idempotencyKey),
      };
    } else {
      if (
        identity.kind === "extension" &&
        identity.installationId !== parsed.data.scope.installationId
      ) {
        return reply.code(401).send(localAuthError);
      }
      const owner = intentOwner.get(parsed.data.intentId) as
        | {
            installation_id: string;
            browser_session_id: string;
            browser_tab_id: number;
            visibility: string;
            logical_page_id: number;
            expected_url: string;
            expected_url_normalized: string;
            expected_instance_revision: number;
          }
        | undefined;
      if (
        identity.kind === "extension" &&
        owner?.installation_id !== identity.installationId
      ) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      if (owner === undefined) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      const exactPhysical = physicalPage.get(parsed.data.scope) as
        | PhysicalPageRow
        | undefined;
      if (
        owner.installation_id !== parsed.data.scope.installationId ||
        owner.browser_session_id !== parsed.data.scope.browserSessionId ||
        owner.browser_tab_id !== parsed.data.scope.browserTabId ||
        owner.logical_page_id !== parsed.data.expectedPage.logicalPageId ||
        owner.expected_url !== parsed.data.expectedPage.url ||
        owner.expected_url_normalized !== parsed.data.expectedPage.urlNormalized ||
        owner.expected_instance_revision !== parsed.data.expectedPage.instanceRevision ||
        exactPhysical === undefined ||
        exactPhysical.logical_page_id !== parsed.data.expectedPage.logicalPageId ||
        exactPhysical.url !== parsed.data.expectedPage.url ||
        exactPhysical.url_normalized !== parsed.data.expectedPage.urlNormalized ||
        exactPhysical.navigation_revision !== parsed.data.expectedPage.instanceRevision
      ) {
        return reply.code(409).send({ error: "SESSION_SCOPE_STALE" });
      }
      command =
        parsed.data.kind === "promote"
          ? {
              kind: "promote",
              intentId: parsed.data.intentId,
              contextKind: parsed.data.contextKind,
              subject: {
                type: "page",
                logicalPageId: owner.logical_page_id,
              },
              idempotencyKey: namespacedKey(
                "local",
                parsed.data.idempotencyKey,
              ),
            }
          : {
              kind: "archive",
              intentId: parsed.data.intentId,
              idempotencyKey: namespacedKey(
                "local",
                parsed.data.idempotencyKey,
              ),
            };
    }
    try {
      return sessionIntentChangeResultSchema.parse(
        options.sessionIntentLedger.change(command),
      );
    } catch (error) {
      return ledgerError(reply, error);
    }
  });

  app.get(
    "/api/agent/pages/:logicalPageId/context",
    async (request, reply) => {
      const parsed = logicalPageParamSchema.safeParse(request.params);
      if (!parsed.success) return validationError(reply, parsed.error.issues);
      try {
        return shareableContextBundleSchema.parse(
          options.contextLedger.readShareable({
            type: "page",
            logicalPageId: parsed.data.logicalPageId,
          }),
        );
      } catch {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
    },
  );

  app.post(
    "/api/agent/pages/:logicalPageId/context",
    async (request, reply) => {
      const params = logicalPageParamSchema.safeParse(request.params);
      const body = agentContextAppendCommandSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validationError(reply, [
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues),
        ]);
      }
      const provenance =
        body.data.provenance.method === "on_behalf_of_user"
          ? { actor: "agent" as const, method: "on_behalf_of_user" as const }
          : { actor: "agent" as const, ...body.data.provenance };
      try {
        const result = options.contextLedger.change({
            ...body.data,
            subject: {
              type: "page",
              logicalPageId: params.data.logicalPageId,
            },
            visibility: "share_with_ai",
            provenance,
            idempotencyKey: namespacedKey("agent", body.data.idempotencyKey),
          });
        if (result.kind !== "changed") throw new Error("Invalid append receipt");
        return agentContextMutationReceiptSchema.parse({
          kind: "appended",
          entry: {
            entryKind: result.entry.entryKind,
            body: result.entry.body,
            provenance: result.entry.provenance,
            visibility: "share_with_ai",
            staleAt: result.entry.staleAt,
            state: result.entry.state,
            createdAt: result.entry.createdAt,
            reviewVerdict: null,
          },
        });
      } catch (error) {
        return ledgerError(reply, error);
      }
    },
  );

  app.get("/api/agent/context/search", async (request, reply) => {
    const parsed = contextSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    return shareableContextEntrySchema.array().parse(
      options.contextLedger.searchShareable({
        query: parsed.data.q,
        logicalPageId: parsed.data.logicalPageId,
        limit: parsed.data.limit,
      }),
    );
  });

  app.get("/api/agent/session-intents", async (request, reply) => {
    const parsed = exactTabScopeQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      return shareableSessionIntentBundleSchema.parse(
        options.sessionIntentLedger.readShareable(parsed.data),
      );
    } catch {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
  });

  app.post("/api/agent/session-intents", async (request, reply) => {
    const parsed = agentSessionIntentSetCommandSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const provenance =
      parsed.data.provenance.method === "on_behalf_of_user"
        ? { actor: "agent" as const, method: "on_behalf_of_user" as const }
        : { actor: "agent" as const, ...parsed.data.provenance };
    const physical = physicalPage.get(parsed.data.scope) as
      | PhysicalPageRow
      | undefined;
    if (physical === undefined || physical.url !== parsed.data.expectedUrl) {
      return reply.code(409).send({ error: "SESSION_SCOPE_STALE" });
    }
    try {
      const result = options.sessionIntentLedger.change({
          kind: "set",
          scope: parsed.data.scope,
          expectedPage: {
            logicalPageId: physical.logical_page_id,
            url: physical.url,
            urlNormalized: physical.url_normalized,
            instanceRevision: physical.navigation_revision,
          },
          body: parsed.data.body,
          staleAt: parsed.data.staleAt,
          visibility: "share_with_ai",
          provenance,
          idempotencyKey: namespacedKey("agent", parsed.data.idempotencyKey),
        });
      if (result.kind !== "set") throw new Error("Invalid set receipt");
      return agentSessionIntentMutationReceiptSchema.parse({
        kind: "set",
        intent: {
          scope: result.intent.scope,
          subject: result.intent.subject,
          expectedPage: result.intent.expectedPage,
          body: result.intent.body,
          provenance: result.intent.provenance,
          visibility: "share_with_ai",
          staleAt: result.intent.staleAt,
          state: result.intent.state,
          createdAt: result.intent.createdAt,
          updatedAt: result.intent.updatedAt,
        },
      });
    } catch (error) {
      return ledgerError(reply, error);
    }
  });
}
