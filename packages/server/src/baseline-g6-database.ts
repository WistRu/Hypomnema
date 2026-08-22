import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type { DatabaseTableFingerprint } from "./baseline-database.js";

export interface G6DatabaseFingerprint {
  readonly databaseBytes: number;
  readonly fileSha256: string;
  readonly foreignKeyViolationCount: number;
  readonly integrityCheck: readonly string[];
  readonly schemaVersion: number;
  readonly schemaSha256: string;
  readonly tables: Readonly<Record<string, DatabaseTableFingerprint>>;
}

interface ColumnRow { readonly name: string; readonly pk: number }

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
  const columns = database.prepare("SELECT name,pk FROM pragma_table_info(?) ORDER BY cid")
    .all(tableName) as ColumnRow[];
  if (columns.length === 0) throw new Error(`G6 baseline table has no columns: ${tableName}`);
  const primary = columns.filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk);
  const ordering = primary.length === 0 ? columns : primary;
  const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${
    ordering.map(({ name }) => quoteIdentifier(name)).join(",")}`)
    .iterate() as Iterable<Record<string, unknown>>;
  const hash = createHash("sha256");
  let rowCount = 0;
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map(({ name }) => normalizedSqlValue(row[name]))));
    hash.update("\n");
    rowCount += 1;
  }
  return { checksumSha256: hash.digest("hex"), rowCount };
}

export async function sha256G6DatabaseFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function checkpointG6Database(path: string): void {
  const database = new Database(path, { fileMustExist: true });
  try {
    sqliteVec.load(database);
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

export async function inspectG6Database(path: string): Promise<G6DatabaseFingerprint> {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    sqliteVec.load(database);
    database.pragma("query_only=ON");
    database.pragma("foreign_keys=ON");
    const tableNames = database.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[];
    const tables = Object.fromEntries(tableNames.map((name) => [
      name, tableFingerprint(database, name),
    ]));
    const schemaRows = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name`).all();
    const schemaSha256 = createHash("sha256").update(JSON.stringify(schemaRows)).digest("hex");
    const integrityCheck = (database.pragma("integrity_check") as
      Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeyViolationCount = Number(database.prepare(
      "SELECT COUNT(*) FROM pragma_foreign_key_check",
    ).pluck().get());
    return {
      databaseBytes: (await stat(path)).size,
      fileSha256: await sha256G6DatabaseFile(path),
      foreignKeyViolationCount,
      integrityCheck,
      schemaVersion: database.pragma("user_version", { simple: true }) as number,
      schemaSha256,
      tables,
    };
  } finally {
    database.close();
  }
}
