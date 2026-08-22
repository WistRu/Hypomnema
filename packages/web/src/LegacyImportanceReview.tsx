import {
  type LogicalPagePreference,
  type TabDetailResponse,
  type TabImportance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { fetchLogicalPageByTabId, setUserImportance } from "./api";
import { useI18n } from "./i18n";

interface LegacyImportanceReviewProps {
  headingId: string;
  tabId: number;
  onChanged?: ((importance: TabImportance) => void) | undefined;
}

interface ImportanceButtonsProps {
  busy: boolean;
  selected: TabImportance;
  onSelect: (importance: TabImportance) => void;
}

function ImportanceButtons({ busy, selected, onSelect }: ImportanceButtonsProps) {
  const { t } = useI18n();

  return (
    <div className="importance-choices">
      {([0, 1, 2, 3] as TabImportance[]).map((level) => (
        <button
          aria-label={
            level === 0
              ? t("Clear importance")
              : t("Set importance to {level} of 3", { level })
          }
          aria-pressed={selected === level}
          disabled={busy}
          key={level}
          type="button"
          onClick={() => onSelect(level)}
        >
          {level === 0 ? t("Clear") : level}
        </button>
      ))}
    </div>
  );
}

function preferenceDescription(
  preference: LogicalPagePreference,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (preference.userImportance === null) {
    return t("Current confirmed importance: Unrated.");
  }

  const current = t("Current confirmed importance: {level} of 3.", {
    level: preference.userImportance,
  });
  const date = formatDate(preference.importanceUpdatedAt, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const provenance =
    preference.recordedBy === "user"
      ? t("Set manually by you on {date}.", { date })
      : t("Recorded by an agent on your behalf on {date}.", { date });
  return `${current} ${provenance}`;
}

function browserLabel(browser: string) {
  switch (browser.toLowerCase()) {
    case "chrome":
      return "Chrome";
    case "edge":
      return "Edge";
    case "yandex":
      return "Yandex";
    default:
      return browser;
  }
}

export function LegacyImportanceReview({
  headingId,
  tabId,
  onChanged,
}: LegacyImportanceReviewProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatDate, t } = useI18n();
  const feedbackId = useId();
  const [feedback, setFeedback] = useState<string | null>(null);
  const logicalPageQuery = useQuery({
    queryKey: ["logical-page", { tabId }],
    queryFn: ({ signal }) => fetchLogicalPageByTabId(tabId, signal),
    retry: false,
  });

  useEffect(() => setFeedback(null), [tabId]);

  const importanceMutation = useMutation({
    mutationFn: (importance: TabImportance) =>
      setUserImportance([tabId], importance),
    onMutate: () => setFeedback(null),
    onSuccess: async (result) => {
      queryClient.setQueryData<TabDetailResponse | undefined>(
        ["tab", tabId],
        (tab) =>
          tab === undefined
            ? undefined
            : { ...tab, importance: result.importance },
      );
      setFeedback(t("Importance saved for all browser copies."));
      onChanged?.(result.importance);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["logical-page", { tabId }],
        }),
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
      ]);
    },
  });

  const view = logicalPageQuery.data;
  const audit = view?.legacyImportanceAudit;
  const pendingReview =
    audit?.resolutionState === "legacy_unknown" ||
    audit?.resolutionState === "conflict"
      ? audit
      : undefined;
  const selected = view?.preference.userImportance ?? 0;
  const description =
    view === undefined
      ? null
      : preferenceDescription(view.preference, formatDate, t);
  const reviewHeadingId = `${headingId}-legacy-importance`;

  return (
    <>
      <fieldset
        aria-describedby={feedbackId}
        aria-busy={
          logicalPageQuery.isFetching || importanceMutation.isPending
        }
        className="importance-editor logical-importance-editor"
      >
        <legend>{t("Importance")}</legend>
        <ImportanceButtons
          busy={view === undefined || importanceMutation.isPending}
          selected={selected}
          onSelect={(importance) => importanceMutation.mutate(importance)}
        />
        {description !== null && view?.preference.userImportance !== null ? (
          <span className="importance-provenance">{description}</span>
        ) : null}
        <span
          aria-live="polite"
          className="importance-feedback"
          id={feedbackId}
          role="status"
        >
          {feedback}
        </span>
        {importanceMutation.isError ? (
          <span className="drawer-error" role="alert">
            {errorMessage(importanceMutation.error)}
          </span>
        ) : null}
        {logicalPageQuery.isError ? (
          <span className="importance-load-error">
            <span className="drawer-error" role="alert">
              {errorMessage(logicalPageQuery.error)}
            </span>
            <button
              disabled={logicalPageQuery.isFetching}
              type="button"
              onClick={() => void logicalPageQuery.refetch()}
            >
              {t("Try again")}
            </button>
          </span>
        ) : null}
      </fieldset>

      {pendingReview !== undefined ? (
        <section
          aria-labelledby={reviewHeadingId}
          className="legacy-importance-review"
        >
          <div className="section-heading">
            <h3 id={reviewHeadingId}>{t("Previous importance needs review")}</h3>
            <span>{t("Needs review")}</span>
          </div>
          <p>
            {pendingReview.resolutionState === "legacy_unknown"
              ? t(
                  "Older TabHub data contains this importance, but its author is unknown. It stays unrated until you confirm it.",
                )
              : t(
                  "Browser copies disagree about importance. TabHub has not chosen a winner.",
                )}
          </p>
          <p className="importance-current">{description}</p>
          <h4>{t("Previous browser values")}</h4>
          <ul aria-label={t("Previous browser values")}>
            {pendingReview.legacyValues.map((source) => (
              <li key={source.tabId}>
                {t("{browser} · {value} · Tab #{id}", {
                  browser: browserLabel(source.browser),
                  id: source.tabId,
                  value: source.value === 0 ? t("Unrated") : source.value,
                })}
              </li>
            ))}
          </ul>
          {pendingReview.resolutionState === "legacy_unknown" &&
          pendingReview.suggestedValue !== null ? (
            <button
              className="primary-button"
              disabled={importanceMutation.isPending}
              type="button"
              onClick={() =>
                importanceMutation.mutate(pendingReview.suggestedValue!)
              }
            >
              {t("Confirm {level} of 3", {
                level: pendingReview.suggestedValue,
              })}
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
