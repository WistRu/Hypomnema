import type Database from "better-sqlite3";

import type {
  IngestContent,
  IngestContentResponse,
  IngestSnapshot,
  IngestSnapshotResponse,
  PatchTabStatusResponse,
  SetStatus,
  SetStatusResponse,
  TabDetailResponse,
  TabImportance,
  TabListItem,
  TabListResponse,
  TabStatus,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";

export interface ListTabsInput {
  browser: string | undefined;
  isOpen: boolean | undefined;
  page: number;
  pageSize: number;
  q: string | undefined;
  status: TabStatus | undefined;
  importance: TabImportance | undefined;
}

export interface TabCatalog {
  ingestSnapshot(snapshot: IngestSnapshot): IngestSnapshotResponse;
  ingestContent(content: IngestContent): IngestContentResponse;
  listTabs(input: ListTabsInput): TabListResponse;
  getTab(id: number): TabDetailResponse | undefined;
  updateStatus(
    id: number,
    status: TabStatus,
  ): PatchTabStatusResponse | undefined;
  updateStatuses(input: SetStatus): SetStatusResponse;
}

export class TabNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(browser: string, url: string) {
    super(`No captured tab exists for ${browser}: ${url}`);
    this.name = "TabNotFoundError";
  }
}

export class TabIdsNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly missingIds: number[]) {
    super(`No tabs exist with ids: ${missingIds.join(", ")}`);
    this.name = "TabIdsNotFoundError";
  }
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

interface TabDetailRow extends TabRow {
  content_tab_id: number | null;
  text: string | null;
  html_excerpt: string | null;
  summary_model: string | null;
  extracted_at: string | null;
}

interface TabTagRow {
  id: number;
  name: string;
  path: string;
  color: string | null;
  assigned_by: "user" | "agent";
}

interface TabLinkRow {
  id: number;
  from_tab: number;
  to_tab: number;
  kind: string;
  note: string | null;
  created_by: "user" | "agent";
}

interface CustomFieldRow {
  key: string;
  value: string | null;
}

interface CountRow {
  total: number;
}

interface TabIdRow {
  id: number;
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];

  if (tokens.length === 0) {
    return '"__tabhub_no_search_tokens__"';
  }

  return tokens.map((token) => `"${token}"`).join(" AND ");
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
  const selectTabId = connection.prepare(
    `SELECT id
       FROM tabs
      WHERE browser = ? AND url_normalized = ?`,
  );
  const upsertContent = connection.prepare(`
    INSERT INTO contents (tab_id, text, html_excerpt, extracted_at)
    VALUES (@tabId, @text, @htmlExcerpt, @extractedAt)
    ON CONFLICT (tab_id) DO UPDATE SET
      text = excluded.text,
      html_excerpt = excluded.html_excerpt,
      summary = NULL,
      summary_model = NULL,
      extracted_at = excluded.extracted_at
  `);
  const selectTabDetail = connection.prepare(`
    SELECT
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
      contents.tab_id AS content_tab_id,
      contents.text,
      contents.html_excerpt,
      contents.summary,
      contents.summary_model,
      contents.extracted_at
    FROM tabs
    LEFT JOIN contents ON contents.tab_id = tabs.id
    WHERE tabs.id = ?
  `);
  const selectTabTags = connection.prepare(`
    WITH RECURSIVE tag_paths(id, path) AS (
      SELECT id, name
      FROM tags
      WHERE parent_id IS NULL
      UNION ALL
      SELECT child.id, tag_paths.path || '/' || child.name
      FROM tags AS child
      JOIN tag_paths ON child.parent_id = tag_paths.id
    )
    SELECT tags.id, tags.name, tag_paths.path, tags.color, tab_tags.assigned_by
    FROM tab_tags
    JOIN tags ON tags.id = tab_tags.tag_id
    JOIN tag_paths ON tag_paths.id = tags.id
    WHERE tab_tags.tab_id = ?
    ORDER BY tag_paths.path, tags.id
  `);
  const selectTabLinks = connection.prepare(`
    SELECT id, from_tab, to_tab, kind, note, created_by
    FROM links
    WHERE from_tab = ? OR to_tab = ?
    ORDER BY id
  `);
  const selectCustomFields = connection.prepare(`
    SELECT key, value
    FROM custom_fields
    WHERE tab_id = ?
    ORDER BY key
  `);
  const updateTabStatus = connection.prepare(`
    UPDATE tabs
    SET status = ?
    WHERE id = ?
  `);
  const selectExistingTabId = connection.prepare(
    "SELECT id FROM tabs WHERE id = ?",
  );

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
  const updateStatusesTransaction = connection.transaction(
    (input: SetStatus): SetStatusResponse => {
      const missingIds = input.ids.filter(
        (id) => selectExistingTabId.get(id) === undefined,
      );

      if (missingIds.length > 0) {
        throw new TabIdsNotFoundError(missingIds);
      }

      let updated = 0;
      for (const id of input.ids) {
        updated += updateTabStatus.run(input.status, id).changes;
      }

      return { updated, status: input.status };
    },
  );

  return {
    ingestSnapshot(snapshot) {
      return ingestTransaction(snapshot);
    },

    ingestContent(content) {
      const tab = selectTabId.get(
        content.browser,
        normalizeUrl(content.url),
      ) as TabIdRow | undefined;

      if (tab === undefined) {
        throw new TabNotFoundError(content.browser, content.url);
      }

      const extractedAt = clock().toISOString();
      upsertContent.run({
        tabId: tab.id,
        text: content.text,
        htmlExcerpt: content.htmlExcerpt,
        extractedAt,
      });

      return { tabId: tab.id, extractedAt };
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

      if (input.q !== undefined) {
        predicates.push(
          "tabs.id IN (SELECT rowid FROM contents_fts WHERE contents_fts MATCH ?)",
        );
        parameters.push(toFtsQuery(input.q));
      }

      if (input.status !== undefined) {
        predicates.push("tabs.status = ?");
        parameters.push(input.status);
      }

      if (input.importance !== undefined) {
        predicates.push("tabs.importance = ?");
        parameters.push(input.importance);
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

    getTab(id) {
      const row = selectTabDetail.get(id) as TabDetailRow | undefined;

      if (row === undefined) {
        return undefined;
      }

      const tags = selectTabTags.all(id) as TabTagRow[];
      const links = selectTabLinks.all(id, id) as TabLinkRow[];
      const customFields = Object.fromEntries(
        (selectCustomFields.all(id) as CustomFieldRow[]).map((field) => [
          field.key,
          field.value,
        ]),
      );

      return {
        ...mapTabRow(row),
        content:
          row.content_tab_id === null
            ? null
            : {
                text: row.text,
                htmlExcerpt: row.html_excerpt,
                summary: row.summary,
                summaryModel: row.summary_model,
                extractedAt: row.extracted_at,
              },
        tags: tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          path: tag.path,
          color: tag.color,
          assignedBy: tag.assigned_by,
        })),
        links: links.map((link) => ({
          id: link.id,
          fromTab: link.from_tab,
          toTab: link.to_tab,
          kind: link.kind,
          note: link.note,
          createdBy: link.created_by,
        })),
        customFields,
      };
    },

    updateStatus(id, status) {
      if (updateTabStatus.run(status, id).changes === 0) {
        return undefined;
      }

      return { id, status };
    },

    updateStatuses(input) {
      return updateStatusesTransaction(input);
    },
  };
}
