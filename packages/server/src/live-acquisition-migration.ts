import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import { sqlJsonObjectMirrorV1 as sqlJsonMirror } from "@tabhub/shared";

export type LiveAcquisitionMigrationFailurePoint =
  | "after_begin"
  | "after_sql"
  | "before_commit";

export type LiveAcquisitionMigrationValidationProbe =
  | "delete_captured_source"
  | "post_delete_guard"
  | "source_column"
  | "manifest_pk"
  | "external_trigger_semantic_replacement"
  | "manifest_self_consistent_replacement"
  | "c90_table_column"
  | "modified_existing_trigger_drop"
  | "existing_view_drop"
  | "new_external_dependency_drop";

export interface LiveAcquisitionMigrationOptions {
  readonly failurePoint?: LiveAcquisitionMigrationFailurePoint;
  /** Closed, test-only fault injection used to exercise post-DDL validators. */
  readonly testOnlyValidationProbe?: LiveAcquisitionMigrationValidationProbe;
}

const approvedMigration025Sha256 =
  "68c09c694ddd7b38df0e3956155cb6c472507a53154fe7a6f5f54c67ce011811";

export interface PrivacyPurgeExecutionTarget {
  readonly tableName: string;
  readonly pkV1: string;
}

export interface PrivacyPurgeLifecycleTarget {
  readonly subjectGenerationId: number;
  readonly generationToken: string;
  readonly researchRunId: number;
}

interface PrivacyPurgeExecutionBase {
  readonly version: "privacy_purge_execution:v1";
  readonly commandId: number;
  readonly safeCounts: Readonly<Record<string, number>>;
  readonly resultDigest: string;
  readonly completedAt: string;
}

export interface CompletedPrivacyPurgeExecutionPlan
  extends PrivacyPurgeExecutionBase {
  readonly outcome: "completed";
  readonly orderedTargets: readonly PrivacyPurgeExecutionTarget[];
  readonly tombstoneDigest: string;
}

export interface FailedPrivacyPurgeExecutionPlan
  extends PrivacyPurgeExecutionBase {
  readonly outcome: "failed";
}

export type PrivacyPurgeExecutionPlan =
  | CompletedPrivacyPurgeExecutionPlan
  | FailedPrivacyPurgeExecutionPlan;

export type PrivacyPurgeExecutionFailurePoint =
  | "after_tombstone"
  | "after_first_retirement"
  | "mid_delete"
  | "before_result_status"
  | "result_before_authorities"
  | "missing_last_authority"
  | "recreate_first_target";

export interface PrivacyPurgeExecutionOptions {
  /** Closed fault injection for migration-runner tests only. */
  readonly testOnlyFailurePoint?: PrivacyPurgeExecutionFailurePoint;
}

export type PrivacyPurgePrimaryKeyPart =
  | { readonly type: "integer"; readonly value: number | bigint }
  | { readonly type: "text"; readonly value: string };

export function encodePrivacyPurgePrimaryKeyV1(
  parts: readonly PrivacyPurgePrimaryKeyPart[],
): string {
  if (parts.length === 0) {
    throw new Error("pk:v1 requires at least one primary-key part");
  }
  let encoded = `pk:v1|${parts.length}|`;
  for (const part of parts) {
    if (part.type === "integer") {
      if (
        typeof part.value === "number" &&
        (!Number.isSafeInteger(part.value) || !Number.isFinite(part.value))
      ) {
        throw new Error("pk:v1 integer must be a safe canonical integer");
      }
      const value = part.value.toString(10);
      encoded += `i:${Buffer.byteLength(value, "utf8")}:${value}`;
    } else {
      encoded += `s:${Buffer.byteLength(part.value, "utf8")}:${part.value}`;
    }
  }
  return encoded;
}

const privacyPurgeSafeCountKeys = new Set([
  "cancelled_jobs",
  "deleted_rows",
  "detached_rows",
  "redacted_rows",
  "removed_activity_records",
  "removed_context_entries",
  "removed_payloads",
  "removed_priority_records",
  "removed_relations",
  "removed_reports",
  "removed_sources",
  "retired_generations",
]);
const privacyPurgeTargetLimit = 250_000;
const privacyPurgeFailurePoints = new Set<PrivacyPurgeExecutionFailurePoint>([
  "after_tombstone",
  "after_first_retirement",
  "mid_delete",
  "before_result_status",
  "missing_last_authority",
  "recreate_first_target",
  "result_before_authorities",
]);

function ownDataRecord(
  value: unknown,
  label: string,
): ReadonlyMap<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol keys`);
    }
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function requireExactDataKeys(
  record: ReadonlyMap<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = [...record.keys()].sort();
  const sortedExpected = [...expected].sort();
  if (sqlJsonMirror(actual) !== sqlJsonMirror(sortedExpected)) {
    throw new TypeError(`${label} has an invalid data shape`);
  }
}

function snapshotDataArray(value: unknown, label: string): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain data array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > privacyPurgeTargetLimit
  ) {
    throw new TypeError(`${label} has an invalid length`);
  }
  const length = Number(lengthDescriptor.value);
  const expectedKeys = new Set(["length"]);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} must be dense and data-only`);
    }
    result.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      throw new TypeError(`${label} cannot contain extra properties`);
    }
  }
  return result;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new TypeError(`${label} must be a canonical timestamp`);
    }
  } catch {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

function snapshotPrivacyPurgeTargets(
  value: unknown,
): readonly PrivacyPurgeExecutionTarget[] {
  const rawTargets = snapshotDataArray(value, "privacy purge orderedTargets");
  const seen = new Set<string>();
  return Object.freeze(rawTargets.map((rawTarget, index) => {
    const record = ownDataRecord(rawTarget, `privacy purge target ${index}`);
    requireExactDataKeys(record, ["pkV1", "tableName"], `privacy purge target ${index}`);
    const tableName = record.get("tableName");
    const pkV1 = record.get("pkV1");
    if (
      typeof tableName !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tableName)
    ) {
      throw new TypeError(`privacy purge target ${index} has an invalid tableName`);
    }
    if (typeof pkV1 !== "string" || !isCanonicalPrivacyPurgePrimaryKeyV1(pkV1)) {
      throw new TypeError(`privacy purge target ${index} has a noncanonical pkV1`);
    }
    const key = `${tableName}\u0000${pkV1}`;
    if (seen.has(key)) {
      throw new TypeError(`privacy purge target ${index} is duplicated`);
    }
    seen.add(key);
    return Object.freeze({ tableName, pkV1 });
  }));
}

export function digestPrivacyPurgeExecutionTargets(
  orderedTargets: readonly PrivacyPurgeExecutionTarget[],
): string {
  const targets = snapshotPrivacyPurgeTargets(orderedTargets);
  return sha256(sqlJsonMirror(targets));
}

function snapshotPrivacyPurgeLifecycleTargets(
  value: unknown,
): readonly PrivacyPurgeLifecycleTarget[] {
  const rawTargets = snapshotDataArray(value, "privacy purge lifecycle targets");
  const seenGenerations = new Set<number>();
  const seenRuns = new Set<number>();
  let priorGenerationId = 0;
  return Object.freeze(rawTargets.map((rawTarget, index) => {
    const record = ownDataRecord(rawTarget, `privacy purge lifecycle target ${index}`);
    requireExactDataKeys(
      record,
      ["generationToken", "researchRunId", "subjectGenerationId"],
      `privacy purge lifecycle target ${index}`,
    );
    const subjectGenerationId = record.get("subjectGenerationId");
    const generationToken = record.get("generationToken");
    const researchRunId = record.get("researchRunId");
    if (
      typeof subjectGenerationId !== "number" ||
      !Number.isSafeInteger(subjectGenerationId) || subjectGenerationId <= 0 ||
      typeof researchRunId !== "number" || !Number.isSafeInteger(researchRunId) ||
      researchRunId <= 0 || typeof generationToken !== "string" ||
      !/^[0-9a-f]{64}$/.test(generationToken)
    ) {
      throw new TypeError(`privacy purge lifecycle target ${index} is invalid`);
    }
    if (
      subjectGenerationId <= priorGenerationId ||
      seenGenerations.has(subjectGenerationId) || seenRuns.has(researchRunId)
    ) {
      throw new TypeError("privacy purge lifecycle targets are not a unique canonical set");
    }
    priorGenerationId = subjectGenerationId;
    seenGenerations.add(subjectGenerationId);
    seenRuns.add(researchRunId);
    return Object.freeze({ subjectGenerationId, generationToken, researchRunId });
  }));
}

export function digestPrivacyPurgeLifecycleTargets(
  orderedTargets: readonly PrivacyPurgeLifecycleTarget[],
): string {
  return sha256(sqlJsonMirror(snapshotPrivacyPurgeLifecycleTargets(orderedTargets)));
}

function snapshotSafeCounts(value: unknown): Readonly<Record<string, number>> {
  const record = ownDataRecord(value, "privacy purge safeCounts");
  const result: Record<string, number> = {};
  for (const key of [...record.keys()].sort()) {
    const count = record.get(key);
    if (
      !privacyPurgeSafeCountKeys.has(key) || typeof count !== "number" ||
      !Number.isSafeInteger(count) || count < 0
    ) {
      throw new TypeError(`privacy purge safeCounts.${key} is invalid`);
    }
    result[key] = count;
  }
  return Object.freeze(result);
}

function snapshotPrivacyPurgeExecutionPlan(
  value: unknown,
): PrivacyPurgeExecutionPlan {
  const record = ownDataRecord(value, "privacy purge plan");
  const outcome = record.get("outcome");
  const commonKeys = [
    "commandId",
    "completedAt",
    "outcome",
    "resultDigest",
    "safeCounts",
    "version",
  ] as const;
  if (outcome === "completed") {
    requireExactDataKeys(
      record,
      [...commonKeys, "orderedTargets", "tombstoneDigest"],
      "privacy purge completed plan",
    );
  } else if (outcome === "failed") {
    requireExactDataKeys(record, commonKeys, "privacy purge failed plan");
  } else {
    throw new TypeError("privacy purge plan outcome is invalid");
  }
  if (record.get("version") !== "privacy_purge_execution:v1") {
    throw new TypeError("privacy purge plan version is invalid");
  }
  const commandId = record.get("commandId");
  if (typeof commandId !== "number" || !Number.isSafeInteger(commandId) || commandId <= 0) {
    throw new TypeError("privacy purge plan commandId is invalid");
  }
  const common = {
    version: "privacy_purge_execution:v1" as const,
    commandId,
    safeCounts: snapshotSafeCounts(record.get("safeCounts")),
    resultDigest: requireDigest(record.get("resultDigest"), "privacy purge resultDigest"),
    completedAt: requireCanonicalTimestamp(record.get("completedAt"), "privacy purge completedAt"),
  };
  if (outcome === "failed") {
    return Object.freeze({ ...common, outcome: "failed" as const });
  }
  return Object.freeze({
    ...common,
    outcome: "completed" as const,
    orderedTargets: snapshotPrivacyPurgeTargets(record.get("orderedTargets")),
    tombstoneDigest: requireDigest(
      record.get("tombstoneDigest"),
      "privacy purge tombstoneDigest",
    ),
  });
}

function snapshotPrivacyPurgeExecutionOptions(
  value: unknown,
): PrivacyPurgeExecutionOptions {
  const record = ownDataRecord(value, "privacy purge options");
  const keys = [...record.keys()];
  if (keys.length === 0) return Object.freeze({});
  requireExactDataKeys(record, ["testOnlyFailurePoint"], "privacy purge options");
  const point = record.get("testOnlyFailurePoint");
  if (typeof point !== "string" ||
    !privacyPurgeFailurePoints.has(point as PrivacyPurgeExecutionFailurePoint)) {
    throw new TypeError("privacy purge failure point is invalid");
  }
  return Object.freeze({
    testOnlyFailurePoint: point as PrivacyPurgeExecutionFailurePoint,
  });
}

const purgeAuthorities = new WeakMap<Database.Database, ReadonlySet<string>>();
const purgeAuthorityUses = new WeakMap<Database.Database, ReadonlySet<string>>();
const purgeFenceInstallers = new WeakMap<
  Database.Database,
  ReadonlySet<string>
>();
const purgeFenceRemovers = new WeakMap<
  Database.Database,
  ReadonlySet<string>
>();
const purgeAuthorityRemovers = new WeakMap<
  Database.Database,
  ReadonlySet<string>
>();
const purgeAuthorityConsumers = new WeakMap<
  Database.Database,
  ReadonlySet<string>
>();
const purgeFinalizations = new WeakMap<
  Database.Database,
  ReadonlyMap<number, string>
>();

