import type { LiveAcquisitionRunStatus } from "@tabhub/shared";
import { useId } from "react";

import { useI18n } from "./i18n";
import "./LiveAcquisitionRunView.css";

type LiveAction = LiveAcquisitionRunStatus["actions"][number];

export interface LiveAcquisitionRunViewProps {
  status: LiveAcquisitionRunStatus;
  exactTabFallbackActionIds?: ReadonlySet<number>;
  onExactTabFallback?: (action: LiveAction) => void;
  onRefresh?: () => void;
}

const ACQUISITION_LABELS: Record<LiveAcquisitionRunStatus["acquisitionOutcome"], string> = {
  running: "Live acquisition is running",
  live_complete: "Live acquisition completed",
  mixed: "Mixed live acquisition completed",
  zero_usable: "No usable live sources",
  blocked: "Live acquisition was blocked",
  ambiguous: "Live acquisition needs review",
  cancelled: "Live acquisition was cancelled",
  failed: "Live acquisition failed",
  purging: "Live acquisition is being purged",
  redacted: "Live acquisition was redacted",
};

const RUN_LABELS: Record<LiveAcquisitionRunStatus["coordinator"]["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partially completed",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

const COUNTERS: ReadonlyArray<{
  key: keyof LiveAcquisitionRunStatus["counters"];
  label: string;
}> = [
  { key: "reservedPages", label: "Reserved pages" },
  { key: "visitedPages", label: "Visited pages" },
  { key: "capturedPages", label: "Captured pages" },
  { key: "blockedPages", label: "Blocked pages" },
  { key: "ambiguousPages", label: "Ambiguous pages" },
  { key: "robotsActions", label: "Robots actions" },
  { key: "networkActions", label: "Network actions" },
  { key: "plannedActions", label: "Planned actions" },
  { key: "activeActions", label: "Active actions" },
];

function present(value: string | null, t: ReturnType<typeof useI18n>["t"]): string {
  return value === null ? t("Not available") : t(value);
}

function Material({ action }: { action: LiveAction }) {
  const { t } = useI18n();
  if (action.redacted) return <span className="live-run-redacted">{t("Redacted")}</span>;
  const value = action.exactUrl ?? action.origin;
  return value === null ? <span>{t("Not available")}</span> : <code>{value}</code>;
}

function Provenance({ action, hidden }: { action: LiveAction; hidden: boolean }) {
  const { t } = useI18n();
  if (hidden || action.redacted) return <span className="live-run-redacted">{t("Hidden")}</span>;
  if (action.capture === null && action.finalInclusion === null) return <span>{t("None yet")}</span>;
  return (
    <div className="live-run-badges" aria-label={t("Source provenance")}>
      {action.capture !== null && (
        <span className="live-run-badge">
          {t("captured")} · {t("Manifest {id}", { id: action.capture.manifestId })}
        </span>
      )}
      {action.finalInclusion !== null && (
        <>
          <span className="live-run-badge">{t("live_acquisition")}</span>
          <span className="live-run-badge">{t("safe_public_http_v1")}</span>
          <span className="live-run-badge">
            {t("Final run {runId}, source {sourceId}", {
              runId: action.finalInclusion.finalRunId,
              sourceId: action.finalInclusion.sourceReceiptId,
            })}
          </span>
        </>
      )}
    </div>
  );
}

export function LiveAcquisitionRunView({
  status,
  exactTabFallbackActionIds,
  onExactTabFallback,
  onRefresh,
}: LiveAcquisitionRunViewProps) {
  const { formatDate, formatNumber, t } = useI18n();
  const titleId = useId();
  const consentTitleId = useId();
  const progressTitleId = useId();
  const actionsTitleId = useId();
  const hidden = status.acquisitionOutcome === "purging" || status.acquisitionOutcome === "redacted";
  const pageActions = status.actions.filter((action) => action.kind === "page");
  const usableCount = pageActions.filter((action) => action.sourceUsable === true).length;
  const omissions = pageActions.filter((action) =>
    action.sourceUsable === false || action.usability === "unusable" || action.omissionReason !== null);
  const coordinatorHandedOff = status.workflowOutcome === "handoff" &&
    status.coordinator.status === "superseded";
  const finalLabel = status.final === null
    ? t("Final research has not started")
    : t("Final research: {status}", { status: t(RUN_LABELS[status.final.status]) });
  const liveSuccessLabel = status.runLiveSuccess === null
    ? t("Pending final research")
    : status.runLiveSuccess ? t("Yes") : t("No");

  return (
    <article className="live-run-view" aria-labelledby={titleId}>
      <header className="live-run-header">
        <div>
          <p className="live-run-eyebrow">{t("Resource live research")}</p>
          <h2 id={titleId}>{t("Live acquisition audit")}</h2>
          <p>{t("Resource {resourceId}", { resourceId: status.target.resourceId })}</p>
        </div>
        {onRefresh !== undefined && (
          <button type="button" onClick={onRefresh}>{t("Refresh status")}</button>
        )}
      </header>

      <section className="live-run-state-grid" aria-label={t("Run states")}>
        <div>
          <h3>{t("Acquisition state")}</h3>
          <strong>{t(ACQUISITION_LABELS[status.acquisitionOutcome])}</strong>
          <p>{t("Coordinator: {status}", {
            status: coordinatorHandedOff ? t("Handed off") : t(RUN_LABELS[status.coordinator.status]),
          })}</p>
          {coordinatorHandedOff && (
            <p>{t("The coordinator was superseded after handoff; this is not a failure.")}</p>
          )}
          <p>{t("Workflow outcome: {outcome}", {
            outcome: status.workflowOutcome === null ? t("Pending") : t(status.workflowOutcome),
          })}</p>
          <p>{t("Outcome code: {code}", {
            code: status.workflowOutcomeCode === null ? t("Pending") : t(status.workflowOutcomeCode),
          })}</p>
        </div>
        <div>
          <h3>{t("Final research state")}</h3>
          <strong>{finalLabel}</strong>
          <p>{t("Live success: {value}", { value: liveSuccessLabel })}</p>
          {!hidden && status.final?.reportId !== null && status.final !== null &&
              status.runLiveSuccess === true && (
            <p>{t("Final dossier {reportId} includes live acquisition evidence.", {
              reportId: status.final.reportId,
            })}</p>
          )}
          {status.acquisitionOutcome === "zero_usable" && (
            <p>{t("No live dossier was produced from this acquisition.")}</p>
          )}
        </div>
      </section>

      {status.acquisitionOutcome === "mixed" && (
        <p className="live-run-callout" role="status">
          {t("Mixed result: {usable} usable live sources and {omissions} visible omissions.", {
            usable: formatNumber(usableCount), omissions: formatNumber(omissions.length),
          })}
        </p>
      )}
      {hidden && (
        <p className="live-run-privacy" role="status">
          {status.acquisitionOutcome === "purging"
            ? t("Privacy purge is in progress. Source material and provenance are hidden.")
            : t("This run was redacted. Source material and provenance are hidden.")}
        </p>
      )}

      <section aria-labelledby={consentTitleId}>
        <h3 id={consentTitleId}>{t("Consent and safe policy")}</h3>
        <dl className="live-run-details">
          <div><dt>{t("Resource")}</dt><dd>{formatNumber(status.target.resourceId)}</dd></div>
          <div><dt>{t("Consent state")}</dt><dd>{t(status.consent.state)}</dd></div>
          <div><dt>{t("Consent expires")}</dt><dd>{formatDate(status.consent.expiresAt)}</dd></div>
          <div><dt>{t("Egress")}</dt><dd>{t("Local TabHub server")}</dd></div>
          <div><dt>{t("Browser network")}</dt><dd>{t("May differ from browser VPN or proxy")}</dd></div>
          <div><dt>{t("Request policy")}</dt><dd>{t("GET only; no cookies, credentials, or redirects")}</dd></div>
          <div><dt>{t("Robots and cadence")}</dt><dd>{t("Robots required; at least {milliseconds} ms", {
            milliseconds: formatNumber(status.consent.effectivePolicy.minCadenceMs),
          })}</dd></div>
          <div><dt>{t("Page and depth cap")}</dt><dd>{t("{pages} pages; depth {depth}", {
            pages: formatNumber(status.consent.limits.maxPages),
            depth: formatNumber(status.consent.limits.maxDepth),
          })}</dd></div>
          <div><dt>{t("Network action cap")}</dt><dd>{formatNumber(
            status.consent.effectivePolicy.maxNetworkActions,
          )}</dd></div>
          <div><dt>{t("Byte caps")}</dt><dd>{t("{source} per source; {total} total; {headers} headers", {
            source: formatNumber(status.consent.effectivePolicy.maxSourceBytes),
            total: formatNumber(status.consent.effectivePolicy.maxTotalBytes),
            headers: formatNumber(status.consent.effectivePolicy.maxHeaderBytes),
          })}</dd></div>
          <div><dt>{t("Request timeout")}</dt><dd>{t("{milliseconds} ms", {
            milliseconds: formatNumber(status.consent.effectivePolicy.requestTimeoutMs),
          })}</dd></div>
          <div><dt>{t("Cost cap")}</dt><dd>{t("{amount} USD", {
            amount: status.consent.limits.maxCostUsd,
          })}</dd></div>
        </dl>
        <div>
          <h4>{t("Approved origins")}</h4>
          {hidden ? <p>{t("Origins are hidden during privacy processing.")}</p>
            : <ul className="live-run-origins">{status.consent.approvedOrigins.map((origin) =>
              <li key={origin}><code>{origin}</code></li>)}</ul>}
        </div>
      </section>

      <section aria-labelledby={progressTitleId}>
        <h3 id={progressTitleId}>{t("Progress and coverage")}</h3>
        <div className="live-run-progress" role="status" aria-live="polite" aria-atomic="true"
          aria-label={t("Live acquisition progress")}>
          <p>{t("Acquisition stage: {stage}", {
            stage: t(ACQUISITION_LABELS[status.acquisitionOutcome]),
          })}</p>
          <dl className="live-run-counters">
            {COUNTERS.map(({ key, label }) => (
              <div key={key}><dt>{t(label)}</dt><dd>{formatNumber(status.counters[key])}</dd></div>
            ))}
            <div><dt>{t("Usable live sources")}</dt><dd>{formatNumber(usableCount)}</dd></div>
            <div><dt>{t("Visible omissions")}</dt><dd>{formatNumber(omissions.length)}</dd></div>
          </dl>
        </div>
      </section>

      <section aria-labelledby={actionsTitleId}>
        <h3 id={actionsTitleId}>{t("Ordered acquisition actions")}</h3>
        <div className="live-run-table-scroll">
          <table className="live-run-table">
            <caption>{t("Robots and page actions in server-projected order")}</caption>
            <thead><tr>
              <th scope="col">{t("Action")}</th><th scope="col">{t("State and outcome")}</th>
              <th scope="col">{t("Usability")}</th><th scope="col">{t("Safe material")}</th>
              <th scope="col">{t("Provenance")}</th><th scope="col">{t("Fallback")}</th>
            </tr></thead>
            <tbody>{status.actions.length === 0 ? (
              <tr><td colSpan={6}>{t("No acquisition actions were recorded for this run.")}</td></tr>
            ) : status.actions.map((action) => (
              <tr key={action.id} data-action-kind={action.kind}>
                <th scope="row">
                  <span>{t(action.kind === "robots" ? "Robots" : "Page")}</span>
                  <small>{t("Action {id}", { id: action.id })}</small>
                  {action.depth !== null && <small>{t("Depth {depth}", { depth: action.depth })}</small>}
                </th>
                <td><span>{t(action.state)}</span><small>{present(action.latestOutcome, t)}</small></td>
                <td>
                  <span>{action.usability === null ? t("Not applicable") : t(action.usability)}</span>
                  <small>{t("Source usable: {value}", {
                    value: action.sourceUsable === null ? t("Pending")
                      : action.sourceUsable ? t("Yes") : t("No"),
                  })}</small>
                  {action.omissionReason !== null &&
                    <small>{t("Omission: {reason}", { reason: t(action.omissionReason) })}</small>}
                </td>
                <td>{hidden ? <span className="live-run-redacted">{t("Hidden")}</span>
                  : <Material action={action} />}</td>
                <td><Provenance action={action} hidden={hidden} /></td>
                <td>{!hidden && action.fallback !== null && onExactTabFallback !== undefined &&
                    exactTabFallbackActionIds?.has(action.id) === true
                  ? <button type="button" onClick={() => onExactTabFallback(action)}>
                      {t("Use exact tab capture")}
                    </button>
                  : <span>{t("None")}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </article>
  );
}
