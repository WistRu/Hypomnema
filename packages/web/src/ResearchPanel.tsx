import {
  type DurableJobId,
  type ResearchCaptureIntent,
  type ResearchConfirmedOrigins,
  type ResearchCoverage,
  type ResearchPreflight,
  type ResearchPreflightRequest,
  type ResearchTarget,
  type TabInstance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  cancelResearchJob,
  executeRelayedTabCommand,
  fetchConnectedTabCommandScopes,
  fetchLogicalPageByTabId,
  fetchResearchJob,
  fetchResearchLatestRun,
  preflightResearch,
  submitResearchRefinement,
  submitResearchRun,
} from "./api";
import { classifyExactCaptureCopies, type SelectableExactCaptureCopy } from "./exact-instance-capture";
import { useI18n } from "./i18n";
import type { ExactTabFallbackRequest } from "./live-acquisition-model";
import {
  captureResearchCopies,
  mapCanonicalTabsToResearchTarget,
  type ResearchCaptureOutcome,
  type ResearchCaptureSelection,
} from "./research-entry";
import "./ResearchPanel.css";

const EMPTY_ORIGINS: ResearchConfirmedOrigins = {
  authenticatedOriginDigests: [],
  sensitiveOriginDigests: [],
};
const EMPTY_CAPTURE_INTENT: ResearchCaptureIntent = {
  selectedTabIds: [],
  knownFailures: [],
};
const EMPTY_CAPTURE_INSTANCES: readonly TabInstance[] = [];
const DEFAULT_BUDGET = {
  maxSteps: 4,
  maxTokens: 20_000,
  maxCostUsd: 1,
  maxWallTimeMs: 120_000,
} as const;

function targetKey(target: ResearchTarget): string {
  return JSON.stringify(target);
}

