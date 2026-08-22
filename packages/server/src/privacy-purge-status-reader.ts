import type { PrivacyPurgeStatusResponse } from "@tabhub/shared";
import { privacyPurgeStatusResponseSchema } from "@tabhub/shared";
import type Database from "better-sqlite3";

const unavailable = () => new Error("Privacy purge status unavailable");

interface StatusRow {
  intent_key: string;
  origin: "schema26" | "legacy25";
  target_kind: "logical_page" | "run" | "resource_history";
  subject_generation_id: number | null;
  history_epoch_id: number | null;
  logical_page_id_snapshot: number | null;
  resource_id_snapshot: number | null;
  root_generation_token: string | null;
  history_epoch_no_snapshot: number | null;
  action_wait_count: number;
  job_wait_count: number;
  status: PrivacyPurgeStatusResponse["state"];
  hold_code: string | null;
  created_at: string;
  updated_at: string;
  research_run_id: number | null;
  generation_logical_page_id: number | null;
  generation_token: string | null;
  epoch_resource_id: number | null;
  epoch_no: number | null;
  terminal_actions: number;
  terminal_jobs: number;
  result_outcome: "completed" | "failed" | null;
  command_status: "pending" | "waiting" | "completed" | "failed" | null;
  safe_counts_json: string | null;
  result_completed_at: string | null;
}

export interface PrivacyPurgeStatusReader {
  read(purgeId: string): PrivacyPurgeStatusResponse | null;
}

function intentKeyOf(purgeId: string): string | null {
  const match = /^purge_([0-9a-f]{64})$/.exec(purgeId);
  return match?.[1] ?? null;
}

