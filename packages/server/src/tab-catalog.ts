import type Database from "better-sqlite3";

import type {
  IngestContent,
  IngestContentResponse,
  IngestSnapshot,
  IngestSnapshotResponse,
  PatchTab,
  SetImportance,
  SetImportanceResponse,
  SetStatus,
  SetStatusResponse,
  SortDirection,
  TabBulkIdsResponse,
  TabDetailResponse,
  TabImportance,
  TabListItem,
  TabListResponse,
  TabSortField,
  TabStatus,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";
import { stableBrowserOrderSql } from "./stable-tab-order.js";
import type { TabInstanceCatalog } from "./tab-instance-catalog.js";
import { tabListSortSql } from "./tab-list-sort.js";

export interface FilterTabsInput {
  browser: string | undefined;
  duplicatesOnly: boolean;
  isOpen: boolean | undefined;
  q: string | undefined;
  status: TabStatus | undefined;
  importance: TabImportance | undefined;
  tag: string | undefined;
}

export interface ListTabsInput extends FilterTabsInput {
  page: number;
  pageSize: number;
  rankedPage?: { ids: number[]; total: number };
  sortBy: TabSortField | undefined;
  sortDirection: SortDirection;
}

export interface TabCatalog {
  ingestSnapshot(snapshot: IngestSnapshot): IngestSnapshotResponse;
  ingestContent(content: IngestContent): IngestContentResponse;
  listTabIds(input: FilterTabsInput): TabBulkIdsResponse;
  listTabs(input: ListTabsInput): TabListResponse;
  getTab(id: number): TabDetailResponse | undefined;
  updateTab(id: number, input: PatchTab): TabDetailResponse | undefined;
  updateImportances(input: SetImportance): SetImportanceResponse;
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

interface TabTagPathRow {
  tab_id: number;
  path: string;
}

interface TabActivitySummaryRow {
  tab_id: number;
  foreground_time_ms: number;
  engaged_time_ms: number;
  open_instance_count: number;
  open_foreground_time_ms: number;
  open_engaged_time_ms: number;
}

interface TabActivitySummary {
  foregroundTimeMs: number;
  engagedTimeMs: number;
  openInstanceCount: number;
  openForegroundTimeMs: number;
  openEngagedTimeMs: number;
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

  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function tabFilter(input: FilterTabsInput): {
  parameters: Array<string | number>;
  predicates: string[];
} {
  const predicates: string[] = [];
  const parameters: Array<string | number> = [];

  if (input.browser !== undefined) {
    predicates.push("tabs.browser = ?");
    parameters.push(input.browser);
  }

  if (input.duplicatesOnly) {
    predicates.push(`tabs.id IN (
      SELECT tab_instances.tab_id
      FROM tab_instances
      GROUP BY tab_instances.tab_id
      HAVING COUNT(*) > 1
    )`);
  }

  if (input.isOpen !== undefined) {
    predicates.push("tabs.is_open = ?");
    parameters.push(input.isOpen ? 1 : 0);
  }

  if (input.q !== undefined) {
    predicates.push(`(
      tabs.id IN (
        SELECT rowid FROM contents_fts WHERE contents_fts MATCH ?
      )
      OR tabhub_contains_normalized(tabs.title, ?) = 1
      OR tabhub_contains_normalized(tabs.url, ?) = 1
      OR EXISTS (
        SELECT 1
        FROM tab_instances AS search_instances
        WHERE search_instances.tab_id = tabs.id
          AND (
            tabhub_contains_normalized(search_instances.title, ?) = 1
            OR tabhub_contains_normalized(search_instances.url, ?) = 1
          )
      )
    )`);
    parameters.push(
      toFtsQuery(input.q),
      input.q,
      input.q,
      input.q,
      input.q,
    );
  }

  if (input.status !== undefined) {
    predicates.push("tabs.status = ?");
    parameters.push(input.status);
  }

  if (input.importance !== undefined) {
    predicates.push("tabs.importance = ?");
    parameters.push(input.importance);
  }

  if (input.tag !== undefined) {
    predicates.push(`tabs.id IN (
      WITH RECURSIVE
        tag_paths(id, path) AS (
          SELECT id, name
          FROM tags
          WHERE parent_id IS NULL
          UNION ALL
          SELECT child.id, tag_paths.path || '/' || child.name
          FROM tags AS child
          JOIN tag_paths ON child.parent_id = tag_paths.id
        ),
        descendants(id) AS (
          SELECT id
          FROM tag_paths
          WHERE path = ?
          UNION ALL
          SELECT child.id
          FROM tags AS child
          JOIN descendants ON child.parent_id = descendants.id
        )
      SELECT tab_tags.tab_id
      FROM tab_tags
      JOIN descendants ON descendants.id = tab_tags.tag_id
    )`);
    parameters.push(input.tag);
  }

  return { parameters, predicates };
}

const emptyTabActivitySummary: TabActivitySummary = {
  foregroundTimeMs: 0,
  engagedTimeMs: 0,
  openInstanceCount: 0,
  openForegroundTimeMs: 0,
  openEngagedTimeMs: 0,
};

function mapTabRow(
  row: TabRow,
  tagPaths: string[],
  activity: TabActivitySummary = emptyTabActivitySummary,
): TabListItem {
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
    tagPaths,
    ...activity,
  };
}

export function createTabCatalog(
  connection: Database.Database,
  tabInstanceCatalog: TabInstanceCatalog,
  clock: () => Date = () => new Date(),
): TabCatalog {
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
      extracted_at = excluded.extracted_at,
      content_revision = contents.content_revision + 1,
      summary_job_id = NULL,
      summary_generated_at = NULL
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
    ORDER BY tabhub_sort_key(tag_paths.path), tag_paths.path, tags.id
  `);
  const selectTabLinks = connection.prepare(`
    SELECT
      relations.id,
      from_entity.tab_id AS from_tab,
      to_entity.tab_id AS to_tab,
      relations.kind,
      relations.note,
      relations.created_by
    FROM relations
    JOIN knowledge_entities AS from_entity
      ON from_entity.id = relations.from_entity_id
     AND from_entity.kind = 'tab'
    JOIN knowledge_entities AS to_entity
      ON to_entity.id = relations.to_entity_id
     AND to_entity.kind = 'tab'
    WHERE from_entity.tab_id = ? OR to_entity.tab_id = ?
    ORDER BY relations.id
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
  const updateTabImportance = connection.prepare(`
    UPDATE tabs
    SET importance = ?
    WHERE id = ?
  `);
  const upsertCustomField = connection.prepare(`
    INSERT INTO custom_fields (tab_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT (tab_id, key) DO UPDATE SET value = excluded.value
  `);
  const deleteCustomField = connection.prepare(`
    DELETE FROM custom_fields
    WHERE tab_id = ? AND key = ?
  `);
  const selectExistingTabId = connection.prepare(
    "SELECT id FROM tabs WHERE id = ?",
  );

  const loadActivitySummaries = (
    tabIds: number[],
  ): Map<number, TabActivitySummary> => {
    if (tabIds.length === 0) return new Map();

    const placeholders = tabIds.map(() => "?").join(", ");
    const rows = connection
      .prepare(`
        SELECT
          tabs.id AS tab_id,
          COALESCE(tab_page_activity_totals.foreground_ms, 0)
            AS foreground_time_ms,
          COALESCE(tab_page_activity_totals.engaged_ms, 0)
            AS engaged_time_ms,
          COUNT(tab_instances.id) AS open_instance_count,
          COALESCE(SUM(tab_activity_totals.foreground_ms), 0)
            AS open_foreground_time_ms,
          COALESCE(SUM(tab_activity_totals.engaged_ms), 0)
            AS open_engaged_time_ms
        FROM tabs
        LEFT JOIN tab_page_activity_totals
          ON tab_page_activity_totals.browser = tabs.browser
         AND tab_page_activity_totals.url_normalized = tabs.url_normalized
        LEFT JOIN tab_instances ON tab_instances.tab_id = tabs.id
        LEFT JOIN tab_activity_totals
          ON tab_activity_totals.installation_id = tab_instances.installation_id
         AND tab_activity_totals.browser_session_id IS tab_instances.browser_session_id
         AND tab_activity_totals.browser_tab_id IS tab_instances.browser_tab_id
        WHERE tabs.id IN (${placeholders})
        GROUP BY tabs.id
      `)
      .all(...tabIds) as TabActivitySummaryRow[];

    return new Map(
      rows.map((row) => [
        row.tab_id,
        {
          foregroundTimeMs: row.foreground_time_ms,
          engagedTimeMs: row.engaged_time_ms,
          openInstanceCount: row.open_instance_count,
          openForegroundTimeMs: row.open_foreground_time_ms,
          openEngagedTimeMs: row.open_engaged_time_ms,
        },
      ]),
    );
  };

  const ingestTransaction = connection.transaction(
    (snapshot: IngestSnapshot): IngestSnapshotResponse => {
      const now = clock().toISOString();
      const currentTabs = new Map(
        snapshot.tabs.map((tab) => [normalizeUrl(tab.url), tab]),
      );

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

      const { closed } = tabInstanceCatalog.syncSnapshot(snapshot, now);
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
  const updateImportancesTransaction = connection.transaction(
    (input: SetImportance): SetImportanceResponse => {
      const missingIds = input.ids.filter(
        (id) => selectExistingTabId.get(id) === undefined,
      );

      if (missingIds.length > 0) {
        throw new TabIdsNotFoundError(missingIds);
      }

      let updated = 0;
      for (const id of input.ids) {
        updated += updateTabImportance.run(input.importance, id).changes;
      }

      return { updated, importance: input.importance };
    },
  );

  const getTabDetail = (id: number): TabDetailResponse | undefined => {
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
    const activity = loadActivitySummaries([id]).get(id);

    return {
      ...mapTabRow(
        row,
        tags.map((tag) => tag.path),
        activity,
      ),
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
  };
  const updateTabTransaction = connection.transaction(
    (id: number, input: PatchTab): TabDetailResponse | undefined => {
      if (selectExistingTabId.get(id) === undefined) {
        return undefined;
      }

      if (input.status !== undefined) {
        updateTabStatus.run(input.status, id);
      }
      if (input.importance !== undefined) {
        updateTabImportance.run(input.importance, id);
      }
      if (input.customFields !== undefined) {
        for (const [key, value] of Object.entries(input.customFields)) {
          if (value === null) {
            deleteCustomField.run(id, key);
          } else {
            upsertCustomField.run(id, key, value);
          }
        }
      }

      return getTabDetail(id);
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

    listTabIds(input) {
      const { parameters, predicates } = tabFilter(input);
      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const rows = connection
        .prepare(
          `SELECT tabs.id, tabs.browser AS browser
           FROM tabs
           ${whereClause}
           ORDER BY ${stableBrowserOrderSql}, tabs.id`,
        )
        .all(...parameters) as TabIdRow[];
      return { ids: rows.map(({ id }) => id) };
    },

    listTabs(input) {
      const { parameters, predicates } = tabFilter(input);

      let sortSql = tabListSortSql(input.sortBy, input.sortDirection);
      if (input.rankedPage !== undefined) {
        if (input.rankedPage.ids.length === 0) {
          predicates.push("0");
        } else {
          const rankedIds = input.rankedPage.ids.join(", ");
          predicates.push(`tabs.id IN (${rankedIds})`);
          sortSql = {
            joinClause: "",
            orderClause: `CASE tabs.id ${input.rankedPage.ids
              .map((id, rank) => `WHEN ${id} THEN ${rank}`)
              .join(" ")} ELSE ${input.rankedPage.ids.length} END`,
            withClause: "",
          };
        }
      }

      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const total =
        input.rankedPage?.total ??
        (
          connection
            .prepare(`SELECT COUNT(*) AS total FROM tabs ${whereClause}`)
            .get(...parameters) as CountRow
        ).total;
      const offset =
        input.rankedPage === undefined
          ? (input.page - 1) * input.pageSize
          : 0;
      const rows = connection
        .prepare(
          `${sortSql.withClause}
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
             contents.summary
           FROM tabs
           LEFT JOIN contents ON contents.tab_id = tabs.id
           ${sortSql.joinClause}
           ${whereClause}
           ORDER BY ${sortSql.orderClause}
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, input.pageSize, offset) as TabRow[];
      const activityByTab = loadActivitySummaries(rows.map(({ id }) => id));
      const tagPathsByTab = new Map<number, string[]>();
      if (rows.length > 0) {
        const placeholders = rows.map(() => "?").join(", ");
        const tagPathRows = connection
          .prepare(
            `WITH RECURSIVE tag_paths(id, path) AS (
               SELECT id, name
               FROM tags
               WHERE parent_id IS NULL
               UNION ALL
               SELECT child.id, tag_paths.path || '/' || child.name
               FROM tags AS child
               JOIN tag_paths ON child.parent_id = tag_paths.id
             )
             SELECT tab_tags.tab_id, tag_paths.path
             FROM tab_tags
             JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
             WHERE tab_tags.tab_id IN (${placeholders})
             ORDER BY
               tab_tags.tab_id,
               tabhub_sort_key(tag_paths.path),
               tag_paths.path,
               tag_paths.id`,
          )
          .all(...rows.map(({ id }) => id)) as TabTagPathRow[];

        for (const tag of tagPathRows) {
          const paths = tagPathsByTab.get(tag.tab_id) ?? [];
          paths.push(tag.path);
          tagPathsByTab.set(tag.tab_id, paths);
        }
      }

      return {
        items: rows.map((row) =>
          mapTabRow(
            row,
            tagPathsByTab.get(row.id) ?? [],
            activityByTab.get(row.id),
          ),
        ),
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    },

    getTab(id) {
      return getTabDetail(id);
    },

    updateTab(id, input) {
      return updateTabTransaction(id, input);
    },

    updateImportances(input) {
      return updateImportancesTransaction(input);
    },

    updateStatuses(input) {
      return updateStatusesTransaction(input);
    },
  };
}
