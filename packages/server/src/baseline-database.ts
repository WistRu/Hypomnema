import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  baselineContractHash,
  g0BaselineSchemaVersion,
  s10kV1,
  type SyntheticFixtureContract,
} from "./baseline-contract.js";
import { openDatabase } from "./database.js";
import { createLogicalPageCatalog } from "./logical-page-catalog.js";

export const g0BaselineTables = Object.freeze([
  "tabs",
  "contents",
  "contents_fts",
  "contents_fts_config",
  "contents_fts_data",
  "contents_fts_docsize",
  "contents_fts_idx",
  "tags",
  "tab_tags",
  "custom_fields",
  "embedding_metadata",
  "jobs",
  "summary_job_attempts",
  "tab_instances",
  "saved_workspaces",
  "saved_workspace_items",
  "knowledge_entities",
  "relations",
  "tab_activity_totals",
  "tab_activity_stream_cursors",
  "tab_page_activity_totals",
  "page_retention",
  "vec_contents",
  "vec_contents_chunks",
  "vec_contents_info",
  "vec_contents_rowids",
  "vec_contents_vector_chunks00",
] as const);

export type G0BaselineTableName = (typeof g0BaselineTables)[number];

export interface DatabaseTableFingerprint {
  readonly checksumSha256: string;
  readonly rowCount: number;
}

export interface DatabaseBaselineFingerprint {
  readonly databaseBytes: number;
  readonly fileSha256: string;
  readonly foreignKeyViolationCount: number;
  readonly importanceCounts: Readonly<Record<string, number>>;
  readonly integrityCheck: readonly string[];
  readonly schemaVersion: number;
  readonly tables: Readonly<
    Record<G0BaselineTableName, DatabaseTableFingerprint>
  >;
}

export interface VerifiedDatabaseSnapshot {
  readonly backup: DatabaseBaselineFingerprint;
  readonly backupPath: string;
  readonly restored: DatabaseBaselineFingerprint;
  readonly restoredPath: string;
  readonly sourcePath: string;
}

interface ColumnRow {
  readonly name: string;
  readonly pk: number;
}

interface CountRow {
  readonly count: number;
}

