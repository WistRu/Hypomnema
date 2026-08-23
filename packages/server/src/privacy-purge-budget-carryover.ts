import { createHash } from "node:crypto";

import { sqlJsonObjectMirrorV1 as sqlJsonMirror } from "@tabhub/shared";

import type Database from "better-sqlite3";

const C90_WORKFLOW_ID = "research_acquisition:c90:v1";
const C90_WORKFLOW_VERSION = 1;

interface CoordinatorStartDay {
  readonly utc_date: string;
  readonly coordinator_starts: number;
}

interface ProviderAttemptRow {
  readonly id: number;
  readonly utc_date: string;
  readonly job_kind: "resource_research";
  readonly workflow_id: string;
  readonly workflow_version: number;
  readonly cost_usd: number;
  readonly authoritative_cost_nanos: number | null;
}

interface ProviderDay {
  readonly utcDate: string;
  readonly jobKind: "resource_research";
  readonly workflowId: string;
  readonly workflowVersion: number;
  providerAttempts: number;
  chargedCostNanos: number;
}

export interface PrivacyPurgeBudgetCarryoverRow {
  readonly intentKey: string;
  readonly utcDate: string;
  readonly budgetClass: "c90_coordinator" | "provider";
  readonly jobKind: "resource_research";
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly coordinatorStarts: number;
  readonly providerAttempts: number;
  readonly chargedCostNanos: number;
  readonly activeExposureNanos: number;
  readonly legacy25DayBlock: 0;
  readonly state: "frozen";
  readonly payloadDigest: string;
  readonly frozenAt: string;
  readonly activatedAt: null;
}

/**
 * Exported so its bytes can be pinned by test: they are persisted, and the
 * value ends up inside the carryover manifest that SQL rebuilds with
 * `json_object`, so key insertion order is part of this digest's contract even
 * though nothing in SQL recomputes the digest itself.
 *
 * That is why the SQL byte mirror is the right helper and `canonicalJsonV1` is
 * not: canonicalization sorts keys, which would put `activeExposureNanos`
 * first and invalidate every stored digest. The mirror keeps the order and
 * still refuses the values a raw `JSON.stringify` would silently drop.
 */
export function privacyPurgeBudgetCarryoverPayloadDigest(
  value: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update("tabhub:privacy-purge-budget-carryover:v1\0", "utf8")
    .update(sqlJsonMirror(value), "utf8")
    .digest("hex");
}

