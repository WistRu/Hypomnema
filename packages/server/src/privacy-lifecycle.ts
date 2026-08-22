import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  digestPrivacyPurgeExecutionTargets,
  encodePrivacyPurgePrimaryKeyV1,
  executePrivacyPurgePlan,
  type PrivacyPurgeExecutionTarget,
  type PrivacyPurgePrimaryKeyPart,
} from "./live-acquisition-migration.js";
import {
  createPrivacyPurgeIntentStore,
} from "./privacy-purge-intent-capabilities.js";

export type PrivacyPurgeTarget =
  | { readonly kind: "logical_page"; readonly subjectGenerationId: number }
  | { readonly kind: "run"; readonly subjectGenerationId: number }
  | { readonly kind: "resource_history"; readonly historyEpochId: number };

export interface PrivacyPurgeRequest {
  readonly idempotencyKey: string;
  readonly target: PrivacyPurgeTarget;
}

export interface PrivacyPurgeResult {
  readonly commandId: number;
  readonly status: "completed";
  readonly deletedRows: number;
  readonly deletionPlanDigest: string;
}

export interface PrivacyLifecycleOptions {
  readonly clock?: () => Date;
}

interface CatalogRow {
  readonly table_name: string;
  readonly pk_columns_json: string;
  readonly delete_rank: number;
}

interface CatalogTarget extends PrivacyPurgeExecutionTarget {
  readonly deleteRank: number;
  readonly liveActionDepth: number | null;
}

interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
}

interface ForeignKeyRelation {
  readonly childTable: string;
  readonly parentTable: string;
  readonly childColumns: readonly string[];
  readonly parentColumns: readonly (string | null)[];
}

interface TraversalRow {
  readonly tableName: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly identity: string;
}

interface CommandRow {
  readonly id: number;
  readonly request_fingerprint: string;
  readonly target_kind: PrivacyPurgeTarget["kind"];
  readonly subject_generation_id: number | null;
  readonly history_epoch_id: number | null;
  readonly deletion_target_count: number;
  readonly deletion_plan_digest: string;
  readonly status: "pending" | "waiting" | "completed" | "failed";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new Error("Privacy purge catalog contains an invalid SQL identifier");
  }
  return `"${value}"`;
}

function canonicalTarget(target: PrivacyPurgeTarget): string {
  if (target.kind === "resource_history") {
    if (!Number.isSafeInteger(target.historyEpochId) || target.historyEpochId <= 0) {
      throw new TypeError("Privacy purge history epoch is invalid");
    }
    return `resource_history:${target.historyEpochId}`;
  }
  if (!Number.isSafeInteger(target.subjectGenerationId) || target.subjectGenerationId <= 0) {
    throw new TypeError("Privacy purge subject generation is invalid");
  }
  return `${target.kind}:${target.subjectGenerationId}`;
}

function commandMatchesTarget(row: CommandRow, target: PrivacyPurgeTarget): boolean {
  return row.target_kind === target.kind && (
    target.kind === "resource_history"
      ? row.history_epoch_id === target.historyEpochId && row.subject_generation_id === null
      : row.subject_generation_id === target.subjectGenerationId && row.history_epoch_id === null
  );
}

function primaryKeyPart(value: unknown): PrivacyPurgePrimaryKeyPart {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { type: "integer", value };
  }
  if (typeof value === "bigint") return { type: "integer", value };
  if (typeof value === "string") return { type: "text", value };
  throw new Error("Privacy purge encountered a noncanonical primary-key value");
}

function primaryKeyColumns(
  connection: Database.Database,
  tableName: string,
): readonly string[] {
  const rows = connection.pragma(
    `table_info(${quoteIdentifier(tableName)})`,
  ) as Array<{ name: string; pk: number }>;
  const columns = rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  if (columns.length === 0) {
    throw new Error(`Privacy purge traversal table has no primary key: ${tableName}`);
  }
  return columns;
}

function readOne(
  connection: Database.Database,
  tableName: string,
  predicate: string,
  values: readonly unknown[],
): Readonly<Record<string, unknown>> {
  const row = connection.prepare(
    `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${predicate}`,
  ).get(...values) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error("SUBJECT_FORGOTTEN_OR_INVALID");
  return row;
}

