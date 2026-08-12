import type Database from "better-sqlite3";

import type {
  AssignTags,
  AssignTagsResponse,
  CreateTag,
  PatchTag,
  TagRecord,
  TagTreeNode,
  TagTreeResponse,
} from "@tabhub/shared";

export interface TagCatalog {
  assignTags(input: AssignTags): AssignTagsResponse;
  createTag(input: CreateTag): TagRecord;
  deleteTag(id: number): void;
  listTags(): TagTreeResponse;
  unassignTag(tabId: number, tagId: number): void;
  updateTag(id: number, input: PatchTag): TagRecord;
}

export class TabsNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly missingIds: number[]) {
    super(`No tabs exist with ids: ${missingIds.join(", ")}`);
    this.name = "TabsNotFoundError";
  }
}

export class TagNotFoundError extends Error {
  readonly code = "TAG_NOT_FOUND";

  constructor(readonly tagId: number) {
    super(`No tag exists with id ${tagId}`);
    this.name = "TagNotFoundError";
  }
}

export class TagConflictError extends Error {
  readonly code = "TAG_CONFLICT";

  constructor(name: string, parentId: number | null) {
    super(
      `A tag named ${name} already exists ${parentId === null ? "at the root" : `under parent ${parentId}`}`,
    );
    this.name = "TagConflictError";
  }
}

export class TagHierarchyConflictError extends Error {
  readonly code = "TAG_HIERARCHY_CONFLICT";

  constructor(tagId: number, parentId: number) {
    super(`Tag ${tagId} cannot be moved under itself or descendant ${parentId}`);
    this.name = "TagHierarchyConflictError";
  }
}

export class TagHasChildrenError extends Error {
  readonly code = "TAG_HAS_CHILDREN";

  constructor(readonly tagId: number) {
    super(`Tag ${tagId} cannot be deleted while it has children`);
    this.name = "TagHasChildrenError";
  }
}

export class TagAssignmentNotFoundError extends Error {
  readonly code = "TAG_ASSIGNMENT_NOT_FOUND";

  constructor(tabId: number, tagId: number) {
    super(`Tab ${tabId} is not assigned tag ${tagId}`);
    this.name = "TagAssignmentNotFoundError";
  }
}

export class SystemTagMutationError extends Error {
  readonly code = "SYSTEM_TAG_IMMUTABLE";

  constructor(readonly tagId: number) {
    super(`System tag ${tagId} cannot be changed manually`);
    this.name = "SystemTagMutationError";
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

interface TagRecordRow {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
}

function mapTagRecord(row: TagRecordRow): TagRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    color: row.color,
  };
}

