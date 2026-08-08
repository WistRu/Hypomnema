import "dotenv/config";

import { resolve } from "node:path";

import { createApp } from "./app.js";

const host = process.env.TABHUB_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.TABHUB_PORT ?? "7717", 10);
const databasePath = resolve(
  process.cwd(),
  process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
);

const app = createApp({ databasePath, logger: true });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