function catalogRows(connection: Database.Database): readonly CatalogRow[] {
  return connection.prepare(`
    SELECT table_name, pk_columns_json, delete_rank
    FROM privacy_purge_target_catalog
    ORDER BY table_name
  `).all() as CatalogRow[];
}

function foreignKeyRelations(
  connection: Database.Database,
  childTables: readonly string[],
): readonly ForeignKeyRelation[] {
  const result: ForeignKeyRelation[] = [];
  for (const childTable of childTables) {
    const rows = connection.pragma(
      `foreign_key_list(${quoteIdentifier(childTable)})`,
    ) as ForeignKeyRow[];
    const grouped = new Map<number, ForeignKeyRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.id) ?? [];
      group.push(row);
      grouped.set(row.id, group);
    }
    for (const group of grouped.values()) {
      group.sort((a, b) => a.seq - b.seq);
      result.push({
        childTable,
        parentTable: group[0]!.table,
        childColumns: group.map((row) => row.from),
        parentColumns: group.map((row) => row.to),
      });
    }
  }
  return result;
}

function enumerateTargets(
  connection: Database.Database,
  target: PrivacyPurgeTarget,
): readonly CatalogTarget[] {
  const catalog = new Map(catalogRows(connection).map((row) => [row.table_name, row]));
  const pkCache = new Map<string, readonly string[]>();
  const pkFor = (tableName: string): readonly string[] => {
    const cached = pkCache.get(tableName);
    if (cached !== undefined) return cached;
    const columns = primaryKeyColumns(connection, tableName);
    pkCache.set(tableName, columns);
    return columns;
  };
  const relations = foreignKeyRelations(connection, [...catalog.keys()]);
  const relationsByParent = new Map<string, ForeignKeyRelation[]>();
  for (const relation of relations) {
    const entries = relationsByParent.get(relation.parentTable) ?? [];
    entries.push(relation);
    relationsByParent.set(relation.parentTable, entries);
  }
  const traversalQueue: TraversalRow[] = [];
  const traversed = new Set<string>();
  const targets = new Map<string, CatalogTarget>();

  const addRow = (tableName: string, values: Readonly<Record<string, unknown>>): void => {
    const pkColumns = pkFor(tableName);
    const parts = pkColumns.map((column) => primaryKeyPart(values[column]));
    const pkV1 = encodePrivacyPurgePrimaryKeyV1(parts);
    const identity = `${tableName}\u0000${pkV1}`;
    if (traversed.has(identity)) return;
    traversed.add(identity);
    traversalQueue.push({ tableName, values, identity });
    const catalogEntry = catalog.get(tableName);
    if (catalogEntry !== undefined) {
      targets.set(identity, {
        tableName,
        pkV1,
        deleteRank: catalogEntry.delete_rank,
        liveActionDepth: tableName === "live_acquisition_actions" &&
            typeof values.depth === "number"
          ? values.depth
          : null,
      });
    }

    // These two catalog parents are part of the exact run-owned graph even
    // though the schema edges point from child to parent.
    if (tableName === "research_runs") {
      const jobId = values.job_id;
      if (typeof jobId === "number" || typeof jobId === "bigint") {
        addRow("ai_jobs", readOne(connection, "ai_jobs", "id = ?", [jobId]));
      }
      const generations = connection.prepare(`
        SELECT * FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
        ORDER BY id
      `).all(values.id) as Array<Record<string, unknown>>;
      for (const generation of generations) addRow("privacy_subject_generations", generation);
    } else if (tableName === "live_acquisition_handoffs") {
      addRow(
        "research_runs",
        readOne(connection, "research_runs", "id = ?", [values.final_run_id]),
      );
    }
  };

  if (target.kind === "logical_page") {
    const generation = readOne(
      connection,
      "privacy_subject_generations",
      "id = ? AND subject_kind = 'logical_page' AND is_active = 1",
      [target.subjectGenerationId],
    );
    addRow("privacy_subject_generations", generation);
    addRow(
      "logical_pages",
      readOne(connection, "logical_pages", "id = ?", [generation.logical_page_id]),
    );
  } else if (target.kind === "run") {
    const generation = readOne(
      connection,
      "privacy_subject_generations",
      "id = ? AND subject_kind = 'research_run' AND is_active = 1",
      [target.subjectGenerationId],
    );
    addRow("privacy_subject_generations", generation);
    addRow(
      "research_runs",
      readOne(connection, "research_runs", "id = ?", [generation.research_run_id]),
    );
  } else {
    addRow(
      "research_history_epochs",
      readOne(connection, "research_history_epochs", "id = ? AND is_active = 1", [
        target.historyEpochId,
      ]),
    );
  }

  for (let index = 0; index < traversalQueue.length; index += 1) {
    if (targets.size > 250_000) throw new Error("Privacy purge target limit exceeded");
    const parent = traversalQueue[index]!;
    for (const relation of relationsByParent.get(parent.tableName) ?? []) {
      const parentPk = pkFor(parent.tableName);
      const parentValues = relation.parentColumns.map((column, sequence) =>
        parent.values[column ?? parentPk[sequence]!]
      );
      if (parentValues.some((value) => value === null || value === undefined)) continue;
      const predicate = relation.childColumns
        .map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
      const childRows = connection.prepare(`
        SELECT * FROM ${quoteIdentifier(relation.childTable)}
        WHERE ${predicate}
      `).all(...parentValues) as Array<Record<string, unknown>>;
      for (const child of childRows) addRow(relation.childTable, child);
    }
  }

  const ordered = [...targets.values()].sort((left, right) =>
    right.deleteRank - left.deleteRank ||
    (left.tableName === "live_acquisition_actions" &&
        right.tableName === "live_acquisition_actions"
      ? (right.liveActionDepth ?? -1) - (left.liveActionDepth ?? -1)
      : 0) ||
    left.tableName.localeCompare(right.tableName, "en") ||
    left.pkV1.localeCompare(right.pkV1, "en")
  );
  const busyJobs = ordered.filter((candidate) => candidate.tableName === "ai_jobs")
    .some((candidate) => connection.prepare(`
      SELECT 1 FROM ai_jobs AS target
      JOIN privacy_purge_target_catalog AS catalog ON catalog.table_name = 'ai_jobs'
      WHERE (${String((connection.prepare(`
        SELECT pk_expression_sql FROM privacy_purge_target_catalog WHERE table_name = 'ai_jobs'
      `).pluck().get())).replaceAll("OLD.", "target.")}) = ?
        AND target.status IN ('queued', 'running')
    `).get(candidate.pkV1) !== undefined);
  if (busyJobs) throw new Error("PURGE_SUBJECT_BUSY");
  const activeAction = ordered.filter(
    (candidate) => candidate.tableName === "live_acquisition_actions",
  ).some((candidate) => {
    const expression = String(connection.prepare(`
      SELECT pk_expression_sql FROM privacy_purge_target_catalog
      WHERE table_name = 'live_acquisition_actions'
    `).pluck().get()).replaceAll("OLD.", "target.");
    return connection.prepare(`
      SELECT 1 FROM live_acquisition_actions AS target
      WHERE (${expression}) = ?
        AND state NOT IN ('completed', 'blocked', 'ambiguous')
    `).get(candidate.pkV1) !== undefined;
  });
  if (activeAction) throw new Error("PURGE_SUBJECT_BUSY");
  return ordered;
}

