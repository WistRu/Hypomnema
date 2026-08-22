import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  encodePrivacyPurgePrimaryKeyV1,
  type PrivacyPurgePrimaryKeyPart,
} from "./live-acquisition-migration.js";

export const PRIVACY_PURGE_TARGET_TABLE_COUNT = 65;
export const PRIVACY_PURGE_MUTATION_OPERATION_COUNT = 3;
export const PRIVACY_PURGE_MUTATION_FENCE_COUNT = 195;
export const PRIVACY_PURGE_DERIVED_TRIGGER_COUNT = 13;
export const PRIVACY_PURGE_DERIVED_STATEMENT_COUNT = 17;
export const PRIVACY_PURGE_DERIVED_PATH_COUNT = 16;

const activeStatuses = "('waiting', 'ready', 'committed', 'failed_hold')";
const roots = new Set([
  "logical_pages",
  "research_runs",
  "research_history_epochs",
  "privacy_subject_generations",
  "ai_jobs",
]);

interface TargetCatalogRow {
  readonly table_name: string;
  readonly pk_columns_json: string;
  readonly pk_expression_sql: string;
  readonly delete_rank: number;
}

interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
}

interface Relation {
  readonly childTable: string;
  readonly parentTable: string;
  readonly childColumns: readonly string[];
  readonly parentColumns: readonly string[];
}

interface OwnershipPath {
  readonly relations: readonly Relation[];
  readonly visited: ReadonlySet<string>;
}

export interface PrivacyPurgeMutationFence {
  readonly tableName: string;
  readonly operation: "INSERT" | "UPDATE" | "DELETE";
  readonly ownerGroup: string;
  readonly oldOwnerPredicate: string;
  readonly newOwnerPredicate: string;
  readonly exceptionClass: "drain" | "executor_delete";
  readonly triggerName: string;
  readonly sql: string;
  readonly oldOwnerPredicateDigest: string;
  readonly newOwnerPredicateDigest: string;
  readonly triggerSqlDigest: string;
}

export interface PrivacyPurgeDerivedStatement {
  readonly ordinal: number;
  readonly operation: "INSERT" | "UPDATE" | "DELETE";
  readonly possibleOperations: readonly ("INSERT" | "UPDATE" | "DELETE")[];
  readonly targetTable: string;
}

export interface PrivacyPurgeDerivedMutation {
  readonly triggerName: string;
  readonly triggerSqlDigest: string;
  readonly sourceTable: string;
  readonly sourceOperation: "INSERT" | "UPDATE" | "DELETE";
  readonly statements: readonly PrivacyPurgeDerivedStatement[];
}

export type PrivacyPurgeIntentTarget =
  | { readonly kind: "logical_page"; readonly subjectGenerationId: number }
  | { readonly kind: "run"; readonly subjectGenerationId: number }
  | { readonly kind: "resource_history"; readonly historyEpochId: number };

