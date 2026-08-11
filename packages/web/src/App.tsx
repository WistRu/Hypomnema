import {
  knownBrowserOptions,
  type TabImportance,
  type TabInstance,
  type TabListItem,
  type TabStatus,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  assignTag,
  enqueueShortSummary,
  fetchAllLibraryTabIds,
  fetchLibraryOpenTabs,
  fetchSummaryJob,
  fetchTabs,
  updateTabStatuses,
  type LibraryTabFilters,
  type OpenFilter,
} from "./api";
import { ActivityMetrics } from "./ActivityMetrics";
import {
  LibraryPhysicalCopies,
  physicalTabAccessibleLabel,
} from "./LibraryPhysicalCopies";
import { LibraryPhysicalTabActions } from "./LibraryPhysicalTabActions";
import {
  effectiveLibraryOpenCopyCount,
  reconcileLibraryPhysicalSelection,
  retainLibraryPhysicalSelectionForContext,
  setLibraryCanonicalRowsSelected,
  setLibraryPhysicalInstanceSelected,
  type LibraryPhysicalSelection,
  type LibraryPhysicalSelectionContext,
} from "./library-physical-selection";
import { TabBrowserAction } from "./TabBrowserAction";
import { useI18n, type TranslationParams } from "./i18n";
import {
  handleMiddleClickClose,
  preventMiddleClickAutoscroll,
} from "./middle-click-close";
import {
  shouldRefreshLibrary,
  type WorkspaceView,
} from "./workspace-view";
import { TabDrawer } from "./TabDrawer";
import { TopicPathInput } from "./TopicPathInput";
import { TopicSidebar, type SelectedTopic } from "./TopicSidebar";
import { useCanonicalTabActivation } from "./use-canonical-tab-activation";
import { useSingleTabClose } from "./use-single-tab-close";

const GraphView = lazy(() => import("./GraphView"));

const EMPTY_TABS: TabListItem[] = [];
const EMPTY_TAB_INSTANCES: TabInstance[] = [];
const EMPTY_PHYSICAL_SELECTION: LibraryPhysicalSelection = new Map();
const tableFeatureSet = tableFeatures({});
const columnHelper = createColumnHelper<typeof tableFeatureSet, TabListItem>();
const CurrentTimeContext = createContext(Date.now());
type LibrarySelectionMode = "canonical" | "physical";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  yandex: "Yandex",
};

const STATUS_LABEL_KEYS: Record<TabStatus, string> = {
  inbox: "Inbox",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

function browserLabel(
  browser: string,
  t: (key: string, params?: TranslationParams) => string,
) {
  const normalized = browser.toLowerCase();
  return BROWSER_LABELS[normalized] ?? (normalized === "other" ? t("Other") : browser);
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatAge(
  value: string,
  now: number,
  t: (key: string, params?: TranslationParams) => string,
) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return t("Unknown");

  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;

  if (elapsed < minute) return t("Just now");
  if (elapsed < hour) return t("{count}m ago", { count: Math.floor(elapsed / minute) });
  if (elapsed < day) return t("{count}h ago", { count: Math.floor(elapsed / hour) });
  if (elapsed < day * 30) return t("{count}d ago", { count: Math.floor(elapsed / day) });
  if (elapsed < day * 365) {
    return t("{count}mo ago", { count: Math.floor(elapsed / (day * 30)) });
  }
  return t("{count}y ago", { count: Math.floor(elapsed / (day * 365)) });
}

function RelativeAge({ value }: { value: string }) {
  const now = useContext(CurrentTimeContext);
  const { formatDate, t } = useI18n();
  const date = new Date(value);
  const title = Number.isNaN(date.getTime())
    ? value
    : formatDate(date, { dateStyle: "medium", timeStyle: "short" });
  return (
    <time dateTime={value} title={title}>
      {formatAge(value, now, t)}
    </time>
  );
}

function useDebouncedValue(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debouncedValue;
}

function BrowserBadge({ browser }: { browser: string }) {
  const { t } = useI18n();
  const normalized = browser.toLowerCase();
  return (
    <span className="browser-badge">
      <span className={`browser-dot browser-${normalized}`} aria-hidden="true" />
      <span>{browserLabel(browser, t)}</span>
    </span>
  );
}

function Importance({ level }: { level: number }) {
  const { t } = useI18n();
  return (
    <span className="importance" aria-label={t("Importance {level} of 3", { level })}>
      {[1, 2, 3].map((step) => (
        <span
          aria-hidden="true"
          className={step <= level ? "importance-dot is-active" : "importance-dot"}
          key={step}
        />
      ))}
    </span>
  );
}

function SelectionCheckbox({
  checked,
  disabled = false,
  indeterminate = false,
  label,
  onChange,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  onClick?: (event: MouseEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      aria-label={label}
      checked={checked}
      disabled={disabled}
      className="selection-checkbox"
      ref={ref}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
      onClick={onClick}
    />
  );
}

function SummaryDisclosure({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const { t } = useI18n();

  return (
    <div className={expanded ? "summary-disclosure is-expanded" : "summary-disclosure"}>
      <p id={summaryId}>{summary}</p>
      <button
        aria-controls={summaryId}
        aria-expanded={expanded}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((current) => !current);
        }}
      >
        {expanded ? t("Collapse") : t("Expand")}
      </button>
    </div>
  );
}

function SummaryAction({ tab }: { tab: TabListItem }) {
  const queryClient = useQueryClient();
  const { errorMessage: localizeError, t } = useI18n();
  const [jobId, setJobId] = useState<number | null>(null);
  const feedbackId = useId();
  const tabLabel = tab.title?.trim() || hostname(tab.url);
  const hasSummary = Boolean(tab.summary?.trim());
  const enqueueMutation = useMutation({
    mutationFn: () => enqueueShortSummary(tab.id),
    onMutate: () => setJobId(null),
    onSuccess: (result) => setJobId(result.jobId),
  });
  const jobQuery = useQuery({
    queryKey: ["summary-job", jobId],
    queryFn: ({ signal }) => fetchSummaryJob(jobId!, signal),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_500 : false;
    },
  });
  const job = jobQuery.data;
  const jobStatus = job?.status ?? enqueueMutation.data?.status;

  useEffect(() => {
    if (job?.status === "succeeded") {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab", tab.id] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
      ]);
    }
  }, [job?.id, job?.status, queryClient, tab.id]);

  const pollingError = jobQuery.isError ? localizeError(jobQuery.error) : null;
  const errorMessage = enqueueMutation.isError
    ? localizeError(enqueueMutation.error)
    : job?.status === "failed"
      ? job.error
        ? localizeError(new Error(job.error))
        : t("TabHub could not create this summary.")
      : pollingError;
  const statusMessage = enqueueMutation.isPending
    ? t("Requesting summary")
    : jobStatus === "queued"
      ? t("Summary queued")
      : jobStatus === "running"
        ? t("Creating summary")
        : jobStatus === "succeeded"
          ? t("Summary ready")
          : null;
  const isActive = jobStatus === "queued" || jobStatus === "running";
  const isStatusRetry = pollingError !== null && jobId !== null;
  const defaultLabel = hasSummary
    ? t("Refresh short summary")
    : t("Create short summary");
  const buttonLabel = isStatusRetry
    ? t("Check summary status")
    : errorMessage
      ? t("Retry short summary")
      : defaultLabel;
  const feedback = errorMessage ?? statusMessage;

  return (
    <div className="summary-action" onClick={(event) => event.stopPropagation()}>
      <button
        aria-describedby={feedback ? feedbackId : undefined}
        aria-label={t("{action} for {tab}", { action: buttonLabel, tab: tabLabel })}
        disabled={enqueueMutation.isPending || (isActive && !isStatusRetry)}
        type="button"
        onClick={() => {
          if (isStatusRetry) {
            void jobQuery.refetch();
          } else {
            enqueueMutation.mutate();
          }
        }}
      >
        {buttonLabel}
      </button>
      {errorMessage ? (
        <span className="summary-feedback is-error" id={feedbackId} role="alert">
          {errorMessage}
        </span>
      ) : statusMessage ? (
        <span className="summary-feedback" id={feedbackId} role="status">
          {isActive ? <span aria-hidden="true" /> : null}
          {statusMessage}
        </span>
      ) : null}
    </div>
  );
}

