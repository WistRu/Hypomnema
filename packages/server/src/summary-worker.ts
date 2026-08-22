import { summaryJobResultSchema, type SummaryJob } from "@tabhub/shared";

import type {
  ClaimedSummaryJob,
  SummaryCatalog,
} from "./summary-catalog.js";
import type { AiJobClaimBoundary } from "./ai-job-runtime-state.js";
import {
  SummaryProviderError,
  summaryErrorRetry,
  type SummaryProvider,
} from "./summary-provider.js";

export interface SummaryWorkerOptions {
  dailyLimit: number;
  pollMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  clock?: () => Date;
  random?: () => number;
  onCompleted?: (job: SummaryJob) => void;
  onFailed?: (job: SummaryJob) => void;
  onError?: (error: unknown) => void;
}

export interface SummaryWorker {
  recoverInterrupted(): number;
  claimNext(claimBoundary?: AiJobClaimBoundary): ClaimedSummaryJob | undefined;
  executeClaim(job: ClaimedSummaryJob): Promise<void>;
  start(): void;
  wake(): void;
  drainAvailable(): Promise<number>;
  stop(): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForProvider<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createSummaryWorker(
  catalog: SummaryCatalog,
  provider: SummaryProvider,
  options: SummaryWorkerOptions,
): SummaryWorker {
  const pollMs = options.pollMs ?? 1_000;
  const baseRetryMs = options.baseRetryMs ?? 1_000;
  const maxRetryMs = options.maxRetryMs ?? 5 * 60_000;
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeDrain: Promise<number> | undefined;
  let activeAttempt: AbortController | undefined;
  let stopping = false;

  function retryAtFor(job: ClaimedSummaryJob, error: unknown): string | undefined {
    const policy = summaryErrorRetry(error);
    if (!policy.retryable || job.attempts >= job.maxAttempts) {
      return undefined;
    }

    const exponential = Math.min(
      maxRetryMs,
      baseRetryMs * 2 ** Math.max(0, job.attempts - 1),
    );
    const jittered = Math.round(exponential * (0.5 + random() * 0.5));
    const delay = Math.max(jittered, policy.retryAfterMs ?? 0);
    return new Date(clock().getTime() + delay).toISOString();
  }

  async function executeClaim(job: ClaimedSummaryJob): Promise<void> {
    const controller = new AbortController();
    activeAttempt = controller;
    try {
      if (job.text === null || job.text.trim().length === 0) {
        throw new SummaryProviderError(
          "Captured content disappeared before summarization",
          false,
        );
      }

      const parsed = summaryJobResultSchema.safeParse(
        await waitForProvider(
          provider.summarize({
            tabId: job.tabId,
            title: job.title,
            url: job.url,
            text: job.text,
            ...(job.context === undefined ? {} : { context: job.context }),
            depth: job.depth,
            model: job.requestedModel,
            signal: controller.signal,
          }),
          controller.signal,
        ),
      );
      if (!parsed.success) {
        throw new SummaryProviderError(
          "Summary provider returned an invalid result",
          false,
        );
      }
      if (
        parsed.data.summary.trim().length === 0 ||
        parsed.data.model.trim().length === 0
      ) {
        throw new SummaryProviderError(
          "Summary provider returned an empty summary or model",
          false,
        );
      }

      if (!catalog.complete(job, parsed.data)) {
        throw new SummaryProviderError(
          "Captured content changed during summarization",
          false,
        );
      }

      const completed = catalog.getJob(job.id);
      if (completed !== undefined) {
        options.onCompleted?.(completed);
      }
    } catch (error) {
      catalog.fail(job, errorText(error), retryAtFor(job, error));
      const failed = catalog.getJob(job.id);
      if (failed?.status === "failed") {
        options.onFailed?.(failed);
      }
    } finally {
      if (activeAttempt === controller) {
        activeAttempt = undefined;
      }
    }
  }

  async function drain(): Promise<number> {
    let processed = 0;

    while (true) {
      if (stopping) {
        return processed;
      }

      const job = catalog.claimNext(options.dailyLimit);
      if (job === undefined) {
        return processed;
      }

      await executeClaim(job);
      processed += 1;
    }
  }

  function drainAvailable(): Promise<number> {
    if (stopping) {
      return Promise.resolve(0);
    }

    if (activeDrain !== undefined) {
      return activeDrain;
    }

    activeDrain = drain().finally(() => {
      activeDrain = undefined;
    });
    return activeDrain;
  }

  function wake(): void {
    if (stopping) {
      return;
    }

    void drainAvailable().catch((error: unknown) => {
      options.onError?.(error);
    });
  }

  return {
    recoverInterrupted() {
      stopping = false;
      return catalog.recoverInterrupted();
    },

    claimNext(claimBoundary) {
      if (stopping) return undefined;
      return catalog.claimNext(options.dailyLimit, claimBoundary);
    },

    executeClaim,

    start() {
      if (timer !== undefined) {
        return;
      }

      stopping = false;
      catalog.recoverInterrupted();
      timer = setInterval(wake, pollMs);
      timer.unref();
      wake();
    },

    wake,

    drainAvailable,

    async stop() {
      stopping = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      activeAttempt?.abort(
        new SummaryProviderError("Summary worker stopped", true),
      );
      await activeDrain;
    },
  };
}