function isCanonicalPrivacyPurgePrimaryKeyV1(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("pk:v1|")) {
    return false;
  }
  const encoded = Buffer.from(value, "utf8");
  let offset = Buffer.byteLength("pk:v1|", "utf8");
  const readAsciiUntil = (delimiter: number): string | undefined => {
    const end = encoded.indexOf(delimiter, offset);
    if (end < 0) return undefined;
    const token = encoded.subarray(offset, end).toString("ascii");
    offset = end + 1;
    return token;
  };
  const countToken = readAsciiUntil(0x7c);
  if (countToken === undefined || !/^[1-9][0-9]*$/.test(countToken)) {
    return false;
  }
  const count = Number(countToken);
  if (!Number.isSafeInteger(count) || count > 32) return false;
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > encoded.length) return false;
    const kind = encoded[offset];
    if ((kind !== 0x69 && kind !== 0x73) || encoded[offset + 1] !== 0x3a) {
      return false;
    }
    offset += 2;
    const lengthToken = readAsciiUntil(0x3a);
    if (
      lengthToken === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(lengthToken)
    ) {
      return false;
    }
    const byteLength = Number(lengthToken);
    if (!Number.isSafeInteger(byteLength) || byteLength > 2048) return false;
    const end = offset + byteLength;
    if (end > encoded.length) return false;
    const part = encoded.subarray(offset, end).toString("utf8");
    if (Buffer.byteLength(part, "utf8") !== byteLength) return false;
    if (kind === 0x69 && !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(part)) {
      return false;
    }
    offset = end;
  }
  return offset === encoded.length;
}

function isCanonicalHttpsOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" &&
      parsed.password === "" && parsed.pathname === "/" &&
      parsed.search === "" && parsed.hash === "" && parsed.origin === value;
  } catch {
    return false;
  }
}

function purgeAuthorityKey(
  tableName: string,
  pkV1: string,
  nonceDigest: string,
): string {
  return `${tableName}\u0000${pkV1}\u0000${nonceDigest}`;
}

function purgeAuthorityRemovalKey(
  commandId: number,
  tableName: string,
  pkV1: string,
  nonceDigest: string,
): string {
  return `${commandId}\u0000${purgeAuthorityKey(tableName, pkV1, nonceDigest)}`;
}

export function installPrivacyPurgeAuthorization(
  connection: Database.Database,
): void {
  purgeAuthorities.set(connection, new Set());
  purgeAuthorityUses.set(connection, new Set());
  purgeFenceInstallers.set(connection, new Set());
  purgeFenceRemovers.set(connection, new Set());
  purgeAuthorityRemovers.set(connection, new Set());
  purgeAuthorityConsumers.set(connection, new Set());
  purgeFinalizations.set(connection, new Map());
  connection.function(
    "tabhub_purge_finalization_active_v1",
    (commandId: unknown) =>
      typeof commandId === "number" && Number.isSafeInteger(commandId) &&
      connection.inTransaction && purgeFinalizations.get(connection)?.has(commandId)
        ? 1
        : 0,
  );
  connection.function(
    "tabhub_purge_finalization_nonce_v1",
    (commandId: unknown) =>
      typeof commandId === "number" && Number.isSafeInteger(commandId) &&
      connection.inTransaction
        ? purgeFinalizations.get(connection)?.get(commandId) ?? null
        : null,
  );
  connection.function(
    "tabhub_pk_v1_canonical",
    { deterministic: true },
    (value: unknown) => isCanonicalPrivacyPurgePrimaryKeyV1(value) ? 1 : 0,
  );
  connection.function(
    "tabhub_https_origin_canonical_v1",
    { deterministic: true },
    (value: unknown) => isCanonicalHttpsOrigin(value) ? 1 : 0,
  );
  connection.function(
    "tabhub_sha256_v1",
    { deterministic: true },
    (value: unknown) => typeof value === "string" ? sha256(value) : null,
  );
  connection.function(
    "tabhub_purge_authorized_v1",
    (tableName: unknown, pkV1: unknown, nonceDigest: unknown) => {
      if (
        typeof tableName !== "string" ||
        typeof pkV1 !== "string" ||
        typeof nonceDigest !== "string" ||
        !connection.inTransaction
      ) {
        return 0;
      }
      const key = purgeAuthorityKey(tableName, pkV1, nonceDigest);
      const available = purgeAuthorities.get(connection);
      if (!available?.has(key)) return 0;
      purgeAuthorities.set(
        connection,
        new Set([...available].filter((candidate) => candidate !== key)),
      );
      purgeAuthorityUses.set(
        connection,
        new Set([...(purgeAuthorityUses.get(connection) ?? []), key]),
      );
      return 1;
    },
  );
  connection.function(
    "tabhub_purge_fence_install_v1",
    (nonceDigest: unknown) =>
      typeof nonceDigest === "string" &&
      purgeFenceInstallers.get(connection)?.has(nonceDigest)
        ? 1
        : 0,
  );
  connection.function(
    "tabhub_purge_fence_remove_v1",
    (nonceDigest: unknown) =>
      typeof nonceDigest === "string" &&
      connection.inTransaction &&
      purgeFenceRemovers.get(connection)?.has(nonceDigest)
        ? 1
        : 0,
  );
  connection.function(
    "tabhub_purge_authority_consume_v1",
    (
      commandId: unknown,
      tableName: unknown,
      pkV1: unknown,
      nonceDigest: unknown,
    ) => {
      if (
        typeof commandId !== "number" || !Number.isSafeInteger(commandId) ||
        typeof tableName !== "string" || typeof pkV1 !== "string" ||
        typeof nonceDigest !== "string" || !connection.inTransaction
      ) {
        return 0;
      }
      const key = purgeAuthorityRemovalKey(
        commandId,
        tableName,
        pkV1,
        nonceDigest,
      );
      const available = purgeAuthorityConsumers.get(connection);
      if (!available?.has(key)) return 0;
      purgeAuthorityConsumers.set(
        connection,
        new Set([...available].filter((candidate) => candidate !== key)),
      );
      return 1;
    },
  );
  connection.function(
    "tabhub_purge_authority_remove_v1",
    (
      commandId: unknown,
      tableName: unknown,
      pkV1: unknown,
      nonceDigest: unknown,
    ) =>
      typeof commandId === "number" && Number.isSafeInteger(commandId) &&
      typeof tableName === "string" && typeof pkV1 === "string" &&
      typeof nonceDigest === "string" && connection.inTransaction &&
      purgeAuthorityRemovers.get(connection)?.has(
        purgeAuthorityRemovalKey(commandId, tableName, pkV1, nonceDigest),
      )
        ? 1
        : 0,
  );
}

interface PrivacyPurgeCommandRow {
  readonly target_kind: "logical_page" | "resource_history" | "run";
  readonly subject_generation_id: number | null;
  readonly history_epoch_id: number | null;
  readonly deletion_target_count: number;
  readonly deletion_plan_digest: string;
  readonly lifecycle_target_count: number;
  readonly lifecycle_plan_digest: string;
  readonly created_at: string;
}

interface PrivacyPurgeLifecycleTargetRow {
  readonly subject_generation_id: number;
  readonly generation_token: string;
  readonly research_run_id: number;
  readonly is_root: 0 | 1;
}

interface PreparedPrivacyPurgeTarget extends PrivacyPurgeExecutionTarget {
  readonly hasGuardManifest: boolean;
  readonly requiresAuthority: boolean;
  readonly deleteRank: number;
  readonly exists: Database.Statement;
  readonly evaluateGuardPredicate: Database.Statement | null;
  readonly deleteExact: Database.Statement;
}

interface PrivacyPurgeTargetCatalogRow {
  readonly pk_expression_sql: string;
  readonly delete_rank: number;
  readonly requires_authority: 0 | 1;
  readonly guard_trigger_name: string | null;
  readonly guarded_table_name: string | null;
  readonly guarded_pk_expression_sql: string | null;
  readonly guarded_pk_columns_json: string | null;
  readonly guarded_predicate_sql: string | null;
  readonly pk_columns_json: string;
  readonly manifest_table_count: number;
}

function resetPrivacyPurgeLocalState(connection: Database.Database): void {
  purgeAuthorities.set(connection, new Set());
  purgeAuthorityUses.set(connection, new Set());
  purgeFenceInstallers.set(connection, new Set());
  purgeFenceRemovers.set(connection, new Set());
  purgeAuthorityRemovers.set(connection, new Set());
  purgeAuthorityConsumers.set(connection, new Set());
  purgeFinalizations.set(connection, new Map());
}

function injectPrivacyPurgeExecutionFailure(
  options: PrivacyPurgeExecutionOptions,
  point: PrivacyPurgeExecutionFailurePoint,
): void {
  if (options.testOnlyFailurePoint === point) {
    throw new Error(`Injected privacy purge execution failure at ${point}`);
  }
}

function assertPrivacyPurgeTargetCatalogFrozen(
  connection: Database.Database,
): void {
  const rows = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank,
      requires_authority, guard_trigger_name
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all();
  if (sha256(sqlJsonMirror(rows)) !== schema25PurgeTargetCatalogFingerprint) {
    throw new Error("Privacy purge target catalog fingerprint drifted");
  }
}

function assertPrivacyPurgeDeletionManifestFrozen(
  connection: Database.Database,
): void {
  const rows = connection.prepare(`
    SELECT manifest.trigger_name, manifest.table_name,
      manifest.pk_columns_json, manifest.pk_expression_sql,
      manifest.predicate_sql, manifest.trigger_sql_digest,
      schema.tbl_name, schema.sql
    FROM privacy_purge_deletion_manifest AS manifest
    LEFT JOIN sqlite_schema AS schema
      ON schema.type = 'trigger' AND schema.name = manifest.trigger_name
    ORDER BY manifest.trigger_name
  `).all() as Array<{
    trigger_name: string;
    table_name: string;
    pk_columns_json: string;
    pk_expression_sql: string;
    predicate_sql: string;
    trigger_sql_digest: string;
    tbl_name: string | null;
    sql: string | null;
  }>;
  const fingerprint = sha256(sqlJsonMirror(rows.map(({
    trigger_name,
    table_name,
    pk_columns_json,
    pk_expression_sql,
    predicate_sql,
    trigger_sql_digest,
  }) => ({
    trigger_name,
    table_name,
    pk_columns_json,
    pk_expression_sql,
    predicate_sql,
    trigger_sql_digest,
  }))));
  if (fingerprint !== schema25DeletionManifestFingerprint) {
    throw new Error(`Privacy purge deletion manifest fingerprint drifted: ${fingerprint}`);
  }
  for (const row of rows) {
    if (
      row.tbl_name !== row.table_name || typeof row.sql !== "string" ||
      sha256(row.sql) !== row.trigger_sql_digest
    ) {
      throw new Error(
        `Privacy purge deletion manifest trigger drifted: ${row.trigger_name}`,
      );
    }
  }
}

const emptyLifecyclePlanDigest = "0".repeat(64);

function assertCommittedRunLifecycleTargets(
  connection: Database.Database,
  commandId: number,
  command: PrivacyPurgeCommandRow,
  orderedTargets: readonly PrivacyPurgeExecutionTarget[],
  expectedState: "active" | "retired" = "active",
  requireRunRowEquality = true,
): readonly PrivacyPurgeLifecycleTarget[] {
  if (command.target_kind === "logical_page") {
    if (
      command.lifecycle_target_count !== 0 ||
      command.lifecycle_plan_digest !== emptyLifecyclePlanDigest
    ) {
      throw new Error("Logical-page privacy purge has an unexpected lifecycle commitment");
    }
    return Object.freeze([]);
  }
  const rows = connection.prepare(`
    SELECT subject_generation_id, generation_token, research_run_id, is_root
    FROM privacy_purge_lifecycle_targets
    WHERE purge_command_id = ? ORDER BY subject_generation_id
  `).all(commandId) as PrivacyPurgeLifecycleTargetRow[];
  const targets = snapshotPrivacyPurgeLifecycleTargets(rows.map((row) => ({
    subjectGenerationId: row.subject_generation_id,
    generationToken: row.generation_token,
    researchRunId: row.research_run_id,
  })));
  if (
    (command.target_kind === "run" && (
      command.subject_generation_id === null || rows.length === 0 || rows.length > 2
    )) ||
    (command.target_kind === "resource_history" && command.history_epoch_id === null) ||
    rows.length !== command.lifecycle_target_count ||
    digestPrivacyPurgeLifecycleTargets(targets) !== command.lifecycle_plan_digest ||
    (command.target_kind === "run" && (
      rows.filter((row) => row.is_root === 1).length !== 1 ||
      rows.find((row) => row.is_root === 1)?.subject_generation_id !==
        command.subject_generation_id
    )) ||
    (command.target_kind === "resource_history" &&
      rows.some((row) => row.is_root !== 0))
  ) {
    throw new Error("Privacy purge run lifecycle commitment drifted");
  }
  const expectedStateSql = expectedState === "active"
    ? "generation.is_active = 1 AND generation.research_run_id = target.research_run_id"
    : "generation.is_active = 0 AND generation.research_run_id IS NULL";
  const currentCount = Number(connection.prepare(`
    SELECT COUNT(*)
    FROM privacy_purge_lifecycle_targets AS target
    JOIN privacy_subject_generations AS generation
      ON generation.id = target.subject_generation_id
    WHERE target.purge_command_id = ?
      AND generation.subject_kind = 'research_run'
      AND generation.generation_token = target.generation_token
      AND ${expectedStateSql}
  `).pluck().get(commandId));
  if (currentCount !== targets.length) {
    throw new Error("Privacy purge run lifecycle identity is stale");
  }
  if (
    command.target_kind === "resource_history" &&
    expectedState === "active" &&
    Number(connection.prepare(`
      SELECT COUNT(*)
      FROM privacy_purge_lifecycle_targets AS target
      JOIN research_runs AS run ON run.id = target.research_run_id
      WHERE target.purge_command_id = ? AND run.history_epoch_id = ?
    `).pluck().get(commandId, command.history_epoch_id)) !== targets.length
  ) {
    throw new Error("Privacy purge history lifecycle membership is stale");
  }
  const committedRunRows = orderedTargets
    .filter((target) => target.tableName === "research_runs")
    .map((target) => target.pkV1).sort();
  const lifecycleRunRows = targets.map((target) =>
    encodePrivacyPurgePrimaryKeyV1([
      { type: "integer", value: target.researchRunId },
    ])
  ).sort();
  if (
    requireRunRowEquality &&
    (command.target_kind === "run" || command.target_kind === "resource_history") &&
    sqlJsonMirror(committedRunRows) !== sqlJsonMirror(lifecycleRunRows)
  ) {
    throw new Error(
      "Privacy purge research-run rows do not exactly match the lifecycle commitment",
    );
  }
  return targets;
}

