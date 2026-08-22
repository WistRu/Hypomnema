import type Database from "better-sqlite3";

export const LIVE_ACQUISITION_WORKFLOW = Object.freeze({
  id: "research_acquisition:c90:v1",
  version: 1,
});

export interface LiveAcquisitionWorkflowUsage {
  readonly running: number;
  readonly attemptsStarted: number;
}

export interface LiveAcquisitionFoundation {
  readWorkflowUsageUtcDay(at: string): LiveAcquisitionWorkflowUsage;
  readWorkflowQueue(at: string): {
    readonly claimableJobIds: readonly number[];
    readonly recoverableJobIds: readonly number[];
  };
}

function canonicalTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError("Live acquisition clock must be a canonical timestamp");
  }
  const date = new Date(value);
  if (date.toISOString() !== value) {
    throw new TypeError("Live acquisition clock must be a canonical timestamp");
  }
  return date;
}

function utcDay(date: Date): { readonly start: string; readonly end: string } {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

export function createLiveAcquisitionFoundation(
  connection: Database.Database,
): LiveAcquisitionFoundation {
  const hasPrivacyPurgeBudgetCarryover = connection.prepare(`
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'view' AND name = 'privacy_purge_active_budget_carryover'
  `).pluck().get() === 1;
  const selectWorkflowUsage = connection.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ai_jobs
        WHERE kind = 'resource_research'
          AND workflow_id = @workflowId
          AND workflow_version = @workflowVersion
          AND status = 'running') AS running,
      (SELECT COUNT(*) FROM ai_job_attempts AS attempts
        JOIN ai_jobs AS jobs ON jobs.id = attempts.job_id
        WHERE jobs.kind = 'resource_research'
          AND jobs.workflow_id = @workflowId
          AND jobs.workflow_version = @workflowVersion
          AND attempts.started_at >= @dayStart
          AND attempts.started_at < @dayEnd) AS attempts_started
  `);
  const selectPrivacyPurgeCoordinatorStarts = hasPrivacyPurgeBudgetCarryover
    ? connection.prepare(`
      SELECT COALESCE(SUM(coordinator_starts), 0)
      FROM privacy_purge_active_budget_carryover
      WHERE utc_date = @utcDate AND budget_class = 'c90_coordinator'
        AND job_kind = 'resource_research'
        AND workflow_id = @workflowId AND workflow_version = @workflowVersion
    `).pluck()
    : null;
  const selectClaimable = connection.prepare(`
    SELECT id FROM ai_jobs
    WHERE kind = 'resource_research'
      AND workflow_id = @workflowId
      AND workflow_version = @workflowVersion
      AND status = 'queued'
      AND available_at <= @at
    ORDER BY scheduling_priority DESC, available_at ASC, created_at ASC, id ASC
  `);
  const selectRecoverable = connection.prepare(`
    SELECT id FROM ai_jobs
    WHERE kind = 'resource_research'
      AND workflow_id = @workflowId
      AND workflow_version = @workflowVersion
      AND status = 'running'
      AND lease_expires_at <= @at
    ORDER BY id
  `);

  const workflowParameters = {
    workflowId: LIVE_ACQUISITION_WORKFLOW.id,
    workflowVersion: LIVE_ACQUISITION_WORKFLOW.version,
  } as const;

  return {
    readWorkflowUsageUtcDay(at) {
      const day = utcDay(canonicalTimestamp(at));
      const row = selectWorkflowUsage.get({
        ...workflowParameters,
        dayStart: day.start,
        dayEnd: day.end,
      }) as { running: number; attempts_started: number };
      const carryoverStarts = selectPrivacyPurgeCoordinatorStarts?.get({
        ...workflowParameters,
        utcDate: day.start.slice(0, 10),
      }) as number | undefined;
      return {
        running: row.running,
        attemptsStarted: row.attempts_started + (carryoverStarts ?? 0),
      };
    },
    readWorkflowQueue(at) {
      canonicalTimestamp(at);
      const parameters = { ...workflowParameters, at };
      return {
        claimableJobIds: (selectClaimable.all(parameters) as Array<{ id: number }>)
          .map(({ id }) => id),
        recoverableJobIds: (selectRecoverable.all(parameters) as Array<{ id: number }>)
          .map(({ id }) => id),
      };
    },
  };
}
