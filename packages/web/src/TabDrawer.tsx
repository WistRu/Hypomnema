import {
  type CustomFields,
  type TabDetailResponse,
  type TabInstance,
  type TabLink,
  type TabStatus,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  assignTag,
  createLink,
  deleteLink,
  fetchCanonicalTabInstances,
  fetchFeatureFlags,
  fetchLinks,
  fetchLogicalPageResourceResolution,
  fetchResourceOpenTabs,
  fetchTabDetail,
  patchLink,
  patchTabDetails,
  unassignTag,
} from "./api";
import { ActivityMetrics, OpenCopyCount } from "./ActivityMetrics";
import { FeatureAwareImportanceEditor } from "./FeatureAwareImportanceEditor";
import { useI18n } from "./i18n";
import { PageSummaryCaptureControl } from "./PageSummaryCaptureControl";
import { PageRetentionActions } from "./PageRetentionActions";
import { PriorityShadowDetails } from "./PriorityShadow";
import { ResearchHistoryDrawer } from "./ResearchHistoryDrawer";
import { ResearchPanel } from "./ResearchPanel";
import { PersonalContextPanel } from "./PersonalContextPanel";
import { defaultTopicPath } from "./system-topics";
import { TabBrowserAction } from "./TabBrowserAction";
import { TopicPathInput } from "./TopicPathInput";
import type { CanonicalTabBrowserActionRequest } from "./open-tab-activation";
import { activateModalDialog } from "./modal-dialog";

const STATUS_OPTIONS: Array<{ labelKey: string; value: TabStatus }> = [
  { labelKey: "Inbox", value: "inbox" },
  { labelKey: "In progress", value: "in_progress" },
  { labelKey: "Done", value: "done" },
  { labelKey: "Archived", value: "archived" },
];

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  yandex: "Yandex",
};

interface TabDrawerProps {
  activationError?: string | undefined;
  activationInProgress?: boolean | undefined;
  closeInProgress?: boolean | undefined;
  isActivating?: boolean | undefined;
  tabId: number;
  onBrowserAction: (request: CanonicalTabBrowserActionRequest) => void;
  onClose: () => void;
  onMiddleClose?: ((canonicalTabId: number) => void) | undefined;
  onReviewResourceResolution?: ((logicalPageId: number) => void) | undefined;
}

function displayTitle(tab: TabDetailResponse) {
  if (tab.title?.trim()) return tab.title.trim();

  try {
    return new URL(tab.url).hostname;
  } catch {
    return tab.url;
  }
}

function instanceLocation(
  tab: TabInstance,
  formatNumber: (value: number) => string,
  t: ReturnType<typeof useI18n>["t"],
) {
  const tabLabel =
    tab.browserTabId === null
      ? t("unknown tab")
      : t("tab {tabId}", { tabId: formatNumber(tab.browserTabId) });
  return t("Window {windowId} | position {position} | {tab}", {
    position: formatNumber(tab.index + 1),
    tab: tabLabel,
    windowId: formatNumber(tab.windowId),
  });
}

function SectionError({ error }: { error: unknown }) {
  const { errorMessage } = useI18n();
  return (
    <p className="drawer-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

function ContentText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const { formatNumber, t } = useI18n();
  const limit = 20_000;
  const isLong = text.length > limit;
  const visibleText = isLong && !expanded ? `${text.slice(0, limit)}\n\n...` : text;

  return (
    <div className="captured-content">
      <pre>{visibleText}</pre>
      {isLong ? (
        <button type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded
            ? t("Show compact view")
            : t("Show all {count} characters", {
                count: formatNumber(text.length),
              })}
        </button>
      ) : null}
    </div>
  );
}

interface CustomFieldRowProps {
  fieldKey: string;
  value: string | null;
  isSaving: boolean;
  onDelete: (fieldKey: string) => void;
  onSave: (fields: CustomFields) => void;
}