interface IntegrityRow {
  readonly integrity_check: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizedSqlValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { blobHex: value.toString("hex") };
  }
  return value;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function tableFingerprint(
  database: Database.Database,
  tableName: string,
): DatabaseTableFingerprint {
  const columns = database
    .prepare("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid")
    .all(tableName) as ColumnRow[];
  if (columns.length === 0) {
    throw new Error(`Baseline table does not exist: ${tableName}`);
  }

  const primaryKeyColumns = columns
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk);
  const orderingColumns =
    primaryKeyColumns.length > 0 ? primaryKeyColumns : columns;
  const orderBy = orderingColumns
    .map(({ name }) => quoteIdentifier(name))
    .join(", ");
  const rows = database
    .prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`)
    .iterate() as Iterable<Record<string, unknown>>;
  const checksum = createHash("sha256");
  let rowCount = 0;

  for (const row of rows) {
    checksum.update(
      JSON.stringify(
        columns.map(({ name }) => normalizedSqlValue(row[name])),
      ),
    );
    checksum.update("\n");
    rowCount += 1;
  }

  return {
    checksumSha256: checksum.digest("hex"),
    rowCount,
  };
}

export async function inspectDatabaseBaseline(
  databasePath: string,
): Promise<DatabaseBaselineFingerprint> {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });

  try {
    sqliteVec.load(database);
    database.pragma("query_only = ON");
    database.pragma("foreign_keys = ON");
    const tables = Object.fromEntries(
      g0BaselineTables.map((tableName) => [
        tableName,
        tableFingerprint(database, tableName),
      ]),
    ) as Record<G0BaselineTableName, DatabaseTableFingerprint>;
    const importanceCounts = Object.fromEntries(
      (
        database
          .prepare(
            "SELECT importance, COUNT(*) AS count FROM tabs GROUP BY importance ORDER BY importance",
          )
          .all() as Array<{ importance: number; count: number }>
      ).map(({ importance, count }) => [String(importance), count]),
    );
    const integrityCheck = (
      database.pragma("integrity_check") as IntegrityRow[]
    ).map(({ integrity_check: result }) => result);
    const foreignKeyViolationCount = (
      database
        .prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check")
        .get() as CountRow
    ).count;

    return {
      databaseBytes: (await stat(databasePath)).size,
      fileSha256: await sha256File(databasePath),
      foreignKeyViolationCount,
      importanceCounts,
      integrityCheck,
      schemaVersion: database.pragma("user_version", {
        simple: true,
      }) as number,
      tables,
    };
  } finally {
    database.close();
  }
}

export async function createVerifiedDatabaseSnapshot(
  sourcePath: string,
  backupPath: string,
  restoredPath: string,
): Promise<VerifiedDatabaseSnapshot> {
  await mkdir(dirname(backupPath), { recursive: true });
  await mkdir(dirname(restoredPath), { recursive: true });
  const source = new Database(sourcePath, {
    fileMustExist: true,
    readonly: true,
  });

  try {
    source.pragma("query_only = ON");
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  await copyFile(backupPath, restoredPath);
  const backup = await inspectDatabaseBaseline(backupPath);
  const restored = await inspectDatabaseBaseline(restoredPath);

  if (
    JSON.stringify(backup) !== JSON.stringify(restored)
  ) {
    throw new Error("Restored database fingerprint differs from backup");
  }
  if (backup.integrityCheck.length !== 1 || backup.integrityCheck[0] !== "ok") {
    throw new Error(`Backup integrity check failed: ${backup.integrityCheck.join(", ")}`);
  }
  if (backup.foreignKeyViolationCount !== 0) {
    throw new Error(
      `Backup has ${backup.foreignKeyViolationCount} foreign-key violations`,
    );
  }

  return {
    backup,
    backupPath,
    restored,
    restoredPath,
    sourcePath,
  };
}

export interface SyntheticFixtureOptions {
  readonly contract?: SyntheticFixtureContract;
  /** Internal-only compatibility boundary for immutable baseline fixtures. */
  readonly maximumMigrationVersion?: number;
  readonly rowCount?: number;
}

export async function createSyntheticBaselineFixture(
  databasePath: string,
  options: SyntheticFixtureOptions = {},
): Promise<DatabaseBaselineFingerprint> {
  const contract = options.contract ?? s10kV1;
  const rowCount = options.rowCount ?? contract.rowCount;
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 1 ||
    rowCount > contract.rowCount
  ) {
    throw new Error(
      `rowCount must be an integer between 1 and ${contract.rowCount}`,
    );
  }
  for (const [name, value] of [
    ["closedEvery", contract.closedEvery],
    ["contentEvery", contract.contentEvery],
    ["crossBrowserLogicalPages", contract.crossBrowserLogicalPages],
    [
      "duplicatePhysicalInstanceEvery",
      contract.duplicatePhysicalInstanceEvery,
    ],
    ["topicCount", contract.topicCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (contract.browsers.length === 0) {
    throw new Error("browsers must contain at least one browser name");
  }

  const timestamp = "2026-01-01T00:00:00.000Z";
  const database = openDatabase(databasePath, {
    migrationClock: () => new Date(timestamp),
    maximumMigrationVersion:
      options.maximumMigrationVersion ?? g0BaselineSchemaVersion,
  });
  const { connection } = database;
  const logicalPageCatalog = database.schemaVersion < 18
    ? undefined
    : createLogicalPageCatalog(
        connection,
        () => new Date(timestamp),
      );
  const fixtureNamespace = baselineContractHash(contract).slice(0, 12);

  try {
    connection.pragma("synchronous = OFF");
    connection.pragma("journal_mode = MEMORY");
    const insertTopic = connection.prepare(
      "INSERT INTO tags (name, color) VALUES (?, ?)",
    );
    const insertTab = connection.prepare(database.schemaVersion < 18 ? `
      INSERT INTO tabs (
        id, url, url_normalized, title, browser, window_id, tab_index,
        status, importance, is_open, first_seen_at, last_seen_at, closed_at
      ) VALUES (
        @id, @url, @url, @title, @browser, @windowId, @tabIndex,
        @status, @importance, @isOpen, @firstSeenAt, @lastSeenAt, @closedAt
      )
    ` : `
      INSERT INTO tabs (
        id, url, url_normalized, title, browser, window_id, tab_index,
        status, importance, is_open, first_seen_at, last_seen_at, closed_at,
        logical_page_id
      ) VALUES (
        @id, @url, @url, @title, @browser, @windowId, @tabIndex,
        @status, @importance, @isOpen, @firstSeenAt, @lastSeenAt, @closedAt,
        @logicalPageId
      )
    `);
    const insertContent = connection.prepare(`
      INSERT INTO contents (
        tab_id, text, html_excerpt, summary, extracted_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const insertTag = connection.prepare(
      "INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES (?, ?, 'user')",
    );
    const insertInstance = connection.prepare(`
      INSERT INTO tab_instances (
        tab_id, installation_id, instance_key, browser_session_id,
        browser_tab_id, url, title, window_id, tab_index, active, pinned,
        audible, muted, discarded, last_accessed, first_seen_at, last_seen_at
      ) VALUES (
        @tabId, @installationId, @instanceKey, @browserSessionId,
        @browserTabId, @url, @title, @windowId, @tabIndex, @active, @pinned,
        0, 0, 0, @lastAccessed, @firstSeenAt, @lastSeenAt
      )
    `);
    const insertInstanceActivity = connection.prepare(`
      INSERT INTO tab_activity_totals (
        installation_id, browser_session_id, browser_tab_id,
        foreground_ms, engaged_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPageActivity = connection.prepare(`
      INSERT INTO tab_page_activity_totals (
        browser, url_normalized, url, foreground_ms, engaged_ms,
        first_activity_at, last_activity_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    connection.transaction(() => {
      const topicIds: number[] = [];
      for (let index = 0; index < contract.topicCount; index += 1) {
        const result = insertTopic.run(
          `Baseline ${fixtureNamespace} topic ${String(index).padStart(2, "0")}`,
          `#${(0x334455 + index * 0x010101).toString(16).slice(-6)}`,
        );
        topicIds.push(Number(result.lastInsertRowid));
      }

      const browsers = contract.browsers;
      const logicalPageCount = Math.min(
        contract.crossBrowserLogicalPages,
        Math.max(1, Math.ceil(rowCount / browsers.length)),
      );
      for (let index = 0; index < rowCount; index += 1) {
        const id = index + 1;
        const browserGroup = Math.floor(index / logicalPageCount);
        const browser = browsers[Math.min(browserGroup, browsers.length - 1)]!;
        const logicalPageIndex = index % logicalPageCount;
        const url = `https://site-${logicalPageIndex % 50}.example/${fixtureNamespace}/baseline/${logicalPageIndex}`;
        const title = `Baseline page ${String(logicalPageIndex).padStart(4, "0")} ${browser}`;
        const isOpen = index % contract.closedEvery !== 0;
        const status = ["inbox", "in_progress", "done", "archived"][
          index % 4
        ]!;
        const windowId = (index % 25) + 1;
        const tabIndex = index % 100;
        const closedAt = isOpen ? null : timestamp;
        const logicalPage = logicalPageCatalog?.resolve({
          observedAt: timestamp,
          url,
          urlNormalized: url,
        });

        insertTab.run({
          browser,
          closedAt,
          firstSeenAt: timestamp,
          id,
          importance: index % 4,
          isOpen: isOpen ? 1 : 0,
          lastSeenAt: timestamp,
          ...(logicalPage === undefined
            ? {}
            : { logicalPageId: logicalPage.id }),
          status,
          tabIndex,
          title,
          url,
          windowId,
        });

        if (index % contract.contentEvery === 0) {
          insertContent.run(
            id,
            `Deterministic baseline content for logical page ${logicalPageIndex}.`,
            `<p>Baseline ${logicalPageIndex}</p>`,
            `Baseline summary ${logicalPageIndex}`,
            timestamp,
          );
        }
        insertTag.run(id, topicIds[index % topicIds.length]!);

        const foregroundMs = (index + 1) * 10;
        const engagedMs = Math.floor(foregroundMs / 2);
        insertPageActivity.run(
          browser,
          url,
          url,
          foregroundMs,
          engagedMs,
          timestamp,
          timestamp,
          timestamp,
        );

        if (isOpen) {
          const installationId = `baseline-${fixtureNamespace}-${browser}`;
          const browserSessionId = `baseline-${fixtureNamespace}-session-${browser}`;
          const primaryBrowserTabId = id * 2;
          insertInstance.run({
            active: index % 97 === 0 ? 1 : 0,
            browserSessionId,
            browserTabId: primaryBrowserTabId,
            firstSeenAt: timestamp,
            installationId,
            instanceKey: `tab:${primaryBrowserTabId}`,
            lastAccessed: 1_767_225_600_000 + index,
            lastSeenAt: timestamp,
            pinned: index % 31 === 0 ? 1 : 0,
            tabId: id,
            tabIndex,
            title,
            url,
            windowId,
          });
          insertInstanceActivity.run(
            installationId,
            browserSessionId,
            primaryBrowserTabId,
            foregroundMs,
            engagedMs,
            timestamp,
          );

          if (index % contract.duplicatePhysicalInstanceEvery === 0) {
            const duplicateBrowserTabId = primaryBrowserTabId + 1;
            insertInstance.run({
              active: 0,
              browserSessionId,
              browserTabId: duplicateBrowserTabId,
              firstSeenAt: timestamp,
              installationId,
              instanceKey: `tab:${duplicateBrowserTabId}`,
              lastAccessed: 1_767_225_600_000 + index + 1,
              lastSeenAt: timestamp,
              pinned: 0,
              tabId: id,
              tabIndex: tabIndex + 1,
              title,
              url,
              windowId,
            });
            insertInstanceActivity.run(
              installationId,
              browserSessionId,
              duplicateBrowserTabId,
              foregroundMs,
              engagedMs,
              timestamp,
            );
          }
        }
      }

      if (database.schemaVersion >= 18) connection.exec(`
        INSERT INTO logical_page_importance_migration_audit (
          logical_page_id,
          legacy_values_json,
          suggested_value,
          resolution_state,
          created_at,
          reviewed_at
        )
        SELECT
          logical_pages.id,
          (
            SELECT json_group_array(
              json_object(
                'tabId', legacy.tab_id,
                'browser', legacy.browser,
                'value', legacy.importance
              )
            )
            FROM (
              SELECT
                tabs.id AS tab_id,
                tabs.browser,
                tabs.importance
              FROM tabs
              WHERE tabs.logical_page_id = logical_pages.id
              ORDER BY tabs.browser ASC, tabs.id ASC
            ) AS legacy
          ),
          CASE
            WHEN MIN(tabs.importance) = MAX(tabs.importance)
              AND MIN(tabs.importance) BETWEEN 1 AND 3
            THEN MIN(tabs.importance)
            ELSE NULL
          END,
          CASE
            WHEN MIN(tabs.importance) = MAX(tabs.importance)
              AND MIN(tabs.importance) = 0
            THEN 'confirmed'
            WHEN MIN(tabs.importance) = MAX(tabs.importance)
            THEN 'legacy_unknown'
            ELSE 'conflict'
          END,
          logical_pages.updated_at,
          NULL
        FROM logical_pages
        JOIN tabs ON tabs.logical_page_id = logical_pages.id
        GROUP BY logical_pages.id
        ORDER BY logical_pages.id
      `);
    })();
  } finally {
    database.close();
  }

  return inspectDatabaseBaseline(databasePath);
}