export function derivePrivacyPurgeBudgetCarryoverRows(
  connection: Database.Database,
  intentKey: string,
  frozenAt: string,
): readonly PrivacyPurgeBudgetCarryoverRow[] {
  if (!connection.inTransaction) {
    throw new Error("Privacy purge budget carryover derivation requires a transaction");
  }
  const coordinatorDays = connection.prepare(`
    WITH owned_jobs AS (
      SELECT DISTINCT target.ai_job_id
      FROM privacy_purge_intent_run_targets AS target
      WHERE target.intent_key = @intentKey
    )
    SELECT substr(attempt.started_at, 1, 10) AS utc_date,
      COUNT(attempt.id) AS coordinator_starts
    FROM owned_jobs
    JOIN ai_jobs AS job ON job.id = owned_jobs.ai_job_id
    JOIN ai_job_attempts AS attempt ON attempt.job_id = job.id
    WHERE job.kind = 'resource_research'
      AND job.workflow_id = @workflowId
      AND job.workflow_version = @workflowVersion
    GROUP BY substr(attempt.started_at, 1, 10)
    ORDER BY utc_date
  `).all({
    intentKey,
    workflowId: C90_WORKFLOW_ID,
    workflowVersion: C90_WORKFLOW_VERSION,
  }) as CoordinatorStartDay[];
  const derived: PrivacyPurgeBudgetCarryoverRow[] = [];
  for (const row of coordinatorDays) {
    const payload = {
      version: "privacy_purge_budget_carryover:v1",
      intentKey,
      utcDate: row.utc_date,
      budgetClass: "c90_coordinator",
      jobKind: "resource_research",
      workflowId: C90_WORKFLOW_ID,
      workflowVersion: C90_WORKFLOW_VERSION,
      coordinatorStarts: row.coordinator_starts,
      providerAttempts: 0,
      chargedCostNanos: 0,
      activeExposureNanos: 0,
      legacy25DayBlock: 0,
      state: "frozen",
      frozenAt,
      activatedAt: null,
    } as const;
    derived.push({
      intentKey,
      utcDate: row.utc_date,
      budgetClass: "c90_coordinator",
      jobKind: "resource_research",
      workflowId: C90_WORKFLOW_ID,
      workflowVersion: C90_WORKFLOW_VERSION,
      coordinatorStarts: row.coordinator_starts,
      providerAttempts: 0,
      chargedCostNanos: 0,
      activeExposureNanos: 0,
      legacy25DayBlock: 0,
      state: "frozen",
      payloadDigest: privacyPurgeBudgetCarryoverPayloadDigest(payload),
      frozenAt,
      activatedAt: null,
    });
  }

  const unresolvedReservation = connection.prepare(`
    WITH owned_jobs AS (
      SELECT DISTINCT target.ai_job_id
      FROM privacy_purge_intent_run_targets AS target
      WHERE target.intent_key = @intentKey
    )
    SELECT 1
    FROM owned_jobs
    JOIN ai_jobs AS job ON job.id = owned_jobs.ai_job_id
    JOIN live_acquisition_provider_reservations AS reservation
      ON reservation.final_job_id = job.id
    WHERE job.kind = 'resource_research'
      AND NOT (job.workflow_id = @workflowId
        AND job.workflow_version = @workflowVersion)
      AND job.status NOT IN ('queued', 'running')
      AND reservation.status = 'active'
    LIMIT 1
  `).get({
    intentKey,
    workflowId: C90_WORKFLOW_ID,
    workflowVersion: C90_WORKFLOW_VERSION,
  });
  if (unresolvedReservation !== undefined) {
    throw new Error("Privacy purge provider reservation remains active");
  }

  const providerAttempts = connection.prepare(`
    WITH owned_jobs AS (
      SELECT DISTINCT target.ai_job_id
      FROM privacy_purge_intent_run_targets AS target
      WHERE target.intent_key = @intentKey
    )
    SELECT attempt.id,
      COALESCE(adoption.utc_date, substr(attempt.provider_bound_at, 1, 10))
        AS utc_date,
      job.kind AS job_kind, job.workflow_id, job.workflow_version,
      CASE WHEN settlement.evidence_digest IS NOT NULL
        THEN wait.provider_consumed_usd ELSE attempt.cost_usd END AS cost_usd,
      CASE WHEN settlement.evidence_kind = 'provider_request_final_usage_positive:v1'
        THEN settlement.final_cost_nanos ELSE NULL END AS authoritative_cost_nanos
    FROM owned_jobs
    JOIN ai_jobs AS job ON job.id = owned_jobs.ai_job_id
    JOIN ai_job_attempts AS attempt ON attempt.job_id = job.id
    LEFT JOIN live_acquisition_provider_reservation_adoptions AS adoption
      ON adoption.attempt_id = attempt.id AND adoption.final_job_id = job.id
    LEFT JOIN privacy_purge_intent_job_waits AS wait
      ON wait.intent_key = @intentKey AND wait.job_id = job.id
        AND wait.attempt_id = attempt.id
    LEFT JOIN privacy_purge_intents AS intent
      ON intent.intent_key = wait.intent_key
    LEFT JOIN privacy_purge_intent_final_settlements AS settlement
      ON settlement.intent_key = wait.intent_key
        AND settlement.job_wait_ordinal = wait.ordinal
        AND settlement.proof_generation = intent.settlement_proof_generation
        AND settlement.wait_row_digest = wait.row_digest
    WHERE job.kind = 'resource_research'
      AND NOT (job.workflow_id = @workflowId
        AND job.workflow_version = @workflowVersion)
      AND ((job.status NOT IN ('queued', 'running')
          AND attempt.outcome <> 'running')
        OR (job.status = 'running' AND attempt.outcome = 'running'
          AND settlement.evidence_digest IS NOT NULL))
      AND attempt.provider IS NOT NULL AND attempt.provider_bound_at IS NOT NULL
    ORDER BY utc_date, job.kind, job.workflow_id, job.workflow_version, attempt.id
  `).all({
    intentKey,
    workflowId: C90_WORKFLOW_ID,
    workflowVersion: C90_WORKFLOW_VERSION,
  }) as ProviderAttemptRow[];
  const providerDays = new Map<string, ProviderDay>();
  for (const attempt of providerAttempts) {
    if (typeof attempt.cost_usd !== "number" ||
        !Number.isFinite(attempt.cost_usd) || attempt.cost_usd < 0) {
      throw new Error("Privacy purge provider cost is corrupt");
    }
    const attemptCostNanos = attempt.authoritative_cost_nanos ??
      Math.ceil(attempt.cost_usd * 1_000_000_000);
    if (!Number.isSafeInteger(attemptCostNanos) || attemptCostNanos < 0) {
      throw new Error("Privacy purge provider cost exceeds safe integer accounting");
    }
    const key = JSON.stringify([
      attempt.utc_date,
      attempt.job_kind,
      attempt.workflow_id,
      attempt.workflow_version,
    ]);
    const day = providerDays.get(key) ?? {
      utcDate: attempt.utc_date,
      jobKind: attempt.job_kind,
      workflowId: attempt.workflow_id,
      workflowVersion: attempt.workflow_version,
      providerAttempts: 0,
      chargedCostNanos: 0,
    };
    if (!Number.isSafeInteger(day.providerAttempts + 1) ||
        !Number.isSafeInteger(day.chargedCostNanos + attemptCostNanos)) {
      throw new Error("Privacy purge provider accounting exceeds safe integers");
    }
    day.providerAttempts += 1;
    day.chargedCostNanos += attemptCostNanos;
    providerDays.set(key, day);
  }
  for (const day of providerDays.values()) {
    const payload = {
      version: "privacy_purge_budget_carryover:v1",
      intentKey,
      utcDate: day.utcDate,
      budgetClass: "provider",
      jobKind: day.jobKind,
      workflowId: day.workflowId,
      workflowVersion: day.workflowVersion,
      coordinatorStarts: 0,
      providerAttempts: day.providerAttempts,
      chargedCostNanos: day.chargedCostNanos,
      activeExposureNanos: 0,
      legacy25DayBlock: 0,
      state: "frozen",
      frozenAt,
      activatedAt: null,
    } as const;
    derived.push({
      intentKey,
      utcDate: day.utcDate,
      budgetClass: "provider",
      jobKind: day.jobKind,
      workflowId: day.workflowId,
      workflowVersion: day.workflowVersion,
      coordinatorStarts: 0,
      providerAttempts: day.providerAttempts,
      chargedCostNanos: day.chargedCostNanos,
      activeExposureNanos: 0,
      legacy25DayBlock: 0,
      state: "frozen",
      payloadDigest: privacyPurgeBudgetCarryoverPayloadDigest(payload),
      frozenAt,
      activatedAt: null,
    });
  }
  return derived;
}

/**
 * Derive the non-identifying daily accounting handoff directly from the exact
 * run targets already owned by an intent. Callers provide no quantities; the
 * exact connection-local INSERT capability independently binds every row.
 */
export function freezePrivacyPurgeBudgetCarryover(
  connection: Database.Database,
  intentKey: string,
  frozenAt: string,
): void {
  const rows = derivePrivacyPurgeBudgetCarryoverRows(
    connection,
    intentKey,
    frozenAt,
  );
  const insert = connection.prepare(`
    INSERT INTO privacy_purge_budget_carryover_days (
      intent_key, utc_date, budget_class,
      job_kind, workflow_id, workflow_version, coordinator_starts,
      provider_attempts, charged_cost_nanos, active_exposure_nanos,
      legacy25_day_block, state, payload_digest, frozen_at, activated_at
    ) VALUES (
      @intentKey, @utcDate, @budgetClass,
      @jobKind, @workflowId, @workflowVersion, @coordinatorStarts,
      @providerAttempts, @chargedCostNanos, @activeExposureNanos,
      @legacy25DayBlock, @state, @payloadDigest, @frozenAt, @activatedAt
    )
  `);
  for (const row of rows) insert.run(row);
}