export interface EnumeratedPrivacyPurgeTarget {
  readonly tableName: string;
  readonly pkV1: string;
  readonly deleteRank: number;
  readonly liveActionDepth: number | null;
  readonly values: Readonly<Record<string, unknown>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new Error(`Invalid privacy purge SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function primaryKeyPart(value: unknown): PrivacyPurgePrimaryKeyPart {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { type: "integer", value };
  }
  if (typeof value === "bigint") return { type: "integer", value };
  if (typeof value === "string") return { type: "text", value };
  throw new Error("Privacy purge encountered a noncanonical primary key");
}

function primaryKeyColumns(
  connection: Database.Database,
  tableName: string,
): readonly string[] {
  const rows = connection.pragma(
    `table_info(${quoteIdentifier(tableName)})`,
  ) as Array<{ name: string; pk: number }>;
  return rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
}

function relationsFor(
  connection: Database.Database,
  tableNames: readonly string[],
): ReadonlyMap<string, readonly Relation[]> {
  const result = new Map<string, Relation[]>();
  for (const childTable of tableNames) {
    const rows = connection.pragma(
      `foreign_key_list(${quoteIdentifier(childTable)})`,
    ) as ForeignKeyRow[];
    const groups = new Map<number, ForeignKeyRow[]>();
    for (const row of rows) {
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    const relations: Relation[] = [];
    for (const group of groups.values()) {
      group.sort((left, right) => left.seq - right.seq);
      const parentTable = group[0]!.table;
      const parentPk = primaryKeyColumns(connection, parentTable);
      relations.push({
        childTable,
        parentTable,
        childColumns: group.map((row) => row.from),
        parentColumns: group.map((row, index) => row.to ?? parentPk[index]!),
      });
    }
    relations.sort((left, right) =>
      left.parentTable.localeCompare(right.parentTable, "en") ||
      left.childColumns.join("\u0000").localeCompare(
        right.childColumns.join("\u0000"),
        "en",
      )
    );
    result.set(childTable, relations);
  }
  return result;
}

function activeLogicalPageRunOwner(runIdExpression: string): string {
  return `EXISTS (
    WITH RECURSIVE logical_owned_runs(research_run_id) AS (
      SELECT run.id
      FROM research_runs AS run
      LEFT JOIN ai_jobs AS job ON job.id = run.job_id
      JOIN privacy_purge_intents AS intent
        ON intent.status IN ${activeStatuses}
       AND intent.target_kind = 'logical_page'
       AND (run.target_logical_page_id = intent.logical_page_id_snapshot
         OR job.logical_page_id = intent.logical_page_id_snapshot)
      UNION
      SELECT handoff.final_run_id
      FROM logical_owned_runs AS owned
      JOIN privacy_subject_generations AS generation
        ON generation.subject_kind = 'research_run'
       AND generation.research_run_id = owned.research_run_id
      JOIN live_acquisition_handoffs AS handoff
        ON handoff.coordinator_run_generation_id = generation.id
    )
    SELECT 1 FROM logical_owned_runs
    WHERE research_run_id = ${runIdExpression}
  )`;
}

function rootOwnerPredicate(root: string, rowRef: string): string {
  const active = `intent.status IN ${activeStatuses}`;
  if (root === "logical_pages") {
    return `EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
      WHERE ${active} AND intent.target_kind = 'logical_page'
        AND intent.logical_page_id_snapshot = ${rowRef}.id)`;
  }
  if (root === "research_history_epochs") {
    return `EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
      WHERE ${active} AND intent.target_kind = 'resource_history'
        AND intent.history_epoch_id = ${rowRef}.id)`;
  }
  if (root === "research_runs") {
    return `(EXISTS (SELECT 1
      FROM privacy_purge_intent_run_targets AS owned_run
      JOIN privacy_purge_intents AS intent
        ON intent.intent_key = owned_run.intent_key
      WHERE ${active} AND owned_run.research_run_id = ${rowRef}.id)
      OR ${activeLogicalPageRunOwner(`${rowRef}.id`)})`;
  }
  if (root === "ai_jobs") {
    return `(EXISTS (SELECT 1
      FROM privacy_purge_intent_run_targets AS owned_run
      JOIN privacy_purge_intents AS intent
        ON intent.intent_key = owned_run.intent_key
      WHERE ${active} AND owned_run.ai_job_id = ${rowRef}.id)
      OR EXISTS (
        SELECT 1 FROM privacy_purge_intents AS intent
        WHERE ${active} AND intent.target_kind = 'logical_page'
          AND intent.logical_page_id_snapshot = ${rowRef}.logical_page_id
      )
      OR EXISTS (
        SELECT 1 FROM research_runs AS owned_job_run
        WHERE owned_job_run.job_id = ${rowRef}.id
          AND ${activeLogicalPageRunOwner("owned_job_run.id")}
      ))`;
  }
  if (root === "privacy_subject_generations") {
    return `(EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
      LEFT JOIN privacy_purge_intent_run_targets AS owned_run
        ON owned_run.intent_key = intent.intent_key
      WHERE ${active} AND (
        intent.subject_generation_id = ${rowRef}.id
        OR owned_run.subject_generation_id = ${rowRef}.id
      )) OR (${rowRef}.subject_kind = 'research_run'
        AND ${activeLogicalPageRunOwner(`${rowRef}.research_run_id`)}))`;
  }
  throw new Error(`Unsupported privacy purge ownership root: ${root}`);
}

/** Exact schema-26 active-purge ownership predicate shared with read projections. */
export function activePrivacyPurgeOwnsResearchRunSql(rowAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowAlias)) {
    throw new TypeError("Research run SQL alias is invalid");
  }
  return rootOwnerPredicate("research_runs", rowAlias);
}

function pathPredicate(path: OwnershipPath, rowRef: string): string {
  if (path.relations.length === 0) {
    return rootOwnerPredicate([...path.visited][0]!, rowRef);
  }
  const aliases = path.relations.map((_relation, index) => `owner_${index}`);
  const joins: string[] = [];
  const where: string[] = [];
  for (const [index, relation] of path.relations.entries()) {
    const parentAlias = aliases[index]!;
    const childRef = index === 0 ? rowRef : aliases[index - 1]!;
    const comparisons = relation.childColumns.map((column, columnIndex) =>
      `${childRef}.${quoteIdentifier(column)} IS ${parentAlias}.${
        quoteIdentifier(relation.parentColumns[columnIndex]!)
      }`
    );
    if (index === 0) {
      where.push(...comparisons);
    } else {
      joins.push(
        `JOIN ${quoteIdentifier(relation.parentTable)} AS ${parentAlias}
          ON ${comparisons.join(" AND ")}`,
      );
    }
  }
  const first = path.relations[0]!;
  const root = path.relations.at(-1)!.parentTable;
  return `EXISTS (SELECT 1
    FROM ${quoteIdentifier(first.parentTable)} AS ${aliases[0]}
    ${joins.join("\n")}
    WHERE ${where.join(" AND ")}
      AND ${rootOwnerPredicate(root, aliases.at(-1)!)})`;
}

function ownershipPaths(
  tableName: string,
  relations: ReadonlyMap<string, readonly Relation[]>,
): readonly OwnershipPath[] {
  if (roots.has(tableName)) {
    return [{ relations: [], visited: new Set([tableName]) }];
  }
  const queue: OwnershipPath[] = [{
    relations: [],
    visited: new Set([tableName]),
  }];
  const completed: OwnershipPath[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]!;
    const current = path.relations.at(-1)?.parentTable ?? tableName;
    for (const relation of relations.get(current) ?? []) {
      if (path.visited.has(relation.parentTable)) continue;
      const visited = new Set(path.visited);
      visited.add(relation.parentTable);
      const next = { relations: [...path.relations, relation], visited };
      if (roots.has(relation.parentTable)) completed.push(next);
      else if (next.relations.length < 12) queue.push(next);
    }
    if (queue.length > 10_000) {
      throw new Error(`Privacy purge ownership graph exploded at ${tableName}`);
    }
  }
  const unique = new Map<string, OwnershipPath>();
  for (const path of completed) {
    const signature = path.relations.map((relation) =>
      `${relation.childTable}:${relation.childColumns.join(",")}->$${
        relation.parentTable
      }:${relation.parentColumns.join(",")}`
    ).join("|");
    unique.set(signature, path);
  }
  return [...unique.values()];
}

function ownedRunId(runIdExpression: string): string {
  return `EXISTS (SELECT 1
    FROM privacy_purge_intent_run_targets AS owned_run
    JOIN privacy_purge_intents AS intent ON intent.intent_key = owned_run.intent_key
    WHERE intent.status IN ${activeStatuses}
      AND owned_run.research_run_id = ${runIdExpression})`;
}

function privacyRequestOwner(rowRef: string, keyColumn = "idempotency_key"): string {
  return `EXISTS (
    SELECT 1 FROM research_privacy_run_bindings AS owned_binding
    WHERE owned_binding.idempotency_key = ${rowRef}.${quoteIdentifier(keyColumn)}
      AND ${ownedRunId("owned_binding.run_id")}
  ) AND NOT EXISTS (
    SELECT 1 FROM research_privacy_run_bindings AS retained_binding
    WHERE retained_binding.idempotency_key = ${rowRef}.${quoteIdentifier(keyColumn)}
      AND NOT ${ownedRunId("retained_binding.run_id")}
  )`;
}

function handoffReceiptCompletable(handoffRef: string): string {
  return `EXISTS (
    SELECT 1
    FROM research_runs AS final_run
    JOIN ai_jobs AS final_job ON final_job.id = final_run.job_id
    WHERE final_run.id = ${handoffRef}.final_run_id
      AND ${handoffRef}.status = 'assembling'
      AND final_job.status = 'queued' AND final_job.event_sequence = 1
      AND EXISTS (
        SELECT 1 FROM ai_job_events AS event
        WHERE event.job_id = final_job.id AND event.sequence_no = 1
          AND event.event_type = 'submitted' AND event.to_status = 'queued'
      )
      AND EXISTS (
        SELECT 1 FROM research_run_events AS event
        WHERE event.run_id = final_run.id AND event.sequence_no = 1
          AND event.event_type = 'queued' AND event.status = 'queued'
      )
      AND EXISTS (
        SELECT 1 FROM live_acquisition_provider_reservations AS reservation
        WHERE reservation.handoff_id = ${handoffRef}.id
          AND reservation.final_job_id = final_job.id
          AND reservation.status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM live_acquisition_source_receipts
        WHERE handoff_id = ${handoffRef}.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM research_sources AS assembled_source
        WHERE assembled_source.run_id = final_run.id AND (
          assembled_source.inclusion_state <> 'included'
          OR NOT EXISTS (
            SELECT 1 FROM research_source_heads AS head
            WHERE head.source_id = assembled_source.id AND head.state = 'valid'
          )
          OR NOT EXISTS (
            SELECT 1 FROM research_source_state_events AS accepted
            WHERE accepted.source_id = assembled_source.id
              AND accepted.sequence_no = 1
              AND accepted.event_type = 'accepted' AND accepted.state = 'valid'
          )
          OR NOT EXISTS (
            SELECT 1 FROM research_source_payloads AS payload
            WHERE payload.source_id = assembled_source.id
          )
          OR EXISTS (
            SELECT 1 FROM research_source_state_events AS successor
            WHERE successor.source_id = assembled_source.id
              AND successor.sequence_no > 1
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM live_acquisition_source_receipts AS receipt
        WHERE receipt.handoff_id = ${handoffRef}.id AND NOT EXISTS (
          SELECT 1 FROM research_sources AS source
          JOIN research_source_state_events AS event
            ON event.source_id = source.id AND event.sequence_no = 1
            AND event.event_type = 'accepted' AND event.state = 'valid'
          JOIN research_source_payloads AS payload ON payload.source_id = source.id
          WHERE source.handoff_source_receipt_id = receipt.id
            AND source.run_id = receipt.final_run_id
            AND source.ordinal = receipt.ordinal
            AND source.logical_page_id = receipt.logical_page_id
            AND source.inclusion_state = receipt.inclusion_state
            AND source.included_order = receipt.included_order
            AND source.content_revision = receipt.content_revision
            AND source.content_digest = receipt.content_digest
            AND source.extracted_at = receipt.extracted_at
            AND NOT EXISTS (
              SELECT 1 FROM research_source_state_events AS successor
              WHERE successor.source_id = source.id
                AND successor.sequence_no > 1
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM live_acquisition_source_receipts AS receipt
        WHERE receipt.handoff_id = ${handoffRef}.id AND NOT EXISTS (
          SELECT 1 FROM live_acquisition_capture_manifests AS capture
          JOIN live_acquisition_consents AS consent ON consent.id = capture.consent_id
          WHERE capture.id = receipt.capture_manifest_id
            AND capture.logical_page_generation_id
              = receipt.logical_page_generation_id
            AND capture.depth = receipt.depth
            AND capture.capture_sequence = receipt.capture_sequence
            AND capture.content_digest = receipt.content_digest
            AND capture.manifest_json = receipt.manifest_json
            AND consent.coordinator_run_generation_id
              = ${handoffRef}.coordinator_run_generation_id
        )
      )
  )`;
}

function ownershipPredicate(
  tableName: string,
  rowRef: string,
  relations: ReadonlyMap<string, readonly Relation[]>,
): string {
  if (tableName === "research_privacy_requests" ||
    tableName === "research_redaction_receipts") {
    return `(${privacyRequestOwner(rowRef)})`;
  }
  if (tableName === "research_privacy_event_bindings") {
    return `(${privacyRequestOwner(rowRef)})`;
  }
  if (tableName === "research_snapshot_payloads" ||
    tableName === "research_snapshot_state_events") {
    const typed = [
      ["page_context", "research_page_context_snapshots"],
      ["resource_context", "research_resource_context_snapshots"],
      ["activity", "research_activity_snapshots"],
      ["relation", "research_relation_snapshots"],
    ] as const;
    return `(${typed.map(([kind, snapshotTable], index) => {
      const alias = `typed_snapshot_${index}`;
      return `(${rowRef}.kind = '${kind}' AND EXISTS (
        SELECT 1 FROM ${snapshotTable} AS ${alias}
        WHERE ${alias}.id = ${rowRef}.snapshot_id
          AND ${ownershipPredicate(snapshotTable, alias, relations)}
      ))`;
    }).join(" OR ")})`;
  }
  const paths = ownershipPaths(tableName, relations);
  if (paths.length === 0) {
    throw new Error(`Privacy purge target has no ownership path: ${tableName}`);
  }
  return `(${paths.map((path) => pathPredicate(path, rowRef)).join(" OR ")})`;
}

function drainAllowance(
  tableName: string,
  operation: string,
  oldPk: string,
  newPk: string,
  newContentDigest?: string,
): string {
  if (operation === "INSERT") {
    if (newContentDigest === undefined) {
      throw new Error("Privacy purge INSERT fence requires a row-content digest");
    }
    return `EXISTS (
      SELECT 1 FROM privacy_purge_intents AS drain_intent
      WHERE drain_intent.status = 'waiting'
        AND tabhub_purge26_drain_insert_v1(
          drain_intent.intent_key, '${tableName}', ${newPk}, ${newContentDigest}
        ) = 1
    )`;
  }
  return `EXISTS (
    SELECT 1 FROM privacy_purge_intents AS drain_intent
    WHERE drain_intent.status = 'waiting'
      AND tabhub_purge26_drain_v1(
        drain_intent.intent_key, '${tableName}', '${operation}',
        ${oldPk}, ${newPk}
      ) = 1
  )`;
}

function externalAbortAllowance(
  tableName: string,
  operation: string,
  oldPk: string,
  newPk: string,
  newContentDigest: string,
): string {
  if (!((tableName === "live_acquisition_action_events" && operation === "INSERT") ||
      (tableName === "live_acquisition_actions" && operation === "UPDATE"))) {
    return "0";
  }
  return `EXISTS (
    SELECT 1 FROM privacy_purge_action_abort_requests AS abort_request
    WHERE abort_request.request_kind = 'current_exact'
      AND abort_request.action_id = ${tableName === "live_acquisition_actions"
        ? "NEW.id" : "NEW.action_id"}
      AND tabhub_purge26_external_abort_v1(
        abort_request.request_digest, abort_request.action_id,
        abort_request.execution_key_digest, '${tableName}', '${operation}',
        ${oldPk}, ${newPk}, ${newContentDigest}
      ) = 1
  )`;
}

function executorDeleteAllowance(tableName: string, oldPk: string): string {
  return `EXISTS (
    SELECT 1
    FROM privacy_purge_intents AS executor_intent
    JOIN privacy_purge_intent_execution_targets AS frozen_target
      ON frozen_target.intent_key = executor_intent.intent_key
    WHERE executor_intent.status = 'committed'
      AND executor_intent.purge_command_id IS NOT NULL
      AND frozen_target.table_name = '${tableName}'
      AND frozen_target.pk_v1 = ${oldPk}
      AND tabhub_purge_finalization_active_v1(
        executor_intent.purge_command_id
      ) = 1
      AND tabhub_purge26_executor_v1(
        executor_intent.intent_key, executor_intent.purge_command_id,
        '${tableName}', ${oldPk}, 'DELETE'
      ) = 1
  )`;
}

function knownUsageExists(waitRef: string, terminalSequence: string): string {
  return `EXISTS (
    SELECT 1 FROM ai_job_events AS known_usage
    WHERE known_usage.job_id = ${waitRef}.job_id
      AND known_usage.attempt_id = ${waitRef}.attempt_id
      AND known_usage.event_type = 'progress'
      AND known_usage.sequence_no > ${waitRef}.event_sequence
      AND known_usage.sequence_no < ${terminalSequence}
      AND known_usage.delta_steps > 0
      AND known_usage.occurred_at <= ${waitRef}.settlement_deadline_at
      AND tabhub_sha256_v1(known_usage.lease_token)
        = ${waitRef}.lease_token_digest
  )`;
}

function relationalDrainAllowance(
  tableName: string,
  operation: "INSERT" | "UPDATE",
): string {
  const oneWaiting = `(SELECT COUNT(*) FROM privacy_purge_intents
    WHERE status = 'waiting') = 1`;
  if (tableName === "live_acquisition_handoff_receipts" && operation === "INSERT") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_run_targets AS wait
        ON wait.intent_key = intent.intent_key
      JOIN live_acquisition_handoffs AS handoff ON handoff.id = wait.handoff_id
      WHERE intent.status = 'waiting' AND intent.target_kind = 'run'
        AND wait.is_root = 0 AND wait.handoff_status = 'assembling'
        AND NEW.handoff_id = wait.handoff_id
        AND NEW.receipt_digest = wait.handoff_receipt_digest
        AND NEW.completed_at = wait.handoff_receipt_completed_at
        AND ${handoffReceiptCompletable("handoff")}
    ))`;
  }
  if (tableName === "live_acquisition_handoffs" && operation === "UPDATE") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_run_targets AS wait
        ON wait.intent_key = intent.intent_key
      JOIN live_acquisition_handoff_receipts AS receipt
        ON receipt.handoff_id = wait.handoff_id
      WHERE intent.status = 'waiting' AND wait.handoff_status = 'assembling'
        AND OLD.id = wait.handoff_id AND NEW.id = OLD.id
        AND OLD.status = 'assembling' AND OLD.completed_at IS NULL
        AND NEW.status = 'completed'
        AND NEW.completed_at = wait.handoff_receipt_completed_at
        AND receipt.receipt_digest = wait.handoff_receipt_digest
        AND receipt.completed_at = wait.handoff_receipt_completed_at
        AND NEW.coordinator_run_generation_id IS OLD.coordinator_run_generation_id
        AND NEW.final_run_id IS OLD.final_run_id AND NEW.created_at IS OLD.created_at
    ))`;
  }
  if (tableName === "ai_job_events" && operation === "INSERT") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1
      FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_job_waits AS wait
        ON wait.intent_key = intent.intent_key
      JOIN ai_jobs AS job ON job.id = wait.job_id
      JOIN ai_job_attempts AS attempt ON attempt.id = wait.attempt_id
      LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
        ON adoption.attempt_id = wait.attempt_id
        AND adoption.final_job_id = wait.job_id
      LEFT JOIN live_acquisition_provider_reservations AS reservation
        ON reservation.id = wait.provider_reservation_id
      WHERE intent.status = 'waiting' AND wait.status = 'running'
        AND wait.request_bound = 1 AND wait.provider_usage_state = 'pending'
        AND NEW.job_id = wait.job_id AND job.status = 'running'
        AND NEW.sequence_no = job.event_sequence + 1
        AND NEW.sequence_no > wait.event_sequence
        AND NEW.occurred_at <= wait.settlement_deadline_at
        AND attempt.job_id = wait.job_id AND attempt.attempt_no = wait.attempt_no
        AND attempt.worker_id = wait.worker_id AND attempt.outcome = 'running'
        AND tabhub_sha256_v1(attempt.lease_token) = wait.lease_token_digest
        AND tabhub_sha256_v1(attempt.request_id) = wait.request_id_digest
        AND attempt.request_bound_at = wait.request_bound_at
        AND attempt.provider IS wait.provider AND attempt.model IS wait.model
        AND attempt.prompt_version IS wait.prompt_version
        AND attempt.pricing_version IS wait.pricing_version
        AND adoption.utc_date IS wait.provider_adoption_utc_date
        AND adoption.adopted_at IS wait.provider_adopted_at
        AND adoption.reservation_id IS wait.provider_reservation_id
        AND (
          (wait.provider_reservation_id IS NULL AND reservation.id IS NULL)
          OR (reservation.final_job_id = wait.job_id
            AND reservation.utc_date = wait.provider_reservation_utc_date
            AND reservation.reserved_usd = wait.provider_reserved_usd
            AND reservation.consumed_usd = wait.provider_consumed_usd + COALESCE((
              SELECT SUM(prior_usage.delta_cost_usd)
              FROM ai_job_events AS prior_usage
              WHERE prior_usage.job_id = wait.job_id
                AND prior_usage.attempt_id = wait.attempt_id
                AND prior_usage.event_type = 'progress'
                AND prior_usage.sequence_no > wait.event_sequence
                AND prior_usage.sequence_no < NEW.sequence_no
                AND tabhub_sha256_v1(prior_usage.lease_token)
                  = wait.lease_token_digest
            ), 0)
            AND reservation.status = wait.provider_reservation_status
            AND reservation.status = 'active')
        )
        AND NEW.event_type IN ('progress', 'cancel_requested', 'failed', 'cancelled')
        AND (
          (NEW.event_type = 'progress'
            AND NEW.from_status = 'running' AND NEW.to_status = 'running'
            AND NEW.attempt_id = wait.attempt_id
            AND tabhub_sha256_v1(NEW.lease_token) = wait.lease_token_digest
            AND NEW.lease_owner = wait.worker_id
            AND NEW.lease_expires_at <= wait.settlement_deadline_at
            AND NEW.spent_steps = job.spent_steps + NEW.delta_steps
            AND NEW.spent_tokens = job.spent_tokens
              + NEW.delta_input_tokens + NEW.delta_output_tokens
            AND NEW.spent_input_tokens = (
              SELECT COALESCE(SUM(input_tokens), 0) FROM ai_job_attempts
              WHERE job_id = wait.job_id
            ) + NEW.delta_input_tokens
            AND NEW.spent_output_tokens = (
              SELECT COALESCE(SUM(output_tokens), 0) FROM ai_job_attempts
              WHERE job_id = wait.job_id
            ) + NEW.delta_output_tokens
            AND NEW.spent_cost_usd = job.spent_cost_usd + NEW.delta_cost_usd
            AND NEW.spent_wall_time_ms
              = job.spent_wall_time_ms + NEW.delta_wall_time_ms
            AND (wait.provider_reservation_id IS NULL
              OR NEW.delta_cost_usd = 0 OR
              reservation.consumed_usd + NEW.delta_cost_usd
                <= reservation.reserved_usd))
          OR (NEW.event_type = 'cancel_requested'
            AND NEW.from_status = 'running' AND NEW.to_status = 'running'
            AND NEW.attempt_id IS NULL AND NEW.lease_token IS NULL
            AND ${knownUsageExists("wait", "NEW.sequence_no")})
          OR (NEW.event_type IN ('failed', 'cancelled')
            AND NEW.from_status = 'running' AND NEW.to_status = NEW.event_type
            AND NEW.attempt_id = wait.attempt_id
            AND tabhub_sha256_v1(NEW.lease_token) = wait.lease_token_digest
            AND ${knownUsageExists("wait", "NEW.sequence_no")})
        )
        AND NOT EXISTS (
          SELECT 1 FROM ai_job_events AS intervening
          WHERE intervening.job_id = wait.job_id
            AND intervening.sequence_no > wait.event_sequence
            AND intervening.sequence_no < NEW.sequence_no
            AND (intervening.event_type NOT IN (
              'progress', 'cancel_requested', 'failed', 'cancelled'
            ) OR (intervening.attempt_id IS NOT NULL
              AND intervening.attempt_id <> wait.attempt_id))
        )
    ))`;
  }
  if (tableName === "ai_job_attempts" && operation === "UPDATE") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1 FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_job_waits AS wait
        ON wait.intent_key = intent.intent_key
      JOIN ai_jobs AS job ON job.id = wait.job_id
      JOIN ai_job_events AS event
        ON event.job_id = wait.job_id AND event.sequence_no = job.event_sequence + 1
      WHERE intent.status = 'waiting' AND wait.request_bound = 1
        AND OLD.id = wait.attempt_id AND NEW.id = OLD.id
        AND NEW.job_id = OLD.job_id AND NEW.attempt_no = OLD.attempt_no
        AND NEW.lease_token IS OLD.lease_token AND NEW.worker_id IS OLD.worker_id
        AND NEW.provider IS OLD.provider AND NEW.model IS OLD.model
        AND NEW.prompt_version IS OLD.prompt_version
        AND NEW.provider_bound_at IS OLD.provider_bound_at
        AND NEW.request_id IS OLD.request_id
        AND NEW.request_bound_at IS OLD.request_bound_at
        AND NEW.started_at IS OLD.started_at
        AND event.attempt_id = wait.attempt_id
        AND tabhub_sha256_v1(event.lease_token) = wait.lease_token_digest
        AND event.event_type IN ('progress', 'failed', 'cancelled')
        AND event.occurred_at <= wait.settlement_deadline_at
        AND ((event.event_type = 'progress' AND NEW.outcome = 'running'
          AND NEW.completed_at IS NULL)
          OR (event.event_type IN ('failed', 'cancelled')
            AND NEW.completed_at = event.occurred_at
            AND NEW.outcome IN ('failed', 'cancelled', 'interrupted')
            AND ${knownUsageExists("wait", "event.sequence_no")}))
    ))`;
  }
  if (tableName === "ai_jobs" && operation === "UPDATE") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1 FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_job_waits AS wait
        ON wait.intent_key = intent.intent_key
      JOIN ai_job_events AS event
        ON event.job_id = wait.job_id AND event.sequence_no = NEW.event_sequence
      WHERE intent.status = 'waiting' AND wait.request_bound = 1
        AND OLD.id = wait.job_id AND NEW.id = OLD.id
        AND NEW.event_sequence = OLD.event_sequence + 1
        AND NEW.event_sequence > wait.event_sequence
        AND event.event_type IN ('progress', 'cancel_requested', 'failed', 'cancelled')
        AND event.occurred_at <= wait.settlement_deadline_at
        AND NEW.status = event.to_status
        AND NEW.result_type IS NULL AND NEW.result_output_fingerprint IS NULL
        AND NEW.result_report_id IS NULL
        AND (event.event_type IN ('progress', 'cancel_requested')
          OR ${knownUsageExists("wait", "event.sequence_no")})
    ))`;
  }
  if (tableName === "research_run_events" && operation === "INSERT") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1 FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_job_waits AS wait
        ON wait.intent_key = intent.intent_key
      JOIN research_runs AS run ON run.job_id = wait.job_id
      JOIN ai_job_events AS event ON event.job_id = wait.job_id
      WHERE intent.status = 'waiting' AND wait.request_bound = 1
        AND NEW.run_id = run.id AND event.id = CAST(
          substr(NEW.idempotency_key, length('ai-job-event:') + 1) AS INTEGER
        )
        AND NEW.idempotency_key = 'ai-job-event:' || event.id
        AND event.event_type IN ('failed', 'cancelled')
        AND NEW.event_type = event.event_type AND NEW.status = event.to_status
        AND NEW.report_id IS NULL AND NEW.occurred_at = event.occurred_at
        AND event.sequence_no > wait.event_sequence
        AND event.occurred_at <= wait.settlement_deadline_at
        AND ${knownUsageExists("wait", "event.sequence_no")}
    ))`;
  }
  if (tableName === "live_acquisition_provider_reservations" && operation === "UPDATE") {
    return `(${oneWaiting} AND EXISTS (
      SELECT 1 FROM privacy_purge_intents AS intent
      JOIN privacy_purge_intent_job_waits AS wait
        ON wait.intent_key = intent.intent_key
      JOIN ai_job_events AS event ON event.job_id = wait.job_id
      WHERE intent.status = 'waiting' AND wait.request_bound = 1
        AND OLD.id = wait.provider_reservation_id AND NEW.id = OLD.id
        AND NEW.handoff_id IS OLD.handoff_id
        AND NEW.final_job_id IS OLD.final_job_id
        AND NEW.utc_date IS OLD.utc_date AND NEW.reserved_usd IS OLD.reserved_usd
        AND NEW.created_at IS OLD.created_at
        AND event.sequence_no > wait.event_sequence
        AND event.sequence_no = (
          SELECT MAX(latest.sequence_no) FROM ai_job_events AS latest
          WHERE latest.job_id = wait.job_id
        )
        AND event.attempt_id = wait.attempt_id
        AND tabhub_sha256_v1(event.lease_token) = wait.lease_token_digest
        AND event.occurred_at <= wait.settlement_deadline_at
        AND ((event.event_type = 'progress' AND event.delta_cost_usd > 0
          AND OLD.status = wait.provider_reservation_status
          AND OLD.consumed_usd = wait.provider_consumed_usd + COALESCE((
            SELECT SUM(prior_usage.delta_cost_usd)
            FROM ai_job_events AS prior_usage
            WHERE prior_usage.job_id = wait.job_id
              AND prior_usage.attempt_id = wait.attempt_id
              AND prior_usage.event_type = 'progress'
              AND prior_usage.sequence_no > wait.event_sequence
              AND prior_usage.sequence_no < event.sequence_no
              AND tabhub_sha256_v1(prior_usage.lease_token)
                = wait.lease_token_digest
          ), 0)
          AND NEW.status = 'active' AND NEW.terminal_at IS NULL
          AND NEW.consumed_usd = OLD.consumed_usd + event.delta_cost_usd)
          OR (event.event_type IN ('failed', 'cancelled')
            AND OLD.status = wait.provider_reservation_status
            AND OLD.consumed_usd = wait.provider_consumed_usd + COALESCE((
              SELECT SUM(prior_usage.delta_cost_usd)
              FROM ai_job_events AS prior_usage
              WHERE prior_usage.job_id = wait.job_id
                AND prior_usage.attempt_id = wait.attempt_id
                AND prior_usage.event_type = 'progress'
                AND prior_usage.sequence_no > wait.event_sequence
                AND prior_usage.sequence_no < event.sequence_no
                AND tabhub_sha256_v1(prior_usage.lease_token)
                  = wait.lease_token_digest
            ), 0)
            AND NEW.consumed_usd IS OLD.consumed_usd
            AND NEW.terminal_at = event.occurred_at
            AND NEW.status = CASE WHEN OLD.consumed_usd = OLD.reserved_usd
              THEN 'consumed' ELSE 'released' END
            AND ${knownUsageExists("wait", "event.sequence_no")}))
    ))`;
  }
  return "0";
}

export function buildPrivacyPurgeMutationFences(
  connection: Database.Database,
): readonly PrivacyPurgeMutationFence[] {
  const catalog = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all() as TargetCatalogRow[];
  if (catalog.length !== PRIVACY_PURGE_TARGET_TABLE_COUNT) {
    throw new Error(
      `Privacy purge target catalog has ${catalog.length} rows, expected 65`,
    );
  }
  const allTables = connection.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).pluck().all() as string[];
  const relations = relationsFor(connection, allTables);
  const fences: PrivacyPurgeMutationFence[] = [];
  for (const target of catalog) {
    const oldPk = `(${target.pk_expression_sql})`;
    const newPk = `(${target.pk_expression_sql.replaceAll("OLD.", "NEW.")})`;
    const oldOwner = ownershipPredicate(target.table_name, "OLD", relations);
    const newOwner = ownershipPredicate(target.table_name, "NEW", relations);
    const columns = (connection.pragma(
      `table_info(${quoteIdentifier(target.table_name)})`,
    ) as Array<{ name: string }>).map((column) => column.name);
    const newContentDigest = `tabhub_sha256_v1(json_object(${columns.flatMap(
      (column) => [`'${column}'`, `NEW.${quoteIdentifier(column)}`],
    ).join(", ")}))`;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const triggerName = `privacy_purge26_${target.table_name}_${
        operation.toLowerCase()
      }_fence`;
      const owned = operation === "INSERT"
        ? newOwner
        : operation === "DELETE"
        ? oldOwner
        : `(${oldOwner} OR ${newOwner})`;
      const oldArgument = operation === "INSERT" ? "''" : oldPk;
      const newArgument = operation === "DELETE" ? "''" : newPk;
      const allowed = operation === "DELETE"
        ? executorDeleteAllowance(target.table_name, oldPk)
        : `(${drainAllowance(
          target.table_name,
          operation,
          oldArgument,
          newArgument,
          newContentDigest,
        )} OR ${relationalDrainAllowance(target.table_name, operation)}
          OR ${externalAbortAllowance(target.table_name, operation,
            oldArgument, newArgument, newContentDigest)})`;
      const timing = operation === "INSERT" ? "AFTER" : "BEFORE";
      const sql = `CREATE TRIGGER ${quoteIdentifier(triggerName)}
