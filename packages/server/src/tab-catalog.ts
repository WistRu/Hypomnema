import type Database from "better-sqlite3";

import type {
  ExactInstanceCaptureFailureCode,
  ExactInstanceContentIngest,
  ExactInstanceContentIngestResponse,
  IngestContent,
  IngestContentResponse,
  IngestSnapshot,
  IngestSnapshotResponse,
  LocalTabListResponse,
  PatchTab,
  PriorityMode,
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
import type { LogicalPageCatalog } from "./logical-page-catalog.js";
import type { PriorityListOrderingReader } from "./priority-list-ordering.js";
import {
  createPriorityListProjectionMaterializer,
  priorityListProjectionRelation,
} from "./priority-list-materialization.js";
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
  resourceId?: number | undefined;
  needsReview?: boolean | undefined;
}

export interface ListTabsInput extends FilterTabsInput {
  page: number;
  pageSize: number;
  priorityMode?: PriorityMode | undefined;
  rankedPage?: { ids: number[]; total: number };
  sortBy: TabSortField | undefined;
  sortDirection: SortDirection;
}

export interface TabCatalog {
  ingestSnapshot(snapshot: IngestSnapshot): IngestSnapshotResponse;
  ingestContent(content: IngestContent): IngestContentResponse;
  ingestExactInstanceContent(
    content: ExactInstanceContentIngest,
  ): ExactInstanceContentIngestResponse;
  listTabIds(input: FilterTabsInput): TabBulkIdsResponse;
  listLocalTabIds(input: FilterTabsInput): TabBulkIdsResponse;
  listTabs(input: ListTabsInput): TabListResponse;
  listLocalTabs(input: ListTabsInput): LocalTabListResponse;
  getTab(id: number): TabDetailResponse | undefined;
  updateTab(id: number, input: PatchTab): TabDetailResponse | undefined;
  updateImportances(input: SetImportance): SetImportanceResponse;
  updateImportancesOnBehalfOfUser(input: SetImportance): SetImportanceResponse;
  updateStatuses(input: SetStatus): SetStatusResponse;
}

export class TabNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(browser: string, url: string) {
    super(`No captured tab exists for ${browser}: ${url}`);
    this.name = "TabNotFoundError";
  }
}

export class ExactInstanceCaptureError extends Error {
  readonly recoverable = true as const;

  constructor(
    readonly code: ExactInstanceCaptureFailureCode,
    message: string,
    readonly observedUrl?: string,
  ) {
    super(message);
    this.name = "ExactInstanceCaptureError";
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
  logical_page_id: number;
}

interface TabDetailRow extends TabRow {
  content_tab_id: number | null;
  content_revision: number | null;
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
  logical_page_id: number;
}

interface ExactInstanceCaptureRow {
  instance_id: number;
  tab_id: number;
  logical_page_id: number;
  browser: string;
  installation_id: string;
  browser_session_id: string | null;
  browser_tab_id: number | null;
  url: string;
  navigation_revision: number;
  first_seen_at: string;
}

interface ContentRevisionRow {
  content_revision: number;
}

function isCapturablePageUrl(url: string): boolean {
  const protocol = new URL(url).protocol;
  return protocol === "http:" || protocol === "https:";
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];

