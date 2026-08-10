import type Database from "better-sqlite3";

import type {
  GraphV2Edge,
  GraphV2Response,
  GraphV2TabNode,
  KnowledgeNodeRef,
} from "@tabhub/shared";

export interface GraphV2Catalog {
  getGraph(rootTopicId?: number, focus?: GraphV2Focus): GraphV2Response;
}

export interface GraphV2Focus {
  node: KnowledgeNodeRef;
  depth: number;
}

interface TopicRow {
  id: number;
  name: string;
  path: string;
  parent_id: number | null;
  color: string | null;
  direct_tab_count: number;
  tab_count: number;
}

interface TabRow {
  id: number;
  title: string | null;
  url: string;
  browser: string;
  status: GraphV2TabNode["status"];
  importance: GraphV2TabNode["importance"];
  is_open: 0 | 1;
}

interface TabTagRow {
  tab_id: number;
  path: string;
  root_name: string;
}

interface ContainmentRow {
  parent_id: number;
  child_id: number;
}

interface MembershipRow {
  topic_id: number;
  tab_id: number;
  assigned_by: "user" | "agent";
}

interface RelationRow {
  id: number;
  from_type: KnowledgeNodeRef["type"];
  from_source_id: number;
  to_type: KnowledgeNodeRef["type"];
  to_source_id: number;
  kind: string;
  note: string | null;
  created_by: "user" | "agent";
}