function CustomFieldRow({
  fieldKey,
  value,
  isSaving,
  onDelete,
  onSave,
}: CustomFieldRowProps) {
  const [draft, setDraft] = useState(value ?? "");
  const { t } = useI18n();

  useEffect(() => setDraft(value ?? ""), [value]);

  return (
    <form
      className="field-row"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ [fieldKey]: draft });
      }}
    >
      <label>
        <span>{fieldKey}</span>
        <input
          aria-label={t("Value for {field}", { field: fieldKey })}
          disabled={isSaving}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button disabled={isSaving || draft === (value ?? "")} type="submit">
        {t("Save")}
      </button>
      <button
        className="danger-button"
        disabled={isSaving}
        type="button"
        onClick={() => onDelete(fieldKey)}
      >
        {t("Delete")}
      </button>
    </form>
  );
}

interface LinkRowProps {
  link: TabLink;
  currentTabId: number;
  isSaving: boolean;
  onDelete: (id: number) => void;
  onSave: (id: number, kind: string, note: string | null) => void;
}

function LinkRow({
  link,
  currentTabId,
  isSaving,
  onDelete,
  onSave,
}: LinkRowProps) {
  const [kind, setKind] = useState(link.kind);
  const [note, setNote] = useState(link.note ?? "");
  const { formatNumber, t } = useI18n();
  const isOutgoing = link.fromTab === currentTabId;
  const relatedTab = isOutgoing ? link.toTab : link.fromTab;
  const changed = kind !== link.kind || note !== (link.note ?? "");

  useEffect(() => {
    setKind(link.kind);
    setNote(link.note ?? "");
  }, [link.kind, link.note]);

  return (
    <form
      className="link-row"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(link.id, kind.trim(), note.trim() || null);
      }}
    >
      <div className="link-direction">
        <span>{isOutgoing ? t("Outgoing") : t("Incoming")}</span>
        <strong>{t("Tab #{id}", { id: formatNumber(relatedTab) })}</strong>
        <span className={`provenance-badge is-${link.createdBy}`}>
          {link.createdBy === "agent" ? t("Agent") : t("User")}
        </span>
      </div>
      <label>
        <span>{t("Kind")}</span>
        <input
          disabled={isSaving}
          maxLength={128}
          required
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        />
      </label>
      <label>
        <span>{t("Note")}</span>
        <input
          disabled={isSaving}
          maxLength={2_048}
          placeholder={t("Optional context")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="link-actions">
        <button disabled={isSaving || !changed || !kind.trim()} type="submit">
          {t("Save link")}
        </button>
        <button
          className="danger-button"
          disabled={isSaving}
          type="button"
          onClick={() => onDelete(link.id)}
        >
          {t("Delete")}
        </button>
      </div>
    </form>
  );
}

