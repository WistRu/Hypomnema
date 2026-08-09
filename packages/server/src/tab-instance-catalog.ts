import type Database from "better-sqlite3";

import type {
  DuplicateGroup,
  DuplicateGroupListResponse,
  IngestSnapshot,
  TabInstance,
  TabInstanceListResponse,
} from "@tabhub/shared";

import { normalizeUrl } from "./normalize-url.js";

export interface ListTabInstancesInput {
  browser: string | undefined;
  q: string | undefined;
  duplicatesOnly: boolean;
  page: number;
  pageSize: number;
}

export interface TabInstanceCatalog {
  syncSnapshot(snapshot: IngestSnapshot, now: string): { closed: number };
  listInstances(input: ListTabInstancesInput): TabInstanceListResponse;
  listDuplicateGroups(input: {
    browser: string | undefined;
    page: number;
    pageSize: number;
  }): DuplicateGroupListResponse;
}

interface InstanceKeyRow {
  instance_key: string;
}

interface BrowserRow {
  browser: string;
}

interface LegacyPositionRow {
  instance_key: string;
  url: string;
  window_id: number;
  tab_index: number;
}

interface CountRow {
  total: number;
}

interface TabInstanceRow {
  instance_id: number;
  canonical_tab_id: number;
  installation_id: string;
  browser_session_id: string | null;
  browser_tab_id: number | null;
  url: string;
  url_normalized: string;
  title: string | null;
  browser: string;
  window_id: number;
  tab_index: number;
  favicon_url: string | null;
  active: 0 | 1;
  pinned: 0 | 1;
  last_accessed: number | null;
  first_seen_at: string;
  last_seen_at: string;
  status: TabInstance["status"];
  importance: TabInstance["importance"];
  summary: string | null;
  duplicate_group_size: number;
}

interface TabTagPathRow {
  tab_id: number;
  path: string;
}

interface DuplicateGroupRow {
  installation_id: string;
  browser: string;
  url: string;
  count: number;
  protected_count: number;
}

interface DuplicateTotalsRow {
  total_groups: number;
  total_tabs_in_groups: number;
  total_duplicate_copies: number;
  total_close_candidates: number;
  total_protected: number;
}

function installationIdFor(snapshot: IngestSnapshot): string {
  return snapshot.installationId ?? `legacy:${snapshot.browser}`;
}

function instanceKey(tab: IngestSnapshot["tabs"][number]): string {
  return tab.tabId === undefined
    ? `position:${tab.windowId}:${tab.index}`
    : `tab:${tab.tabId}`;
}

function mapInstanceRow(row: TabInstanceRow, tagPaths: string[]): TabInstance {
  return {
    instanceId: row.instance_id,
    canonicalTabId: row.canonical_tab_id,
    installationId: row.installation_id,
    browserSessionId: row.browser_session_id,
    browserTabId: row.browser_tab_id,
    url: row.url,
    urlNormalized: row.url_normalized,
    title: row.title,
    browser: row.browser,
    windowId: row.window_id,
    index: row.tab_index,
    faviconUrl: row.favicon_url,
    active: row.active === 1,
    pinned: row.pinned === 1,
    lastAccessed: row.last_accessed,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    importance: row.importance,
    summary: row.summary,
    tagPaths,
    duplicateGroupSize: row.duplicate_group_size,
  };
}

