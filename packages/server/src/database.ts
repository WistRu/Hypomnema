import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export class DatabaseSchemaTooNewError extends Error {
  readonly code = "DATABASE_SCHEMA_TOO_NEW";

  constructor(currentVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${currentVersion} is newer than supported version ${supportedVersion}`,
    );
    this.name = "DatabaseSchemaTooNewError";
  }
}

export interface TabHubDatabase {
  readonly connection: Database.Database;
  readonly schemaVersion: number;
  close(): void;
}

interface Migration {
  version: number;
  sql: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(migrationsDirectory)
    .filter((fileName) => /^\d{3}_.+\.sql$/.test(fileName))
    .sort()
    .map((fileName, index) => {
      const version = Number.parseInt(fileName.slice(0, 3), 10);
      const expectedVersion = index + 1;

      if (version !== expectedVersion) {
        throw new Error(
          `Migration sequence is not contiguous: expected ${expectedVersion}, found ${version}`,
        );
      }

      return {
        version,
        sql: readFileSync(resolve(migrationsDirectory, fileName), "utf8"),
      };
    });
}

function prepareDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
}

export function openDatabase(databasePath: string): TabHubDatabase {
  prepareDirectory(databasePath);

  const connection = new Database(databasePath);
  try {
    const migrations = loadMigrations();
    const supportedVersion = migrations.at(-1)?.version ?? 0;
    const currentVersion = connection.pragma("user_version", {
      simple: true,
    }) as number;

    if (currentVersion > supportedVersion) {
      throw new DatabaseSchemaTooNewError(currentVersion, supportedVersion);
    }

    connection.pragma("foreign_keys = ON");
    connection.pragma("busy_timeout = 5000");

    if (databasePath !== ":memory:") {
      connection.pragma("journal_mode = WAL");
      connection.pragma("synchronous = NORMAL");
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }

      connection.transaction(() => {
        connection.exec(migration.sql);
        connection.pragma(`user_version = ${migration.version}`);
      })();
    }

    return {
      connection,
      schemaVersion: supportedVersion,
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
