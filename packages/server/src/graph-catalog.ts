import type Database from "better-sqlite3";

import type { GraphNode, GraphResponse, TabLink } from "@tabhub/shared";

export interface GraphCatalog {
  getGraph(rootTag?: string): GraphResponse;
}

interface GraphNodeRow {
  id: number;
  title: string | null;
  url: string;
  browser: string;
  status: GraphNode["status"];
  importance: GraphNode["importance"];
  is_open: 0 | 1;
}

interface GraphTagRow {
  tab_id: number;
  tag_id: number;
  path: string;
  root_name: string;
}

interface GraphEdgeRow {
  id: number;
  from_tab: number;
  to_tab: number;
  kind: string;
  note: string | null;
  created_by: TabLink["createdBy"];
}

const selectedTabsCte = `
  WITH RECURSIVE
    tag_paths(id, path, root_name) AS (
      SELECT id, name, name
      FROM tags
      WHERE parent_id IS NULL
      UNION ALL
      SELECT
        child.id,
        tag_paths.path || '/' || child.name,
        tag_paths.root_name
      FROM tags AS child
      JOIN tag_paths ON child.parent_id = tag_paths.id
    ),
    selected_tag_ids(id) AS (
      SELECT id
      FROM tag_paths
      WHERE path = @rootTag
      UNION ALL
      SELECT child.id
      FROM tags AS child
      JOIN selected_tag_ids ON child.parent_id = selected_tag_ids.id
    ),
    selected_tabs(id) AS (
      SELECT id
      FROM tabs
      WHERE @rootTag IS NULL
      UNION
      SELECT tab_tags.tab_id
      FROM tab_tags
      JOIN selected_tag_ids ON selected_tag_ids.id = tab_tags.tag_id
      WHERE @rootTag IS NOT NULL
    )
`;

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createGraphCatalog(
  connection: Database.Database,
): GraphCatalog {
  const selectNodes = connection.prepare(`${selectedTabsCte}
    SELECT
      tabs.id,
      tabs.title,
      tabs.url,
      tabs.browser,
      tabs.status,
      tabs.importance,
      tabs.is_open
    FROM tabs
    JOIN selected_tabs ON selected_tabs.id = tabs.id
    ORDER BY tabs.id
  `);
  const selectTags = connection.prepare(`${selectedTabsCte}
    SELECT
      tab_tags.tab_id,
      tag_paths.id AS tag_id,
      tag_paths.path,
      tag_paths.root_name
    FROM tab_tags
    JOIN selected_tabs ON selected_tabs.id = tab_tags.tab_id
    JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
    ORDER BY tab_tags.tab_id, tag_paths.path COLLATE NOCASE, tag_paths.path,
      tag_paths.id
  `);
  const selectEdges = connection.prepare(`${selectedTabsCte}
    SELECT
      links.id,
      links.from_tab,
      links.to_tab,
      links.kind,
      links.note,
      links.created_by
    FROM links
    JOIN selected_tabs AS from_tabs ON from_tabs.id = links.from_tab
    JOIN selected_tabs AS to_tabs ON to_tabs.id = links.to_tab
    ORDER BY links.id
  `);

  return {
    getGraph(rootTag) {
      const parameters = { rootTag: rootTag ?? null };
      const rows = selectNodes.all(parameters) as GraphNodeRow[];
      const nodes = new Map<number, GraphNode>();
      const rootTags = new Map<number, Set<string>>();

      for (const row of rows) {
        nodes.set(row.id, {
          id: row.id,
          title: row.title,
          url: row.url,
          browser: row.browser,
          status: row.status,
          importance: row.importance,
          isOpen: row.is_open === 1,
          tagPaths: [],
          rootTags: [],
        });
        rootTags.set(row.id, new Set());
      }

      for (const tag of selectTags.all(parameters) as GraphTagRow[]) {
        nodes.get(tag.tab_id)?.tagPaths.push(tag.path);
        rootTags.get(tag.tab_id)?.add(tag.root_name);
      }

      for (const node of nodes.values()) {
        node.tagPaths.sort(compareText);
        node.rootTags = [...(rootTags.get(node.id) ?? [])].sort(compareText);
      }

      const edges = (selectEdges.all(parameters) as GraphEdgeRow[]).map(
        (edge): TabLink => ({
          id: edge.id,
          fromTab: edge.from_tab,
          toTab: edge.to_tab,
          kind: edge.kind,
          note: edge.note,
          createdBy: edge.created_by,
        }),
      );

      return { nodes: [...nodes.values()], edges };
    },
  };
}
