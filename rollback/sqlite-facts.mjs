/**
 * The handful of facts every rollout and rollback proof reads out of a SQLite file.
 *
 * Both the C98 smoke and the migration test need them, and a fingerprint or a row
 * count that means one thing in the script and another in the test is exactly the kind
 * of quiet disagreement these proofs exist to rule out. `sqlite_sequence` is excluded
 * everywhere, because it is bookkeeping SQLite maintains rather than user data; a
 * count that includes it is one higher and must say so.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const rowCountTableRule = "type = 'table' AND name NOT LIKE 'sqlite_%'";

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function tableRowCounts(connection) {
  const tables = connection.prepare(`
    SELECT name FROM sqlite_master
    WHERE ${rowCountTableRule}
    ORDER BY name
  `).pluck().all();
  return new Map(tables.map((table) => [
    table,
    Number(connection.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()),
  ]));
}

export function changedRowCounts(before, after) {
  const changed = [];
  for (const [table, count] of before) {
    const now = after.get(table);
    if (now !== count) changed.push({ table, before: count, after: now ?? null });
  }
  return changed;
}