export function createTabInstanceCatalog(
  connection: Database.Database,
): TabInstanceCatalog {
  const selectInstanceKeys = connection.prepare(`
    SELECT instance_key
    FROM tab_instances
    WHERE installation_id = ?
  `);
  const selectInstallationBrowsers = connection.prepare(`
    SELECT DISTINCT tabs.browser
    FROM tab_instances
    JOIN tabs ON tabs.id = tab_instances.tab_id
    WHERE tab_instances.installation_id = ?
  `);
  const deleteInstance = connection.prepare(`
    DELETE FROM tab_instances
    WHERE installation_id = ? AND instance_key = ?
  `);
  const selectLegacyPositionInstances = connection.prepare(`
    SELECT instance_key, url, window_id, tab_index
    FROM tab_instances
    WHERE installation_id = ?
      AND instance_key LIKE 'position:%'
    ORDER BY instance_key
  `);
  const deleteLegacyMigrationInstances = connection.prepare(`
    DELETE FROM tab_instances
    WHERE installation_id = ?
      AND instance_key LIKE 'canonical:%'
  `);
  const deleteLegacyPositionInstances = connection.prepare(`
    DELETE FROM tab_instances
    WHERE installation_id = ?
      AND instance_key LIKE 'position:%'
  `);
  const selectCanonicalTab = connection.prepare(`
    SELECT id
    FROM tabs
    WHERE browser = ? AND url_normalized = ?
  `);
  const upsertInstance = connection.prepare(`
    INSERT INTO tab_instances (
      tab_id,
      installation_id,
      instance_key,
      browser_session_id,
      browser_tab_id,
      url,
      title,
      window_id,
      tab_index,
      favicon_url,
      active,
      pinned,
      last_accessed,
      first_seen_at,
      last_seen_at
    ) VALUES (
      @tabId,
      @installationId,
      @instanceKey,
      @browserSessionId,
      @browserTabId,
      @url,
      @title,
      @windowId,
      @tabIndex,
      @faviconUrl,
      @active,
      @pinned,
      @lastAccessed,
      @now,
      @now
    )
    ON CONFLICT (installation_id, instance_key) DO UPDATE SET
      tab_id = excluded.tab_id,
      browser_session_id = excluded.browser_session_id,
      browser_tab_id = excluded.browser_tab_id,
      url = excluded.url,
      title = excluded.title,
      window_id = excluded.window_id,
      tab_index = excluded.tab_index,
      favicon_url = excluded.favicon_url,
      active = excluded.active,
      pinned = excluded.pinned,
      last_accessed = excluded.last_accessed,
      last_seen_at = excluded.last_seen_at
  `);
  const closeCanonicalTabs = connection.prepare(`
    UPDATE tabs
    SET is_open = 0, closed_at = ?
    WHERE browser = ?
      AND is_open = 1
      AND NOT EXISTS (
        SELECT 1
        FROM tab_instances
        WHERE tab_instances.tab_id = tabs.id
      )
  `);
  const reopenCanonicalTabs = connection.prepare(`
    UPDATE tabs
    SET is_open = 1, closed_at = NULL
    WHERE browser = ?
      AND is_open = 0
      AND EXISTS (
        SELECT 1
        FROM tab_instances
        WHERE tab_instances.tab_id = tabs.id
      )
  `);
  const selectDuplicateGroupInstances = connection.prepare(`
    SELECT
      tab_instances.id AS instance_id,
      tabs.id AS canonical_tab_id,
      tab_instances.installation_id,
      tab_instances.browser_session_id,
      tab_instances.browser_tab_id,
      tab_instances.url,
      tabs.url_normalized,
      tab_instances.title,
      tabs.browser,
      tab_instances.window_id,
      tab_instances.tab_index,
      tab_instances.favicon_url,
      tab_instances.active,
      tab_instances.pinned,
      tab_instances.last_accessed,
      tab_instances.first_seen_at,
      tab_instances.last_seen_at,
      tabs.status,
      tabs.importance,
      contents.summary,
      COUNT(*) OVER (
        PARTITION BY
          tab_instances.installation_id,
          tabs.browser,
          tab_instances.url
      ) AS duplicate_group_size
    FROM tab_instances
    JOIN tabs ON tabs.id = tab_instances.tab_id
    LEFT JOIN contents ON contents.tab_id = tabs.id
    WHERE tab_instances.installation_id = ?
      AND tabs.browser = ?
      AND tab_instances.url = ?
    ORDER BY
      tab_instances.active DESC,
      tab_instances.pinned DESC,
      COALESCE(tab_instances.last_accessed, -1) DESC,
      tab_instances.window_id,
      tab_instances.tab_index,
      tab_instances.id
  `);

  const loadTagPaths = (rows: TabInstanceRow[]): Map<number, string[]> => {
    const tagPathsByTab = new Map<number, string[]>();
    const canonicalIds = [...new Set(rows.map((row) => row.canonical_tab_id))];
    if (canonicalIds.length === 0) {
      return tagPathsByTab;
    }

    const placeholders = canonicalIds.map(() => "?").join(", ");
    const tagRows = connection
      .prepare(`
        WITH RECURSIVE tag_paths(id, path) AS (
          SELECT id, name FROM tags WHERE parent_id IS NULL
          UNION ALL
          SELECT child.id, tag_paths.path || '/' || child.name
          FROM tags AS child
          JOIN tag_paths ON child.parent_id = tag_paths.id
        )
        SELECT tab_tags.tab_id, tag_paths.path
        FROM tab_tags
        JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
        WHERE tab_tags.tab_id IN (${placeholders})
        ORDER BY tab_tags.tab_id, tag_paths.path COLLATE NOCASE, tag_paths.id
      `)
      .all(...canonicalIds) as TabTagPathRow[];
    for (const row of tagRows) {
      const paths = tagPathsByTab.get(row.tab_id) ?? [];
      paths.push(row.path);
      tagPathsByTab.set(row.tab_id, paths);
    }
    return tagPathsByTab;
  };

  return {
    syncSnapshot(snapshot, now) {
      const installationId = installationIdFor(snapshot);
      const affectedBrowsers = new Set<string>([
        snapshot.browser,
        ...(selectInstallationBrowsers.all(installationId) as BrowserRow[]).map(
          ({ browser }) => browser,
        ),
      ]);
      if (snapshot.installationId !== undefined) {
        const legacyInstallationId = `legacy:${snapshot.browser}`;
        deleteLegacyMigrationInstances.run(legacyInstallationId);

        const legacyPositions = selectLegacyPositionInstances.all(
          legacyInstallationId,
        ) as LegacyPositionRow[];
        const legacyByPosition = new Map(
          legacyPositions.map((row) => [
            `${row.window_id}:${row.tab_index}`,
            row.url,
          ]),
        );
        const modernPositions = new Set(
          snapshot.tabs.map((tab) => `${tab.windowId}:${tab.index}`),
        );
        const replacesSameLegacySnapshot =
          legacyPositions.length > 0 &&
          legacyPositions.length === snapshot.tabs.length &&
          modernPositions.size === snapshot.tabs.length &&
          snapshot.tabs.every(
            (tab) =>
              legacyByPosition.get(`${tab.windowId}:${tab.index}`) === tab.url,
          );
        if (replacesSameLegacySnapshot) {
          deleteLegacyPositionInstances.run(legacyInstallationId);
        }
      }

      const currentKeys = new Set(snapshot.tabs.map(instanceKey));
      const previousKeys = selectInstanceKeys.all(
        installationId,
      ) as InstanceKeyRow[];
      for (const previous of previousKeys) {
        if (!currentKeys.has(previous.instance_key)) {
          deleteInstance.run(installationId, previous.instance_key);
        }
      }

      for (const tab of snapshot.tabs) {
        const canonical = selectCanonicalTab.get(
          snapshot.browser,
          normalizeUrl(tab.url),
        ) as { id: number } | undefined;
        if (canonical === undefined) {
          throw new Error(`Canonical tab is missing for ${tab.url}`);
        }

        upsertInstance.run({
          tabId: canonical.id,
          installationId,
          instanceKey: instanceKey(tab),
          browserSessionId: snapshot.browserSessionId ?? null,
          browserTabId: tab.tabId ?? null,
          url: tab.url,
          title: tab.title ?? null,
          windowId: tab.windowId,
          tabIndex: tab.index,
          faviconUrl: tab.faviconUrl ?? null,
          active: tab.active === true ? 1 : 0,
          pinned: tab.pinned === true ? 1 : 0,
          lastAccessed: tab.lastAccessed ?? null,
          now,
        });
      }

      let closed = 0;
      for (const browser of affectedBrowsers) {
        reopenCanonicalTabs.run(browser);
        closed += closeCanonicalTabs.run(now, browser).changes;
      }
      return { closed };
    },

    listInstances(input) {
      const predicates: string[] = [];
      const parameters: Array<string | number> = [];
      if (input.browser !== undefined) {
        predicates.push("browser = ?");
        parameters.push(input.browser);
      }
      if (input.q !== undefined) {
        predicates.push("(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')");
        const escaped = input.q
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
        parameters.push(`%${escaped}%`, `%${escaped}%`);
      }
      if (input.duplicatesOnly) {
        predicates.push("duplicate_group_size > 1");
      }
      const whereClause =
        predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
      const baseQuery = `
        WITH instances AS (
          SELECT
            tab_instances.id AS instance_id,
            tabs.id AS canonical_tab_id,
            tab_instances.installation_id,
            tab_instances.browser_session_id,
            tab_instances.browser_tab_id,
            tab_instances.url,
            tabs.url_normalized,
            tab_instances.title,
            tabs.browser,
            tab_instances.window_id,
            tab_instances.tab_index,
            tab_instances.favicon_url,
            tab_instances.active,
            tab_instances.pinned,
            tab_instances.last_accessed,
            tab_instances.first_seen_at,
            tab_instances.last_seen_at,
            tabs.status,
            tabs.importance,
            contents.summary,
            COUNT(*) OVER (
              PARTITION BY
                tab_instances.installation_id,
                tabs.browser,
                tab_instances.url
            ) AS duplicate_group_size
          FROM tab_instances
          JOIN tabs ON tabs.id = tab_instances.tab_id
          LEFT JOIN contents ON contents.tab_id = tabs.id
        )`;
      const total = connection
        .prepare(
          `${baseQuery} SELECT COUNT(*) AS total FROM instances ${whereClause}`,
        )
        .get(...parameters) as CountRow;
      const offset = (input.page - 1) * input.pageSize;
      const rows = connection
        .prepare(`
          ${baseQuery}
          SELECT *
          FROM instances
          ${whereClause}
          ORDER BY last_seen_at DESC, instance_id DESC
          LIMIT ? OFFSET ?
        `)
        .all(...parameters, input.pageSize, offset) as TabInstanceRow[];
      const tagPathsByTab = loadTagPaths(rows);

      return {
        items: rows.map((row) =>
          mapInstanceRow(row, tagPathsByTab.get(row.canonical_tab_id) ?? []),
        ),
        total: total.total,
        page: input.page,
        pageSize: input.pageSize,
      };
    },

    listDuplicateGroups(input) {
      const readSnapshot = connection.transaction(() => {
        const browserPredicate =
          input.browser === undefined ? "" : "WHERE browser = ?";
        const parameters = input.browser === undefined ? [] : [input.browser];
        const groupedQuery = `
        WITH grouped AS (
          SELECT
            tab_instances.installation_id,
            tabs.browser,
            tab_instances.url,
            COUNT(*) AS count,
            SUM(
              CASE WHEN tab_instances.active = 1 OR tab_instances.pinned = 1
                THEN 1 ELSE 0 END
            ) AS protected_count
          FROM tab_instances
          JOIN tabs ON tabs.id = tab_instances.tab_id
          ${browserPredicate}
          GROUP BY
            tab_instances.installation_id,
            tabs.browser,
            tab_instances.url
          HAVING COUNT(*) > 1
        )`;
        const totals = connection
          .prepare(`
          ${groupedQuery}
          SELECT
            COUNT(*) AS total_groups,
            COALESCE(SUM(count), 0) AS total_tabs_in_groups,
            COALESCE(SUM(count - 1), 0) AS total_duplicate_copies,
            COALESCE(SUM(
              CASE WHEN protected_count > 0
                THEN count - protected_count
                ELSE count - 1 END
            ), 0) AS total_close_candidates,
            COALESCE(SUM(protected_count), 0) AS total_protected
          FROM grouped
          `)
          .get(...parameters) as DuplicateTotalsRow;
        const offset = (input.page - 1) * input.pageSize;
        const groupRows = connection
          .prepare(`
          ${groupedQuery}
          SELECT *
          FROM grouped
          ORDER BY count DESC, browser COLLATE NOCASE, installation_id, url
          LIMIT ? OFFSET ?
          `)
          .all(...parameters, input.pageSize, offset) as DuplicateGroupRow[];
        const rowsByGroup = groupRows.map((group) =>
          selectDuplicateGroupInstances.all(
            group.installation_id,
            group.browser,
            group.url,
          ) as TabInstanceRow[],
        );
        const tagPathsByTab = loadTagPaths(rowsByGroup.flat());
        const items: DuplicateGroup[] = groupRows.map((group, groupIndex) => {
          const instances = rowsByGroup[groupIndex]!.map((row) =>
            mapInstanceRow(row, tagPathsByTab.get(row.canonical_tab_id) ?? []),
          );
          const protectedInstances = instances.filter(
            (instance) => instance.active || instance.pinned,
          );
          const keeper = instances[0]!;
          const candidates =
            protectedInstances.length > 0
              ? instances.filter(
                  (instance) => !instance.active && !instance.pinned,
                )
              : instances.slice(1);

          return {
            installationId: group.installation_id,
            browser: group.browser,
            url: group.url,
            count: group.count,
            keeperInstanceId: keeper.instanceId,
            candidateInstanceIds: candidates.map(({ instanceId }) => instanceId),
            protectedInstanceIds: protectedInstances.map(
              ({ instanceId }) => instanceId,
            ),
            instances,
          };
        });

        return {
          items,
          totalGroups: totals.total_groups,
          totalTabsInGroups: totals.total_tabs_in_groups,
          totalDuplicateCopies: totals.total_duplicate_copies,
          totalCloseCandidates: totals.total_close_candidates,
          totalProtected: totals.total_protected,
          page: input.page,
          pageSize: input.pageSize,
        };
      });

      return readSnapshot();
    },
  };
}
