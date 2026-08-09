import {
  createWorkspaceSchema,
  deleteResponseSchema,
  patchWorkspaceSchema,
  workspaceDetailSchema,
  workspaceIdParamSchema,
  workspaceListResponseSchema,
} from "@tabhub/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  TabInstanceStaleError,
  type WorkspaceCatalog,
} from "./workspace-catalog.js";

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", issues });
}

function sendMissingWorkspace(reply: FastifyReply, id: number) {
  return reply.code(404).send({
    error: "WORKSPACE_NOT_FOUND",
    message: `No saved workspace exists with id ${id}`,
  });
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  catalog: WorkspaceCatalog,
): void {
  app.post("/api/workspaces", async (request, reply) => {
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    try {
      return reply
        .code(201)
        .send(workspaceDetailSchema.parse(catalog.create(parsed.data)));
    } catch (error) {
      if (error instanceof TabInstanceStaleError) {
        return reply.code(409).send({
          error: error.code,
          message: error.message,
          staleInstanceIds: error.staleInstanceIds,
        });
      }
      throw error;
    }
  });

  app.get("/api/workspaces", async () =>
    workspaceListResponseSchema.parse(catalog.list()),
  );

  app.get("/api/workspaces/:id", async (request, reply) => {
    const parsed = workspaceIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const workspace = catalog.get(parsed.data.id);
    if (workspace === undefined) {
      return sendMissingWorkspace(reply, parsed.data.id);
    }
    return workspaceDetailSchema.parse(workspace);
  });

  app.patch("/api/workspaces/:id", async (request, reply) => {
    const params = workspaceIdParamSchema.safeParse(request.params);
    const body = patchWorkspaceSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendValidationError(reply, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ]);
    }

    const workspace = catalog.rename(params.data.id, body.data);
    if (workspace === undefined) {
      return sendMissingWorkspace(reply, params.data.id);
    }
    return workspaceDetailSchema.parse(workspace);
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const parsed = workspaceIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    if (!catalog.delete(parsed.data.id)) {
      return sendMissingWorkspace(reply, parsed.data.id);
    }
    return deleteResponseSchema.parse({ deleted: true });
  });
}
