import {
  healthResponseSchema,
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

export interface CreateAppOptions {
  databasePath: string;
  logger?: boolean | FastifyBaseLogger;
  clock?: () => Date;
  webRoot?: string | false;
}

export type TabHubApp = FastifyInstance;

export function createApp(options: CreateAppOptions): TabHubApp {
  const database = openDatabase(options.databasePath);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024 * 1024,
  });
  const tabCatalog = createTabCatalog(database.connection, options.clock);
  const tagCatalog = createTagCatalog(database.connection);
  const statsCatalog = createStatsCatalog(database.connection);

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

  app.addHook("onClose", async () => {
    database.close();
  });

  app.get("/api/health", async (): Promise<HealthResponse> =>
    healthResponseSchema.parse({
      status: "ok",
      database: "ok",
      schemaVersion: database.schemaVersion,
    }),
  );

  registerTabRoutes(app, tabCatalog);
  registerTagRoutes(app, tagCatalog);
  registerStatsRoutes(app, statsCatalog);

  return app;
}
