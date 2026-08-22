import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createLogicalPageCatalog } from "../src/logical-page-catalog.js";
import { createPriorityAssessmentCoordinator } from
  "../src/priority-assessment-coordinator.js";
import { createPriorityEngine } from "../src/priority-engine.js";
import {
  createPriorityFeatureCatalog,
  priorityProjectionAggregateName,
  type PriorityFeatureCatalog,
} from "../src/priority-feature-catalog.js";
import { projectPriorityListSubjects } from "../src/priority-list-ordering.js";
import { createResourceReadCatalog } from "../src/resource-read-catalog.js";
import { createTabCatalog } from "../src/tab-catalog.js";
import type { ListTabsInput } from "../src/tab-catalog.js";
import { createTabInstanceCatalog } from "../src/tab-instance-catalog.js";

const anchor = "2026-08-13T12:00:00.000Z";

interface SqlExecution {
  readonly sql: string;
  readonly args: readonly unknown[];
}

function captureProjectionAggregate(connection: Database.Database): {
  readonly connection: Database.Database;
  starts(): number;
  enable(): void;
} {
  let starts = 0;
  let enabled = false;
  let proxy: Database.Database;
  proxy = new Proxy(connection, {
    get(target, property) {
      if (property !== "aggregate") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, options: Record<string, unknown>) => {
        const start = options.start;
        const instrumented = name === priorityProjectionAggregateName &&
            typeof start === "function"
          ? {
              ...options,
              start: (...args: unknown[]) => {
                if (enabled) starts += 1;
                return (start as (...values: unknown[]) => unknown)(...args);
              },
            }
          : options;
        (target.aggregate as unknown as (
          aggregateName: string,
          aggregateOptions: Record<string, unknown>,
        ) => unknown)(name, instrumented);
        return proxy;
      };
    },
  }) as Database.Database;
  return { connection: proxy, starts: () => starts, enable: () => { enabled = true; } };
}

function captureConnection(connection: Database.Database): {
  readonly connection: Database.Database;
  readonly executions: SqlExecution[];
  enable(): void;
} {
  const executions: SqlExecution[] = [];
  let enabled = false;
  const proxy = new Proxy(connection, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        let statementProxy: Database.Statement;
        statementProxy = new Proxy(statement, {
          get(statementTarget, statementProperty) {
            const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
            if (statementProperty === "all" || statementProperty === "get" ||
                statementProperty === "run" || statementProperty === "iterate") {
              return (...args: unknown[]) => {
                if (enabled) executions.push({ sql, args });
                return (value as (...values: unknown[]) => unknown)
                  .apply(statementTarget, args);
              };
            }
            if (statementProperty === "pluck" || statementProperty === "raw" ||
                statementProperty === "expand" || statementProperty === "safeIntegers") {
              return (...args: unknown[]) => {
                (value as (...values: unknown[]) => unknown).apply(statementTarget, args);
                return statementProxy;
              };
            }
            return typeof value === "function" ? value.bind(statementTarget) : value;
          },
        }) as Database.Statement;
        return statementProxy;
      };
    },
  }) as Database.Database;
  return { connection: proxy, executions, enable: () => { enabled = true; } };
}

function coordinator(
  connection: Database.Database,
  catalog: PriorityFeatureCatalog,
  ledgerConnection = connection,
) {
  let token = 0;
  return createPriorityAssessmentCoordinator({
    connection,
    catalog,
    clock: () => new Date(anchor),
    writerEnabled: false,
    createLedger: (guards) => createAiJobLedger(ledgerConnection, {
      clock: () => new Date(anchor),
      kindAvailable: () => false,
      token: () => `p60-lease-${String(++token).padStart(4, "0")}`,
      guards,
    }),
  });
}

