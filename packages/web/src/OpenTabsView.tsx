import type { TabInstance } from "@tabhub/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchOpenTabs } from "./api";
import { DuplicateReview } from "./DuplicateReview";
import { clampPage, isTrulyEmptyPage } from "./pagination";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

function browserLabel(browser: string): string {
  return BROWSER_LABELS[browser] ?? browser;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname || new URL(url).protocol.replace(":", "");
  } catch {
    return url;
  }
}

function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

function physicalLocation(tab: TabInstance): string {
  const tabId = tab.browserTabId === null ? "unknown tab" : `tab ${tab.browserTabId}`;
  return `Window ${tab.windowId} | position ${tab.index + 1} | ${tabId}`;
}

function OpenTabRow({
  tab,
  onSelectCanonicalTab,
}: {
  tab: TabInstance;
  onSelectCanonicalTab: (id: number) => void;
}) {
  const label = tab.title?.trim() || hostname(tab.url);

  return (
    <tr>
      <td>
        <div className="physical-tab-title">
          <button type="button" onClick={() => onSelectCanonicalTab(tab.canonicalTabId)}>
            {label}
          </button>
          <a
            aria-label={`Open ${label} in a new tab`}
            href={tab.url}
            rel="noreferrer"
            target="_blank"
          >
            Open
          </a>
          <span title={tab.url}>{hostname(tab.url)}</span>
        </div>
      </td>
      <td>
        <span className="browser-badge">
          <span
            aria-hidden="true"
            className={`browser-dot browser-${tab.browser.toLowerCase()}`}
          />
          <span>{browserLabel(tab.browser)}</span>
        </span>
        <span className="physical-location">{physicalLocation(tab)}</span>
      </td>
      <td>
        <div className="physical-flags">
          {tab.active ? <span className="physical-flag is-active">Active</span> : null}
          {tab.pinned ? <span className="physical-flag is-protected">Pinned</span> : null}
          {!tab.active && !tab.pinned ? <span className="physical-flag">Standard</span> : null}
        </div>
      </td>
      <td>
        {tab.duplicateGroupSize > 1 ? (
          <span className="duplicate-count">
            {tab.duplicateGroupSize.toLocaleString()} exact copies
          </span>
        ) : (
          <span className="unique-copy">Unique</span>
        )}
      </td>
    </tr>
  );
}

