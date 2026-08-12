import type {
  RetentionReason,
  RetentionWarning,
  TabListItem,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  fetchRetentionReview,
  fetchRetentionTrash,
  forgetRetentionTab,
  restoreRetentionTab,
  setRetentionDecision,
} from "./api";
import { useI18n, type TranslationParams } from "./i18n";
import {
  retentionBlockedMessageKey,
  RETENTION_FORGET_CONFIRMATION,
} from "./retention-ui";

export type RetentionCollection = "review" | "trash";

interface PageRetentionPanelProps {
  collection: RetentionCollection;
  onSelectTab: (tabId: number) => void;
}

const REASON_LABELS: Record<RetentionReason, string> = {
  closed: "Closed page",
  search_results: "Search results page",
  no_captured_content: "No captured content",
  no_engaged_activity: "No confirmed interaction",
  no_custom_fields: "No custom fields",
  no_links: "No links",
};

function displayTitle(tab: TabListItem): string {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url;
  }
}

function warningLabel(
  warning: RetentionWarning,
  t: (key: string, params?: TranslationParams) => string,
): string {
  switch (warning.kind) {
    case "open_instances":
      return t("Open copies: {count}", { count: warning.count });
    case "pinned":
      return t("Pinned copies: {count}", { count: warning.count });
    case "workspace":
      return t("Saved workspaces: {count}", { count: warning.count });
    case "links":
      return t("Links: {count}", { count: warning.count });
    case "captured_content":
      return t("Captured content");
  }
}

