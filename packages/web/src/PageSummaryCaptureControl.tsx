import {
  type ExactInstanceCaptureReceipt,
  type SummaryDepth,
  type SummaryJobResult,
  type TabDetailResponse,
  type TabInstance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  ApiRequestError,
  enqueueSummary,
  fetchSummaryJob,
} from "./api";
import {
  ExactCaptureControl,
  type ExactCaptureReconciliation,
} from "./ExactCaptureControl";
import { useI18n } from "./i18n";
import {
  bindCaptureReceipt,
  bindObservedCaptureRevision,
  bindSummaryEnqueue,
  inspectSummaryJob,
  type CapturedSummaryAnchor,
  type CaptureSummaryOperation,
  type SummaryJobAnchor,
} from "./page-summary-orchestration";

interface PageSummaryCaptureControlProps {
  canonicalTabId: number;
  detail: Pick<TabDetailResponse, "id" | "content">;
  instances: readonly TabInstance[];
  instancesPending: boolean;
  refetchInstances: () => Promise<{
    data: readonly TabInstance[] | undefined;
    isError: boolean;
  }>;
  refetchTabDetail: () => Promise<{
    data: Pick<TabDetailResponse, "id" | "content"> | undefined;
    isError: boolean;
  }>;
}

type FlowState =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { anchor: CapturedSummaryAnchor; kind: "resume" }
  | { anchor: CapturedSummaryAnchor; kind: "enqueueing" }
  | {
      anchor: CapturedSummaryAnchor;
      kind: "enqueue-error";
      reason: "content-missing" | "provider-unavailable" | "request-failed";
    }
  | { kind: "mismatch" }
  | { kind: "poll-error" }
  | { kind: "queued" | "running" }
  | { kind: "job-failed" }
  | { kind: "stale" }
  | { kind: "current"; result: SummaryJobResult };

