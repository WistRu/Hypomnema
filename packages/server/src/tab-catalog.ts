import type Database from "better-sqlite3";

import type {
  IngestSnapshot,
  IngestSnapshotResponse,
  TabListItem,
  TabListResponse,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";

export interface ListTabsInput {
  browser: string | undefined;
  isOpen: boolean | undefined;
  page: number;
  pageSize: number;
}

export interface TabCatalog {
  ingestSnapshot(snapshot: IngestSnapshot): IngestSnapshotResponse;
  listTabs(input: ListTabsInput): TabListResponse;
}

interface OpenTabRow {
  url_normalized: string;
}

interface TabRow {
  id: number;
  url: string;
  url_normalized: string;
  title: string | null;
  browser: string;
  window_id: number | null;
  tab_index: number | null;
  favicon_url: string | null;
  status: TabListItem["status"];
  importance: TabListItem["importance"];
  is_open: 0 | 1;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  summary: string | null;
}

interface CountRow {
  total: number;
}

function mapTabRow(row: TabRow): TabListItem {
  return {
    id: row.id,
    url: row.url,
    urlNormalized: row.url_normalized,
    title: row.title,
    browser: row.browser,
    windowId: row.window_id,
    index: row.tab_index,
    faviconUrl: row.favicon_url,
    status: row.status,
    importance: row.importance,
    isOpen: row.is_open === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
    summary: row.summary,
  };
}

export function createTabCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
): TabCatalog {
  const selectOpenTabs = connection.prepare(
    `SELECT url_normalized
       FROM tabs
      WHERE browser = ? AND is_open = 1`,
  );
  const closeTab = connection.prepare(
    `UPDATE tabs
        SET is_open = 0, closed_at = ?
      WHERE browser = ? AND url_normalized = ? AND is_open = 1`,
  );
  const upsertTab = connection.prepare(`
    INSERT INTO tabs (
      url,
      url_normalized,
      title,
      browser,
      window_id,
      tab_index,
      favicon_url,
      first_seen_at,
      last_seen_at
    ) VALUES (
      @url,
      @urlNormalized,
      @title,
      @browser,
      @windowId,
      @tabIndex,
      @faviconUrl,
      @now,
      @now
    )
    ON CONFLICT (url_normalized, browser) DO UPDATE SET
      url = excluded.url,
      title = COALESCE(excluded.title, tabs.title),
      window_id = excluded.window_id,
      tab_index = excluded.tab_index,
      favicon_url = COALESCE(excluded.favicon_url, tabs.favicon_url),
      is_open = 1,
      last_seen_at = excluded.last_seen_at,
      closed_at = NULL
  `);

  const ingestTransaction = connection.transaction(
    (snapshot: IngestSnapshot): IngestSnapshotResponse => {
      const now = clock().toISOString();
      const currentTabs = new Map(
        snapshot.tabs.map((tab) => [normalizeUrl(tab.url), tab]),
      );
      const previouslyOpen = selectOpenTabs.all(
        snapshot.browser,
      ) as OpenTabRow[];
      let closed = 0;

      for (const previousTab of previouslyOpen) {
        if (!currentTabs.has(previousTab.url_normalized)) {
          closed += closeTab.run(
            now,
            snapshot.browser,
            previousTab.url_normalized,
          ).changes;
        }
      }

      for (const [urlNormalized, tab] of currentTabs) {
        upsertTab.run({
          url: tab.url,
          urlNormalized,
          title: tab.title ?? null,
          browser: snapshot.browser,
          windowId: tab.windowId,
          tabIndex: tab.index,
          faviconUrl: tab.faviconUrl ?? null,
          now,
        });
      }

      return { upserted: currentTabs.size, closed };
    },
  );

  return {
    ingestSnapshot(snapshot) {
      return ingestTransaction(snapshot);
    },

    listTabs(input) {
      const predicates: string[] = [];
      const parameters: Array<string | number> = [];

      if (input.browser !== undefined) {
        predicates.push("tabs.browser = ?");
        parameters.push(input.browser);
      }

      if (input.isOpen !== undefined) {
        predicates.push("tabs.is_open = ?");
        parameters.push(input.isOpen ? 1 : 0);
      }

      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const count = connection
        .prepare(`SELECT COUNT(*) AS total FROM tabs ${whereClause}`)
        .get(...parameters) as CountRow;
      const offset = (input.page - 1) * input.pageSize;
      const rows = connection
        .prepare(
          `SELECT
             tabs.id,
             tabs.url,
             tabs.url_normalized,
             tabs.title,
             tabs.browser,
             tabs.window_id,
             tabs.tab_index,
             tabs.favicon_url,
             tabs.status,
             tabs.importance,
             tabs.is_open,
             tabs.first_seen_at,
             tabs.last_seen_at,
             tabs.closed_at,
             contents.summary
           FROM tabs
           LEFT JOIN contents ON contents.tab_id = tabs.id
           ${whereClause}
           ORDER BY tabs.last_seen_at DESC, tabs.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, input.pageSize, offset) as TabRow[];

      return {
        items: rows.map(mapTabRow),
        total: count.total,
        page: input.page,
        pageSize: input.pageSize,
      };
    },
  };
}