function idempotencyKey(): string {
  return `research-run:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function terminal(status: string): boolean {
  return ["succeeded", "partial", "failed", "cancelled", "superseded"].includes(status);
}

function manifestStateLabel(state: ResearchPreflight["manifest"][number]["state"]): string {
  return state === "captured" ? "Captured" : state === "missing" ? "Missing"
    : state === "failed" ? "Failed" : "Excluded";
}

function accessLabel(access: ResearchPreflight["manifest"][number]["accessClass"]): string {
  return access === "public" ? "Public" : access === "authenticated" ? "Authenticated" : "Sensitive";
}

function exclusionLabel(reason: ResearchPreflight["limitations"][number]): string {
  const labels: Record<ResearchPreflight["limitations"][number], string> = {
    invalid_url: "Invalid URL",
    browser_internal: "Browser-internal page",
    extension: "Browser extension page",
    file: "Local file",
    data: "Inline data URL",
    unsupported_scheme: "Unsupported URL scheme",
    embedded_credentials: "URL contains embedded credentials",
    localhost: "Localhost source",
    private_ip: "Private IP source",
    private_hostname: "Private hostname source",
    registrable_domain_unavailable: "Registrable domain unavailable",
    weak_sensitive_signal: "Sensitive source could not be safely confirmed",
    empty_captured_text: "Captured text is empty",
    source_limit: "Source limit reached",
    corpus_byte_limit: "Corpus byte limit reached",
  };
  return labels[reason];
}

function snapshotKindLabel(kind: ResearchPreflight["snapshots"][number]["kind"]): string {
  return {
    page_context: "Page context",
    resource_context: "Resource context",
    activity: "Activity",
    relation: "Relation",
  }[kind];
}

function unavailableLabel(reason: string): string {
  const labels: Record<string, string> = {
    extension_offline: "Browser extension offline",
    protocol_unsupported: "Extension update required",
    incomplete_identity: "Exact tab identity is incomplete",
    page_unsupported: "This page type cannot be captured",
    discarded: "This tab is discarded; activate it before capture",
  };
  return labels[reason] ?? reason;
}

function copyLabel(
  instance: TabInstance,
  formatNumber: (value: number) => string,
  untitledLabel: string,
): string {
  return `${instance.browser} · ${formatNumber(instance.windowId)} · ${formatNumber(instance.browserTabId ?? 0)} · ${instance.title?.trim() || untitledLabel}`;
}

interface ResearchPanelProps {
  captureInstances?: readonly TabInstance[];
  captureInstancesState?: "ready" | "pending" | "error";
  entryLabel: string;
  exactTabFallbackRequest?: ExactTabFallbackRequest;
  openRequestToken?: number;
  onRefresh?: () => Promise<unknown>;
  onRetryCaptureInstances?: () => void;
  refinement?: {
    readonly parentReportId: number;
    readonly previousCoverage: ResearchCoverage;
  };
  target: ResearchTarget;
}

export function ResearchPanel(props: ResearchPanelProps) {
  return <ResearchPanelState
    key={`${targetKey(props.target)}:${props.refinement?.parentReportId ?? "new"}`}
    {...props}
  />;
}

function ResearchPanelState({
  captureInstances = EMPTY_CAPTURE_INSTANCES,
  captureInstancesState = "ready",
  entryLabel,
  exactTabFallbackRequest,
  onRefresh,
  onRetryCaptureInstances,
  openRequestToken,
  refinement,
  target,
}: ResearchPanelProps) {
  const { errorMessage, formatDuration, formatNumber, localeTag, t } = useI18n();
  const queryClient = useQueryClient();
  const panelId = useId();
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [includeShareableContext, setIncludeShareableContext] = useState(true);
  const [maxIncludedSources, setMaxIncludedSources] = useState(10);
  const [preflight, setPreflight] = useState<ResearchPreflight | null>(null);
  const [approvedRequest, setApprovedRequest] = useState<ResearchPreflightRequest | null>(null);
  const [approvalKey, setApprovalKey] = useState<{ fingerprint: string; key: string } | null>(null);
  const [captureIntent, setCaptureIntent] = useState<ResearchCaptureIntent>(EMPTY_CAPTURE_INTENT);
  const [authenticatedConfirmed, setAuthenticatedConfirmed] = useState(false);
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const [activeJobId, setActiveJobId] = useState<DurableJobId | null>(null);
  const [selectedCopies, setSelectedCopies] = useState<Map<number, string>>(() => new Map());
  const [captureOutcomes, setCaptureOutcomes] = useState<ResearchCaptureOutcome[]>([]);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [focusRestoreRevision, setFocusRestoreRevision] = useState(0);
  const historyRefreshedForTerminalJob = useRef<string | null>(null);
  const approvalInputsRevision = useRef(0);
  const previousOpenRequestToken = useRef(openRequestToken);
  const previousFallbackKey = useRef<string | null>(null);

  const key = targetKey(target);
  const latestQuery = useQuery({
    queryKey: ["research-latest-run", key],
    queryFn: ({ signal }) => fetchResearchLatestRun(target, signal),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : false;
    },
    refetchOnWindowFocus: "always",
  });
  const restoredJobId = latestQuery.data?.jobId ?? null;
  const jobId = activeJobId ?? restoredJobId;
  const jobQuery = useQuery({
    enabled: jobId !== null,
    queryKey: ["research-job", jobId],
    queryFn: ({ signal }) => fetchResearchJob(jobId!, signal),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : false;
    },
    refetchOnWindowFocus: "always",
  });

  useEffect(() => {
    if (!jobQuery.data || !terminal(jobQuery.data.status)) return;
    if (activeJobId !== null) setActiveJobId(null);
    if (historyRefreshedForTerminalJob.current === jobQuery.data.id) return;
    historyRefreshedForTerminalJob.current = jobQuery.data.id;
    void latestQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["research-report-history", key] });
  }, [activeJobId, jobQuery.data?.id, jobQuery.data?.status, key, queryClient]);

  useEffect(() => {
    if (focusRestoreRevision > 0) panelHeadingRef.current?.focus();
  }, [focusRestoreRevision]);

  useEffect(() => {
    if (openRequestToken === undefined ||
        previousOpenRequestToken.current === openRequestToken) return;
    previousOpenRequestToken.current = openRequestToken;
    setOpen(true);
    setFocusRestoreRevision((current) => current + 1);
  }, [openRequestToken]);

  const boundFallback = exactTabFallbackRequest !== undefined && target.type === "resource" &&
      target.resourceId === exactTabFallbackRequest.resourceId
    ? exactTabFallbackRequest : undefined;
  const fallbackKey = boundFallback === undefined ? null
    : `${boundFallback.jobId}:${boundFallback.actionId}:${boundFallback.exactUrl}`;

  useEffect(() => {
    if (fallbackKey === null || previousFallbackKey.current === fallbackKey) return;
    previousFallbackKey.current = fallbackKey;
    setOpen(true);
    setFocusRestoreRevision((current) => current + 1);
  }, [fallbackKey]);

  const invalidatePreflight = () => {
    approvalInputsRevision.current += 1;
    setPreflight(null);
    setApprovedRequest(null);
    setApprovalKey(null);
    setAuthenticatedConfirmed(false);
    setSensitiveConfirmed(false);
    setSubmitError(null);
  };

  const invalidateApproval = () => {
    approvalInputsRevision.current += 1;
    setApprovedRequest(null);
    setApprovalKey(null);
    setSubmitError(null);
  };

  const requestFor = (
    confirmedOrigins: ResearchConfirmedOrigins,
    nextCaptureIntent = captureIntent,
  ): ResearchPreflightRequest => ({
    version: 1,
    target,
    question: question.trim(),
    includeShareableContext,
    maxIncludedSources,
    parentReportId: refinement?.parentReportId ?? null,
    budget: DEFAULT_BUDGET,
    captureIntent: nextCaptureIntent,
    confirmedOrigins,
  });

  const preflightMutation = useMutation({
    mutationFn: ({ request }: { request: ResearchPreflightRequest; revision: number }) =>
      preflightResearch(request),
    onSuccess: (result, { request, revision }) => {
      if (revision !== approvalInputsRevision.current) return;
      setPreflight(result);
      setApprovedRequest(request);
      setApprovalKey((current) => result.approvalFingerprint === null
        ? null
        : current?.fingerprint === result.approvalFingerprint
          ? current
          : { fingerprint: result.approvalFingerprint, key: idempotencyKey() });
    },
  });
  const submitMutation = useMutation({
    mutationFn: ({ approval }: {
      approval: Parameters<typeof submitResearchRun>[0];
      revision: number;
      approvalKey: string;
    }) => {
      if (refinement === undefined) return submitResearchRun(approval);
      if (approval.parentReportId !== refinement.parentReportId) {
        throw new Error("Research refinement parent does not match its preflight.");
      }
      const { parentReportId: _parentReportId, ...body } = approval;
      return submitResearchRefinement(refinement.parentReportId, target, body);
    },
    onSuccess: (job, variables) => {
      setActiveJobId(job.id);
      setSubmitError(null);
      if (variables.revision === approvalInputsRevision.current &&
          variables.approvalKey === approvalKey?.key) {
        approvalInputsRevision.current += 1;
        setPreflight(null);
        setApprovedRequest(null);
        setApprovalKey(null);
        setAuthenticatedConfirmed(false);
        setSensitiveConfirmed(false);
        setCaptureIntent(EMPTY_CAPTURE_INTENT);
        setSelectedCopies(new Map());
        setCaptureOutcomes([]);
        setFocusRestoreRevision((current) => current + 1);
      }
      void latestQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ["research-report-history", key] });
    },
    onError: (error, variables) => {
      if (variables.revision !== approvalInputsRevision.current ||
          variables.approvalKey !== approvalKey?.key) return;
      setSubmitError(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code : undefined;
      if (code === "RESEARCH_PREFLIGHT_STALE" || code === "RESEARCH_SELECTION_INVALID" ||
          code === "RESEARCH_CAPTURE_REQUIRED") {
        approvalInputsRevision.current += 1;
        setPreflight(null);
        setApprovedRequest(null);
        setApprovalKey(null);
        setAuthenticatedConfirmed(false);
        setSensitiveConfirmed(false);
        setFocusRestoreRevision((current) => current + 1);
      }
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (id: DurableJobId) => cancelResearchJob(id),
    onSuccess: (job) => {
      queryClient.setQueryData(["research-job", job.id], job);
      void latestQuery.refetch();
    },
  });

  const mustCapture = preflight?.coverage.eligible === 0;
  const hasCapturableGaps = preflight?.manifest.some(({ state, exclusionReason }) =>
    state === "missing" || state === "failed" || exclusionReason === "empty_captured_text") ?? false;
  const fallbackCaptureInstances = useMemo(() => {
    if (boundFallback === undefined) return captureInstances;
    const normalized = (value: string) => {
      try { const url = new URL(value); url.hash = ""; return url.href; }
      catch { return null; }
    };
    const expected = normalized(boundFallback.exactUrl);
    if (expected === null) return [];
    return captureInstances.filter((instance) =>
      normalized(instance.urlNormalized || instance.url) === expected ||
      normalized(instance.url) === expected);
  }, [boundFallback, captureInstances]);
  const candidateTabIds = useMemo(
    () => [...new Set(fallbackCaptureInstances.map(({ canonicalTabId }) => canonicalTabId))]
      .sort((left, right) => left - right).slice(0, 100),
    [fallbackCaptureInstances],
  );
  const scopesQuery = useQuery({
    enabled: open && hasCapturableGaps && captureInstancesState === "ready" && candidateTabIds.length > 0,
    queryKey: ["tab-command-relay", "connected-scopes", "research"],
    queryFn: ({ signal }) => fetchConnectedTabCommandScopes(signal),
    refetchOnWindowFocus: "always",
  });
  const logicalPagesQuery = useQuery({
    enabled: open && hasCapturableGaps && captureInstancesState === "ready" && candidateTabIds.length > 0,
    queryKey: ["research-capture-pages", candidateTabIds],
    queryFn: async ({ signal }) => Promise.all(candidateTabIds.map(async (canonicalTabId) => ({
      canonicalTabId,
      logicalPageId: (await fetchLogicalPageByTabId(canonicalTabId, signal)).page.id,
    }))),
  });
  const recapturablePageIds = useMemo(() => new Set(preflight?.manifest
    .filter(({ state, exclusionReason }) =>
      state === "missing" || state === "failed" || exclusionReason === "empty_captured_text")
    .map(({ logicalPageId }) => logicalPageId) ?? []), [preflight]);
  const captureGroups = useMemo(() => {
    if (!logicalPagesQuery.data) return [];
    const instancesByPage = new Map<number, TabInstance[]>();
    for (const { canonicalTabId, logicalPageId } of logicalPagesQuery.data) {
      if (!recapturablePageIds.has(logicalPageId)) continue;
      const current = instancesByPage.get(logicalPageId) ?? [];
      current.push(...fallbackCaptureInstances.filter((item) => item.canonicalTabId === canonicalTabId));
      instancesByPage.set(logicalPageId, current);
    }
    return [...instancesByPage.entries()].sort(([left], [right]) => left - right)
      .map(([logicalPageId, instances]) => ({
        logicalPageId,
        copies: classifyExactCaptureCopies(instances, undefined, scopesQuery.data ?? []),
      }));
  }, [fallbackCaptureInstances, logicalPagesQuery.data, recapturablePageIds, scopesQuery.data]);

  useEffect(() => {
    setSelectedCopies((current) => {
      const next = new Map<number, string>();
      for (const group of captureGroups) {
        const selectable = group.copies.filter(
          (copy): copy is SelectableExactCaptureCopy => copy.kind === "selectable",
        );
        const currentKey = current.get(group.logicalPageId);
        if (currentKey && selectable.some(({ selectionKey }) => selectionKey === currentKey)) {
          next.set(group.logicalPageId, currentKey);
        } else if (selectable.length === 1) {
          next.set(group.logicalPageId, selectable[0]!.selectionKey);
        }
      }
      return next;
    });
  }, [captureGroups]);

  const chosenCaptureSelections = useMemo(() => captureGroups.flatMap((group) => {
    const selectedKey = selectedCopies.get(group.logicalPageId);
    const copy = group.copies.find((candidate): candidate is SelectableExactCaptureCopy =>
      candidate.kind === "selectable" && candidate.selectionKey === selectedKey);
    return copy ? [{ logicalPageId: group.logicalPageId, copy }] : [];
  }), [captureGroups, selectedCopies]);

  const captureMutation = useMutation({
    mutationFn: (selections: readonly ResearchCaptureSelection[]) =>
      captureResearchCopies(selections, executeRelayedTabCommand),
    onSuccess: async (result) => {
      setCaptureIntent(result.captureIntent);
      setCaptureOutcomes(result.outcomes);
      setPreflight(null);
      setApprovedRequest(null);
      setApprovalKey(null);
      setFocusRestoreRevision((current) => current + 1);
      await onRefresh?.();
      const request = requestFor(EMPTY_ORIGINS, result.captureIntent);
      setAuthenticatedConfirmed(false);
      setSensitiveConfirmed(false);
      approvalInputsRevision.current += 1;
      preflightMutation.mutate({ request, revision: approvalInputsRevision.current });
    },
  });

  const latestStatus = jobQuery.data?.status ?? latestQuery.data?.status;
  const snapshotBytes = preflight?.snapshots.reduce((total, snapshot) => total + snapshot.materialBytes, 0) ?? 0;
  const hasAuthenticated = (preflight?.confirmationRequirements.authenticatedOriginDigests.length ?? 0) > 0;
  const hasSensitive = (preflight?.confirmationRequirements.sensitiveOriginDigests.length ?? 0) > 0;
  const confirmationsComplete = (!hasAuthenticated || authenticatedConfirmed) &&
    (!hasSensitive || sensitiveConfirmed);
  const prepareFreshPreflight = () => {
    const request = requestFor(EMPTY_ORIGINS);
    invalidatePreflight();
    preflightMutation.mutate({
      request,
      revision: approvalInputsRevision.current,
    });
  };
  const captureLookupsPending = captureInstancesState === "pending" ||
    (captureInstancesState === "ready" && candidateTabIds.length > 0 &&
      (logicalPagesQuery.isPending || scopesQuery.isPending));
  const captureLookupsFailed = captureInstancesState === "error" ||
    logicalPagesQuery.isError || scopesQuery.isError;
  const formatCost = (cost: number) => new Intl.NumberFormat(localeTag, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cost);
  const snapshotIdentity = (snapshot: ResearchPreflight["snapshots"][number]) => {
    switch (snapshot.kind) {
      case "page_context": return t("context entry {id}, page {pageId}", {
        id: formatNumber(snapshot.contextEntryId), pageId: formatNumber(snapshot.logicalPageId),
      });
      case "resource_context": return t("context entry {id}, resource {resourceId}", {
        id: formatNumber(snapshot.contextEntryId), resourceId: formatNumber(snapshot.resourceId),
      });
      case "activity": return t("page {pageId}, activity date {date}", {
        pageId: formatNumber(snapshot.logicalPageId), date: snapshot.activityDate,
      });
      case "relation": return t("relation {id}", { id: formatNumber(snapshot.relationId) });
    }
  };

  return (
    <div className="research-panel">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={t(entryLabel)}
        className="research-entry-button"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{t(entryLabel)}</span>
        {latestStatus ? <span aria-hidden="true" className={`research-status is-${latestStatus}`}>{t("Research: {status}", { status: t(latestStatus) })}</span> : null}
      </button>
      {jobQuery.data ? (
        <p aria-live="polite" className="research-progress-summary">
          {t("Stage: {stage} · {completed}/{total}", {
            stage: t(jobQuery.data.progress.stage),
            completed: formatNumber(jobQuery.data.progress.completed),
            total: jobQuery.data.progress.total === null ? "?" : formatNumber(jobQuery.data.progress.total),
          })}
        </p>
      ) : null}
      {open ? (
        <section aria-label={t("Research preflight")} className="research-preflight" id={panelId}>
          <h3 ref={panelHeadingRef} tabIndex={-1}>{t("Research preflight")}</h3>
          {boundFallback ? (
            <aside aria-label={t("Exact live fallback source")} className="research-fallback-binding">
              <strong>{t("Exact live fallback source")}</strong>
              <p>{t("Run {jobId}, action {actionId}; reason {reason}.", {
                jobId: boundFallback.jobId, actionId: formatNumber(boundFallback.actionId),
                reason: t(boundFallback.reason),
              })}</p>
              <code>{boundFallback.exactUrl}</code>
              <p>{t("Only an already-open exact copy of this URL can be captured.")}</p>
            </aside>
          ) : null}
          <label>
            <span>{t("Research question")}</span>
            <textarea
              maxLength={4_000}
              required
              value={question}
              onChange={(event) => { setQuestion(event.target.value); invalidatePreflight(); }}
            />
          </label>
          <label className="research-checkbox">
            <input
              checked={includeShareableContext}
              type="checkbox"
              onChange={(event) => { setIncludeShareableContext(event.target.checked); invalidatePreflight(); }}
            />
            <span>{t("Include context explicitly marked as shareable with AI")}</span>
          </label>
          <label>
            <span>{t("Maximum included sources")}</span>
            <input
              max={100}
              min={1}
              type="number"
              value={maxIncludedSources}
              onChange={(event) => { setMaxIncludedSources(Number(event.target.value)); invalidatePreflight(); }}
            />
          </label>
          <button
            disabled={!question.trim() || preflightMutation.isPending || maxIncludedSources < 1 || maxIncludedSources > 100}
            type="button"
            onClick={prepareFreshPreflight}
          >
            {t("Prepare research")}
          </button>

          {preflight ? (
            <div className="research-preflight-result">
              <p><strong>{t("Acquisition")}</strong>: {t("Captured-only corpus")}</p>
              <dl className="research-coverage">
                {(["discovered", "captured", "eligible", "used", "missing", "failed"] as const).map((field) => (
                  <div key={field}><dt>{t(field[0]!.toUpperCase() + field.slice(1))}</dt><dd>{formatNumber(preflight.coverage[field])}</dd></div>
                ))}
              </dl>
              {refinement ? (
                <section aria-label={t("Coverage comparison")} className="research-coverage-comparison">
                  <h4>{t("Coverage compared with parent report {id}", {
                    id: formatNumber(refinement.parentReportId),
                  })}</h4>
                  <table aria-label={t("Coverage comparison")}>
                    <thead><tr>
                      <th scope="col">{t("Measure")}</th>
                      <th scope="col">{t("Prior report")}</th>
                      <th scope="col">{t("Current preflight")}</th>
                      <th scope="col">{t("Delta")}</th>
                    </tr></thead>
                    <tbody>
                      {(["discovered", "captured", "eligible", "missing", "failed"] as const)
                        .map((field) => {
                          const delta = preflight.coverage[field] - refinement.previousCoverage[field];
                          return <tr key={field}>
                            <th scope="row">{t(field[0]!.toUpperCase() + field.slice(1))}</th>
                            <td>{formatNumber(refinement.previousCoverage[field])}</td>
                            <td>{formatNumber(preflight.coverage[field])}</td>
                            <td>{delta === 0 ? "0" : `${delta > 0 ? "+" : "−"}${formatNumber(Math.abs(delta))}`}</td>
                          </tr>;
                        })}
                    </tbody>
                  </table>
                  <p>{t("Coverage compares available material only; it does not prove better research quality. Used sources are omitted because preflight usage stays zero until publication.")}</p>
                </section>
              ) : null}
              <div className="research-estimate" aria-label={t("Research estimate") }>
                <strong>{t("Estimate")}</strong>
                <span>{t("{count} provider calls", { count: formatNumber(preflight.estimate.calls) })}</span>
                <span>{t("{count} input tokens", { count: formatNumber(preflight.estimate.inputTokens) })}</span>
                <span>{t("{count} output tokens", { count: formatNumber(preflight.estimate.outputTokens) })}</span>
                <span>{t("Up to {cost}", { cost: formatCost(preflight.estimate.costUsd) })}</span>
                <span>{t("Up to {duration}", { duration: formatDuration(preflight.estimate.wallTimeMs) })}</span>
              </div>
              <div className="research-estimate" aria-label={t("Approved research budget") }>
                <strong>{t("Approved budget")}</strong>
                <span>{t("{count} maximum steps", { count: formatNumber(preflight.approvedBudget.maxSteps) })}</span>
                <span>{t("{count} maximum tokens", { count: formatNumber(preflight.approvedBudget.maxTokens) })}</span>
                <span>{t("Up to {cost}", { cost: formatCost(preflight.approvedBudget.maxCostUsd) })}</span>
                <span>{t("Up to {duration}", { duration: formatDuration(preflight.approvedBudget.maxWallTimeMs) })}</span>
              </div>
              <p>{t("Shareable snapshots: {count} · {bytes} B", {
                count: formatNumber(preflight.snapshots.length), bytes: formatNumber(snapshotBytes),
              })}</p>
              {preflight.snapshots.length > 0 ? <ul aria-label={t("Safe snapshot manifest") }>
                {preflight.snapshots.map((snapshot) => <li key={`${snapshot.kind}:${snapshot.ordinal}`}>
                  {t("{kind} snapshot · {identity} · digest {digest} · {bytes} B · {truncation}", {
                    kind: t(snapshotKindLabel(snapshot.kind)),
                    identity: snapshotIdentity(snapshot),
                    digest: snapshot.snapshotDigest,
                    bytes: formatNumber(snapshot.materialBytes),
                    truncation: t(snapshot.truncated ? "truncated" : "complete"),
                  })}
                </li>)}
              </ul> : null}
              <p className="muted-copy">{t("The source manifest shows only page IDs, states, access classes, digests, and limits. Confirmation shows normalized origins only; full URL paths, captured text, private context, and titles remain hidden.")}</p>
              <ul className="research-safe-manifest" aria-label={t("Safe source manifest") }>
                {preflight.manifest.map((entry) => (
                  <li key={entry.ordinal}>
                    {t("Page {id} · {state} · {access}", {
                      id: formatNumber(entry.logicalPageId),
                      state: t(manifestStateLabel(entry.state)),
                      access: t(accessLabel(entry.accessClass)),
                    })}
                    <small>{t("Selected tab: {value}", { value: entry.selectedTabId === null
                      ? t("None") : formatNumber(entry.selectedTabId) })}</small>
                    <small>{t("Content revision: {value}", { value: entry.contentRevision === null
                      ? t("None") : formatNumber(entry.contentRevision) })}</small>
                    <small>{t("Content digest: {value}", { value: entry.contentDigest ?? t("None") })}</small>
                    <small>{t("Origin digest: {value}", { value: entry.originDigest ?? t("None") })}</small>
                    {entry.capturedChunkManifest ? <small>{t("Captured chunk: bytes {start}-{end} · digest {digest} · {truncation}", {
                      start: formatNumber(entry.capturedChunkManifest.byteStart),
                      end: formatNumber(entry.capturedChunkManifest.byteEnd),
                      digest: entry.capturedChunkManifest.chunkDigest,
                      truncation: t(entry.capturedChunkManifest.truncated ? "truncated" : "complete"),
                    })}</small> : <small>{t("Captured chunk: none")}</small>}
                    {entry.failureCode ? <small>{t("Capture failure: {code}", { code: entry.failureCode })}</small> : null}
                    {entry.exclusionReason ? <small>{t("Limitation: {reason}", { reason: t(exclusionLabel(entry.exclusionReason)) })}</small> : null}
                  </li>
                ))}
              </ul>
              {preflight.limitations.length > 0 ? (
                <p>{t("Limitations: {items}", {
                  items: preflight.limitations.map((reason) => t(exclusionLabel(reason))).join(", "),
                })}</p>
              ) : <p>{t("No manifest exclusions.")}</p>}

              {preflight.requiresConfirmation && preflight.approvalFingerprint === null ? (
                <fieldset className="research-confirmations">
                  <legend>{t("Per-run privacy confirmation")}</legend>
                  <ul aria-label={t("Origins requiring confirmation") }>
                    {preflight.confirmationDisplay.map((entry) => (
                      <li key={`${entry.accessClass}:${entry.originDigest}`}>
                        {t(entry.accessClass === "authenticated"
                          ? "Authenticated origin: {origin}"
                          : "Sensitive origin: {origin}", { origin: entry.origin })}
                      </li>
                    ))}
                  </ul>
                  {hasAuthenticated ? <label><input checked={authenticatedConfirmed} type="checkbox"
                    onChange={(event) => { setAuthenticatedConfirmed(event.target.checked); invalidateApproval(); }} />
                    <span>{t("Confirm authenticated origins for this run")}</span></label> : null}
                  {hasSensitive ? <label><input checked={sensitiveConfirmed} type="checkbox"
                    onChange={(event) => { setSensitiveConfirmed(event.target.checked); invalidateApproval(); }} />
                    <span>{t("Confirm sensitive origins for this run")}</span></label> : null}
                  <button disabled={!confirmationsComplete || preflightMutation.isPending} type="button"
                    onClick={() => preflightMutation.mutate({
                      request: requestFor({
                        authenticatedOriginDigests: authenticatedConfirmed
                          ? preflight.confirmationRequirements.authenticatedOriginDigests : [],
                        sensitiveOriginDigests: sensitiveConfirmed
                          ? preflight.confirmationRequirements.sensitiveOriginDigests : [],
                      }),
                      revision: approvalInputsRevision.current,
                    })}>
                    {t("Confirm and refresh preflight")}
                  </button>
                </fieldset>
              ) : null}

              {hasCapturableGaps ? (
                <div className="research-capture-batch">
                  {mustCapture ? <p><strong>{t("No eligible captured pages")}</strong></p>
                    : <p><strong>{t("Improve the captured corpus")}</strong></p>}
                  <p>{t("Choose exact copies that are already open. Research capture never opens or navigates a URL.")}</p>
                  {captureLookupsPending ? <p role="status">{t("Checking exact open copies...")}</p> : null}
                  {captureInstancesState === "error" ? <p role="alert">{t("Open-copy data could not be loaded for capture.")} {onRetryCaptureInstances ? <button type="button" onClick={onRetryCaptureInstances}>{t("Retry")}</button> : null}</p> : null}
                  {scopesQuery.isError ? <p role="alert">{t("Connected browser scopes could not be loaded for capture.")} <button type="button" onClick={() => void scopesQuery.refetch()}>{t("Retry")}</button></p> : null}
                  {logicalPagesQuery.isError ? <p role="alert">{t("Open copies could not be mapped to logical pages.")} <button type="button" onClick={() => void logicalPagesQuery.refetch()}>{t("Retry")}</button></p> : null}
                  {new Set(captureInstances.map(({ canonicalTabId }) => canonicalTabId)).size > 100 ? (
                    <p>{t("Capture candidates are limited to the first 100 selected open pages.")}</p>
                  ) : null}
                  {captureGroups.map((group) => (
                    <fieldset key={group.logicalPageId}>
                      <legend>{t("Open copy for page {id}", { id: formatNumber(group.logicalPageId) })}</legend>
                      {group.copies.map((copy) => (
                        <label key={copy.selectionKey}>
                          <input
                            checked={selectedCopies.get(group.logicalPageId) === copy.selectionKey}
                            disabled={copy.kind === "unavailable" || captureMutation.isPending}
                            name={`research-copy-${group.logicalPageId}`}
                            type="radio"
                            onChange={() => {
                              invalidateApproval();
                              setSelectedCopies((current) => {
                                const next = new Map(current); next.set(group.logicalPageId, copy.selectionKey); return next;
                              });
                            }}
                          />
                          <span>{copyLabel(copy.instance, formatNumber, t("Untitled"))}</span>
                          {copy.kind === "unavailable" ? <small>{t("Unavailable: {reason}", { reason: t(unavailableLabel(copy.reason)) })}</small> : null}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                  {captureGroups.length === 0 && !captureLookupsPending && !captureLookupsFailed ? (
                    <p>{t("No already-open exact copies are available for missing pages.")}</p>
                  ) : null}
                  <button disabled={captureLookupsFailed || chosenCaptureSelections.length === 0 || captureMutation.isPending} type="button"
                    onClick={() => captureMutation.mutate(chosenCaptureSelections)}>
                    {t("Capture selected open pages")}
                  </button>
                  {captureOutcomes.length > 0 ? <ul aria-label={t("Capture results")}>{captureOutcomes.map((outcome) => (
                    <li key={`${outcome.logicalPageId}:${outcome.tabId}`}>
                      {outcome.status === "captured"
                        ? t("Page {id}: captured", { id: formatNumber(outcome.logicalPageId) })
                        : t("Page {id}: failed ({code}); refresh copies and retry that page.", {
                            id: formatNumber(outcome.logicalPageId), code: outcome.failureCode,
                          })}
                    </li>
                  ))}</ul> : null}
                </div>
              ) : null}
              {!mustCapture && preflight.approvalFingerprint !== null && approvedRequest && approvalKey ? (
                <button disabled={submitMutation.isPending} type="button" onClick={() => submitMutation.mutate({
                  approval: {
                    ...approvedRequest,
                    estimate: preflight.estimate,
                    approvalFingerprint: preflight.approvalFingerprint!,
                    idempotencyKey: approvalKey.key,
                  },
                  revision: approvalInputsRevision.current,
                  approvalKey: approvalKey.key,
                })}>{t("Start research")}</button>
              ) : null}
            </div>
          ) : null}

          {jobQuery.data?.canCancel ? <button disabled={cancelMutation.isPending} type="button"
            onClick={() => cancelMutation.mutate(jobQuery.data!.id)}>{t("Cancel research")}</button> : null}
          {jobQuery.data?.error ? <p role="alert">{errorMessage(Object.assign(
            new Error(jobQuery.data.error.message),
            jobQuery.data.error.type === "durable" ? { code: jobQuery.data.error.code } : {},
          ))}</p> : null}
          {preflightMutation.isError ? <p role="alert">{errorMessage(preflightMutation.error)}</p> : null}
          {submitError ? <p role="alert">{errorMessage(submitError)}</p> : null}
          {cancelMutation.isError ? <p role="alert">{errorMessage(cancelMutation.error)}</p> : null}
          {latestQuery.isError || jobQuery.isError ? <p role="alert">{errorMessage(latestQuery.error ?? jobQuery.error)}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

export function ResearchSelectionPanel({
  canonicalTabIds,
  captureInstances,
  captureInstancesState = "ready",
  onRetryCaptureInstances,
}: {
  canonicalTabIds: readonly number[];
  captureInstances: readonly TabInstance[];
  captureInstancesState?: "ready" | "pending" | "error";
  onRetryCaptureInstances?: () => void;
}) {
  const { t } = useI18n();
  const canonicalIds = useMemo(
    () => [...new Set(canonicalTabIds)].sort((left, right) => left - right),
    [canonicalTabIds],
  );
  const selectionQuery = useQuery({
    enabled: canonicalIds.length > 0,
    queryKey: ["research-selection-target", canonicalIds],
    queryFn: async ({ signal }) => {
      return mapCanonicalTabsToResearchTarget(canonicalIds, async (id) =>
        (await fetchLogicalPageByTabId(id, signal)).page.id);
    },
  });
  if (selectionQuery.isError) {
    if (selectionQuery.error instanceof Error &&
        selectionQuery.error.message === "Research selection must contain 1..100 logical pages") {
      return <span className="bulk-error" role="alert">{t("Research supports at most 100 selected logical pages.")}</span>;
    }
    return <span className="bulk-error" role="alert">{t("Logical-page mapping unavailable; refresh before researching this selection.")}</span>;
  }
  if (!selectionQuery.data) {
    return <span role="status">{t("Preparing research selection...")}</span>;
  }
  return (
    <ResearchPanel
      captureInstances={captureInstances.filter(({ canonicalTabId }) => canonicalIds.includes(canonicalTabId))}
      captureInstancesState={captureInstancesState}
      entryLabel="Research selected pages"
      target={selectionQuery.data}
      {...(onRetryCaptureInstances ? { onRetryCaptureInstances } : {})}
    />
  );
}
