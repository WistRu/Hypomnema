import { createHash } from "node:crypto";

import {
  privacyPurgeStartBodySchema,
  type PrivacyPurgePublicTarget,
  type PrivacyPurgeStartBody,
  type PrivacyPurgeStatusResponse,
} from "@tabhub/shared";
import type Database from "better-sqlite3";

import {
  createPrivacyPurgeIntentStore,
  type PrivacyPurgeIntentStore,
  type PrivacyPurgeIntentStoreOptions,
  type PrivacyPurgeReadyCommandIdentity,
} from "./privacy-purge-intent-capabilities.js";
import type { PrivacyPurgeIntentTarget } from "./privacy-purge-fence-spec.js";
import {
  createPrivacyPurgeStatusReader,
  type PrivacyPurgeStatusReader,
} from "./privacy-purge-status-reader.js";

export const PRIVACY_PURGE_ACTION_BATCH = 256;
export const PRIVACY_PURGE_JOB_BATCH = 100;
export const PRIVACY_PURGE_RESOURCE_JOB_BATCH = 256;

export type PrivacyPurgeCoordinatorErrorCode =
  | "PURGE_INVALID_REQUEST"
  | "PURGE_NOT_FOUND"
  | "PURGE_TARGET_NOT_FOUND"
  | "PURGE_IDEMPOTENCY_CONFLICT"
  | "PURGE_SUBJECT_BUSY"
  | "PURGE_RETRY_NOT_ALLOWED"
  | "PURGE_NEW_START_DISABLED"
  | "PURGE_UNAVAILABLE";

export class PrivacyPurgeCoordinatorError extends Error {
  readonly httpStatus: 400 | 404 | 409 | 503;
  constructor(readonly code: PrivacyPurgeCoordinatorErrorCode) {
    super(code);
    this.name = "PrivacyPurgeCoordinatorError";
    this.httpStatus = code === "PURGE_NOT_FOUND" || code === "PURGE_TARGET_NOT_FOUND"
      ? 404 : code === "PURGE_IDEMPOTENCY_CONFLICT" || code === "PURGE_SUBJECT_BUSY" ||
        code === "PURGE_RETRY_NOT_ALLOWED" || code === "PURGE_NEW_START_DISABLED"
      ? 409 : code === "PURGE_UNAVAILABLE" ? 503 : 400;
  }
}

interface ExistingIntent {
  readonly intentKey: string;
  readonly target: PrivacyPurgePublicTarget;
}

interface StoredIntentIdentity extends PrivacyPurgeReadyCommandIdentity {
  readonly commandId: number | null;
}

export interface PrivacyPurgeCoordinatorDependencies {
  readonly store: Pick<PrivacyPurgeIntentStore,
    "publishWaiting" | "reconcileActionWaits" | "abortStartedActionWait" |
    "terminalizeResourceResearchJobWaits" | "terminalizeJobWaits" |
    "reconcileJobWaits" | "reconcileWaiting" | "repairFinalSettlements" |
    "freezeReady" | "linkReadyCommand" | "executeCommitted">;
  readonly statusReader: PrivacyPurgeStatusReader;
  readonly findByIdempotencyHash: (hash: string) => ExistingIntent | null;
  readonly resolveTarget: (target: PrivacyPurgePublicTarget) => PrivacyPurgeIntentTarget | null;
  readonly readIdentity: (intentKey: string) => StoredIntentIdentity | null;
  readonly readNextWakeAt: (intentKey: string) => string | null;
}

export interface PrivacyPurgeDriveResult {
  readonly status: PrivacyPurgeStatusResponse;
  readonly progressed: boolean;
  readonly nextWakeAt?: string;
}

