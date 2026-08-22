import type {
  DurableJobRef,
  DurableJobView,
  PageSummaryTaskSpec,
  SummaryJob,
} from "@tabhub/shared";

import type { ClaimedSummaryJob, SummaryCatalog } from "./summary-catalog.js";

export interface SummaryExecutionClaim extends ClaimedSummaryJob {
  readonly kind: "page_summary";
  readonly task: PageSummaryTaskSpec;
}

export interface SummaryJobAdapter {
  submit(task: PageSummaryTaskSpec): DurableJobRef;
  get(id: number): DurableJobView | undefined;
  claimNext(dailyLimit: number): SummaryExecutionClaim | undefined;
  recoverInterrupted(): number;
}

function mapSummaryJob(job: SummaryJob): DurableJobView {
  return {
    id: `summary:${job.id}`,
    kind: "page_summary",
    subject: { type: "tab", tabId: job.tabId },
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: {
      completed: job.status === "succeeded" ? 1 : 0,
      total: 1,
      stage: job.status,
    },
    canCancel: false,
    cancellationRequest: null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    nextAttemptAt: job.nextAttemptAt,
    error: job.error === null
      ? null
      : { type: "legacy_summary", message: job.error },
    result: job.result === null
      ? null
      : { type: "page_summary", value: job.result },
  };
}

export function createSummaryJobAdapter(
  catalog: SummaryCatalog,
): SummaryJobAdapter {
  return {
    submit(task) {
      const response = catalog.enqueue(
        task.subject.tabId,
        task.depth,
        {
          maxAttempts: task.maxAttempts,
          requestedBy: task.requestedBy,
          requestedModel: task.requestedModel,
        },
      );
      return {
        id: `summary:${response.jobId}`,
        kind: "page_summary",
        status: response.status,
      };
    },

    get(id) {
      const job = catalog.getJob(id);
      return job === undefined ? undefined : mapSummaryJob(job);
    },

    claimNext(dailyLimit) {
      const job = catalog.claimNext(dailyLimit);
      return job === undefined ? undefined : {
        ...job,
        kind: "page_summary",
        task: {
          version: 1,
          kind: "page_summary",
          subject: { type: "tab", tabId: job.tabId },
          depth: job.depth,
          requestedBy: job.requestedBy,
          requestedModel: job.requestedModel,
          maxAttempts: job.maxAttempts,
        },
      };
    },

    recoverInterrupted() {
      return catalog.recoverInterrupted();
    },
  };
}
