import type { Database } from "better-sqlite3";

/** The `sqlite_master` predicate every row-count comparison uses. */
export declare const rowCountTableRule: string;

export declare function sha256File(path: string): Promise<string>;

/** Row count per table, excluding SQLite's own bookkeeping tables. */
export declare function tableRowCounts(
  connection: Database,
): Map<string, number>;

export declare function changedRowCounts(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): { table: string; before: number; after: number | null }[];