const selectedGraphCte = `
  WITH RECURSIVE
    tag_paths(id, parent_id, name, color, path, root_name) AS (
      SELECT id, parent_id, name, color, name, name
      FROM tags
      WHERE parent_id IS NULL
      UNION ALL
      SELECT
        child.id,
        child.parent_id,
        child.name,
        child.color,
        tag_paths.path || '/' || child.name,
        tag_paths.root_name
      FROM tags AS child
      JOIN tag_paths ON child.parent_id = tag_paths.id
    ),
    selected_topic_ids(id) AS (
      SELECT id
      FROM tags
      WHERE @rootTopicId IS NULL OR id = @rootTopicId
      UNION ALL
      SELECT child.id
      FROM tags AS child
      JOIN selected_topic_ids ON child.parent_id = selected_topic_ids.id
      WHERE @rootTopicId IS NOT NULL
    ),
    selected_tabs(id) AS (
      SELECT id
      FROM tabs
      WHERE @rootTopicId IS NULL
      UNION
      SELECT tab_tags.tab_id
      FROM tab_tags
      JOIN selected_topic_ids ON selected_topic_ids.id = tab_tags.tag_id
      WHERE @rootTopicId IS NOT NULL
    ),
    core_entities(id) AS (
      SELECT knowledge_entities.id
      FROM knowledge_entities
      JOIN selected_tabs ON selected_tabs.id = knowledge_entities.tab_id
      WHERE knowledge_entities.kind = 'tab'
      UNION ALL
      SELECT knowledge_entities.id
      FROM knowledge_entities
      JOIN selected_topic_ids
        ON selected_topic_ids.id = knowledge_entities.topic_id
      WHERE knowledge_entities.kind = 'topic'
    ),
    graph_connections(from_entity_id, to_entity_id) AS (
      SELECT from_entity_id, to_entity_id
      FROM relations
      UNION
      SELECT to_entity_id, from_entity_id
      FROM relations
      UNION
      SELECT parent_entity.id, child_entity.id
      FROM tags AS child
      JOIN knowledge_entities AS child_entity
        ON child_entity.kind = 'topic'
       AND child_entity.topic_id = child.id
      JOIN knowledge_entities AS parent_entity
        ON parent_entity.kind = 'topic'
       AND parent_entity.topic_id = child.parent_id
      WHERE child.parent_id IS NOT NULL
      UNION
      SELECT child_entity.id, parent_entity.id
      FROM tags AS child
      JOIN knowledge_entities AS child_entity
        ON child_entity.kind = 'topic'
       AND child_entity.topic_id = child.id
      JOIN knowledge_entities AS parent_entity
        ON parent_entity.kind = 'topic'
       AND parent_entity.topic_id = child.parent_id
      WHERE child.parent_id IS NOT NULL
      UNION
      SELECT topic_entity.id, tab_entity.id
      FROM tab_tags
      JOIN knowledge_entities AS topic_entity
        ON topic_entity.kind = 'topic'
       AND topic_entity.topic_id = tab_tags.tag_id
      JOIN knowledge_entities AS tab_entity
        ON tab_entity.kind = 'tab'
       AND tab_entity.tab_id = tab_tags.tab_id
      UNION
      SELECT tab_entity.id, topic_entity.id
      FROM tab_tags
      JOIN knowledge_entities AS topic_entity
        ON topic_entity.kind = 'topic'
       AND topic_entity.topic_id = tab_tags.tag_id
      JOIN knowledge_entities AS tab_entity
        ON tab_entity.kind = 'tab'
       AND tab_entity.tab_id = tab_tags.tab_id
    ),
    focus_walk(entity_id, depth) AS (
      SELECT knowledge_entities.id, 0
      FROM knowledge_entities
      WHERE @focusNodeType IS NOT NULL
        AND knowledge_entities.kind = @focusNodeType
        AND (
          (knowledge_entities.kind = 'tab'
            AND knowledge_entities.tab_id = @focusNodeId)
          OR
          (knowledge_entities.kind = 'topic'
            AND knowledge_entities.topic_id = @focusNodeId)
        )
      UNION
      SELECT graph_connections.to_entity_id, focus_walk.depth + 1
      FROM focus_walk
      JOIN graph_connections
        ON graph_connections.from_entity_id = focus_walk.entity_id
      WHERE focus_walk.depth < @focusDepth
    ),
    focus_entities(id) AS (
      SELECT DISTINCT entity_id
      FROM focus_walk
    ),
    selected_entities(id) AS (
      SELECT id
      FROM core_entities
      UNION
      SELECT relations.to_entity_id
      FROM relations
      JOIN core_entities ON core_entities.id = relations.from_entity_id
      UNION
      SELECT relations.from_entity_id
      FROM relations
      JOIN core_entities ON core_entities.id = relations.to_entity_id
      UNION
      SELECT id
      FROM focus_entities
    ),
    graph_tab_ids(id) AS (
      SELECT knowledge_entities.tab_id
      FROM knowledge_entities
      JOIN selected_entities ON selected_entities.id = knowledge_entities.id
      WHERE knowledge_entities.kind = 'tab'
    ),
    graph_topic_ids(id) AS (
      SELECT knowledge_entities.topic_id
      FROM knowledge_entities
      JOIN selected_entities ON selected_entities.id = knowledge_entities.id
      WHERE knowledge_entities.kind = 'topic'
    )
`;

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createGraphV2Catalog(
  connection: Database.Database,
): GraphV2Catalog {
  const selectTopics = connection.prepare(`${selectedGraphCte},
    topic_tab_memberships(topic_id, tab_id) AS (
      SELECT tab_tags.tag_id, tab_tags.tab_id
      FROM tab_tags
      UNION
      SELECT tags.parent_id, topic_tab_memberships.tab_id
      FROM topic_tab_memberships
      JOIN tags ON tags.id = topic_tab_memberships.topic_id
      WHERE tags.parent_id IS NOT NULL
    )
    SELECT
      tag_paths.id,
      tag_paths.name,
      tag_paths.path,
      tag_paths.parent_id,
      tag_paths.color,
      (
        SELECT COUNT(DISTINCT direct_tags.tab_id)
        FROM tab_tags AS direct_tags
        WHERE direct_tags.tag_id = tag_paths.id
      ) AS direct_tab_count,
      (
        SELECT COUNT(*)
        FROM topic_tab_memberships
        WHERE topic_tab_memberships.topic_id = tag_paths.id
      ) AS tab_count
    FROM tag_paths
    JOIN graph_topic_ids ON graph_topic_ids.id = tag_paths.id
    ORDER BY tag_paths.path COLLATE NOCASE, tag_paths.path, tag_paths.id
  `);
  const selectTabs = connection.prepare(`${selectedGraphCte}
    SELECT
      tabs.id,
      tabs.title,
      tabs.url,
      tabs.browser,
      tabs.status,
      tabs.importance,
      tabs.is_open
    FROM tabs
    JOIN graph_tab_ids ON graph_tab_ids.id = tabs.id
    ORDER BY tabs.id
  `);
  const selectTabTags = connection.prepare(`${selectedGraphCte}
    SELECT tab_tags.tab_id, tag_paths.path, tag_paths.root_name
    FROM tab_tags
    JOIN graph_tab_ids ON graph_tab_ids.id = tab_tags.tab_id
    JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
    ORDER BY
      tab_tags.tab_id,
      tag_paths.path COLLATE NOCASE,
      tag_paths.path,
      tag_paths.id
  `);
  const selectContainment = connection.prepare(`${selectedGraphCte}
    SELECT child.parent_id, child.id AS child_id
    FROM tags AS child
    JOIN graph_topic_ids AS selected_child ON selected_child.id = child.id
    JOIN graph_topic_ids AS selected_parent ON selected_parent.id = child.parent_id
    ORDER BY child.parent_id, child.id
  `);
  const selectMemberships = connection.prepare(`${selectedGraphCte}
    SELECT
      tab_tags.tag_id AS topic_id,
      tab_tags.tab_id,
      tab_tags.assigned_by
    FROM tab_tags
    JOIN graph_topic_ids ON graph_topic_ids.id = tab_tags.tag_id
    JOIN graph_tab_ids ON graph_tab_ids.id = tab_tags.tab_id
    ORDER BY tab_tags.tag_id, tab_tags.tab_id
  `);
  const selectRelations = connection.prepare(`${selectedGraphCte}
    SELECT
      relations.id,
      from_entity.kind AS from_type,
      COALESCE(from_entity.tab_id, from_entity.topic_id) AS from_source_id,
      to_entity.kind AS to_type,
      COALESCE(to_entity.tab_id, to_entity.topic_id) AS to_source_id,
      relations.kind,
      relations.note,
      relations.created_by
    FROM relations
    JOIN selected_entities AS selected_from
      ON selected_from.id = relations.from_entity_id
    JOIN selected_entities AS selected_to
      ON selected_to.id = relations.to_entity_id
    JOIN knowledge_entities AS from_entity
      ON from_entity.id = relations.from_entity_id
    JOIN knowledge_entities AS to_entity
      ON to_entity.id = relations.to_entity_id
    WHERE
      EXISTS (
        SELECT 1
        FROM core_entities
        WHERE core_entities.id = relations.from_entity_id
           OR core_entities.id = relations.to_entity_id
      )
      OR (
        EXISTS (
          SELECT 1
          FROM focus_entities
          WHERE focus_entities.id = relations.from_entity_id
        )
        AND EXISTS (
          SELECT 1
          FROM focus_entities
          WHERE focus_entities.id = relations.to_entity_id
        )
      )
    ORDER BY relations.id
  `);

  const readGraph = connection.transaction(
    (rootTopicId?: number, focus?: GraphV2Focus): GraphV2Response => {
      const parameters = {
        rootTopicId: rootTopicId ?? null,
        focusNodeType: focus?.node.type ?? null,
        focusNodeId: focus?.node.id ?? null,
        focusDepth: focus?.depth ?? null,
      };
      const tabNodes = new Map<number, GraphV2TabNode>();
      const tabRootTags = new Map<number, Set<string>>();

      for (const row of selectTabs.all(parameters) as TabRow[]) {
        tabNodes.set(row.id, {
          type: "tab",
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
        tabRootTags.set(row.id, new Set());
      }

      for (const tag of selectTabTags.all(parameters) as TabTagRow[]) {
        tabNodes.get(tag.tab_id)?.tagPaths.push(tag.path);
        tabRootTags.get(tag.tab_id)?.add(tag.root_name);
      }
      for (const node of tabNodes.values()) {
        node.tagPaths.sort(compareText);
        node.rootTags = [...(tabRootTags.get(node.id) ?? [])].sort(compareText);
      }

      const topicNodes = (selectTopics.all(parameters) as TopicRow[]).map(
        (topic) => ({
          type: "topic" as const,
          id: topic.id,
          name: topic.name,
          path: topic.path,
          parentId: topic.parent_id,
          color: topic.color,
          directTabCount: topic.direct_tab_count,
          tabCount: topic.tab_count,
        }),
      );
      const edges: GraphV2Edge[] = [];

      for (const row of selectContainment.all(parameters) as ContainmentRow[]) {
        edges.push({
          id: `containment:${row.parent_id}:${row.child_id}`,
          edgeType: "containment",
          source: { type: "topic", id: row.parent_id },
          target: { type: "topic", id: row.child_id },
          relationId: null,
          relationKind: null,
          note: null,
          createdBy: null,
        });
      }
      for (const row of selectMemberships.all(parameters) as MembershipRow[]) {
        edges.push({
          id: `membership:${row.topic_id}:${row.tab_id}`,
          edgeType: "membership",
          source: { type: "topic", id: row.topic_id },
          target: { type: "tab", id: row.tab_id },
          relationId: null,
          relationKind: null,
          note: null,
          createdBy: row.assigned_by,
        });
      }
      for (const row of selectRelations.all(parameters) as RelationRow[]) {
        edges.push({
          id: `relation:${row.id}`,
          edgeType: "relation",
          source: { type: row.from_type, id: row.from_source_id },
          target: { type: row.to_type, id: row.to_source_id },
          relationId: row.id,
          relationKind: row.kind,
          note: row.note,
          createdBy: row.created_by,
        });
      }

      return {
        nodes: [...topicNodes, ...tabNodes.values()],
        edges,
      };
    },
  );

  return {
    getGraph(rootTopicId, focus) {
      return readGraph(rootTopicId, focus);
    },
  };
}
