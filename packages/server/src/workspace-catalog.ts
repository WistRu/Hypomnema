import type Database from "better-sqlite3";

import type {
  CreateWorkspace,
  PatchWorkspace,
  WorkspaceDetail,
  WorkspaceItem,
  WorkspaceListResponse,
} from "@tabhub/shared";

export interface WorkspaceCatalog {
  create(input: CreateWorkspace): WorkspaceDetail;
  get(id: number): WorkspaceDetail | undefined;
  list(): WorkspaceListResponse;
  rename(id: number, input: PatchWorkspace): WorkspaceDetail | undefined;
  delete(id: number): boolean;
}

export class TabInstanceStaleError extends Error {
  readonly code = "TAB_INSTANCE_STALE";

  constructor(readonly staleInstanceIds: number[]) {
    super(
      `Physical tab selections are stale: ${staleInstanceIds.join(", ")}`,
    );
    this.name = "TabInstanceStaleError";
  }
}

interface WorkspaceHeaderRow {
  id: number;
  name: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}

interface WorkspaceSourceRow {
  source_instance_id: number;
  canonical_tab_id: number | null;
  browser: string;
  installation_id: string;
  browser_session_id: string | null;
  browser_tab_id: number | null;
  url: string;
  title: string | null;
  window_id: number;
  tab_index: number;
  favicon_url: string | null;
  active: 0 | 1;
  pinned: 0 | 1;
  audible: 0 | 1;
  muted: 0 | 1;
  discarded: 0 | 1;
  last_accessed: number | null;
}

interface WorkspaceItemRow extends WorkspaceSourceRow {
  id: number;
  ordinal: number;
}

function mapItem(row: WorkspaceItemRow): WorkspaceItem {
  return {
    id: row.id,
    ordinal: row.ordinal,
    sourceInstanceId: row.source_instance_id,
    canonicalTabId: row.canonical_tab_id,
    browser: row.browser,
    installationId: row.installation_id,
    browserSessionId: row.browser_session_id,
    browserTabId: row.browser_tab_id,
    url: row.url,
    title: row.title,
    windowId: row.window_id,
    index: row.tab_index,
    faviconUrl: row.favicon_url,
    active: row.active === 1,
    pinned: row.pinned === 1,
    audible: row.audible === 1,
    muted: row.muted === 1,
    discarded: row.discarded === 1,
    lastAccessed: row.last_accessed,
  };
}