function seedScaledCorpus(connection: Database.Database): void {
  connection.exec(`
    WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 400
    )
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) SELECT value, 'https://scaled.test/' || value, 'https://scaled.test/' || value,
      'https://scaled.test/' || value, '${anchor}', '${anchor}' FROM numbers;

    WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1200
    )
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) SELECT value, 'https://scaled.test/' || (((value - 1) % 400) + 1),
      'https://scaled.test/' || (((value - 1) % 400) + 1), 'Scaled ' || value,
      CASE (value - 1) / 400 WHEN 0 THEN 'chrome' WHEN 1 THEN 'edge' ELSE 'yandex' END,
      'inbox', 0, 1, '${anchor}', '${anchor}', ((value - 1) % 400) + 1 FROM numbers;

    WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 120
    )
    INSERT INTO resources (id, resource_key, created_at)
      SELECT 10000 + value, 'website:scaled-' || value, '${anchor}' FROM numbers;
    WITH RECURSIVE numbers(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 120
    )
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) SELECT 20000 + value, 10000 + value, 1, 'Scaled ' || value, 'website', 'public',
      'active', 'system', 'derived', '${anchor}' FROM numbers;
    INSERT INTO resource_heads (resource_id, event_id)
      SELECT resource_id, id FROM resource_events WHERE id BETWEEN 20001 AND 20120;
    INSERT INTO resource_preferences (
      resource_id, user_evaluation, recorded_by, record_method, updated_at
    ) SELECT id, NULL, NULL, NULL, '${anchor}' FROM resources
      WHERE id BETWEEN 10001 AND 10120;
  `);
}

function seedSemanticCorpus(connection: Database.Database): void {
  connection.exec(`
    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) SELECT id, 'https://semantic.test/' || id, 'https://semantic.test/' || id,
      'https://semantic.test/' || id, '${anchor}', '${anchor}' FROM ids;
    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) SELECT id, 'https://semantic.test/' || id, 'https://semantic.test/' || id,
      'Semantic ' || id, 'chrome', 'inbox', 0, 1, '${anchor}', '${anchor}', id FROM ids;
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
      SELECT id, 'captured', '${anchor}', 1 FROM tabs WHERE id BETWEEN 1 AND 5;

    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO resources (id, resource_key, created_at)
      SELECT 1000 + id, 'website:semantic-' || id, '${anchor}' FROM ids;
    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) SELECT 2000 + id, 1000 + id, 1, 'Semantic ' || id, 'website', 'public',
      'active', 'system', 'derived', '${anchor}' FROM ids;
    INSERT INTO resource_heads (resource_id, event_id)
      SELECT resource_id, id FROM resource_events WHERE id BETWEEN 2001 AND 2005;
    INSERT INTO resource_preferences (
      resource_id, user_evaluation, recorded_by, record_method, updated_at
    ) SELECT id, NULL, NULL, NULL, '${anchor}' FROM resources
      WHERE id BETWEEN 1001 AND 1005;

    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) SELECT 3000 + id, id, 'assigned', 1000 + id, 'registrable_domain',
      'system', 'derived', 'assignment-' || id, '${anchor}' FROM ids;
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      SELECT logical_page_id, id FROM logical_page_resource_assignments
      WHERE id BETWEEN 3001 AND 3005;
    WITH ids(id) AS (VALUES (1),(2),(3),(4),(5))
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      research_exclusion_reason, created_at
    ) SELECT 4000 + id, id, 'unmatched', 'weak_sensitive_signal', NULL, NULL,
      '[]', 'resolution-' || id, 0, 'weak_sensitive_signal', '${anchor}' FROM ids;
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
      SELECT logical_page_id, id FROM resource_resolution_events
      WHERE id BETWEEN 4001 AND 4005;
  `);
}

