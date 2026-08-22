import type Database from "better-sqlite3";

import type {
  ShareableContextBundle,
  ShareableContextEntry,
  SummaryDepth,
  SummaryEnqueueResponse,
  SummaryJob,
  SummaryJobResult,
} from "@tabhub/shared";

import {
  normalizeAiJobClaimBoundary,
  prepareAiJobRuntimeClaimBoundary,
  type AiJobClaimBoundary,
} from "./ai-job-runtime-state.js";

export interface QueueSummaryOptions {
  expectedContentRevision?: number;
  maxAttempts: number;
  requestedBy: "user" | "agent";
  requestedModel: string;
}

export interface ClaimedSummaryJob {
  id: number;
  tabId: number;
  depth: SummaryDepth;
  attempts: number;
  maxAttempts: number;
  attemptId: number;
  requestedBy: "user" | "agent";
  requestedModel: string;
  sourceContentRevision: number;
  title: string | null;
  url: string;
  text: string | null;
  context?: readonly ShareableContextEntry[];
}

export interface SummaryCatalogOptions {
  readShareableContext?: (logicalPageId: number) => ShareableContextBundle;
}

export interface SummaryCatalog {
  enqueue(
    tabId: number,
    depth: SummaryDepth,
    options: QueueSummaryOptions,
  ): SummaryEnqueueResponse;
  getJob(id: number): SummaryJob | undefined;
  recoverInterrupted(): number;
  claimNext(
    dailyLimit: number,
    claimBoundary?: AiJobClaimBoundary,
  ): ClaimedSummaryJob | undefined;
  complete(job: ClaimedSummaryJob, result: SummaryJobResult): boolean;
  fail(
    job: ClaimedSummaryJob,
    error: string,
    retryAt: string | undefined,
  ): void;
}

export class SummaryTabNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly tabId: number) {
    super(`No tab exists with id ${tabId}`);
    this.name = "SummaryTabNotFoundError";
  }
}

function contextForProvider(
  bundle: ShareableContextBundle,
): readonly ShareableContextEntry[] {
  return bundle.currentEntries.filter(
    (entry) =>
      entry.state === "active" &&
      (entry.provenance.actor !== "agent" ||
        entry.reviewVerdict === "accepted"),
  );
}

export class SummaryContentMissingError extends Error {
  readonly code = "TAB_CONTENT_MISSING";

  constructor(readonly tabId: number) {
    super(`Tab ${tabId} has no captured text to summarize`);
    this.name = "SummaryContentMissingError";
  }
}

export class SummaryContentRevisionMismatchError extends Error {
  readonly code = "TAB_CONTENT_REVISION_MISMATCH";

  constructor(
    readonly tabId: number,
    readonly expectedContentRevision: number,
    readonly currentContentRevision: number | null,
  ) {
    super(
      `Tab ${tabId} content revision ${String(currentContentRevision)} does not match expected revision ${expectedContentRevision}`,
    );
    this.name = "SummaryContentRevisionMismatchError";
  }
}

interface TabContentRow {
  id: number;
  text: string | null;
  content_revision: number | null;
}

interface ActiveJobRow {
  id: number;
  status: SummaryEnqueueResponse["status"];
  depth: SummaryDepth;
  requested_model: string;
  source_content_revision: number;
}

interface CountRow {
  total: number;
}

