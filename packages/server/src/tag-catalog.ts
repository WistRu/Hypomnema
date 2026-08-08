import type Database from "better-sqlite3";

import type {
  AssignTags,
  AssignTagsResponse,
  TagTreeNode,
  TagTreeResponse,
} from "@tabhub/shared";

export interface TagCatalog {
  assignTags(input: AssignTags): AssignTagsResponse;
  listTags(): TagTreeResponse;
}

export class TabsNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly missingIds: number[]) {
    super(`No tabs exist with ids: ${missingIds.join(", ")}`);
    this.name = "TabsNotFoundError";
  }
}

interface IdRow {
  id: number;
}

interface TagTreeRow {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
  tab_count: number;
}

export function createTagCatalog(connection: Database.Database): TagCatalog {
  const selectTab = connection.prepare("SELECT id FROM tabs WHERE id = ?");
  const insertTag = connection.prepare(`
    INSERT OR IGNORE INTO tags (name, parent_id)
    VALUES (?, ?)
  `);
  const selectTag = connection.prepare(`
    SELECT id
    FROM tags
    WHERE name = ? AND parent_id IS ?
    ORDER BY id
    LIMIT 1
  `);
  const assignTag = connection.prepare(`
    INSERT OR IGNORE INTO tab_tags (tab_id, tag_id, assigned_by)
    VALUES (?, ?, ?)
  `);
  const selectTagTree = connection.prepare(`
    WITH RECURSIVE descendants(ancestor_id, descendant_id) AS (
      SELECT id, id
      FROM tags
      UNION ALL
      SELECT descendants.ancestor_id, child.id
      FROM descendants
      JOIN tags AS child ON child.parent_id = descendants.descendant_id
    )
    SELECT
      tags.id,
      tags.name,
      tags.parent_id,
      tags.color,
      COUNT(DISTINCT tab_tags.tab_id) AS tab_count
    FROM tags
    LEFT JOIN descendants ON descendants.ancestor_id = tags.id
    LEFT JOIN tab_tags ON tab_tags.tag_id = descendants.descendant_id
    GROUP BY tags.id
    ORDER BY tags.name COLLATE NOCASE, tags.id
  `);

  const assignTransaction = connection.transaction(
    (input: AssignTags): AssignTagsResponse => {
      const missingIds = input.ids.filter(
        (id) => selectTab.get(id) === undefined,
      );

      if (missingIds.length > 0) {
        throw new TabsNotFoundError(missingIds);
      }

      let parentId: number | null = null;

      for (const name of input.tagPath.split("/")) {
        let tag = selectTag.get(name, parentId) as IdRow | undefined;

        if (tag === undefined) {
          insertTag.run(name, parentId);
          tag = selectTag.get(name, parentId) as IdRow | undefined;
        }

        if (tag === undefined) {
          throw new Error(`Failed to resolve tag path ${input.tagPath}`);
        }

        parentId = tag.id;
      }

      if (parentId === null) {
        throw new Error("A validated tag path must contain at least one segment");
      }

      let assigned = 0;
      for (const id of input.ids) {
        assigned += assignTag.run(id, parentId, input.assignedBy).changes;
      }

      return { tagId: parentId, assigned };
    },
  );

  return {
    assignTags(input) {
      return assignTransaction(input);
    },

    listTags() {
      const rows = selectTagTree.all() as TagTreeRow[];
      const nodes = new Map<number, TagTreeNode>();
      const roots: TagTreeNode[] = [];

      for (const row of rows) {
        nodes.set(row.id, {
          id: row.id,
          name: row.name,
          path: row.name,
          color: row.color,
          tabCount: row.tab_count,
          children: [],
        });
      }

      for (const row of rows) {
        const node = nodes.get(row.id);
        if (node === undefined) {
          continue;
        }

        if (row.parent_id === null) {
          roots.push(node);
          continue;
        }

        const parent = nodes.get(row.parent_id);
        if (parent === undefined) {
          continue;
        }

        parent.children.push(node);
      }

      const setPaths = (node: TagTreeNode, parentPath?: string): void => {
        node.path = parentPath === undefined ? node.name : `${parentPath}/${node.name}`;
        for (const child of node.children) {
          setPaths(child, node.path);
        }
      };

      for (const root of roots) {
        setPaths(root);
      }

      return { items: roots };
    },
  };
}
