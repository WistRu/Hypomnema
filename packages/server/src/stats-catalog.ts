import type Database from "better-sqlite3";

import type {
  StatsResponse,
  StatusCount,
  TabStatus,
} from "@tabhub/shared";

const STATUSES = ["inbox", "in_progress", "done", "archived"] as const;

interface CountRow {
  total: number;
  open: number;
  inbox: number;
  in_progress: number;
  done: number;
  archived: number;
}

interface BrowserCountRow extends CountRow {
  browser: string;
}

interface TagCountRow extends Omit<CountRow, "open"> {
  tag_id: number;
  name: string;
  path: string;
}

function toStatusCounts(row: Record<TabStatus, number>): StatusCount[] {
  return STATUSES.map((status) => ({ status, count: row[status] }));
}

export interface StatsCatalog {
  getStats(): StatsResponse;
}

export function createStatsCatalog(
  connection: Database.Database,
): StatsCatalog {
  const selectOverall = connection.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN is_open = 1 THEN 1 END) AS open,
      COUNT(CASE WHEN status = 'inbox' THEN 1 END) AS inbox,
      COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done,
      COUNT(CASE WHEN status = 'archived' THEN 1 END) AS archived
    FROM tabs
  `);
  const selectBrowsers = connection.prepare(`
    SELECT
      browser,
      COUNT(*) AS total,
      COUNT(CASE WHEN is_open = 1 THEN 1 END) AS open,
      COUNT(CASE WHEN status = 'inbox' THEN 1 END) AS inbox,
      COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress,
      COUNT(CASE WHEN status = 'done' THEN 1 END) AS done,
      COUNT(CASE WHEN status = 'archived' THEN 1 END) AS archived
    FROM tabs
    GROUP BY browser
    ORDER BY browser COLLATE NOCASE
  `);
  const selectTags = connection.prepare(`
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
      descendants(ancestor_id, descendant_id) AS (
        SELECT id, id
        FROM tags
        UNION ALL
        SELECT descendants.ancestor_id, child.id
        FROM descendants
        JOIN tags AS child ON child.parent_id = descendants.descendant_id
      )
    SELECT
      tags.id AS tag_id,
      tags.name,
      tag_paths.path,
      COUNT(DISTINCT tabs.id) AS total,
      COUNT(DISTINCT CASE WHEN tabs.status = 'inbox' THEN tabs.id END) AS inbox,
      COUNT(DISTINCT CASE WHEN tabs.status = 'in_progress' THEN tabs.id END) AS in_progress,
      COUNT(DISTINCT CASE WHEN tabs.status = 'done' THEN tabs.id END) AS done,
      COUNT(DISTINCT CASE WHEN tabs.status = 'archived' THEN tabs.id END) AS archived
    FROM tags
    JOIN tag_paths ON tag_paths.id = tags.id
    LEFT JOIN descendants ON descendants.ancestor_id = tags.id
    LEFT JOIN tab_tags ON tab_tags.tag_id = descendants.descendant_id
    LEFT JOIN tabs ON tabs.id = tab_tags.tab_id
    GROUP BY tags.id, tag_paths.path
    ORDER BY tag_paths.path COLLATE NOCASE, tags.id
  `);

  return {
    getStats() {
      const overall = selectOverall.get() as CountRow;
      const browsers = selectBrowsers.all() as BrowserCountRow[];
      const tags = selectTags.all() as TagCountRow[];

      return {
        total: overall.total,
        open: overall.open,
        byStatus: toStatusCounts(overall),
        byBrowser: browsers.map((browser) => ({
          browser: browser.browser,
          total: browser.total,
          open: browser.open,
          byStatus: toStatusCounts(browser),
        })),
        byTag: tags.map((tag) => ({
          tagId: tag.tag_id,
          name: tag.name,
          path: tag.path,
          total: tag.total,
          byStatus: toStatusCounts(tag),
        })),
      };
    },
  };
}