${timing} ${operation} ON ${quoteIdentifier(target.table_name)}
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
  OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
  OR ((${owned}) AND NOT (${allowed}))
BEGIN
  SELECT RAISE(ABORT, 'schema26 privacy purge mutation fence');
END;`;
      fences.push({
        tableName: target.table_name,
        operation,
        ownerGroup: target.table_name.startsWith("research_privacy_") ||
            target.table_name === "research_redaction_receipts"
          ? "exclusive_privacy_request"
          : target.table_name.startsWith("research_snapshot_")
          ? "typed_snapshot"
          : "schema_fk_closure",
        oldOwnerPredicate: oldOwner,
        newOwnerPredicate: newOwner,
        exceptionClass: operation === "DELETE" ? "executor_delete" : "drain",
        triggerName,
        sql,
        oldOwnerPredicateDigest: sha256(oldOwner),
        newOwnerPredicateDigest: sha256(newOwner),
        triggerSqlDigest: sha256(sql),
      });
    }
  }
  if (fences.length !== PRIVACY_PURGE_MUTATION_FENCE_COUNT) {
    throw new Error("Privacy purge mutation fence matrix is incomplete");
  }
  return fences;
}

function sourceTrigger(sql: string): {
  sourceOperation: "INSERT" | "UPDATE" | "DELETE";
  sourceTable: string;
} {
  const match = /\b(?:BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+[^\n]+)?\s+ON\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)/i
    .exec(sql);
  if (match === null) throw new Error("Cannot parse derived mutation source trigger");
  return {
    sourceOperation: match[1]!.toUpperCase() as "INSERT" | "UPDATE" | "DELETE",
    sourceTable: match[2]!,
  };
}

export function derivePrivacyPurgeTriggerMutations(
  connection: Database.Database,
): readonly PrivacyPurgeDerivedMutation[] {
  const targets = new Set(connection.prepare(`
    SELECT table_name FROM privacy_purge_target_catalog
  `).pluck().all() as string[]);
  const triggers = connection.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND sql IS NOT NULL
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>;
  const result: PrivacyPurgeDerivedMutation[] = [];
  const statementPattern = /\b(INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|UPDATE(?:\s+OR\s+[A-Z]+)?|DELETE\s+FROM)\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const trigger of triggers) {
    const statements: PrivacyPurgeDerivedStatement[] = [];
    for (const match of trigger.sql.matchAll(statementPattern)) {
      const targetTable = match[2]!;
      if (!targets.has(targetTable)) continue;
      const keyword = match[1]!.toUpperCase();
      const operation = keyword.startsWith("INSERT")
        ? "INSERT"
        : keyword.startsWith("DELETE")
        ? "DELETE"
        : "UPDATE";
      const possibleOperations = operation === "INSERT" &&
          targetTable === "research_target_heads" &&
          /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(trigger.sql)
        ? ["INSERT", "UPDATE"] as const
        : [operation] as const;
      statements.push({
        ordinal: statements.length,
        operation,
        possibleOperations,
        targetTable,
      });
    }
    if (statements.length === 0) continue;
    const source = sourceTrigger(trigger.sql);
    result.push({
      triggerName: trigger.name,
      triggerSqlDigest: sha256(trigger.sql),
      ...source,
      statements,
    });
  }
  const statementCount = result.reduce(
    (count, mutation) => count + mutation.statements.length,
    0,
  );
  const paths = new Set(result.flatMap((mutation) =>
    mutation.statements.map((statement) =>
      `${mutation.triggerName}\u0000${statement.operation}\u0000${statement.targetTable}`
    )
  ));
  const executorDeleteDerivedWrites = result.filter((mutation) =>
    mutation.sourceOperation === "DELETE" && targets.has(mutation.sourceTable) &&
    mutation.statements.some((statement) =>
      statement.possibleOperations.some((operation) => operation !== "DELETE")
    )
  );
  if (executorDeleteDerivedWrites.length !== 0) {
    throw new Error(
      "Privacy purge execution-target DELETE has an unfenced derived write",
    );
  }
  if (
    result.length !== PRIVACY_PURGE_DERIVED_TRIGGER_COUNT ||
    statementCount !== PRIVACY_PURGE_DERIVED_STATEMENT_COUNT ||
    paths.size !== PRIVACY_PURGE_DERIVED_PATH_COUNT
  ) {
    throw new Error(
      `Privacy purge derived mutation inventory drifted: ${result.length}/${
        statementCount
      }/${paths.size}`,
    );
  }
  return result;
}

export function buildPrivacyPurgeDerivedSourceGuards(
  connection: Database.Database,
): readonly string[] {
  const mutations = derivePrivacyPurgeTriggerMutations(connection);
  const targetTables = new Set(connection.prepare(`
    SELECT table_name FROM privacy_purge_target_catalog
  `).pluck().all() as string[]);
  const allTables = connection.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).pluck().all() as string[];
  const relations = relationsFor(connection, allTables);
  const guardedSources = [...new Set(mutations.filter((mutation) =>
    mutation.sourceOperation === "DELETE" &&
    !targetTables.has(mutation.sourceTable) &&
    mutation.statements.some((statement) =>
      statement.possibleOperations.some((operation) => operation !== "DELETE")
    )
  ).map((mutation) => mutation.sourceTable))].sort();
  return guardedSources.map((tableName) => `CREATE TRIGGER ${quoteIdentifier(
    `privacy_purge26_${tableName}_derived_delete_guard`,
  )}