export interface PrivacyPurgeCoordinator {
  start(request: PrivacyPurgeStartBody,
    options?: { readonly allowCreate?: boolean }): Promise<PrivacyPurgeStatusResponse>;
  read(purgeId: string): PrivacyPurgeStatusResponse | null;
  retry(purgeId: string): Promise<PrivacyPurgeStatusResponse>;
  driveOnce(purgeId: string): Promise<PrivacyPurgeDriveResult>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function idempotencyHash(key: string): string {
  return sha256(`tabhub:privacy-purge:idempotency:v1\0${key}`);
}

function targetFingerprint(target: PrivacyPurgePublicTarget): string {
  const value = target.kind === "logical_page" ? `logical_page\0${target.logicalPageId}`
    : target.kind === "run" ? `run\0${target.researchRunId}`
    : `resource_history\0${target.resourceId}`;
  return sha256(`tabhub:privacy-purge:request:v1\0${value}`);
}

function intentKey(hash: string, fingerprint: string): string {
  return sha256(`tabhub:privacy-purge:intent:v1\0${hash}\0${fingerprint}`);
}

function sameTarget(left: PrivacyPurgePublicTarget, right: PrivacyPurgePublicTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "logical_page" && right.kind === "logical_page") {
    return left.logicalPageId === right.logicalPageId;
  }
  if (left.kind === "run" && right.kind === "run") {
    return left.researchRunId === right.researchRunId;
  }
  return left.kind === "resource_history" && right.kind === "resource_history" &&
    left.resourceId === right.resourceId;
}

function keyOf(purgeId: string): string {
  const match = /^purge_([0-9a-f]{64})$/.exec(purgeId);
  if (!match) throw new PrivacyPurgeCoordinatorError("PURGE_NOT_FOUND");
  return match[1]!;
}

function safeStatus(reader: PrivacyPurgeStatusReader, purgeId: string): PrivacyPurgeStatusResponse {
  try {
    const status = reader.read(purgeId);
    if (status === null) throw new PrivacyPurgeCoordinatorError("PURGE_NOT_FOUND");
    return status;
  } catch (error) {
    if (error instanceof PrivacyPurgeCoordinatorError) throw error;
    throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE");
  }
}

function changed(before: PrivacyPurgeStatusResponse, after: PrivacyPurgeStatusResponse): boolean {
  return before.state !== after.state ||
    before.progress.completedSteps !== after.progress.completedSteps ||
    before.progress.totalSteps !== after.progress.totalSteps;
}