  if (tokens.length === 0) {
    return '"__tabhub_no_search_tokens__"';
  }

  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function tabFilter(
  input: FilterTabsInput,
  includeLocalContext = false,
  includeResearch = true,
): {
  parameters: Array<string | number>;
  predicates: string[];
} {
  const predicates: string[] = [
    `NOT EXISTS (
      SELECT 1
      FROM page_retention
      WHERE page_retention.tab_id = tabs.id
        AND page_retention.state = 'trashed'
    )`,
  ];
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
      ${includeLocalContext ? `OR EXISTS (
        SELECT 1
        FROM context_entries AS search_context
        JOIN context_entries_fts
          ON context_entries_fts.rowid = search_context.id
        WHERE search_context.logical_page_id = tabs.logical_page_id
          AND search_context.state = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM context_entries AS newer_context
            WHERE newer_context.supersedes_id = search_context.id
          )
          AND (
            search_context.actor IN ('user', 'system')
            OR (
              search_context.actor = 'agent'
              AND EXISTS (
                SELECT 1
                FROM context_entry_reviews AS current_review
                WHERE current_review.context_entry_id = search_context.id
                  AND current_review.verdict = 'accepted'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM context_entry_reviews AS newer_review
                    WHERE newer_review.supersedes_id = current_review.id
                  )
              )
            )
          )
          AND context_entries_fts MATCH ?
      )` : ""}
      ${includeResearch ? `OR EXISTS (
        SELECT 1
        FROM research_target_heads AS search_research_head
        JOIN research_reports AS search_research_report
          ON search_research_report.id = search_research_head.current_fresh_report_id
        JOIN research_reports_fts
          ON research_reports_fts.rowid = search_research_report.id
        WHERE research_reports_fts MATCH ?
          AND (
            search_research_report.target_logical_page_id = tabs.logical_page_id
            OR EXISTS (
              SELECT 1
              FROM logical_page_resource_heads AS search_resource_head
              JOIN logical_page_resource_assignments AS search_resource_assignment
                ON search_resource_assignment.id = search_resource_head.assignment_id
                AND search_resource_assignment.logical_page_id =
                  search_resource_head.logical_page_id
              WHERE search_resource_head.logical_page_id = tabs.logical_page_id
                AND search_resource_assignment.action = 'assigned'
                AND search_resource_assignment.resource_id =
                  search_research_report.target_resource_id
            )
            OR EXISTS (
              SELECT 1
              FROM research_run_selection_pages AS search_selection_page
              WHERE search_selection_page.run_id = search_research_report.run_id
                AND search_selection_page.logical_page_id = tabs.logical_page_id
            )
          )
      )` : ""}
    )`);
    parameters.push(
      toFtsQuery(input.q),
      input.q,
      input.q,
      input.q,
      input.q,
      ...(includeLocalContext ? [toFtsQuery(input.q)] : []),
      ...(includeResearch ? [toFtsQuery(input.q)] : []),
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

  if (input.resourceId !== undefined) {
    predicates.push(`EXISTS (
      SELECT 1
      FROM logical_page_resource_heads AS resource_heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = resource_heads.assignment_id
      WHERE resource_heads.logical_page_id = tabs.logical_page_id
        AND assignments.action = 'assigned'
        AND assignments.resource_id = ?
    )`);
    parameters.push(input.resourceId);
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
    logicalPageId: row.logical_page_id,
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
  logicalPageCatalog: LogicalPageCatalog,
  logicalImportanceEnabled: boolean,
  clock: () => Date = () => new Date(),
  contextLedger?: {
    readLocal(subject: { type: "page"; logicalPageId: number }): {
      preview: LocalTabListResponse["items"][number]["contextPreview"];
    };
  },
  priorityReader?: () => PriorityListOrderingReader | undefined,
): TabCatalog {
  const researchSearchAvailable = connection.prepare(`
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table'
      AND name IN (
        'research_target_heads',
        'research_reports',
        'research_reports_fts',
        'research_run_selection_pages'
      )
  `).pluck().get() === 4;
  const priorityProjection = createPriorityListProjectionMaterializer(connection);
  const tabListSearchBaseRelation = "temp.tab_list_search_base";
  connection.exec(`CREATE TEMP TABLE IF NOT EXISTS tab_list_search_base (
    tab_id INTEGER PRIMARY KEY
  ) WITHOUT ROWID`);
  const clearTabListSearchBase = connection.prepare(
    `DELETE FROM ${tabListSearchBaseRelation}`,
  );
  const replaceTabListSearchBase = connection.transaction((
    predicates: readonly string[],
    parameters: readonly (string | number)[],
  ) => {
    clearTabListSearchBase.run();
    const whereClause = predicates.length > 0
      ? `WHERE ${predicates.join(" AND ")}` : "";
    connection.prepare(`INSERT INTO ${tabListSearchBaseRelation}(tab_id)
      SELECT tabs.id FROM tabs ${whereClause}`).run(...parameters);
  });
  const materializeTabListSearchBase = (
    input: ListTabsInput,
    predicates: string[],
    parameters: Array<string | number>,
  ): void => {
    if (input.q === undefined || input.rankedPage !== undefined) return;
    replaceTabListSearchBase(predicates, parameters);
    predicates.splice(0, predicates.length,
      `tabs.id IN (SELECT tab_id FROM ${tabListSearchBaseRelation})`);
    parameters.splice(0, parameters.length);
  };
  const upsertTab = connection.prepare(`
    INSERT INTO tabs (
      url,
      url_normalized,
      title,
      browser,
      window_id,
      tab_index,
      favicon_url,
      logical_page_id,
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
      @logicalPageId,
      @now,
      @now
    )
    ON CONFLICT (url_normalized, browser) DO UPDATE SET
      url = excluded.url,
      title = COALESCE(excluded.title, tabs.title),
      window_id = excluded.window_id,
      tab_index = excluded.tab_index,
      favicon_url = COALESCE(excluded.favicon_url, tabs.favicon_url),
      logical_page_id = excluded.logical_page_id,
      is_open = 1,
      last_seen_at = excluded.last_seen_at,
      closed_at = NULL
  `);
  const selectTabId = connection.prepare(
    `SELECT id
       FROM tabs
      WHERE browser = ? AND url_normalized = ?`,
  );
  const selectExactInstanceForCapture = connection.prepare(`
    SELECT
      tab_instances.id AS instance_id,
      tab_instances.tab_id,
      tabs.logical_page_id,
      tabs.browser,
      tab_instances.installation_id,
      tab_instances.browser_session_id,
      tab_instances.browser_tab_id,
      tab_instances.url,
      tab_instances.navigation_revision
      , tab_instances.first_seen_at
    FROM tab_instances
    JOIN tabs ON tabs.id = tab_instances.tab_id
    WHERE tab_instances.id = ?
  `);
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
  const selectContentRevision = connection.prepare(`
    SELECT content_revision
    FROM contents
    WHERE tab_id = ?
  `);
  const selectTabDetail = connection.prepare(`
    SELECT
      tabs.id,
      tabs.logical_page_id,
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
      contents.content_revision,
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
        const logicalPage = logicalPageCatalog.resolve({
          observedAt: now,
          url: tab.url,
          urlNormalized,
        });
        upsertTab.run({
          url: tab.url,
          urlNormalized,
          title: tab.title ?? null,
          browser: snapshot.browser,
          windowId: tab.windowId,
          tabIndex: tab.index,
          faviconUrl: tab.faviconUrl ?? null,
          logicalPageId: logicalPage.id,
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
  const updateLegacyImportancesTransaction = connection.transaction(
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
  const updateCanonicalImportances = (
    input: SetImportance,
    provenance:
      | { recordedBy: "user"; recordMethod: "manual" }
      | { recordedBy: "agent"; recordMethod: "on_behalf_of_user" },
  ): SetImportanceResponse => {
    const result = logicalPageCatalog.setImportance(input, provenance);
    if (result.kind === "missing") {
      throw new TabIdsNotFoundError(result.missingIds);
    }
    return { updated: result.updated, importance: input.importance };
  };

  const prioritySort = (
    input: ListTabsInput,
    predicates: string[],
    parameters: Array<string | number>,
    secondaryOrderClause: string,
  ): { readonly joinClause: string; readonly orderClause: string;
    readonly leadingParameters: readonly string[] } | null => {
    if (input.priorityMode === undefined && input.needsReview === undefined) {
      return null;
    }
    const needsProjection = input.priorityMode === "ai" ||
      input.priorityMode === "recommended" || input.needsReview !== undefined;
    if (needsProjection) {
      const reader = priorityReader?.();
      if (reader === undefined) {
        throw new Error("Priority list ordering reader is unavailable");
      }
      const subjectWhere = predicates.length > 0
        ? `WHERE ${predicates.join(" AND ")}` : "";
      const ids = (connection.prepare(`SELECT DISTINCT tabs.logical_page_id AS id
        FROM tabs ${subjectWhere} ORDER BY tabs.logical_page_id`
      ).pluck().all(...parameters) as number[]);
      priorityProjection.replace(reader, "page", ids, clock().toISOString());
    }
    const joins: string[] = [];
    if (input.priorityMode === "my" || input.priorityMode === "recommended") {
      joins.push(`LEFT JOIN logical_page_preferences AS priority_page_preferences
        ON priority_page_preferences.logical_page_id = tabs.logical_page_id`);
    }
    if (needsProjection) {
      joins.push(`LEFT JOIN ${priorityListProjectionRelation} AS priority_list_projection
        ON priority_list_projection.subject_id = tabs.logical_page_id`);
    }
    if (input.needsReview !== undefined) {
      predicates.push(`COALESCE(priority_list_projection.needs_review, 0) = ?`);
      parameters.push(input.needsReview ? 1 : 0);
    }
    const primary = input.priorityMode === "my"
      ? `COALESCE(priority_page_preferences.user_importance, 0) DESC`
      : input.priorityMode === "ai"
        ? `COALESCE(priority_list_projection.band_rank, 0) DESC,
          COALESCE(priority_list_projection.agent_score, -1) DESC`
        : input.priorityMode === "recommended"
          ? `CASE priority_page_preferences.user_importance
              WHEN 3 THEN 3 WHEN 2 THEN 2 WHEN 1 THEN 1
              ELSE COALESCE(priority_list_projection.band_rank, 0)
            END DESC,
            CASE WHEN priority_page_preferences.user_importance IS NULL
              THEN 0 ELSE 1 END DESC,
            COALESCE(priority_list_projection.agent_score, -1) DESC`
          : "";
    return {
      joinClause: joins.join("\n"),
      orderClause: [primary, secondaryOrderClause,
        "tabhub_sort_key(tabs.browser)", "tabs.browser", "tabs.id"]
        .filter((value) => value.trim().length > 0).join(",\n"),
      leadingParameters: [],
    };
  };

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
              contentRevision: row.content_revision!,
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
        if (logicalImportanceEnabled) {
          updateCanonicalImportances(
            { ids: [id], importance: input.importance },
            { recordedBy: "user", recordMethod: "manual" },
          );
        } else {
          updateTabImportance.run(input.importance, id);
        }
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
  const ingestExactInstanceContentTransaction = connection.transaction(
    (content: ExactInstanceContentIngest): ExactInstanceContentIngestResponse => {
      if (content.text.trim().length === 0) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_EXTRACTION_FAILED",
          "The selected page did not yield readable text.",
          content.observedUrl,
        );
      }
      if (!isCapturablePageUrl(content.target.expectedUrl)) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_PAGE_UNSUPPORTED",
          "Only http and https pages can be captured.",
          content.target.expectedUrl,
        );
      }

      const instance = selectExactInstanceForCapture.get(
        content.target.instanceId,
      ) as ExactInstanceCaptureRow | undefined;
      if (instance === undefined) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_INSTANCE_MISSING",
          "The selected physical tab instance no longer exists.",
        );
      }

      if (
        instance.browser !== content.browser ||
        instance.installation_id !== content.installationId ||
        instance.browser_session_id !== content.browserSessionId ||
        instance.browser_tab_id !== content.target.tabId
      ) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_SCOPE_MISMATCH",
          "The selected physical tab no longer belongs to the requested browser scope.",
        );
      }

      if (
        content.observedUrl !== content.target.expectedUrl ||
        instance.url !== content.target.expectedUrl
      ) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_TAB_NAVIGATED",
          "The selected physical tab navigated before capture completed.",
          instance.url,
        );
      }

      if (
        instance.navigation_revision !==
        content.target.expectedInstanceRevision
      ) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_INSTANCE_STALE",
          "The selected physical tab changed after it was selected.",
          instance.url,
        );
      }

      if (instance.first_seen_at !== content.target.expectedFirstSeenAt) {
        throw new ExactInstanceCaptureError(
          "CAPTURE_INSTANCE_STALE",
          "The selected physical tab incarnation no longer exists.",
          instance.url,
        );
      }

      const extractedAt = clock().toISOString();
      upsertContent.run({
        tabId: instance.tab_id,
        text: content.text,
        htmlExcerpt: content.htmlExcerpt,
        extractedAt,
      });
      const revision = selectContentRevision.get(
        instance.tab_id,
      ) as ContentRevisionRow | undefined;
      if (revision === undefined) {
        throw new Error("Captured content revision was not persisted");
      }

      return {
        instanceId: instance.instance_id,
        browserTabId: instance.browser_tab_id,
        canonicalTabId: instance.tab_id,
        logicalPageId: instance.logical_page_id,
        capturedUrl: instance.url,
        instanceRevision: instance.navigation_revision,
        firstSeenAt: instance.first_seen_at,
        contentRevision: revision.content_revision,
        extractedAt,
      };
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

    ingestExactInstanceContent(content) {
      return ingestExactInstanceContentTransaction(content);
    },

    listTabIds(input) {
      const { parameters, predicates } = tabFilter(
        input,
        false,
        researchSearchAvailable,
      );
      const priority = prioritySort({
        ...input,
        page: 1,
        pageSize: 1,
        sortBy: undefined,
        sortDirection: "asc",
      }, predicates, parameters, "");
      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const rows = connection
        .prepare(
          `SELECT tabs.id, tabs.browser AS browser, tabs.logical_page_id
           FROM tabs
           ${priority?.joinClause ?? ""}
           ${whereClause}
           ORDER BY ${stableBrowserOrderSql}, tabs.id`,
        )
        .all(...(priority?.leadingParameters ?? []), ...parameters) as TabIdRow[];
      return {
        ids: rows.map(({ id }) => id),
        logicalPageCount: new Set(rows.map(({ logical_page_id }) => logical_page_id)).size,
      };
    },

    listLocalTabIds(input) {
      if (contextLedger === undefined) {
        throw new Error("Local context is unavailable");
      }
      const { parameters, predicates } = tabFilter(
        input,
        true,
        researchSearchAvailable,
      );
      const priority = prioritySort({
        ...input,
        page: 1,
        pageSize: 1,
        sortBy: undefined,
        sortDirection: "asc",
      }, predicates, parameters, "");
      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const rows = connection
        .prepare(
          `SELECT tabs.id, tabs.browser AS browser, tabs.logical_page_id
           FROM tabs
           ${priority?.joinClause ?? ""}
           ${whereClause}
           ORDER BY ${stableBrowserOrderSql}, tabs.id`,
        )
        .all(...(priority?.leadingParameters ?? []), ...parameters) as TabIdRow[];
      return {
        ids: rows.map(({ id }) => id),
        logicalPageCount: new Set(rows.map(({ logical_page_id }) => logical_page_id)).size,
      };
    },

    listTabs(input) {
      const { parameters, predicates } = tabFilter(
        input,
        false,
        researchSearchAvailable,
      );

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
            secondaryOrderClause: "",
            withClause: "",
          };
        }
      }
      materializeTabListSearchBase(input, predicates, parameters);
      const priority = prioritySort(input, predicates, parameters,
        sortSql.secondaryOrderClause);
      if (priority !== null) {
        sortSql = {
          ...sortSql,
          joinClause: `${sortSql.joinClause}\n${priority.joinClause}`,
          orderClause: priority.orderClause,
        };
      }

      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const total =
        input.rankedPage?.total ??
        (
          connection
            .prepare(`SELECT COUNT(*) AS total FROM tabs
              ${priority?.joinClause ?? ""} ${whereClause}`)
            .get(...(priority?.leadingParameters ?? []), ...parameters) as CountRow
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
             tabs.logical_page_id,
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
        .all(...(priority?.leadingParameters ?? []), ...parameters,
          input.pageSize, offset) as TabRow[];
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

    listLocalTabs(input) {
      if (contextLedger === undefined) {
        throw new Error("Local context is unavailable");
      }
      const { parameters, predicates } = tabFilter(
        input,
        true,
        researchSearchAvailable,
      );
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
            secondaryOrderClause: "",
            withClause: "",
          };
        }
      }
      materializeTabListSearchBase(input, predicates, parameters);
      const priority = prioritySort(input, predicates, parameters,
        sortSql.secondaryOrderClause);
      if (priority !== null) {
        sortSql = {
          ...sortSql,
          joinClause: `${sortSql.joinClause}\n${priority.joinClause}`,
          orderClause: priority.orderClause,
        };
      }
      const whereClause =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const total =
        input.rankedPage?.total ??
        (
          connection
            .prepare(`SELECT COUNT(*) AS total FROM tabs
              ${priority?.joinClause ?? ""} ${whereClause}`)
            .get(...(priority?.leadingParameters ?? []), ...parameters) as CountRow
        ).total;
      const offset =
        input.rankedPage === undefined ? (input.page - 1) * input.pageSize : 0;
      const rows = connection
        .prepare(
          `${sortSql.withClause}
           SELECT tabs.*, contents.summary
           FROM tabs
           LEFT JOIN contents ON contents.tab_id = tabs.id
           ${sortSql.joinClause}
           ${whereClause}
           ORDER BY ${sortSql.orderClause}
           LIMIT ? OFFSET ?`,
        )
        .all(...(priority?.leadingParameters ?? []), ...parameters,
          input.pageSize, offset) as TabRow[];
      const activityByTab = loadActivitySummaries(rows.map(({ id }) => id));
      const tagPathsByTab = new Map<number, string[]>();
      if (rows.length > 0) {
        const placeholders = rows.map(() => "?").join(", ");
        const tags = connection
          .prepare(
            `WITH RECURSIVE tag_paths(id, path) AS (
               SELECT id, name FROM tags WHERE parent_id IS NULL
               UNION ALL
               SELECT child.id, tag_paths.path || '/' || child.name
               FROM tags AS child JOIN tag_paths ON tag_paths.id = child.parent_id
             )
             SELECT tab_tags.tab_id, tag_paths.path
             FROM tab_tags JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
             WHERE tab_tags.tab_id IN (${placeholders})
             ORDER BY tab_tags.tab_id, tabhub_sort_key(tag_paths.path), tag_paths.path, tag_paths.id`,
          )
          .all(...rows.map(({ id }) => id)) as TabTagPathRow[];
        for (const tag of tags) {
          const paths = tagPathsByTab.get(tag.tab_id) ?? [];
          paths.push(tag.path);
          tagPathsByTab.set(tag.tab_id, paths);
        }
      }
      return {
        items: rows.map((row) => ({
          ...mapTabRow(
            row,
            tagPathsByTab.get(row.id) ?? [],
            activityByTab.get(row.id),
          ),
          contextPreview: contextLedger.readLocal({
            type: "page",
            logicalPageId: row.logical_page_id,
          }).preview,
        })),
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
      return logicalImportanceEnabled
        ? updateCanonicalImportances(input, {
            recordedBy: "user",
            recordMethod: "manual",
          })
        : updateLegacyImportancesTransaction(input);
    },

    updateImportancesOnBehalfOfUser(input) {
      return updateCanonicalImportances(input, {
        recordedBy: "agent",
        recordMethod: "on_behalf_of_user",
      });
    },

    updateStatuses(input) {
      return updateStatusesTransaction(input);
    },
  };
}
