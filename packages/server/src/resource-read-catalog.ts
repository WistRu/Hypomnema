import type Database from "better-sqlite3";

import {
  resourceDetailSchema,
  resourceListResponseSchema,
  resourcePagesResponseSchema,
  type ResourceDetail,
  type ResourceListQuery,
  type ResourceListResponse,
  type ResourcePagesQuery,
  type ResourcePagesResponse,
  type ResourceSummary,
} from "@tabhub/shared";
import type { PriorityListOrderingReader } from "./priority-list-ordering.js";
import {
  createPriorityListProjectionMaterializer,
  priorityListProjectionRelation,
} from "./priority-list-materialization.js";

interface ResourceReadRow {
  id: number;
  resource_key: string;
  version: number;
  name: string;
  kind: ResourceSummary["resource"]["kind"];
  access_class: ResourceSummary["resource"]["accessClass"];
  lifecycle_state: ResourceSummary["resource"]["lifecycleState"];
  merged_into_resource_id: number | null;
  created_at: string;
  updated_at: string;
  user_evaluation: 1 | 2 | 3 | null;
  recorded_by: "user" | "agent" | null;
  record_method: "manual" | "on_behalf_of_user" | null;
  preference_updated_at: string;
  logical_page_count: number;
  browser_page_count: number;
  physical_open_copy_count: number;
  on_screen_ms: number;
  active_use_ms: number;
  coverage_start: string | null;
}

export interface ResourceReadCatalog {
  list(query: ResourceListQuery): ResourceListResponse;
  get(resourceId: number): ResourceDetail | undefined;
  pages(resourceId: number, query: ResourcePagesQuery): ResourcePagesResponse | undefined;
}

const currentMembershipSql = `
  SELECT assignments.logical_page_id, assignments.resource_id,
    assignments.id AS assignment_id, assignments.provenance_class
  FROM logical_page_resource_heads AS assignment_heads
  JOIN logical_page_resource_assignments AS assignments
    ON assignments.id = assignment_heads.assignment_id
  WHERE assignments.action = 'assigned'
`;

const tagPathsSql = `
  WITH RECURSIVE tag_paths(id, path) AS (
    SELECT id, name FROM tags WHERE parent_id IS NULL
    UNION ALL
    SELECT child.id, tag_paths.path || '/' || child.name
    FROM tags AS child JOIN tag_paths ON child.parent_id = tag_paths.id
  )
`;

const descendantTopicTabIdsSql = `
  WITH RECURSIVE tag_paths(id, path) AS (
    SELECT id, name FROM tags WHERE parent_id IS NULL
    UNION ALL
    SELECT child.id, tag_paths.path || '/' || child.name
    FROM tags AS child JOIN tag_paths ON child.parent_id = tag_paths.id
  ), descendants(id) AS (
    SELECT id FROM tag_paths WHERE path = ?
    UNION ALL
    SELECT child.id FROM tags AS child
    JOIN descendants ON child.parent_id = descendants.id
  )
  SELECT tab_tags.tab_id FROM tab_tags
  JOIN descendants ON descendants.id = tab_tags.tag_id
`;

