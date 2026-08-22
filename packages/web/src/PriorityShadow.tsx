import type {
  PrioritySafeRead,
  PrioritySubjectContract,
  TabImportance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";

import {
  fetchPriorityReadBatch,
  fetchPriorityReviewQueue,
  submitPriorityFeedback,
  type PriorityFeedbackInput,
  type PriorityFeedbackVerdict,
} from "./api";
import { useI18n } from "./i18n";
import "./PriorityShadow.css";

const REASON_LABEL_KEYS: Record<string, string> = {
  "At least 15 minutes of active use in 30 days":
    "At least 15 minutes of active use in 30 days",
  "Member of a current project": "Member of a current project",
  "Has a current research report": "Has a current research report",
  "Has a current summary": "Has a current summary",
  "Pinned in the browser": "Pinned in the browser",
  "Has knowledge relations": "Has knowledge relations",
  "Has a shareable next action": "Has a shareable next action",
  "Has shareable project context": "Has shareable project context",
  "Confidence is below the active review threshold":
    "Confidence is below the active review threshold",
};

const MISSING_SIGNAL_LABEL_KEYS: Record<string, string> = {
  captured_content: "Captured content",
  active_use_30d_ms: "30-day active use",
  on_screen_30d_ms: "30-day on-screen time",
  has_current_research_report: "Current research report",
  has_current_summary: "Current summary",
  has_shareable_next_action: "Shareable next action",
  has_shareable_project_context: "Shareable project context",
  has_current_project_membership: "Current project membership",
  topic_paths: "Topic membership",
  workspace_names: "Workspace membership",
  is_pinned: "Pinned state",
  is_open: "Open state",
  status: "Page status",
  relation_count: "Knowledge relations",
  age_days: "Page age",
  last_seen_days: "Last-seen recency",
  has_captured_content: "Captured content",
  duplicate_physical_count: "Duplicate physical copies",
  resource_page_count: "Resource page count",
  resource_captured_page_count: "Captured Resource page count",
};

const EXCLUSION_LABEL_KEYS: Record<string, string> = {
  unsupported_url: "Unsupported URL",
  private_or_internal: "Private or internal page",
  user_excluded: "Excluded by a personal rule",
  policy_excluded: "Excluded by policy",
  insufficient_signals: "Insufficient signals",
  temporarily_unavailable: "Temporarily unavailable",
};

const BAND_LABEL_KEYS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const FEEDBACK_LABEL_KEYS: Record<PriorityFeedbackVerdict, string> = {
  accept: "Looks right",
  reject: "Not useful",
  too_high: "Too high",
  too_low: "Too low",
};

export const priorityShadowDynamicTranslationKeys = [
  ...Object.values(REASON_LABEL_KEYS),
  ...Object.values(MISSING_SIGNAL_LABEL_KEYS),
  ...Object.values(EXCLUSION_LABEL_KEYS),
  ...Object.values(BAND_LABEL_KEYS),
  ...Object.values(FEEDBACK_LABEL_KEYS),
] as const;

function subjectKey(subject: PrioritySubjectContract): string {
  return subject.type === "page"
    ? `page:${subject.logicalPageId}`
    : `resource:${subject.resourceId}`;
}

function idempotencyKey(subject: PrioritySubjectContract): string {
  const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `priority-feedback:${subjectKey(subject)}:${nonce}`;
}

function safeDetailStrings(detail: Record<string, unknown>): string[] {
  return Object.entries(detail)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`);
}

function priorityState(read: PrioritySafeRead) {
  const stale = !read.isCurrent || read.dirty;
  return {
    stale,
    excluded: read.outcome?.kind === "exclusion",
    unranked: read.outcome === null,
    needsReview: read.needsReview,
  };
}

function reasonLabel(
  reason: Extract<PrioritySafeRead["outcome"], { kind: "assessment" }>["assessment"]["reasons"][number],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (reason.code.startsWith("conflict:")) {
    return t("Conflicting rules were resolved deterministically.");
  }
  if (reason.code.startsWith("review:explicit:")) {
    return t("A personal rule requested review.");
  }
  return t(REASON_LABEL_KEYS[reason.label] ?? reason.label);
}

export function PriorityShadowSummary({
  read,
  userImportance,
}: {
  read: PrioritySafeRead | undefined;
  userImportance?: TabImportance | null;
}) {
  const { formatNumber, t } = useI18n();
  const userLabel = userImportance === undefined
    ? null
    : userImportance === null || userImportance === 0
      ? t("You: Unrated")
      : t("You: {importance}", { importance: userImportance });

  if (read === undefined) {
    return userLabel === null ? null : (
      <span className="priority-shadow-summary">
        <span className="priority-you">{userLabel}</span>
        <span className="priority-ai">{t("AI: Unranked")}</span>
      </span>
    );
  }

  const state = priorityState(read);
  const assessment = read.outcome?.kind === "assessment"
    ? read.outcome.assessment
    : null;
  const aiLabel = assessment === null
    ? state.excluded
      ? t("AI: Excluded")
      : t("AI: Unranked")
    : t("AI: {score}", { score: formatNumber(assessment.agentScore) });

  return (
    <span
      aria-label={userLabel === null ? aiLabel : `${userLabel}. ${aiLabel}.`}
      className="priority-shadow-summary"
    >
      {userLabel === null ? null : <span className="priority-you">{userLabel}</span>}
      <span className="priority-ai">{aiLabel}</span>
      <span className="priority-state-badges">
        {state.stale ? <span className="priority-state is-stale">{t("Stale")}</span> : null}
        {state.excluded ? <span className="priority-state is-excluded">{t("Excluded")}</span> : null}
        {state.unranked ? <span className="priority-state is-unranked">{t("Unranked")}</span> : null}
        {!state.stale && !state.excluded && !state.unranked ? (
          <span className="priority-state is-current">{t("Current")}</span>
        ) : null}
        {state.needsReview ? (
          <span className="priority-state is-review">{t("Needs review")}</span>
        ) : null}
      </span>
    </span>
  );
}

function PriorityReadDetails({
  read,
  showFeedback = false,
  userImportance,
}: {
  read: PrioritySafeRead;
  showFeedback?: boolean;
  userImportance?: TabImportance | null;
}) {
  const { formatDate, formatNumber, t } = useI18n();
  const state = priorityState(read);
  const outcome = read.outcome;

  return (
    <div className="priority-shadow-details">
      <PriorityShadowSummary
        read={read}
        {...(userImportance === undefined ? {} : { userImportance })}
      />
      {outcome === null ? (
        <p>{t("This subject has not been ranked yet.")}</p>
      ) : outcome.kind === "exclusion" ? (
        <div className="priority-exclusion">
          <strong>{t(EXCLUSION_LABEL_KEYS[outcome.exclusion.reason] ?? outcome.exclusion.reason)}</strong>
          <span>{t("No AI score is assigned to an excluded subject.")}</span>
          {safeDetailStrings(outcome.exclusion.detail).length > 0 ? (
            <ul aria-label={t("Exclusion details")}>
              {safeDetailStrings(outcome.exclusion.detail).map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <>
          <dl className="priority-score-details">
            <div>
              <dt>{t("AI band")}</dt>
              <dd>{t(BAND_LABEL_KEYS[outcome.assessment.agentBand] ?? outcome.assessment.agentBand)}</dd>
            </div>
            <div>
              <dt>{t("AI score")}</dt>
              <dd>{formatNumber(outcome.assessment.agentScore)} / 100</dd>
            </div>
            <div>
              <dt>{t("Confidence")}</dt>
              <dd>{formatNumber(Math.round(outcome.assessment.confidence * 100))}%</dd>
            </div>
            <div>
              <dt>{t("Evaluated")}</dt>
              <dd>{formatDate(outcome.assessment.evaluatedAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}</dd>
            </div>
          </dl>
          <div className="priority-explanation-block">
            <strong>{t("Why AI assigned this priority")}</strong>
            {outcome.assessment.reasons.length === 0 ? (
              <p>{t("No additional contributions were applied.")}</p>
            ) : (
              <ul>
                {outcome.assessment.reasons.map((reason) => (
                  <li key={reason.code}>
                    <span>{reasonLabel(reason, t)}</span>
                    {reason.scoreDelta === undefined ? null : (
                      <small>{t("{value} score", {
                        value: `${reason.scoreDelta >= 0 ? "+" : ""}${reason.scoreDelta}`,
                      })}</small>
                    )}
                    {reason.confidenceDelta === undefined ? null : (
                      <small>{t("{value} confidence", {
                        value: `${reason.confidenceDelta >= 0 ? "+" : ""}${formatNumber(
                          Math.round(reason.confidenceDelta * 100),
                        )}%`,
                      })}</small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="priority-explanation-block">
            <strong>{t("Missing signals")}</strong>
            {outcome.assessment.missingSignals.length === 0 ? (
              <p>{t("No expected signals are missing.")}</p>
            ) : (
              <ul>
                {outcome.assessment.missingSignals.map((signal) => (
                  <li key={signal}>{t(MISSING_SIGNAL_LABEL_KEYS[signal] ?? signal)}</li>
                ))}
              </ul>
            )}
          </div>
          {state.stale ? (
            <p className="priority-stale-note" role="note">
              {t("This explanation is stale and is shown only for review.")}
            </p>
          ) : null}
          {showFeedback && !state.stale ? (
            <PriorityFeedbackPanel
              assessmentId={outcome.assessment.id}
              key={outcome.assessment.id}
              subject={outcome.assessment.subject}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

export function PriorityShadowDetails({
  enabled,
  subject,
  userImportance,
}: {
  enabled: boolean;
  subject: PrioritySubjectContract | null;
  userImportance?: TabImportance | null;
}) {
  const { errorMessage, t } = useI18n();
  const query = useQuery({
    enabled: enabled && subject !== null,
    queryKey: ["priority", "shadow", subject === null ? "none" : subjectKey(subject)],
    queryFn: ({ signal }) => fetchPriorityReadBatch([subject!], signal),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  if (!enabled || subject === null) return null;

  return (
    <section className="priority-shadow-panel" aria-label={t("AI priority explanation")}>
      <div className="priority-shadow-heading">
        <h3>{t("AI priority")}</h3>
        <span>{t("Shadow only")}</span>
      </div>
      <p>{t("AI priority is separate from your importance and does not change Library order.")}</p>
      {query.isPending ? <span role="status">{t("Loading AI priority...")}</span> : null}
      {query.isError ? (
        <span className="priority-shadow-error">
          <span role="alert">{errorMessage(query.error)}</span>
          <button type="button" onClick={() => void query.refetch()}>{t("Try again")}</button>
        </span>
      ) : null}
      {query.isSuccess && query.data[0] ? (
        <PriorityReadDetails
          read={query.data[0]}
          showFeedback
          {...(userImportance === undefined ? {} : { userImportance })}
        />
      ) : null}
    </section>
  );
}

export function PriorityFeedbackPanel({
  assessmentId,
  subject,
}: {
  assessmentId: number;
  subject: PrioritySubjectContract;
}) {
  const { errorMessage, t } = useI18n();
  const [verdict, setVerdict] = useState<PriorityFeedbackVerdict>("accept");
  const [note, setNote] = useState("");
  const [attempt, setAttempt] = useState<PriorityFeedbackInput | null>(null);
  const feedbackId = useId();
  const mutation = useMutation({
    mutationFn: (input: PriorityFeedbackInput) =>
      submitPriorityFeedback(subject, input),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: PriorityFeedbackInput = {
      assessmentId,
      idempotencyKey: idempotencyKey(subject),
      verdict,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setAttempt(input);
    mutation.mutate(input);
  };

  return (
    <form className="priority-feedback" onSubmit={submit}>
      <strong>{t("Your feedback on this AI assessment")}</strong>
      <label>
        <span>{t("Feedback")}</span>
        <select
          disabled={mutation.isPending}
          value={verdict}
          onChange={(event) => setVerdict(event.target.value as PriorityFeedbackVerdict)}
        >
          {(Object.keys(FEEDBACK_LABEL_KEYS) as PriorityFeedbackVerdict[]).map((value) => (
            <option key={value} value={value}>{t(FEEDBACK_LABEL_KEYS[value])}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("Optional note")}</span>
        <textarea
          disabled={mutation.isPending}
          maxLength={4_096}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button disabled={mutation.isPending} type="submit">{t("Send feedback")}</button>
      <span aria-live="polite" id={feedbackId} role="status">
        {mutation.isSuccess ? t("Feedback saved.") : null}
      </span>
      {mutation.isError ? (
        <span className="priority-feedback-error">
          <span role="alert">{errorMessage(mutation.error)}</span>
          <button
            disabled={mutation.isPending || attempt === null}
            type="button"
            onClick={() => attempt && mutation.mutate(attempt)}
          >
            {t("Retry same feedback")}
          </button>
        </span>
      ) : null}
    </form>
  );
}

export function PriorityReviewQueue({ enabled }: { enabled: boolean }) {
  const { errorMessage, formatNumber, t } = useI18n();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    enabled: enabled && expanded,
    queryKey: ["priority", "review-queue", cursor ?? "first"],
    queryFn: ({ signal }) => fetchPriorityReviewQueue({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 50,
    }, signal),
    retry: false,
  });
  const pageNumber = cursors.length;
  const items = useMemo(
    () => query.isSuccess ? query.data.items : [],
    [query.data, query.isSuccess],
  );
  const nextCursor = query.isSuccess ? query.data.nextCursor : undefined;
  useEffect(() => {
    if (enabled) return;
    setExpanded(false);
    setCursors([undefined]);
    queryClient.removeQueries({ queryKey: ["priority", "review-queue"] });
  }, [enabled, queryClient]);
  if (!enabled) return null;

  return (
    <section className="priority-review-queue" aria-label={t("AI priority review queue")}>
      <button
        aria-expanded={expanded}
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        {t("Review AI priorities")}
      </button>
      {expanded ? (
        <div className="priority-review-body">
          <div className="priority-shadow-heading">
            <h3>{t("AI priority review queue")}</h3>
            <span>{t("Page {page}", { page: formatNumber(pageNumber) })}</span>
          </div>
          {query.isPending ? <span role="status">{t("Loading priority review queue...")}</span> : null}
          {query.isError ? (
            <span className="priority-shadow-error">
              <span role="alert">{errorMessage(query.error)}</span>
              <button type="button" onClick={() => void query.refetch()}>{t("Try again")}</button>
            </span>
          ) : null}
          {query.isSuccess && items.length === 0 ? (
            <p role="status">{t("No AI priorities need review.")}</p>
          ) : null}
          {items.length > 0 ? (
            <ol>
              {items.map((read) => (
                <li key={subjectKey(read.subject)}>
                  <details>
                    <summary>
                      <strong>
                        {read.subject.type === "page"
                          ? t("Page #{id}", { id: formatNumber(read.subject.logicalPageId) })
                          : t("Resource #{id}", { id: formatNumber(read.subject.resourceId) })}
                      </strong>
                      <PriorityShadowSummary read={read} />
                    </summary>
                    <PriorityReadDetails read={read} showFeedback />
                  </details>
                </li>
              ))}
            </ol>
          ) : null}
          <nav aria-label={t("Priority review queue pages")}>
            <button
              disabled={cursors.length <= 1 || query.isFetching}
              type="button"
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              {t("Previous")}
            </button>
            <button
              disabled={nextCursor === null || nextCursor === undefined || query.isFetching}
              type="button"
              onClick={() => {
                if (nextCursor !== null && nextCursor !== undefined) {
                  setCursors((value) => [...value, nextCursor]);
                }
              }}
            >
              {t("Next")}
            </button>
          </nav>
        </div>
      ) : null}
    </section>
  );
}

export function priorityReadMap(reads: readonly PrioritySafeRead[]) {
  return new Map(reads.map((read) => [subjectKey(read.subject), read]));
}

export function pagePriorityKey(logicalPageId: number): string {
  return subjectKey({ type: "page", logicalPageId });
}
