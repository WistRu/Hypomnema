import type {
  ResearchCoverage,
  ResearchEvidenceDetail,
  ResearchLatestRun,
  ResearchPublicationReason,
  ResearchReportDetail,
  ResearchReportSummary,
  ResearchTarget,
  TabInstance,
} from "@tabhub/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  appendResourceContext,
  changeLocalPageContext,
  fetchResearchJob,
  fetchResearchReport,
  fetchResearchReports,
} from "./api";
import { useI18n } from "./i18n";
import { activateModalDialog } from "./modal-dialog";
import { ResearchPanel } from "./ResearchPanel";
import { ResearchPurgeControl } from "./ResearchPurgeControl";
import "./ResearchHistoryDrawer.css";

const PAGE_SIZE = 20;
const COVERAGE_FIELDS = [
  "discovered", "captured", "eligible", "used", "missing", "failed",
] as const;
const REPORT_STATE_LABELS: Record<ResearchReportSummary["state"], string> = {
  fresh: "Fresh report",
  stale: "Stale report",
  redacted: "Redacted report state",
  superseded: "Superseded report",
};
const PUBLICATION_STATUS_LABELS: Record<ResearchReportSummary["publishStatus"], string> = {
  succeeded: "Successful publication",
  partial: "Partial publication",
};
const PUBLICATION_REASON_LABELS: Record<ResearchPublicationReason, string> = {
  budget_exhausted: "Budget exhausted",
  corpus_became_stale: "Corpus became stale",
};
const RUN_STATUS_LABELS: Record<ResearchLatestRun["status"], string> = {
  queued: "Research run queued",
  running: "Research run in progress",
  succeeded: "Research run published successfully",
  partial: "Research run published partially",
  failed: "Research run failed",
  cancelled: "Research run cancelled",
  superseded: "Research run superseded",
};

function targetKey(target: ResearchTarget): string {
  return JSON.stringify(target);
}

function sameTarget(left: ResearchTarget, right: ResearchTarget): boolean {
  return targetKey(left) === targetKey(right);
}

function immutableSummarySignature(report: ResearchReportSummary): string {
  const { headFlags: _headFlags, ...immutable } = report;
  return JSON.stringify(immutable);
}

function statusError(job: Awaited<ReturnType<typeof fetchResearchJob>> | undefined): Error | null {
  if (!job?.error) return null;
  return Object.assign(new Error(job.error.message),
    job.error.type === "durable" ? { code: job.error.code } : {});
}