function mapSummary(
  row: ResourceReadRow,
  topicPaths: string[],
): ResourceSummary {
  return {
    resource: {
      id: row.id,
      resourceKey: row.resource_key,
      name: row.name,
      kind: row.kind,
      accessClass: row.access_class,
      lifecycleState: row.lifecycle_state,
      mergedIntoResourceId: row.merged_into_resource_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    version: row.version,
    preference: {
      userEvaluation: row.user_evaluation,
      provenance:
        row.recorded_by === "user" && row.record_method === "manual"
          ? { actor: "user", method: "manual" }
          : row.recorded_by === "agent" && row.record_method === "on_behalf_of_user"
            ? { actor: "agent", method: "on_behalf_of_user" }
            : null,
      updatedAt: row.preference_updated_at,
    },
    counts: {
      logicalPageCount: row.logical_page_count,
      browserPageCount: row.browser_page_count,
      physicalOpenCopyCount: row.physical_open_copy_count,
    },
    allTimeActivity: {
      window: "all",
      onScreenMs: row.on_screen_ms,
      activeUseMs: row.active_use_ms,
      coverageStart: row.coverage_start,
    },
    topicPaths,
  };
}

export function createResourceReadCatalog(
  connection: Database.Database,
  priorityReader?: () => PriorityListOrderingReader | undefined,
  clock: () => Date = () => new Date(),
): ResourceReadCatalog {
  const priorityProjection = createPriorityListProjectionMaterializer(connection);
  const baseSelect = `
    SELECT resources.id, resources.resource_key,
      events.version, events.name, events.kind, events.access_class,
      events.lifecycle_state, events.merged_into_resource_id,
      resources.created_at, events.created_at AS updated_at,
      preferences.user_evaluation, preferences.recorded_by,
      preferences.record_method,
      preferences.updated_at AS preference_updated_at,
      (SELECT COUNT(DISTINCT membership.logical_page_id)
       FROM (${currentMembershipSql}) AS membership
       WHERE membership.resource_id = resources.id) AS logical_page_count,
      (SELECT COUNT(*) FROM tabs
       WHERE tabs.logical_page_id IN (
         SELECT membership.logical_page_id FROM (${currentMembershipSql}) AS membership
         WHERE membership.resource_id = resources.id
       )) AS browser_page_count,
      (SELECT COUNT(*) FROM tab_instances
       JOIN tabs ON tabs.id = tab_instances.tab_id
       WHERE tabs.logical_page_id IN (
         SELECT membership.logical_page_id FROM (${currentMembershipSql}) AS membership
         WHERE membership.resource_id = resources.id
       )) AS physical_open_copy_count,
      COALESCE((SELECT SUM(activity.foreground_ms)
       FROM tab_page_activity_totals AS activity
       JOIN logical_pages ON logical_pages.url_normalized = activity.url_normalized
       WHERE logical_pages.id IN (
         SELECT membership.logical_page_id FROM (${currentMembershipSql}) AS membership
         WHERE membership.resource_id = resources.id
       )), 0) AS on_screen_ms,
      COALESCE((SELECT SUM(activity.engaged_ms)
       FROM tab_page_activity_totals AS activity
       JOIN logical_pages ON logical_pages.url_normalized = activity.url_normalized
       WHERE logical_pages.id IN (
         SELECT membership.logical_page_id FROM (${currentMembershipSql}) AS membership
         WHERE membership.resource_id = resources.id
       )), 0) AS active_use_ms,
      NULL AS coverage_start
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events ON events.id = heads.event_id
    JOIN resource_preferences AS preferences ON preferences.resource_id = resources.id
  `;
  const topicPaths = connection.prepare(`${tagPathsSql}
    SELECT DISTINCT tag_paths.path
    FROM tag_paths
    JOIN tab_tags ON tab_tags.tag_id = tag_paths.id
    JOIN tabs ON tabs.id = tab_tags.tab_id
    WHERE tabs.logical_page_id IN (
      SELECT membership.logical_page_id FROM (${currentMembershipSql}) AS membership
      WHERE membership.resource_id = ?
    )
    ORDER BY tag_paths.path
  `);
  const selectDetail = connection.prepare(`${baseSelect} WHERE resources.id = ?`);
  const selectRulesetVersion = connection.prepare(`
    SELECT events.version FROM resource_ruleset_heads AS heads
    JOIN resource_ruleset_events AS events ON events.id = heads.ruleset_event_id
    WHERE heads.scope = 'global'
  `);
  const selectAliases = connection.prepare(`
    SELECT rules.* FROM resource_match_rule_heads AS heads
    JOIN resource_match_rules AS rules ON rules.id = heads.rule_id
    WHERE rules.resource_id = ? ORDER BY rules.rule_key
  `);

  const pathsFor = (resourceId: number): string[] =>
    topicPaths.pluck().all(resourceId) as string[];

  return {
    list(query) {
      const predicates = ["events.lifecycle_state = ?"];
      const parameters: Array<string | number> = [query.lifecycleState ?? "active"];
      if (query.q !== undefined) {
        predicates.push("(tabhub_contains_normalized(events.name, ?) = 1 OR tabhub_contains_normalized(resources.resource_key, ?) = 1)");
        parameters.push(query.q, query.q);
      }
      if (query.kind !== undefined) {
        predicates.push("events.kind = ?"); parameters.push(query.kind);
      }
      if (query.accessClass !== undefined) {
        predicates.push("events.access_class = ?"); parameters.push(query.accessClass);
      }
      const pageFilters: string[] = [];
      if (query.browser !== undefined) { pageFilters.push("tabs.browser = ?"); parameters.push(query.browser); }
      if (query.status !== undefined) { pageFilters.push("tabs.status = ?"); parameters.push(query.status); }
      if (query.importance !== undefined) { pageFilters.push("tabs.importance = ?"); parameters.push(query.importance); }
      if (query.tag !== undefined) {
        pageFilters.push(`tabs.id IN (${descendantTopicTabIdsSql})`);
        parameters.push(query.tag);
      }
      if (pageFilters.length > 0) {
        predicates.push(`EXISTS (
          SELECT 1 FROM (${currentMembershipSql}) AS membership
          JOIN tabs ON tabs.logical_page_id = membership.logical_page_id
          WHERE membership.resource_id = resources.id AND ${pageFilters.join(" AND ")}
        )`);
      }
      const where = `WHERE ${predicates.join(" AND ")}`;
      const sortColumn = {
        name: "name COLLATE NOCASE",
        logical_pages: "logical_page_count",
        activity: "on_screen_ms",
        updated_at: "updated_at",
      }[query.sort_by];
      const direction = query.sort_direction === "desc" ? "DESC" : "ASC";
      if (query.priority_mode === undefined && query.needs_review === undefined) {
        const total = Number(connection.prepare(
          `SELECT COUNT(*) FROM (${baseSelect} ${where})`,
        ).pluck().get(...parameters));
        const rows = connection.prepare(`${baseSelect} ${where}
          ORDER BY ${sortColumn} ${direction}, resources.id ASC LIMIT ? OFFSET ?
        `).all(...parameters, query.pageSize,
          (query.page - 1) * query.pageSize) as ResourceReadRow[];
        return resourceListResponseSchema.parse({
          items: rows.map((row) => mapSummary(row, pathsFor(row.id))),
          total, page: query.page, pageSize: query.pageSize,
        });
      }
      const needsProjection = query.priority_mode === "ai" ||
        query.priority_mode === "recommended" || query.needs_review !== undefined;
      if (needsProjection) {
        const reader = priorityReader?.();
        if (reader === undefined) {
          throw new Error("Priority Resource ordering reader is unavailable");
        }
        const ids = connection.prepare(`SELECT id FROM (${baseSelect} ${where})
          WHERE lifecycle_state = 'active' ORDER BY id`
        ).pluck().all(...parameters) as number[];
        priorityProjection.replace(reader, "resource", ids, clock().toISOString());
      }
      const priorityWhere = query.needs_review === undefined ? "" : `WHERE
        COALESCE(priority_list_projection.needs_review, 0) =
          ${query.needs_review ? 1 : 0}`;
      const priorityJoin = !needsProjection ? "" :
        `LEFT JOIN ${priorityListProjectionRelation} AS priority_list_projection
          ON priority_list_projection.subject_id = resource_rows.id`;
      const resultSource = `FROM (${baseSelect} ${where}) AS resource_rows
        ${priorityJoin} ${priorityWhere}`;
      const resultParameters = parameters;
      const total = Number(connection.prepare(`SELECT COUNT(*) ${resultSource}`)
        .pluck().get(...resultParameters));
      const priorityOrder = query.priority_mode === "my"
        ? "COALESCE(resource_rows.user_evaluation, 0) DESC,"
        : query.priority_mode === "ai"
          ? `COALESCE(priority_list_projection.band_rank, 0) DESC,
            COALESCE(priority_list_projection.agent_score, -1) DESC,`
          : query.priority_mode === "recommended"
            ? `CASE resource_rows.user_evaluation
                WHEN 3 THEN 3 WHEN 2 THEN 2 WHEN 1 THEN 1
                ELSE COALESCE(priority_list_projection.band_rank, 0)
              END DESC,
              CASE WHEN resource_rows.user_evaluation IS NULL THEN 0 ELSE 1 END DESC,
              COALESCE(priority_list_projection.agent_score, -1) DESC,`
            : "";
      const rows = connection.prepare(`SELECT resource_rows.* ${resultSource}
        ORDER BY ${priorityOrder} ${sortColumn.replaceAll("resources.", "resource_rows.")}
          ${direction}, tabhub_sort_key(resource_rows.resource_key),
          resource_rows.resource_key, resource_rows.id LIMIT ? OFFSET ?
      `).all(...resultParameters, query.pageSize,
        (query.page - 1) * query.pageSize) as ResourceReadRow[];
      return resourceListResponseSchema.parse({
        items: rows.map((row) => mapSummary(row, pathsFor(row.id))),
        total, page: query.page, pageSize: query.pageSize,
      });
    },

    get(resourceId) {
      const row = selectDetail.get(resourceId) as ResourceReadRow | undefined;
      if (row === undefined) return undefined;
      const rulesetVersion = Number(selectRulesetVersion.pluck().get());
      const aliases = (selectAliases.all(resourceId) as Array<{
        rule_key: string; version: number; host_pattern: string;
        match_kind: "exact_host" | "suffix_host"; path_prefix: string;
        priority: number; enabled: 0 | 1;
        provenance_class: "user_alias" | "agent_alias" | "system_seed";
      }>).map((alias) => ({
        ruleKey: alias.rule_key, version: alias.version,
        hostPattern: alias.host_pattern, matchKind: alias.match_kind,
        pathPrefix: alias.path_prefix, priority: alias.priority,
        enabled: alias.enabled === 1, provenance: alias.provenance_class,
      }));
      return resourceDetailSchema.parse({
        ...mapSummary(row, pathsFor(row.id)), rulesetVersion, aliases,
      });
    },

    pages(resourceId, query) {
      if (selectDetail.get(resourceId) === undefined) return undefined;
      const predicates = ["membership.resource_id = ?"];
      const parameters: Array<string | number> = [resourceId];
      const pageFilters: string[] = [];
      if (query.browser !== undefined) { pageFilters.push("eligible_tabs.browser = ?"); parameters.push(query.browser); }
      if (query.status !== undefined) { pageFilters.push("eligible_tabs.status = ?"); parameters.push(query.status); }
      if (query.importance !== undefined) { pageFilters.push("eligible_tabs.importance = ?"); parameters.push(query.importance); }
      if (query.tag !== undefined) {
        pageFilters.push(`eligible_tabs.id IN (${descendantTopicTabIdsSql})`);
        parameters.push(query.tag);
      }
      if (pageFilters.length > 0) {
        predicates.push(`EXISTS (
          SELECT 1 FROM tabs AS eligible_tabs
          WHERE eligible_tabs.logical_page_id = logical_pages.id
            AND ${pageFilters.join(" AND ")}
        )`);
      }
      const where = `WHERE ${predicates.join(" AND ")}`;
      const grouped = `FROM (${currentMembershipSql}) AS membership
        JOIN logical_pages ON logical_pages.id = membership.logical_page_id
        ${where}
        GROUP BY logical_pages.id, membership.assignment_id, membership.provenance_class`;
      const total = Number(connection.prepare(`SELECT COUNT(*) FROM (SELECT logical_pages.id ${grouped})`).pluck().get(...parameters));
      const rows = connection.prepare(`SELECT logical_pages.id,
          logical_pages.url_normalized, logical_pages.representative_url,
          membership.assignment_id, membership.provenance_class,
          (SELECT COUNT(*) FROM tabs AS all_tabs
           WHERE all_tabs.logical_page_id = logical_pages.id) AS browser_page_count,
          (SELECT COUNT(*) FROM tab_instances JOIN tabs AS instance_tabs
           ON instance_tabs.id = tab_instances.tab_id
           WHERE instance_tabs.logical_page_id = logical_pages.id) AS physical_tab_count,
          (SELECT GROUP_CONCAT(DISTINCT all_tabs.browser) FROM tabs AS all_tabs
           WHERE all_tabs.logical_page_id = logical_pages.id) AS browsers,
          COALESCE((SELECT SUM(foreground_ms) FROM tab_page_activity_totals
            WHERE url_normalized = logical_pages.url_normalized), 0) AS on_screen_ms,
          COALESCE((SELECT SUM(engaged_ms) FROM tab_page_activity_totals
            WHERE url_normalized = logical_pages.url_normalized), 0) AS active_use_ms,
          NULL AS coverage_start
        ${grouped} ORDER BY logical_pages.id ASC LIMIT ? OFFSET ?
      `).all(...parameters, query.pageSize, (query.page - 1) * query.pageSize) as Array<Record<string, unknown>>;
      const reason = (value: string): string => value === "user_manual" || value === "agent_on_behalf" ? value : value === "explicit_alias" || value === "system_seed" ? value : "registrable_domain";
      return resourcePagesResponseSchema.parse({
        items: rows.map((row) => ({
          logicalPageId: row.id, urlNormalized: row.url_normalized,
          representativeUrl: row.representative_url,
          browserPageCount: row.browser_page_count,
          physicalOpenCopyCount: row.physical_tab_count,
          browsers: row.browsers === null ? [] : String(row.browsers).split(",").sort(),
          topicPaths: connection.prepare(`${tagPathsSql}
            SELECT DISTINCT tag_paths.path FROM tag_paths
            JOIN tab_tags ON tab_tags.tag_id = tag_paths.id
            JOIN tabs ON tabs.id = tab_tags.tab_id
            WHERE tabs.logical_page_id = ? ORDER BY tag_paths.path`).pluck().all(row.id),
          allTimeActivity: { window: "all", onScreenMs: row.on_screen_ms,
            activeUseMs: row.active_use_ms, coverageStart: row.coverage_start },
          currentAssignmentId: row.assignment_id,
          assignmentReason: reason(String(row.provenance_class)),
        })),
        total, page: query.page, pageSize: query.pageSize,
      });
    },
  };
}