BEFORE DELETE ON ${quoteIdentifier(tableName)}
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
  OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
  OR ${ownershipPredicate(tableName, "OLD", relations)}
BEGIN
  SELECT RAISE(ABORT, 'schema26 blocks external derived DELETE mutation');
END;`);
}

/**
 * Enumerates the exact schema-25 deletion closure without publishing a command.
 * The five schema-24 polymorphic/reverse-owned families are deliberately added
 * outside the FK walk so a shared privacy request is retained.
 */
/** Internal generated-ownership compiler seam; it grants no mutation authority. */
export function compilePrivacyPurgeTargetCandidatesV26(
  connection: Database.Database,
  target: PrivacyPurgeIntentTarget,
): readonly EnumeratedPrivacyPurgeTarget[] {
  const catalogRows = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all() as TargetCatalogRow[];
  if (catalogRows.length !== PRIVACY_PURGE_TARGET_TABLE_COUNT) {
    throw new Error("Privacy purge target catalog is incomplete");
  }
  const catalog = new Map(catalogRows.map((row) => [row.table_name, row]));
  const tableNames = connection.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).pluck().all() as string[];
  const relationMap = relationsFor(connection, tableNames);
  const children = new Map<string, Relation[]>();
  for (const relations of relationMap.values()) {
    for (const relation of relations) {
      if (!catalog.has(relation.childTable)) continue;
      const values = children.get(relation.parentTable) ?? [];
      values.push(relation);
      children.set(relation.parentTable, values);
    }
  }
  const pkCache = new Map<string, readonly string[]>();
  const pkFor = (tableName: string): readonly string[] => {
    const cached = pkCache.get(tableName);
    if (cached !== undefined) return cached;
    const columns = primaryKeyColumns(connection, tableName);
    if (columns.length === 0) {
      throw new Error(`Privacy purge table has no primary key: ${tableName}`);
    }
    pkCache.set(tableName, columns);
    return columns;
  };
  const readOne = (
    tableName: string,
    predicate: string,
    parameters: readonly unknown[],
  ): Readonly<Record<string, unknown>> => {
    const row = connection.prepare(`
      SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${predicate}
    `).get(...parameters) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("SUBJECT_FORGOTTEN_OR_INVALID");
    return row;
  };
  const queue: Array<{
    tableName: string;
    values: Readonly<Record<string, unknown>>;
  }> = [];
  const traversed = new Set<string>();
  const result = new Map<string, EnumeratedPrivacyPurgeTarget>();
  const identityFor = (
    tableName: string,
    values: Readonly<Record<string, unknown>>,
  ): { pkV1: string; identity: string } => {
    const pkV1 = encodePrivacyPurgePrimaryKeyV1(
      pkFor(tableName).map((column) => primaryKeyPart(values[column])),
    );
    return { pkV1, identity: `${tableName}\u0000${pkV1}` };
  };
  const addTargetOnly = (
    tableName: string,
    values: Readonly<Record<string, unknown>>,
  ): void => {
    const entry = catalog.get(tableName);
    if (entry === undefined) return;
    const { pkV1, identity } = identityFor(tableName, values);
    if (result.has(identity)) return;
    result.set(identity, {
      tableName,
      pkV1,
      deleteRank: entry.delete_rank,
      liveActionDepth: tableName === "live_acquisition_actions" &&
          typeof values.depth === "number"
        ? values.depth
        : null,
      values: Object.freeze({ ...values }),
    });
  };
  const addRow = (
    tableName: string,
    values: Readonly<Record<string, unknown>>,
  ): void => {
    const { identity } = identityFor(tableName, values);
    if (traversed.has(identity)) return;
    traversed.add(identity);
    queue.push({ tableName, values });
    addTargetOnly(tableName, values);

    if (tableName === "research_runs") {
      addRow("ai_jobs", readOne("ai_jobs", "id = ?", [values.job_id]));
      const generations = connection.prepare(`
        SELECT * FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ?
        ORDER BY id
      `).all(values.id) as Array<Record<string, unknown>>;
      for (const generation of generations) {
        addRow("privacy_subject_generations", generation);
      }
    } else if (tableName === "live_acquisition_handoffs") {
      addRow(
        "research_runs",
        readOne("research_runs", "id = ?", [values.final_run_id]),
      );
    }
  };

  if (target.kind === "logical_page") {
    const generation = readOne(
      "privacy_subject_generations",
      "id = ? AND subject_kind = 'logical_page' AND is_active = 1",
      [target.subjectGenerationId],
    );
    addRow("privacy_subject_generations", generation);
    addRow("logical_pages", readOne("logical_pages", "id = ?", [
      generation.logical_page_id,
    ]));
  } else if (target.kind === "run") {
    const generation = readOne(
      "privacy_subject_generations",
      "id = ? AND subject_kind = 'research_run' AND is_active = 1",
      [target.subjectGenerationId],
    );
    addRow("privacy_subject_generations", generation);
    addRow("research_runs", readOne("research_runs", "id = ?", [
      generation.research_run_id,
    ]));
  } else {
    addRow(
      "research_history_epochs",
      readOne("research_history_epochs", "id = ? AND is_active = 1", [
        target.historyEpochId,
      ]),
    );
  }

  for (let index = 0; index < queue.length; index += 1) {
    if (result.size > 250_000) {
      throw new Error("Privacy purge target limit exceeded");
    }
    const parent = queue[index]!;
    for (const relation of children.get(parent.tableName) ?? []) {
      const parentPk = pkFor(parent.tableName);
      const values = relation.parentColumns.map((column, sequence) =>
        parent.values[column ?? parentPk[sequence]!]
      );
      if (values.some((value) => value === null || value === undefined)) continue;
      const predicate = relation.childColumns.map((column) =>
        `${quoteIdentifier(column)} IS ?`
      ).join(" AND ");
      const rows = connection.prepare(`
        SELECT * FROM ${quoteIdentifier(relation.childTable)}
        WHERE ${predicate}
      `).all(...values) as Array<Record<string, unknown>>;
      for (const row of rows) addRow(relation.childTable, row);
    }
  }

  const typedSnapshots = [
    ["page_context", "research_page_context_snapshots"],
    ["resource_context", "research_resource_context_snapshots"],
    ["activity", "research_activity_snapshots"],
    ["relation", "research_relation_snapshots"],
  ] as const;
  for (const [kind, tableName] of typedSnapshots) {
    const ownedIds = [...result.values()]
      .filter((entry) => entry.tableName === tableName)
      .map((entry) => entry.values.id);
    for (const snapshotId of ownedIds) {
      const payload = connection.prepare(`
        SELECT * FROM research_snapshot_payloads
        WHERE kind = ? AND snapshot_id = ?
      `).get(kind, snapshotId) as Record<string, unknown> | undefined;
      if (payload !== undefined) addTargetOnly("research_snapshot_payloads", payload);
      const events = connection.prepare(`
        SELECT * FROM research_snapshot_state_events
        WHERE kind = ? AND snapshot_id = ? ORDER BY id
      `).all(kind, snapshotId) as Array<Record<string, unknown>>;
      for (const event of events) {
        addTargetOnly("research_snapshot_state_events", event);
      }
    }
  }

  const ownedBindingKeys = new Set([...result.values()]
    .filter((entry) => entry.tableName === "research_privacy_run_bindings")
    .map((entry) => String(entry.values.idempotency_key)));
  for (const idempotencyKey of ownedBindingKeys) {
    const allBindings = connection.prepare(`
      SELECT * FROM research_privacy_run_bindings
      WHERE idempotency_key = ? ORDER BY run_id
    `).all(idempotencyKey) as Array<Record<string, unknown>>;
    const exclusive = allBindings.every((binding) => {
      const { identity } = identityFor("research_privacy_run_bindings", binding);
      return result.has(identity);
    });
    if (!exclusive) continue;
    const request = connection.prepare(`
      SELECT * FROM research_privacy_requests WHERE idempotency_key = ?
    `).get(idempotencyKey) as Record<string, unknown> | undefined;
    if (request !== undefined) addTargetOnly("research_privacy_requests", request);
    const eventBindings = connection.prepare(`
      SELECT * FROM research_privacy_event_bindings
      WHERE idempotency_key = ? ORDER BY event_key
    `).all(idempotencyKey) as Array<Record<string, unknown>>;
    for (const binding of eventBindings) {
      addTargetOnly("research_privacy_event_bindings", binding);
    }
    const receipt = connection.prepare(`
      SELECT * FROM research_redaction_receipts WHERE idempotency_key = ?
    `).get(idempotencyKey) as Record<string, unknown> | undefined;
    if (receipt !== undefined) addTargetOnly("research_redaction_receipts", receipt);
  }

  return Object.freeze([...result.values()].sort((left, right) =>
    right.deleteRank - left.deleteRank ||
    left.tableName.localeCompare(right.tableName, "en") ||
    (left.tableName === "live_acquisition_actions" &&
        right.tableName === "live_acquisition_actions"
      ? (right.liveActionDepth ?? -1) - (left.liveActionDepth ?? -1)
      : 0) ||
    left.pkV1.localeCompare(right.pkV1, "en")
  ));
}

function rootOwner(tableName: string, rowRef: string): string {
  if (tableName === "logical_pages") return rootOwnerPredicate(tableName, rowRef);
  if (tableName === "resources") {
    return `EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
      WHERE intent.status IN ${activeStatuses}
        AND intent.target_kind = 'resource_history'
        AND intent.resource_id_snapshot = ${rowRef}.id)`;
  }
  if (tableName === "research_history_epochs") {
    return `EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
      WHERE intent.status IN ${activeStatuses}
        AND intent.target_kind = 'resource_history'
        AND (intent.history_epoch_id = ${rowRef}.id
          OR intent.resource_id_snapshot = ${rowRef}.resource_id))`;
  }
  return `EXISTS (SELECT 1 FROM privacy_purge_intents AS intent
    LEFT JOIN privacy_purge_intent_run_targets AS owned_run
      ON owned_run.intent_key = intent.intent_key
    WHERE intent.status IN ${activeStatuses} AND (
      intent.subject_generation_id = ${rowRef}.id
      OR owned_run.subject_generation_id = ${rowRef}.id
      OR (intent.target_kind = 'logical_page'
        AND intent.logical_page_id_snapshot = ${rowRef}.logical_page_id)
    ))`;
}

function rootPk(tableName: string, rowRef: string): string {
  return `'pk:v1|1|' || 'i:' || length(CAST(${rowRef}.id AS TEXT)) || ':'
    || CAST(${rowRef}.id AS TEXT)`;
}

export function buildPrivacyPurgeRootGuards(): readonly string[] {
  const result: string[] = [];
  for (const tableName of [
    "privacy_subject_generations",
    "research_history_epochs",
    "logical_pages",
    "resources",
  ]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const owner = operation === "INSERT"
        ? rootOwner(tableName, "NEW")
        : operation === "DELETE"
        ? rootOwner(tableName, "OLD")
        : `(${rootOwner(tableName, "OLD")} OR ${rootOwner(tableName, "NEW")})`;
      const ref = operation === "INSERT" ? "NEW" : "OLD";
      const pk = rootPk(tableName, ref);
      result.push(`CREATE TRIGGER ${quoteIdentifier(
        `privacy_purge26_root_${tableName}_${operation.toLowerCase()}_guard`,
      )}