export function createPrivacyLifecycle(
  connection: Database.Database,
  options: PrivacyLifecycleOptions = {},
): { purge(request: PrivacyPurgeRequest): PrivacyPurgeResult } {
  const clock = options.clock ?? (() => new Date());
  const schemaVersion = connection.pragma("user_version", { simple: true }) as number;
  const schemaHasPrivacyPurgeIntents = schemaVersion >= 26;
  const intentStore = schemaHasPrivacyPurgeIntents
    ? createPrivacyPurgeIntentStore(connection, { clock })
    : null;
  const selectCommand = connection.prepare(`
    SELECT id, request_fingerprint, target_kind, subject_generation_id,
      history_epoch_id, deletion_target_count, deletion_plan_digest, status
    FROM privacy_purge_commands WHERE idempotency_key_hash = ?
  `);

  const resultFor = (command: CommandRow): PrivacyPurgeResult => {
    if (command.status !== "completed") {
      throw new Error(`Privacy purge command is not terminal: ${command.status}`);
    }
    const safeCounts = JSON.parse(String(connection.prepare(`
      SELECT safe_counts_json FROM privacy_purge_results WHERE command_id = ?
    `).pluck().get(command.id))) as { deleted_rows?: number };
    return Object.freeze({
      commandId: command.id,
      status: "completed" as const,
      deletedRows: safeCounts.deleted_rows ?? command.deletion_target_count,
      deletionPlanDigest: command.deletion_plan_digest,
    });
  };

  return {
    purge(request): PrivacyPurgeResult {
      if (
        typeof request.idempotencyKey !== "string" ||
        Buffer.byteLength(request.idempotencyKey, "utf8") < 1 ||
        Buffer.byteLength(request.idempotencyKey, "utf8") > 200
      ) {
        throw new TypeError("Privacy purge idempotency key is invalid");
      }
      const canonical = canonicalTarget(request.target);
      const idempotencyHash = sha256(`tabhub:privacy-purge:idempotency:v1\0${request.idempotencyKey}`);
      const requestFingerprint = sha256(`tabhub:privacy-purge:request:v1\0${canonical}`);
      let command = selectCommand.get(idempotencyHash) as CommandRow | undefined;
      if (command !== undefined) {
        if (
          command.request_fingerprint !== requestFingerprint ||
          !commandMatchesTarget(command, request.target)
        ) {
          throw new Error("Privacy purge idempotency key conflicts with another request");
        }
        if (command.status === "completed") return resultFor(command);
        if (command.status === "failed") throw new Error("Privacy purge command already failed");
      }

      if (schemaHasPrivacyPurgeIntents) {
        if (command === undefined) {
          const commandId = intentStore!.linkReadyCommand({
            idempotencyKeyHash: idempotencyHash,
            requestFingerprint,
            targetKind: request.target.kind,
            subjectGenerationId: request.target.kind === "resource_history"
              ? null
              : request.target.subjectGenerationId,
            historyEpochId: request.target.kind === "resource_history"
              ? request.target.historyEpochId
              : null,
          });
          command = selectCommand.get(idempotencyHash) as CommandRow;
          if (command.id !== commandId) {
            throw new Error("Privacy purge command identity drifted");
          }
        }
        intentStore!.executeCommitted(command.id);
        command = selectCommand.get(idempotencyHash) as CommandRow;
        return resultFor(command);
      }

      const orderedTargets = enumerateTargets(connection, request.target);
      const executionTargets = orderedTargets.map(({ tableName, pkV1 }) => ({ tableName, pkV1 }));
      const deletionPlanDigest = digestPrivacyPurgeExecutionTargets(executionTargets);
      const createdAt = clock().toISOString();
      if (command === undefined) {
        const insert = connection.prepare(`
          INSERT INTO privacy_purge_commands (
            idempotency_key_hash, request_fingerprint, target_kind,
            subject_generation_id, history_epoch_id, deletion_target_count,
            deletion_plan_digest, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          idempotencyHash,
          requestFingerprint,
          request.target.kind,
          request.target.kind === "resource_history" ? null : request.target.subjectGenerationId,
          request.target.kind === "resource_history" ? request.target.historyEpochId : null,
          executionTargets.length,
          deletionPlanDigest,
          createdAt,
        );
        command = selectCommand.get(idempotencyHash) as CommandRow;
        if (Number(insert.lastInsertRowid) !== command.id) {
          throw new Error("Privacy purge command identity drifted");
        }
      } else if (
        command.deletion_target_count !== executionTargets.length ||
        command.deletion_plan_digest !== deletionPlanDigest
      ) {
        throw new Error("Privacy purge durable plan drifted before execution");
      }

      const tombstoneDigest = sha256(
        `tabhub:privacy-purge:tombstone:v1\0${command.id}\0${requestFingerprint}`,
      );
      const resultDigest = sha256(
        `tabhub:privacy-purge:result:v1\0${command.id}\0${deletionPlanDigest}`,
      );
      executePrivacyPurgePlan(connection, {
        version: "privacy_purge_execution:v1",
        commandId: command.id,
        outcome: "completed",
        orderedTargets: executionTargets,
        tombstoneDigest,
        safeCounts: { deleted_rows: executionTargets.length },
        resultDigest,
        completedAt: createdAt,
      });
      command = selectCommand.get(idempotencyHash) as CommandRow;
      return resultFor(command);
    },
  };
}