function Coverage({ value }: { value: ResearchCoverage }) {
  const { formatNumber, t } = useI18n();
  return (
    <dl className="research-history-coverage">
      {COVERAGE_FIELDS.map((field) => (
        <div key={field}>
          <dt>{t(field[0]!.toUpperCase() + field.slice(1))}</dt>
          <dd>{formatNumber(value[field])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportBadges({ report }: { report: ResearchReportSummary }) {
  const { t } = useI18n();
  return (
    <span className="research-history-badges">
      {report.headFlags.isCurrentFresh ? <span>{t("Current fresh")}</span> : null}
      {report.headFlags.isLastSuccessful ? <span>{t("Last successful")}</span> : null}
      {report.headFlags.isLatestPublished ? <span>{t("Latest published")}</span> : null}
    </span>
  );
}

function BoundedText({ children, limit = 20_000 }: { children: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const { formatNumber, t } = useI18n();
  const truncated = children.length > limit;
  const visible = truncated && !expanded ? `${children.slice(0, limit)}\n\n…` : children;
  return (
    <div className="research-bounded-text">
      <pre>{visible}</pre>
      {truncated ? (
        <button aria-expanded={expanded} type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("Show compact view") : t("Show all {count} characters", {
            count: formatNumber(children.length),
          })}
        </button>
      ) : null}
    </div>
  );
}

const EVIDENCE_KIND_LABELS: Record<ResearchEvidenceDetail["kind"], string> = {
  tab_content: "Captured page content",
  page_context: "Page context snapshot",
  resource_context: "Resource context snapshot",
  activity: "Activity snapshot",
  relation: "Relation snapshot",
};

function EvidenceDetail({ evidence }: { evidence: ResearchEvidenceDetail }) {
  const { formatNumber, t } = useI18n();
  const unavailable = evidence.state !== "valid";
  return (
    <article className={`research-evidence is-${evidence.state}`}>
      <h6>{t(EVIDENCE_KIND_LABELS[evidence.kind])}</h6>
      <p>{t("Evidence {ordinal} · id {id}", {
        ordinal: formatNumber(evidence.ordinal), id: formatNumber(evidence.id),
      })}</p>
      <p>{t("Evidence state: {state}", { state: t(
        evidence.state === "valid" ? "Valid" : evidence.state === "invalid" ? "Invalid" : "Redacted",
      ) })}</p>
      {evidence.kind === "tab_content" ? (
        <>
          <p>{t("Source kind: {kind} · acquisition method: {method}", {
            kind: t(evidence.sourceKind),
            method: t(evidence.acquisitionMethod),
          })}</p>
          <p>{t("Source {source} · revision {revision} · digest {digest}", {
            source: formatNumber(evidence.sourceId),
            revision: formatNumber(evidence.contentRevision),
            digest: evidence.contentDigest,
          })}</p>
        </>
      ) : (
        <p>{t("Snapshot {id} · locator digest {locatorDigest} · excerpt digest {excerptDigest}", {
          id: formatNumber(evidence.snapshotId),
          locatorDigest: evidence.locatorDigest,
          excerptDigest: evidence.excerptHash,
        })}</p>
      )}
      {unavailable ? (
        <p role="status">{t(evidence.state === "invalid"
          ? "Invalid evidence unavailable: {reason}"
          : "Redacted evidence unavailable: {reason}", {
          reason: evidence.stateReason ?? t("No reason recorded"),
        })}</p>
      ) : (
        <>
          {evidence.kind === "tab_content" && evidence.locator ? (
            <p>{t("Bytes {start}–{end}", {
              start: formatNumber(evidence.locator.byteStart),
              end: formatNumber(evidence.locator.byteEnd),
            })}</p>
          ) : evidence.locator ? <p>{t("Whole snapshot")}</p> : null}
          {evidence.kind === "tab_content" && evidence.title ? <p>{evidence.title}</p> : null}
          {evidence.kind === "tab_content" && evidence.url ? <p>{evidence.url}</p> : null}
          {evidence.excerpt ? <BoundedText limit={4_000}>{evidence.excerpt}</BoundedText> : null}
        </>
      )}
      <details>
        <summary>{t("Evidence digests")}</summary>
        <p>{t("Locator digest: {digest}", { digest: evidence.locatorDigest })}</p>
        <p>{t("Excerpt digest: {digest}", { digest: evidence.excerptHash })}</p>
      </details>
    </article>
  );
}

function nextActionKey(reportId: number): string {
  return `research-next-action:${reportId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function NextActionSaver({ report, target }: {
  report: ResearchReportDetail;
  target: ResearchTarget;
}) {
  const { errorMessage, t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"local_only" | "share_with_ai">("local_only");
  const [attempt, setAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [receipt, setReceipt] = useState(false);
  const mutation = useMutation({
    mutationFn: ({ body, key, nextVisibility }: {
      body: string;
      key: string;
      nextVisibility: "local_only" | "share_with_ai";
    }) => {
      if (target.type === "page") {
        return changeLocalPageContext(target.logicalPageId, {
          kind: "append",
          entryKind: "next_action",
          body,
          visibility: nextVisibility,
          staleAt: null,
          idempotencyKey: key,
        });
      }
      if (target.type === "resource") {
        return appendResourceContext(target.resourceId, {
          entryKind: "next_action",
          body,
          visibility: nextVisibility,
          idempotencyKey: key,
        });
      }
      throw new Error("A selection cannot receive one shared next action.");
    },
    onSuccess: async () => {
      setReceipt(true);
      setSelected(null);
      setAttempt(null);
      if (target.type === "page") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["personal-context"] }),
          queryClient.invalidateQueries({ queryKey: ["tabs"] }),
          queryClient.invalidateQueries({ queryKey: ["tab"] }),
        ]);
      } else if (target.type === "resource") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["resource", target.resourceId, "local-context"] }),
          queryClient.invalidateQueries({ queryKey: ["resource", target.resourceId] }),
          queryClient.invalidateQueries({ queryKey: ["resources"] }),
          queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        ]);
      }
    },
  });

  if (report.dossier === null || report.dossier.nextSteps.length === 0) return null;
  if (target.type === "selection") {
    return (
      <section>
        <h4>{t("Save next step as context")}</h4>
        <p>{t("A selection cannot save one shared next action. Open one page or Resource and choose its next step there.")}</p>
      </section>
    );
  }

  const save = () => {
    if (selected === null || mutation.isPending) return;
    const signature = JSON.stringify({ target, reportId: report.id, selected, visibility });
    const current = attempt?.signature === signature
      ? attempt
      : { signature, key: nextActionKey(report.id) };
    setAttempt(current);
    setReceipt(false);
    mutation.mutate({ body: selected, key: current.key, nextVisibility: visibility });
  };

  return (
    <section className="research-next-action">
      <h4>{t("Save next step as context")}</h4>
      <fieldset>
        <legend>{t("Choose one next step")}</legend>
        {report.dossier.nextSteps.map((step) => (
          <label key={step}>
            <input checked={selected === step} disabled={mutation.isPending} name={`next-step-${report.id}`}
              type="radio" onChange={() => { setSelected(step); setReceipt(false); }} />
            <span>{step}</span>
          </label>
        ))}
      </fieldset>
      <label>
        <span>{t("Next-action visibility")}</span>
        <select aria-label={t("Next-action visibility")} disabled={mutation.isPending} value={visibility}
          onChange={(event) => {
            setVisibility(event.target.value as "local_only" | "share_with_ai");
            setReceipt(false);
          }}>
          <option value="local_only">{t("Local only")}</option>
          <option value="share_with_ai">{t("May be used by AI")}</option>
        </select>
      </label>
      <button disabled={selected === null || mutation.isPending} type="button" onClick={save}>
        {t("Save next step as context")}
      </button>
      {mutation.isError ? <p role="alert">{errorMessage(mutation.error)}</p> : null}
      {receipt ? <p role="status">{t("Next action saved.")}</p> : null}
    </section>
  );
}

function ReportDetail({
  captureInstances = [],
  captureInstancesState = "ready",
  onRefresh,
  onRetryCaptureInstances,
  onPurgeCompleted,
  privacyPurgeEnabled = false,
  report,
  researchEnabled,
  target,
}: ResearchHistoryDrawerProps & {
  onPurgeCompleted?: (report: ResearchReportDetail) => void;
  report: ResearchReportDetail;
}) {
  const { formatDate, formatDuration, formatNumber, localeTag, t } = useI18n();
  const redacted = report.state === "redacted" || report.dossier === null || report.reportText === null;
  const canRefine = researchEnabled && !redacted && report.state !== "superseded";
  return (
    <div className="research-report-detail">
      <p>{t("Created {date}", {
        date: formatDate(report.createdAt, { dateStyle: "medium", timeStyle: "short" }),
      })}</p>
      <dl className="research-report-metadata">
        <div><dt>{t("State")}</dt><dd>{t(REPORT_STATE_LABELS[report.state])}</dd></div>
        <div><dt>{t("Publication")}</dt><dd>{t(PUBLICATION_STATUS_LABELS[report.publishStatus])}</dd></div>
        <div><dt>{t("Reason")}</dt><dd>{report.reason === null
          ? t("None") : t(PUBLICATION_REASON_LABELS[report.reason])}</dd></div>
        <div><dt>{t("Parent report")}</dt><dd>{report.parentReportId === null
          ? t("None") : formatNumber(report.parentReportId)}</dd></div>
      </dl>
      <span className="research-history-badges">
        {report.headFlags.isCurrentFresh ? <span>{t("Current fresh")}</span> : null}
        {report.headFlags.isLastSuccessful ? <span>{t("Last successful")}</span> : null}
        {report.headFlags.isLatestPublished ? <span>{t("Latest published")}</span> : null}
      </span>
      <Coverage value={report.coverage} />
      {redacted ? (
        <p role="status">{t("This report has been redacted. Its private material is unavailable.")}</p>
      ) : <>
        <section>
          <h4>{t("Executive summary")}</h4>
          <p>{report.dossier!.executiveSummary}</p>
        </section>
        {researchEnabled ? <NextActionSaver report={report} target={target} /> : null}
        <section>
          <h4>{t("Value for you")}</h4>
          <p>{report.dossier!.valueForUser}</p>
        </section>
        {([
          ["Capabilities", report.dossier!.capabilities],
          ["Limitations", report.dossier!.limitations],
          ["Risks", report.dossier!.risks],
          ["Unknowns", report.dossier!.unknowns],
          ["Next steps", report.dossier!.nextSteps],
        ] as const).map(([label, values]) => (
          <section key={label}>
            <h4>{t(label)}</h4>
            {values.length > 0 ? <ul>{values.map((value, index) => (
              <li key={`${index}:${value}`}>{value}</li>
            ))}</ul> : <p>{t("None recorded.")}</p>}
          </section>
        ))}
        <section>
          <h4>{t("Report text")}</h4>
          <BoundedText>{report.reportText!}</BoundedText>
        </section>
      </>}
      <section>
        <h4>{t("Claims and evidence")}</h4>
        {report.claims.length === 0 ? <p>{t("No claims recorded.")}</p> : (
          <ol className="research-claims">
            {report.claims.map((claim) => (
              <li key={claim.id}>
                <article>
                  <h5>{redacted ? t("Redacted claim") : claim.claimText ?? t("Redacted claim")}</h5>
                  <p>{t("Claim {ordinal} · id {id} · digest {digest}", {
                    ordinal: formatNumber(claim.ordinal), id: formatNumber(claim.id),
                    digest: claim.claimDigest,
                  })}</p>
                  <p>{t("Confidence: {confidence}", {
                    confidence: new Intl.NumberFormat(localeTag, {
                      style: "percent", maximumFractionDigits: 0,
                    }).format(claim.confidence),
                  })}</p>
                  {claim.rationaleDigest ? <p>{t("Rationale digest: {digest}", {
                    digest: claim.rationaleDigest,
                  })}</p> : null}
                  {claim.isInference ? (
                    <div className="research-inference">
                      <strong>{t("Inference")}</strong>
                      {!redacted ? <p>{claim.rationale ?? t("Inference rationale unavailable.")}</p> : null}
                    </div>
                  ) : null}
                  {claim.evidence.length > 0 ? (
                    <ol aria-label={t("Evidence for claim {number}", {
                      number: formatNumber(claim.ordinal),
                    })}>
                      {claim.evidence.map((evidence) => (
                        <li key={evidence.id}><EvidenceDetail evidence={evidence} /></li>
                      ))}
                    </ol>
                  ) : claim.isInference ? null : <p role="alert">{t("Required evidence is unavailable.")}</p>}
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section>
        <h4>{t("Provenance")}</h4>
        <dl className="research-provenance">
          <div><dt>{t("Provider")}</dt><dd>{report.provenance.provider}</dd></div>
          <div><dt>{t("Model")}</dt><dd>{report.provenance.model}</dd></div>
          <div><dt>{t("Prompt version")}</dt><dd>{report.provenance.promptVersion}</dd></div>
          <div><dt>{t("Pricing version")}</dt><dd>{report.provenance.pricingVersion}</dd></div>
          <div><dt>{t("Request ID")}</dt><dd>{report.provenance.requestId ?? t("None")}</dd></div>
          <div><dt>{t("Input fingerprint")}</dt><dd>{report.provenance.inputFingerprint}</dd></div>
          <div><dt>{t("Terminal attempt")}</dt><dd>{formatNumber(report.provenance.terminalAttemptId)}</dd></div>
          <div><dt>{t("Generated")}</dt><dd>{formatDate(report.provenance.generatedAt, {
            dateStyle: "medium", timeStyle: "short",
          })}</dd></div>
          <div><dt>{t("Steps")}</dt><dd>{formatNumber(report.provenance.usage.steps)}</dd></div>
          <div><dt>{t("Input tokens")}</dt><dd>{formatNumber(report.provenance.usage.inputTokens)}</dd></div>
          <div><dt>{t("Output tokens")}</dt><dd>{formatNumber(report.provenance.usage.outputTokens)}</dd></div>
          <div><dt>{t("Wall time")}</dt><dd>{formatDuration(report.provenance.usage.wallTimeMs)}</dd></div>
          <div><dt>{t("Cost")}</dt><dd>{new Intl.NumberFormat(localeTag, {
            style: "currency", currency: "USD", minimumFractionDigits: 2,
            maximumFractionDigits: 6,
          }).format(report.provenance.usage.costUsd)}</dd></div>
        </dl>
      </section>
      {canRefine ? (
        <ResearchPanel
          captureInstances={captureInstances}
          captureInstancesState={captureInstancesState}
          entryLabel="Refine this report"
          refinement={{ parentReportId: report.id, previousCoverage: report.coverage }}
          target={target}
          {...(onRefresh ? { onRefresh } : {})}
          {...(onRetryCaptureInstances ? { onRetryCaptureInstances } : {})}
        />
      ) : null}
      {target.type === "resource" ? (
        <ResearchPurgeControl
          label={t("Delete this research run")}
          privacyPurgeEnabled={privacyPurgeEnabled}
          target={{ kind: "run", researchRunId: report.runId }}
          onCompleted={() => onPurgeCompleted?.(report)}
        />
      ) : null}
      <p className="muted-copy">{t("Report version {version} · run {run}", {
        version: formatNumber(report.version), run: formatNumber(report.runId),
      })}</p>
    </div>
  );
}

export interface ResearchHistoryDrawerProps {
  captureInstances?: readonly TabInstance[];
  captureInstancesState?: "ready" | "pending" | "error";
  onRefresh?: () => Promise<unknown>;
  onRetryCaptureInstances?: () => void;
  privacyPurgeEnabled?: boolean;
  researchEnabled: boolean;
  target: ResearchTarget;
}

export function ResearchHistoryDrawer(props: ResearchHistoryDrawerProps) {
  return <ResearchHistoryDrawerState key={targetKey(props.target)} {...props} />;
}

function ResearchHistoryDrawerState({
  captureInstances,
  captureInstancesState,
  onRefresh,
  onRetryCaptureInstances,
  privacyPurgeEnabled = false,
  researchEnabled,
  target,
}: ResearchHistoryDrawerProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatDate, formatNumber, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
  const [purgedRunId, setPurgedRunId] = useState<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const key = targetKey(target);

  const historyQuery = useInfiniteQuery({
    enabled: open,
    queryKey: ["research-report-history", key],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => fetchResearchReports(target, {
      limit: PAGE_SIZE,
      ...(pageParam === null ? {} : { beforeVersion: pageParam }),
    }, signal),
    getNextPageParam: (lastPage) => lastPage.nextBeforeVersion ?? undefined,
  });
  const firstPage = historyQuery.data?.pages[0];
  const latestRun = firstPage?.latestRun ?? null;
  const latestJobQuery = useQuery({
    enabled: open && latestRun !== null,
    queryKey: ["research-job", latestRun?.jobId],
    queryFn: async ({ signal }) => {
      const job = await fetchResearchJob(latestRun!.jobId, signal);
      if (!sameTarget(job.subject as ResearchTarget, target)) {
        throw new Error("TabHub returned mismatched research progress.");
      }
      return job;
    },
  });
  const historyCollection = useMemo(() => {
    const byId = new Map<number, ResearchReportSummary>();
    const idByVersion = new Map<number, number>();
    let consistencyError: Error | null = null;
    for (const page of historyQuery.data?.pages ?? []) {
      for (const report of page.items) {
        const existing = byId.get(report.id);
        if (existing && immutableSummarySignature(existing) !== immutableSummarySignature(report)) {
          consistencyError = new Error("Research history contains conflicting copies of one report.");
          continue;
        }
        const existingId = idByVersion.get(report.version);
        if (existingId !== undefined && existingId !== report.id) {
          consistencyError = new Error("Research history assigns one version to multiple reports.");
          continue;
        }
        if (!existing) {
          byId.set(report.id, report);
          idByVersion.set(report.version, report.id);
        }
      }
    }
    const head = firstPage?.head;
    const reports = [...byId.values()].map((report) => ({
      ...report,
      // The first page is the snapshot authority for moving heads. Older pages
      // contribute immutable report rows only and cannot move those heads.
      headFlags: {
        isLatestPublished: head?.latestPublishedReportId === report.id,
        isCurrentFresh: head?.currentFreshReportId === report.id,
        isLastSuccessful: head?.lastSuccessfulReportId === report.id,
      },
    })).sort((left, right) => right.version - left.version);
    return { consistencyError, reports };
  }, [firstPage?.head, historyQuery.data]);
  const reports = historyCollection.reports;
  const selectedSummary = reports.find(({ id }) => id === selectedReportId) ?? null;
  const detailQuery = useQuery({
    enabled: open && selectedReportId !== null,
    queryKey: ["research-report-detail", key, selectedReportId],
    queryFn: ({ signal }) => fetchResearchReport(selectedReportId!, target, signal),
  });
  const selectedDetail = useMemo(() => detailQuery.data ? {
    ...detailQuery.data,
    // Head membership is mutable. The first history page is authoritative,
    // while the dossier and provenance remain the immutable detail payload.
    headFlags: {
      isLatestPublished: firstPage?.head.latestPublishedReportId === detailQuery.data.id,
      isCurrentFresh: firstPage?.head.currentFreshReportId === detailQuery.data.id,
      isLastSuccessful: firstPage?.head.lastSuccessfulReportId === detailQuery.data.id,
    },
  } : undefined, [detailQuery.data, firstPage?.head]);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    return activateModalDialog(dialogRef.current, triggerRef.current, () => setOpen(false));
  }, [open]);
  useEffect(() => {
    if (detailQuery.data?.id === selectedReportId) detailHeadingRef.current?.focus();
  }, [detailQuery.data?.id, selectedReportId]);

  return (
    <div className="research-history-entry">
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        {t("Research history")}
      </button>
      {open ? (
        <div className="research-history-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setOpen(false);
        }}>
          <aside
            aria-labelledby={headingId}
            aria-modal="true"
            className="research-history-drawer"
            ref={dialogRef}
            role="dialog"
          >
            <header>
              <h2 id={headingId}>{t("Research history")}</h2>
              <button aria-label={t("Close research history")} type="button"
                onClick={() => setOpen(false)}>×</button>
            </header>
            {!researchEnabled ? (
              <p role="status">{t("Research creation is disabled; published history remains available.")}</p>
            ) : null}
            {historyQuery.isPending ? <p role="status">{t("Loading research history...")}</p> : null}
            {historyQuery.isError ? <p role="alert">{errorMessage(historyQuery.error)}</p> : null}
            {latestRun ? (
              <section aria-labelledby={`${headingId}-latest`}>
                <h3 id={`${headingId}-latest`}>{t("Latest attempt")}</h3>
                <p>{t("Latest attempt: {status}", {
                  status: t(RUN_STATUS_LABELS[latestRun.status]),
                })}</p>
                <p>{t("Created {date}", {
                  date: formatDate(latestRun.createdAt, { dateStyle: "medium", timeStyle: "short" }),
                })}</p>
                {statusError(latestJobQuery.data) ? (
                  <p role="alert">{errorMessage(statusError(latestJobQuery.data))}</p>
                ) : null}
                {latestJobQuery.isError ? <p role="alert">{errorMessage(latestJobQuery.error)}</p> : null}
              </section>
            ) : null}
            <section aria-labelledby={`${headingId}-reports`}>
              <h3 id={`${headingId}-reports`}>{t("Published reports")}</h3>
              {firstPage ? (
                <nav aria-label={t("Report heads")} className="research-history-heads">
                  {([
                    ["Current fresh report {id}", firstPage.head.currentFreshReportId],
                    ["Last successful report {id}", firstPage.head.lastSuccessfulReportId],
                    ["Latest published report {id}", firstPage.head.latestPublishedReportId],
                  ] as const).map(([label, reportId]) => reportId === null ? null : (
                    <button key={label} type="button" onClick={() => setSelectedReportId(reportId)}>
                      {t(label, { id: formatNumber(reportId) })}
                    </button>
                  ))}
                </nav>
              ) : null}
              {historyCollection.consistencyError ? (
                <div role="alert">
                  <p>{t("Research history is inconsistent. Retry before relying on it.")}</p>
                  <button type="button" onClick={() => void historyQuery.refetch()}>{t("Retry")}</button>
                </div>
              ) : null}
              {reports.length === 0 && historyQuery.isSuccess ? <p>{t("No published reports yet.")}</p> : null}
              <ul className="research-history-list">
                {reports.map((report) => (
                  <li key={report.id}>
                    <button
                      aria-label={t("View report version {version}", {
                        version: formatNumber(report.version),
                      })}
                      type="button"
                      onClick={() => setSelectedReportId(report.id)}
                    >
                      <span>{t("Version {version}", { version: formatNumber(report.version) })}</span>
                      <ReportBadges report={report} />
                      <span>{report.executiveSummary ?? t("Redacted report")}</span>
                      <span>{t("State: {state}", {
                        state: t(REPORT_STATE_LABELS[report.state]),
                      })}</span>
                      <Coverage value={report.coverage} />
                    </button>
                    {report.parentReportId !== null ? (
                      <button type="button" onClick={() => setSelectedReportId(report.parentReportId!)}>
                        {t("Parent report {id}", { id: formatNumber(report.parentReportId) })}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {historyQuery.hasNextPage ? (
                <button disabled={historyQuery.isFetchingNextPage} type="button"
                  onClick={() => void historyQuery.fetchNextPage()}>{t("Load more")}</button>
              ) : null}
            </section>
            {purgedRunId !== null ? (
              <p role="status">{t("Research run {run} was deleted and its report is redacted.", {
                run: formatNumber(purgedRunId),
              })}</p>
            ) : null}
            {selectedReportId !== null ? (
              <section aria-labelledby={`${headingId}-detail`}>
                <h3 id={`${headingId}-detail`} ref={detailHeadingRef} tabIndex={-1}>
                  {selectedSummary?.version !== undefined || selectedDetail?.version !== undefined
                    ? t("Report version {version}", {
                        version: formatNumber(selectedSummary?.version ?? selectedDetail!.version),
                      })
                    : t("Report {id}", { id: formatNumber(selectedReportId) })}
                </h3>
                {detailQuery.isPending ? <p role="status">{t("Loading report...")}</p> : null}
                {detailQuery.isError ? <p role="alert">{errorMessage(detailQuery.error)}</p> : null}
                {selectedDetail ? (
                  <ReportDetail
                    key={`${key}:${selectedDetail.id}`}
                    onPurgeCompleted={(report) => {
                      setPurgedRunId(report.runId);
                      setSelectedReportId(null);
                      queryClient.removeQueries({
                        exact: true,
                        queryKey: ["research-report-detail", key, report.id],
                      });
                      void Promise.all([
                        queryClient.invalidateQueries({ queryKey: ["research-report-history", key] }),
                        queryClient.invalidateQueries({ queryKey: ["research-job"] }),
                        queryClient.invalidateQueries({ queryKey: ["live-acquisition-status"] }),
                        ...(target.type === "resource" ? [
                          queryClient.invalidateQueries({
                            queryKey: ["resource", target.resourceId, "local-context"],
                          }),
                          queryClient.invalidateQueries({ queryKey: ["resource", target.resourceId] }),
                          queryClient.invalidateQueries({ queryKey: ["resources"] }),
                        ] : []),
                        historyQuery.refetch(),
                        onRefresh?.(),
                      ]);
                    }}
                    privacyPurgeEnabled={privacyPurgeEnabled}
                    onRefresh={async () => {
                      await Promise.all([historyQuery.refetch(), onRefresh?.()]);
                    }}
                    report={selectedDetail}
                    researchEnabled={researchEnabled}
                    target={target}
                    {...(captureInstances ? { captureInstances } : {})}
                    {...(captureInstancesState ? { captureInstancesState } : {})}
                    {...(onRetryCaptureInstances ? { onRetryCaptureInstances } : {})}
                  />
                ) : null}
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