BEFORE ${operation} ON ${quoteIdentifier(tableName)}
WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
  OR (SELECT recursive_triggers FROM pragma_recursive_triggers) <> 1
  OR ((${owner}) AND NOT EXISTS (
    SELECT 1 FROM privacy_purge_intents AS intent
    WHERE intent.status = 'committed' AND intent.purge_command_id IS NOT NULL
      AND tabhub_purge_finalization_active_v1(intent.purge_command_id) = 1
      AND tabhub_purge26_executor_v1(
        intent.intent_key, intent.purge_command_id, '${tableName}', ${pk},
        '${operation}'
      ) = 1
  ))
BEGIN
  SELECT RAISE(ABORT, 'schema26 privacy purge root fence');
END;`);
    }
  }
  return result;
}

export function buildPrivacyPurgeExpectedViews(
  connection: Database.Database,
): readonly string[] {
  const catalog = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all() as TargetCatalogRow[];
  if (catalog.length !== PRIVACY_PURGE_TARGET_TABLE_COUNT) {
    throw new Error("Privacy purge target catalog is incomplete");
  }
  const allTables = connection.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `).pluck().all() as string[];
  const relations = relationsFor(connection, allTables);
  const targetSelects = catalog.map((target) => {
    const pk = target.pk_expression_sql.replaceAll("OLD.", "candidate.");
    const depth = target.table_name === "live_acquisition_actions"
      ? "candidate.depth"
      : "NULL";
    return `SELECT intent.intent_key, '${target.table_name}' AS table_name,
      (${pk}) AS pk_v1, ${target.delete_rank} AS delete_rank,
      ${depth} AS live_action_depth
    FROM ${quoteIdentifier(target.table_name)} AS candidate
    JOIN privacy_purge_intents AS intent ON intent.status = 'waiting'
    WHERE ${ownershipPredicate(target.table_name, "candidate", relations)}`;
  });
  const executionView = `CREATE VIEW privacy_purge26_expected_execution_targets AS
WITH unordered AS (
  ${targetSelects.join("\n  UNION ALL\n  ")}
), ranked AS (
  SELECT intent_key,
    ROW_NUMBER() OVER (
      PARTITION BY intent_key
      ORDER BY delete_rank DESC,
        table_name COLLATE BINARY,
        CASE WHEN table_name = 'live_acquisition_actions'
          THEN COALESCE(live_action_depth, -1) ELSE -1 END DESC,
        pk_v1 COLLATE BINARY
    ) - 1 AS ordinal,
    table_name, pk_v1, delete_rank, live_action_depth
  FROM unordered
)
SELECT intent_key, ordinal, table_name, pk_v1, delete_rank, live_action_depth,
  tabhub_sha256_v1(json_object(
    'intentKey', intent_key, 'ordinal', ordinal,
    'tableName', table_name, 'pkV1', pk_v1,
    'deleteRank', delete_rank, 'liveActionDepth', live_action_depth
  )) AS row_digest
FROM ranked;`;

  const runView = `CREATE VIEW privacy_purge26_expected_run_targets AS
WITH run_members AS (
  SELECT intent.intent_key, generation.id AS subject_generation_id,
    generation.generation_token, run.id AS research_run_id,
    run.job_id AS ai_job_id, 1 AS is_root,
    NULL AS handoff_id, NULL AS handoff_status,
    NULL AS handoff_receipt_digest, NULL AS handoff_receipt_completed_at
  FROM privacy_purge_intents AS intent
  JOIN privacy_subject_generations AS generation
    ON generation.id = intent.subject_generation_id
    AND generation.subject_kind = 'research_run' AND generation.is_active = 1
  JOIN research_runs AS run ON run.id = generation.research_run_id
  WHERE intent.status = 'waiting' AND intent.target_kind = 'run'
  UNION ALL
  SELECT intent.intent_key, successor.id, successor.generation_token,
    final_run.id, final_run.job_id, 0, handoff.id, handoff.status,
    CASE WHEN handoff.status = 'assembling' THEN tabhub_sha256_v1(
      'tabhub:privacy-purge:handoff-receipt:v1' || char(0)
        || intent.intent_key || char(0) || CAST(handoff.id AS TEXT)
    ) ELSE receipt.receipt_digest END,
    CASE WHEN handoff.status = 'assembling' THEN intent.created_at
      ELSE receipt.completed_at END
  FROM privacy_purge_intents AS intent
  JOIN live_acquisition_handoffs AS handoff
    ON handoff.coordinator_run_generation_id = intent.subject_generation_id
    AND handoff.status IN ('assembling', 'completed')
  JOIN research_runs AS final_run ON final_run.id = handoff.final_run_id
  JOIN privacy_subject_generations AS successor
    ON successor.subject_kind = 'research_run'
    AND successor.research_run_id = final_run.id AND successor.is_active = 1
  LEFT JOIN live_acquisition_handoff_receipts AS receipt
    ON receipt.handoff_id = handoff.id
  WHERE intent.status = 'waiting' AND intent.target_kind = 'run'
    AND ((handoff.status = 'assembling' AND ${handoffReceiptCompletable("handoff")})
      OR (handoff.status = 'completed' AND receipt.handoff_id = handoff.id
        AND handoff.completed_at = receipt.completed_at))
  UNION ALL
  SELECT intent.intent_key, generation.id, generation.generation_token,
    run.id, run.job_id, 0, NULL, NULL, NULL, NULL
  FROM privacy_purge_intents AS intent
  JOIN research_runs AS run ON run.history_epoch_id = intent.history_epoch_id
  JOIN privacy_subject_generations AS generation
    ON generation.subject_kind = 'research_run'
    AND generation.research_run_id = run.id AND generation.is_active = 1
  WHERE intent.status = 'waiting' AND intent.target_kind = 'resource_history'
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY intent_key ORDER BY subject_generation_id
  ) - 1 AS ordinal
  FROM run_members
)
SELECT intent_key, ordinal, subject_generation_id, generation_token,
  research_run_id, ai_job_id, is_root, handoff_id, handoff_status,
  handoff_receipt_digest, handoff_receipt_completed_at,
  tabhub_sha256_v1(json_object(
    'intentKey', intent_key, 'ordinal', ordinal,
    'subjectGenerationId', subject_generation_id,
    'generationToken', generation_token, 'researchRunId', research_run_id,
    'aiJobId', ai_job_id, 'isRoot', is_root,
    'handoffId', handoff_id, 'handoffStatus', handoff_status,
    'handoffReceiptDigest', handoff_receipt_digest,
    'handoffReceiptCompletedAt', handoff_receipt_completed_at
  )) AS row_digest
FROM ranked;`;

  const actionOwner = ownershipPredicate(
    "live_acquisition_actions",
    "action",
    relations,
  );
  const actionView = `CREATE VIEW privacy_purge26_expected_action_waits AS
WITH ranked AS (
  SELECT intent.intent_key,
    ROW_NUMBER() OVER (PARTITION BY intent.intent_key ORDER BY action.id) - 1
      AS ordinal,
    action.id AS action_id, action.consent_id, action.action_kind,
    action.state, action.sequence_no, action.runtime_epoch,
    action.action_key_digest, consent.expires_at AS deadline_at
  FROM live_acquisition_actions AS action
  JOIN live_acquisition_consents AS consent ON consent.id = action.consent_id
  JOIN privacy_purge_intents AS intent ON intent.status = 'waiting'
  WHERE action.state NOT IN ('completed', 'blocked', 'ambiguous')
    AND ${actionOwner}
)
SELECT *, tabhub_sha256_v1(json_object(
  'intentKey', intent_key, 'ordinal', ordinal,
  'actionId', action_id, 'consentId', consent_id,
  'actionKind', action_kind, 'state', state, 'sequenceNo', sequence_no,
  'runtimeEpoch', runtime_epoch, 'actionKeyDigest', action_key_digest,
  'deadlineAt', deadline_at
)) AS row_digest
FROM ranked;`;

  const jobOwner = ownershipPredicate("ai_jobs", "job", relations);
  const jobView = `CREATE VIEW privacy_purge26_expected_job_waits AS
WITH job_members AS (
  SELECT intent.intent_key, job.id AS job_id, job.status, job.event_sequence,
    attempt.id AS attempt_id, attempt.attempt_no, attempt.worker_id,
    CASE WHEN job.lease_token IS NULL THEN NULL
      ELSE tabhub_sha256_v1(job.lease_token) END AS lease_token_digest,
    job.lease_expires_at,
    CASE WHEN attempt.request_bound_at IS NULL THEN 0 ELSE 1 END AS request_bound,
    CASE WHEN attempt.request_id IS NULL THEN NULL
      ELSE tabhub_sha256_v1(attempt.request_id) END AS request_id_digest,
    attempt.request_bound_at, attempt.provider, attempt.model,
    attempt.prompt_version, attempt.pricing_version,
    adoption.utc_date AS provider_adoption_utc_date,
    adoption.adopted_at AS provider_adopted_at,
    reservation.id AS provider_reservation_id,
    reservation.utc_date AS provider_reservation_utc_date,
    reservation.reserved_usd AS provider_reserved_usd,
    reservation.consumed_usd AS provider_consumed_usd,
    reservation.status AS provider_reservation_status,
    CASE WHEN attempt.request_bound_at IS NULL THEN NULL
      WHEN job.lease_expires_at > strftime(
        '%Y-%m-%dT%H:%M:%fZ', attempt.request_bound_at, '+31 minutes'
      ) THEN job.lease_expires_at
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ',
        attempt.request_bound_at, '+31 minutes') END AS settlement_deadline_at,
    CASE WHEN attempt.request_bound_at IS NOT NULL THEN 'pending'
      WHEN reservation.id IS NULL THEN 'none' ELSE 'known' END
      AS provider_usage_state
  FROM ai_jobs AS job
  LEFT JOIN ai_job_attempts AS attempt
    ON attempt.job_id = job.id AND attempt.outcome = 'running'
  LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
    ON adoption.attempt_id = attempt.id AND adoption.final_job_id = job.id
  LEFT JOIN live_acquisition_provider_reservations AS reservation
    ON reservation.final_job_id = job.id
  JOIN privacy_purge_intents AS intent ON intent.status = 'waiting'
  WHERE job.status IN ('queued', 'running') AND ${jobOwner}
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY intent_key ORDER BY job_id
  ) - 1 AS ordinal FROM job_members
)
SELECT intent_key, ordinal, job_id, status, event_sequence,
  attempt_id, attempt_no, worker_id, lease_token_digest, lease_expires_at,
  request_bound, request_id_digest, request_bound_at, provider, model,
  prompt_version, pricing_version, provider_adoption_utc_date,
  provider_adopted_at, provider_reservation_id,
  provider_reservation_utc_date, provider_reserved_usd, provider_consumed_usd,
  provider_reservation_status, settlement_deadline_at, provider_usage_state,
  tabhub_sha256_v1(json_object(
    'intentKey', intent_key, 'ordinal', ordinal, 'jobId', job_id,
    'status', status, 'eventSequence', event_sequence,
    'attemptId', attempt_id, 'attemptNo', attempt_no, 'workerId', worker_id,
    'leaseTokenDigest', lease_token_digest, 'leaseExpiresAt', lease_expires_at,
    'requestBound', request_bound, 'requestIdDigest', request_id_digest,
    'requestBoundAt', request_bound_at, 'provider', provider, 'model', model,
    'promptVersion', prompt_version, 'pricingVersion', pricing_version,
    'providerAdoptionUtcDate', provider_adoption_utc_date,
    'providerAdoptedAt', provider_adopted_at,
    'providerReservationId', provider_reservation_id,
    'providerReservationUtcDate', provider_reservation_utc_date,
    'providerReservedUsd', provider_reserved_usd,
    'providerConsumedUsd', provider_consumed_usd,
    'providerReservationStatus', provider_reservation_status,
    'settlementDeadlineAt', settlement_deadline_at,
    'providerUsageState', provider_usage_state
  )) AS row_digest
FROM ranked;`;
  const commandPreflightView = `CREATE VIEW privacy_purge26_command_preflight AS
SELECT intent.intent_key
FROM privacy_purge_intents AS intent
WHERE intent.status = 'waiting' AND intent.target_kind <> 'run'
UNION ALL
SELECT intent.intent_key
FROM privacy_purge_intents AS intent
JOIN privacy_subject_generations AS root
  ON root.id = intent.subject_generation_id
JOIN research_runs AS coordinator_run ON coordinator_run.id = root.research_run_id
JOIN research_run_heads AS coordinator_head
  ON coordinator_head.run_id = coordinator_run.id
JOIN ai_jobs AS coordinator_job ON coordinator_job.id = coordinator_run.job_id
WHERE intent.status = 'waiting' AND intent.target_kind = 'run'
  AND root.subject_kind = 'research_run' AND root.is_active = 1
  AND NOT EXISTS (
    SELECT 1 FROM live_acquisition_handoffs AS incoming_root
    WHERE incoming_root.final_run_id = root.research_run_id
  )
  AND (SELECT COUNT(*) FROM live_acquisition_handoffs AS edge
    WHERE edge.coordinator_run_generation_id = root.id) BETWEEN 0 AND 1
  AND (
    NOT EXISTS (SELECT 1 FROM live_acquisition_handoffs AS edge
      WHERE edge.coordinator_run_generation_id = root.id)
    OR EXISTS (
      SELECT 1
      FROM live_acquisition_handoffs AS edge
      JOIN privacy_subject_generations AS final_generation
        ON final_generation.subject_kind = 'research_run'
        AND final_generation.research_run_id = edge.final_run_id
        AND final_generation.is_active = 1
      JOIN research_runs AS final_run ON final_run.id = edge.final_run_id
      JOIN ai_jobs AS final_job ON final_job.id = final_run.job_id
      JOIN live_acquisition_handoff_receipts AS receipt
        ON receipt.handoff_id = edge.id
      WHERE edge.coordinator_run_generation_id = root.id
        AND edge.status = 'completed' AND edge.completed_at = receipt.completed_at
        AND coordinator_job.kind = 'resource_research'
        AND coordinator_job.workflow_id = 'research_acquisition:c90:v1'
        AND coordinator_job.workflow_version = 1
        AND coordinator_job.status = 'superseded'
        AND coordinator_head.status = 'superseded'
        AND coordinator_run.workflow_id = 'research_acquisition:c90:v1'
        AND coordinator_run.workflow_version = 1
        AND final_job.kind = 'resource_research'
        AND final_job.workflow_id = 'research_workflow:c81:v1'
        AND final_job.workflow_version = 1
        AND final_run.workflow_id = 'research_workflow:c81:v1'
        AND final_run.workflow_version = 1
        AND coordinator_job.resource_id IS NOT NULL
        AND coordinator_run.target_resource_id = coordinator_job.resource_id
        AND coordinator_run.target_key = coordinator_job.subject_key
        AND final_job.resource_id = coordinator_job.resource_id
        AND final_run.target_resource_id = coordinator_run.target_resource_id
        AND final_run.target_key = coordinator_run.target_key
        AND final_job.subject_key = coordinator_job.subject_key
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM live_acquisition_handoffs AS edge
    LEFT JOIN privacy_subject_generations AS descendant
      ON descendant.subject_kind = 'research_run'
      AND descendant.research_run_id = edge.final_run_id
      AND descendant.is_active = 1
    WHERE edge.coordinator_run_generation_id = root.id AND (
      descendant.id IS NULL OR descendant.id = root.id
      OR (SELECT COUNT(*) FROM live_acquisition_handoffs AS incoming
        WHERE incoming.final_run_id = edge.final_run_id) <> 1
      OR EXISTS (
        SELECT 1 FROM live_acquisition_handoffs AS extension
        JOIN privacy_subject_generations AS extension_generation
          ON extension_generation.id = extension.coordinator_run_generation_id
        WHERE extension_generation.subject_kind = 'research_run'
          AND extension_generation.research_run_id = edge.final_run_id
      )
    )
  );`;
  return [executionView, runView, actionView, jobView, commandPreflightView];
}

export function privacyPurgeFenceFingerprint(
  fences: readonly PrivacyPurgeMutationFence[],
): string {
  return sha256(JSON.stringify(fences.map((fence) => ({
    tableName: fence.tableName,
    operation: fence.operation,
    triggerName: fence.triggerName,
    triggerSqlDigest: fence.triggerSqlDigest,
  }))));
}
