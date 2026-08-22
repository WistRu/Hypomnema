import type {
  ResourceReviewQueueItem,
  ResourceSummary,
  TabImportance,
  TabStatus,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  changeResource,
  fetchResourceReviewQueue,
  fetchResources,
  setResourceUserEvaluation,
  type ResourceListFilters,
} from "./api";
import { useI18n } from "./i18n";
import { ManualPriorityRating } from "./ManualPriorityRating";
import {
  applyResourceEvaluationBulk,
  type ResourceEvaluationBulkReceipt,
} from "./resource-priority-bulk";
import "./ResourceSidebar.css";

export interface SelectedResource {
  id: number;
  name: string;
}

interface ResourceSidebarProps {
  filters: {
    browser: string;
    importance: "all" | TabImportance;
    q: string;
    status: "all" | TabStatus;
    tag: string;
    priorityMode?: ResourceListFilters["priorityMode"];
    needsReview?: boolean;
  };
  manualPriorityEnabled?: boolean;
  selectedResource: SelectedResource | null;
  onSelectResource: (resource: SelectedResource | null) => void;
  reviewRequest?: { logicalPageId: number; nonce: number } | null;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function resourceFilters(filters: ResourceSidebarProps["filters"]): ResourceListFilters {
  return { browser: filters.browser, importance: filters.importance, q: filters.q,
    status: filters.status, tag: filters.tag, page: 1, pageSize: 100,
    ...(filters.priorityMode === undefined ? {} : { priorityMode: filters.priorityMode }),
    ...(filters.needsReview === undefined ? {} : { needsReview: filters.needsReview }) };
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function reviewResourceName(
  resourceId: number,
  resources: ResourceSummary[],
): string {
  return resources.find(({ resource }) => resource.id === resourceId)?.resource.name ??
    `#${resourceId}`;
}

function ReviewItem({
  item,
  resources,
  onResolved,
}: {
  item: ResourceReviewQueueItem;
  resources: ResourceSummary[];
  onResolved: () => void;
}) {
  const { errorMessage, t } = useI18n();
  const [targetId, setTargetId] = useState("");
  const host = hostname(item.urlNormalized);
  const missingCandidateIds = item.candidateResourceIds.filter(
    (resourceId) => !resources.some(({ resource }) => resource.id === resourceId),
  );
  const resolveMutation = useMutation({
    mutationFn: async (mode: "existing" | "create") => {
      let resourceId: number;
      if (mode === "existing") {
        resourceId = Number(targetId);
        if (!Number.isSafeInteger(resourceId) || resourceId < 1) {
          throw new Error(t("Choose a valid Resource ID."));
        }
      } else {
        if (!host) throw new Error(t("This address cannot become a resource automatically."));
        const created = await changeResource({
          kind: "create",
          resourceKey: `website:${host}`,
          name: host,
          resourceKind: "website",
          accessClass: item.reason === "weak_sensitive_signal" ? "sensitive" : "public",
          idempotencyKey: idempotencyKey("resource-create"),
        });
        if (created.result.kind !== "create") throw new Error(t("Unexpected resource update."));
        resourceId = created.result.resource.resource.id;
      }
      return changeResource({
        kind: "apply_override",
        logicalPageId: item.logicalPageId,
        resourceId,
        expectedAssignmentId: item.currentAssignmentId,
        idempotencyKey: idempotencyKey("resource-override"),
      });
    },
    onSuccess: onResolved,
  });

  return (
    <li className="resource-review-item" id={`resource-review-page-${item.logicalPageId}`} tabIndex={-1}>
      <strong>{item.state === "ambiguous" ? t("Ambiguous") : t("Unmatched")}</strong>
      <span dir="ltr" title={item.urlNormalized}>{item.urlNormalized}</span>
      {item.candidateResourceIds.length > 0 ? (
        <small>
          {t("Candidates: {names}", {
            names: item.candidateResourceIds
              .map((id) => reviewResourceName(id, resources))
              .join(", "),
          })}
        </small>
      ) : null}
      <label>
        <span>{t("Assign manually")}</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">{t("Choose a resource")}</option>
          {resources.map(({ resource }) => (
            <option key={resource.id} value={resource.id}>{resource.name}</option>
          ))}
          {missingCandidateIds.map((resourceId) => (
            <option key={resourceId} value={resourceId}>#{resourceId}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("Resource ID")}</span>
        <input
          inputMode="numeric"
          min={1}
          pattern="[0-9]+"
          type="number"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
        />
      </label>
      <div>
        <button
          disabled={!targetId || resolveMutation.isPending}
          type="button"
          onClick={() => resolveMutation.mutate("existing")}
        >
          {t("Apply override")}
        </button>
        <button
          disabled={!host || resolveMutation.isPending}
          type="button"
          onClick={() => resolveMutation.mutate("create")}
        >
          {t("Create and assign {host}", { host: host || t("resource") })}
        </button>
      </div>
      {resolveMutation.isError ? (
        <span className="resource-sidebar-error" role="alert">
          {errorMessage(resolveMutation.error)}
        </span>
      ) : null}
    </li>
  );
}

export function ResourceSidebar({
  filters,
  manualPriorityEnabled = false,
  selectedResource,
  onSelectResource,
  reviewRequest = null,
}: ResourceSidebarProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatNumber, t } = useI18n();
  const [showReview, setShowReview] = useState(false);
  const [resourcePage, setResourcePage] = useState(1);
  const [reviewPage, setReviewPage] = useState(1);
  const [checkedResourceIds, setCheckedResourceIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [bulkReceipt, setBulkReceipt] = useState<ResourceEvaluationBulkReceipt | null>(null);
  const baseFilters = useMemo(() => resourceFilters(filters), [
    filters.browser,
    filters.importance,
    filters.q,
    filters.status,
    filters.tag,
    filters.priorityMode,
    filters.needsReview,
  ]);
  const normalizedFilters = useMemo(
    () => ({ ...baseFilters, page: resourcePage }),
    [baseFilters, resourcePage],
  );
  useEffect(() => setResourcePage(1), [baseFilters]);
  useEffect(() => {
    if (reviewRequest === null) return;
    setShowReview(true);
    setReviewPage(1);
  }, [reviewRequest?.nonce]);
  useEffect(() => {
    setCheckedResourceIds(new Set());
    setBulkReceipt(null);
  }, [baseFilters, resourcePage]);
  const resourcesQuery = useQuery({
    queryKey: ["resources", normalizedFilters],
    queryFn: ({ signal }) => fetchResources(normalizedFilters, signal),
  });
  const reviewQuery = useQuery({
    enabled: showReview,
    queryKey: ["resources", "review-queue", reviewPage],
    queryFn: ({ signal }) => fetchResourceReviewQueue(reviewPage, 50, signal),
  });
  const reviewLocationQuery = useQuery({
    enabled: showReview && reviewRequest !== null,
    queryKey: ["resources", "review-location", reviewRequest?.logicalPageId, reviewRequest?.nonce],
    queryFn: async ({ signal }) => {
      let page = 1;
      let maximumPage = 1;
      while (page <= maximumPage) {
        const result = await fetchResourceReviewQueue(page, 50, signal);
        if (page === 1) maximumPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (result.items.some(({ logicalPageId }) =>
          logicalPageId === reviewRequest!.logicalPageId)) return page;
        page += 1;
      }
      return null;
    },
  });
  useEffect(() => {
    if (reviewLocationQuery.data !== undefined && reviewLocationQuery.data !== null) {
      setReviewPage(reviewLocationQuery.data);
    }
  }, [reviewLocationQuery.data]);
  useEffect(() => {
    if (reviewRequest === null || !reviewQuery.data?.items.some(({ logicalPageId }) =>
      logicalPageId === reviewRequest.logicalPageId)) return;
    document.getElementById(`resource-review-page-${reviewRequest.logicalPageId}`)?.focus();
  }, [reviewQuery.data, reviewRequest?.logicalPageId, reviewRequest?.nonce]);
  const reviewResourcesQuery = useQuery({
    enabled: showReview,
    queryKey: ["resources", "review-targets"],
    queryFn: ({ signal }) => fetchResources({
      browser: "all",
      importance: "all",
      page: 1,
      pageSize: 200,
      q: "",
      status: "all",
      tag: "",
    }, signal),
  });
  const resources = resourcesQuery.data?.items ?? [];
  const bulkEvaluationMutation = useMutation({
    mutationFn: (evaluation: 1 | 2 | 3 | null) => applyResourceEvaluationBulk({
      visibleResources: resources,
      checkedResourceIds,
      evaluation,
      operationId: idempotencyKey("resource-evaluation-bulk"),
      update: setResourceUserEvaluation,
    }),
    onSuccess: async (receipt) => {
      setBulkReceipt(receipt);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      ]);
    },
  });
  const checkedResources = resources.filter(({ resource }) =>
    resource.lifecycleState === "active" && checkedResourceIds.has(resource.id));
  const checkedLogicalPageCount = checkedResources.reduce((sum, item) =>
    sum + item.counts.logicalPageCount, 0);
  const reviewResources = reviewResourcesQuery.data?.items ?? resources;
  const refreshAfterResolution = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["resources"] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
    ]);
  };

