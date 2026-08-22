import {
  liveAcquisitionCanonicalOriginSchema,
  type LiveAcquisitionPreflight,
  type LiveAcquisitionPreflightRequest,
  type LiveAcquisitionRunStatus,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  ApiRequestError,
  fetchLiveAcquisitionStatus,
  preflightLiveAcquisition,
  startLiveAcquisition,
} from "./api";
import { useI18n } from "./i18n";
import { LiveAcquisitionRunView } from "./LiveAcquisitionRunView";
import {
  canonicalizeLiveAcquisitionOrigins,
  createExactTabFallbackRequest,
  createLiveAcquisitionConsentDraft,
  createLiveAcquisitionStartRequest,
  persistActiveLiveAcquisition,
  persistLiveAcquisitionReviewSummary,
  readActiveLiveAcquisition,
  readLiveAcquisitionReviewSummary,
  type ExactTabFallbackRequest,
  type LiveAcquisitionConsentDraft,
} from "./live-acquisition-model";
import "./LiveResourceResearchPanel.css";

const EMPTY_CAPTURE_INTENT = { selectedTabIds: [], knownFailures: [] };
const EMPTY_CONFIRMED_ORIGINS = {
  authenticatedOriginDigests: [],
  sensitiveOriginDigests: [],
};

function idempotencyKey(fingerprint: string): string {
  return `live-resource-research:${fingerprint}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function canonicalOrigins(raw: string): string[] {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const origins = lines.map((line) => {
    let value: string;
    try {
      const parsed = new URL(line);
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
        throw new TypeError("unsafe origin");
      }
      value = parsed.origin;
    } catch {
      throw new TypeError("INVALID_LIVE_ORIGIN");
    }
    if (!liveAcquisitionCanonicalOriginSchema.safeParse(value).success) {
      throw new TypeError("INVALID_LIVE_ORIGIN");
    }
    return value;
  });
  return canonicalizeLiveAcquisitionOrigins([...new Set(origins)]);
}

function isActiveStatus(status: LiveAcquisitionRunStatus | undefined): boolean {
  if (status === undefined || status.acquisitionOutcome === "running") return true;
  return status.final?.status === "queued" || status.final?.status === "running";
}

function fallbackRecommended(status: LiveAcquisitionRunStatus | undefined): boolean {
  return status?.actions.some((action) => action.fallback !== null) === true;
}

function isTerminalStatus(status: LiveAcquisitionRunStatus): boolean {
  if (status.acquisitionOutcome === "running") return false;
  return status.final === null ||
    status.final.status !== "queued" && status.final.status !== "running";
}

function manifestState(state: LiveAcquisitionPreflight["capturedCorpus"]["manifest"][number]["state"]): string {
  return state === "captured" ? "Captured" : state === "missing" ? "Missing"
    : state === "failed" ? "Failed" : "Excluded";
}

export interface LiveResourceResearchPanelProps {
  resourceId: number;
  resourceLabel?: string;
  startEnabled?: boolean;
  onOpenCapturedFallback?: (request: ExactTabFallbackRequest) => void;
  onRefresh?: () => Promise<unknown> | unknown;
}

export function LiveResourceResearchPanel(props: LiveResourceResearchPanelProps) {
  return <LiveResourceResearchPanelState key={props.resourceId} {...props} />;
}

function LiveResourceResearchPanelState({
  resourceId,
  resourceLabel,
  startEnabled = true,
  onOpenCapturedFallback,
  onRefresh,
}: LiveResourceResearchPanelProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatDate, formatDuration, formatNumber, localeTag, t } = useI18n();
  const panelId = useId();
  const warningId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const startDispatchInFlight = useRef(false);
  const inputRevision = useRef(0);
  const terminalRefresh = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [includeShareableContext, setIncludeShareableContext] = useState(true);
  const [maxIncludedSources, setMaxIncludedSources] = useState(10);
  const [originText, setOriginText] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const [maxDepth, setMaxDepth] = useState(1);
  const [durationMs, setDurationMs] = useState(300_000);
  const [maxCostUsd, setMaxCostUsd] = useState(1);
  const [reviewed, setReviewed] = useState<{
    draft: LiveAcquisitionConsentDraft;
    idempotencyKey: string;
  } | null>(null);
  const [approvalFingerprint, setApprovalFingerprint] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const persisted = readActiveLiveAcquisition(window.localStorage);
    return persisted?.resourceId === resourceId ? persisted.jobId : null;
  });
  const [localValidationError, setLocalValidationError] = useState<string | null>(null);
  const [typedFallback, setTypedFallback] = useState(false);
  const [restoredReview, setRestoredReview] = useState(() => {
    if (typeof window === "undefined") return null;
    return readLiveAcquisitionReviewSummary(window.localStorage, resourceId);
  });

  const invalidateReview = () => {
    inputRevision.current += 1;
    setReviewed(null);
    setApprovalFingerprint(null);
    setLocalValidationError(null);
    setTypedFallback(false);
    setRestoredReview(null);
    if (typeof window !== "undefined") {
      persistLiveAcquisitionReviewSummary(window.localStorage, resourceId, null);
    }
  };

  const reviewMutation = useMutation({
    mutationFn: ({ request }: { request: LiveAcquisitionPreflightRequest; revision: number }) =>
      preflightLiveAcquisition(request),
    onSuccess: (response, { request, revision }) => {
      if (revision !== inputRevision.current) return;
      const draft = createLiveAcquisitionConsentDraft(request, response);
      setReviewed({
        draft,
        idempotencyKey: idempotencyKey(response.approvalFingerprint),
      });
      setRestoredReview(null);
      if (typeof window !== "undefined") {
        persistLiveAcquisitionReviewSummary(window.localStorage, resourceId, response);
      }
      setApprovalFingerprint(null);
      setTypedFallback(false);
    },
    onError: (error) => {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      setTypedFallback(code === "RESEARCH_CAPTURE_REQUIRED" ||
        code === "SENSITIVE_URL_CAPTURE_REQUIRED");
    },
  });

  const startMutation = useMutation({
    mutationFn: () => {
      if (!startEnabled || reviewed === null ||
          approvalFingerprint !== reviewed.draft.preflight.approvalFingerprint) {
        throw new Error("LIVE_APPROVAL_REQUIRED");
      }
      return startLiveAcquisition(createLiveAcquisitionStartRequest(
        reviewed.draft,
        reviewed.idempotencyKey,
      ));
    },
    onSuccess: (receipt) => {
      setJobId(receipt.id);
      if (typeof window !== "undefined") {
        persistActiveLiveAcquisition(window.localStorage, { jobId: receipt.id, resourceId });
        persistLiveAcquisitionReviewSummary(window.localStorage, resourceId, null);
      }
      setRestoredReview(null);
      setApprovalFingerprint(null);
      queueMicrotask(() => headingRef.current?.focus());
    },
    onSettled: () => { startDispatchInFlight.current = false; },
  });

  const statusQuery = useQuery({
    enabled: jobId !== null,
    queryKey: ["live-acquisition-status", jobId],
    queryFn: ({ signal }) => fetchLiveAcquisitionStatus(jobId!, signal),
    refetchInterval: (query) => isActiveStatus(query.state.data) ? 1_000 : false,
    refetchOnWindowFocus: "always",
  });

  useEffect(() => {
    if (fallbackRecommended(statusQuery.data)) setTypedFallback(true);
  }, [statusQuery.data]);

  useEffect(() => {
    const status = statusQuery.data;
    if (status === undefined || !isTerminalStatus(status) ||
        terminalRefresh.current === status.jobId) return;
    terminalRefresh.current = status.jobId;
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["research-report-history", JSON.stringify(status.target)],
      }),
      Promise.resolve(onRefresh?.()),
    ]);
  }, [onRefresh, queryClient, statusQuery.data]);

  const displayResource = resourceLabel?.trim() || t("Resource {id}", {
    id: formatNumber(resourceId),
  });
  const policy = reviewed?.draft.preflight.effectivePolicy;
  const coverage = reviewed?.draft.preflight.capturedCorpus.coverage;
  const budgetError = startMutation.error instanceof ApiRequestError &&
      startMutation.error.liveAcquisitionBudget !== undefined
    ? startMutation.error.liveAcquisitionBudget
    : reviewMutation.error instanceof ApiRequestError
      ? reviewMutation.error.liveAcquisitionBudget
      : undefined;
  const formatCost = (value: number) => new Intl.NumberFormat(localeTag, {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
  const exactFallbackActionIds = useMemo(() => new Set(statusQuery.data?.actions.flatMap((action) =>
    createExactTabFallbackRequest({ jobId: statusQuery.data!.jobId, resourceId, action }) === null
      ? [] : [action.id]) ?? []), [resourceId, statusQuery.data]);

  const prepareReview = () => {
    setLocalValidationError(null);
    let approvedOrigins: string[];
    try {
      approvedOrigins = canonicalOrigins(originText);
      if (approvedOrigins.length < 1 || approvedOrigins.length > 16) {
        throw new RangeError("INVALID_LIVE_ORIGIN_COUNT");
      }
    } catch {
      setLocalValidationError(t("Enter 1 to 16 public HTTPS origins, one per line."));
      return;
    }
    const request: LiveAcquisitionPreflightRequest = {
      version: 1,
      approvedOrigins,
      limits: { maxPages, maxDepth, durationMs, maxCostUsd },
      research: {
        version: 1,
        target: { type: "resource", resourceId },
        question: question.trim(),
        includeShareableContext,
        maxIncludedSources,
        parentReportId: null,
        budget: {
          maxSteps: 100,
          maxTokens: 200_000,
          maxCostUsd,
          maxWallTimeMs: durationMs + 120_000,
        },
        captureIntent: EMPTY_CAPTURE_INTENT,
        confirmedOrigins: EMPTY_CONFIRMED_ORIGINS,
      },
    };
    reviewMutation.mutate({ request, revision: inputRevision.current });
  };

  const openFallback = (action: LiveAcquisitionRunStatus["actions"][number]) => {
    if (statusQuery.data === undefined) return;
    const request = createExactTabFallbackRequest({
      jobId: statusQuery.data.jobId, resourceId, action,
    });
    if (request === null) return;
    onOpenCapturedFallback?.(request);
    queueMicrotask(() => headingRef.current?.focus());
  };

  const startApproved = () => {
    if (startDispatchInFlight.current || startMutation.isPending) return;
    startDispatchInFlight.current = true;
    startMutation.mutate();
  };

  return (
    <div className="live-resource-research-panel">
      {startEnabled ? <button aria-controls={panelId} aria-expanded={open}
        className="live-research-entry" type="button" onClick={() => setOpen((value) => !value)}>
          {t("Research public pages from this Resource")}
        </button> : null}
      {startEnabled && open ? (
        <section aria-describedby={warningId} aria-labelledby={`${panelId}-heading`} id={panelId}>
          <h3 id={`${panelId}-heading`} ref={headingRef} tabIndex={-1}>
            {t("Live Resource research")}
          </h3>
          <p className="live-research-warning" id={warningId}>
            {t("Public web requests leave from the local TabHub server. Its network route may differ from your browser VPN or proxy, and browser extensions and signed-in browser sessions do not apply.")}
          </p>

          <fieldset disabled={reviewMutation.isPending || startMutation.isPending}>
            <legend>{t("Research scope")}</legend>
            <p>{t("Resource: {resource}", { resource: displayResource })}</p>
            <label><span>{t("Research question")}</span>
              <textarea maxLength={4_000} required value={question}
                onChange={(event) => { setQuestion(event.target.value); invalidateReview(); }} />
            </label>
            <label className="live-research-checkbox">
              <input checked={includeShareableContext} type="checkbox"
                onChange={(event) => { setIncludeShareableContext(event.target.checked); invalidateReview(); }} />
              <span>{t("Include context explicitly marked as shareable with AI")}</span>
            </label>
            <label><span>{t("Maximum included sources")}</span>
              <input max={100} min={1} type="number" value={maxIncludedSources}
                onChange={(event) => { setMaxIncludedSources(Number(event.target.value)); invalidateReview(); }} />
            </label>
          </fieldset>

          <fieldset disabled={reviewMutation.isPending || startMutation.isPending}>
            <legend>{t("Approved public origins")}</legend>
            <label><span>{t("HTTPS origins, one per line")}</span>
              <textarea aria-describedby={warningId} placeholder={t("https://example.com")}
                value={originText}
                onChange={(event) => { setOriginText(event.target.value); invalidateReview(); }} />
            </label>
          </fieldset>

          <fieldset disabled={reviewMutation.isPending || startMutation.isPending}>
            <legend>{t("Live acquisition limits")}</legend>
            <label><span>{t("Maximum pages")}</span><input max={50} min={1} type="number"
              value={maxPages} onChange={(event) => { setMaxPages(Number(event.target.value)); invalidateReview(); }} /></label>
            <label><span>{t("Maximum link depth")}</span><input max={3} min={0} type="number"
              value={maxDepth} onChange={(event) => { setMaxDepth(Number(event.target.value)); invalidateReview(); }} /></label>
            <label><span>{t("Acquisition time limit in milliseconds")}</span>
              <input max={900_000} min={30_000} step={1_000} type="number" value={durationMs}
                onChange={(event) => { setDurationMs(Number(event.target.value)); invalidateReview(); }} /></label>
            <label><span>{t("Maximum AI research cost in USD")}</span>
              <input max={2} min={0.01} step={0.01} type="number" value={maxCostUsd}
                onChange={(event) => { setMaxCostUsd(Number(event.target.value)); invalidateReview(); }} /></label>
          </fieldset>

          <button disabled={!question.trim() || maxIncludedSources < 1 || maxIncludedSources > 100 ||
            reviewMutation.isPending || startMutation.isPending} type="button" onClick={prepareReview}>
            {reviewMutation.isPending ? t("Preparing live research review...") : t("Review live research")}
          </button>

          {restoredReview ? (
            <section className="live-research-consent" aria-label={t("Previous live review summary") }>
              <h4>{t("Previous live review summary")}</h4>
              <p>{t("This safe summary was restored after reload. Review again before approval or start.")}</p>
              <p>{t("Requests leave from the local TabHub server, not the browser. Browser VPN or proxy routing may differ.")}</p>
              <p>{t("Method: {method}. No cookies, credentials, or authorization headers are sent.", {
                method: restoredReview.effectivePolicy.method,
              })}</p>
              <p>{t("Daily starts remaining: {count}", {
                count: formatNumber(restoredReview.dailyStartsRemaining),
              })}</p>
              <p>{t("Daily start limit resets at {date} UTC", { date: formatDate(
                restoredReview.dailyStartsResetAt,
                { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" },
              ) })}</p>
              <dl className="live-research-policy-grid">
                {(["discovered", "captured", "eligible", "used", "missing", "failed"] as const)
                  .map((field) => <div key={field}><dt>{t(field)}</dt>
                    <dd>{formatNumber(restoredReview.capturedCorpus.coverage[field])}</dd></div>)}
              </dl>
              <p>{t("Estimate: {calls} calls, {input} input tokens, {output} output tokens, up to {cost}, up to {duration}.", {
                calls: formatNumber(restoredReview.capturedCorpus.estimate.calls),
                input: formatNumber(restoredReview.capturedCorpus.estimate.inputTokens),
                output: formatNumber(restoredReview.capturedCorpus.estimate.outputTokens),
                cost: formatCost(restoredReview.capturedCorpus.estimate.costUsd),
                duration: formatDuration(restoredReview.capturedCorpus.estimate.wallTimeMs),
              })}</p>
            </section>
          ) : null}

          {reviewed && policy && coverage ? (
            <section className="live-research-consent" aria-label={t("Exact live research consent") }>
              <h4>{t("Exact consent returned by TabHub")}</h4>
              <p>{t("Resource: {resource}", { resource: displayResource })}</p>
              <fieldset>
                <legend>{t("Approved origins for this run")}</legend>
                <ul>{reviewed.draft.preflight.approvedOrigins.map((origin) => <li key={origin}>{origin}</li>)}</ul>
              </fieldset>
              <section aria-label={t("Outgoing request policy") }>
                <h5>{t("Outgoing request policy")}</h5>
                <ul>
                  <li>{t("Requests leave from the local TabHub server, not the browser. Browser VPN or proxy routing may differ.")}</li>
                  <li>{t("Method: {method}. No cookies, credentials, or authorization headers are sent.", { method: policy.method })}</li>
                  <li>{t("Redirects are rejected and never followed.")}</li>
                  <li>{t("Robots policy is checked before page requests.")}</li>
                  <li>{t("Minimum per-origin cadence: {duration}.", { duration: formatDuration(policy.minCadenceMs) })}</li>
                </ul>
              </section>
              <dl className="live-research-policy-grid">
                <div><dt>{t("Maximum pages")}</dt><dd>{formatNumber(reviewed.draft.preflight.limits.maxPages)}</dd></div>
                <div><dt>{t("Maximum depth")}</dt><dd>{formatNumber(reviewed.draft.preflight.limits.maxDepth)}</dd></div>
                <div><dt>{t("Consent duration")}</dt><dd>{formatDuration(reviewed.draft.preflight.limits.durationMs)}</dd></div>
                <div><dt>{t("Maximum source bytes")}</dt><dd>{formatNumber(policy.maxSourceBytes)}</dd></div>
                <div><dt>{t("Maximum total bytes")}</dt><dd>{formatNumber(policy.maxTotalBytes)}</dd></div>
                <div><dt>{t("Maximum header bytes")}</dt><dd>{formatNumber(policy.maxHeaderBytes)}</dd></div>
                <div><dt>{t("DNS timeout")}</dt><dd>{formatDuration(policy.dnsTimeoutMs)}</dd></div>
                <div><dt>{t("Connect timeout")}</dt><dd>{formatDuration(policy.connectTimeoutMs)}</dd></div>
                <div><dt>{t("Headers timeout")}</dt><dd>{formatDuration(policy.headersTimeoutMs)}</dd></div>
                <div><dt>{t("Body idle timeout")}</dt><dd>{formatDuration(policy.bodyIdleTimeoutMs)}</dd></div>
                <div><dt>{t("Request timeout")}</dt><dd>{formatDuration(policy.requestTimeoutMs)}</dd></div>
                <div><dt>{t("Maximum network actions")}</dt><dd>{formatNumber(policy.maxNetworkActions)}</dd></div>
                <div><dt>{t("Maximum AI research cost")}</dt><dd>{formatCost(reviewed.draft.preflight.limits.maxCostUsd)}</dd></div>
              </dl>
              <p>{t("Daily starts remaining: {count}", { count: formatNumber(reviewed.draft.preflight.dailyStartsRemaining) })}</p>
              <p>{t("Daily start limit resets at {date} UTC", { date: formatDate(
                reviewed.draft.preflight.dailyStartsResetAt, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" },
              ) })}</p>
              <p>{t("Consent expires at {date}", { date: formatDate(reviewed.draft.preflight.expiresAt, {
                dateStyle: "medium", timeStyle: "medium",
              }) })}</p>
              <p>{t("Provider: {provider}; model: {model}; prompt: {prompt}; pricing: {pricing}", {
                provider: reviewed.draft.preflight.provider.provider,
                model: reviewed.draft.preflight.provider.model,
                prompt: reviewed.draft.preflight.provider.promptVersion,
                pricing: reviewed.draft.preflight.provider.pricingVersion,
              })}</p>
              <section aria-label={t("Captured corpus coverage") }>
                <h5>{t("Captured corpus coverage")}</h5>
                <dl className="live-research-policy-grid">
                  {(["discovered", "captured", "eligible", "used", "missing", "failed"] as const)
                    .map((field) => <div key={field}><dt>{t(field)}</dt><dd>{formatNumber(coverage[field])}</dd></div>)}
                </dl>
                <p>{t("Estimate: {calls} calls, {input} input tokens, {output} output tokens, up to {cost}, up to {duration}.", {
                  calls: formatNumber(reviewed.draft.preflight.capturedCorpus.estimate.calls),
                  input: formatNumber(reviewed.draft.preflight.capturedCorpus.estimate.inputTokens),
                  output: formatNumber(reviewed.draft.preflight.capturedCorpus.estimate.outputTokens),
                  cost: formatCost(reviewed.draft.preflight.capturedCorpus.estimate.costUsd),
                  duration: formatDuration(reviewed.draft.preflight.capturedCorpus.estimate.wallTimeMs),
                })}</p>
                {reviewed.draft.preflight.capturedCorpus.manifest.length === 0 ? (
                  <p>{t("No captured corpus entries were returned.")}</p>
                ) : <ul aria-label={t("Captured corpus manifest") }>
                  {reviewed.draft.preflight.capturedCorpus.manifest.map((entry) => (
                    <li key={`${entry.sourceKind}:${entry.ordinal}`}>
                      {t("Page {id}: {state}; source {source}; method {method}", {
                        id: formatNumber(entry.logicalPageId), state: t(manifestState(entry.state)),
                        source: t(entry.sourceKind), method: t(entry.acquisitionMethod),
                      })}
                    </li>
                  ))}
                </ul>}
                <p>{t("Shareable snapshots: {count}", {
                  count: formatNumber(reviewed.draft.preflight.capturedCorpus.snapshots.length),
                })}</p>
                {reviewed.draft.preflight.capturedCorpus.snapshots.length > 0 ? (
                  <ul aria-label={t("Captured corpus snapshots") }>
                    {reviewed.draft.preflight.capturedCorpus.snapshots.map((snapshot) => (
                      <li key={`${snapshot.kind}:${snapshot.ordinal}`}>
                        {t("{kind} snapshot {ordinal}: {bytes} bytes; digest {digest}; {truncation}", {
                          kind: t(snapshot.kind), ordinal: formatNumber(snapshot.ordinal),
                          bytes: formatNumber(snapshot.materialBytes), digest: snapshot.snapshotDigest,
                          truncation: t(snapshot.truncated ? "truncated" : "complete"),
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
              <label className="live-research-checkbox">
                <input checked={approvalFingerprint === reviewed.draft.preflight.approvalFingerprint}
                  disabled={startMutation.isPending} type="checkbox"
                  onChange={(event) => setApprovalFingerprint(event.target.checked
                    ? reviewed.draft.preflight.approvalFingerprint : null)} />
                <span>{t("I approve this exact Resource, origin list, policy, limits, corpus, and fingerprint for one run.")}</span>
              </label>
              <button disabled={approvalFingerprint !== reviewed.draft.preflight.approvalFingerprint ||
                startMutation.isPending} type="button" onClick={startApproved}>
                {startMutation.isPending ? t("Starting live research...") : t("Start approved live research")}
              </button>
            </section>
          ) : null}

          {typedFallback && statusQuery.data === undefined ? (
            <p role="status">{t("Captured-only research is required. Open the captured research flow for an exact already-open tab.")}</p>
          ) : null}
          {localValidationError ? <p role="alert">{localValidationError}</p> : null}
          {reviewMutation.isError && budgetError === undefined
            ? <p role="alert">{errorMessage(reviewMutation.error)}</p> : null}
          {startMutation.isError && budgetError === undefined
            ? <p role="alert">{errorMessage(startMutation.error)}</p> : null}
          {budgetError ? <p role="alert">
            {t("Daily live starts are exhausted. {count} remain; reset at {date} UTC.", {
                count: formatNumber(budgetError.dailyStartsRemaining),
                date: formatDate(budgetError.dailyStartsResetAt, {
                  dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
                }),
              })}
          </p> : null}
        </section>
      ) : null}
      {statusQuery.data ? (
        <LiveAcquisitionRunView status={statusQuery.data}
          {...(onOpenCapturedFallback === undefined
            ? {}
            : { exactTabFallbackActionIds: exactFallbackActionIds,
                onExactTabFallback: openFallback })}
          onRefresh={() => void statusQuery.refetch()} />
      ) : null}
      {statusQuery.isPending && jobId !== null ? (
        <p aria-live="polite" role="status">{t("Loading live acquisition status...")}</p>
      ) : null}
      {statusQuery.isError ? <p role="alert">{errorMessage(statusQuery.error)}</p> : null}
    </div>
  );
}
