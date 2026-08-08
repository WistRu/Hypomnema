import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import Database from "better-sqlite3";

const databasePath = resolve(
  process.cwd(),
  process.env.TABHUB_DB_PATH ?? "./data/tabhub.sqlite",
);
const backupDirectory = resolve(process.cwd(), "./backups");
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
