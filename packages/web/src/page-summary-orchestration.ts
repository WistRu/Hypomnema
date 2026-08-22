import {
  hasCurrentSummaryResult,
  type ExactInstanceCaptureReceipt,
  type SummaryDepth,
  type SummaryEnqueueResponse,
  type SummaryJob,
  type SummaryJobResult,
} from "@tabhub/shared";

export interface CaptureSummaryOperation {
  readonly depth: SummaryDepth;
  readonly operationId: number;
  readonly tabId: number;
}

export interface CapturedSummaryAnchor extends CaptureSummaryOperation {
  readonly sourceContentRevision: number;
}

export interface SummaryJobAnchor extends CapturedSummaryAnchor {
  readonly jobId: number;
}

type CaptureMismatchReason = "capture-tab";
type EnqueueMismatchReason = "enqueue-revision";
type JobMismatchReason =
  | "job-current-result"
  | "job-current-revision"
  | "job-depth"
  | "job-id"
  | "job-source-revision"
  | "job-tab";

export type BindResult<T, TReason extends string> =
  | { readonly anchor: T; readonly kind: "bound" }
  | { readonly kind: "mismatch"; readonly reason: TReason };

export function bindCaptureReceipt(
  operation: CaptureSummaryOperation,
  receipt: ExactInstanceCaptureReceipt,
): BindResult<CapturedSummaryAnchor, CaptureMismatchReason> {
  if (receipt.canonicalTabId !== operation.tabId) {
    return { kind: "mismatch", reason: "capture-tab" };
  }

  return {
    kind: "bound",
    anchor: {
      ...operation,
      sourceContentRevision: receipt.contentRevision,
    },
  };
}

export function bindObservedCaptureRevision(
  operation: CaptureSummaryOperation,
  sourceContentRevision: number,
): CapturedSummaryAnchor {
  return { ...operation, sourceContentRevision };
}

export function bindSummaryEnqueue(
  captured: CapturedSummaryAnchor,
  response: SummaryEnqueueResponse,
): BindResult<SummaryJobAnchor, EnqueueMismatchReason> {
  if (response.sourceContentRevision !== captured.sourceContentRevision) {
    return { kind: "mismatch", reason: "enqueue-revision" };
  }

  return {
    kind: "bound",
    anchor: { ...captured, jobId: response.jobId },
  };
}

export type SummaryJobInspection =
  | { readonly kind: "current"; readonly result: SummaryJobResult }
  | { readonly kind: "failed" }
  | { readonly kind: "mismatch"; readonly reason: JobMismatchReason }
  | { readonly kind: "queued" | "running" }
  | { readonly kind: "stale" };

export function inspectSummaryJob(
  anchor: SummaryJobAnchor,
  job: SummaryJob,
): SummaryJobInspection {
  if (job.id !== anchor.jobId) return { kind: "mismatch", reason: "job-id" };
  if (job.tabId !== anchor.tabId) return { kind: "mismatch", reason: "job-tab" };
  if (job.depth !== anchor.depth) {
    return { kind: "mismatch", reason: "job-depth" };
  }
  if (job.sourceContentRevision !== anchor.sourceContentRevision) {
    return { kind: "mismatch", reason: "job-source-revision" };
  }

  if (
    job.contentRevisionMatches === false ||
    (job.currentContentRevision !== undefined &&
      job.currentContentRevision !== null &&
      job.currentContentRevision !== anchor.sourceContentRevision)
  ) {
    return { kind: "stale" };
  }
  if (
    job.contentRevisionMatches !== true ||
    job.currentContentRevision !== anchor.sourceContentRevision
  ) {
    return { kind: "mismatch", reason: "job-current-revision" };
  }

  if (job.status === "queued" || job.status === "running") {
    return { kind: job.status };
  }
  if (job.status === "failed") return { kind: "failed" };
  if (!hasCurrentSummaryResult(job)) {
    return { kind: "mismatch", reason: "job-current-result" };
  }
  return { kind: "current", result: job.result };
}
