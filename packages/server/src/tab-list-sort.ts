import type { SortDirection, TabSortField } from "@tabhub/shared";

import { stableBrowserOrderSql } from "./stable-tab-order.js";

export interface TabListSortSql {
  joinClause: string;
  orderClause: string;
  withClause: string;
}

const defaultOrderClause = `${stableBrowserOrderSql}, tabs.id`;

export function tabListSortSql(
  sortBy: TabSortField | undefined,
  sortDirection: SortDirection,
): TabListSortSql {
  const direction = sortDirection === "desc" ? "DESC" : "ASC";
  // Age grows as first_seen_at gets older, so its timestamp direction is inverse.
  const ageTimestampDirection = direction === "ASC" ? "DESC" : "ASC";
  const defaultResult: TabListSortSql = {
    joinClause: "",
    orderClause: defaultOrderClause,
    withClause: "",
  };

  switch (sortBy) {
    case undefined:
      return defaultResult;
    case "title":
      return {
        ...defaultResult,
        orderClause: `
          tabhub_sort_key(tabhub_display_title(tabs.title, tabs.url)) ${direction},
          tabhub_display_title(tabs.title, tabs.url) ${direction},
          ${defaultOrderClause}
        `,
      };
    case "topics":
      return {
        withClause: `
          WITH RECURSIVE sort_tag_paths(id, path) AS (
            SELECT id, name
            FROM tags
            WHERE parent_id IS NULL
            UNION ALL
            SELECT child.id, sort_tag_paths.path || '/' || child.name
            FROM tags AS child
            JOIN sort_tag_paths ON child.parent_id = sort_tag_paths.id
          )
        `,
        joinClause: `
          LEFT JOIN (
            SELECT
              tab_tags.tab_id,
              MIN(tabhub_sort_key(sort_tag_paths.path)) AS first_path_key
            FROM tab_tags
            JOIN sort_tag_paths ON sort_tag_paths.id = tab_tags.tag_id
            GROUP BY tab_tags.tab_id
          ) AS tab_sort_topics ON tab_sort_topics.tab_id = tabs.id
        `,
        orderClause: `
          CASE WHEN tab_sort_topics.first_path_key IS NULL THEN 1 ELSE 0 END,
          tab_sort_topics.first_path_key ${direction},
          ${defaultOrderClause}
        `,
      };
    case "browser":
      return {
        ...defaultResult,
        orderClause: `
          CASE WHEN tabs.browser = 'other' THEN 1 ELSE 0 END,
          tabhub_sort_key(tabs.browser) ${direction},
          tabs.browser ${direction},
          tabs.id
        `,
      };
    case "activity":
      return {
        withClause: "",
        joinClause: `
          LEFT JOIN (
            SELECT
              tab_instances.tab_id,
              COUNT(*) AS open_instance_count,
              COALESCE(SUM(tab_activity_totals.foreground_ms), 0)
                AS open_foreground_time_ms,
              COALESCE(SUM(tab_activity_totals.engaged_ms), 0)
                AS open_engaged_time_ms
            FROM tab_instances
            LEFT JOIN tab_activity_totals
              ON tab_activity_totals.installation_id = tab_instances.installation_id
             AND tab_activity_totals.browser_session_id IS tab_instances.browser_session_id
             AND tab_activity_totals.browser_tab_id IS tab_instances.browser_tab_id
            GROUP BY tab_instances.tab_id
          ) AS tab_sort_activity ON tab_sort_activity.tab_id = tabs.id
        `,
        orderClause: `
          COALESCE(tab_sort_activity.open_foreground_time_ms, 0) ${direction},
          COALESCE(tab_sort_activity.open_engaged_time_ms, 0) ${direction},
          COALESCE(tab_sort_activity.open_instance_count, 0) ${direction},
          ${defaultOrderClause}
        `,
      };
    case "status":
      return {
        ...defaultResult,
        orderClause: `
          CASE tabs.status
            WHEN 'inbox' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'done' THEN 2
            WHEN 'archived' THEN 3
            ELSE 4
          END ${direction},
          ${defaultOrderClause}
        `,
      };
    case "importance":
      return {
        ...defaultResult,
        orderClause: `tabs.importance ${direction}, ${defaultOrderClause}`,
      };
    case "state":
      return {
        ...defaultResult,
        orderClause: `tabs.is_open ${direction}, ${defaultOrderClause}`,
      };
    case "age":
      return {
        ...defaultResult,
        orderClause: `tabs.first_seen_at ${ageTimestampDirection}, ${defaultOrderClause}`,
      };
  }
}
