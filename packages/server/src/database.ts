import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

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

// Immutable URL contract used by migration 012. Future canonicalization
// changes must use a new versioned migration function instead of editing this.
function normalizeUrlV2(input: string): string {
  const url = new URL(input);
  const retainedParameters = [...url.searchParams.entries()].filter(
    ([key]) => !key.toLowerCase().startsWith("utm_"),
  );

  url.search = "";

  for (const [key, value] of retainedParameters) {
    url.searchParams.append(key, value);
  }

  return url.toString();
}

function normalizeForCaselessSearch(value: string): string {
  return value.normalize("NFKC").toUpperCase().normalize("NFKC");
}

const russianAlphabet = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";

// SQLite NOCASE folds ASCII only. This deterministic key keeps Latin and
// Cyrillic titles case-insensitive and puts Ё in its Russian alphabet position.
function tabSortKey(value: unknown): string {
  if (typeof value !== "string") return "";

  return [...value.normalize("NFKC").toLowerCase()]
    .map((character) => {
      const russianIndex = russianAlphabet.indexOf(character);
      return russianIndex === -1
        ? character
        : String.fromCodePoint(0x1000 + russianIndex);
    })
    .join("");
}

// Keep untitled-row ordering aligned with the hostname fallback shown by web.
function tabDisplayTitle(title: unknown, url: unknown): string {
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }
  if (typeof url !== "string") return "";

  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function containsNormalizedCaseless(value: unknown, query: unknown): number {
  if (typeof value !== "string" || typeof query !== "string") {
    return 0;
  }

  const normalizedValue = normalizeForCaselessSearch(value);
  const normalizedQuery = normalizeForCaselessSearch(query);
  return normalizedValue.includes(normalizedQuery) ? 1 : 0;
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
    sqliteVec.load(connection);
    connection.function(
      "tabhub_normalize_url_v2",
      { deterministic: true },
      normalizeUrlV2,
    );
    connection.function(
      "tabhub_contains_normalized",
      { deterministic: true },
      containsNormalizedCaseless,
    );
    connection.function(
      "tabhub_sort_key",
      { deterministic: true },
      tabSortKey,
    );
    connection.function(
      "tabhub_display_title",
      { deterministic: true },
      tabDisplayTitle,
    );
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