export function createPrivacyPurgeCoordinatorFromDependencies(
  dependencies: PrivacyPurgeCoordinatorDependencies,
): PrivacyPurgeCoordinator {
  const inFlight = new Map<string, Promise<unknown>>();
  const singleFlight = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;
    const promise = operation().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  const read = (purgeId: string) => {
    try { return dependencies.statusReader.read(purgeId); }
    catch { throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE"); }
  };

  const start = async (raw: PrivacyPurgeStartBody,
    startOptions: { readonly allowCreate?: boolean } = {}): Promise<PrivacyPurgeStatusResponse> => {
    const parsed = privacyPurgeStartBodySchema.safeParse(raw);
    if (!parsed.success) throw new PrivacyPurgeCoordinatorError("PURGE_INVALID_REQUEST");
    const request = parsed.data;
    const hash = idempotencyHash(request.idempotencyKey);
    const fingerprint = targetFingerprint(request.target);
    const key = intentKey(hash, fingerprint);
    return singleFlight(`purge_${key}`, async () => {
      let existing: ExistingIntent | null;
      try { existing = dependencies.findByIdempotencyHash(hash); }
      catch { throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE"); }
      if (existing !== null) {
        if (!sameTarget(existing.target, request.target)) {
          throw new PrivacyPurgeCoordinatorError("PURGE_IDEMPOTENCY_CONFLICT");
        }
        return safeStatus(dependencies.statusReader, `purge_${existing.intentKey}`);
      }
      if (startOptions.allowCreate === false) {
        throw new PrivacyPurgeCoordinatorError("PURGE_NEW_START_DISABLED");
      }
      let target: PrivacyPurgeIntentTarget | null;
      try { target = dependencies.resolveTarget(request.target); }
      catch { throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE"); }
      if (target === null) throw new PrivacyPurgeCoordinatorError("PURGE_TARGET_NOT_FOUND");
      try {
        dependencies.store.publishWaiting({
          intentKey: key, idempotencyKeyHash: hash,
          requestFingerprint: fingerprint, target,
        });
      } catch (error) {
        let replay: ExistingIntent | null;
        try { replay = dependencies.findByIdempotencyHash(hash); }
        catch { throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE"); }
        if (replay !== null) {
          if (!sameTarget(replay.target, request.target)) {
            throw new PrivacyPurgeCoordinatorError("PURGE_IDEMPOTENCY_CONFLICT");
          }
          return safeStatus(dependencies.statusReader, `purge_${replay.intentKey}`);
        }
        const message = error instanceof Error ? error.message : "";
        if (message.includes("PURGE_SUBJECT_BUSY") ||
            message.includes("privacy_purge_intents_one_active") ||
            message.includes("one active")) {
          throw new PrivacyPurgeCoordinatorError("PURGE_SUBJECT_BUSY");
        }
        throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE");
      }
      return safeStatus(dependencies.statusReader, `purge_${key}`);
    });
  };

  const retry = (purgeId: string): Promise<PrivacyPurgeStatusResponse> => {
    const key = keyOf(purgeId);
    return singleFlight(purgeId, async () => {
      const before = safeStatus(dependencies.statusReader, purgeId);
      if (before.state !== "failed_hold" ||
          before.holdReason !== "awaiting_provider_settlement") {
        throw new PrivacyPurgeCoordinatorError("PURGE_RETRY_NOT_ALLOWED");
      }
      try {
        await dependencies.store.repairFinalSettlements(key, { maxJobs: PRIVACY_PURGE_JOB_BATCH });
      } catch {
        throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE");
      }
      return safeStatus(dependencies.statusReader, purgeId);
    });
  };

  const driveOnce = (purgeId: string): Promise<PrivacyPurgeDriveResult> => {
    const key = keyOf(purgeId);
    return singleFlight(purgeId, async () => {
      const initial = safeStatus(dependencies.statusReader, purgeId);
      let current = initial;
      const reread = () => (current = safeStatus(dependencies.statusReader, purgeId));
      const finish = (): PrivacyPurgeDriveResult => {
        let nextWakeAt: string | undefined;
        try {
          nextWakeAt = current.state === "waiting"
            ? dependencies.readNextWakeAt(key) ?? undefined : undefined;
        } catch {
          throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE");
        }
        return { status: current, progressed: changed(initial, current),
          ...(nextWakeAt === undefined ? {} : { nextWakeAt }) };
      };
      try {
        if (initial.state === "waiting") {
          const actions = dependencies.store.reconcileActionWaits(
            key, { maxActions: PRIVACY_PURGE_ACTION_BATCH },
          );
          reread();
          if (actions.remaining > 0 || current.state !== "waiting") return finish();
          if (current.state === "waiting") {
            const started = await dependencies.store.abortStartedActionWait(
              key, { maxActions: PRIVACY_PURGE_ACTION_BATCH },
            );
            reread();
            if (started.remaining > 0 || current.state !== "waiting") return finish();
          }
          if (current.state === "waiting") {
            const resourceJobs = dependencies.store.terminalizeResourceResearchJobWaits(key,
              { maxJobs: PRIVACY_PURGE_RESOURCE_JOB_BATCH });
            reread();
            if (resourceJobs.remaining > 0 || current.state !== "waiting") return finish();
          }
          if (current.state === "waiting") {
            const jobs = dependencies.store.terminalizeJobWaits(
              key, { maxJobs: PRIVACY_PURGE_JOB_BATCH },
            );
            reread();
            if (jobs.remaining > 0 || current.state !== "waiting") return finish();
          }
          if (current.state === "waiting") {
            const adoption = dependencies.store.reconcileJobWaits(
              key, { maxJobs: PRIVACY_PURGE_JOB_BATCH },
            );
            reread();
            if (adoption.remaining > 0 || current.state !== "waiting") return finish();
          }
          if (current.state === "waiting") {
            dependencies.store.reconcileWaiting(key, { maxJobs: PRIVACY_PURGE_JOB_BATCH });
            reread();
          }
          if (current.state === "waiting" &&
              current.progress.completedSteps === current.progress.totalSteps - 2) {
            dependencies.store.freezeReady(key);
            reread();
          }
        } else if (initial.state === "ready") {
          const identity = dependencies.readIdentity(key);
          if (identity === null) throw new Error("missing identity");
          dependencies.store.linkReadyCommand({
            idempotencyKeyHash: identity.idempotencyKeyHash,
            requestFingerprint: identity.requestFingerprint,
            targetKind: identity.targetKind,
            subjectGenerationId: identity.subjectGenerationId,
            historyEpochId: identity.historyEpochId,
          });
          reread();
        } else if (initial.state === "committed") {
          const identity = dependencies.readIdentity(key);
          if (identity?.commandId === null || identity === null) throw new Error("missing command");
          dependencies.store.executeCommitted(identity.commandId);
          reread();
        }
      } catch (error) {
        if (error instanceof PrivacyPurgeCoordinatorError) throw error;
        throw new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE");
      }
      return finish();
    });
  };

  return Object.freeze({ start, read, retry, driveOnce });
}

export function readPrivacyPurgeNextWakeAt(
  connection: Database.Database,
  key: string,
): string | null {
  const row = connection.prepare(`
    SELECT MIN(at) AS at FROM (
      SELECT resolution_deadline_at AS at
      FROM privacy_purge_intent_action_waits
      WHERE intent_key = ? AND terminal_state IS NULL
        AND state = 'resolution_started' AND resolution_deadline_at IS NOT NULL
      UNION ALL
      SELECT CASE WHEN request_bound = 1 THEN settlement_deadline_at
        ELSE lease_expires_at END
      FROM privacy_purge_intent_job_waits
      WHERE intent_key = ? AND terminal_status IS NULL
        AND CASE WHEN request_bound = 1 THEN settlement_deadline_at
          ELSE lease_expires_at END IS NOT NULL
    )
  `).get(key, key) as { at: string | null };
  return row.at;
}

export function createPrivacyPurgeCoordinatorDependencies(
  connection: Database.Database,
  options: PrivacyPurgeIntentStoreOptions,
): PrivacyPurgeCoordinatorDependencies {
  const durableStore = createPrivacyPurgeIntentStore(connection, options);
  const store: PrivacyPurgeCoordinatorDependencies["store"] = {
    ...durableStore,
    reconcileActionWaits(key, input) {
      const result = durableStore.reconcileActionWaits(key, input);
      const remaining = Number(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_action_waits AS wait
        JOIN live_acquisition_actions AS action ON action.id = wait.action_id
        WHERE wait.intent_key = ? AND wait.terminal_state IS NULL
          AND action.state <> 'started'
      `).pluck().get(key));
      return { ...result, remaining };
    },
  };
  const statusReader = createPrivacyPurgeStatusReader(connection);
  return {
    store, statusReader,
    findByIdempotencyHash(hash) {
      const row = connection.prepare(`
        SELECT intent_key FROM privacy_purge_intents WHERE idempotency_key_hash = ?
      `).get(hash) as { intent_key: string } | undefined;
      if (row === undefined) return null;
      const status = statusReader.read(`purge_${row.intent_key}`);
      if (status === null) throw new Error("inconsistent replay");
      return { intentKey: row.intent_key, target: status.target };
    },
    resolveTarget(target) {
      if (target.kind === "resource_history") {
        const row = connection.prepare(`
          SELECT id FROM research_history_epochs WHERE resource_id = ? AND is_active = 1
        `).get(target.resourceId) as { id: number } | undefined;
        return row === undefined ? null : { kind: "resource_history", historyEpochId: row.id };
      }
      const column = target.kind === "logical_page" ? "logical_page_id" : "research_run_id";
      const kind = target.kind === "logical_page" ? "logical_page" : "research_run";
      const id = target.kind === "logical_page" ? target.logicalPageId : target.researchRunId;
      const row = connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = ? AND ${column} = ? AND is_active = 1
      `).get(kind, id) as { id: number } | undefined;
      return row === undefined ? null : { kind: target.kind, subjectGenerationId: row.id };
    },
    readIdentity(key) {
      const row = connection.prepare(`
        SELECT idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, purge_command_id
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(key) as {
        idempotency_key_hash: string; request_fingerprint: string;
        target_kind: PrivacyPurgeReadyCommandIdentity["targetKind"];
        subject_generation_id: number | null; history_epoch_id: number | null;
        purge_command_id: number | null;
      } | undefined;
      return row === undefined ? null : {
        idempotencyKeyHash: row.idempotency_key_hash,
        requestFingerprint: row.request_fingerprint,
        targetKind: row.target_kind,
        subjectGenerationId: row.subject_generation_id,
        historyEpochId: row.history_epoch_id,
        commandId: row.purge_command_id,
      };
    },
    readNextWakeAt(key) {
      return readPrivacyPurgeNextWakeAt(connection, key);
    },
  };
}

export function createPrivacyPurgeCoordinator(
  connection: Database.Database,
  options: PrivacyPurgeIntentStoreOptions = {},
): PrivacyPurgeCoordinator {
  return createPrivacyPurgeCoordinatorFromDependencies(
    createPrivacyPurgeCoordinatorDependencies(connection, options),
  );
}