export function createWorkspaceCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
): WorkspaceCatalog {
  const selectSource = connection.prepare(`
    SELECT
      tab_instances.id AS source_instance_id,
      tab_instances.tab_id AS canonical_tab_id,
      tabs.browser,
      tab_instances.installation_id,
      tab_instances.browser_session_id,
      tab_instances.browser_tab_id,
      tab_instances.url,
      tab_instances.title,
      tab_instances.window_id,
      tab_instances.tab_index,
      tab_instances.favicon_url,
      tab_instances.active,
      tab_instances.pinned,
      tab_instances.audible,
      tab_instances.muted,
      tab_instances.discarded,
      tab_instances.last_accessed
    FROM tab_instances
    JOIN tabs ON tabs.id = tab_instances.tab_id
    WHERE tab_instances.id = ?
  `);
  const insertWorkspace = connection.prepare(`
    INSERT INTO saved_workspaces (name, created_at, updated_at)
    VALUES (?, ?, ?)
  `);
  const insertItem = connection.prepare(`
    INSERT INTO saved_workspace_items (
      workspace_id,
      ordinal,
      source_instance_id,
      canonical_tab_id,
      browser,
      installation_id,
      browser_session_id,
      browser_tab_id,
      url,
      title,
      window_id,
      tab_index,
      favicon_url,
      active,
      pinned,
      audible,
      muted,
      discarded,
      last_accessed
    ) VALUES (
      @workspaceId,
      @ordinal,
      @sourceInstanceId,
      @canonicalTabId,
      @browser,
      @installationId,
      @browserSessionId,
      @browserTabId,
      @url,
      @title,
      @windowId,
      @tabIndex,
      @faviconUrl,
      @active,
      @pinned,
      @audible,
      @muted,
      @discarded,
      @lastAccessed
    )
  `);
  const selectHeader = connection.prepare(`
    SELECT
      saved_workspaces.id,
      saved_workspaces.name,
      COUNT(saved_workspace_items.id) AS item_count,
      saved_workspaces.created_at,
      saved_workspaces.updated_at
    FROM saved_workspaces
    LEFT JOIN saved_workspace_items
      ON saved_workspace_items.workspace_id = saved_workspaces.id
    WHERE saved_workspaces.id = ?
    GROUP BY saved_workspaces.id
  `);
  const selectHeaders = connection.prepare(`
    SELECT
      saved_workspaces.id,
      saved_workspaces.name,
      COUNT(saved_workspace_items.id) AS item_count,
      saved_workspaces.created_at,
      saved_workspaces.updated_at
    FROM saved_workspaces
    LEFT JOIN saved_workspace_items
      ON saved_workspace_items.workspace_id = saved_workspaces.id
    GROUP BY saved_workspaces.id
    ORDER BY saved_workspaces.updated_at DESC, saved_workspaces.id DESC
  `);
  const selectItems = connection.prepare(`
    SELECT
      id,
      ordinal,
      source_instance_id,
      canonical_tab_id,
      browser,
      installation_id,
      browser_session_id,
      browser_tab_id,
      url,
      title,
      window_id,
      tab_index,
      favicon_url,
      active,
      pinned,
      audible,
      muted,
      discarded,
      last_accessed
    FROM saved_workspace_items
    WHERE workspace_id = ?
    ORDER BY ordinal, id
  `);
  const updateWorkspace = connection.prepare(`
    UPDATE saved_workspaces
    SET name = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteWorkspace = connection.prepare(`
    DELETE FROM saved_workspaces
    WHERE id = ?
  `);

  const getDetail = (id: number): WorkspaceDetail | undefined => {
    const header = selectHeader.get(id) as WorkspaceHeaderRow | undefined;
    if (header === undefined) {
      return undefined;
    }

    return {
      id: header.id,
      name: header.name,
      itemCount: header.item_count,
      createdAt: header.created_at,
      updatedAt: header.updated_at,
      items: (selectItems.all(id) as WorkspaceItemRow[]).map(mapItem),
    };
  };

  const createTransaction = connection.transaction(
    (input: CreateWorkspace): WorkspaceDetail => {
      const sources = input.selections.map((selected) =>
        selectSource.get(selected.instanceId) as WorkspaceSourceRow | undefined,
      );
      const staleInstanceIds = input.selections.flatMap((selected, index) => {
        const source = sources[index];
        return source === undefined ||
          source.browser !== selected.browser ||
          source.installation_id !== selected.installationId ||
          source.browser_session_id !== selected.browserSessionId ||
          source.browser_tab_id !== selected.browserTabId
          ? [selected.instanceId]
          : [];
      });
      if (staleInstanceIds.length > 0) {
        throw new TabInstanceStaleError(staleInstanceIds);
      }

      const now = clock().toISOString();
      const workspaceId = Number(
        insertWorkspace.run(input.name, now, now).lastInsertRowid,
      );
      const orderedSources = sources
        .map((source) => source!)
        .sort(
          (left, right) =>
            left.browser.localeCompare(right.browser) ||
            left.installation_id.localeCompare(right.installation_id) ||
            (left.browser_session_id ?? "").localeCompare(
              right.browser_session_id ?? "",
            ) ||
            left.window_id - right.window_id ||
            left.tab_index - right.tab_index ||
            left.source_instance_id - right.source_instance_id,
        );
      orderedSources.forEach((current, ordinal) => {
        insertItem.run({
          workspaceId,
          ordinal,
          sourceInstanceId: current.source_instance_id,
          canonicalTabId: current.canonical_tab_id,
          browser: current.browser,
          installationId: current.installation_id,
          browserSessionId: current.browser_session_id,
          browserTabId: current.browser_tab_id,
          url: current.url,
          title: current.title,
          windowId: current.window_id,
          tabIndex: current.tab_index,
          faviconUrl: current.favicon_url,
          active: current.active,
          pinned: current.pinned,
          audible: current.audible,
          muted: current.muted,
          discarded: current.discarded,
          lastAccessed: current.last_accessed,
        });
      });

      const workspace = getDetail(workspaceId);
      if (workspace === undefined) {
        throw new Error("Created workspace could not be read back");
      }
      return workspace;
    },
  );
  const renameTransaction = connection.transaction(
    (id: number, input: PatchWorkspace): WorkspaceDetail | undefined => {
      const now = clock().toISOString();
      if (updateWorkspace.run(input.name, now, id).changes === 0) {
        return undefined;
      }
      return getDetail(id);
    },
  );

  return {
    create(input) {
      return createTransaction.immediate(input);
    },

    get(id) {
      return getDetail(id);
    },

    list() {
      return {
        items: (selectHeaders.all() as WorkspaceHeaderRow[]).map((row) => ({
          id: row.id,
          name: row.name,
          itemCount: row.item_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      };
    },

    rename(id, input) {
      return renameTransaction(id, input);
    },

    delete(id) {
      return deleteWorkspace.run(id).changes > 0;
    },
  };
}