interface SummaryJobRow {
  id: number;
  tab_id: number;
  source_content_revision: number;
  current_content_revision: number | null;
  depth: SummaryDepth;
  status: SummaryJob["status"];
  attempts: number;
  max_attempts: number;
  available_at: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  result_summary: string | null;
  result_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

interface ClaimedSummaryJobRow {
  id: number;
  tab_id: number;
  depth: SummaryDepth;
  attempts: number;
  max_attempts: number;
  title: string | null;
  url: string;
  text: string | null;
  extracted_at: string | null;
  requested_by: "user" | "agent";
  requested_model: string;
  source_content_revision: number;
  current_content_revision: number | null;
  logical_page_id: number;
}

function mapJob(row: SummaryJobRow): SummaryJob {
  const hasResult =
    row.result_summary !== null &&
    row.result_model !== null &&
    row.input_tokens !== null &&
    row.output_tokens !== null &&
    row.cost_usd !== null;

  return {
    id: row.id,
    tabId: row.tab_id,
    sourceContentRevision: row.source_content_revision,
    currentContentRevision: row.current_content_revision,
    contentRevisionMatches:
      row.current_content_revision === row.source_content_revision,
    depth: row.depth,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextAttemptAt: row.status === "queued" ? row.available_at : null,
    error: row.last_error,
    result: hasResult
      ? {
          summary: row.result_summary!,
          model: row.result_model!,
          usage: {
            inputTokens: row.input_tokens!,
            outputTokens: row.output_tokens!,
            costUsd: row.cost_usd!,
          },
        }
      : null,
  };
}

function utcDayBounds(now: Date): { start: string; end: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function createSummaryCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
  options: SummaryCatalogOptions = {},
): SummaryCatalog {
  const runtimeClaimBoundary = prepareAiJobRuntimeClaimBoundary(connection);
  const selectTabContent = connection.prepare(`
    SELECT tabs.id, contents.text, contents.content_revision
    FROM tabs
    LEFT JOIN contents ON contents.tab_id = tabs.id
    WHERE tabs.id = ?
  `);
  const selectActiveJob = connection.prepare(`
    SELECT id, status, depth, requested_model, source_content_revision
    FROM jobs
    WHERE kind = 'summary'
      AND tab_id = ?
      AND status IN ('queued', 'running')
    ORDER BY id
    LIMIT 1
  `);
  const countStartedAttempts = connection.prepare(`
    SELECT COUNT(*) AS total
    FROM summary_job_attempts
    WHERE started_at >= ? AND started_at < ?
  `);
  const insertJob = connection.prepare(`
    INSERT INTO jobs (
      kind, tab_id, requested_by, depth, requested_model, prompt_version,
      source_content_revision, status, attempts, max_attempts,
      available_at, created_at, updated_at
    ) VALUES ('summary', ?, ?, ?, ?, 1, ?, 'queued', 0, ?, ?, ?, ?)
  `);
  const selectJob = connection.prepare(`
    SELECT
      jobs.id, jobs.tab_id, jobs.source_content_revision,
      contents.content_revision AS current_content_revision,
      jobs.depth, jobs.status, jobs.attempts, jobs.max_attempts,
      jobs.available_at, jobs.created_at, jobs.started_at, jobs.completed_at,
      jobs.last_error, jobs.result_summary, jobs.result_model,
      jobs.input_tokens, jobs.output_tokens, jobs.cost_usd
    FROM jobs
    LEFT JOIN contents ON contents.tab_id = jobs.tab_id
    WHERE jobs.id = ? AND jobs.kind = 'summary'
  `);
  const selectNextJob = connection.prepare(`
    SELECT
      jobs.id,
      jobs.tab_id,
      jobs.depth,
      jobs.attempts,
      jobs.max_attempts,
      tabs.title,
      tabs.url,
      contents.text,
      contents.extracted_at,
      jobs.requested_by,
      jobs.requested_model,
      jobs.source_content_revision,
      contents.content_revision AS current_content_revision
      , tabs.logical_page_id
    FROM jobs
    JOIN tabs ON tabs.id = jobs.tab_id
    LEFT JOIN contents ON contents.tab_id = jobs.tab_id
    WHERE jobs.kind = 'summary'
      AND jobs.status = 'queued'
      AND jobs.available_at <= ?
    ORDER BY jobs.available_at, jobs.id
    LIMIT 1
  `);
  const markObsolete = connection.prepare(`
    UPDATE jobs
    SET
      status = 'failed',
      completed_at = ?,
      updated_at = ?,
      last_error = ?
    WHERE id = ? AND status = 'queued'
  `);
  const markSuperseded = connection.prepare(`
    UPDATE jobs
    SET
      status = 'failed',
      available_at = ?,
      updated_at = ?,
      completed_at = ?,
      last_error = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `);
  const markSupersededAttempt = connection.prepare(`
    UPDATE summary_job_attempts
    SET completed_at = ?, outcome = 'failed', error = ?
    WHERE job_id = ? AND outcome = 'running'
  `);
  const markRunning = connection.prepare(`
    UPDATE jobs
    SET
      status = 'running',
      attempts = attempts + 1,
      started_at = COALESCE(started_at, ?),
      updated_at = ?,
      last_error = NULL
    WHERE id = ? AND status = 'queued'
  `);
  const insertAttempt = connection.prepare(`
    INSERT INTO summary_job_attempts (
      job_id, attempt_no, started_at, outcome, model
    ) VALUES (?, ?, ?, 'running', ?)
  `);
  const deferReadyJobs = connection.prepare(`
    UPDATE jobs
    SET available_at = ?, updated_at = ?
    WHERE kind = 'summary'
      AND status = 'queued'
      AND available_at <= ?
  `);
  const storeSummary = connection.prepare(`
    UPDATE contents
    SET summary = ?, summary_model = ?,
      summary_job_id = ?,
      summary_generated_at = ?
    WHERE tab_id = ? AND content_revision = ?
      AND EXISTS (
        SELECT 1
        FROM jobs
        WHERE jobs.id = ?
          AND jobs.tab_id = contents.tab_id
          AND jobs.status = 'running'
      )
  `);
  const markSucceeded = connection.prepare(`
    UPDATE jobs
    SET
      status = 'succeeded',
      completed_at = ?,
      available_at = ?,
      updated_at = ?,
      last_error = NULL,
      result_summary = ?,
      result_model = ?,
      input_tokens = ?,
      output_tokens = ?,
      cost_usd = ?
    WHERE id = ? AND status = 'running'
  `);
  const markAttemptSucceeded = connection.prepare(`
    UPDATE summary_job_attempts
    SET
      completed_at = ?,
      outcome = 'succeeded',
      model = ?,
      input_tokens = ?,
      output_tokens = ?,
      cost_usd = ?
    WHERE id = ? AND outcome = 'running'
  `);
  const markRetry = connection.prepare(`
    UPDATE jobs
    SET status = 'queued', available_at = ?, updated_at = ?, last_error = ?
    WHERE id = ? AND status = 'running'
  `);
  const markFailed = connection.prepare(`
    UPDATE jobs
    SET
      status = 'failed', completed_at = ?, available_at = ?,
      updated_at = ?, last_error = ?
    WHERE id = ? AND status = 'running'
  `);
  const markAttemptFailed = connection.prepare(`
    UPDATE summary_job_attempts
    SET completed_at = ?, outcome = 'failed', error = ?
    WHERE id = ? AND outcome = 'running'
  `);
  const failInterruptedAttempts = connection.prepare(`
    UPDATE summary_job_attempts
    SET
      completed_at = ?,
      outcome = 'failed',
      error = 'Server stopped while this attempt was running'
    WHERE outcome = 'running'
  `);
  const retryInterruptedJobs = connection.prepare(`
    UPDATE jobs
    SET
      status = 'queued',
      available_at = ?,
      updated_at = ?,
      last_error = 'Server stopped while the previous attempt was running'
    WHERE status = 'running' AND attempts < max_attempts
  `);
  const failExhaustedInterruptedJobs = connection.prepare(`
    UPDATE jobs
    SET
      status = 'failed',
      available_at = ?,
      updated_at = ?,
      completed_at = ?,
      last_error = 'Server stopped during the final allowed attempt'
    WHERE status = 'running' AND attempts >= max_attempts
  `);

  const enqueueTransaction = connection.transaction(
    (
      tabId: number,
      depth: SummaryDepth,
      options: QueueSummaryOptions,
    ): SummaryEnqueueResponse => {
      const tab = selectTabContent.get(tabId) as TabContentRow | undefined;
      if (tab === undefined) {
        throw new SummaryTabNotFoundError(tabId);
      }
      if (tab.text === null || tab.text.trim().length === 0) {
        throw new SummaryContentMissingError(tabId);
      }
      if (tab.content_revision === null) {
        throw new SummaryContentMissingError(tabId);
      }
      if (
        options.expectedContentRevision !== undefined &&
        options.expectedContentRevision !== tab.content_revision
      ) {
        throw new SummaryContentRevisionMismatchError(
          tabId,
          options.expectedContentRevision,
          tab.content_revision,
        );
      }

      const active = selectActiveJob.get(tabId) as ActiveJobRow | undefined;
      if (
        active !== undefined &&
        active.depth === depth &&
        active.requested_model === options.requestedModel &&
        active.source_content_revision === tab.content_revision
      ) {
        return {
          jobId: active.id,
          sourceContentRevision: active.source_content_revision,
          status: active.status,
        };
      }

      const timestamp = clock().toISOString();
      if (active !== undefined) {
        const error =
          "Superseded by a summary request with different content, depth, or model";
        markSupersededAttempt.run(timestamp, error, active.id);
        markSuperseded.run(
          timestamp,
          timestamp,
          timestamp,
          error,
          active.id,
        );
      }

      const result = insertJob.run(
        tabId,
        options.requestedBy,
        depth,
        options.requestedModel,
        tab.content_revision,
        options.maxAttempts,
        timestamp,
        timestamp,
        timestamp,
      );
      return {
        jobId: Number(result.lastInsertRowid),
        sourceContentRevision: tab.content_revision,
        status: "queued",
      };
    },
  );

  const claimTransaction = connection.transaction(
    (
      dailyLimit: number,
      claimBoundary?: AiJobClaimBoundary,
    ): ClaimedSummaryJob | undefined => {
      const normalizedClaimBoundary = normalizeAiJobClaimBoundary(claimBoundary);
      const nowDate = clock();
      const now = nowDate.toISOString();
      const bounds = utcDayBounds(nowDate);
      const count = countStartedAttempts.get(
        bounds.start,
        bounds.end,
      ) as CountRow;
      if (count.total >= dailyLimit) {
        deferReadyJobs.run(bounds.end, now, now);
        return undefined;
      }

      while (true) {
        const row = selectNextJob.get(now) as ClaimedSummaryJobRow | undefined;
        if (row === undefined) {
          return undefined;
        }

        if (
          row.text === null ||
          row.text.trim().length === 0 ||
          row.current_content_revision !== row.source_content_revision
        ) {
          markObsolete.run(
            now,
            now,
            "Captured content changed or disappeared before summarization",
            row.id,
          );
          continue;
        }

        const attemptNo = row.attempts + 1;
        if (markRunning.run(now, now, row.id).changes === 0) {
          continue;
        }
        const attempt = insertAttempt.run(
          row.id,
          attemptNo,
          now,
          row.requested_model,
        );
        runtimeClaimBoundary.advance(normalizedClaimBoundary, now);

        return {
          id: row.id,
          tabId: row.tab_id,
          depth: row.depth,
          attempts: attemptNo,
          maxAttempts: row.max_attempts,
          attemptId: Number(attempt.lastInsertRowid),
          requestedBy: row.requested_by,
          requestedModel: row.requested_model,
          sourceContentRevision: row.source_content_revision,
          title: row.title,
          url: row.url,
          text: row.text,
          ...(options.readShareableContext === undefined
            ? {}
              : {
                context: contextForProvider(
                  options.readShareableContext(row.logical_page_id),
                ),
              }),
        };
      }
    },
  );

  const completeTransaction = connection.transaction(
    (job: ClaimedSummaryJob, result: SummaryJobResult): boolean => {
      const now = clock().toISOString();
      if (
        storeSummary.run(
          result.summary,
          result.model,
          job.id,
          now,
          job.tabId,
          job.sourceContentRevision,
          job.id,
        ).changes === 0
      ) {
        return false;
      }

      markSucceeded.run(
        now,
        now,
        now,
        result.summary,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.costUsd,
        job.id,
      );
      markAttemptSucceeded.run(
        now,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.costUsd,
        job.attemptId,
      );
      return true;
    },
  );
  const recoverTransaction = connection.transaction((): number => {
    const now = clock().toISOString();
    failInterruptedAttempts.run(now);
    const retried = retryInterruptedJobs.run(now, now).changes;
    const failed = failExhaustedInterruptedJobs.run(now, now, now).changes;
    return retried + failed;
  });

  return {
    enqueue(tabId, depth, options) {
      return enqueueTransaction(tabId, depth, options);
    },

    getJob(id) {
      const row = selectJob.get(id) as SummaryJobRow | undefined;
      return row === undefined ? undefined : mapJob(row);
    },

    recoverInterrupted() {
      return recoverTransaction();
    },

    claimNext(dailyLimit, claimBoundary) {
      return claimTransaction(dailyLimit, claimBoundary);
    },

    complete(job, result) {
      return completeTransaction(job, result);
    },

    fail(job, error, retryAt) {
      const now = clock().toISOString();
      markAttemptFailed.run(now, error, job.attemptId);
      if (retryAt !== undefined && job.attempts < job.maxAttempts) {
        markRetry.run(retryAt, now, error, job.id);
        return;
      }

      markFailed.run(now, now, now, error, job.id);
    },
  };
}
