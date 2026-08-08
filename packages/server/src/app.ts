import {
  healthResponseSchema,
  type HealthResponse,
} from "@tabhub/shared";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { openDatabase } from "./database.js";

export interface CreateAppOptions {
  databasePath: string;
  logger?: boolean | FastifyBaseLogger;
}

export type TabHubApp = FastifyInstance;

export function createApp(options: CreateAppOptions): TabHubApp {
  const database = openDatabase(options.databasePath);
  const app = Fastify({ logger: options.logger ?? false });

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

  return app;
}
