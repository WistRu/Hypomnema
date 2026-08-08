import { knownBrowserOptions, type TabListItem } from "@tabhub/shared";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { createContext, useContext, useEffect, useId, useState } from "react";

import { fetchTabs, type OpenFilter } from "./api";

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

const STATUS_LABELS: Record<TabListItem["status"], string> = {
  archived: "Archived",
  done: "Done",
  inbox: "Inbox",
  in_progress: "In progress",
};

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

function RelativeAge({ value }: { value: string }) {
  const now = useContext(CurrentTimeContext);
  return (
    <time dateTime={value} title={fullDate(value)}>
      {formatAge(value, now)}
    </time>
  );
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
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? "Collapse" : "Expand"}
      </button>
    </div>
  );
}

const columns = columnHelper.columns([
  columnHelper.accessor("title", {
    header: "Tab",
    cell: ({ row }) => {
      const tab = row.original;
      return (
        <div className="tab-title-cell">
          <a href={tab.url} target="_blank" rel="noreferrer" title={tab.url}>
            {tab.title?.trim() || hostname(tab.url)}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.25 3.25h7.5v7.5M12.5 3.5 7 9m2.5 3.75H3.25v-6.5h3" />
            </svg>
          </a>
          <span>{hostname(tab.url)}</span>
          {tab.summary?.trim() ? <SummaryDisclosure summary={tab.summary.trim()} /> : null}
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
  const [browser, setBrowser] = useState("all");
  const [openState, setOpenState] = useState<OpenFilter>("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [currentTime, setCurrentTime] = useState(Date.now());
  const debouncedSearch = useDebouncedValue(search, 300);
  const q = debouncedSearch.trim();

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const tabsQuery = useQuery({
    queryKey: ["tabs", { browser, openState, page, q }],
    queryFn: ({ signal }) => fetchTabs({ browser, openState, page, q }, signal),
  });

  const tabs = tabsQuery.data?.items ?? EMPTY_TABS;
  const table = useTable({
    columns,
    data: tabs,
    features: tableFeatureSet,
    getRowId: (row) => String(row.id),
  });

  const hasFilters = browser !== "all" || openState !== "all" || search.length > 0;
  const hasAppliedFilters = browser !== "all" || openState !== "all" || q.length > 0;
  const clearFilters = () => {
    setBrowser("all");
    setOpenState("all");
    setPage(1);
    setSearch("");
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
              <h2 id="tab-list-title">All tabs</h2>
              {tabsQuery.data ? <span>{tabsQuery.data.total.toLocaleString()}</span> : null}
            </div>
            <p>Tabs captured from every connected browser.</p>
          </div>
          {tabsQuery.isFetching && !tabsQuery.isPending ? (
            <span className="refresh-status" role="status">
              <span aria-hidden="true" />
              Refreshing
            </span>
          ) : null}
        </section>

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
                type="search"
                value={search}
                autoComplete="off"
                maxLength={500}
                placeholder="Search titles and content"
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
                  <option value={browserOption} key={browserOption}>
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
                  ? `${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()} of ${tabsQuery.data.total.toLocaleString()}`
                  : "0 tabs"
                : "Loading collection"}
            </p>
          </div>

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
                      <tr key={row.id}>
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
                  <span>Reading the local collection…</span>
                </div>
              </div>
            ) : null}

            {tabsQuery.isError ? (
              <div className="state-panel error-state" role="alert">
                <div className="state-icon" aria-hidden="true">!</div>
                <div>
                  <strong>Couldn’t load tabs</strong>
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
                    {hasAppliedFilters ? "No tabs match your search or filters" : "No tabs yet"}
                  </strong>
                  <span>
                    {hasAppliedFilters
                      ? "Try another search, browser, or tab state."
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
                  type="button"
                  disabled={tabsQuery.data.page <= 1 || tabsQuery.isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <span aria-hidden="true">←</span>
                  Previous
                </button>
                <button
                  type="button"
                  disabled={tabsQuery.data.page >= totalPages || tabsQuery.isFetching}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  Next
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </nav>
          ) : null}
        </section>
      </main>
      </div>
    </CurrentTimeContext.Provider>
  );
}