export function createPrivacyPurgeStatusReader(
  connection: Database.Database,
): PrivacyPurgeStatusReader {
  const select = connection.prepare(`
    SELECT intent.intent_key, intent.origin, intent.target_kind, intent.subject_generation_id,
      intent.history_epoch_id, intent.logical_page_id_snapshot,
      intent.resource_id_snapshot, intent.root_generation_token,
      intent.history_epoch_no_snapshot, intent.action_wait_count,
      intent.job_wait_count, intent.status, intent.hold_code,
      intent.created_at, intent.updated_at,
      generation.research_run_id,
      generation.logical_page_id AS generation_logical_page_id,
      generation.generation_token,
      epoch.resource_id AS epoch_resource_id, epoch.epoch_no,
      (SELECT COUNT(*) FROM privacy_purge_intent_action_waits AS action_wait
        WHERE action_wait.intent_key = intent.intent_key
          AND action_wait.terminal_state IS NOT NULL) AS terminal_actions,
      (SELECT COUNT(*) FROM privacy_purge_intent_job_waits AS job_wait
        WHERE job_wait.intent_key = intent.intent_key
          AND job_wait.terminal_status IS NOT NULL) AS terminal_jobs,
      command.status AS command_status, result.outcome AS result_outcome, result.safe_counts_json,
      result.completed_at AS result_completed_at
    FROM privacy_purge_intents AS intent
    LEFT JOIN privacy_subject_generations AS generation
      ON generation.id = intent.subject_generation_id
    LEFT JOIN research_history_epochs AS epoch ON epoch.id = intent.history_epoch_id
    LEFT JOIN privacy_purge_commands AS command ON command.id = intent.purge_command_id
    LEFT JOIN privacy_purge_results AS result ON result.command_id = command.id
    WHERE intent.intent_key = ?
  `);
  const countWaits = connection.prepare(`
    SELECT
      (SELECT COUNT(*) FROM privacy_purge_intent_action_waits WHERE intent_key = ?) AS actions,
      (SELECT COUNT(*) FROM privacy_purge_intent_job_waits WHERE intent_key = ?) AS jobs
  `);

  const readSnapshot = connection.transaction((intentKey: string) => {
    const row = select.get(intentKey) as StatusRow | undefined;
    if (row === undefined) return null;
    const counts = countWaits.get(intentKey, intentKey) as { actions: number; jobs: number };
    if (counts.actions !== row.action_wait_count || counts.jobs !== row.job_wait_count ||
        row.terminal_actions < 0 || row.terminal_actions > counts.actions ||
        row.terminal_jobs < 0 || row.terminal_jobs > counts.jobs) {
      throw unavailable();
    }
    let target: PrivacyPurgeStatusResponse["target"];
    if (row.target_kind === "run" && row.subject_generation_id !== null &&
        row.research_run_id !== null && row.generation_token === row.root_generation_token) {
      target = { kind: "run", researchRunId: row.research_run_id };
    } else if (row.origin === "legacy25" && row.target_kind === "run" &&
        row.research_run_id !== null) {
      target = { kind: "run", researchRunId: row.research_run_id };
    } else if (row.target_kind === "logical_page" &&
        row.subject_generation_id !== null && row.generation_logical_page_id !== null &&
        row.generation_logical_page_id === row.logical_page_id_snapshot &&
        row.generation_token === row.root_generation_token) {
      target = { kind: "logical_page", logicalPageId: row.generation_logical_page_id };
    } else if (row.origin === "legacy25" && row.target_kind === "logical_page" &&
        row.generation_logical_page_id !== null) {
      target = { kind: "logical_page", logicalPageId: row.generation_logical_page_id };
    } else if (row.target_kind === "resource_history" &&
        row.history_epoch_id !== null && row.epoch_resource_id !== null &&
        row.epoch_resource_id === row.resource_id_snapshot &&
        row.epoch_no === row.history_epoch_no_snapshot) {
      target = { kind: "resource_history", resourceId: row.epoch_resource_id };
    } else if (row.origin === "legacy25" && row.target_kind === "resource_history" &&
        row.epoch_resource_id !== null) {
      target = { kind: "resource_history", resourceId: row.epoch_resource_id };
    } else {
      throw unavailable();
    }
    const terminal = row.status === "completed" || row.status === "failed";
    if (terminal !== (row.result_outcome !== null) ||
        terminal && (row.result_outcome !== row.status ||
          row.command_status !== row.status)) throw unavailable();
    let result: PrivacyPurgeStatusResponse["result"] = null;
    if (terminal) {
      let countsValue: unknown;
      try { countsValue = JSON.parse(row.safe_counts_json!); } catch { throw unavailable(); }
      if (typeof countsValue !== "object" || countsValue === null ||
          !Number.isSafeInteger((countsValue as { deleted_rows?: unknown }).deleted_rows) ||
          Number((countsValue as { deleted_rows: number }).deleted_rows) < 0 ||
          row.result_completed_at === null) throw unavailable();
      result = { deletedRows: Number((countsValue as { deleted_rows: number }).deleted_rows) };
    }
    const completedPhases = row.status === "waiting" || row.status === "failed_hold"
      ? 0 : row.status === "ready" || row.status === "committed" ? 1 : 2;
    const holdReason = row.status !== "failed_hold" ? null
      : row.hold_code === "PROVIDER_USAGE_UNKNOWN"
      ? "awaiting_provider_settlement" as const
      : row.hold_code === "WAIT_SNAPSHOT_DRIFT" ||
        row.hold_code === "PURGE_INVARIANT_VIOLATION"
      ? "manual_review" as const : null;
    if ((row.status === "failed_hold") !== (holdReason !== null)) throw unavailable();
    const response = {
      version: 1 as const,
      purgeId: `purge_${row.intent_key}`,
      target,
      state: row.status,
      progress: {
        completedSteps: row.terminal_actions + row.terminal_jobs + completedPhases,
        totalSteps: row.action_wait_count + row.job_wait_count + 2,
      },
      holdReason,
      canRetry: row.status === "failed_hold" &&
        holdReason === "awaiting_provider_settlement",
      timestamps: {
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: terminal ? row.result_completed_at : null,
      },
      result,
    };
    const parsed = privacyPurgeStatusResponseSchema.safeParse(response);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  });

  return Object.freeze({
    read(purgeId: string) {
      const intentKey = intentKeyOf(purgeId);
      if (intentKey === null) return null;
      try { return readSnapshot.deferred(intentKey); } catch { throw unavailable(); }
    },
  });
}