export function PageRetentionPanel({
  collection,
  onSelectTab,
}: PageRetentionPanelProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatDate, formatNumber, t } = useI18n();
  const [page, setPage] = useState(1);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
    setActionError(null);
  }, [collection]);

  const reviewQuery = useQuery({
    enabled: collection === "review",
    queryKey: ["retention", "review", page],
    queryFn: ({ signal }) => fetchRetentionReview(page, signal),
  });
  const trashQuery = useQuery({
    enabled: collection === "trash",
    queryKey: ["retention", "trash", page],
    queryFn: ({ signal }) => fetchRetentionTrash(page, signal),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retention"] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({ queryKey: ["tab"] }),
      queryClient.invalidateQueries({ queryKey: ["tab-instances"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["graph"] }),
    ]);
  };

  const decisionMutation = useMutation({
    mutationFn: ({
      decision,
      tabId,
    }: {
      decision: "keep" | "later";
      tabId: number;
    }) => setRetentionDecision(tabId, decision),
    onMutate: ({ tabId }) => {
      setActiveTabId(tabId);
      setActionError(null);
    },
    onSuccess: () => void refresh(),
    onError: (error) => setActionError(errorMessage(error)),
    onSettled: () => setActiveTabId(null),
  });

  const forgetMutation = useMutation({
    mutationFn: (tabId: number) => forgetRetentionTab(tabId),
    onMutate: (tabId) => {
      setActiveTabId(tabId);
      setActionError(null);
    },
    onSuccess: (result) => {
      if (result.outcome === "trashed") {
        void refresh();
        return;
      }
      const baseMessage = t(retentionBlockedMessageKey(result.reason));
      setActionError(
        result.closedInstanceCount > 0
          ? `${baseMessage} ${t(
              "{count} copies were already closed; the page remains in the Library.",
              { count: formatNumber(result.closedInstanceCount) },
            )}`
          : baseMessage,
      );
      void refresh();
    },
    onError: (error) => setActionError(errorMessage(error)),
    onSettled: () => setActiveTabId(null),
  });

  const restoreMutation = useMutation({
    mutationFn: (tabId: number) => restoreRetentionTab(tabId),
    onMutate: (tabId) => {
      setActiveTabId(tabId);
      setActionError(null);
    },
    onSuccess: () => void refresh(),
    onError: (error) => setActionError(errorMessage(error)),
    onSettled: () => setActiveTabId(null),
  });

  const query = collection === "review" ? reviewQuery : trashQuery;
  const busy =
    decisionMutation.isPending ||
    forgetMutation.isPending ||
    restoreMutation.isPending;
  const totalPages = query.data
    ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize))
    : 1;

  useEffect(() => {
    if (query.data && page > totalPages) setPage(totalPages);
  }, [page, query.data, totalPages]);

  const confirmForget = (tabId: number) => {
    const confirmed = window.confirm(t(RETENTION_FORGET_CONFIRMATION));
    if (confirmed) forgetMutation.mutate(tabId);
  };

  return (
    <div className="retention-panel">
      <header className="retention-panel-header">
        <div>
          <h2>
            {collection === "review"
              ? t("Pages suggested for review")
              : t("Trash")}
          </h2>
          <p>
            {collection === "review"
              ? t(
                  "Suggestions use weak signals and your explicit decisions. Nothing is deleted automatically.",
                )
              : t(
                  "Forgotten pages stay here for 7 days before permanent deletion.",
                )}
          </p>
        </div>
        {query.data ? (
          <span className="retention-count">
            {t("{count} pages", { count: formatNumber(query.data.total) })}
          </span>
        ) : null}
      </header>

      {actionError ? (
        <p aria-label={actionError} className="retention-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {query.isPending ? (
        <div className="retention-state" role="status">
          <span aria-hidden="true" className="spinner" />
          {t("Loading retention collection")}
        </div>
      ) : null}
      {query.isError ? (
        <p className="retention-error" role="alert">
          {errorMessage(query.error)}
        </p>
      ) : null}
      {query.data?.total === 0 ? (
        <div className="retention-state">
          <strong>
            {collection === "review"
              ? t("No pages need review.")
              : t("Trash is empty.")}
          </strong>
        </div>
      ) : null}

      {collection === "review" &&
      reviewQuery.data &&
      reviewQuery.data.items.length > 0 ? (
        <ul className="retention-list">
          {reviewQuery.data.items.map((candidate) => (
                <li className="retention-card" key={candidate.tab.id}>
                  <div className="retention-card-main">
                    <button
                      className="retention-title"
                      id={`retention-title-${candidate.tab.id}`}
                      type="button"
                      onClick={() => onSelectTab(candidate.tab.id)}
                    >
                      {displayTitle(candidate.tab)}
                    </button>
                    <span className="retention-url" title={candidate.tab.url}>
                      {candidate.tab.url}
                    </span>
                    <div className="retention-signals">
                      <span className="retention-signal-label">
                        {t("Why suggested")}
                      </span>
                      {candidate.reasons.map((reason) => (
                        <span className="retention-chip" key={reason}>
                          {t(REASON_LABELS[reason])}
                        </span>
                      ))}
                    </div>
                    {candidate.warnings.length > 0 ? (
                      <div className="retention-warnings">
                        {candidate.warnings.map((warning) => (
                          <span
                            className="retention-chip is-warning"
                            key={warning.kind}
                          >
                            {warningLabel(warning, t)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="retention-actions">
                    <button
                      aria-label={t("Keep {title}", {
                        title: displayTitle(candidate.tab),
                      })}
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        decisionMutation.mutate({
                          decision: "keep",
                          tabId: candidate.tab.id,
                        })
                      }
                    >
                      {t("Keep")}
                    </button>
                    <button
                      aria-label={t("Review {title} later", {
                        title: displayTitle(candidate.tab),
                      })}
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        decisionMutation.mutate({
                          decision: "later",
                          tabId: candidate.tab.id,
                        })
                      }
                    >
                      {t("Later")}
                    </button>
                    <button
                      aria-label={t("Close and forget {title}", {
                        title: displayTitle(candidate.tab),
                      })}
                      className="danger-button"
                      disabled={busy}
                      type="button"
                      onClick={() => confirmForget(candidate.tab.id)}
                    >
                      {activeTabId === candidate.tab.id && forgetMutation.isPending
                        ? t("Closing copies...")
                        : t("Close and forget")}
                    </button>
                  </div>
                </li>
              ))}
        </ul>
      ) : null}

      {collection === "trash" &&
      trashQuery.data &&
      trashQuery.data.items.length > 0 ? (
        <ul className="retention-list">
          {trashQuery.data.items.map((item) => (
                <li className="retention-card" key={item.tab.id}>
                  <div className="retention-card-main">
                    <button
                      className="retention-title"
                      id={`retention-title-${item.tab.id}`}
                      type="button"
                      onClick={() => onSelectTab(item.tab.id)}
                    >
                      {displayTitle(item.tab)}
                    </button>
                    <span className="retention-url" title={item.tab.url}>
                      {item.tab.url}
                    </span>
                    <span className="retention-purge-date">
                      {t("Permanently deleted {date}", {
                        date: formatDate(item.purgeAt),
                      })}
                    </span>
                  </div>
                  <div className="retention-actions">
                    <button
                      aria-label={t("Restore {title}", {
                        title: displayTitle(item.tab),
                      })}
                      disabled={busy}
                      type="button"
                      onClick={() => restoreMutation.mutate(item.tab.id)}
                    >
                      {t("Restore")}
                    </button>
                  </div>
                </li>
              ))}
        </ul>
      ) : null}

      {query.data && totalPages > 1 ? (
        <nav aria-label={t("Retention pagination")} className="pagination">
          <span>
            {t("Page {page} of {total}", {
              page: formatNumber(page),
              total: formatNumber(totalPages),
            })}
          </span>
          <div>
            <button
              disabled={page <= 1 || query.isFetching}
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t("Previous")}
            </button>
            <button
              disabled={page >= totalPages || query.isFetching}
              type="button"
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              {t("Next")}
            </button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