export function OpenTabsView({
  onSelectCanonicalTab,
}: {
  onSelectCanonicalTab: (id: number) => void;
}) {
  const [browser, setBrowser] = useState("all");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search, 300).trim();
  const openTabsQuery = useQuery({
    queryKey: ["tab-instances", { browser, duplicatesOnly, page, q }],
    queryFn: ({ signal }) =>
      fetchOpenTabs({ browser, duplicatesOnly, page, q }, signal),
    refetchInterval: 15_000,
  });
  const physicalCountQuery = useQuery({
    queryKey: ["tab-instances", "physical-total", { browser }],
    queryFn: ({ signal }) =>
      fetchOpenTabs(
        { browser, duplicatesOnly: false, page: 1, q: "" },
        signal,
      ),
    refetchInterval: 15_000,
  });
  const tabs = openTabsQuery.data?.items ?? [];
  const totalPages = openTabsQuery.data
    ? Math.max(1, Math.ceil(openTabsQuery.data.total / openTabsQuery.data.pageSize))
    : 1;
  const firstVisible = openTabsQuery.data?.total
    ? (openTabsQuery.data.page - 1) * openTabsQuery.data.pageSize + 1
    : 0;
  const lastVisible = firstVisible === 0 ? 0 : firstVisible + tabs.length - 1;

  useEffect(() => setPage(1), [browser, duplicatesOnly, q]);
  useEffect(() => {
    if (openTabsQuery.data === undefined) return;
    setPage((current) =>
      clampPage(
        current,
        openTabsQuery.data!.total,
        openTabsQuery.data!.pageSize,
      ),
    );
  }, [openTabsQuery.data?.pageSize, openTabsQuery.data?.total]);

  return (
    <section className="open-tabs-workspace" aria-label="Physical open tabs">
      <div className="physical-count-card">
        <div>
          <p>Live browser state</p>
          <strong>
            {physicalCountQuery.data
              ? `${physicalCountQuery.data.total.toLocaleString()} physical tabs open`
              : "Reading physical tabs..."}
          </strong>
          <span>Every open occurrence is listed, including exact copies.</span>
        </div>
        {(openTabsQuery.isFetching || physicalCountQuery.isFetching) &&
        !physicalCountQuery.isPending ? (
          <span className="refresh-status" role="status">
            <span aria-hidden="true" />
            Refreshing
          </span>
        ) : null}
      </div>

      <DuplicateReview
        browser={browser}
        onCollectionChanged={async () => {
          await Promise.all([openTabsQuery.refetch(), physicalCountQuery.refetch()]);
        }}
      />

      <div className="table-panel physical-table-panel">
        <div className="filter-bar">
          <label className="search-field physical-search-field">
            <span>Search open tab titles and URLs</span>
            <input
              autoComplete="off"
              maxLength={500}
              placeholder="Search open titles and URLs"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span>Browser</span>
            <select value={browser} onChange={(event) => setBrowser(event.target.value)}>
              <option value="all">All browsers</option>
              {Object.entries(BROWSER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="duplicates-toggle">
            <input
              checked={duplicatesOnly}
              type="checkbox"
              onChange={(event) => setDuplicatesOnly(event.target.checked)}
            />
            Exact duplicates only
          </label>
          <p className="result-count">
            {openTabsQuery.data
              ? openTabsQuery.data.total === 0
                ? "0 physical tabs"
                : `${firstVisible.toLocaleString()}-${lastVisible.toLocaleString()} of ${openTabsQuery.data.total.toLocaleString()}`
              : "Loading open tabs"}
          </p>
        </div>

        <div className="physical-table-scroll">
          <table className="physical-tabs-table">
            <caption className="sr-only">
              Every physical tab currently reported by connected browsers
            </caption>
            <thead>
              <tr>
                <th scope="col">Open tab</th>
                <th scope="col">Browser location</th>
                <th scope="col">Protection</th>
                <th scope="col">Exact copies</th>
              </tr>
            </thead>
            <tbody>
              {tabs.map((tab) => (
                <OpenTabRow
                  key={tab.instanceId}
                  tab={tab}
                  onSelectCanonicalTab={onSelectCanonicalTab}
                />
              ))}
            </tbody>
          </table>

          {openTabsQuery.isPending ? (
            <div className="state-panel loading-state" role="status">
              <div className="spinner" aria-hidden="true" />
              <div>
                <strong>Loading every open tab</strong>
                <span>Reading physical browser occurrences...</span>
              </div>
            </div>
          ) : null}
          {openTabsQuery.isError ? (
            <div className="state-panel error-state" role="alert">
              <div className="state-icon" aria-hidden="true">!</div>
              <div>
                <strong>Couldn't load open tabs</strong>
                <span>{openTabsQuery.error.message}</span>
              </div>
              <button type="button" onClick={() => void openTabsQuery.refetch()}>
                Try again
              </button>
            </div>
          ) : null}
          {openTabsQuery.isSuccess &&
          openTabsQuery.data !== undefined &&
          isTrulyEmptyPage(openTabsQuery.data) ? (
            <div className="state-panel empty-state" role="status">
              <div>
                <strong>
                  {duplicatesOnly ? "No exact duplicates match" : "No open tabs match"}
                </strong>
                <span>
                  {duplicatesOnly
                    ? "Active and pinned tabs can still appear when they belong to a duplicate group."
                    : "Wait for a connected extension to send its next snapshot."}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {openTabsQuery.data && openTabsQuery.data.total > 0 ? (
          <nav className="pagination" aria-label="Open-tab list pages">
            <p>
              Page <strong>{openTabsQuery.data.page.toLocaleString()}</strong> of{" "}
              {totalPages.toLocaleString()}
            </p>
            <div>
              <button
                disabled={page <= 1 || openTabsQuery.isFetching}
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages || openTabsQuery.isFetching}
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                Next
              </button>
            </div>
          </nav>
        ) : null}
      </div>
    </section>
  );
}
