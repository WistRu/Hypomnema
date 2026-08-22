import type Database from "better-sqlite3";

import type {
  BrowserPageRef,
  LegacyImportanceReviewResponse,
  LogicalPageImportanceMigrationAudit,
  LogicalPagePreference,
  LogicalPageRef,
  LogicalPageView,
  SetImportance,
  UserImportance,
} from "@tabhub/shared";

export interface ResolveLogicalPageInput {
  firstObservedAt?: string;
  observedAt: string;
  url: string;
  urlNormalized: string;
}

export type LogicalImportanceProvenance =
  | { recordedBy: "user"; recordMethod: "manual" }
  | { recordedBy: "agent"; recordMethod: "on_behalf_of_user" };

export type SetLogicalImportanceResult =
  | { kind: "missing"; missingIds: number[] }
  | { kind: "updated"; updated: number };

export interface LogicalPageCatalog {
  resolve(input: ResolveLogicalPageInput): LogicalPageRef;
  get(id: number): LogicalPageView | undefined;
  getByTabId(tabId: number): LogicalPageView | undefined;
  listLegacyImportanceReviews(input: {
    page: number;
    pageSize: number;
  }): LegacyImportanceReviewResponse;
  setImportance(
    input: SetImportance,
    provenance: LogicalImportanceProvenance,
  ): SetLogicalImportanceResult;
  setUserImportance(
    input: { logicalPageId: number; value: UserImportance | null },
    provenance: LogicalImportanceProvenance,
  ): LogicalPagePreference | undefined;
}

interface LogicalPageRow {
  id: number;
  identity_key: string;
  url_normalized: string;
  representative_url: string;
  created_at: string;
  updated_at: string;
}

interface LogicalPagePreferenceRow {
  logical_page_id: number;
  user_importance: number | null;
  recorded_by: string | null;
  record_method: string | null;
  importance_updated_at: string | null;
  updated_at: string;
}

interface LegacyImportanceAuditRow {
  logical_page_id: number;
  legacy_values_json: string;
  suggested_value: 1 | 2 | 3 | null;
  resolution_state: "legacy_unknown" | "conflict" | "confirmed";
  created_at: string;
  reviewed_at: string | null;
}

interface BrowserPageRow {
  id: number;
  logical_page_id: number;
  browser: string;
  url: string;
  url_normalized: string;
}

interface TabLogicalPageRow {
  id: number;
  logical_page_id: number;
}

interface CountRow {
  total: number;
}

