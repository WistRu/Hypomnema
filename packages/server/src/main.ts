import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";

import { createApp } from "./app.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(workspaceRoot, ".env") });

const host = process.env.TABHUB_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.TABHUB_PORT ?? "7717", 10);
const databasePath = resolve(
  workspaceRoot,
  process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
);
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = createApp({
  databasePath,
  logger: true,
  webRoot: existsSync(webRoot) ? webRoot : false,
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