  return (
    <aside className="resource-sidebar" aria-labelledby="resource-sidebar-title">
      <div className="resource-sidebar-heading">
        <div>
          <p>{t("Organize")}</p>
          <h2 id="resource-sidebar-title">{t("Resources")}</h2>
        </div>
        {resourcesQuery.isFetching ? <span className="resource-mini-spinner" aria-hidden="true" /> : null}
      </div>
      <nav aria-label={t("Filter tabs by resource") }>
        <button
          aria-current={selectedResource === null ? "page" : undefined}
          className="resource-all-button"
          type="button"
          onClick={() => onSelectResource(null)}
        >
          {t("All resources")}
        </button>
        <ul className="resource-list">
          {resources.map(({ counts, resource }) => (
            <li key={resource.id}>
              {manualPriorityEnabled && resource.lifecycleState === "active" ? <input
                aria-label={t("Select {resource} for bulk evaluation", {
                  resource: resource.name,
                })}
                checked={checkedResourceIds.has(resource.id)}
                type="checkbox"
                onChange={(event) => setCheckedResourceIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(resource.id);
                  else next.delete(resource.id);
                  return next;
                })}
              /> : null}
              <button
                aria-current={selectedResource?.id === resource.id ? "page" : undefined}
                type="button"
                onClick={() => onSelectResource({ id: resource.id, name: resource.name })}
              >
                <span>{resource.name}</span>
                <small title={t("Logical pages")}>{formatNumber(counts.logicalPageCount)}</small>
              </button>
            </li>
          ))}
        </ul>
        {manualPriorityEnabled && checkedResources.length > 0 ? (
          <div className="resource-evaluation-bulk" aria-label={t("Bulk Resource evaluation")}>
            <p>{t("{resources} Resources, {pages} logical pages", {
              resources: formatNumber(checkedResources.length),
              pages: formatNumber(checkedLogicalPageCount),
            })}</p>
            <ManualPriorityRating
              busy={bulkEvaluationMutation.isPending}
              labels={{ group: t("Set evaluation for selected Resources"), clear: t("Clear"),
                level: (value) => t("Set evaluation to {level} of 3", { level: value }) }}
              value={null}
              onChange={(value) => bulkEvaluationMutation.mutate(value)}
            />
            {bulkReceipt !== null ? <p aria-live="polite">
              {t("Resource bulk result: {succeeded} succeeded, {failed} failed, {unknown} unknown; {pages} logical pages.", {
                succeeded: formatNumber(bulkReceipt.succeeded),
                failed: formatNumber(bulkReceipt.failed),
                unknown: formatNumber(bulkReceipt.outcomeUnknown),
                pages: formatNumber(bulkReceipt.logicalPageCount),
              })}
            </p> : null}
            {bulkEvaluationMutation.isError ? <p role="alert">
              {errorMessage(bulkEvaluationMutation.error)}
            </p> : null}
          </div>
        ) : null}
        {resourcesQuery.isPending ? <p role="status">{t("Loading resources...")}</p> : null}
        {resourcesQuery.isError ? (
          <div className="resource-sidebar-error" role="alert">
            <span>{errorMessage(resourcesQuery.error)}</span>
            <button type="button" onClick={() => void resourcesQuery.refetch()}>{t("Retry")}</button>
          </div>
        ) : null}
        {resourcesQuery.isSuccess && resources.length === 0 ? (
          <p>{t("No resources match the active filters.")}</p>
        ) : null}
        {resourcesQuery.data && resourcesQuery.data.total > resourcesQuery.data.pageSize ? (
          <div className="resource-pagination" aria-label={t("Resource list pages")} role="group">
            <button
              disabled={resourcePage <= 1 || resourcesQuery.isFetching}
              type="button"
              onClick={() => setResourcePage((page) => Math.max(1, page - 1))}
            >
              {t("Previous")}
            </button>
            <span>{t("Page {page}", { page: formatNumber(resourcePage) })}</span>
            <button
              disabled={resourcePage * resourcesQuery.data.pageSize >= resourcesQuery.data.total || resourcesQuery.isFetching}
              type="button"
              onClick={() => setResourcePage((page) => page + 1)}
            >
              {t("Next")}
            </button>
          </div>
        ) : null}
      </nav>
      <button
        aria-expanded={showReview}
        className="resource-review-toggle"
        type="button"
        onClick={() => setShowReview((current) => !current)}
      >
        {t("Classification review")}
      </button>
      {showReview ? (
        <section aria-label={t("Unmatched and ambiguous pages")} className="resource-review-queue">
          <p>{t("Nothing is assigned until you choose explicitly.")}</p>
          {reviewRequest ? <p role="status">{t("Reviewing Resource assignment for page {id}.", {
            id: formatNumber(reviewRequest.logicalPageId),
          })}</p> : null}
          {reviewLocationQuery.isPending ? <p role="status">{t("Locating the requested review page...")}</p> : null}
          {reviewLocationQuery.isSuccess && reviewLocationQuery.data === null ? (
            <p className="resource-sidebar-error" role="alert">
              {t("The requested page is no longer in classification review.")}
            </p>
          ) : null}
          {reviewLocationQuery.isError ? (
            <p className="resource-sidebar-error" role="alert">{errorMessage(reviewLocationQuery.error)}</p>
          ) : null}
          {reviewQuery.isPending ? <p role="status">{t("Loading review queue...")}</p> : null}
          {reviewQuery.isError ? (
            <p className="resource-sidebar-error" role="alert">{errorMessage(reviewQuery.error)}</p>
          ) : null}
          {reviewResourcesQuery.isError ? (
            <p className="resource-sidebar-error" role="alert">{errorMessage(reviewResourcesQuery.error)}</p>
          ) : null}
          <ul>
            {reviewQuery.data?.items.map((item) => (
              <ReviewItem
                item={item}
                key={item.logicalPageId}
                resources={reviewResources}
                onResolved={() => void refreshAfterResolution()}
              />
            ))}
          </ul>
          {reviewQuery.isSuccess && reviewQuery.data.items.length === 0 ? (
            <p>{t("No pages need classification review.")}</p>
          ) : null}
          {reviewQuery.data && reviewQuery.data.total > reviewQuery.data.pageSize ? (
            <div className="resource-pagination" aria-label={t("Classification review pages")} role="group">
              <button
                disabled={reviewPage <= 1 || reviewQuery.isFetching}
                type="button"
                onClick={() => setReviewPage((page) => Math.max(1, page - 1))}
              >
                {t("Previous")}
              </button>
              <span>{t("Page {page}", { page: formatNumber(reviewPage) })}</span>
              <button
                disabled={reviewPage * reviewQuery.data.pageSize >= reviewQuery.data.total || reviewQuery.isFetching}
                type="button"
                onClick={() => setReviewPage((page) => page + 1)}
              >
                {t("Next")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
