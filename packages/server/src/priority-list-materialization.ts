import type Database from "better-sqlite3";

import {
  projectPriorityListSubjects,
  type PriorityListOrderingReader,
} from "./priority-list-ordering.js";

export const priorityListProjectionRelation =
  "temp.priority_list_projection" as const;

/**
 * Builds the request-local, indexed SQL relation used by every priority list.
 * Canonical currentness stays behind PriorityListOrderingReader; the SQL
 * consumers only see its fail-closed ordering projection.
 */
export function createPriorityListProjectionMaterializer(
  connection: Database.Database,
) {
  connection.exec(`CREATE TEMP TABLE IF NOT EXISTS priority_list_projection (
    subject_id INTEGER PRIMARY KEY,
    band_rank INTEGER NOT NULL,
    agent_score INTEGER NOT NULL,
    needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1))
  ) WITHOUT ROWID`);
  const clear = connection.prepare(`DELETE FROM ${priorityListProjectionRelation}`);
  const populate = connection.prepare(`INSERT INTO ${priorityListProjectionRelation} (
      subject_id, band_rank, agent_score, needs_review
    ) SELECT
      CAST(json_extract(value, '$.subjectId') AS INTEGER),
      CAST(json_extract(value, '$.bandRank') AS INTEGER),
      CAST(json_extract(value, '$.agentScore') AS INTEGER),
      CAST(json_extract(value, '$.needsReview') AS INTEGER)
    FROM json_each(?)`);
  const replace = connection.transaction((projectionJson: string) => {
    clear.run();
    if (projectionJson !== "[]") populate.run(projectionJson);
  });

  return {
    replace(
      reader: PriorityListOrderingReader,
      type: "page" | "resource",
      ids: readonly number[],
      anchor: string,
    ): void {
      const projection = reader.readListProjection?.(type, ids, anchor) ??
        projectPriorityListSubjects(reader, type, ids, anchor);
      replace(JSON.stringify(projection));
    },
  };
}