export function createTagCatalog(connection: Database.Database): TagCatalog {
  const selectTab = connection.prepare("SELECT id FROM tabs WHERE id = ?");
  const selectTagById = connection.prepare(`
    SELECT id, name, parent_id, color
    FROM tags
    WHERE id = ?
  `);
  const selectSystemTagById = connection.prepare(`
    SELECT id
    FROM tags
    WHERE id = ? AND system_kind IS NOT NULL
  `);
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
  const insertTagRecord = connection.prepare(`
    INSERT OR IGNORE INTO tags (name, parent_id, color)
    VALUES (?, ?, ?)
  `);
  const selectSiblingTag = connection.prepare(`
    SELECT id
    FROM tags
    WHERE name = ? AND parent_id IS ? AND id != ?
    LIMIT 1
  `);
  const selectDescendant = connection.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id
      FROM tags
      WHERE parent_id = ?
      UNION ALL
      SELECT child.id
      FROM tags AS child
      JOIN descendants ON child.parent_id = descendants.id
    )
    SELECT id
    FROM descendants
    WHERE id = ?
    LIMIT 1
  `);
  const selectChild = connection.prepare(`
    SELECT id
    FROM tags
    WHERE parent_id = ?
    LIMIT 1
  `);
  const updateTagRecord = connection.prepare(`
    UPDATE tags
    SET name = ?, parent_id = ?, color = ?
    WHERE id = ?
  `);
  const deleteTagRecord = connection.prepare("DELETE FROM tags WHERE id = ?");
  const assignTag = connection.prepare(`
    INSERT OR IGNORE INTO tab_tags (tab_id, tag_id, assigned_by)
    VALUES (?, ?, ?)
  `);
  const deleteTagAssignment = connection.prepare(`
    DELETE FROM tab_tags
    WHERE tab_id = ? AND tag_id = ?
  `);
  const selectTagTree = connection.prepare(`
    WITH RECURSIVE
      descendants(ancestor_id, descendant_id) AS (
        SELECT id, id
        FROM tags
        UNION ALL
        SELECT descendants.ancestor_id, child.id
        FROM descendants
        JOIN tags AS child ON child.parent_id = descendants.descendant_id
      ),
      active_tab_tags(tab_id, tag_id) AS (
        SELECT tab_tags.tab_id, tab_tags.tag_id
        FROM tab_tags
        JOIN tabs ON tabs.id = tab_tags.tab_id
        LEFT JOIN page_retention ON page_retention.tab_id = tabs.id
        WHERE page_retention.state IS NULL OR page_retention.state != 'trashed'
      )
    SELECT
      tags.id,
      tags.name,
      tags.parent_id,
      tags.color,
      COUNT(DISTINCT active_tab_tags.tab_id) AS tab_count
    FROM tags
    LEFT JOIN descendants ON descendants.ancestor_id = tags.id
    LEFT JOIN active_tab_tags ON active_tab_tags.tag_id = descendants.descendant_id
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
        if (selectSystemTagById.get(parentId) !== undefined) {
          throw new SystemTagMutationError(parentId);
        }
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
  const createTransaction = connection.transaction(
    (input: CreateTag): TagRecord => {
      const parentId = input.parentId ?? null;
      if (
        input.parentId !== undefined &&
        selectTagById.get(input.parentId) === undefined
      ) {
        throw new TagNotFoundError(input.parentId);
      }
      if (
        input.parentId !== undefined &&
        selectSystemTagById.get(input.parentId) !== undefined
      ) {
        throw new SystemTagMutationError(input.parentId);
      }

      const inserted = insertTagRecord.run(
        input.name,
        parentId,
        input.color ?? null,
      );
      if (inserted.changes === 0) {
        throw new TagConflictError(input.name, parentId);
      }

      const row = selectTagById.get(
        Number(inserted.lastInsertRowid),
      ) as TagRecordRow;
      return mapTagRecord(row);
    },
  );
  const updateTransaction = connection.transaction(
    (id: number, input: PatchTag): TagRecord => {
      const current = selectTagById.get(id) as TagRecordRow | undefined;
      if (current === undefined) {
        throw new TagNotFoundError(id);
      }
      if (selectSystemTagById.get(id) !== undefined) {
        throw new SystemTagMutationError(id);
      }

      const name = input.name ?? current.name;
      const parentId =
        input.parentId === undefined ? current.parent_id : input.parentId;
      const color = input.color === undefined ? current.color : input.color;

      if (parentId !== null) {
        if (selectTagById.get(parentId) === undefined) {
          throw new TagNotFoundError(parentId);
        }
        if (selectSystemTagById.get(parentId) !== undefined) {
          throw new SystemTagMutationError(parentId);
        }
        if (
          parentId === id ||
          selectDescendant.get(id, parentId) !== undefined
        ) {
          throw new TagHierarchyConflictError(id, parentId);
        }
      }

      if (selectSiblingTag.get(name, parentId, id) !== undefined) {
        throw new TagConflictError(name, parentId);
      }

      updateTagRecord.run(name, parentId, color, id);
      return mapTagRecord(selectTagById.get(id) as TagRecordRow);
    },
  );
  const deleteTransaction = connection.transaction((id: number): void => {
    if (selectTagById.get(id) === undefined) {
      throw new TagNotFoundError(id);
    }
    if (selectSystemTagById.get(id) !== undefined) {
      throw new SystemTagMutationError(id);
    }
    if (selectChild.get(id) !== undefined) {
      throw new TagHasChildrenError(id);
    }

    deleteTagRecord.run(id);
  });
  const unassignTransaction = connection.transaction(
    (tabId: number, tagId: number): void => {
      if (selectTab.get(tabId) === undefined) {
        throw new TabsNotFoundError([tabId]);
      }
      if (selectTagById.get(tagId) === undefined) {
        throw new TagNotFoundError(tagId);
      }
      if (selectSystemTagById.get(tagId) !== undefined) {
        throw new SystemTagMutationError(tagId);
      }
      if (deleteTagAssignment.run(tabId, tagId).changes === 0) {
        throw new TagAssignmentNotFoundError(tabId, tagId);
      }
    },
  );

  return {
    assignTags(input) {
      return assignTransaction(input);
    },

    createTag(input) {
      return createTransaction(input);
    },

    deleteTag(id) {
      deleteTransaction(id);
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

    unassignTag(tabId, tagId) {
      unassignTransaction(tabId, tagId);
    },

    updateTag(id, input) {
      return updateTransaction(id, input);
    },
  };
}