export function PageSummaryCaptureControl({
  canonicalTabId,
  detail,
  instances,
  instancesPending,
  refetchInstances,
  refetchTabDetail,
}: PageSummaryCaptureControlProps) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [depth, setDepth] = useState<SummaryDepth>("short");
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const [jobAnchor, setJobAnchor] = useState<SummaryJobAnchor | null>(null);
  const operationSequence = useRef(0);
  const operation = useRef<CaptureSummaryOperation | null>(null);
  const enqueueInFlight = useRef(false);
  const currentCanonicalTabId = useRef(canonicalTabId);

  useEffect(() => {
    currentCanonicalTabId.current = canonicalTabId;
    operation.current = null;
    enqueueInFlight.current = false;
    setJobAnchor(null);
    setFlow({ kind: "idle" });
    return () => {
      currentCanonicalTabId.current = 0;
      operation.current = null;
      enqueueInFlight.current = false;
    };
  }, [canonicalTabId]);

  const enqueueMutation = useMutation({
    mutationFn: (anchor: CapturedSummaryAnchor) =>
      enqueueSummary(
        anchor.tabId,
        {
          depth: anchor.depth,
          expectedContentRevision: anchor.sourceContentRevision,
        },
      ).then((response) => ({ anchor, response })),
    onSuccess: ({ anchor, response }) => {
      enqueueInFlight.current = false;
      if (
        currentCanonicalTabId.current !== anchor.tabId ||
        canonicalTabId !== anchor.tabId ||
        operation.current?.operationId !== anchor.operationId
      ) return;
      const bound = bindSummaryEnqueue(anchor, response);
      if (bound.kind === "mismatch") {
        setJobAnchor(null);
        setFlow({ kind: "mismatch" });
        return;
      }
      setJobAnchor(bound.anchor);
      setFlow({ kind: response.status === "running" ? "running" : "queued" });
    },
    onError: (cause, anchor) => {
      enqueueInFlight.current = false;
      if (
        currentCanonicalTabId.current !== anchor.tabId ||
        canonicalTabId !== anchor.tabId ||
        operation.current?.operationId !== anchor.operationId
      ) return;
      setJobAnchor(null);
      if (
        cause instanceof ApiRequestError &&
        cause.code === "TAB_CONTENT_REVISION_MISMATCH"
      ) {
        setFlow({ kind: "stale" });
        return;
      }
      setFlow({
        anchor,
        kind: "enqueue-error",
        reason:
          cause instanceof ApiRequestError && cause.code === "TAB_CONTENT_MISSING"
            ? "content-missing"
            : cause instanceof ApiRequestError && cause.code === "SUMMARY_PROVIDER_UNAVAILABLE"
              ? "provider-unavailable"
              : "request-failed",
      });
    },
  });

  const jobQuery = useQuery({
    queryKey: ["summary-job", jobAnchor?.jobId ?? null],
    queryFn: ({ signal }) => fetchSummaryJob(jobAnchor!.jobId, signal),
    enabled: jobAnchor !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_500 : false;
    },
    retry: false,
  });

  useEffect(() => {
    if (
      jobAnchor === null ||
      jobQuery.data === undefined ||
      jobAnchor.tabId !== canonicalTabId ||
      currentCanonicalTabId.current !== jobAnchor.tabId
    ) return;
    const inspection = inspectSummaryJob(jobAnchor, jobQuery.data);
    switch (inspection.kind) {
      case "queued":
      case "running":
        setFlow({ kind: inspection.kind });
        return;
      case "failed":
        setFlow({ kind: "job-failed" });
        return;
      case "stale":
        setJobAnchor(null);
        setFlow({ kind: "stale" });
        return;
      case "mismatch":
        setJobAnchor(null);
        setFlow({ kind: "mismatch" });
        return;
      case "current":
        setFlow({ kind: "current", result: inspection.result });
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["tab", canonicalTabId] }),
          queryClient.invalidateQueries({ queryKey: ["tabs"] }),
          queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
        ]);
    }
  }, [canonicalTabId, jobAnchor, jobQuery.data, queryClient]);

  useEffect(() => {
    if (jobAnchor !== null && jobQuery.isError) setFlow({ kind: "poll-error" });
  }, [jobAnchor, jobQuery.isError]);

  const continuationAnchor =
    flow.kind === "resume" ||
    flow.kind === "enqueueing" ||
    flow.kind === "enqueue-error"
      ? flow.anchor
      : jobAnchor;
  const observedContentRevision = detail.content?.contentRevision;
  const anchorStillCurrent =
    continuationAnchor !== null &&
    detail.id === continuationAnchor.tabId &&
    observedContentRevision === continuationAnchor.sourceContentRevision;

  useEffect(() => {
    if (
      continuationAnchor === null ||
      observedContentRevision === undefined ||
      observedContentRevision <= continuationAnchor.sourceContentRevision
    ) return;
    setJobAnchor(null);
    setFlow({ kind: "stale" });
  }, [continuationAnchor, observedContentRevision]);

  const beginCapture = () => {
    const next: CaptureSummaryOperation = {
      depth,
      operationId: ++operationSequence.current,
      tabId: canonicalTabId,
    };
    operation.current = next;
    setJobAnchor(null);
    setFlow({ kind: "capturing" });
  };

  const enqueueCaptured = (anchor: CapturedSummaryAnchor) => {
    if (enqueueInFlight.current) return;
    enqueueInFlight.current = true;
    setFlow({ anchor, kind: "enqueueing" });
    enqueueMutation.mutate(anchor);
  };

  const captured = (receipt: ExactInstanceCaptureReceipt) => {
    const active = operation.current;
    if (
      active === null ||
      active.tabId !== canonicalTabId ||
      currentCanonicalTabId.current !== active.tabId
    ) {
      setFlow({ kind: "mismatch" });
      return;
    }
    const bound = bindCaptureReceipt(active, receipt);
    if (bound.kind === "mismatch") {
      setFlow({ kind: "mismatch" });
      return;
    }
    enqueueCaptured(bound.anchor);
  };

  const reconciled = (result: ExactCaptureReconciliation) => {
    const active = operation.current;
    if (
      active === null ||
      active.tabId !== canonicalTabId ||
      currentCanonicalTabId.current !== active.tabId
    ) {
      setFlow({ kind: "mismatch" });
      return;
    }
    setFlow({
      anchor: bindObservedCaptureRevision(active, result.contentRevision),
      kind: "resume",
    });
  };

  const activeJob = flow.kind === "queued" || flow.kind === "running";
  const depthDisabled =
    flow.kind === "capturing" ||
    flow.kind === "resume" ||
    flow.kind === "enqueueing" ||
    activeJob;
  const feedback = (() => {
    switch (flow.kind) {
      case "enqueueing":
        return { kind: "status" as const, text: t("Queueing page summary...") };
      case "queued":
        return { kind: "status" as const, text: t("Page summary queued.") };
      case "running":
        return { kind: "status" as const, text: t("Creating page summary...") };
      case "enqueue-error":
        return {
          kind: "alert" as const,
          text: flow.reason === "content-missing"
            ? t("Captured page content is no longer available. Capture and summarize again.")
            : flow.reason === "provider-unavailable"
              ? t("The page-summary provider is unavailable. Try again after it is configured.")
              : t("TabHub could not queue this page summary."),
        };
      case "poll-error":
        return { kind: "alert" as const, text: t("TabHub could not check this page summary job.") };
      case "job-failed":
        return {
          kind: "alert" as const,
          text: t("TabHub could not create this page summary."),
        };
      case "mismatch":
        return {
          kind: "alert" as const,
          text: t("TabHub returned a summary job for a different capture. Capture and summarize again."),
        };
      case "stale":
        return {
          kind: "alert" as const,
          text: t("Captured content changed while the page summary was running. Capture and summarize again."),
        };
      case "current":
        return anchorStillCurrent
          ? null
          : {
              kind: "status" as const,
              text: t("Confirming the current captured revision before showing this page summary..."),
            };
      default:
        return null;
    }
  })();

  return (
    <div className="page-summary-capture-control">
      <fieldset className="page-summary-depth" disabled={depthDisabled}>
        <legend>{t("Page summary depth")}</legend>
        <label>
          <input
            aria-label={t("Short page summary")}
            checked={depth === "short"}
            name={`page-summary-depth-${canonicalTabId}`}
            type="radio"
            onChange={() => setDepth("short")}
          />
          <span>
            <strong>{t("Short page summary")}</strong>
            <small>{t("A compact overview of this single page.")}</small>
          </span>
        </label>
        <label>
          <input
            aria-label={t("Deep page summary")}
            checked={depth === "deep"}
            name={`page-summary-depth-${canonicalTabId}`}
            type="radio"
            onChange={() => setDepth("deep")}
          />
          <span>
            <strong>{t("Deep page summary")}</strong>
            <small>{t("A detailed analysis of this single captured page.")}</small>
          </span>
        </label>
      </fieldset>

      <ExactCaptureControl
        actionLabel={t("Capture and summarize")}
        actionPendingLabel={t("Capturing page for summary...")}
        canonicalTabId={canonicalTabId}
        detail={detail}
        externalBusy={enqueueMutation.isPending || activeJob}
        instances={instances}
        instancesPending={instancesPending}
        refetchInstances={refetchInstances}
        refetchTabDetail={refetchTabDetail}
        onCaptured={captured}
        onCaptureFailed={() => setFlow({ kind: "idle" })}
        onCaptureReconciled={reconciled}
        onCaptureStarted={beginCapture}
        onCaptureUnchanged={() => setFlow({ kind: "idle" })}
      />

      {flow.kind === "resume" && anchorStillCurrent ? (
        <button
          className="page-summary-resume"
          disabled={enqueueMutation.isPending}
          type="button"
          onClick={() => enqueueCaptured(flow.anchor)}
        >
          {t("Summarize captured revision")}
        </button>
      ) : null}
      {flow.kind === "enqueue-error" &&
      flow.reason !== "content-missing" &&
      anchorStillCurrent ? (
        <button
          className="page-summary-resume"
          disabled={enqueueMutation.isPending}
          type="button"
          onClick={() => enqueueCaptured(flow.anchor)}
        >
          {t("Retry page summary")}
        </button>
      ) : null}
      {flow.kind === "poll-error" && jobAnchor !== null ? (
        <button type="button" onClick={() => void jobQuery.refetch()}>
          {t("Check page summary status")}
        </button>
      ) : null}
      {feedback ? <p role={feedback.kind}>{feedback.text}</p> : null}
      {flow.kind === "current" && anchorStillCurrent ? (
        <div className="page-summary-current" role="status">
          <strong>
            {operation.current?.depth === "deep"
              ? t("Deep page summary ready.")
              : t("Short page summary ready.")}
          </strong>
          <p>{flow.result.summary}</p>
          <small>{flow.result.model}</small>
        </div>
      ) : null}
    </div>
  );
}