function mapLogicalPage(row: LogicalPageRow): LogicalPageRef {
  return {
    id: row.id,
    identityKey: row.identity_key,
    urlNormalized: row.url_normalized,
    representativeUrl: row.representative_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function invalidPreference(row: LogicalPagePreferenceRow): never {
  throw new Error(
    `Invalid logical page preference provenance for logical page ${row.logical_page_id}`,
  );
}

function isUserImportance(value: number): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

function mapPreference(row: LogicalPagePreferenceRow): LogicalPagePreference {
  if (row.user_importance === null) {
    if (
      row.recorded_by !== null ||
      row.record_method !== null ||
      row.importance_updated_at !== null
    ) {
      return invalidPreference(row);
    }
    return {
      logicalPageId: row.logical_page_id,
      userImportance: null,
      recordedBy: null,
      recordMethod: null,
      importanceUpdatedAt: null,
      updatedAt: row.updated_at,
    };
  }

  if (
    !isUserImportance(row.user_importance) ||
    row.importance_updated_at === null
  ) {
    return invalidPreference(row);
  }

  if (row.recorded_by === "user" && row.record_method === "manual") {
    return {
      logicalPageId: row.logical_page_id,
      userImportance: row.user_importance,
      recordedBy: "user",
      recordMethod: "manual",
      importanceUpdatedAt: row.importance_updated_at,
      updatedAt: row.updated_at,
    };
  }

  if (
    row.recorded_by === "agent" &&
    row.record_method === "on_behalf_of_user"
  ) {
    return {
      logicalPageId: row.logical_page_id,
      userImportance: row.user_importance,
      recordedBy: "agent",
      recordMethod: "on_behalf_of_user",
      importanceUpdatedAt: row.importance_updated_at,
      updatedAt: row.updated_at,
    };
  }

  return invalidPreference(row);
}

function mapAudit(
  row: LegacyImportanceAuditRow,
): LogicalPageImportanceMigrationAudit {
  return {
    logicalPageId: row.logical_page_id,
    legacyValues: JSON.parse(row.legacy_values_json) as
      LogicalPageImportanceMigrationAudit["legacyValues"],
    suggestedValue: row.suggested_value,
    resolutionState: row.resolution_state,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function mapBrowserPage(row: BrowserPageRow): BrowserPageRef {
  return {
    tabId: row.id,
    logicalPageId: row.logical_page_id,
    browser: row.browser,
    url: row.url,
    urlNormalized: row.url_normalized,
  };
}

export function createLogicalPageCatalog(
  connection: Database.Database,
  clock: () => Date = () => new Date(),
  onPageCreated?: (logicalPageId: number) => void,
): LogicalPageCatalog {
  const upsertLogicalPage = connection.prepare(`
    INSERT INTO logical_pages (
      identity_key,
      url_normalized,
      representative_url,
      created_at,
      updated_at
    ) VALUES (
      @urlNormalized,
      @urlNormalized,
      @url,
      @createdAt,
      @observedAt
    )
    ON CONFLICT (identity_key) DO UPDATE SET
      representative_url = CASE
        WHEN excluded.updated_at > logical_pages.updated_at
          OR (
            excluded.updated_at = logical_pages.updated_at
            AND excluded.representative_url < logical_pages.representative_url
          )
          THEN excluded.representative_url
        ELSE logical_pages.representative_url
      END,
      created_at = MIN(logical_pages.created_at, excluded.created_at),
      updated_at = MAX(logical_pages.updated_at, excluded.updated_at)
  `);
  const selectLogicalPage = connection.prepare(`
    SELECT
      id,
      identity_key,
      url_normalized,
      representative_url,
      created_at,
      updated_at
    FROM logical_pages
    WHERE identity_key = ?
  `);
  const selectLogicalPageById = connection.prepare(`
    SELECT
      id,
      identity_key,
      url_normalized,
      representative_url,
      created_at,
      updated_at
    FROM logical_pages
    WHERE id = ?
  `);
  const selectLogicalPagesByIds = connection.prepare(`
    SELECT
      id,
      identity_key,
      url_normalized,
      representative_url,
      created_at,
      updated_at
    FROM logical_pages
    WHERE id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
  `);
  const ensurePreference = connection.prepare(`
    INSERT INTO logical_page_preferences (
      logical_page_id,
      user_importance,
      recorded_by,
      record_method,
      importance_updated_at,
      updated_at
    ) VALUES (?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT (logical_page_id) DO NOTHING
  `);
  const selectPreference = connection.prepare(`
    SELECT
      logical_page_id,
      user_importance,
      recorded_by,
      record_method,
      importance_updated_at,
      updated_at
    FROM logical_page_preferences
    WHERE logical_page_id = ?
  `);
  const selectPreferencesByIds = connection.prepare(`
    SELECT
      logical_page_id,
      user_importance,
      recorded_by,
      record_method,
      importance_updated_at,
      updated_at
    FROM logical_page_preferences
    WHERE logical_page_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
  `);
  const selectAudit = connection.prepare(`
    SELECT
      logical_page_id,
      legacy_values_json,
      suggested_value,
      resolution_state,
      created_at,
      reviewed_at
    FROM logical_page_importance_migration_audit
    WHERE logical_page_id = ?
  `);
  const selectAuditsByIds = connection.prepare(`
    SELECT
      logical_page_id,
      legacy_values_json,
      suggested_value,
      resolution_state,
      created_at,
      reviewed_at
    FROM logical_page_importance_migration_audit
    WHERE logical_page_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
  `);
  const selectBrowserPages = connection.prepare(`
    SELECT id, logical_page_id, browser, url, url_normalized
    FROM tabs
    WHERE logical_page_id = ?
    ORDER BY browser ASC, id ASC
  `);
  const selectBrowserPagesByIds = connection.prepare(`
    SELECT id, logical_page_id, browser, url, url_normalized
    FROM tabs
    WHERE logical_page_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
    ORDER BY logical_page_id ASC, browser ASC, id ASC
  `);
  const selectLogicalPageIdByTabId = connection.prepare(`
    SELECT id, logical_page_id
    FROM tabs
    WHERE id = ?
  `);
  const selectLogicalPageIdsByTabIds = connection.prepare(`
    SELECT tabs.id, tabs.logical_page_id
    FROM tabs
    INNER JOIN json_each(?) AS requested_ids
      ON tabs.id = CAST(requested_ids.value AS INTEGER)
  `);
  const updatePreference = connection.prepare(`
    UPDATE logical_page_preferences
    SET
      user_importance = @userImportance,
      recorded_by = @recordedBy,
      record_method = @recordMethod,
      importance_updated_at = @importanceUpdatedAt,
      updated_at = @updatedAt
    WHERE logical_page_id = @logicalPageId
  `);
  const markAuditReviewed = connection.prepare(`
    UPDATE logical_page_importance_migration_audit
    SET resolution_state = 'confirmed', reviewed_at = @reviewedAt
    WHERE logical_page_id = @logicalPageId
      AND (resolution_state <> 'confirmed' OR reviewed_at IS NULL)
  `);
  const projectImportance = connection.prepare(`
    UPDATE tabs
    SET importance = ?
    WHERE logical_page_id IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each(?)
    )
      AND importance <> ?
  `);
  const countReviews = connection.prepare(`
    SELECT COUNT(*) AS total
    FROM logical_page_importance_migration_audit
    WHERE resolution_state IN ('legacy_unknown', 'conflict')
  `);
  const selectReviewIds = connection.prepare(`
    SELECT logical_page_id
    FROM logical_page_importance_migration_audit
    WHERE resolution_state IN ('legacy_unknown', 'conflict')
    ORDER BY created_at ASC, logical_page_id ASC
    LIMIT ? OFFSET ?
  `);

  const resolveInternal = (input: ResolveLogicalPageInput): LogicalPageRef => {
    const existing = selectLogicalPage.get(input.urlNormalized) as
      | LogicalPageRow
      | undefined;
    upsertLogicalPage.run({
      ...input,
      createdAt: input.firstObservedAt ?? input.observedAt,
    });
    const row = selectLogicalPage.get(input.urlNormalized) as LogicalPageRow;
    ensurePreference.run(row.id, row.created_at);
    if (existing === undefined) {
      onPageCreated?.(row.id);
    }
    return mapLogicalPage(row);
  };
  const resolveTransaction = connection.transaction(resolveInternal);

  const getView = (id: number): LogicalPageView | undefined => {
    const page = selectLogicalPageById.get(id) as LogicalPageRow | undefined;
    if (page === undefined) return undefined;

    const preference = selectPreference.get(
      id,
    ) as LogicalPagePreferenceRow | undefined;
    if (preference === undefined) {
      throw new Error(`Logical page ${id} is missing its preference row`);
    }

    const audit = selectAudit.get(id) as LegacyImportanceAuditRow | undefined;
    const browserPages = selectBrowserPages.all(id) as BrowserPageRow[];
    return {
      page: mapLogicalPage(page),
      preference: mapPreference(preference),
      legacyImportanceAudit: audit === undefined ? null : mapAudit(audit),
      browserPages: browserPages.map(mapBrowserPage),
    };
  };

  const updateLogicalPreference = (
    logicalPageId: number,
    value: UserImportance | null,
    provenance: LogicalImportanceProvenance,
    updatedAt: string,
    preference: LogicalPagePreferenceRow,
  ): void => {
    const isReplay = value === null
      ? preference.user_importance === null
      : preference.user_importance === value &&
        preference.recorded_by === provenance.recordedBy &&
        preference.record_method === provenance.recordMethod;
    if (!isReplay) {
      updatePreference.run({
        logicalPageId,
        userImportance: value,
        recordedBy: value === null ? null : provenance.recordedBy,
        recordMethod: value === null ? null : provenance.recordMethod,
        importanceUpdatedAt: value === null ? null : updatedAt,
        updatedAt,
      });
    }
    markAuditReviewed.run({ logicalPageId, reviewedAt: updatedAt });
  };
  const setUserImportanceInternal = (
    logicalPageId: number,
    value: UserImportance | null,
    provenance: LogicalImportanceProvenance,
    updatedAt: string,
  ): LogicalPagePreference | undefined => {
    const preference = selectPreference.get(
      logicalPageId,
    ) as LogicalPagePreferenceRow | undefined;
    if (preference === undefined) return undefined;

    updateLogicalPreference(
      logicalPageId,
      value,
      provenance,
      updatedAt,
      preference,
    );
    projectImportance.run(
      value ?? 0,
      JSON.stringify([logicalPageId]),
      value ?? 0,
    );
    return mapPreference(
      selectPreference.get(logicalPageId) as LogicalPagePreferenceRow,
    );
  };
  const setUserImportanceTransaction = connection.transaction(
    (
      input: { logicalPageId: number; value: UserImportance | null },
      provenance: LogicalImportanceProvenance,
    ) => setUserImportanceInternal(
      input.logicalPageId,
      input.value,
      provenance,
      clock().toISOString(),
    ),
  );
  const setImportanceTransaction = connection.transaction(
    (
      input: SetImportance,
      provenance: LogicalImportanceProvenance,
    ): SetLogicalImportanceResult => {
      const rows = selectLogicalPageIdsByTabIds.all(
        JSON.stringify(input.ids),
      ) as TabLogicalPageRow[];
      const foundIds = new Set(rows.map(({ id }) => id));
      const missingIds = input.ids.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return { kind: "missing", missingIds };
      }

      const updatedAt = clock().toISOString();
      const logicalPageIds = [...new Set(rows.map((row) => row.logical_page_id))]
        .sort((left, right) => left - right);
      const preferences = new Map(
        (
          selectPreferencesByIds.all(
            JSON.stringify(logicalPageIds),
          ) as LogicalPagePreferenceRow[]
        ).map((row) => [row.logical_page_id, row]),
      );
      for (const logicalPageId of logicalPageIds) {
        const preference = preferences.get(logicalPageId);
        if (preference === undefined) {
          throw new Error(`Logical page ${logicalPageId} is missing its preference row`);
        }
        updateLogicalPreference(
          logicalPageId,
          input.importance === 0 ? null : input.importance,
          provenance,
          updatedAt,
          preference,
        );
      }
      projectImportance.run(
        input.importance,
        JSON.stringify(logicalPageIds),
        input.importance,
      );
      return { kind: "updated", updated: input.ids.length };
    },
  );

  return {
    resolve(input) {
      return connection.inTransaction
        ? resolveInternal(input)
        : resolveTransaction(input);
    },

    get(id) {
      return getView(id);
    },

    getByTabId(tabId) {
      const row = selectLogicalPageIdByTabId.get(tabId) as
        | TabLogicalPageRow
        | undefined;
      return row === undefined ? undefined : getView(row.logical_page_id);
    },

    listLegacyImportanceReviews(input) {
      const total = (countReviews.get() as CountRow).total;
      const ids = selectReviewIds.all(
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as Array<{ logical_page_id: number }>;
      const logicalPageIds = ids.map(({ logical_page_id }) => logical_page_id);
      if (logicalPageIds.length === 0) {
        return {
          items: [],
          total,
          page: input.page,
          pageSize: input.pageSize,
        };
      }
      const idsJson = JSON.stringify(logicalPageIds);
      const pages = new Map(
        (selectLogicalPagesByIds.all(idsJson) as LogicalPageRow[]).map((row) => [
          row.id,
          row,
        ]),
      );
      const preferences = new Map(
        (
          selectPreferencesByIds.all(idsJson) as LogicalPagePreferenceRow[]
        ).map((row) => [row.logical_page_id, row]),
      );
      const audits = new Map(
        (selectAuditsByIds.all(idsJson) as LegacyImportanceAuditRow[]).map(
          (row) => [row.logical_page_id, row],
        ),
      );
      const browserPages = new Map<number, BrowserPageRow[]>();
      for (const row of selectBrowserPagesByIds.all(idsJson) as BrowserPageRow[]) {
        const rows = browserPages.get(row.logical_page_id) ?? [];
        rows.push(row);
        browserPages.set(row.logical_page_id, rows);
      }
      return {
        items: logicalPageIds.map((logicalPageId) => {
          const page = pages.get(logicalPageId);
          const preference = preferences.get(logicalPageId);
          if (page === undefined || preference === undefined) {
            throw new Error(
              `Logical page ${logicalPageId} is missing its review state`,
            );
          }
          const audit = audits.get(logicalPageId);
          return {
            page: mapLogicalPage(page),
            preference: mapPreference(preference),
            legacyImportanceAudit:
              audit === undefined ? null : mapAudit(audit),
            browserPages: (browserPages.get(logicalPageId) ?? []).map(
              mapBrowserPage,
            ),
          };
        }),
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    },

    setImportance(input, provenance) {
      return setImportanceTransaction(input, provenance);
    },

    setUserImportance(input, provenance) {
      return connection.inTransaction
        ? setUserImportanceInternal(
            input.logicalPageId,
            input.value,
            provenance,
            clock().toISOString(),
          )
        : setUserImportanceTransaction(input, provenance);
    },
  };
}
