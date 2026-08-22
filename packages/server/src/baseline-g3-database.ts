import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type { DatabaseTableFingerprint } from "./baseline-database.js";

export const g3ResourceTables = Object.freeze([
  "resources",
  "resource_events",
  "resource_heads",
  "resource_match_rules",
  "resource_match_rule_heads",
  "resource_ruleset_events",
  "resource_ruleset_heads",
  "logical_page_resource_assignments",
  "logical_page_resource_heads",
  "resource_resolution_events",
  "resource_resolution_heads",
  "resource_preferences",
  "resource_context_entries",
  "resource_context_entry_reviews",
  "resource_command_receipts",
] as const);

export type G3ResourceTableName = (typeof g3ResourceTables)[number];

export interface G3DatabaseFingerprint {
  readonly databaseBytes: number;
  readonly fileSha256: string;
  readonly foreignKeyViolationCount: number;
  readonly integrityCheck: readonly string[];
  readonly schemaVersion: number;
  readonly resourceTables: Readonly<
    Record<G3ResourceTableName, DatabaseTableFingerprint>
  >;
  readonly topics: Readonly<{
    tags: DatabaseTableFingerprint;
    tabTags: DatabaseTableFingerprint;
  }>;
}

export interface TopicFingerprints {
  readonly tags: DatabaseTableFingerprint;
  readonly tabTags: DatabaseTableFingerprint;
}

interface ColumnRow {
  readonly name: string;
  readonly pk: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizedSqlValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? { blobHex: value.toString("hex") } : value;
}

function tableFingerprint(
  database: Database.Database,
  tableName: string,
): DatabaseTableFingerprint {
  const columns = database
    .prepare("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid")
    .all(tableName) as ColumnRow[];
  if (columns.length === 0) {
    throw new Error(`G3 baseline table does not exist: ${tableName}`);
  }
  const primaryKey = columns
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk);
  const ordering = primaryKey.length > 0 ? primaryKey : columns;
  const rows = database
    .prepare(
      `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${ordering
        .map(({ name }) => quoteIdentifier(name))
        .join(", ")}`,
    )
    .iterate() as Iterable<Record<string, unknown>>;
  const checksum = createHash("sha256");
  let rowCount = 0;
  for (const row of rows) {
    checksum.update(
      JSON.stringify(columns.map(({ name }) => normalizedSqlValue(row[name]))),
    );
    checksum.update("\n");
    rowCount += 1;
  }
  return { checksumSha256: checksum.digest("hex"), rowCount };
}

export async function sha256DatabaseFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function checkpointDatabase(path: string): void {
  const database = new Database(path, { fileMustExist: true });
  try {
    sqliteVec.load(database);
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

export function inspectTopicFingerprints(path: string): TopicFingerprints {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    return {
      tags: tableFingerprint(database, "tags"),
      tabTags: tableFingerprint(database, "tab_tags"),
    };
  } finally {
    database.close();
  }
}

export async function inspectG3Database(
  path: string,
): Promise<G3DatabaseFingerprint> {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    sqliteVec.load(database);
    database.pragma("query_only = ON");
    database.pragma("foreign_keys = ON");
    const resourceTables = Object.fromEntries(
      g3ResourceTables.map((tableName) => [
        tableName,
        tableFingerprint(database, tableName),
      ]),
    ) as Record<G3ResourceTableName, DatabaseTableFingerprint>;
    const integrityCheck = (
      database.pragma("integrity_check") as Array<{ integrity_check: string }>
    ).map(({ integrity_check }) => integrity_check);
    const foreignKeyViolationCount = (
      database
        .prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check")
        .get() as { count: number }
    ).count;
    return {
      databaseBytes: (await stat(path)).size,
      fileSha256: await sha256DatabaseFile(path),
      foreignKeyViolationCount,
      integrityCheck,
      schemaVersion: database.pragma("user_version", { simple: true }) as number,
      resourceTables,
      topics: {
        tags: tableFingerprint(database, "tags"),
        tabTags: tableFingerprint(database, "tab_tags"),
      },
    };
  } finally {
    database.close();
  }
}
