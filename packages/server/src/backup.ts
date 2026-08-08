import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { config as loadEnvironment } from "dotenv";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: resolve(workspaceRoot, ".env") });
const databasePath = resolve(
  workspaceRoot,
  process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
);
const backupDirectory = resolve(workspaceRoot, "./backups");
const extension = extname(databasePath) || ".sqlite";
const stem = basename(databasePath, extension);
const timestamp = new Date().toISOString().replaceAll(":", "-");
const destination = resolve(
  backupDirectory,
  `${stem}-${timestamp}${extension}`,
);

await mkdir(dirname(destination), { recursive: true });

const database = new Database(databasePath, { fileMustExist: true });

try {
  await database.backup(destination);
  console.log(destination);
} finally {
  database.close();
}