interface PrivacyPurgeTerminalRow extends PrivacyPurgeCommandRow {
  readonly status: "completed" | "failed";
  readonly outcome: "completed" | "failed";
  readonly safe_counts_json: string;
  readonly result_digest: string;
  readonly completed_at: string;
}

function acceptExactPrivacyPurgeReplay(
  connection: Database.Database,
  plan: PrivacyPurgeExecutionPlan,
  orderedTargets: readonly PrivacyPurgeExecutionTarget[],
  planDigest: string,
  safeCountsJson: string,
): boolean {
  const terminal = connection.prepare(`
    SELECT command.target_kind, command.subject_generation_id,
      command.history_epoch_id, command.deletion_target_count,
      command.deletion_plan_digest, command.lifecycle_target_count,
      command.lifecycle_plan_digest, command.created_at, command.status,
      result.outcome, result.safe_counts_json, result.result_digest,
      result.completed_at
    FROM privacy_purge_commands AS command
    JOIN privacy_purge_results AS result ON result.command_id = command.id
    WHERE command.id = ? AND command.status IN ('completed', 'failed')
  `).get(plan.commandId) as PrivacyPurgeTerminalRow | undefined;
  if (terminal === undefined) return false;
  if (
    terminal.status !== plan.outcome || terminal.outcome !== plan.outcome ||
    terminal.deletion_target_count !== orderedTargets.length ||
    terminal.deletion_plan_digest !== planDigest ||
    terminal.safe_counts_json !== safeCountsJson ||
    terminal.result_digest !== plan.resultDigest ||
    terminal.completed_at !== plan.completedAt
  ) {
    throw new Error("Privacy purge replay conflicts with its terminal receipt");
  }
  if (plan.outcome === "failed") {
    if (
      terminal.deletion_target_count !== 0 ||
      Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones
        WHERE purge_command_id = ?
      `).pluck().get(plan.commandId)) !== 0
    ) {
      throw new Error("Failed privacy purge replay has terminal lifecycle drift");
    }
    return true;
  }
  const lifecycleTargets = assertCommittedRunLifecycleTargets(
    connection,
    plan.commandId,
    terminal,
    orderedTargets,
    "retired",
  );
  const tombstones = connection.prepare(`
    SELECT subject_generation_id, history_epoch_id, tombstone_digest
    FROM privacy_subject_tombstones
    WHERE purge_command_id = ? ORDER BY subject_generation_id, history_epoch_id
  `).all(plan.commandId) as Array<{
    subject_generation_id: number | null;
    history_epoch_id: number | null;
    tombstone_digest: string;
  }>;
  if (terminal.target_kind === "run") {
    if (
      tombstones.length !== lifecycleTargets.length ||
      lifecycleTargets.some((target) => !tombstones.some((tombstone) =>
        tombstone.subject_generation_id === target.subjectGenerationId &&
        tombstone.history_epoch_id === null &&
        tombstone.tombstone_digest === runLifecycleTombstoneDigest(
          plan.tombstoneDigest,
          target,
          terminal.subject_generation_id!,
        )
      ))
    ) {
      throw new Error("Privacy purge replay conflicts with run tombstones");
    }
  } else if (terminal.target_kind === "resource_history") {
    if (
      terminal.history_epoch_id === null ||
      (lifecycleTargets.length === 0
        ? tombstones.length !== 1 ||
          tombstones[0]!.subject_generation_id !== null ||
          tombstones[0]!.history_epoch_id !== terminal.history_epoch_id ||
          tombstones[0]!.tombstone_digest !== plan.tombstoneDigest
        : tombstones.length !== lifecycleTargets.length ||
          lifecycleTargets.some((target) => !tombstones.some((tombstone) =>
            tombstone.subject_generation_id === target.subjectGenerationId &&
            tombstone.history_epoch_id === terminal.history_epoch_id &&
            tombstone.tombstone_digest === historyLifecycleTombstoneDigest(
              plan.tombstoneDigest,
              target,
              terminal.history_epoch_id!,
            )
          )))
    ) {
      throw new Error("Privacy purge replay conflicts with history tombstones");
    }
  } else if (
    tombstones.length !== 1 ||
    tombstones[0]!.subject_generation_id !== terminal.subject_generation_id ||
    tombstones[0]!.history_epoch_id !== terminal.history_epoch_id ||
    tombstones[0]!.tombstone_digest !== plan.tombstoneDigest
  ) {
    throw new Error("Privacy purge replay conflicts with its tombstone");
  }
  return true;
}

function retireRunGenerationsBeforePurge(
  connection: Database.Database,
  targets: readonly PrivacyPurgeLifecycleTarget[],
  completedAt: string,
  options: PrivacyPurgeExecutionOptions,
): void {
  const retire = connection.prepare(`
    UPDATE privacy_subject_generations
    SET research_run_id = NULL, is_active = 0, retired_at = ?
    WHERE id = ? AND subject_kind = 'research_run'
      AND generation_token = ? AND research_run_id = ? AND is_active = 1
  `);
  for (const [index, target] of targets.entries()) {
    if (retire.run(
      completedAt,
      target.subjectGenerationId,
      target.generationToken,
      target.researchRunId,
    ).changes !== 1) {
      throw new Error("Privacy purge run generation retirement failed");
    }
    if (index === 0) {
      injectPrivacyPurgeExecutionFailure(options, "after_first_retirement");
    }
  }
}

function runLifecycleTombstoneDigest(
  rootDigest: string,
  target: PrivacyPurgeLifecycleTarget,
  rootGenerationId: number,
): string {
  if (target.subjectGenerationId === rootGenerationId) return rootDigest;
  return sha256(sqlJsonMirror({
    version: "privacy_purge_run_tombstone:v1",
    rootDigest,
    subjectGenerationId: target.subjectGenerationId,
    generationToken: target.generationToken,
    researchRunId: target.researchRunId,
  }));
}

function historyLifecycleTombstoneDigest(
  rootDigest: string,
  target: PrivacyPurgeLifecycleTarget,
  historyEpochId: number,
): string {
  return sha256(sqlJsonMirror({
    version: "privacy_purge_history_run_tombstone:v1",
    rootDigest,
    historyEpochId,
    subjectGenerationId: target.subjectGenerationId,
    generationToken: target.generationToken,
    researchRunId: target.researchRunId,
  }));
}

function closePrivacyPurgeLifecycle(
  connection: Database.Database,
  commandId: number,
  command: PrivacyPurgeCommandRow,
  runLifecycleTargets: readonly PrivacyPurgeLifecycleTarget[],
  completedAt: string,
): void {
  if (command.target_kind === "run" || command.target_kind === "resource_history") {
    const retired = connection.prepare(`
      SELECT COUNT(*) FROM privacy_subject_generations AS generation
      JOIN privacy_purge_lifecycle_targets AS target
        ON target.subject_generation_id = generation.id
      WHERE target.purge_command_id = ?
        AND generation.subject_kind = 'research_run'
        AND generation.generation_token = target.generation_token
        AND generation.is_active = 0 AND generation.research_run_id IS NULL
    `).pluck().get(commandId);
    if (Number(retired) !== runLifecycleTargets.length) {
      throw new Error("Privacy purge run lifecycle did not close every target");
    }
    if (command.target_kind === "run") return;
  }
  if (command.target_kind !== "resource_history" && runLifecycleTargets.length !== 0) {
    throw new Error("Non-run privacy purge retained run lifecycle targets");
  }
  if (command.target_kind === "logical_page") {
    const generation = connection.prepare(
      `SELECT logical_page_id FROM privacy_subject_generations
       WHERE id = ? AND subject_kind = 'logical_page' AND is_active = 1`,
    ).get(command.subject_generation_id) as { logical_page_id: number } | undefined;
    if (generation === undefined || connection.prepare(
      `UPDATE privacy_subject_generations
       SET is_active = 0, retired_at = ? WHERE id = ? AND is_active = 1`,
    ).run(completedAt, command.subject_generation_id).changes !== 1) {
      throw new Error("Privacy purge logical-page generation retirement failed");
    }
    connection.prepare(
      `INSERT INTO privacy_subject_generations (
        subject_kind, logical_page_id, generation_token, is_active, created_at
      ) VALUES ('logical_page', ?, ?, 1, ?)`,
    ).run(generation.logical_page_id, randomBytes(32).toString("hex"), completedAt);
    return;
  }
  const history = connection.prepare(
    `SELECT resource_id, resource_generation_id, epoch_no
     FROM research_history_epochs WHERE id = ? AND is_active = 1`,
  ).get(command.history_epoch_id) as {
    resource_id: number;
    resource_generation_id: number;
    epoch_no: number;
  } | undefined;
  if (history === undefined || connection.prepare(
    `UPDATE research_history_epochs SET is_active = 0, retired_at = ?
     WHERE id = ? AND is_active = 1`,
  ).run(completedAt, command.history_epoch_id).changes !== 1) {
    throw new Error("Privacy purge history-epoch retirement failed");
  }
  connection.prepare(
    `INSERT INTO research_history_epochs (
      resource_id, resource_generation_id, epoch_no, is_active, created_at
    ) VALUES (?, ?, ?, 1, ?)`,
  ).run(
    history.resource_id,
    history.resource_generation_id,
    history.epoch_no + 1,
    completedAt,
  );
}

/**
 * Executes one already-enumerated exact-row purge plan. This is deliberately a
 * data-only API: it owns every statement and the complete transaction, and it
 * never calls caller-provided code.
 */
export function executePrivacyPurgePlan(
  connection: Database.Database,
  plainPlan: PrivacyPurgeExecutionPlan,
  plainOptions: PrivacyPurgeExecutionOptions = {},
): void {
  const plan = snapshotPrivacyPurgeExecutionPlan(plainPlan);
  const options = snapshotPrivacyPurgeExecutionOptions(plainOptions);
  if (connection.inTransaction) {
    throw new Error("Privacy purge execution requires autocommit mode");
  }
  if (pragmaNumber(connection, "foreign_keys") !== 1) {
    throw new Error("Privacy purge execution requires foreign_keys=ON");
  }
  if (
    !purgeAuthorities.has(connection) || !purgeFinalizations.has(connection) ||
    Number(connection.prepare(
      "SELECT COUNT(*) FROM privacy_purge_transaction_fence_roots",
    ).pluck().get()) !== 0
  ) {
    throw new Error("Privacy purge execution authorization is unavailable or corrupt");
  }
  const orderedTargets = plan.outcome === "completed" ? plan.orderedTargets : [];
  const planDigest = digestPrivacyPurgeExecutionTargets(orderedTargets);
  const safeCountsJson = sqlJsonMirror(plan.safeCounts);
  if (acceptExactPrivacyPurgeReplay(
    connection,
    plan,
    orderedTargets,
    planDigest,
    safeCountsJson,
  )) {
    return;
  }
  connection.exec("BEGIN IMMEDIATE");
  try {
    const command = connection.prepare(
      `SELECT target_kind, subject_generation_id, history_epoch_id,
        deletion_target_count, deletion_plan_digest,
        lifecycle_target_count, lifecycle_plan_digest, created_at
       FROM privacy_purge_commands
       WHERE id = ? AND status IN ('pending', 'waiting')
         AND NOT EXISTS (
           SELECT 1 FROM privacy_purge_results WHERE command_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM privacy_subject_tombstones WHERE purge_command_id = ?
         )`,
    ).get(plan.commandId, plan.commandId, plan.commandId) as
      | PrivacyPurgeCommandRow
      | undefined;
    if (command === undefined) {
      throw new Error("Privacy purge command is not open for execution");
    }
    if (
      command.deletion_target_count !== orderedTargets.length ||
      command.deletion_plan_digest !== planDigest
    ) {
      throw new Error("Privacy purge ordered plan does not match its durable commitment");
    }
    if (plan.completedAt < command.created_at) {
      throw new Error("Privacy purge completion cannot precede command creation");
    }
    if (plan.outcome === "failed" && command.deletion_target_count !== 0) {
      throw new Error("Failed privacy purge execution requires an empty committed plan");
    }
    assertPrivacyPurgeTargetCatalogFrozen(connection);
    assertPrivacyPurgeDeletionManifestFrozen(connection);
    const runLifecycleTargets = assertCommittedRunLifecycleTargets(
      connection,
      plan.commandId,
      command,
      orderedTargets,
      "active",
      plan.outcome === "completed",
    );

    const finalizationNonce = randomBytes(32).toString("hex");
    purgeFenceInstallers.set(connection, new Set([finalizationNonce]));
    try {
      connection.prepare(
        "INSERT INTO privacy_purge_transaction_fences (nonce_digest) VALUES (?)",
      ).run(finalizationNonce);
    } finally {
      purgeFenceInstallers.set(connection, new Set());
    }
    purgeFinalizations.set(
      connection,
      new Map([[plan.commandId, finalizationNonce]]),
    );

    if (plan.outcome === "completed") {
      const insertTombstone = connection.prepare(
        `INSERT INTO privacy_subject_tombstones (
          subject_generation_id, history_epoch_id, purge_command_id,
          tombstone_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      if (command.target_kind === "run") {
        for (const target of runLifecycleTargets) {
          insertTombstone.run(
            target.subjectGenerationId,
            null,
            plan.commandId,
            runLifecycleTombstoneDigest(
              plan.tombstoneDigest,
              target,
              command.subject_generation_id!,
            ),
            plan.completedAt,
          );
        }
      } else if (command.target_kind === "resource_history") {
        if (runLifecycleTargets.length === 0) {
          insertTombstone.run(
            null,
            command.history_epoch_id,
            plan.commandId,
            plan.tombstoneDigest,
            plan.completedAt,
          );
        } else {
          for (const target of runLifecycleTargets) {
            insertTombstone.run(
              target.subjectGenerationId,
              command.history_epoch_id,
              plan.commandId,
              historyLifecycleTombstoneDigest(
                plan.tombstoneDigest,
                target,
                command.history_epoch_id!,
              ),
              plan.completedAt,
            );
          }
        }
      } else {
        insertTombstone.run(
          command.subject_generation_id,
          command.history_epoch_id,
          plan.commandId,
          plan.tombstoneDigest,
          plan.completedAt,
        );
      }
      injectPrivacyPurgeExecutionFailure(options, "after_tombstone");
      if (options.testOnlyFailurePoint === "result_before_authorities") {
        connection.prepare(
          `INSERT INTO privacy_purge_results (
            command_id, outcome, safe_counts_json, result_digest, completed_at
          ) VALUES (?, 'completed', ?, ?, ?)`,
        ).run(plan.commandId, safeCountsJson, plan.resultDigest, plan.completedAt);
        throw new Error("Privacy purge result unexpectedly preceded authorities");
      }

      retireRunGenerationsBeforePurge(
        connection,
        runLifecycleTargets,
        plan.completedAt,
        options,
      );
      const preparedTargets: PreparedPrivacyPurgeTarget[] = [];
      let priorDeleteRank = Number.POSITIVE_INFINITY;
      for (const target of plan.orderedTargets) {
        const catalogs = connection.prepare(`
          SELECT catalog.pk_expression_sql, catalog.pk_columns_json,
            catalog.delete_rank, catalog.requires_authority,
            catalog.guard_trigger_name,
            manifest.table_name AS guarded_table_name,
            manifest.pk_expression_sql AS guarded_pk_expression_sql,
            manifest.pk_columns_json AS guarded_pk_columns_json,
            manifest.predicate_sql AS guarded_predicate_sql,
            (SELECT COUNT(*) FROM privacy_purge_deletion_manifest AS candidate
             WHERE candidate.table_name = catalog.table_name) AS manifest_table_count
          FROM privacy_purge_target_catalog AS catalog
          LEFT JOIN privacy_purge_deletion_manifest AS manifest
            ON manifest.trigger_name = catalog.guard_trigger_name
          WHERE catalog.table_name = ?
        `).all(target.tableName) as PrivacyPurgeTargetCatalogRow[];
        if (catalogs.length !== 1) {
          throw new Error(
            `Privacy purge target table is not uniquely frozen: ${target.tableName}`,
          );
        }
        const catalog = catalogs[0]!;
        if (catalog.delete_rank > priorDeleteRank) {
          throw new Error(
            `Privacy purge target order is not FK-safe: ${target.tableName}`,
          );
        }
        priorDeleteRank = catalog.delete_rank;
        const hasGuardManifest = catalog.requires_authority === 1;
        if (hasGuardManifest) {
          if (
            catalog.guard_trigger_name === null ||
            catalog.guarded_table_name !== target.tableName ||
            catalog.guarded_pk_expression_sql !== catalog.pk_expression_sql ||
            catalog.guarded_pk_columns_json !== catalog.pk_columns_json ||
            catalog.guarded_predicate_sql === null ||
            catalog.manifest_table_count !== 1
          ) {
            throw new Error(
              `Privacy purge target guard binding drifted: ${target.tableName}`,
            );
          }
        } else if (
          catalog.guard_trigger_name !== null ||
          catalog.guarded_table_name !== null ||
          catalog.manifest_table_count !== 0
        ) {
          throw new Error(
            `Privacy purge ordinary target binding drifted: ${target.tableName}`,
          );
        }
        const tableIdentifier = `"${target.tableName.replaceAll('"', '""')}"`;
        const expression = catalog.pk_expression_sql.replaceAll(
          "OLD.",
          "target.",
        );
        const predicateExpression = catalog.guarded_predicate_sql?.replaceAll(
          "OLD.",
          "target.",
        );
        const evaluateGuardPredicate = hasGuardManifest
          ? connection.prepare(
            `SELECT CASE WHEN (${predicateExpression}) THEN 1 ELSE 0 END
             FROM ${tableIdentifier} AS target
             WHERE (${expression}) = ? LIMIT 1`,
          ).pluck()
          : null;
        const requiresAuthority = evaluateGuardPredicate !== null &&
          Number(evaluateGuardPredicate.get(target.pkV1)) === 1;
        preparedTargets.push({
          ...target,
          hasGuardManifest,
          requiresAuthority,
          deleteRank: catalog.delete_rank,
          exists: connection.prepare(
            `SELECT 1 FROM ${tableIdentifier} AS target
             WHERE (${expression}) = ? LIMIT 1`,
          ),
          evaluateGuardPredicate,
          deleteExact: connection.prepare(
            `DELETE FROM ${tableIdentifier} AS target
             WHERE (${expression}) = ?`,
          ),
        });
      }
      for (const target of preparedTargets) {
        if (target.exists.get(target.pkV1) === undefined) {
          throw new Error(`Privacy purge exact target is absent: ${target.tableName}`);
        }
      }
      const targetedActionOrder = new Map<number, number>();
      const readTargetedAction = connection.prepare(`
        SELECT id, discovered_from_action_id
        FROM live_acquisition_actions AS action
        WHERE ('pk:v1|1|' || 'i:' || length(CAST(action.id AS TEXT)) || ':'
          || CAST(action.id AS TEXT)) = ?
      `);
      for (const [index, target] of preparedTargets.entries()) {
        if (target.tableName !== "live_acquisition_actions") continue;
        const row = readTargetedAction.get(target.pkV1) as {
          id: number;
          discovered_from_action_id: number | null;
        } | undefined;
        if (row === undefined) {
          throw new Error("Privacy purge exact live acquisition action is absent");
        }
        targetedActionOrder.set(row.id, index);
      }
      const readActionChildren = connection.prepare(`
        SELECT id FROM live_acquisition_actions
        WHERE discovered_from_action_id = ? ORDER BY id
      `).pluck();
      for (const [parentId, parentIndex] of targetedActionOrder) {
        const childIds = readActionChildren.all(parentId) as number[];
        for (const childId of childIds) {
          const childIndex = targetedActionOrder.get(childId);
          if (childIndex === undefined) {
            throw new Error(
              "Privacy purge cannot retain a discovered live acquisition child",
            );
          }
          if (childIndex >= parentIndex) {
            throw new Error(
              "Privacy purge must order live acquisition descendants before parents",
            );
          }
        }
      }

      const insertAuthority = connection.prepare(
        `INSERT INTO privacy_purge_authorities (
          command_id, table_name, pk_v1, nonce_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertFence = connection.prepare(
        "INSERT INTO privacy_purge_transaction_fences (nonce_digest) VALUES (?)",
      );
      const consumeAuthority = connection.prepare(
        `UPDATE privacy_purge_authorities SET consumed_at = ?
         WHERE command_id = ? AND table_name = ? AND pk_v1 = ?
           AND nonce_digest = ? AND consumed_at IS NULL`,
      );
      const removeAuthority = connection.prepare(
        `DELETE FROM privacy_purge_authorities
         WHERE command_id = ? AND table_name = ? AND pk_v1 = ?
           AND nonce_digest = ? AND consumed_at IS NOT NULL`,
      );
      const removeFence = connection.prepare(
        "DELETE FROM privacy_purge_transaction_fences WHERE nonce_digest = ?",
      );
      let lastGuardedTargetIndex = -1;
      for (const [index, target] of preparedTargets.entries()) {
        if (target.requiresAuthority) lastGuardedTargetIndex = index;
      }
      if (
        options.testOnlyFailurePoint === "missing_last_authority" &&
        lastGuardedTargetIndex < 0
      ) {
        throw new Error("Injected privacy purge execution failure at missing_last_authority");
      }
      for (const [index, target] of preparedTargets.entries()) {
        if (target.exists.get(target.pkV1) === undefined) {
          throw new Error(`Privacy purge exact target drifted: ${target.tableName}`);
        }
        const predicateMatchesNow = target.hasGuardManifest &&
          target.evaluateGuardPredicate !== null &&
          Number(target.evaluateGuardPredicate.get(target.pkV1)) === 1;
        if (predicateMatchesNow !== target.requiresAuthority) {
          throw new Error(
            `Privacy purge exact-row predicate drifted: ${target.tableName}`,
          );
        }

        let nonceDigest: string | null = null;
        let authorityKey: string | null = null;
        let removalKey: string | null = null;
        const omitAuthority = target.requiresAuthority &&
          options.testOnlyFailurePoint === "missing_last_authority" &&
          index === lastGuardedTargetIndex;
        if (target.requiresAuthority && !omitAuthority) {
          nonceDigest = randomBytes(32).toString("hex");
          authorityKey = purgeAuthorityKey(
            target.tableName,
            target.pkV1,
            nonceDigest,
          );
          removalKey = purgeAuthorityRemovalKey(
            plan.commandId,
            target.tableName,
            target.pkV1,
            nonceDigest,
          );
          insertAuthority.run(
            plan.commandId,
            target.tableName,
            target.pkV1,
            nonceDigest,
            plan.completedAt,
          );
          purgeFenceInstallers.set(connection, new Set([nonceDigest]));
          try {
            insertFence.run(nonceDigest);
          } finally {
            purgeFenceInstallers.set(connection, new Set());
          }
          purgeAuthorities.set(connection, new Set([authorityKey]));
          purgeAuthorityUses.set(connection, new Set());
        } else {
          purgeAuthorities.set(connection, new Set());
          purgeAuthorityUses.set(connection, new Set());
        }

        if (target.deleteExact.run(target.pkV1).changes !== 1) {
          throw new Error(`Privacy purge exact delete failed: ${target.tableName}`);
        }
        const usedAuthorities = purgeAuthorityUses.get(connection) ?? new Set();
        if (target.requiresAuthority) {
          if (
            authorityKey === null || nonceDigest === null || removalKey === null ||
            usedAuthorities.size !== 1 || !usedAuthorities.has(authorityKey) ||
            (purgeAuthorities.get(connection)?.size ?? 0) !== 0
          ) {
            throw new Error(
              `Privacy purge authority was not exercised exactly once: ${target.tableName}`,
            );
          }
          purgeAuthorityConsumers.set(connection, new Set([removalKey]));
          try {
            if (consumeAuthority.run(
              plan.completedAt,
              plan.commandId,
              target.tableName,
              target.pkV1,
              nonceDigest,
            ).changes !== 1) {
              throw new Error(
                `Privacy purge authority consumption failed: ${target.tableName}`,
              );
            }
          } finally {
            purgeAuthorityConsumers.set(connection, new Set());
          }
          purgeAuthorityRemovers.set(connection, new Set([removalKey]));
          try {
            if (removeAuthority.run(
              plan.commandId,
              target.tableName,
              target.pkV1,
              nonceDigest,
            ).changes !== 1) {
              throw new Error(
                `Privacy purge authority removal failed: ${target.tableName}`,
              );
            }
          } finally {
            purgeAuthorityRemovers.set(connection, new Set());
          }
          purgeFenceRemovers.set(connection, new Set([nonceDigest]));
          try {
            if (removeFence.run(nonceDigest).changes !== 1) {
              throw new Error("Privacy purge target fence removal failed");
            }
          } finally {
            purgeFenceRemovers.set(connection, new Set());
          }
        } else if (
          usedAuthorities.size !== 0 ||
          (purgeAuthorities.get(connection)?.size ?? 0) !== 0
        ) {
          throw new Error(
            `Privacy purge false predicate received authority: ${target.tableName}`,
          );
        }
        purgeAuthorities.set(connection, new Set());
        purgeAuthorityUses.set(connection, new Set());
        if (index === 0) {
          injectPrivacyPurgeExecutionFailure(options, "mid_delete");
        }
      }
      injectPrivacyPurgeExecutionFailure(options, "recreate_first_target");
      for (const target of preparedTargets) {
        if (target.exists.get(target.pkV1) !== undefined) {
          throw new Error(`Privacy purge exact target was recreated: ${target.tableName}`);
        }
      }
      closePrivacyPurgeLifecycle(
        connection,
        plan.commandId,
        command,
        runLifecycleTargets,
        plan.completedAt,
      );
      injectPrivacyPurgeExecutionFailure(options, "before_result_status");
      connection.prepare(
        `INSERT INTO privacy_purge_results (
          command_id, outcome, safe_counts_json, result_digest, completed_at
        ) VALUES (?, 'completed', ?, ?, ?)`,
      ).run(plan.commandId, safeCountsJson, plan.resultDigest, plan.completedAt);
      connection.prepare(
        "UPDATE privacy_purge_commands SET status = 'completed' WHERE id = ?",
      ).run(plan.commandId);
    } else {
      connection.prepare(
        `INSERT INTO privacy_purge_results (
          command_id, outcome, safe_counts_json, result_digest, completed_at
        ) VALUES (?, 'failed', ?, ?, ?)`,
      ).run(plan.commandId, safeCountsJson, plan.resultDigest, plan.completedAt);
      connection.prepare(
        "UPDATE privacy_purge_commands SET status = 'failed' WHERE id = ?",
      ).run(plan.commandId);
    }

    if (connection.prepare(
      `SELECT 1 FROM privacy_purge_commands AS command
       JOIN privacy_purge_results AS result ON result.command_id = command.id
       WHERE command.id = ? AND command.status = result.outcome
         AND command.status IN ('completed', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM privacy_purge_authorities AS authority
           WHERE authority.command_id = command.id
         )
         AND (
           (command.status = 'completed' AND (
             (
               command.target_kind = 'run'
               AND command.lifecycle_target_count = (
                 SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
                 WHERE tombstone.purge_command_id = command.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM privacy_purge_lifecycle_targets AS target
                 LEFT JOIN privacy_subject_tombstones AS tombstone
                   ON tombstone.purge_command_id = target.purge_command_id
                   AND tombstone.subject_generation_id = target.subject_generation_id
                 JOIN privacy_subject_generations AS generation
                   ON generation.id = target.subject_generation_id
                 WHERE target.purge_command_id = command.id
                   AND (
                     tombstone.id IS NULL
                     OR generation.generation_token <> target.generation_token
                     OR generation.is_active <> 0
                     OR generation.research_run_id IS NOT NULL
                   )
               )
             )
             OR (
               command.target_kind = 'resource_history'
               AND (CASE WHEN command.lifecycle_target_count = 0 THEN 1
                 ELSE command.lifecycle_target_count END) = (
                 SELECT COUNT(*) FROM privacy_subject_tombstones AS tombstone
                 WHERE tombstone.purge_command_id = command.id
                   AND tombstone.history_epoch_id = command.history_epoch_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM privacy_purge_lifecycle_targets AS target
                 LEFT JOIN privacy_subject_tombstones AS tombstone
                   ON tombstone.purge_command_id = target.purge_command_id
                   AND tombstone.subject_generation_id = target.subject_generation_id
                   AND tombstone.history_epoch_id = command.history_epoch_id
                 JOIN privacy_subject_generations AS generation
                   ON generation.id = target.subject_generation_id
                 WHERE target.purge_command_id = command.id
                   AND (tombstone.id IS NULL
                     OR generation.generation_token <> target.generation_token
                     OR generation.is_active <> 0
                     OR generation.research_run_id IS NOT NULL)
               )
             )
             OR (
               command.target_kind = 'logical_page'
               AND EXISTS (
                 SELECT 1 FROM privacy_subject_tombstones AS tombstone
                 WHERE tombstone.purge_command_id = command.id
                   AND tombstone.subject_generation_id IS command.subject_generation_id
                   AND tombstone.history_epoch_id IS command.history_epoch_id
               )
             )
           ))
           OR (command.status = 'failed' AND NOT EXISTS (
             SELECT 1 FROM privacy_subject_tombstones AS tombstone
             WHERE tombstone.purge_command_id = command.id
           ))
         )`,
    ).get(plan.commandId) === undefined) {
      throw new Error("Privacy purge execution is not durably terminal");
    }
    purgeFenceRemovers.set(connection, new Set([finalizationNonce]));
    try {
      if (connection.prepare(
        "DELETE FROM privacy_purge_transaction_fences WHERE nonce_digest = ?",
      ).run(finalizationNonce).changes !== 1) {
        throw new Error("Privacy purge finalization fence removal failed");
      }
    } finally {
      purgeFenceRemovers.set(connection, new Set());
    }
    purgeFinalizations.set(connection, new Map());
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    resetPrivacyPurgeLocalState(connection);
  }
}

function injectFailure(
  options: LiveAcquisitionMigrationOptions,
  point: LiveAcquisitionMigrationFailurePoint,
): void {
  if (options.failurePoint === point) {
    throw new Error(`Injected live acquisition migration failure at ${point}`);
  }
}

function pragmaNumber(
  connection: Database.Database,
  pragma: string,
): number {
  return Number(connection.pragma(pragma, { simple: true }));
}

const sourceColumnsV24 = [
  "id",
  "run_id",
  "ordinal",
  "logical_page_id",
  "tab_id",
  "captured_tab_id_snapshot",
  "content_revision",
  "content_digest",
  "extracted_at",
  "acquisition_method",
  "access_class_snapshot",
  "eligibility",
  "inclusion_state",
  "exclusion_reason",
  "included_order",
  "failure_code",
  "created_at",
] as const;

const sourceChildTables = [
  "research_source_state_events",
  "research_source_payloads",
  "research_report_sources",
  "research_claim_evidence",
] as const;

const externalSourceTriggers = [
  "contents_invalidate_research_sources_after_delete",
  "contents_invalidate_research_sources_after_update",
  "research_claim_evidence_same_run",
  "research_report_sources_same_run",
  "research_source_payloads_insert_guard",
] as const;

const schema25ExternalSourceDependencies = [
  ...externalSourceTriggers,
  "live_acquisition_handoff_receipts_insert_guard",
  "research_source_payloads_no_late_live_insert",
  "research_source_state_events_no_late_live_accept",
].sort();

const schema25SourceObjectFingerprints = new Map<string, string>([
  ["research_sources_exact_identity_idx", "ad6561e851e0fd96ce9e10d9318cfccc46e92587818b6726f8c6944aad618a79"],
  ["research_sources_immutable_delete", "3367297cff53bf0ef578ed4b9853ca89e403ab2459790a82316dc08b42331680"],
  ["research_sources_immutable_update", "442e313418ebc386be643cb26e1490597fd902279b1a106879893a044a842346"],
  ["research_sources_live_capture_insert_guard", "5e03a392247ff3796237d8097fa00f2d42fa628a0a55d7e2d14f999288ee3ce5"],
  ["research_sources_live_receipt_insert_guard", "e4d1090c181984b9ebc750e27c264ecd76ffbf8ad2d82ee00d0da5475ba11cf8"],
  ["research_sources_no_late_live_insert", "dc2b589f7edc04ca4c583a8313d9993814871b0af492a3e8d4d61075d184f442"],
  ["research_sources_run_state_idx", "ace1037b9355de5dbd86fa21c9303ef3d1ae291543577dec2d3ee51edea00eef"],
]);

const schema25ResearchSourcesTableFingerprint =
  "084d854b923f6a3b926b8c40940c946d9edcc294f588d7f1f9358a32a8b02b06";

const schema25ExternalSourceTriggerFingerprints = new Map<string, string>([
  [
    "contents_invalidate_research_sources_after_delete",
    "c3bb7a15e7dbe478458d2ff283b56d5a0b4a16a233e60da85201dfc0d9586eb4",
  ],
  [
    "contents_invalidate_research_sources_after_update",
    "68ec000b7e614fdd1ca99279dd30645a8810ad02e60b0f1d616fdf1078124a35",
  ],
  [
    "research_source_payloads_insert_guard",
    "75dd17a053434053676925243d3d095decb65de237415acaeb6053bfa2c2198d",
  ],
  [
    "research_claim_evidence_same_run",
    "6bae800307558241c567ba904724d4144455786fea9abb296e1a80db12d0c2ab",
  ],
  [
    "research_report_sources_same_run",
    "83ee2eb9849bff6bc30246c02e3b835f6590a2df944090bb0562ad2a277da2ae",
  ],
  [
    "live_acquisition_handoff_receipts_insert_guard",
    "10ad8dcc28209244f9e5347d59d4d59a7f6b63348b1a2a2dce3902c05551eec5",
  ],
  [
    "research_source_payloads_no_late_live_insert",
    "71bd655d2d9ae7c6efc43a08e0c0f9bfb91e256d524091fad69660f84e39e06e",
  ],
  [
    "research_source_state_events_no_late_live_accept",
    "1e8dc211998b1a31eaea565cde7c81c285af25ec4fea04b06ab7f7e4adef2279",
  ],
]);

const schema25DeletionManifestFingerprint =
  "dc505c4b389494cbb89e043de53889afac7d5720506e0c3efad0860325e6cc1f";

const schema25PurgeTargetCatalogFingerprint =
  "63fad6152932ee36029ba3cbace2b7b52e262287b0371effb41631ae7a54e507";

const schema25OwnedSchemaMutationFingerprint =
  "fa14bb8849b4c2f8bc2331b4794271ed30ea5d10b708a2e19783d8d8f30381f8";

const expectedDeletionManifestTriggers = [
  "agent_research_command_receipts_immutable_delete",
  "agent_user_importance_receipts_immutable_delete",
  "ai_job_attempts_immutable_delete",
  "ai_job_events_immutable_delete",
  "ai_job_idempotency_receipts_immutable_delete",
  "live_acquisition_action_authorizations_immutable_delete",
  "live_acquisition_action_events_immutable_delete",
  "live_acquisition_actions_immutable_delete",
  "live_acquisition_body_payloads_redaction_guard",
  "live_acquisition_capture_manifests_immutable_delete",
  "live_acquisition_checkpoints_immutable_delete",
  "live_acquisition_consent_payloads_redaction_guard",
  "live_acquisition_consents_immutable_delete",
  "live_acquisition_digest_keys_redaction_guard",
  "live_acquisition_dns_payloads_redaction_guard",
  "live_acquisition_handoff_receipts_immutable_delete",
  "live_acquisition_handoffs_immutable_delete",
  "live_acquisition_origin_courtesy_state_immutable_delete",
  "live_acquisition_page_reservations_immutable_delete",
  "live_acquisition_provider_reservation_adoptions_immutable_delete",
  "live_acquisition_provider_reservations_immutable_delete",
  "live_acquisition_source_receipts_immutable_delete",
  "live_acquisition_url_payloads_redaction_guard",
  "live_acquisition_workflow_outcomes_immutable_delete",
  "priority_assessments_privacy_delete_only",
  "priority_exclusions_privacy_delete_only",
  "priority_feedback_privacy_delete_only",
  "research_activity_snapshots_immutable_delete",
  "research_claim_evidence_immutable_delete",
  "research_claim_payloads_redaction_guard",
  "research_claims_immutable_delete",
  "research_evidence_payloads_redaction_guard",
  "research_evidence_state_events_immutable_delete",
  "research_page_context_snapshots_immutable_delete",
  "research_privacy_event_bindings_immutable_delete",
  "research_privacy_requests_immutable_delete",
  "research_privacy_run_bindings_immutable_delete",
  "research_redaction_receipts_immutable_delete",
  "research_relation_snapshots_immutable_delete",
  "research_report_payloads_redaction_guard",
  "research_report_sources_immutable_delete",
  "research_report_state_events_immutable_delete",
  "research_reports_immutable_delete",
  "research_resource_context_snapshots_immutable_delete",
  "research_run_events_immutable_delete",
  "research_run_payloads_redaction_guard",
  "research_runs_immutable_delete",
  "research_selection_pages_immutable_delete",
  "research_snapshot_payloads_redaction_guard",
  "research_snapshot_state_events_immutable_delete",
  "research_source_payloads_redaction_guard",
  "research_source_state_events_immutable_delete",
  "research_sources_immutable_delete",
  "research_target_heads_no_delete",
  "resource_assignment_heads_delete_guard",
  "resource_assignments_delete_immutable",
  "resource_resolution_heads_delete_guard",
  "resource_resolutions_delete_immutable",
] as const;

const expectedOrdinaryPurgeTargetTables = [
  "ai_jobs",
  "context_entries",
  "context_entry_reviews",
  "logical_page_activity_daily",
  "logical_page_importance_migration_audit",
  "logical_page_preferences",
  "tab_session_intents",
] as const;

const schema25DeletionTriggers = new Set([
  "live_acquisition_action_authorizations_immutable_delete",
  "live_acquisition_action_events_immutable_delete",
  "live_acquisition_actions_immutable_delete",
  "live_acquisition_body_payloads_redaction_guard",
  "live_acquisition_capture_manifests_immutable_delete",
  "live_acquisition_checkpoints_immutable_delete",
  "live_acquisition_consent_payloads_redaction_guard",
  "live_acquisition_consents_immutable_delete",
  "live_acquisition_digest_keys_redaction_guard",
  "live_acquisition_dns_payloads_redaction_guard",
  "live_acquisition_handoff_receipts_immutable_delete",
  "live_acquisition_handoffs_immutable_delete",
  "live_acquisition_origin_courtesy_state_immutable_delete",
  "live_acquisition_page_reservations_immutable_delete",
  "live_acquisition_provider_reservation_adoptions_immutable_delete",
  "live_acquisition_provider_reservations_immutable_delete",
  "live_acquisition_source_receipts_immutable_delete",
  "live_acquisition_url_payloads_redaction_guard",
  "live_acquisition_workflow_outcomes_immutable_delete",
  "priority_assessments_privacy_delete_only",
  "priority_exclusions_privacy_delete_only",
  "priority_feedback_privacy_delete_only",
  "resource_assignment_heads_delete_guard",
  "resource_assignments_delete_immutable",
  "resource_resolution_heads_delete_guard",
  "resource_resolutions_delete_immutable",
]);

const expectedLegacyDeletionTriggers = expectedDeletionManifestTriggers.filter(
  (name) => !schema25DeletionTriggers.has(name),
);

const schema24BlockingDeletionTriggers = [
  "activity_tracking_epochs_immutable_delete",
  "agent_research_command_receipts_immutable_delete",
  "agent_user_importance_receipts_immutable_delete",
  "ai_job_attempts_immutable_delete",
  "ai_job_events_immutable_delete",
  "ai_job_idempotency_receipts_immutable_delete",
  "priority_assessments_privacy_delete_only",
  "priority_baseline_ruleset_immutable_delete",
  "priority_exclusions_privacy_delete_only",
  "priority_feedback_privacy_delete_only",
  "priority_rule_versions_immutable_delete",
  "research_activity_snapshots_immutable_delete",
  "research_claim_evidence_immutable_delete",
  "research_claim_payloads_redaction_guard",
  "research_claims_immutable_delete",
  "research_evidence_payloads_redaction_guard",
  "research_evidence_state_events_immutable_delete",
  "research_page_context_snapshots_immutable_delete",
  "research_privacy_event_bindings_immutable_delete",
  "research_privacy_requests_immutable_delete",
  "research_privacy_run_bindings_immutable_delete",
  "research_redaction_receipts_immutable_delete",
  "research_relation_snapshots_immutable_delete",
  "research_report_payloads_redaction_guard",
  "research_report_sources_immutable_delete",
  "research_report_state_events_immutable_delete",
  "research_reports_immutable_delete",
  "research_resource_context_snapshots_immutable_delete",
  "research_run_events_immutable_delete",
  "research_run_payloads_redaction_guard",
  "research_runs_immutable_delete",
  "research_selection_pages_immutable_delete",
  "research_snapshot_payloads_redaction_guard",
  "research_snapshot_state_events_immutable_delete",
  "research_source_payloads_redaction_guard",
  "research_source_state_events_immutable_delete",
  "research_sources_immutable_delete",
  "research_target_heads_no_delete",
  "resource_assignment_heads_delete_guard",
  "resource_assignments_delete_immutable",
  "resource_command_receipts_delete_immutable",
  "resource_events_delete_immutable",
  "resource_heads_delete_guard",
  "resource_priority_assessments_privacy_delete_only",
  "resource_priority_exclusions_privacy_delete_only",
  "resource_priority_feedback_privacy_delete_only",
  "resource_resolution_heads_delete_guard",
  "resource_resolutions_delete_immutable",
  "resource_rule_heads_delete_guard",
  "resource_rules_delete_immutable",
  "resource_ruleset_events_delete_immutable",
  "resource_ruleset_heads_delete_guard",
  "resources_delete_immutable",
  "system_topic_delete",
] as const;

const schema25BlockingDeletionTriggers = [
  ...schema24BlockingDeletionTriggers.filter(
    (name) => !new Set<string>(expectedDeletionManifestTriggers).has(name),
  ),
  ...expectedDeletionManifestTriggers,
  "live_acquisition_runtime_state_no_delete",
  "privacy_purge_authorities_immutable_delete",
  "privacy_purge_commands_immutable_delete",
  "privacy_purge_deletion_manifest_immutable_delete",
  "privacy_purge_lifecycle_targets_immutable_delete",
  "privacy_purge_results_immutable_delete",
  "privacy_purge_target_catalog_immutable_delete",
  "privacy_purge_transaction_fences_delete_guard",
  "privacy_subject_generations_immutable_delete",
  "privacy_subject_tombstones_immutable_delete",
  "research_history_epochs_immutable_delete",
].sort();

interface SchemaSnapshot {
  readonly sourceCount: number;
  readonly sourceChecksum: string;
  readonly childSchema: ReadonlyMap<string, string>;
  readonly childForeignKeys: ReadonlyMap<string, string>;
  readonly protectedObjects: ReadonlyMap<string, string>;
  readonly sourceObjects: ReadonlyMap<string, string>;
  readonly externalTriggers: ReadonlyMap<string, string>;
  readonly externalDependencyNames: readonly string[];
  readonly legacyDeletionTriggers: readonly string[];
  readonly blockingDeletionTriggers: readonly string[];
  readonly schemaObjects: ReadonlyMap<string, SchemaObjectRow>;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function transactionControlScanText(sql: string): string {
  let result = "";
  for (let index = 0; index < sql.length;) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        result += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index = Math.min(sql.length, index + 2);
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      const quote = character;
      result += " ";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        result += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (character === "[") {
      result += " ";
      index += 1;
      while (index < sql.length && sql[index] !== "]") {
        result += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index = Math.min(sql.length, index + 1);
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

export function assertNoMigrationTransactionControl(sql: string): void {
  const scanText = transactionControlScanText(sql);
  const tokens = scanText.match(
    /[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_$\u0080-\u{10FFFF}]*|;/gu,
  ) ?? [];
  let statementStart = true;
  let statementPrefix: string[] = [];
  let isTrigger = false;
  let triggerBodyDepth = 0;
  let triggerCaseDepth = 0;
  const reject = (): never => {
    throw new Error("Live acquisition migration SQL must not contain transaction control");
  };
  for (const rawToken of tokens) {
    const token = rawToken.toUpperCase();
    if (token === ";") {
      if (!isTrigger || triggerBodyDepth === 0) {
        statementStart = true;
        statementPrefix = [];
        isTrigger = false;
        triggerCaseDepth = 0;
      }
      continue;
    }
    if (
      statementStart &&
      ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]
        .includes(token)
    ) {
      reject();
    }
    if (statementStart) statementStart = false;
    if (!isTrigger && statementPrefix.length < 4) {
      statementPrefix.push(token);
      const prefixWithoutQualifier = statementPrefix.filter((candidate) =>
        candidate !== "TEMP" && candidate !== "TEMPORARY"
      );
      isTrigger = prefixWithoutQualifier[0] === "CREATE" &&
        prefixWithoutQualifier[1] === "TRIGGER";
    }
    if (!isTrigger) continue;
    if (token === "BEGIN" && triggerBodyDepth === 0) {
      triggerBodyDepth = 1;
    } else if (triggerBodyDepth > 0 && token === "CASE") {
      triggerCaseDepth += 1;
    } else if (triggerBodyDepth > 0 && token === "END") {
      if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
      else triggerBodyDepth -= 1;
    }
  }
}

function runTestOnlyValidationProbe(
  connection: Database.Database,
  probe: LiveAcquisitionMigrationValidationProbe | undefined,
): void {
  if (probe === undefined) return;
  const sqlByProbe: Record<LiveAcquisitionMigrationValidationProbe, string> = {
    delete_captured_source: `DROP TRIGGER research_sources_immutable_delete;
      DELETE FROM research_sources;`,
    post_delete_guard: `CREATE TRIGGER rogue_schema25_delete_guard
      BEFORE DELETE ON tabs BEGIN
        SELECT RAISE(ABORT, 'rogue schema-25 guard');
      END;`,
    source_column:
      "ALTER TABLE research_sources ADD COLUMN rogue_column TEXT;",
    manifest_pk: `UPDATE privacy_purge_deletion_manifest
      SET pk_columns_json = '["run_id"]'
      WHERE trigger_name = 'research_sources_immutable_delete';`,
    external_trigger_semantic_replacement: `DROP TRIGGER research_source_payloads_insert_guard;
      CREATE TRIGGER research_source_payloads_insert_guard
      BEFORE INSERT ON research_source_payloads
      WHEN EXISTS (
        SELECT 1 FROM research_sources AS source
        WHERE source.id = NEW.source_id AND source.source_kind = 'captured'
      )
      BEGIN
        SELECT RAISE(ABORT, 'semantic replacement');
      END;`,
    manifest_self_consistent_replacement: `DROP TRIGGER research_runs_immutable_delete;
      CREATE TRIGGER research_runs_immutable_delete
      BEFORE DELETE ON research_runs
      WHEN (0) AND NOT EXISTS (
        SELECT 1 FROM privacy_purge_authorities AS authority
        JOIN privacy_purge_commands AS command ON command.id = authority.command_id
        WHERE authority.table_name = 'research_runs'
          AND authority.pk_v1 = 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT)
          AND authority.consumed_at IS NULL
          AND command.status IN ('pending', 'waiting')
          AND EXISTS (
            SELECT 1 FROM privacy_purge_transaction_fences AS fence
            WHERE fence.nonce_digest = authority.nonce_digest
          )
          AND tabhub_purge_authorized_v1(
            'research_runs', 'pk:v1|1|' || 'i:' || length(CAST(OLD.id AS TEXT)) || ':' || CAST(OLD.id AS TEXT), authority.nonce_digest
          ) = 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'weakened research run guard');
      END;
      UPDATE privacy_purge_deletion_manifest
      SET predicate_sql = '0'
      WHERE trigger_name = 'research_runs_immutable_delete';`,
    c90_table_column:
      "ALTER TABLE live_acquisition_actions ADD COLUMN raw_secret TEXT;",
    modified_existing_trigger_drop:
      "DROP TRIGGER research_runs_job_ownership_insert;",
    existing_view_drop: "DROP VIEW research_source_heads;",
    new_external_dependency_drop:
      "DROP TRIGGER research_source_payloads_no_late_live_insert;",
  };
  const probeSql = sqlByProbe[probe];
  assertNoMigrationTransactionControl(probeSql);
  connection.exec(probeSql);
}

function assertMigrationTransaction(
  connection: Database.Database,
  phase: string,
): void {
  if (!connection.inTransaction) {
    throw new Error(`Live acquisition migration lost transaction at ${phase}`);
  }
}

function userSchemaObjects(
  connection: Database.Database,
): Map<string, SchemaObjectRow> {
  const rows = connection
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as SchemaObjectRow[];
  return new Map(rows.map((row) => [`${row.type}:${row.name}`, row]));
}

function sourceRows(connection: Database.Database): unknown[] {
  return connection
    .prepare(
      `SELECT ${sourceColumnsV24.join(", ")}
       FROM research_sources ORDER BY id`,
    )
    .all();
}

function schemaSql(connection: Database.Database, table: string): string {
  const sql = connection
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    )
    .pluck()
    .get(table);
  if (typeof sql !== "string") {
    throw new Error(`Missing schema-24 table ${table}`);
  }
  return sql;
}

function namedSchemaObjects(
  connection: Database.Database,
  names: readonly string[],
): Map<string, string> {
  const rows = connection
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE name IN (${names
         .map(() => "?")
         .join(", ")}) ORDER BY name`,
    )
    .all(...names) as Array<{ name: string; sql: string | null }>;
  return new Map(
    rows.map(({ name, sql }) => {
      if (typeof sql !== "string") {
        throw new Error(`Missing sqlite_schema SQL for ${name}`);
      }
      return [name, sql];
    }),
  );
}

function tableOwnedSchemaObjects(
  connection: Database.Database,
  tableNames: readonly string[],
): Map<string, string> {
  const rows = connection
    .prepare(
      `SELECT type || ':' || name AS object_key, sql
       FROM sqlite_schema
       WHERE tbl_name IN (${tableNames.map(() => "?").join(", ")})
         AND sql IS NOT NULL ORDER BY type, name`,
    )
    .all(...tableNames) as Array<{ object_key: string; sql: string }>;
  return new Map(rows.map(({ object_key, sql }) => [object_key, sql]));
}

function externalDependencyNames(connection: Database.Database): string[] {
  return connection
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name <> 'research_sources'
         AND instr(lower(sql), 'research_sources') > 0
       ORDER BY name`,
    )
    .pluck()
    .all() as string[];
}

function blockingDeletionTriggerNames(
  connection: Database.Database,
): string[] {
  const rows = connection
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
  return rows
    .filter(
      ({ name, sql }) =>
        name !== "ai_job_runtime_state_no_delete" &&
        /BEFORE\s+DELETE\s+ON/i.test(sql) &&
        /RAISE\s*\(\s*ABORT/i.test(sql),
    )
    .map(({ name }) => name);
}

function captureSchema24(connection: Database.Database): SchemaSnapshot {
  const rows = sourceRows(connection);
  const blockingDeletionTriggers = blockingDeletionTriggerNames(connection);
  if (
    sqlJsonMirror(blockingDeletionTriggers) !==
    sqlJsonMirror(schema24BlockingDeletionTriggers)
  ) {
    throw new Error(
      `Schema-24 blocking deletion trigger inventory drifted: expected ${schema24BlockingDeletionTriggers.length}, got ${blockingDeletionTriggers.length}`,
    );
  }
  const legacySet = new Set<string>(expectedLegacyDeletionTriggers);
  const legacyDeletionTriggers = blockingDeletionTriggers.filter((name) =>
    legacySet.has(name),
  );
  if (
    legacyDeletionTriggers.length !== 32 ||
    sqlJsonMirror(legacyDeletionTriggers) !==
      sqlJsonMirror(expectedLegacyDeletionTriggers)
  ) {
    throw new Error("Schema-24 purge guard inventory is not the exact legacy 32");
  }
  return {
    sourceCount: rows.length,
    sourceChecksum: sha256(sqlJsonMirror(rows)),
    childSchema: new Map(
      sourceChildTables.map((table) => [table, schemaSql(connection, table)]),
    ),
    childForeignKeys: new Map(
      sourceChildTables.map((table) => [
        table,
        sqlJsonMirror(connection.pragma(`foreign_key_list('${table}')`)),
      ]),
    ),
    protectedObjects: namedSchemaObjects(connection, [
      ...sourceChildTables,
      "research_runs",
      "ai_job_events",
    ]),
    sourceObjects: tableOwnedSchemaObjects(connection, ["research_sources"]),
    externalTriggers: namedSchemaObjects(connection, externalSourceTriggers),
    externalDependencyNames: externalDependencyNames(connection),
    legacyDeletionTriggers,
    blockingDeletionTriggers,
    schemaObjects: userSchemaObjects(connection),
  };
}

function finalizeDeletionManifest(connection: Database.Database): void {
  const rows = connection
    .prepare(
      `SELECT trigger_name FROM privacy_purge_deletion_manifest
       ORDER BY trigger_name`,
    )
    .pluck()
    .all() as string[];
  if (sqlJsonMirror(rows) !== sqlJsonMirror(expectedDeletionManifestTriggers)) {
    throw new Error("Privacy purge deletion manifest is incomplete");
  }
  const update = connection.prepare(
    `UPDATE privacy_purge_deletion_manifest
     SET trigger_sql_digest = ? WHERE trigger_name = ?`,
  );
  for (const triggerName of rows) {
    const sql = connection
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
      )
      .pluck()
      .get(triggerName);
    if (typeof sql !== "string") {
      throw new Error(`Deletion manifest trigger is missing: ${triggerName}`);
    }
    update.run(sha256(sql), triggerName);
  }
  connection.exec(`
    CREATE TRIGGER privacy_purge_deletion_manifest_immutable_update
    BEFORE UPDATE ON privacy_purge_deletion_manifest
    BEGIN
      SELECT RAISE(ABORT, 'privacy purge deletion manifest is frozen');
    END;
    CREATE TRIGGER privacy_purge_deletion_manifest_no_insert
    BEFORE INSERT ON privacy_purge_deletion_manifest
    BEGIN
      SELECT RAISE(ABORT, 'privacy purge deletion manifest is frozen');
    END
  `);
}

function finalizePurgeTargetCatalog(connection: Database.Database): void {
  const rows = connection.prepare(`
    SELECT catalog.table_name, catalog.pk_columns_json,
      catalog.pk_expression_sql, catalog.delete_rank,
      catalog.requires_authority, catalog.guard_trigger_name,
      manifest.table_name AS guarded_table_name,
      manifest.pk_columns_json AS guarded_pk_columns_json,
      manifest.pk_expression_sql AS guarded_pk_expression_sql
    FROM privacy_purge_target_catalog AS catalog
    LEFT JOIN privacy_purge_deletion_manifest AS manifest
      ON manifest.trigger_name = catalog.guard_trigger_name
    ORDER BY catalog.table_name
  `).all() as Array<{
    table_name: string;
    pk_columns_json: string;
    pk_expression_sql: string;
    delete_rank: number;
    requires_authority: number;
    guard_trigger_name: string | null;
    guarded_table_name: string | null;
    guarded_pk_columns_json: string | null;
    guarded_pk_expression_sql: string | null;
  }>;
  const guardedTables = connection.prepare(`
    SELECT table_name FROM privacy_purge_deletion_manifest ORDER BY table_name
  `).pluck().all() as string[];
  const expectedTables = [...new Set([
    ...guardedTables,
    ...expectedOrdinaryPurgeTargetTables,
  ])].sort();
  if (
    guardedTables.length !== expectedDeletionManifestTriggers.length ||
    rows.length !== expectedTables.length ||
    sqlJsonMirror(rows.map(({ table_name }) => table_name)) !==
      sqlJsonMirror(expectedTables)
  ) {
    throw new Error("Privacy purge target catalog is incomplete");
  }
  const byTable = new Map(rows.map((row) => [row.table_name, row]));
  for (const row of rows) {
    const primaryKeyColumns = (
      connection.pragma(`table_info('${row.table_name}')`) as Array<{
        name: string;
        pk: number;
      }>
    ).filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name);
    let declaredPrimaryKey: unknown;
    try {
      declaredPrimaryKey = JSON.parse(row.pk_columns_json);
    } catch {
      throw new Error(`Privacy purge catalog PK JSON is invalid: ${row.table_name}`);
    }
    if (
      sqlJsonMirror(declaredPrimaryKey) !== sqlJsonMirror(primaryKeyColumns) ||
      !row.pk_expression_sql.startsWith(`'pk:v1|${primaryKeyColumns.length}|'`)
    ) {
      throw new Error(`Privacy purge catalog PK drifted: ${row.table_name}`);
    }
    if (row.requires_authority === 1) {
      if (
        row.guard_trigger_name === null ||
        row.guarded_table_name !== row.table_name ||
        row.guarded_pk_columns_json !== row.pk_columns_json ||
        row.guarded_pk_expression_sql !== row.pk_expression_sql
      ) {
        throw new Error(`Privacy purge catalog guard binding drifted: ${row.table_name}`);
      }
    } else if (
      row.guard_trigger_name !== null || row.guarded_table_name !== null ||
      guardedTables.includes(row.table_name)
    ) {
      throw new Error(`Privacy purge catalog ordinary binding drifted: ${row.table_name}`);
    }
    const foreignKeys = connection.pragma(
      `foreign_key_list('${row.table_name}')`,
    ) as Array<{ table: string }>;
    for (const { table } of foreignKeys) {
      const parent = byTable.get(table);
      if (parent === undefined || parent.table_name === row.table_name) continue;
      const runReportCycle =
        (row.table_name === "research_runs" && table === "research_reports") ||
        (row.table_name === "research_reports" && table === "research_runs");
      if (
        row.delete_rank < parent.delete_rank ||
        (row.delete_rank === parent.delete_rank && !runReportCycle)
      ) {
        throw new Error(
          `Privacy purge catalog delete rank is not FK-safe: ${row.table_name}`,
        );
      }
    }
  }
  connection.exec(`
    CREATE TRIGGER privacy_purge_target_catalog_no_insert
    BEFORE INSERT ON privacy_purge_target_catalog
    BEGIN
      SELECT RAISE(ABORT, 'privacy purge target catalog is frozen');
    END;
    CREATE TRIGGER privacy_purge_target_catalog_immutable_update
    BEFORE UPDATE ON privacy_purge_target_catalog
    BEGIN
      SELECT RAISE(ABORT, 'privacy purge target catalog is frozen');
    END;
    CREATE TRIGGER privacy_purge_target_catalog_immutable_delete
    BEFORE DELETE ON privacy_purge_target_catalog
    BEGIN
      SELECT RAISE(ABORT, 'privacy purge target catalog is frozen');
    END
  `);
}

function validateSchema25(
  connection: Database.Database,
  before: SchemaSnapshot,
): void {
  const rows = sourceRows(connection);
  if (rows.length !== before.sourceCount) {
    throw new Error(
      `research_sources row count changed: ${before.sourceCount} -> ${rows.length}`,
    );
  }
  if (sha256(sqlJsonMirror(rows)) !== before.sourceChecksum) {
    throw new Error("research_sources checksum changed during migration");
  }

  for (const table of sourceChildTables) {
    if (schemaSql(connection, table) !== before.childSchema.get(table)) {
      throw new Error(`Child schema changed during migration: ${table}`);
    }
    if (
      sqlJsonMirror(connection.pragma(`foreign_key_list('${table}')`)) !==
      before.childForeignKeys.get(table)
    ) {
      throw new Error(`Child foreign keys changed during migration: ${table}`);
    }
  }

  const expectedExternal = [...externalSourceTriggers].sort();
  if (
    before.legacyDeletionTriggers.length !== 32 ||
    sqlJsonMirror(before.legacyDeletionTriggers) !==
      sqlJsonMirror(expectedLegacyDeletionTriggers)
  ) {
    throw new Error("Schema-24 blocking deletion trigger inventory is not exact");
  }
  if (
    sqlJsonMirror(before.blockingDeletionTriggers) !==
    sqlJsonMirror(schema24BlockingDeletionTriggers)
  ) {
    throw new Error("Schema-24 complete delete-guard inventory is not exact");
  }
  const blockingAfter = blockingDeletionTriggerNames(connection);
  if (
    sqlJsonMirror(blockingAfter) !==
    sqlJsonMirror(schema25BlockingDeletionTriggers)
  ) {
    throw new Error(
      `Schema-25 blocking deletion trigger inventory drifted: expected ${schema25BlockingDeletionTriggers.length}, got ${blockingAfter.length}`,
    );
  }
  if (
    sqlJsonMirror([...before.externalTriggers.keys()]) !==
    sqlJsonMirror(expectedExternal)
  ) {
    throw new Error("Schema-24 research source trigger inventory is incomplete");
  }
  const afterExternal = namedSchemaObjects(connection, externalSourceTriggers);
  if (sqlJsonMirror([...afterExternal.keys()]) !== sqlJsonMirror(expectedExternal)) {
    throw new Error("Schema-25 research source trigger inventory is incomplete");
  }
  if (
    sqlJsonMirror(before.externalDependencyNames) !==
      sqlJsonMirror([...externalSourceTriggers].sort()) ||
    sqlJsonMirror(externalDependencyNames(connection)) !==
      sqlJsonMirror(schema25ExternalSourceDependencies)
  ) {
    throw new Error("External research_sources dependency inventory changed");
  }
  for (const unchanged of [
    "research_report_sources_same_run",
    "research_claim_evidence_same_run",
  ]) {
    if (afterExternal.get(unchanged) !== before.externalTriggers.get(unchanged)) {
      throw new Error(`External research_sources trigger drifted: ${unchanged}`);
    }
  }
  const afterExternalDependencies = namedSchemaObjects(
    connection,
    schema25ExternalSourceDependencies,
  );
  if (
    sqlJsonMirror([...afterExternalDependencies.keys()]) !==
    sqlJsonMirror(schema25ExternalSourceDependencies)
  ) {
    throw new Error("Schema-25 external dependency inventory drifted");
  }
  const externalFingerprintDrift = [...schema25ExternalSourceTriggerFingerprints]
    .map(([name, expected]) => ({
      name,
      actual: sha256(afterExternalDependencies.get(name) ?? ""),
      expected,
    }))
    .filter(({ actual, expected }) => actual !== expected);
  if (externalFingerprintDrift.length !== 0) {
    throw new Error(
      `External research_sources trigger fingerprint drifted: ${sqlJsonMirror(externalFingerprintDrift)}`,
    );
  }

  const protectedAfter = namedSchemaObjects(connection, [
    ...sourceChildTables,
    "research_runs",
    "ai_job_events",
  ]);
  const unchangedProtectedBefore = [...before.protectedObjects]
    .filter(([name]) => name !== "research_runs");
  const unchangedProtectedAfter = [...protectedAfter]
    .filter(([name]) => name !== "research_runs");
  if (sqlJsonMirror(unchangedProtectedAfter) !== sqlJsonMirror(unchangedProtectedBefore)) {
    throw new Error("Protected child/job/run schema fingerprint changed");
  }
  const runColumns = connection.pragma("table_info('research_runs')") as Array<{
    name: string;
  }>;
  const runForeignKeys = connection.pragma("foreign_key_list('research_runs')") as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>;
  if (
    !runColumns.some(({ name }) => name === "history_epoch_id") ||
    !runForeignKeys.some((foreignKey) =>
      foreignKey.from === "history_epoch_id" &&
      foreignKey.table === "research_history_epochs" &&
      foreignKey.to === "id" && foreignKey.on_delete === "RESTRICT"
    ) ||
    Number(connection.prepare(`
      SELECT COUNT(*)
      FROM research_runs AS run
      LEFT JOIN research_history_epochs AS history
        ON history.id = run.history_epoch_id
      LEFT JOIN privacy_subject_generations AS resource_generation
        ON resource_generation.id = history.resource_generation_id
      WHERE (run.target_resource_id IS NULL) <> (run.history_epoch_id IS NULL)
        OR (run.target_resource_id IS NOT NULL AND (
          history.id IS NULL OR history.resource_id <> run.target_resource_id
          OR history.is_active <> 1
          OR resource_generation.subject_kind <> 'resource'
          OR resource_generation.resource_id <> run.target_resource_id
          OR resource_generation.is_active <> 1
        ))
    `).pluck().get()) !== 0
  ) {
    throw new Error("Research-run history epoch membership is incomplete");
  }

  const expectedSourceV24 = [
    "index:research_sources_exact_identity_idx",
    "index:research_sources_run_state_idx",
    "table:research_sources",
    "trigger:research_sources_immutable_delete",
    "trigger:research_sources_immutable_update",
    "trigger:research_sources_live_capture_insert_guard",
  ];
  if (
    sqlJsonMirror([...before.sourceObjects.keys()]) !==
    sqlJsonMirror(expectedSourceV24)
  ) {
    throw new Error("Schema-24 research_sources object inventory drifted");
  }

  const columns = (connection
    .pragma("table_info('research_sources')") as Array<{ name: string }>)
    .map((row) => (row as { name: string }).name);
  for (const required of ["source_kind", "handoff_source_receipt_id"]) {
    if (!columns.includes(required)) {
      throw new Error(`Schema-25 research_sources is missing ${required}`);
    }
  }
  const researchSourcesTableFingerprint = sha256(
    schemaSql(connection, "research_sources"),
  );
  if (
    researchSourcesTableFingerprint !== schema25ResearchSourcesTableFingerprint
  ) {
    throw new Error(
      `Schema-25 research_sources table fingerprint drifted: ${researchSourcesTableFingerprint}`,
    );
  }

  const sourceObjectRows = connection
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE tbl_name = 'research_sources' AND type IN ('index', 'trigger')
         AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
  if (
    sqlJsonMirror(sourceObjectRows.map(({ name }) => name)) !==
    sqlJsonMirror([...schema25SourceObjectFingerprints.keys()])
  ) {
    throw new Error("Schema-25 research_sources object inventory drifted");
  }
  for (const { name, sql } of sourceObjectRows) {
    if (sha256(sql) !== schema25SourceObjectFingerprints.get(name)) {
      throw new Error(`Schema-25 research_sources fingerprint drifted: ${name}`);
    }
  }

  const manifestRows = connection
    .prepare(
      `SELECT manifest.trigger_name, manifest.table_name,
        manifest.pk_columns_json, manifest.pk_expression_sql,
        manifest.predicate_sql, manifest.trigger_sql_digest,
        schema.tbl_name, schema.sql
       FROM privacy_purge_deletion_manifest AS manifest
       LEFT JOIN sqlite_schema AS schema
         ON schema.type = 'trigger' AND schema.name = manifest.trigger_name
       ORDER BY manifest.trigger_name`,
    )
    .all() as Array<{
      trigger_name: string;
      table_name: string;
      pk_columns_json: string;
      pk_expression_sql: string;
      predicate_sql: string;
      trigger_sql_digest: string;
      tbl_name: string | null;
      sql: string | null;
    }>;
  if (
    sqlJsonMirror(manifestRows.map(({ trigger_name }) => trigger_name)) !==
    sqlJsonMirror(expectedDeletionManifestTriggers)
  ) {
    throw new Error("Deletion manifest exact inventory mismatch");
  }
  const manifestFingerprint = sha256(
    sqlJsonMirror(
      manifestRows.map(
        ({
          trigger_name,
          table_name,
          pk_columns_json,
          pk_expression_sql,
          predicate_sql,
          trigger_sql_digest,
        }) => ({
          trigger_name,
          table_name,
          pk_columns_json,
          pk_expression_sql,
          predicate_sql,
          trigger_sql_digest,
        }),
      ),
    ),
  );
  if (manifestFingerprint !== schema25DeletionManifestFingerprint) {
    throw new Error(
      `Deletion manifest aggregate fingerprint drifted: ${manifestFingerprint}`,
    );
  }
  for (const row of manifestRows) {
    const primaryKeyColumns = (
      connection.pragma(`table_info('${row.table_name}')`) as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name);
    let declaredPrimaryKey: unknown;
    try {
      declaredPrimaryKey = JSON.parse(row.pk_columns_json);
    } catch {
      throw new Error(`Deletion manifest PK JSON is invalid: ${row.trigger_name}`);
    }
    const normalizeSql = (sql: string): string =>
      sql.replace(/\s+/g, " ").trim();
    const triggerSql = typeof row.sql === "string" ? normalizeSql(row.sql) : "";
    const pkExpression = normalizeSql(row.pk_expression_sql);
    const predicate = normalizeSql(row.predicate_sql);
    const pkExpressionUses = triggerSql.split(pkExpression).length - 1;
    if (
      typeof row.sql !== "string" ||
      sha256(row.sql) !== row.trigger_sql_digest ||
      row.tbl_name !== row.table_name ||
      !triggerSql.includes(`BEFORE DELETE ON ${row.table_name}`) ||
      sqlJsonMirror(declaredPrimaryKey) !== sqlJsonMirror(primaryKeyColumns) ||
      !triggerSql.includes(`WHEN (${predicate}) AND NOT EXISTS (`) ||
      pkExpressionUses < 2 ||
      !triggerSql.includes(`authority.table_name = '${row.table_name}'`) ||
      !triggerSql.includes(
        "FROM privacy_purge_transaction_fences AS fence",
      ) ||
      !triggerSql.includes(
        "WHERE fence.nonce_digest = authority.nonce_digest",
      ) ||
      !triggerSql.includes("tabhub_purge_authorized_v1(")
    ) {
      throw new Error(`Deletion manifest fingerprint mismatch: ${row.trigger_name}`);
    }
  }
  const purgeTargetCatalogRows = connection.prepare(`
    SELECT table_name, pk_columns_json, pk_expression_sql, delete_rank,
      requires_authority, guard_trigger_name
    FROM privacy_purge_target_catalog ORDER BY table_name
  `).all();
  const purgeTargetCatalogFingerprint = sha256(
    sqlJsonMirror(purgeTargetCatalogRows),
  );
  if (purgeTargetCatalogFingerprint !== schema25PurgeTargetCatalogFingerprint) {
    throw new Error(
      `Privacy purge target catalog aggregate fingerprint drifted: ${purgeTargetCatalogFingerprint}`,
    );
  }
  const schemaAfter = userSchemaObjects(connection);
  const schemaMutations: Array<
    | { readonly state: "created_or_changed"; readonly object: SchemaObjectRow }
    | { readonly state: "dropped"; readonly object: SchemaObjectRow }
  > = [];
  for (const [key, object] of schemaAfter) {
    const prior = before.schemaObjects.get(key);
    if (prior === undefined || sqlJsonMirror(prior) !== sqlJsonMirror(object)) {
      schemaMutations.push({ state: "created_or_changed", object });
    }
  }
  for (const [key, object] of before.schemaObjects) {
    if (!schemaAfter.has(key)) {
      schemaMutations.push({ state: "dropped", object });
    }
  }
  schemaMutations.sort((left, right) => {
    const leftKey = `${left.state}:${left.object.type}:${left.object.name}`;
    const rightKey = `${right.state}:${right.object.type}:${right.object.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const schemaMutationFingerprint = sha256(sqlJsonMirror(schemaMutations));
  if (schemaMutationFingerprint !== schema25OwnedSchemaMutationFingerprint) {
    throw new Error(
      `Schema-25 owned schema aggregate fingerprint drifted: ${schemaMutationFingerprint}`,
    );
  }
}

/**
 * Migration 025 is the sole migration that rebuilds a referenced parent table.
 * It therefore owns its transaction and FK pragma instead of using the generic
 * migration transaction wrapper.
 */
export function runLiveAcquisitionMigration(
  connection: Database.Database,
  migrationSql: string,
  options: LiveAcquisitionMigrationOptions = {},
): void {
  if (connection.inTransaction) {
    throw new Error("Live acquisition migration requires autocommit mode");
  }
  const migrationFingerprint = sha256(migrationSql);
  if (migrationFingerprint !== approvedMigration025Sha256) {
    throw new Error(
      `Live acquisition migration fingerprint mismatch: ${migrationFingerprint}`,
    );
  }
  assertNoMigrationTransactionControl(migrationSql);
  if (pragmaNumber(connection, "user_version") !== 24) {
    throw new Error("Live acquisition migration requires schema version 24");
  }
  const corruptSource = connection.prepare(
    `SELECT id FROM research_sources WHERE
       typeof(id) <> 'integer' OR typeof(run_id) <> 'integer'
       OR typeof(ordinal) <> 'integer' OR typeof(logical_page_id) <> 'integer'
       OR (tab_id IS NOT NULL AND typeof(tab_id) <> 'integer')
       OR (captured_tab_id_snapshot IS NOT NULL
         AND typeof(captured_tab_id_snapshot) <> 'integer')
       OR (content_revision IS NOT NULL AND typeof(content_revision) <> 'integer')
       OR (content_digest IS NOT NULL AND typeof(content_digest) <> 'text')
       OR (extracted_at IS NOT NULL AND typeof(extracted_at) <> 'text')
       OR typeof(acquisition_method) <> 'text'
       OR typeof(access_class_snapshot) <> 'text'
       OR typeof(eligibility) <> 'text' OR typeof(inclusion_state) <> 'text'
       OR (exclusion_reason IS NOT NULL AND typeof(exclusion_reason) <> 'text')
       OR (included_order IS NOT NULL AND typeof(included_order) <> 'integer')
       OR (failure_code IS NOT NULL AND typeof(failure_code) <> 'text')
       OR typeof(created_at) <> 'text'
     ORDER BY id LIMIT 1`,
  ).pluck().get();
  if (corruptSource !== undefined) {
    throw new Error(
      `Schema-24 research_sources storage-class corruption at id ${String(corruptSource)}`,
    );
  }

  let failure: unknown;
  try {
    connection.pragma("foreign_keys = OFF");
    if (pragmaNumber(connection, "foreign_keys") !== 0) {
      throw new Error("Live acquisition migration could not disable foreign keys");
    }

    connection.exec("BEGIN IMMEDIATE");
    assertMigrationTransaction(connection, "begin");
    if (pragmaNumber(connection, "foreign_keys") !== 0) {
      throw new Error("Live acquisition migration changed foreign key mode");
    }
    if (pragmaNumber(connection, "user_version") !== 24) {
      throw new Error("Live acquisition migration requires schema version 24");
    }
    injectFailure(options, "after_begin");

    const before = captureSchema24(connection);
    assertMigrationTransaction(connection, "schema-24 capture");

    connection.exec(migrationSql);
    assertMigrationTransaction(connection, "migration SQL");
    runTestOnlyValidationProbe(
      connection,
      options.testOnlyValidationProbe,
    );
    assertMigrationTransaction(connection, "validation probe");
    injectFailure(options, "after_sql");

    const copiedSources = sourceRows(connection);
    if (copiedSources.length !== before.sourceCount) {
      throw new Error(
        `research_sources row count changed: ${before.sourceCount} -> ${copiedSources.length}`,
      );
    }
    if (sha256(sqlJsonMirror(copiedSources)) !== before.sourceChecksum) {
      throw new Error("research_sources checksum changed during migration");
    }
    finalizeDeletionManifest(connection);
    assertMigrationTransaction(connection, "deletion manifest finalization");
    finalizePurgeTargetCatalog(connection);
    assertMigrationTransaction(connection, "purge target catalog finalization");
    validateSchema25(connection, before);
    assertMigrationTransaction(connection, "schema-25 validation");

    const foreignKeyViolations = connection.pragma(
      "foreign_key_check",
    ) as unknown[];
    if (foreignKeyViolations.length !== 0) {
      throw new Error("Live acquisition migration failed foreign_key_check");
    }
    if (connection.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Live acquisition migration failed integrity_check");
    }

    assertMigrationTransaction(connection, "pre-version validation");
    connection.pragma("user_version = 25");
    assertMigrationTransaction(connection, "schema version update");
    injectFailure(options, "before_commit");
    assertMigrationTransaction(connection, "commit boundary");
    connection.exec("COMMIT");
  } catch (error) {
    failure = error;
    if (connection.inTransaction) {
      connection.exec("ROLLBACK");
    }
  } finally {
    connection.pragma("foreign_keys = ON");
    if (pragmaNumber(connection, "foreign_keys") !== 1) {
      const restoreError = new Error(
        "Live acquisition migration could not restore foreign keys",
      );
      if (failure === undefined) {
        failure = restoreError;
      } else {
        failure = new AggregateError([failure, restoreError]);
      }
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
}