function seedSearchCorpus(connection: Database.Database): void {
  const rows = [
    [1, "https://search.test/one", "CanonicalTitleNeedle", "chrome", "inbox", 1],
    [2, "https://canonical-url-needle.test/two", "Plain two", "chrome", "inbox", 1],
    [3, "https://search.test/three", "Plain three", "chrome", "inbox", 1],
    [4, "https://search.test/four", "Plain four", "chrome", "inbox", 1],
    [5, "https://search.test/five", "Plain five", "chrome", "inbox", 1],
    [6, "https://search.test/six", "Plain six", "chrome", "inbox", 1],
    [7, "https://search.test/seven", "TrashedNeedle", "chrome", "inbox", 0],
    [8, "https://search.test/eight", "CombinedNeedle", "edge", "done", 0],
    [9, "https://search.test/nine", "SecondNeedle", "chrome", "inbox", 1],
    [10, "https://search.test/ten", "BoundaryNeedle", "chrome", "inbox", 1],
    [11, "https://search.test/eleven", "BoundaryNeedle", "chrome", "inbox", 1],
  ] as const;
  const page = connection.prepare(`INSERT INTO logical_pages (
    id,identity_key,url_normalized,representative_url,created_at,updated_at
  ) VALUES (?,?,?,?,?,?)`);
  const tab = connection.prepare(`INSERT INTO tabs (
    id,url,url_normalized,title,browser,status,importance,is_open,
    first_seen_at,last_seen_at,logical_page_id
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, url, title, browser, status, isOpen] of rows) {
    page.run(id, url, url, url, anchor, anchor);
    tab.run(id, url, url, title, browser, status, 0, isOpen, anchor, anchor, id);
  }
  connection.exec(`
    INSERT INTO tab_instances (
      id,tab_id,installation_id,instance_key,browser_tab_id,url,title,
      window_id,tab_index,active,pinned,first_seen_at,last_seen_at
    ) VALUES
      (31,3,'search-install','search-three',3,'https://search.test/three',
        'PhysicalTitleNeedle',1,0,1,0,'${anchor}','${anchor}'),
      (41,4,'search-install','search-four',4,'https://physical-url-needle.test/four',
        'Plain physical four',1,1,1,0,'${anchor}','${anchor}');
    INSERT INTO contents(tab_id,text,extracted_at,content_revision)
      VALUES (5,'ContentNeedle body','${anchor}',1);
    INSERT INTO context_entries (
      id,logical_page_id,kind,body,actor,method,visibility,source_fingerprint,
      state,operation,revision,idempotency_key,created_at
    ) VALUES (61,6,'purpose','ContextNeedle body','agent','rule','local_only',
      'search-context-fingerprint','active','append',1,'search-context','${anchor}');
    INSERT INTO context_entry_reviews (
      id,context_entry_id,verdict,reviewed_by,review_method,idempotency_key,created_at
    ) VALUES (62,61,'accepted','user','manual','search-context-review','${anchor}');
    INSERT INTO page_retention (
      tab_id,state,decided_by,decided_at,trashed_at,purge_at
    ) VALUES (7,'trashed','user','${anchor}','${anchor}','2026-09-13T12:00:00.000Z');
    INSERT INTO logical_page_preferences(
      logical_page_id,user_importance,recorded_by,record_method,
      importance_updated_at,updated_at
    ) VALUES (10,3,'user','manual','${anchor}','${anchor}');
  `);
}

function tabListInput(overrides: Partial<ListTabsInput>): ListTabsInput {
  return {
    browser: undefined,
    duplicatesOnly: false,
    isOpen: undefined,
    q: undefined,
    status: undefined,
    importance: undefined,
    tag: undefined,
    resourceId: undefined,
    page: 1,
    pageSize: 20,
    sortBy: "title",
    sortDirection: "asc",
    ...overrides,
  };
}

function insertCurrentExclusion(
  connection: Database.Database,
  type: "page" | "resource",
  id: number,
  fingerprint: string,
  revision = 1,
): void {
  const table = type === "page" ? "priority_exclusions" :
    "resource_priority_exclusions";
  const column = type === "page" ? "logical_page_id" : "resource_id";
  connection.prepare(`INSERT INTO ${table} (
    ${column}, reason, detail_json, ruleset_id, ruleset_version,
    feature_fingerprint, revision, evaluated_at
  ) VALUES (?, 'policy_excluded', '{}', 1, 1, ?, ?, ?)`)
    .run(id, fingerprint, revision, anchor);
}

describe("P60 priority-list performance acceptance", () => {
  it("materializes q filters once without changing public/local search or priority ordering", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(anchor) });
    try {
      seedSearchCorpus(database.connection);
      const capture = captureConnection(database.connection);
      const reader = {
        readBatch() { throw new Error("unexpected readBatch"); },
        readListProjection(_type: "page" | "resource", ids: readonly number[]) {
          return ids.map((subjectId) => ({
            subjectId,
            bandRank: subjectId === 11 ? 2 as const : 1 as const,
            agentScore: subjectId === 11 ? 0.99 : 0.1,
            needsReview: false,
          }));
        },
      };
      const tabs = createTabCatalog(
        capture.connection,
        createTabInstanceCatalog(database.connection),
        createLogicalPageCatalog(database.connection, () => new Date(anchor)),
        true,
        () => new Date(anchor),
        { readLocal: () => ({ preview: null }) },
        () => reader,
      );
      const ids = (q: string) => tabs.listTabs(tabListInput({ q })).items.map(({ id }) => id);
      const localIds = (q: string) =>
        tabs.listLocalTabs(tabListInput({ q })).items.map(({ id }) => id);

      expect(ids("CanonicalTitleNeedle")).toEqual([1]);
      expect(ids("canonical-url-needle")).toEqual([2]);
      expect(ids("PhysicalTitleNeedle")).toEqual([3]);
      expect(ids("physical-url-needle")).toEqual([4]);
      expect(ids("ContentNeedle")).toEqual([5]);
      expect(ids("ContextNeedle")).toEqual([]);
      expect(localIds("ContextNeedle")).toEqual([6]);
      expect(ids("TrashedNeedle")).toEqual([]);
      expect(tabs.listTabs(tabListInput({
        q: "CombinedNeedle", browser: "edge", status: "done", isOpen: false,
      })).items.map(({ id }) => id)).toEqual([8]);
      expect(tabs.listTabs(tabListInput({
        q: "CombinedNeedle", browser: "chrome", status: "done", isOpen: false,
      })).items).toEqual([]);

      expect(ids("CanonicalTitleNeedle")).toEqual([1]);
      expect(ids("SecondNeedle")).toEqual([9]);
      expect(ids("CanonicalTitleNeedle")).toEqual([1]);

      const beyond = tabs.listTabs(tabListInput({
        q: "BoundaryNeedle", page: 3, pageSize: 1,
      }));
      expect(beyond).toMatchObject({ items: [], total: 2, page: 3, pageSize: 1 });
      expect(tabs.listTabs(tabListInput({
        q: "BoundaryNeedle", priorityMode: "ai",
      })).items.map(({ id }) => id)).toEqual([11, 10]);
      expect(tabs.listTabs(tabListInput({
        q: "BoundaryNeedle", priorityMode: "recommended",
      })).items.map(({ id }) => id)).toEqual([10, 11]);

      capture.enable();
      expect(ids("CanonicalTitleNeedle")).toEqual([1]);
      const expensive = capture.executions.filter(({ sql }) =>
        /contents_fts\s+MATCH/i.test(sql) || /tabhub_contains_normalized\(tabs\./i.test(sql));
      expect(expensive, "the full q predicate must execute exactly once").toHaveLength(1);
      const finalReads = capture.executions.filter(({ sql }) =>
        /SELECT COUNT\(\*\) AS total FROM tabs/i.test(sql) ||
        /SELECT\s+tabs\.id,[\s\S]*FROM tabs/i.test(sql));
      expect(finalReads).toHaveLength(2);
      for (const execution of finalReads) {
        expect(execution.sql).toMatch(/temp\.tab_list_search_base/);
        expect(execution.sql).not.toMatch(/contents_fts\s+MATCH|tabhub_contains_normalized/i);
        const plan = database.connection.prepare(`EXPLAIN QUERY PLAN ${execution.sql}`)
          .all(...execution.args) as Array<{ detail: string }>;
        expect(plan.some(({ detail }) => /tab_list_search_base/i.test(detail))).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  it("uses bounded SQL for small and large missing outcomes", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(anchor) });
    try {
      seedScaledCorpus(database.connection);
      const projection = captureProjectionAggregate(database.connection);
      const capture = captureConnection(projection.connection);
      const canonicalCatalog = createPriorityFeatureCatalog(capture.connection);
      let readBatchCalls = 0;
      const catalog: PriorityFeatureCatalog = {
        ...canonicalCatalog,
        readBatch(subjects, at) {
          readBatchCalls += 1;
          return canonicalCatalog.readBatch(subjects, at);
        },
      };
      const reader = coordinator(capture.connection, catalog, database.connection);
      projection.enable();
      capture.enable();

      const expected = (ids: readonly number[]) => ids.map((subjectId) => ({
          subjectId,
          bandRank: 0,
          agentScore: -1,
          needsReview: false,
        }));
      const smallIds = [4, 1, 3, 2];
      expect(reader.readListProjection("page", smallIds, anchor)).toEqual(expected(smallIds));
      expect(readBatchCalls).toBe(0);
      expect(() => reader.readListProjection("page", [1, 1], anchor))
        .toThrow(/unique positive integers/);
      expect(() => reader.readListProjection("page", [0], anchor))
        .toThrow(/unique positive integers/);
      const smallSqlCount = capture.executions.length;
      expect(smallSqlCount).toBeLessThanOrEqual(4);
      const smallProjectionStarts = projection.starts();

      const largeIds = Array.from({ length: 400 }, (_, index) => 400 - index);
      expect(reader.readListProjection("page", largeIds, anchor)).toEqual(expected(largeIds));
      expect(readBatchCalls, "large list projection must not enter the per-100 fallback")
        .toBe(0);

      expect(projection.starts(), "missing outcomes cannot produce ranked rows")
        .toBe(smallProjectionStarts);
      expect(smallProjectionStarts).toBe(0);
      expect(capture.executions.length - smallSqlCount,
        "SQL statement count must remain independent of requested subject count")
        .toBeLessThanOrEqual(4);
    } finally {
      database.close();
    }
  });

  it("keeps scaled AI/recommended/review joins out of rows x JSON-projection plans", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(anchor) });
    try {
      seedScaledCorpus(database.connection);
      const capture = captureConnection(database.connection);
      const canonicalCatalog = createPriorityFeatureCatalog(database.connection);
      let readBatchCalls = 0;
      const reader = coordinator(database.connection, {
        ...canonicalCatalog,
        readBatch(subjects, at) {
          readBatchCalls += 1;
          return canonicalCatalog.readBatch(subjects, at);
        },
      });
      const clock = () => new Date(anchor);
      const tabs = createTabCatalog(
        capture.connection,
        createTabInstanceCatalog(database.connection),
        createLogicalPageCatalog(database.connection, clock),
        true,
        clock,
        undefined,
        () => reader,
      );
      const resources = createResourceReadCatalog(capture.connection, () => reader, clock);
      capture.enable();

      const tabBase = {
        browser: undefined, duplicatesOnly: false, isOpen: undefined, q: undefined,
        status: undefined, importance: undefined, tag: undefined, resourceId: undefined,
        page: 1, pageSize: 20, sortBy: undefined, sortDirection: "asc" as const,
      };
      tabs.listTabs({ ...tabBase, priorityMode: "ai" });
      tabs.listTabs({ ...tabBase, priorityMode: "recommended" });
      tabs.listTabs({ ...tabBase, needsReview: true });

      const resourceBase = {
        q: undefined, kind: undefined, accessClass: undefined,
        lifecycleState: "active" as const, browser: undefined, status: undefined,
        importance: undefined, tag: undefined, page: 1, pageSize: 20,
        sort_by: "name" as const, sort_direction: "asc" as const,
      };
      resources.list({ ...resourceBase, priority_mode: "ai" });
      resources.list({ ...resourceBase, priority_mode: "recommended" });
      resources.list({ ...resourceBase, needs_review: true });

      expect(readBatchCalls, "scaled list projection must not enter the per-100 fallback")
        .toBe(0);

      const listExecutions = capture.executions.filter(({ sql }) =>
        /\bSELECT\b/i.test(sql) && (/\bFROM tabs\b/i.test(sql) ||
          /\bresource_rows\b/i.test(sql)));
      expect(listExecutions.length).toBeGreaterThanOrEqual(12);
      const directJsonJoins = listExecutions.filter(({ sql }) =>
        /LEFT JOIN\s+json_each\(\?\)/i.test(sql));
      expect(directJsonJoins).toEqual([]);

      const nestedVirtualScans = listExecutions.flatMap(({ sql, args }) => {
        const plan = database.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...args) as Array<{ detail: string }>;
        return plan.filter(({ detail }) =>
          /SCAN .*VIRTUAL TABLE.*LEFT-JOIN/i.test(detail));
      });
      expect(nestedVirtualScans).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("matches canonical page/Resource currentness and fails closed on corrupt XOR", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(anchor) });
    try {
      seedSemanticCorpus(database.connection);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const engine = createPriorityEngine(database.connection, { now: () => anchor });
      const reader = coordinator(database.connection, catalog);
      for (const subject of [
        { type: "page" as const, logicalPageId: 1 },
        { type: "page" as const, logicalPageId: 2 },
        { type: "page" as const, logicalPageId: 5 },
        { type: "resource" as const, resourceId: 1001 },
        { type: "resource" as const, resourceId: 1002 },
        { type: "resource" as const, resourceId: 1005 },
      ]) {
        const projected = catalog.read(subject, anchor);
        const candidateIneligible = subject.type === "page"
          ? subject.logicalPageId === 5
          : subject.resourceId === 1005;
        engine.assess([{ subject, features: projected.features,
          eligibility: projected.eligibility,
          assessmentMethod: candidateIneligible ? "model" : "rule",
          ...(candidateIneligible ? {
            modelProvenance: {
              provider: "test-provider",
              name: "test-model",
              promptVersion: "test-prompt-v1",
            },
          } : {}),
        }],
        projected.ruleset);
      }
      for (const [type, id] of [
        ["page", 3], ["resource", 1003],
      ] as const) {
        const subject = type === "page"
          ? { type, logicalPageId: id }
          : { type, resourceId: id };
        insertCurrentExclusion(database.connection, type, id,
          catalog.read(subject, anchor).featureFingerprint);
      }

      const pageIds = [1, 2, 3, 4];
      const resourceIds = [1001, 1002, 1003, 1004];
      const pageBefore = reader.readListProjection("page", pageIds, anchor);
      const resourceBefore = reader.readListProjection("resource", resourceIds, anchor);
      expect(pageBefore).toEqual(projectPriorityListSubjects(catalog, "page", pageIds, anchor));
      expect(resourceBefore).toEqual(
        projectPriorityListSubjects(catalog, "resource", resourceIds, anchor),
      );
      expect(pageBefore[0]!.bandRank).toBeGreaterThan(0);
      expect(pageBefore[1]!.bandRank).toBeGreaterThan(0);
      expect(pageBefore.slice(2)).toEqual([
        { subjectId: 3, bandRank: 0, agentScore: -1, needsReview: false },
        { subjectId: 4, bandRank: 0, agentScore: -1, needsReview: false },
      ]);
      expect(resourceBefore[0]!.bandRank).toBeGreaterThan(0);
      expect(resourceBefore[1]!.bandRank).toBeGreaterThan(0);
      expect(resourceBefore.slice(2)).toEqual([
        { subjectId: 1003, bandRank: 0, agentScore: -1, needsReview: false },
        { subjectId: 1004, bandRank: 0, agentScore: -1, needsReview: false },
      ]);

      database.connection.prepare("UPDATE tabs SET is_open = 0 WHERE id = 2").run();
      for (const [type, ids, staleIndex] of [
        ["page", pageIds, 1], ["resource", resourceIds, 1],
      ] as const) {
        const actual = reader.readListProjection(type, ids, anchor);
        expect(actual).toEqual(projectPriorityListSubjects(catalog, type, ids, anchor));
        expect(actual[staleIndex]).toEqual({
          subjectId: ids[staleIndex], bandRank: 0, agentScore: -1, needsReview: false,
        });
      }

      database.connection.exec(`
        DROP TRIGGER priority_exclusions_insert_guard;
        DROP TRIGGER resource_priority_exclusions_insert_guard;
      `);
      insertCurrentExclusion(database.connection, "page", 2,
        catalog.read({ type: "page", logicalPageId: 2 }, anchor).featureFingerprint, 2);
      insertCurrentExclusion(database.connection, "resource", 1002,
        catalog.read({ type: "resource", resourceId: 1002 }, anchor).featureFingerprint, 2);
      for (const [type, id] of [["page", 2], ["resource", 1002]] as const) {
        expect(() => projectPriorityListSubjects(catalog, type, [id], anchor))
          .toThrow(/Corrupt priority XOR/);
        expect(() => reader.readListProjection(type, [id], anchor))
          .toThrow(/Corrupt priority XOR/);
      }

      insertCurrentExclusion(database.connection, "page", 5,
        catalog.read({ type: "page", logicalPageId: 5 }, anchor).featureFingerprint, 2);
      insertCurrentExclusion(database.connection, "resource", 1005,
        catalog.read({ type: "resource", resourceId: 1005 }, anchor).featureFingerprint, 2);
      for (const [type, id] of [["page", 5], ["resource", 1005]] as const) {
        expect(() => projectPriorityListSubjects(catalog, type, [id], anchor))
          .toThrow(/Corrupt priority XOR/);
        expect(() => reader.readListProjection(type, [id], anchor))
          .toThrow(/Corrupt priority XOR/);
      }
    } finally {
      database.close();
    }
  });
});