function Mark() {
  return (
    <div className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function FilterIcon() {
  return (
    <svg className="filter-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 5.25h14M5.5 10h9M8 14.75h4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="4.75" />
      <path d="m12.25 12.25 3.75 3.75" />
    </svg>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const { errorMessage: localizeError, formatNumber, locale, setLocale, t } =
    useI18n();
  const canonicalTabActivation = useCanonicalTabActivation();
  const singleTabClose = useSingleTabClose();
  const [view, setView] = useState<WorkspaceView>("library");
  const [browser, setBrowser] = useState("all");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [openState, setOpenState] = useState<OpenFilter>("all");
  const [status, setStatus] = useState<"all" | TabStatus>("all");
  const [importance, setImportance] = useState<"all" | TabImportance>("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<SelectedTopic | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [selectionMode, setSelectionMode] =
    useState<LibrarySelectionMode>("canonical");
  const [physicalSelection, setPhysicalSelection] =
    useState<LibraryPhysicalSelection>(() => new Map());
  const [expandedPhysicalRows, setExpandedPhysicalRows] = useState<Set<number>>(
    () => new Set(),
  );
  const [bulkStatus, setBulkStatus] = useState<TabStatus>("in_progress");
  const [bulkTag, setBulkTag] = useState("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const statusOptions = Object.entries(STATUS_LABEL_KEYS).map(([value, key]) => [
    value as TabStatus,
    t(key),
  ] as const);
  const debouncedSearch = useDebouncedValue(search, 300);
  const q = debouncedSearch.trim();
  const tag = selectedTopic?.path ?? "";
  const libraryFilters: LibraryTabFilters = {
    browser,
    duplicatesOnly,
    importance,
    openState,
    q,
    status,
    tag,
  };
  const libraryFilterKey = JSON.stringify(libraryFilters);
  const libraryFilterKeyRef = useRef(libraryFilterKey);
  libraryFilterKeyRef.current = libraryFilterKey;

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [libraryFilterKey, selectionMode]);

  useEffect(() => {
    if (view !== "library") setPhysicalSelection(new Map());
  }, [view]);

  useEffect(() => {
    setExpandedPhysicalRows(new Set());
  }, [libraryFilterKey]);

  const previousPhysicalSelectionContext = useRef<LibraryPhysicalSelectionContext>({
    filterKey: libraryFilterKey,
    mode: selectionMode,
  });
  useEffect(() => {
    const nextContext: LibraryPhysicalSelectionContext = {
      filterKey: libraryFilterKey,
      mode: selectionMode,
    };
    setPhysicalSelection((current) =>
      retainLibraryPhysicalSelectionForContext(
        current,
        previousPhysicalSelectionContext.current,
        nextContext,
      ),
    );
    previousPhysicalSelectionContext.current = nextContext;
  }, [libraryFilterKey, selectionMode]);

  const tabsQuery = useQuery({
    queryKey: [
      "tabs",
      { browser, duplicatesOnly, importance, openState, page, q, status, tag },
    ],
    queryFn: ({ signal }) =>
      fetchTabs(
        { browser, duplicatesOnly, importance, openState, page, q, status, tag },
        signal,
      ),
    refetchInterval: view === "library" ? 15_000 : false,
    refetchOnWindowFocus: view === "library" ? "always" : false,
  });
  const libraryOpenTabsQuery = useQuery({
    enabled: view === "library",
    queryKey: ["tab-instances", "library", libraryFilters],
    queryFn: ({ signal }) => fetchLibraryOpenTabs(libraryFilters, signal),
    refetchInterval: view === "library" ? 15_000 : false,
    refetchOnWindowFocus: view === "library" ? "always" : false,
  });

  useEffect(() => {
    if (libraryOpenTabsQuery.isError) {
      setPhysicalSelection(new Map());
      return;
    }
    if (libraryOpenTabsQuery.data === undefined) return;
    setPhysicalSelection((current) =>
      reconcileLibraryPhysicalSelection(current, libraryOpenTabsQuery.data),
    );
  }, [libraryOpenTabsQuery.data, libraryOpenTabsQuery.isError]);
  const selectAllLibraryMutation = useMutation({
    mutationFn: ({ filters }: { filters: LibraryTabFilters; filterKey: string }) =>
      fetchAllLibraryTabIds(filters),
    onSuccess: (ids, { filterKey }) => {
      if (filterKey === libraryFilterKeyRef.current) {
        setSelectedIds(new Set(ids));
      }
    },
  });
  const selectView = (nextView: WorkspaceView) => {
    if (shouldRefreshLibrary(view, nextView)) {
      void tabsQuery.refetch();
    }
    if (nextView !== "library") {
      setSelectionMode("canonical");
    }
    setView(nextView);
  };
  const bulkStatusMutation = useMutation({
    mutationFn: () => updateTabStatuses([...selectedIds], bulkStatus),
    onSuccess: async () => {
      setSelectedIds(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
      ]);
    },
  });
  const bulkTagMutation = useMutation({
    mutationFn: () => assignTag([...selectedIds], bulkTag.trim()),
    onSuccess: async () => {
      setSelectedIds(new Set());
      setBulkTag("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
      ]);
    },
  });

  const tabs = tabsQuery.data?.items ?? EMPTY_TABS;
  const libraryPhysicalResolutionAvailable =
    libraryOpenTabsQuery.data !== undefined && !libraryOpenTabsQuery.isError;
  const libraryOpenTabs = libraryPhysicalResolutionAvailable
    ? libraryOpenTabsQuery.data
    : EMPTY_TAB_INSTANCES;
  const effectivePhysicalSelection = libraryPhysicalResolutionAvailable
    ? physicalSelection
    : EMPTY_PHYSICAL_SELECTION;
  const instancesByCanonicalTab = useMemo(() => {
    const grouped = new Map<number, TabInstance[]>();
    for (const instance of libraryOpenTabs) {
      const instances = grouped.get(instance.canonicalTabId);
      if (instances === undefined) grouped.set(instance.canonicalTabId, [instance]);
      else instances.push(instance);
    }
    return grouped;
  }, [libraryOpenTabs]);
  const visibleIds = tabs.map((tabItem) => tabItem.id);
  const visiblePhysicalTabs = tabs.flatMap(
    ({ id }) => instancesByCanonicalTab.get(id) ?? EMPTY_TAB_INSTANCES,
  );
  const visibleCanonicalSelected = visibleIds.filter((id) => selectedIds.has(id)).length;
  const visiblePhysicalSelected = visiblePhysicalTabs.filter(({ instanceId }) =>
    physicalSelection.has(instanceId),
  ).length;
  const visibleSelectionCount =
    selectionMode === "canonical"
      ? visibleCanonicalSelected
      : visiblePhysicalSelected;
  const visibleSelectionSize =
    selectionMode === "canonical" ? visibleIds.length : visiblePhysicalTabs.length;
  const allVisibleSelected =
    visibleSelectionSize > 0 && visibleSelectionCount === visibleSelectionSize;
  const someVisibleSelected = visibleSelectionCount > 0 && !allVisibleSelected;
  const setTabSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setPageSelected = (checked: boolean) => {
    if (selectionMode === "physical") {
      setPhysicalSelection((current) =>
        setLibraryCanonicalRowsSelected(current, tabs, visiblePhysicalTabs, checked),
      );
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const columns = columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: () => (
        <SelectionCheckbox
          checked={allVisibleSelected}
          disabled={visibleSelectionSize === 0}
          indeterminate={someVisibleSelected}
          label={
            selectionMode === "physical"
              ? t("Select all browser tabs on this page")
              : t("Select all tabs on this page")
          }
          onChange={setPageSelected}
        />
      ),
      cell: ({ row }) => {
        const instances =
          instancesByCanonicalTab.get(row.original.id) ?? EMPTY_TAB_INSTANCES;
        const selectedCopies = instances.filter(({ instanceId }) =>
          physicalSelection.has(instanceId),
        ).length;
        const selectingPhysicalTabs = selectionMode === "physical";
        return (
          <SelectionCheckbox
            checked={
              selectingPhysicalTabs
                ? instances.length > 0 && selectedCopies === instances.length
                : selectedIds.has(row.original.id)
            }
            disabled={selectingPhysicalTabs && instances.length === 0}
            indeterminate={
              selectingPhysicalTabs &&
              selectedCopies > 0 &&
              selectedCopies < instances.length
            }
            label={
              selectingPhysicalTabs
                ? t("Select browser tabs for {tab}", {
                    tab: row.original.title?.trim() || hostname(row.original.url),
                  })
                : t("Select {tab}", {
                    tab: row.original.title?.trim() || hostname(row.original.url),
                  })
            }
            onChange={(checked) => {
              if (selectingPhysicalTabs) {
                setPhysicalSelection((current) =>
                  setLibraryCanonicalRowsSelected(
                    current,
                    [row.original],
                    instances,
                    checked,
                  ),
                );
              } else {
                setTabSelected(row.original.id, checked);
              }
            }}
            onClick={(event) => event.stopPropagation()}
          />
        );
      },
    }),
    columnHelper.accessor("title", {
      header: t("Tab"),
      cell: ({ row }) => {
        const tabItem = row.original;
        const instances =
          instancesByCanonicalTab.get(tabItem.id) ?? EMPTY_TAB_INSTANCES;
        const openCopyCount = effectiveLibraryOpenCopyCount(
          tabItem.openInstanceCount,
          instances,
          libraryPhysicalResolutionAvailable,
        );
        const onlyInstance = instances.length === 1 ? instances[0] : undefined;
        const tabLabel = tabItem.title?.trim() || hostname(tabItem.url);
        const onlyInstanceLabel =
          onlyInstance === undefined
            ? undefined
            : physicalTabAccessibleLabel(
                onlyInstance,
                tabLabel,
                t,
                formatNumber,
              );
        return (
          <div className="tab-title-cell">
            <div className="tab-title-line">
              <button
                aria-label={
                  onlyInstance
                    ? t("Switch to existing tab: {label}", {
                        label: onlyInstanceLabel ?? tabLabel,
                      })
                    : undefined
                }
                className="tab-open-button"
                disabled={
                  onlyInstance !== undefined &&
                  (canonicalTabActivation.isActivatingPhysical(
                    onlyInstance.instanceId,
                  ) || singleTabClose.isClosingPhysical(onlyInstance.instanceId))
                }
                title={
                  onlyInstance
                    ? t("Switch to this existing browser tab")
                    : instances.length > 1
                      ? t("{count} open copies", {
                          count: formatNumber(instances.length),
                          rawCount: instances.length,
                        })
                      : t("Open tab details")
                }
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (onlyInstance !== undefined) {
                    canonicalTabActivation.runPhysical(onlyInstance);
                  } else if (instances.length > 1) {
                    setExpandedPhysicalRows((current) => {
                      const next = new Set(current);
                      if (next.has(tabItem.id)) next.delete(tabItem.id);
                      else next.add(tabItem.id);
                      return next;
                    });
                  } else {
                    setActiveTabId(tabItem.id);
                  }
                }}
              >
                {tabLabel}
              </button>
              {openCopyCount === 0 ? (
                <TabBrowserAction
                  activationError={
                    singleTabClose.errorForCanonical(tabItem.id) !== undefined
                      ? localizeError(singleTabClose.errorForCanonical(tabItem.id))
                      : canonicalTabActivation.errorFor(tabItem.id) === undefined
                        ? undefined
                        : localizeError(canonicalTabActivation.errorFor(tabItem.id))
                  }
                  activationInProgress={
                    canonicalTabActivation.busy || singleTabClose.busy
                  }
                  className="tab-browser-action"
                  closeInProgress={singleTabClose.isClosingCanonical(tabItem.id)}
                  isActivating={canonicalTabActivation.isActivating(tabItem.id)}
                  stopPropagation
                  tab={tabItem}
                  onBrowserAction={canonicalTabActivation.run}
                  onMiddleClose={singleTabClose.closeCanonical}
                />
              ) : null}
            </div>
            <span className="library-tab-url" dir="ltr" title={tabItem.url}>
              {tabItem.url}
            </span>
            <SummaryAction tab={tabItem} />
            {tabItem.summary?.trim() ? (
              <SummaryDisclosure summary={tabItem.summary.trim()} />
            ) : null}
            {openCopyCount > 0 ? (
              <div className="library-tab-physical">
                {libraryOpenTabsQuery.isPending ? (
                  <span>{t("Loading open copies...")}</span>
                ) : libraryOpenTabsQuery.isError ? (
                  <span className="physical-tab-action-error">
                    {t("Open copies unavailable")}
                  </span>
                ) : (
                  <LibraryPhysicalCopies
                    activationErrorFor={(instanceId) => {
                      const error =
                        canonicalTabActivation.errorForPhysical(instanceId);
                      return error === undefined ? undefined : localizeError(error);
                    }}
                    closeErrorFor={(instanceId) => {
                      const error = singleTabClose.errorForPhysical(instanceId);
                      return error === undefined ? undefined : localizeError(error);
                    }}
                    expanded={expandedPhysicalRows.has(tabItem.id)}
                    instances={instances}
                    isActivating={canonicalTabActivation.isActivatingPhysical}
                    isClosing={singleTabClose.isClosingPhysical}
                    selection={physicalSelection}
                    selectionEnabled={selectionMode === "physical"}
                    tab={tabItem}
                    onActivate={canonicalTabActivation.runPhysical}
                    onClose={singleTabClose.closePhysical}
                    onExpandedChange={(expanded) =>
                      setExpandedPhysicalRows((current) => {
                        const next = new Set(current);
                        if (expanded) next.add(tabItem.id);
                        else next.delete(tabItem.id);
                        return next;
                      })
                    }
                    onSelectedChange={(instance, selected) =>
                      setPhysicalSelection((current) =>
                        setLibraryPhysicalInstanceSelected(
                          current,
                          instance,
                          selected,
                        ),
                      )
                    }
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("tagPaths", {
      header: t("Topics"),
      cell: ({ getValue }) => {
        const paths = getValue();
        if (paths.length === 0) return <span className="no-row-tags">-</span>;

        return (
          <div className="row-tag-list" title={paths.join(", ")}>
            {paths.slice(0, 2).map((path) => (
              <span key={path}>{path}</span>
            ))}
            {paths.length > 2 ? <strong>+{formatNumber(paths.length - 2)}</strong> : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("browser", {
      header: t("Browser"),
      cell: ({ getValue }) => <BrowserBadge browser={getValue()} />,
    }),
    columnHelper.accessor("openInstanceCount", {
      id: "activity",
      header: t("Activity"),
      cell: ({ getValue, row }) => {
        const instances =
          instancesByCanonicalTab.get(row.original.id) ?? EMPTY_TAB_INSTANCES;
        const count = effectiveLibraryOpenCopyCount(
          getValue(),
          instances,
          libraryPhysicalResolutionAvailable,
        );
        if (count === 0) {
          return (
            <span className="no-library-activity" title={t("No open copies")}>
              <span aria-hidden="true">—</span>
              <span className="sr-only">{t("No open copies")}</span>
            </span>
          );
        }

        return (
          <div
            className="library-activity"
            title={t("Combined across currently open physical copies.")}
          >
            <ActivityMetrics
              engagedTimeMs={row.original.openEngagedTimeMs}
              foregroundTimeMs={row.original.openForegroundTimeMs}
            />
          </div>
        );
      },
    }),
    columnHelper.accessor("status", {
      header: t("Status"),
      cell: ({ getValue }) => {
        const status = getValue();
        return (
          <span className={`status status-${status}`}>
            {t(STATUS_LABEL_KEYS[status])}
          </span>
        );
      },
    }),
    columnHelper.accessor("importance", {
      header: t("Importance"),
      cell: ({ getValue }) => <Importance level={getValue()} />,
    }),
    columnHelper.accessor("isOpen", {
      header: t("State"),
      cell: ({ getValue }) => (
        <span className={getValue() ? "open-state is-open" : "open-state"}>
          <span aria-hidden="true" />
          {getValue() ? t("Open") : t("Closed")}
        </span>
      ),
    }),
    columnHelper.accessor("firstSeenAt", {
      id: "age",
      header: t("Age"),
      cell: ({ getValue }) => <RelativeAge value={getValue()} />,
    }),
  ]);
  const table = useTable({
    columns,
    data: tabs,
    features: tableFeatureSet,
    getRowId: (row) => String(row.id),
  });
  const tableRows = table.getRowModel().rows;
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    estimateSize: () => 82,
    getItemKey: (index) => tableRows[index]?.id ?? index,
    getScrollElement: () => tableScrollRef.current,
    overscan: 8,
  });

  useEffect(() => {
    rowVirtualizer.scrollToOffset(0);
  }, [browser, duplicatesOnly, importance, openState, page, q, rowVirtualizer, status, tag]);

  const hasFilters =
    browser !== "all" ||
    duplicatesOnly ||
    importance !== "all" ||
    openState !== "all" ||
    search.length > 0 ||
    status !== "all" ||
    tag.length > 0;
  const hasAppliedFilters =
    browser !== "all" ||
    duplicatesOnly ||
    importance !== "all" ||
    openState !== "all" ||
    q.length > 0 ||
    status !== "all" ||
    tag.length > 0;
  const clearFilters = () => {
    setBrowser("all");
    setDuplicatesOnly(false);
    setImportance("all");
    setOpenState("all");
    setPage(1);
    setSearch("");
    setStatus("all");
    setSelectedTopic(null);
  };
  const totalPages = tabsQuery.data
    ? Math.max(1, Math.ceil(tabsQuery.data.total / tabsQuery.data.pageSize))
    : 1;
  const firstVisible = tabsQuery.data?.total
    ? (tabsQuery.data.page - 1) * tabsQuery.data.pageSize + 1
    : 0;
  const lastVisible = firstVisible ? firstVisible + tabs.length - 1 : 0;
  const connectionState = tabsQuery.isError
    ? "error"
    : tabsQuery.isPending
      ? "pending"
      : "ready";
  const connectionLabel =
    connectionState === "error"
      ? t("API unavailable")
      : connectionState === "pending"
        ? t("Connecting")
        : t("Local collection");
  const bulkError = bulkStatusMutation.error ?? bulkTagMutation.error;
  const bulkBusy =
    selectAllLibraryMutation.isPending ||
    bulkStatusMutation.isPending ||
    bulkTagMutation.isPending;
  const closeDrawer = useCallback(() => setActiveTabId(null), []);
  const openRow = (tabId: number, event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select")) return;
    setActiveTabId(tabId);
  };
  const openRowFromKeyboard = (
    tabId: number,
    event: KeyboardEvent<HTMLTableRowElement>,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setActiveTabId(tabId);
    }
  };

  return (
    <CurrentTimeContext.Provider value={currentTime}>
      <div className="app-shell">
        <header className="app-header">
          <div className="brand">
            <Mark />
            <div>
              <h1>TabHub</h1>
              <p>{t("Your browsers, one workspace")}</p>
            </div>
          </div>
          <div className="app-header-actions">
            <label className="language-select">
              <span>{t("Language")}</span>
              <select
                aria-label={t("Language")}
                value={locale}
                onChange={(event) => setLocale(event.target.value as "en" | "ru")}
              >
                <option lang="en" value="en">{t("English")}</option>
                <option lang="ru" value="ru">{t("Russian")}</option>
              </select>
            </label>
            <div className={`connection-status is-${connectionState}`} role="status">
              <span aria-hidden="true" />
              {connectionLabel}
            </div>
          </div>
        </header>

        <main>
          <section className="list-heading" aria-labelledby="tab-list-title">
            <div>
              <p className="eyebrow">{t("Workspace")}</p>
              <div className="title-row">
                <h2 id="tab-list-title">
                  {view === "graph"
                    ? tag || t("Knowledge graph")
                    : tag || t("Library")}
                </h2>
                {view === "library" && tabsQuery.data ? (
                  <span>{formatNumber(tabsQuery.data.total)}</span>
                ) : null}
              </div>
              <p>
                {view === "graph"
                  ? tag
                    ? t("Directed links under {tag} and its descendants.", { tag })
                    : t("Explore relationships across every captured tab.")
                  : tag
                    ? t("Tabs filed under {tag} and its descendants.", { tag })
                    : t("Tabs captured from every connected browser.")}
              </p>
            </div>
            <div className="heading-actions">
              {view === "library" && tabsQuery.isFetching && !tabsQuery.isPending ? (
                <span className="refresh-status" role="status">
                  <span aria-hidden="true" />
                  {t("Refreshing")}
                </span>
              ) : null}
              <div className="view-switch" aria-label={t("Workspace view")} role="group">
                <button
                  aria-pressed={view === "library"}
                  type="button"
                  onClick={() => selectView("library")}
                >
                  {t("Library")}
                </button>
                <button
                  aria-pressed={view === "graph"}
                  type="button"
                  onClick={() => selectView("graph")}
                >
                  {t("Graph")}
                </button>
              </div>
            </div>
          </section>

          <div className="workspace-layout">
            <TopicSidebar
              selectedTopic={selectedTopic}
              onSelectTopic={(topic) => {
                setSelectedTopic(topic);
                setPage(1);
              }}
            />

            {view === "library" ? (
              <section className="table-panel" aria-label={t("Library pages")}>
              <div className="library-mode-bar">
                <button
                  aria-pressed={selectionMode === "physical"}
                  className="manage-browser-tabs-button"
                  type="button"
                  onClick={() => {
                    if (selectionMode === "physical") {
                      setPhysicalSelection(new Map());
                      setSelectionMode("canonical");
                      return;
                    }
                    setSelectionMode("physical");
                  }}
                >
                  {t("Manage browser tabs")}
                </button>
                {selectionMode === "physical" ? (
                  <p>{t("Select and manage exact tabs in their owning browsers.")}</p>
                ) : null}
              </div>
              <div className="filter-bar">
                <div className="filter-label">
                  <FilterIcon />
                  <span>{t("Filters")}</span>
                </div>
                <label className="search-field">
                  <span>{t("Search tab titles, URLs, and content")}</span>
                  <SearchIcon />
                  <input
                    autoComplete="off"
                    maxLength={500}
                    placeholder={t("Search titles, URLs, and content")}
                    type="search"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <label>
                  <span>{t("Browser")}</span>
                  <select
                    value={browser}
                    onChange={(event) => {
                      setBrowser(event.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">{t("All browsers")}</option>
                    {knownBrowserOptions.map((browserOption) => (
                      <option key={browserOption} value={browserOption}>
                        {browserLabel(browserOption, t)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("Tab state")}</span>
                  <select
                    value={openState}
                    onChange={(event) => {
                      setOpenState(event.target.value as OpenFilter);
                      setPage(1);
                    }}
                  >
                    <option value="all">{t("Open & closed")}</option>
                    <option value="open">{t("Open only")}</option>
                    <option value="closed">{t("Closed only")}</option>
                  </select>
                </label>
                <label>
                  <span>{t("Workflow status")}</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value as "all" | TabStatus);
                      setPage(1);
                    }}
                  >
                    <option value="all">{t("All statuses")}</option>
                    {statusOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("Importance")}</span>
                  <select
                    value={importance}
                    onChange={(event) => {
                      const value = event.target.value;
                      setImportance(
                        value === "all" ? "all" : (Number(value) as TabImportance),
                      );
                      setPage(1);
                    }}
                  >
                    <option value="all">{t("Any importance")}</option>
                    <option value="0">{t("0 - Unrated")}</option>
                    <option value="1">{t("1 - Low")}</option>
                    <option value="2">{t("2 - Medium")}</option>
                    <option value="3">{t("3 - High")}</option>
                  </select>
                </label>
                <label className="duplicates-toggle">
                  <input
                    aria-label={t("Multiple open copies")}
                    checked={duplicatesOnly}
                    type="checkbox"
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setDuplicatesOnly(checked);
                      if (checked) setOpenState("open");
                      setPage(1);
                    }}
                  />
                  <span>{t("Multiple open copies")}</span>
                </label>
                {hasFilters ? (
                  <button className="clear-button" type="button" onClick={clearFilters}>
                    {t("Clear filters")}
                  </button>
                ) : null}
                <p className="result-count">
                  {tabsQuery.isError
                    ? t("Collection unavailable")
                    : tabsQuery.data
                      ? tabsQuery.data.total > 0
                        ? t("{first}-{last} of {total}", {
                            first: formatNumber(firstVisible),
                            last: formatNumber(lastVisible),
                            total: formatNumber(tabsQuery.data.total),
                          })
                        : t("0 tabs")
                      : t("Loading collection")}
                </p>
                {selectionMode === "canonical" ? (
                  <button
                    className="clear-button"
                    disabled={
                      bulkBusy || !tabsQuery.data || tabsQuery.data.total === 0
                    }
                    type="button"
                    onClick={() =>
                      selectAllLibraryMutation.mutate({
                        filterKey: libraryFilterKey,
                        filters: libraryFilters,
                      })
                    }
                  >
                    {t("All filtered results")}
                  </button>
                ) : null}
                {selectionMode === "canonical" && selectAllLibraryMutation.isError ? (
                  <span className="bulk-error" role="alert">
                    {localizeError(selectAllLibraryMutation.error)}
                  </span>
                ) : null}
              </div>

              <LibraryPhysicalTabActions
                allFilteredInstances={libraryOpenTabs}
                selection={
                  selectionMode === "physical"
                    ? effectivePhysicalSelection
                    : EMPTY_PHYSICAL_SELECTION
                }
                showSelectionControls={
                  selectionMode === "physical" &&
                  libraryPhysicalResolutionAvailable
                }
                onRefresh={() =>
                  Promise.all([
                    tabsQuery.refetch(),
                    libraryOpenTabsQuery.refetch(),
                  ])
                }
                onSelectionChange={setPhysicalSelection}
              />
              {selectionMode === "canonical" && selectedIds.size > 0 ? (
                <div className="bulk-toolbar" aria-label={t("Bulk tab actions")}>
                  <strong>
                    {t("{count} selected", { count: formatNumber(selectedIds.size) })}
                  </strong>
                  <label>
                    <span>{t("Status")}</span>
                    <select
                      disabled={bulkBusy}
                      value={bulkStatus}
                      onChange={(event) => setBulkStatus(event.target.value as TabStatus)}
                    >
                      {statusOptions.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={bulkBusy}
                    type="button"
                    onClick={() => bulkStatusMutation.mutate()}
                  >
                    {t("Apply status")}
                  </button>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (bulkTag.trim()) bulkTagMutation.mutate();
                    }}
                  >
                    <label>
                      <span>{t("Topic path")}</span>
                      <TopicPathInput
                        disabled={bulkBusy}
                        placeholder={t("Research/AI")}
                        required
                        value={bulkTag}
                        onChange={setBulkTag}
                      />
                    </label>
                    <button disabled={bulkBusy || !bulkTag.trim()} type="submit">
                      {t("Assign topic")}
                    </button>
                  </form>
                  <button
                    className="bulk-clear"
                    disabled={bulkBusy}
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    {t("Clear")}
                  </button>
                  {bulkError ? (
                    <span className="bulk-error" role="alert">
                      {localizeError(bulkError)}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="table-scroll" ref={tableScrollRef}>
                <table aria-rowcount={tableRows.length + 1} className="virtual-table">
                  <caption className="sr-only">
                    {t("Tabs collected from connected browsers")}
                  </caption>
                  <thead>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <tr key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <th data-column={header.column.id} key={header.id} scope="col">
                            {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody
                    className="virtual-table-body"
                    style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                  >
                    {!tabsQuery.isPending && !tabsQuery.isError
                      ? rowVirtualizer.getVirtualItems().map((virtualRow) => {
                          const row = tableRows[virtualRow.index];
                          if (!row) return null;
                          const rowInstances =
                            instancesByCanonicalTab.get(row.original.id) ??
                            EMPTY_TAB_INSTANCES;
                          const rowSelected =
                            selectionMode === "canonical"
                              ? selectedIds.has(row.original.id)
                              : rowInstances.length > 0 &&
                                rowInstances.every(({ instanceId }) =>
                                  physicalSelection.has(instanceId),
                                );

                          return (
                            <tr
                              aria-rowindex={virtualRow.index + 2}
                              aria-selected={rowSelected}
                              className={rowSelected ? "is-selected" : undefined}
                              data-index={virtualRow.index}
                              key={row.id}
                              ref={(element) => rowVirtualizer.measureElement(element)}
                              style={{ transform: `translateY(${virtualRow.start}px)` }}
                              tabIndex={0}
                              onAuxClick={(event) => {
                                const onlyInstance = rowInstances[0];
                                if (rowInstances.length !== 1 || onlyInstance === undefined) {
                                  return;
                                }
                                handleMiddleClickClose(event, () =>
                                  singleTabClose.closePhysical(onlyInstance),
                                );
                              }}
                              onClick={(event) => openRow(row.original.id, event)}
                              onKeyDown={(event) =>
                                openRowFromKeyboard(row.original.id, event)
                              }
                              onMouseDown={preventMiddleClickAutoscroll}
                            >
                              {row.getAllCells().map((cell) => (
                                <td data-column={cell.column.id} key={cell.id}>
                                  <table.FlexRender cell={cell} />
                                </td>
                              ))}
                            </tr>
                          );
                        })
                      : null}
                  </tbody>
                </table>

                {tabsQuery.isPending ? (
                  <div className="state-panel loading-state" role="status">
                    <div className="spinner" aria-hidden="true" />
                    <div>
                      <strong>{t("Loading your tabs")}</strong>
                      <span>{t("Reading the local collection...")}</span>
                    </div>
                  </div>
                ) : null}

                {tabsQuery.isError ? (
                  <div className="state-panel error-state" role="alert">
                    <div className="state-icon" aria-hidden="true">!</div>
                    <div>
                      <strong>{t("Couldn't load tabs")}</strong>
                      <span>{localizeError(tabsQuery.error)}</span>
                    </div>
                    <button type="button" onClick={() => void tabsQuery.refetch()}>
                      {t("Try again")}
                    </button>
                  </div>
                ) : null}

                {tabsQuery.isSuccess && tabs.length === 0 ? (
                  <div className="state-panel empty-state" role="status">
                    <div className="empty-mark" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                    <div>
                      <strong>
                        {hasAppliedFilters
                          ? t("No tabs match these filters")
                          : t("No tabs yet")}
                      </strong>
                      <span>
                        {hasAppliedFilters
                          ? t("Try another search, topic, browser, or tab state.")
                          : t("Connect a browser extension to fill this workspace.")}
                      </span>
                    </div>
                    {hasFilters ? (
                      <button type="button" onClick={clearFilters}>
                        {t("Clear filters")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {tabsQuery.data && tabsQuery.data.total > 0 ? (
                <nav className="pagination" aria-label={t("Tab list pages")}>
                  <p>
                    {t("Page {page} of {total}", {
                      page: formatNumber(tabsQuery.data.page),
                      total: formatNumber(totalPages),
                    })}
                  </p>
                  <div>
                    <button
                      disabled={tabsQuery.data.page <= 1 || tabsQuery.isFetching}
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <span aria-hidden="true">&lt;-</span>
                      {t("Previous")}
                    </button>
                    <button
                      disabled={tabsQuery.data.page >= totalPages || tabsQuery.isFetching}
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      {t("Next")}
                      <span aria-hidden="true">-&gt;</span>
                    </button>
                  </div>
                </nav>
              ) : null}
              </section>
            ) : (
              <Suspense
                fallback={
                  <section className="graph-panel" aria-label={t("Tab knowledge graph")}>
                    <div className="graph-canvas">
                      <div className="graph-state" role="status">
                        <div className="graph-state-mark" aria-hidden="true" />
                        <strong>{t("Loading graph view")}</strong>
                        <span>{t("Preparing the interactive canvas...")}</span>
                      </div>
                    </div>
                  </section>
                }
              >
                <GraphView
                  activationErrorForTab={(tabId: number) => {
                    const error = canonicalTabActivation.errorFor(tabId);
                    return error === undefined ? undefined : localizeError(error);
                  }}
                  activationInProgress={canonicalTabActivation.busy}
                  closeErrorForTab={(tabId) => {
                    const error = singleTabClose.errorForCanonical(tabId);
                    return error === undefined ? undefined : localizeError(error);
                  }}
                  isActivatingTab={canonicalTabActivation.isActivating}
                  isClosingTab={singleTabClose.isClosingCanonical}
                  rootTopicId={selectedTopic?.id ?? null}
                  rootTag={tag}
                  onBrowserAction={canonicalTabActivation.run}
                  onCloseTab={singleTabClose.closeCanonical}
                  onSelectTab={setActiveTabId}
                  onSelectTopic={(topic: SelectedTopic | null) => {
                    setSelectedTopic(topic);
                    setPage(1);
                    selectView("library");
                  }}
                />
              </Suspense>
            )}
          </div>
        </main>
      </div>

      {activeTabId !== null ? (
        <TabDrawer
          activationError={
            singleTabClose.errorForCanonical(activeTabId) !== undefined
              ? localizeError(singleTabClose.errorForCanonical(activeTabId))
              : canonicalTabActivation.errorFor(activeTabId) === undefined
                ? undefined
                : localizeError(canonicalTabActivation.errorFor(activeTabId))
          }
          activationInProgress={canonicalTabActivation.busy || singleTabClose.busy}
          closeInProgress={singleTabClose.isClosingCanonical(activeTabId)}
          isActivating={canonicalTabActivation.isActivating(activeTabId)}
          key={activeTabId}
          tabId={activeTabId}
          onBrowserAction={canonicalTabActivation.run}
          onClose={closeDrawer}
          onMiddleClose={singleTabClose.closeCanonical}
        />
      ) : null}
    </CurrentTimeContext.Provider>
  );
}