export function TabDrawer({
  activationError,
  activationInProgress = false,
  closeInProgress = false,
  isActivating = false,
  tabId,
  onBrowserAction,
  onClose,
  onMiddleClose,
  onReviewResourceResolution,
}: TabDrawerProps) {
  const queryClient = useQueryClient();
  const { formatDate, formatNumber, t } = useI18n();
  const headingId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const [tagPath, setTagPath] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [linkDirection, setLinkDirection] = useState<"outgoing" | "incoming">(
    "outgoing",
  );
  const [relatedTabId, setRelatedTabId] = useState("");
  const [linkKind, setLinkKind] = useState("related");
  const [linkNote, setLinkNote] = useState("");
  const [contextScopeRequest, setContextScopeRequest] = useState<{
    instanceId: number;
    nonce: number;
  } | null>(null);

  const detailQuery = useQuery({
    queryKey: ["tab", tabId],
    queryFn: ({ signal }) => fetchTabDetail(tabId, signal),
  });
  const linksQuery = useQuery({
    queryKey: ["links", tabId],
    queryFn: ({ signal }) => fetchLinks(tabId, signal),
  });
  const instancesQuery = useQuery({
    queryKey: ["tab-instances", { canonicalTabId: tabId }],
    queryFn: ({ signal }) => fetchCanonicalTabInstances(tabId, signal),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
  });
  const featuresQuery = useQuery({
    queryKey: ["features"],
    queryFn: ({ signal }) => fetchFeatureFlags(signal),
    staleTime: 30_000,
  });
  const contextEnabled = featuresQuery.data?.context === true;
  const pageSummaryCaptureEnabled =
    featuresQuery.isSuccess && featuresQuery.data?.pageSummaryCapture === true;
  const priorityShadowEnabled =
    featuresQuery.isSuccess &&
    featuresQuery.data?.priorityReaders === true &&
    (featuresQuery.data?.priorityShadow === true ||
      featuresQuery.data?.priorityPersonalization === true);
  const researchEnabled = featuresQuery.isSuccess && featuresQuery.data?.research === true;
  const researchLogicalPageId = detailQuery.data?.logicalPageId;
  const resourceResolutionQuery = useQuery({
    enabled: researchEnabled && Number.isSafeInteger(researchLogicalPageId) &&
      (researchLogicalPageId ?? 0) > 0,
    queryKey: ["resource-resolution", researchLogicalPageId],
    queryFn: ({ signal }) => fetchLogicalPageResourceResolution(researchLogicalPageId!, signal),
  });
  const resolvedResearchResource = resourceResolutionQuery.data?.state === "resolved" &&
      resourceResolutionQuery.data.researchEligible
    ? resourceResolutionQuery.data.resource
    : null;
  const resourceResearchUnavailableKey = resourceResolutionQuery.data?.state === "unmatched"
    ? "Resource research unavailable: this page is not assigned to a Resource."
    : resourceResolutionQuery.data?.state === "ambiguous"
      ? "Resource research unavailable: this page matches multiple Resources."
      : resourceResolutionQuery.data?.state === "excluded"
        ? "Resource research unavailable: this page is excluded from Resources."
        : resourceResolutionQuery.data?.state === "resolved" &&
            !resourceResolutionQuery.data.researchEligible
          ? "Resource research unavailable: this Resource is not eligible."
          : null;
  const resourceResearchInstancesQuery = useQuery({
    enabled: resolvedResearchResource !== null,
    queryKey: ["tab-instances", "resource-research", resolvedResearchResource?.id],
    queryFn: ({ signal }) => fetchResourceOpenTabs(resolvedResearchResource!.id, signal),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
  });

  const refreshTab = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tab", tabId] }),
      queryClient.invalidateQueries({ queryKey: ["links", tabId] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["graph"] }),
    ]);
  };

  const patchMutation = useMutation({
    mutationFn: (patch: Parameters<typeof patchTabDetails>[1]) =>
      patchTabDetails(tabId, patch),
    onSuccess: (tab) => {
      queryClient.setQueryData(["tab", tabId], tab);
      void refreshTab();
    },
  });
  const assignMutation = useMutation({
    mutationFn: (path: string) => assignTag([tabId], path),
    onSuccess: () => {
      setTagPath("");
      void refreshTab();
    },
  });
  const unassignMutation = useMutation({
    mutationFn: (tagId: number) => unassignTag(tabId, tagId),
    onSuccess: () => void refreshTab(),
  });
  const createLinkMutation = useMutation({
    mutationFn: (input: Parameters<typeof createLink>[0]) => createLink(input),
    onSuccess: () => {
      setRelatedTabId("");
      setLinkNote("");
      void refreshTab();
    },
  });
  const patchLinkMutation = useMutation({
    mutationFn: ({
      id,
      kind,
      note,
    }: {
      id: number;
      kind: string;
      note: string | null;
    }) => patchLink(id, { kind, note }),
    onSuccess: () => void refreshTab(),
  });
  const deleteLinkMutation = useMutation({
    mutationFn: deleteLink,
    onSuccess: () => void refreshTab(),
  });

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const deactivate = drawer.current
      ? activateModalDialog(drawer.current, previouslyFocused, onClose)
      : () => undefined;
    return () => {
      document.body.style.overflow = previousOverflow;
      deactivate();
    };
  }, [onClose, tabId]);

  const tab = detailQuery.data;
  const priorityLogicalPageId = tab === undefined
    ? null
    : tab.logicalPageId;
  const prioritySubject =
    Number.isSafeInteger(priorityLogicalPageId) && (priorityLogicalPageId ?? 0) > 0
      ? { type: "page" as const, logicalPageId: priorityLogicalPageId! }
      : null;
  const openCopyCount = instancesQuery.data?.length ?? tab?.openInstanceCount ?? 0;
  const openForegroundTimeMs =
    instancesQuery.data?.reduce(
      (total, instance) => total + instance.foregroundTimeMs,
      0,
    ) ?? tab?.openForegroundTimeMs ?? 0;
  const openEngagedTimeMs =
    instancesQuery.data?.reduce(
      (total, instance) => total + instance.engagedTimeMs,
      0,
    ) ?? tab?.openEngagedTimeMs ?? 0;
  const mutationError =
    patchMutation.error ??
    assignMutation.error ??
    unassignMutation.error ??
    createLinkMutation.error ??
    patchLinkMutation.error ??
    deleteLinkMutation.error;
  const linkBusy =
    createLinkMutation.isPending ||
    patchLinkMutation.isPending ||
    deleteLinkMutation.isPending;

  const createNewLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const relatedId = Number(relatedTabId);
    if (!Number.isSafeInteger(relatedId) || relatedId <= 0 || relatedId === tabId) {
      return;
    }

    const common = {
      kind: linkKind.trim(),
      createdBy: "user" as const,
      ...(linkNote.trim() ? { note: linkNote.trim() } : {}),
    };
    createLinkMutation.mutate(
      linkDirection === "outgoing"
        ? { ...common, from: tabId, to: relatedId }
        : { ...common, from: relatedId, to: tabId },
    );
  };

  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) onClose();
  };

  return (
    <div className="drawer-backdrop" onMouseDown={closeOnBackdrop}>
      <aside
        aria-labelledby={headingId}
        aria-modal="true"
        className="tab-drawer"
        ref={drawer}
        role="dialog"
      >
        <header className="drawer-header">
          <div>
            <p>{t("Tab details | #{id}", { id: formatNumber(tabId) })}</p>
            <h2 id={headingId}>
              {tab ? displayTitle(tab) : t("Tab #{id}", { id: formatNumber(tabId) })}
            </h2>
          </div>
          <button
            aria-label={t("Close tab details")}
            className="icon-button"
            ref={closeButton}
            type="button"
            onClick={onClose}
          >
            X
          </button>
        </header>

        {detailQuery.isPending ? (
          <div className="drawer-state" role="status">
            <span className="spinner" aria-hidden="true" />
            {t("Loading tab details")}
          </div>
        ) : null}
        {detailQuery.isError ? (
          <div className="drawer-state">
            <SectionError error={detailQuery.error} />
            <button type="button" onClick={() => void detailQuery.refetch()}>
              {t("Try again")}
            </button>
          </div>
        ) : null}

        {tab ? (
          <div className="drawer-body">
            <section className="drawer-overview">
              <TabBrowserAction
                activationError={activationError}
                activationInProgress={activationInProgress}
                className="primary-link"
                closeInProgress={closeInProgress}
                isActivating={isActivating}
                tab={tab}
                onBrowserAction={onBrowserAction}
                onMiddleClose={onMiddleClose}
              />
              <p className="drawer-url" title={tab.url}>
                {tab.url}
              </p>
              <PersonalContextPanel
                exactScopeRequest={contextScopeRequest}
                instances={instancesQuery.data ?? []}
                instancesError={instancesQuery.error}
                instancesPending={instancesQuery.isPending}
                tabId={tabId}
              />
              <div className="editor-grid">
                <label>
                  <span>{t("Status")}</span>
                  <select
                    disabled={patchMutation.isPending}
                    value={tab.status}
                    onChange={(event) =>
                      patchMutation.mutate({ status: event.target.value as TabStatus })
                    }
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <FeatureAwareImportanceEditor
                  headingId={headingId}
                  legacyBusy={patchMutation.isPending}
                  legacyImportance={tab.importance}
                  tabId={tabId}
                  onCanonicalChanged={() => void refreshTab()}
                  onLegacySelect={(importance) =>
                    patchMutation.mutate({ importance })
                  }
                />
              </div>
              <PriorityShadowDetails
                enabled={priorityShadowEnabled}
                subject={prioritySubject}
                userImportance={tab.importance}
              />
              {prioritySubject ? (
                <ResearchHistoryDrawer
                  captureInstances={instancesQuery.data ?? []}
                  captureInstancesState={instancesQuery.isPending ? "pending" : instancesQuery.isError ? "error" : "ready"}
                  onRetryCaptureInstances={() => void instancesQuery.refetch()}
                  researchEnabled={researchEnabled}
                  target={prioritySubject}
                  onRefresh={async () => {
                    await Promise.all([detailQuery.refetch(), instancesQuery.refetch()]);
                  }}
                />
              ) : null}
              {researchEnabled && prioritySubject ? (
                <ResearchPanel
                  captureInstances={instancesQuery.data ?? []}
                  captureInstancesState={instancesQuery.isPending ? "pending" : instancesQuery.isError ? "error" : "ready"}
                  entryLabel="Research this page"
                  onRetryCaptureInstances={() => void instancesQuery.refetch()}
                  target={prioritySubject}
                  onRefresh={async () => {
                    await Promise.all([detailQuery.refetch(), instancesQuery.refetch()]);
                  }}
                />
              ) : null}
              {resolvedResearchResource ? (
                <>
                  <ResearchHistoryDrawer
                    captureInstances={resourceResearchInstancesQuery.data ?? []}
                    captureInstancesState={resourceResearchInstancesQuery.isPending ? "pending" : resourceResearchInstancesQuery.isError ? "error" : "ready"}
                    onRetryCaptureInstances={() => void resourceResearchInstancesQuery.refetch()}
                    researchEnabled={researchEnabled}
                    target={{ type: "resource", resourceId: resolvedResearchResource.id }}
                    onRefresh={async () => {
                      await Promise.all([
                        resourceResolutionQuery.refetch(),
                        resourceResearchInstancesQuery.refetch(),
                      ]);
                    }}
                  />
                  {researchEnabled ? (
                    <ResearchPanel
                      captureInstances={resourceResearchInstancesQuery.data ?? []}
                      captureInstancesState={resourceResearchInstancesQuery.isPending ? "pending" : resourceResearchInstancesQuery.isError ? "error" : "ready"}
                      entryLabel="Research this resource"
                      onRetryCaptureInstances={() => void resourceResearchInstancesQuery.refetch()}
                      target={{ type: "resource", resourceId: resolvedResearchResource.id }}
                      onRefresh={async () => {
                        await Promise.all([
                          resourceResolutionQuery.refetch(),
                          resourceResearchInstancesQuery.refetch(),
                        ]);
                      }}
                    />
                  ) : null}
                </>
              ) : null}
              {researchEnabled && resourceResearchUnavailableKey ? (
                <div className="muted-copy" role="status">
                  <p>{t(resourceResearchUnavailableKey)}</p>
                  {(resourceResolutionQuery.data?.state === "unmatched" ||
                    resourceResolutionQuery.data?.state === "ambiguous") &&
                    onReviewResourceResolution && priorityLogicalPageId ? (
                    <button type="button" onClick={() =>
                      onReviewResourceResolution(priorityLogicalPageId)}>
                      {t("Review Resource assignment")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {mutationError ? <SectionError error={mutationError} /> : null}
            </section>

            <section
              className="drawer-section"
              aria-labelledby={`${headingId}-retention`}
            >
              <div className="section-heading">
                <h3 id={`${headingId}-retention`}>{t("Page retention")}</h3>
              </div>
              <PageRetentionActions tabId={tabId} onForgotten={onClose} />
            </section>

            <section
              className="drawer-section"
              aria-labelledby={`${headingId}-page-activity`}
            >
              <div className="section-heading">
                <h3 id={`${headingId}-page-activity`}>{t("Page activity")}</h3>
              </div>
              {tab.foregroundTimeMs > 0 ? (
                <div className="drawer-activity-summary">
                  <p>{t("Accumulated for this page across tracked browser sessions.")}</p>
                  <ActivityMetrics
                    engagedTimeMs={tab.engagedTimeMs}
                    foregroundTimeMs={tab.foregroundTimeMs}
                  />
                </div>
              ) : (
                <p className="muted-copy">{t("No recorded activity")}</p>
              )}
            </section>

            <section
              className="drawer-section"
              aria-labelledby={`${headingId}-open-copies`}
            >
              <div className="section-heading">
                <h3 id={`${headingId}-open-copies`}>{t("Open copies")}</h3>
                <span>
                  <OpenCopyCount count={openCopyCount} />
                </span>
              </div>
              {openCopyCount > 0 ? (
                <>
                  <div className="drawer-activity-summary">
                    <p>{t("Combined across currently open physical copies.")}</p>
                    <ActivityMetrics
                      engagedTimeMs={openEngagedTimeMs}
                      foregroundTimeMs={openForegroundTimeMs}
                    />
                  </div>
                  <p className="drawer-activity-note">
                    {t(
                      "Activity is tracked separately for each physical tab in its current browser session.",
                    )}
                  </p>
                </>
              ) : null}
              {instancesQuery.isPending ? (
                <p className="muted-copy">{t("Loading open copies...")}</p>
              ) : null}
              {instancesQuery.isError ? <SectionError error={instancesQuery.error} /> : null}
              {instancesQuery.data?.length === 0 ? (
                <p className="muted-copy">
                  {t("No open copies in the current browser session.")}
                </p>
              ) : null}
              {instancesQuery.data && instancesQuery.data.length > 0 ? (
                <ul className="drawer-activity-copies">
                  {instancesQuery.data.map((instance) => {
                    const installationLabel = instance.installationId.slice(0, 8);
                    return (
                      <li className="drawer-activity-copy" key={instance.instanceId}>
                        <div className="drawer-copy-identity">
                          <strong>{instance.title?.trim() || displayTitle(tab)}</strong>
                          <span>
                            {BROWSER_LABELS[instance.browser.toLowerCase()] ??
                              (instance.browser.toLowerCase() === "other"
                                ? t("Other")
                                : instance.browser)}{" "}
                            ·{" "}
                            <span title={instance.installationId}>
                              {t("Installation {id}", { id: installationLabel })}
                            </span>
                          </span>
                          <span>{instanceLocation(instance, formatNumber, t)}</span>
                          {contextEnabled &&
                          instance.browserSessionId !== null &&
                          instance.browserTabId !== null ? (
                            <button
                              aria-label={t(
                                "Use exact context for {title} in {browser}, window {windowId}, tab {tabId}",
                                {
                                  browser:
                                    BROWSER_LABELS[instance.browser.toLowerCase()] ??
                                    (instance.browser.toLowerCase() === "other"
                                      ? t("Other")
                                      : instance.browser),
                                  tabId: formatNumber(instance.browserTabId),
                                  title: instance.title?.trim() || displayTitle(tab),
                                  windowId: formatNumber(instance.windowId),
                                },
                              )}
                              className="context-open-copy-action"
                              type="button"
                              onClick={() =>
                                setContextScopeRequest({
                                  instanceId: instance.instanceId,
                                  nonce: Date.now(),
                                })
                              }
                            >
                              {t("Only this open tab")}
                            </button>
                          ) : null}
                        </div>
                        <ActivityMetrics
                          engagedTimeMs={instance.engagedTimeMs}
                          foregroundTimeMs={instance.foregroundTimeMs}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>

            <section className="drawer-section" aria-labelledby={`${headingId}-summary`}>
              <div className="section-heading">
                <h3 id={`${headingId}-summary`}>{t("Summary")}</h3>
                {tab.content?.summaryModel ? <span>{tab.content.summaryModel}</span> : null}
              </div>
              <p className="summary-copy">
                {tab.content?.summary?.trim() ||
                  tab.summary?.trim() ||
                  t("No summary yet.")}
              </p>
              {pageSummaryCaptureEnabled ? (
                <PageSummaryCaptureControl
                  canonicalTabId={tabId}
                  detail={tab}
                  instances={instancesQuery.data ?? []}
                  instancesPending={instancesQuery.isPending}
                  key={tabId}
                  refetchInstances={() => instancesQuery.refetch()}
                  refetchTabDetail={() => detailQuery.refetch()}
                />
              ) : null}
            </section>

            <section className="drawer-section" aria-labelledby={`${headingId}-tags`}>
              <div className="section-heading">
                <h3 id={`${headingId}-tags`}>{t("Topics")}</h3>
                <span>{formatNumber(tab.tags.length)}</span>
              </div>
              {tab.tags.length > 0 ? (
                <ul className="tag-pills">
                  {tab.tags.map((tag) => {
                    const isDefaultTopic = tag.path === defaultTopicPath;
                    const displayPath = isDefaultTopic ? t("No topic") : tag.path;

                    return (
                      <li key={tag.id}>
                        <span>{displayPath}</span>
                        <span className={`provenance-badge is-${tag.assignedBy}`}>
                          {tag.assignedBy === "agent" ? t("Agent") : t("User")}
                        </span>
                        {!isDefaultTopic ? (
                          <button
                            aria-label={t("Remove {topic}, assigned by {source}", {
                              source:
                                tag.assignedBy === "agent" ? t("Agent") : t("User"),
                              topic: tag.path,
                            })}
                            disabled={unassignMutation.isPending}
                            title={t("Assigned by {source}", {
                              source:
                                tag.assignedBy === "agent" ? t("Agent") : t("User"),
                            })}
                            type="button"
                            onClick={() => unassignMutation.mutate(tag.id)}
                          >
                            X
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted-copy">{t("No topics assigned.")}</p>
              )}
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (tagPath.trim()) assignMutation.mutate(tagPath.trim());
                }}
              >
                <label>
                  <span>{t("Topic path")}</span>
                  <TopicPathInput
                    disabled={assignMutation.isPending}
                    placeholder={t("Research/AI/Agents")}
                    required
                    value={tagPath}
                    onChange={setTagPath}
                  />
                </label>
                <button disabled={assignMutation.isPending || !tagPath.trim()} type="submit">
                  {t("Assign topic")}
                </button>
              </form>
            </section>

            <section className="drawer-section" aria-labelledby={`${headingId}-fields`}>
              <div className="section-heading">
                <h3 id={`${headingId}-fields`}>{t("Custom fields")}</h3>
                <span>{formatNumber(Object.keys(tab.customFields).length)}</span>
              </div>
              <div className="field-list">
                {Object.entries(tab.customFields).map(([key, value]) => (
                  <CustomFieldRow
                    fieldKey={key}
                    isSaving={patchMutation.isPending}
                    key={key}
                    value={value}
                    onDelete={(deleteKey) =>
                      patchMutation.mutate({ customFields: { [deleteKey]: null } })
                    }
                    onSave={(fields) => patchMutation.mutate({ customFields: fields })}
                  />
                ))}
              </div>
              <form
                className="new-field-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const key = fieldKey.trim();
                  if (!key) return;
                  patchMutation.mutate(
                    { customFields: { [key]: fieldValue } },
                    {
                      onSuccess: () => {
                        setFieldKey("");
                        setFieldValue("");
                      },
                    },
                  );
                }}
              >
                <label>
                  <span>{t("Field name")}</span>
                  <input
                    disabled={patchMutation.isPending}
                    maxLength={128}
                    placeholder={t("owner")}
                    required
                    value={fieldKey}
                    onChange={(event) => setFieldKey(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("Value")}</span>
                  <input
                    disabled={patchMutation.isPending}
                    maxLength={8_192}
                    placeholder={t("Optional value")}
                    value={fieldValue}
                    onChange={(event) => setFieldValue(event.target.value)}
                  />
                </label>
                <button disabled={patchMutation.isPending || !fieldKey.trim()} type="submit">
                  {t("Add field")}
                </button>
              </form>
            </section>

            <section className="drawer-section" aria-labelledby={`${headingId}-links`}>
              <div className="section-heading">
                <h3 id={`${headingId}-links`}>{t("Links")}</h3>
                <span>{formatNumber(linksQuery.data?.items.length ?? 0)}</span>
              </div>
              {linksQuery.isPending ? (
                <p className="muted-copy">{t("Loading links...")}</p>
              ) : null}
              {linksQuery.isError ? <SectionError error={linksQuery.error} /> : null}
              <div className="link-list">
                {linksQuery.data?.items.map((link) => (
                  <LinkRow
                    currentTabId={tabId}
                    isSaving={linkBusy}
                    key={link.id}
                    link={link}
                    onDelete={(id) => deleteLinkMutation.mutate(id)}
                    onSave={(id, kind, note) =>
                      patchLinkMutation.mutate({ id, kind, note })
                    }
                  />
                ))}
              </div>
              <form className="new-link-form" onSubmit={createNewLink}>
                <label>
                  <span>{t("Direction")}</span>
                  <select
                    disabled={linkBusy}
                    value={linkDirection}
                    onChange={(event) =>
                      setLinkDirection(event.target.value as "outgoing" | "incoming")
                    }
                  >
                    <option value="outgoing">{t("This tab to target")}</option>
                    <option value="incoming">{t("Source to this tab")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("Related tab ID")}</span>
                  <input
                    disabled={linkBusy}
                    inputMode="numeric"
                    min="1"
                    placeholder="42"
                    required
                    type="number"
                    value={relatedTabId}
                    onChange={(event) => setRelatedTabId(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("Kind")}</span>
                  <input
                    disabled={linkBusy}
                    maxLength={128}
                    required
                    value={linkKind}
                    onChange={(event) => setLinkKind(event.target.value)}
                  />
                </label>
                <label className="link-note-field">
                  <span>{t("Note")}</span>
                  <input
                    disabled={linkBusy}
                    maxLength={2_048}
                    placeholder={t("Why are these tabs connected?")}
                    value={linkNote}
                    onChange={(event) => setLinkNote(event.target.value)}
                  />
                </label>
                <button
                  disabled={
                    linkBusy ||
                    !linkKind.trim() ||
                    !Number.isSafeInteger(Number(relatedTabId)) ||
                    Number(relatedTabId) <= 0 ||
                    Number(relatedTabId) === tabId
                  }
                  type="submit"
                >
                  {t("Create link")}
                </button>
              </form>
            </section>

            <section className="drawer-section" aria-labelledby={`${headingId}-content`}>
              <div className="section-heading">
                <h3 id={`${headingId}-content`}>{t("Captured content")}</h3>
                {tab.content?.extractedAt ? (
                  <time dateTime={tab.content.extractedAt}>
                    {formatDate(tab.content.extractedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                ) : null}
              </div>
              {tab.content?.text ? (
                <ContentText text={tab.content.text} />
              ) : (
                <p className="muted-copy">{t("No captured content.")}</p>
              )}
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
