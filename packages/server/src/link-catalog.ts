import type Database from "better-sqlite3";

import type {
  CreateLink,
  LinkListResponse,
  PatchLink,
  TabLink,
} from "@tabhub/shared";

export interface LinkCatalog {
  listLinks(tabId?: number): LinkListResponse;
  createLink(input: CreateLink): TabLink;
  updateLink(id: number, input: PatchLink): TabLink | undefined;
  deleteLink(id: number): boolean;
}

export class LinkTabsNotFoundError extends Error {
  readonly code = "TAB_NOT_FOUND";

  constructor(readonly missingIds: number[]) {
    super(`No tabs exist with ids: ${missingIds.join(", ")}`);
    this.name = "LinkTabsNotFoundError";
  }
}

export class SelfLinkError extends Error {
  readonly code = "SELF_LINK_NOT_ALLOWED";

  constructor(readonly tabId: number) {
    super(`Tab ${tabId} cannot link to itself`);
    this.name = "SelfLinkError";
  }
}

interface LinkRow {
  id: number;
  from_tab: number;
  to_tab: number;
  kind: string;
  note: string | null;
  created_by: "user" | "agent";
}

interface TabIdRow {
  id: number;
}

function mapLink(row: LinkRow): TabLink {
  return {
    id: row.id,
    fromTab: row.from_tab,
    toTab: row.to_tab,
    kind: row.kind,
    note: row.note,
    createdBy: row.created_by,
  };
}

export function createLinkCatalog(
  connection: Database.Database,
): LinkCatalog {
  const selectAll = connection.prepare(`
    SELECT id, from_tab, to_tab, kind, note, created_by
      FROM links
     ORDER BY id ASC
  `);
  const selectForTab = connection.prepare(`
    SELECT id, from_tab, to_tab, kind, note, created_by
      FROM links
     WHERE from_tab = ? OR to_tab = ?
     ORDER BY id ASC
  `);
  const selectById = connection.prepare(`
    SELECT id, from_tab, to_tab, kind, note, created_by
      FROM links
     WHERE id = ?
  `);
  const selectEndpointTabs = connection.prepare(`
    SELECT id
      FROM tabs
     WHERE id = ? OR id = ?
     ORDER BY id ASC
  `);
  const insertLink = connection.prepare(`
    INSERT INTO links (from_tab, to_tab, kind, note, created_by)
    VALUES (@from, @to, @kind, @note, @createdBy)
  `);
  const updateLink = connection.prepare(`
    UPDATE links
       SET kind = CASE WHEN @hasKind = 1 THEN @kind ELSE kind END,
           note = CASE WHEN @hasNote = 1 THEN @note ELSE note END
     WHERE id = @id
  `);
  const deleteLink = connection.prepare("DELETE FROM links WHERE id = ?");

  const createTransaction = connection.transaction(
    (input: CreateLink): TabLink => {
      const endpointIds = (
        selectEndpointTabs.all(input.from, input.to) as TabIdRow[]
      ).map(({ id }) => id);
      const missingIds = [...new Set([input.from, input.to])]
        .filter((id) => !endpointIds.includes(id))
        .sort((left, right) => left - right);

      if (missingIds.length > 0) {
        throw new LinkTabsNotFoundError(missingIds);
      }

      const result = insertLink.run({
        from: input.from,
        to: input.to,
        kind: input.kind,
        note: input.note ?? null,
        createdBy: input.createdBy,
      });
      const row = selectById.get(Number(result.lastInsertRowid)) as
        | LinkRow
        | undefined;

      if (row === undefined) {
        throw new Error("Created link could not be read back");
      }

      return mapLink(row);
    },
  );

  const updateTransaction = connection.transaction(
    (id: number, input: PatchLink): TabLink | undefined => {
      const result = updateLink.run({
        id,
        hasKind: input.kind === undefined ? 0 : 1,
        kind: input.kind ?? null,
        hasNote: input.note === undefined ? 0 : 1,
        note: input.note ?? null,
      });

      if (result.changes === 0) {
        return undefined;
      }

      const row = selectById.get(id) as LinkRow | undefined;
      return row === undefined ? undefined : mapLink(row);
    },
  );

  return {
    listLinks(tabId) {
      const rows = (
        tabId === undefined
          ? selectAll.all()
          : selectForTab.all(tabId, tabId)
      ) as LinkRow[];

      return { items: rows.map(mapLink) };
    },

    createLink(input) {
      if (input.from === input.to) {
        throw new SelfLinkError(input.from);
      }

      return createTransaction(input);
    },

    updateLink(id, input) {
      return updateTransaction(id, input);
    },

    deleteLink(id) {
      return deleteLink.run(id).changes > 0;
    },
  };
}
