import {
  knownBrowserOptions,
  type TabImportance,
  type TabListItem,
  type TabStatus,
  type TagTreeNode,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  assignTag,
  enqueueShortSummary,
  fetchSummaryJob,
  fetchTabs,
  fetchTagTree,
  updateTabStatuses,
  type OpenFilter,
} from "./api";
import { TabDrawer } from "./TabDrawer";

const EMPTY_TABS: TabListItem[] = [];
const tableFeatureSet = tableFeatures({});
const columnHelper = createColumnHelper<typeof tableFeatureSet, TabListItem>();
const CurrentTimeContext = createContext(Date.now());

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

const STATUS_LABELS: Record<TabStatus, string> = {
  inbox: "Inbox",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

const STATUS_OPTIONS = Object.entries(STATUS_LABELS) as Array<[
  TabStatus,
  string,
]>;

function browserLabel(browser: string) {
  return BROWSER_LABELS[browser.toLowerCase()] ?? browser;
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatAge(value: string, now: number) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unknown";

  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;

  if (elapsed < minute) return "Just now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < day * 30) return `${Math.floor(elapsed / day)}d ago`;
  if (elapsed < day * 365) return `${Math.floor(elapsed / (day * 30))}mo ago`;
  return `${Math.floor(elapsed / (day * 365))}y ago`;
}

function fullDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function RelativeAge({ value }: { value: string }) {
  const now = useContext(CurrentTimeContext);
  return (
    <time dateTime={value} title={fullDate(value)}>
      {formatAge(value, now)}
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
  const normalized = browser.toLowerCase();
  return (
    <span className="browser-badge">
      <span className={`browser-dot browser-${normalized}`} aria-hidden="true" />
      <span>{browserLabel(browser)}</span>
    </span>
  );
}

function Importance({ level }: { level: number }) {
  return (
    <span className="importance" aria-label={`Importance ${level} of 3`}>
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
  indeterminate = false,
  label,
  onChange,
  onClick,
}: {
  checked: boolean;
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
        {expanded ? "Collapse" : "Expand"}
      </button>
    </div>
  );
}

function SummaryAction({ tab }: { tab: TabListItem }) {
  const queryClient = useQueryClient();
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
      ]);
    }
  }, [job?.id, job?.status, queryClient, tab.id]);

  const pollingError = jobQuery.isError ? jobQuery.error.message : null;
  const errorMessage = enqueueMutation.isError
    ? enqueueMutation.error.message
    : job?.status === "failed"
      ? job.error ?? "TabHub could not create this summary."
      : pollingError;
  const statusMessage = enqueueMutation.isPending
    ? "Requesting summary"
    : jobStatus === "queued"
      ? "Summary queued"
      : jobStatus === "running"
        ? "Creating summary"
        : jobStatus === "succeeded"
          ? "Summary ready"
          : null;
  const isActive = jobStatus === "queued" || jobStatus === "running";
  const isStatusRetry = pollingError !== null && jobId !== null;
  const defaultLabel = hasSummary ? "Refresh short summary" : "Create short summary";
  const buttonLabel = isStatusRetry
    ? "Check summary status"
    : errorMessage
      ? "Retry short summary"
      : defaultLabel;
  const feedback = errorMessage ?? statusMessage;

  return (
    <div className="summary-action" onClick={(event) => event.stopPropagation()}>
      <button
        aria-describedby={feedback ? feedbackId : undefined}
        aria-label={`${buttonLabel} for ${tabLabel}`}
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

function TagBranch({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: TagTreeNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            aria-current={selectedPath === node.path ? "page" : undefined}
            className={selectedPath === node.path ? "is-active" : undefined}
            title={node.path}
            type="button"
            onClick={() => onSelect(node.path)}
          >
            <span>{node.name}</span>
            <strong>{node.tabCount.toLocaleString()}</strong>
          </button>
          {node.children.length > 0 ? (
            <TagBranch
              nodes={node.children}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ) : null}
        </li>
      ))}
    </ul>
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
  const [browser, setBrowser] = useState("all");
  const [openState, setOpenState] = useState<OpenFilter>("all");
  const [status, setStatus] = useState<"all" | TabStatus>("all");
  const [importance, setImportance] = useState<"all" | TabImportance>("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkStatus, setBulkStatus] = useState<TabStatus>("in_progress");
  const [bulkTag, setBulkTag] = useState("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);
  const q = debouncedSearch.trim();

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [browser, importance, openState, page, q, status, tag]);

  const tabsQuery = useQuery({
    queryKey: ["tabs", { browser, importance, openState, page, q, status, tag }],
    queryFn: ({ signal }) =>
      fetchTabs({ browser, importance, openState, page, q, status, tag }, signal),
  });
  const tagsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchTagTree(signal),
  });
  const bulkStatusMutation = useMutation({
    mutationFn: () => updateTabStatuses([...selectedIds], bulkStatus),
    onSuccess: async () => {
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ["tabs"] });
    },
  });
  const bulkTagMutation = useMutation({
    mutationFn: () => assignTag([...selectedIds], bulkTag.trim()),
    onSuccess: async () => {
      setSelectedIds(new Set());
      setBulkTag("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
      ]);
    },
  });

  const tabs = tabsQuery.data?.items ?? EMPTY_TABS;
  const visibleIds = tabs.map((tabItem) => tabItem.id);
  const visibleSelected = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  const someVisibleSelected = visibleSelected > 0 && !allVisibleSelected;
  const setTabSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setPageSelected = (checked: boolean) => {
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
          indeterminate={someVisibleSelected}
          label="Select all tabs on this page"
          onChange={setPageSelected}
        />
      ),
      cell: ({ row }) => (
        <SelectionCheckbox
          checked={selectedIds.has(row.original.id)}
          label={`Select ${row.original.title?.trim() || hostname(row.original.url)}`}
          onChange={(checked) => setTabSelected(row.original.id, checked)}
          onClick={(event) => event.stopPropagation()}
        />
      ),
    }),
    columnHelper.accessor("title", {
      header: "Tab",
      cell: ({ row }) => {
        const tabItem = row.original;
        return (
          <div className="tab-title-cell">
            <div className="tab-title-line">
              <button
                className="tab-open-button"
                title="Open tab details"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveTabId(tabItem.id);
                }}
              >
                {tabItem.title?.trim() || hostname(tabItem.url)}
              </button>
              <a
                aria-label={`Open ${tabItem.title?.trim() || hostname(tabItem.url)} in browser`}
                href={tabItem.url}
                rel="noreferrer"
                target="_blank"
                title={tabItem.url}
                onClick={(event) => event.stopPropagation()}
              >
                Open
              </a>
            </div>
            <span>{hostname(tabItem.url)} | #{tabItem.id}</span>
            <SummaryAction tab={tabItem} />
            {tabItem.summary?.trim() ? (
              <SummaryDisclosure summary={tabItem.summary.trim()} />
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("tagPaths", {
      header: "Tags",
      cell: ({ getValue }) => {
        const paths = getValue();
        if (paths.length === 0) return <span className="no-row-tags">-</span>;

        return (
          <div className="row-tag-list" title={paths.join(", ")}>
            {paths.slice(0, 2).map((path) => (
              <span key={path}>{path}</span>
            ))}
            {paths.length > 2 ? <strong>+{paths.length - 2}</strong> : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("browser", {
      header: "Browser",
      cell: ({ getValue }) => <BrowserBadge browser={getValue()} />,
    }),
    columnHelper.accessor("status", {
      header: "Status",
      cell: ({ getValue }) => {
        const status = getValue();
        return <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>;
      },
    }),
    columnHelper.accessor("importance", {
      header: "Importance",
      cell: ({ getValue }) => <Importance level={getValue()} />,
    }),
    columnHelper.accessor("isOpen", {
      header: "State",
      cell: ({ getValue }) => (
        <span className={getValue() ? "open-state is-open" : "open-state"}>
          <span aria-hidden="true" />
          {getValue() ? "Open" : "Closed"}
        </span>
      ),
    }),
    columnHelper.accessor("firstSeenAt", {
      id: "age",
      header: "Age",
      cell: ({ getValue }) => <RelativeAge value={getValue()} />,
    }),
  ]);
  const table = useTable({
    columns,
    data: tabs,
    features: tableFeatureSet,
    getRowId: (row) => String(row.id),
  });

  const hasFilters =
    browser !== "all" ||
    importance !== "all" ||
    openState !== "all" ||
    search.length > 0 ||
    status !== "all" ||
    tag.length > 0;
  const hasAppliedFilters =
    browser !== "all" ||
    importance !== "all" ||
    openState !== "all" ||
    q.length > 0 ||
    status !== "all" ||
    tag.length > 0;
  const clearFilters = () => {
    setBrowser("all");
    setImportance("all");
    setOpenState("all");
    setPage(1);
    setSearch("");
    setStatus("all");
    setTag("");
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
      ? "API unavailable"
      : connectionState === "pending"
        ? "Connecting"
        : "Local collection";
  const bulkError = bulkStatusMutation.error ?? bulkTagMutation.error;
  const bulkBusy = bulkStatusMutation.isPending || bulkTagMutation.isPending;
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
              <p>Your browsers, one workspace</p>
            </div>
          </div>
          <div className={`connection-status is-${connectionState}`} role="status">
            <span aria-hidden="true" />
            {connectionLabel}
          </div>
        </header>

        <main>
          <section className="list-heading" aria-labelledby="tab-list-title">
            <div>
              <p className="eyebrow">Workspace</p>
              <div className="title-row">
                <h2 id="tab-list-title">{tag || "All tabs"}</h2>
                {tabsQuery.data ? <span>{tabsQuery.data.total.toLocaleString()}</span> : null}
              </div>
              <p>
                {tag
                  ? `Tabs filed under ${tag} and its descendants.`
                  : "Tabs captured from every connected browser."}
              </p>
            </div>
            {tabsQuery.isFetching && !tabsQuery.isPending ? (
              <span className="refresh-status" role="status">
                <span aria-hidden="true" />
                Refreshing
              </span>
            ) : null}
          </section>

          <div className="workspace-layout">
            <aside className="tag-sidebar" aria-labelledby="tag-tree-title">
              <div className="sidebar-heading">
                <div>
                  <p>Organize</p>
                  <h2 id="tag-tree-title">Topics</h2>
                </div>
                {tagsQuery.isFetching ? <span className="mini-spinner" aria-hidden="true" /> : null}
              </div>
              <nav aria-label="Filter tabs by topic">
                <button
                  aria-current={!tag ? "page" : undefined}
                  className={!tag ? "all-tags-button is-active" : "all-tags-button"}
                  type="button"
                  onClick={() => {
                    setTag("");
                    setPage(1);
                  }}
                >
                  <span>All tabs</span>
                </button>
                {tagsQuery.data?.items.length ? (
                  <TagBranch
                    nodes={tagsQuery.data.items}
                    selectedPath={tag}
                    onSelect={(path) => {
                      setTag(path);
                      setPage(1);
                    }}
                  />
                ) : null}
                {tagsQuery.isPending ? <p className="sidebar-state">Loading topics...</p> : null}
                {tagsQuery.isError ? (
                  <div className="sidebar-state is-error" role="alert">
                    <span>{tagsQuery.error.message}</span>
                    <button type="button" onClick={() => void tagsQuery.refetch()}>
                      Retry
                    </button>
                  </div>
                ) : null}
                {tagsQuery.isSuccess && tagsQuery.data.items.length === 0 ? (
                  <p className="sidebar-state">Assign a tag to start your topic tree.</p>
                ) : null}
              </nav>
            </aside>

            <section className="table-panel" aria-label="Browser tabs">
              <div className="filter-bar">
                <div className="filter-label">
                  <FilterIcon />
                  <span>Filters</span>
                </div>
                <label className="search-field">
                  <span>Search tab titles and content</span>
                  <SearchIcon />
                  <input
                    autoComplete="off"
                    maxLength={500}
                    placeholder="Search titles and content"
                    type="search"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <label>
                  <span>Browser</span>
                  <select
                    value={browser}
                    onChange={(event) => {
                      setBrowser(event.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">All browsers</option>
                    {knownBrowserOptions.map((browserOption) => (
                      <option key={browserOption} value={browserOption}>
                        {browserLabel(browserOption)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Tab state</span>
                  <select
                    value={openState}
                    onChange={(event) => {
                      setOpenState(event.target.value as OpenFilter);
                      setPage(1);
                    }}
                  >
                    <option value="all">Open &amp; closed</option>
                    <option value="open">Open only</option>
                    <option value="closed">Closed only</option>
                  </select>
                </label>
                <label>
                  <span>Workflow status</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value as "all" | TabStatus);
                      setPage(1);
                    }}
                  >
                    <option value="all">All statuses</option>
                    {STATUS_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Importance</span>
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
                    <option value="all">Any importance</option>
                    <option value="0">0 - Unrated</option>
                    <option value="1">1 - Low</option>
                    <option value="2">2 - Medium</option>
                    <option value="3">3 - High</option>
                  </select>
                </label>
                {hasFilters ? (
                  <button className="clear-button" type="button" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : null}
                <p className="result-count">
                  {tabsQuery.isError
                    ? "Collection unavailable"
                    : tabsQuery.data
                      ? tabsQuery.data.total > 0
                        ? `${firstVisible.toLocaleString()}-${lastVisible.toLocaleString()} of ${tabsQuery.data.total.toLocaleString()}`
                        : "0 tabs"
                      : "Loading collection"}
                </p>
              </div>

              {selectedIds.size > 0 ? (
                <div className="bulk-toolbar" aria-label="Bulk tab actions">
                  <strong>{selectedIds.size.toLocaleString()} selected</strong>
                  <label>
                    <span>Status</span>
                    <select
                      disabled={bulkBusy}
                      value={bulkStatus}
                      onChange={(event) => setBulkStatus(event.target.value as TabStatus)}
                    >
                      {STATUS_OPTIONS.map(([value, label]) => (
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
                    Apply status
                  </button>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (bulkTag.trim()) bulkTagMutation.mutate();
                    }}
                  >
                    <label>
                      <span>Tag path</span>
                      <input
                        disabled={bulkBusy}
                        maxLength={2_048}
                        placeholder="Research/AI"
                        required
                        value={bulkTag}
                        onChange={(event) => setBulkTag(event.target.value)}
                      />
                    </label>
                    <button disabled={bulkBusy || !bulkTag.trim()} type="submit">
                      Assign tag
                    </button>
                  </form>
                  <button
                    className="bulk-clear"
                    disabled={bulkBusy}
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Clear
                  </button>
                  {bulkError ? (
                    <span className="bulk-error" role="alert">
                      {bulkError.message}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Tabs collected from connected browsers</caption>
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
                  <tbody>
                    {!tabsQuery.isPending && !tabsQuery.isError
                      ? table.getRowModel().rows.map((row) => (
                          <tr
                            aria-selected={selectedIds.has(row.original.id)}
                            className={selectedIds.has(row.original.id) ? "is-selected" : undefined}
                            key={row.id}
                            tabIndex={0}
                            onClick={(event) => openRow(row.original.id, event)}
                            onKeyDown={(event) => openRowFromKeyboard(row.original.id, event)}
                          >
                            {row.getAllCells().map((cell) => (
                              <td data-column={cell.column.id} key={cell.id}>
                                <table.FlexRender cell={cell} />
                              </td>
                            ))}
                          </tr>
                        ))
                      : null}
                  </tbody>
                </table>

                {tabsQuery.isPending ? (
                  <div className="state-panel loading-state" role="status">
                    <div className="spinner" aria-hidden="true" />
                    <div>
                      <strong>Loading your tabs</strong>
                      <span>Reading the local collection...</span>
                    </div>
                  </div>
                ) : null}

                {tabsQuery.isError ? (
                  <div className="state-panel error-state" role="alert">
                    <div className="state-icon" aria-hidden="true">!</div>
                    <div>
                      <strong>Couldn't load tabs</strong>
                      <span>{tabsQuery.error.message}</span>
                    </div>
                    <button type="button" onClick={() => void tabsQuery.refetch()}>
                      Try again
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
                        {hasAppliedFilters ? "No tabs match these filters" : "No tabs yet"}
                      </strong>
                      <span>
                        {hasAppliedFilters
                          ? "Try another search, topic, browser, or tab state."
                          : "Connect a browser extension to fill this workspace."}
                      </span>
                    </div>
                    {hasFilters ? (
                      <button type="button" onClick={clearFilters}>
                        Clear filters
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {tabsQuery.data && tabsQuery.data.total > 0 ? (
                <nav className="pagination" aria-label="Tab list pages">
                  <p>
                    Page <strong>{tabsQuery.data.page.toLocaleString()}</strong> of{" "}
                    {totalPages.toLocaleString()}
                  </p>
                  <div>
                    <button
                      disabled={tabsQuery.data.page <= 1 || tabsQuery.isFetching}
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <span aria-hidden="true">&lt;-</span>
                      Previous
                    </button>
                    <button
                      disabled={tabsQuery.data.page >= totalPages || tabsQuery.isFetching}
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      Next
                      <span aria-hidden="true">-&gt;</span>
                    </button>
                  </div>
                </nav>
              ) : null}
            </section>
          </div>
        </main>
      </div>

      {activeTabId !== null ? (
        <TabDrawer key={activeTabId} tabId={activeTabId} onClose={closeDrawer} />
      ) : null}
    </CurrentTimeContext.Provider>
  );
}
