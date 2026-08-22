import { createHash } from "node:crypto";

import {
  researchSelectionFingerprintPayload,
  type ResearchTarget,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createPriorityEngine } from "../src/priority-engine.js";
import {
  createPriorityFeatureCatalog,
  priorityProjectionFactsFromValues,
  reducePriorityProjectionFacts,
} from "../src/priority-feature-catalog.js";
import {
  buildCurrentResearchProjection,
  createResearchStore,
  researchParentAvailability,
} from "../src/research-store.js";
import { createResearchWorkflow } from "../src/research-workflow.js";

const anchor = "2026-08-13T12:00:00.000Z";
const researchBudget = {
  maxSteps: 10,
  maxTokens: 4_000,
  maxCostUsd: 1,
  maxWallTimeMs: 60_000,
} as const;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function fixture() {
  const database = openDatabase(":memory:", {
    migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
  });
  database.connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      501, 'https://priority.test/page', 'https://priority.test/page',
      'https://priority.test/page', '2026-07-01T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z'
    );
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES
      (601, 'https://priority.test/page', 'https://priority.test/page', 'Chrome copy',
       'chrome', 'in_progress', 3, 1, '2026-07-01T00:00:00.000Z',
       '2026-08-12T00:00:00.000Z', 501),
      (602, 'https://priority.test/page', 'https://priority.test/page', 'Edge copy',
       'edge', 'inbox', 1, 1, '2026-07-02T00:00:00.000Z',
       '2026-08-11T00:00:00.000Z', 501);
    INSERT INTO tab_instances (
      tab_id, installation_id, instance_key, browser_tab_id, url, title,
      window_id, tab_index, active, pinned, first_seen_at, last_seen_at,
      browser_session_id
    ) VALUES
      (601, 'install-a', 'a', 1, 'https://priority.test/page', 'Chrome copy',
       1, 0, 1, 1, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
       'session-a'),
      (602, 'install-b', 'b', 2, 'https://priority.test/page', 'Edge copy',
       2, 0, 0, 0, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z',
       'session-b');
    INSERT INTO tags (id, name, parent_id) VALUES
      (701, 'Current projects', NULL), (702, 'TabHub', 701);
    INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES
      (601, 702, 'user'), (602, 702, 'user');
    INSERT INTO saved_workspaces (id, name, created_at, updated_at)
    VALUES (801, 'Research', '${anchor}', '${anchor}');
    INSERT INTO saved_workspace_items (
      workspace_id, ordinal, source_instance_id, canonical_tab_id, browser,
      installation_id, url, window_id, tab_index, active, pinned, audible,
      muted, discarded
    ) VALUES
      (801, 0, 1, 601, 'chrome', 'install-a', 'https://priority.test/page',
       1, 0, 1, 1, 0, 0, 0),
      (801, 1, 2, 602, 'edge', 'install-b', 'https://priority.test/page',
       2, 0, 1, 0, 0, 0, 0);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (601, 'captured', '${anchor}', 1);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      research_exclusion_reason, created_at
    ) VALUES (
      901, 501, 'unmatched', 'weak_sensitive_signal', NULL, NULL, '[]',
      'resolution-fingerprint', 0, 'weak_sensitive_signal', '${anchor}'
    );
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (501, 901);
    UPDATE activity_daily_writer_state
    SET state = 'enabled', coverage_started_at = '2026-07-01T00:00:00.000Z',
      updated_at = '2026-07-01T00:00:00.000Z'
    WHERE singleton_id = 1;
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (501, '2026-08-12', 2000, 500, '${anchor}');
  `);
  return database;
}

function createFreshResearchPublisher(database: ReturnType<typeof fixture>) {
  let tokenSequence = 0;
  const research = createResearchStore(database.connection, { clock: () => new Date(anchor) });
  const ledger = createAiJobLedger(database.connection, {
    clock: () => new Date(anchor),
    token: () => `priority-research-token-${++tokenSequence}`,
    kindAvailable: () => true,
    research,
  });
  const workflow = createResearchWorkflow({
    current: (request) => buildCurrentResearchProjection(database.connection, request,
      { clock: () => new Date(anchor) }),
    parentAvailability: (target, reportId) =>
      researchParentAvailability(database.connection, target, reportId),
    submitResearch: (task, approval) => ledger.submitResearch(task, approval),
    cancelResearch: (jobId) => ledger.cancel(
      "resource_research",
      Number(jobId.slice("resource_research:".length)),
    ),
    redactResearch: (request) => research.redactResearch(request),
  });

  return (target: ResearchTarget, idempotencyKey: string): number => {
    const request = {
      version: 1 as const,
      target,
      question: "What is useful here?",
      includeShareableContext: false,
      maxIncludedSources: 100,
      parentReportId: null,
      budget: researchBudget,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: [] as string[],
        sensitiveOriginDigests: [] as string[],
      },
    };
    const preflight = workflow.preflight(request);
    if (preflight.approvalFingerprint === null) {
      throw new Error("Fixture expected a fully confirmed public research corpus");
    }
    workflow.requestRun({
      ...request,
      estimate: preflight.estimate,
      approvalFingerprint: preflight.approvalFingerprint,
      idempotencyKey,
    });
    const run = database.connection.prepare(`
      SELECT id, target_logical_page_id, target_resource_id, selection_fingerprint,
        target_key, approval_fingerprint
      FROM research_runs ORDER BY id DESC LIMIT 1
    `).get() as {
      id: number;
      target_logical_page_id: number | null;
      target_resource_id: number | null;
      selection_fingerprint: string | null;
      target_key: string;
      approval_fingerprint: string;
    };
    const version = Number(database.connection.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 FROM research_reports WHERE target_key = ?
    `).pluck().get(run.target_key));
    const coverageJson = JSON.stringify(preflight.coverage);
    const reportId = Number(database.connection.prepare(`
      INSERT INTO research_reports (
        run_id, target_logical_page_id, target_resource_id, selection_fingerprint,
        target_key, version, parent_report_id, publish_status, coverage_json,
        coverage_fingerprint, provenance_json, input_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'succeeded', ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.target_logical_page_id,
      run.target_resource_id,
      run.selection_fingerprint,
      run.target_key,
      version,
      coverageJson,
      sha256(coverageJson),
      JSON.stringify({ provider: "fixture", model: "fixture", promptVersion: "v1" }),
      run.approval_fingerprint,
      anchor,
    ).lastInsertRowid);
    database.connection.prepare(`
      INSERT INTO research_report_state_events (
        report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
      ) VALUES (?, 1, 'published', 'fresh', NULL, ?, ?)
    `).run(reportId, `${idempotencyKey}-published`, anchor);
    return reportId;
  };
}

describe("PriorityFeatureCatalog", () => {
  it("enumerates the collection denominator through bounded 100-subject pages", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        WITH RECURSIVE numbers(value) AS (
          SELECT 1 UNION ALL SELECT value+1 FROM numbers WHERE value<204
        )
        INSERT INTO logical_pages (
          id,identity_key,url_normalized,representative_url,created_at,updated_at
        ) SELECT 1000+value,'https://bulk.test/'||value,'https://bulk.test/'||value,
          'https://bulk.test/'||value,'2026-07-01T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z' FROM numbers;
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const expectedSubjects = catalog.listSubjects();
      const first = catalog.listSubjectPage({ limit: 100 });
      const second = catalog.listSubjectPage({ after: first.nextAfter!, limit: 100 });
      const third = catalog.listSubjectPage({ after: second.nextAfter!, limit: 100 });
      expect([first.items.length, second.items.length, third.items.length])
        .toEqual([100, 100, expectedSubjects.length - 200]);
      expect(third.nextAfter).toBeNull();
      expect(new Set([...first.items, ...second.items, ...third.items].map((subject) =>
        subject.type === "page" ? `p:${subject.logicalPageId}` : `r:${subject.resourceId}`,
      )).size).toBe(expectedSubjects.length);
    } finally { database.close(); }
  });

  it("registers exactly one aggregate per connection and rejects re-registration", () => {
    const database = fixture();
    try {
      createPriorityFeatureCatalog(database.connection);
      expect(() => createPriorityFeatureCatalog(database.connection))
        .toThrow(/already registered/);
    } finally { database.close(); }
  });

  it("round-trips known false, zero, and empty sets through the shared pure reducer", () => {
    const projection = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { is_open: false, relation_count: 0, topic_paths: [] },
      eligibility: { kind: "eligible" },
    }));
    expect(projection.features).toEqual({
      is_open: false, relation_count: 0, topic_paths: [],
    });
  });

  it("fails closed on duplicate scalars and omits only an individually overbound set", () => {
    const base = priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { is_open: false }, eligibility: { kind: "eligible" },
    });
    expect(() => reducePriorityProjectionFacts([base[0]!, base[0]!, base[1]!]))
      .toThrow(/duplicate scalar/);
    const projection = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { topic_paths: ["x".repeat(8_193)], status: ["inbox"] },
      eligibility: { kind: "eligible" },
    }));
    expect(projection.features).not.toHaveProperty("topic_paths");
    expect(projection.features.status).toEqual(["inbox"]);
    expect(projection.eligibility).toMatchObject({
      kind: "excluded", reason: "temporarily_unavailable",
      detail: { code: "feature_set_limit_exceeded" },
    });
  });

  it("honors exact 10k/8192-byte set bounds and fails closed without truncation", () => {
    const values = Array.from({ length: 10_000 }, (_, index) =>
      `${String(index).padStart(5, "0")}:${index === 0 ? "x".repeat(8_186) : "x"}`);
    const exact = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { topic_paths: values }, eligibility: { kind: "eligible" },
    }));
    expect(exact.features.topic_paths).toHaveLength(10_000);
    const over = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { topic_paths: [...values, "zzzzz:overflow"] },
      eligibility: { kind: "eligible" },
    }));
    expect(over.features).not.toHaveProperty("topic_paths");
    expect(over.eligibility).toMatchObject({
      kind: "excluded", detail: { code: "feature_set_limit_exceeded" },
    });
  });

  it("omits all string sets when their aggregate exceeds 4 MiB", () => {
    const large = Array.from({ length: 513 }, (_, index) =>
      `${String(index).padStart(4, "0")}:${"x".repeat(8_187)}`);
    const projection = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject: { type: "page", logicalPageId: 1 }, anchor,
      features: { topic_paths: large, status: ["inbox"] },
      eligibility: { kind: "eligible" },
    }));
    expect(projection.features).not.toHaveProperty("topic_paths");
    expect(projection.features).not.toHaveProperty("status");
    expect(projection.eligibility).toMatchObject({
      kind: "excluded", detail: { code: "feature_set_limit_exceeded" },
    });
  });

  it("projects one canonical logical page across browser copies and shares the engine fingerprint", () => {
    const database = fixture();
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      const projected = catalog.read(
        { type: "page", logicalPageId: 501 },
        anchor,
      );
      expect(projected).toMatchObject({
        subject: { type: "page", logicalPageId: 501 },
        eligibility: { kind: "eligible" },
        features: {
          active_use_30d_ms: 500,
          duplicate_physical_count: 1,
          has_captured_content: true,
          has_current_project_membership: true,
          is_open: true,
          is_pinned: true,
          on_screen_30d_ms: 2000,
          status: ["in_progress", "inbox"],
          topic_paths: ["Current projects/TabHub"],
          workspace_names: ["Research"],
        },
        currentOutcome: null,
        dirty: true,
        isCurrent: false,
      });

      const [outcome] = createPriorityEngine(database.connection, { now: () => anchor }).assess([{
        subject: projected.subject,
        features: projected.features,
        eligibility: projected.eligibility,
        assessmentMethod: "rule",
      }], projected.ruleset);
      expect(outcome?.kind).toBe("assessment");
      expect(outcome?.kind === "assessment" && outcome.assessment.featureFingerprint)
        .toBe(projected.featureFingerprint);
      expect(catalog.read(projected.subject, anchor)).toMatchObject({
        currentOutcome: { kind: "assessment" },
        dirty: false,
        isCurrent: true,
      });
    } finally {
      database.close();
    }
  });

  it("uses only direct current-fresh research heads and dirties an assessed fingerprint", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (502, 'website:priority.test', '${anchor}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (
          902, 502, 1, 'Priority', 'website', 'public', 'active',
          'user', 'manual', '${anchor}'
        );
        INSERT INTO resource_heads (resource_id, event_id) VALUES (502, 902);
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (
          903, 501, 'assigned', 502, 'user_manual', 'user', 'manual',
          'research-priority-assignment', '${anchor}'
        );
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (501, 903);
        INSERT INTO resource_resolution_events (
          id, logical_page_id, state, reason, resource_id, assignment_id,
          candidate_resource_ids_json, source_fingerprint, research_eligible,
          research_exclusion_reason, supersedes_id, created_at
        ) VALUES (
          904, 501, 'matched', 'user_manual', 502, 903, '[]',
          'research-priority-resolution', 1, NULL, 901, '${anchor}'
        );
        UPDATE resource_resolution_heads SET resolution_event_id = 904
        WHERE logical_page_id = 501;
        UPDATE logical_pages SET
          identity_key = 'https://openai.com/priority-feature',
          url_normalized = 'https://openai.com/priority-feature',
          representative_url = 'https://openai.com/priority-feature'
        WHERE id = 501;
        UPDATE tabs SET
          url = 'https://openai.com/priority-feature',
          url_normalized = 'https://openai.com/priority-feature'
        WHERE logical_page_id = 501;
      `);
      const page = { type: "page" as const, logicalPageId: 501 };
      const resource = { type: "resource" as const, resourceId: 502 };
      const catalog = createPriorityFeatureCatalog(database.connection);
      const beforePage = catalog.read(page, anchor);
      const beforeResource = catalog.read(resource, anchor);
      expect(beforePage.features.has_current_research_report).toBe(false);
      expect(beforeResource.features.has_current_research_report).toBe(false);

      createPriorityEngine(database.connection, { now: () => anchor }).assess([{
        subject: beforePage.subject,
        features: beforePage.features,
        eligibility: beforePage.eligibility,
        assessmentMethod: "rule",
      }], beforePage.ruleset);
      expect(catalog.read(page, anchor)).toMatchObject({ dirty: false, isCurrent: true });

      const publishFresh = createFreshResearchPublisher(database);
      const selectionFingerprint = sha256(researchSelectionFingerprintPayload([501]));
      publishFresh({
        type: "selection",
        logicalPageIds: [501],
        fingerprint: selectionFingerprint,
      }, "priority-selection-report");
      expect(database.connection.prepare(`
        SELECT current_fresh_report_id FROM research_target_heads WHERE target_key = ?
      `).pluck().get(`selection:${selectionFingerprint}`)).not.toBeNull();
      const afterSelectionPage = catalog.read(page, anchor);
      const afterSelectionResource = catalog.read(resource, anchor);
      expect(afterSelectionPage).toMatchObject({
        features: { has_current_research_report: false },
        featureFingerprint: beforePage.featureFingerprint,
        dirty: false,
        isCurrent: true,
      });
      expect(afterSelectionResource).toMatchObject({
        features: { has_current_research_report: false },
        featureFingerprint: beforeResource.featureFingerprint,
      });

      const pageReportId = publishFresh(page, "priority-page-report");
      const afterPageReport = catalog.read(page, anchor);
      const resourceWithMemberReport = catalog.read(resource, anchor);
      expect(afterPageReport.features.has_current_research_report).toBe(true);
      expect(afterPageReport.featureFingerprint).not.toBe(beforePage.featureFingerprint);
      expect(afterPageReport.currentOutcome).not.toBeNull();
      expect(afterPageReport).toMatchObject({
        dirty: true,
        isCurrent: false,
      });
      expect(resourceWithMemberReport).toMatchObject({
        features: { has_current_research_report: false },
        featureFingerprint: beforeResource.featureFingerprint,
      });

      publishFresh(resource, "priority-resource-report");
      const afterResourceReport = catalog.read(resource, anchor);
      expect(afterResourceReport.features.has_current_research_report).toBe(true);
      expect(afterResourceReport.featureFingerprint).not.toBe(beforeResource.featureFingerprint);
      expect(catalog.readBatch([page, resource, page, resource], anchor)).toEqual([
        afterPageReport, afterResourceReport, afterPageReport, afterResourceReport,
      ]);

      database.connection.prepare(`
        INSERT INTO research_report_state_events (
          report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (?, 2, 'stale', 'stale', 'source changed', ?, ?)
      `).run(pageReportId, "priority-page-report-stale", anchor);
      const afterStale = catalog.read(page, anchor);
      expect(afterStale).toMatchObject({
        features: { has_current_research_report: false },
        featureFingerprint: beforePage.featureFingerprint,
        dirty: false,
        isCurrent: true,
      });
      expect(catalog.readBatch([page, resource], anchor)).toEqual([
        afterStale, afterResourceReport,
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps local-only existence/content out of page and resource projections", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (502, 'website:priority.test', '${anchor}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (902, 502, 1, 'Priority', 'website', 'public', 'active',
          'user', 'manual', '${anchor}');
        INSERT INTO resource_heads (resource_id, event_id) VALUES (502, 902);
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class, assigned_by,
          assignment_method, source_fingerprint, created_at
        ) VALUES (903, 501, 'assigned', 502, 'user_manual', 'user', 'manual',
          'assignment', '${anchor}');
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (501, 903);
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const pageBefore = catalog.read({ type: "page", logicalPageId: 501 }, anchor);
      const resourceBefore = catalog.read({ type: "resource", resourceId: 502 }, anchor);
      database.connection.exec(`
        INSERT INTO context_entries (
          logical_page_id, kind, body, actor, method, visibility, state,
          operation, revision, idempotency_key, created_at
        ) VALUES (501, 'project', 'PRIVATE-SENTINEL-PAGE', 'user', 'manual',
          'local_only', 'active', 'append', 1, 'private-page', '${anchor}');
        INSERT INTO resource_context_entries (
          resource_id, kind, body, actor, method, visibility, state,
          operation, revision, idempotency_key, created_at
        ) VALUES (502, 'next_action', 'PRIVATE-SENTINEL-RESOURCE', 'user', 'manual',
          'local_only', 'active', 'append', 1, 'private-resource', '${anchor}');
      `);
      const pageAfter = catalog.read({ type: "page", logicalPageId: 501 }, anchor);
      const resourceAfter = catalog.read({ type: "resource", resourceId: 502 }, anchor);
      expect(pageAfter).toEqual(pageBefore);
      expect(resourceAfter).toEqual(resourceBefore);
      expect(JSON.stringify([pageAfter, resourceAfter])).not.toContain("PRIVATE-SENTINEL");
    } finally {
      database.close();
    }
  });

  it("propagates a raw member set overflow to its resource without truncation", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (502, 'website:priority.test', '${anchor}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, created_at
        ) VALUES (902,502,1,'Priority','website','public','active','user','manual','${anchor}');
        INSERT INTO resource_heads (resource_id,event_id) VALUES (502,902);
        INSERT INTO logical_page_resource_assignments (
          id,logical_page_id,action,resource_id,provenance_class,assigned_by,
          assignment_method,source_fingerprint,created_at
        ) VALUES (903,501,'assigned',502,'user_manual','user','manual','a','${anchor}');
        INSERT INTO logical_page_resource_heads (logical_page_id,assignment_id)
        VALUES (501,903);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO tags (id,name,parent_id) SELECT 10000+x,'Overflow-'||x,NULL FROM n;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO tab_tags (tab_id,tag_id,assigned_by)
        SELECT 601,10000+x,'user' FROM n;
      `);
      const projected = createPriorityFeatureCatalog(database.connection)
        .read({ type: "resource", resourceId: 502 }, anchor);
      expect(projected.features).not.toHaveProperty("topic_paths");
      expect(projected.eligibility).toMatchObject({
        kind: "excluded", reason: "temporarily_unavailable",
        detail: { code: "feature_set_limit_exceeded" },
      });
    } finally {
      database.close();
    }
  });

  it("anchors shareable staleness and does not let a local successor hide a shareable head", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility, stale_at,
          state, operation, revision, idempotency_key, created_at
        ) VALUES
          (1001, 501, 'next_action', 'shareable', 'user', 'manual', 'share_with_ai',
           '2026-08-13T12:30:00.000Z', 'active', 'append', 1, 'shareable-head', '${anchor}'),
          (1002, 501, 'next_action', 'private successor', 'user', 'manual', 'local_only',
           NULL, 'active', 'append', 2, 'private-successor', '${anchor}');
        DELETE FROM context_entries WHERE id = 1002;
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility, stale_at,
          supersedes_id, state, operation, revision, idempotency_key, created_at
        ) VALUES (1002, 501, 'next_action', 'private successor', 'user', 'manual',
          'local_only', NULL, 1001, 'active', 'append', 2, 'private-successor', '${anchor}');
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      expect(catalog.read({ type: "page", logicalPageId: 501 }, anchor).features)
        .toMatchObject({ has_shareable_next_action: true });
      expect(catalog.read(
        { type: "page", logicalPageId: 501 },
        "2026-08-13T13:00:00.000Z",
      ).features).toMatchObject({ has_shareable_next_action: false });
    } finally {
      database.close();
    }
  });

  it("fails branched current agent-review heads closed", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO context_entries (
          id,logical_page_id,kind,body,actor,method,visibility,state,operation,
          revision,idempotency_key,created_at,
          source_fingerprint
        ) VALUES (1101,501,'project','agent project','agent','rule','share_with_ai',
          'active','append',1,'agent-project','${anchor}','agent-source');
        INSERT INTO context_entry_reviews (
          id,context_entry_id,verdict,reviewed_by,review_method,
          idempotency_key,created_at
        ) VALUES
          (1201,1101,'accepted','user','manual','accept-agent','${anchor}'),
          (1202,1101,'rejected','user','manual','reject-agent','${anchor}');
      `);
      expect(createPriorityFeatureCatalog(database.connection)
        .read({ type: "page", logicalPageId: 501 }, anchor).features)
        .toMatchObject({ has_shareable_project_context: false });
    } finally { database.close(); }
  });

  it("omits incomplete 30d activity and uses the newest browser-row observation", () => {
    const database = fixture();
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      database.connection.prepare(`
        UPDATE activity_daily_writer_state
        SET coverage_started_at = ?, updated_at = ? WHERE singleton_id = 1
      `).run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      const projected = catalog.read({ type: "page", logicalPageId: 501 }, anchor);
      expect(projected.features).not.toHaveProperty("active_use_30d_ms");
      expect(projected.features).not.toHaveProperty("on_screen_30d_ms");
      expect(projected.features.last_seen_days).toBe(1);
    } finally {
      database.close();
    }
  });

  it("ignores personal importance and retention while day rollover changes age signals", () => {
    const database = fixture();
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      const before = catalog.read({ type: "page", logicalPageId: 501 }, anchor);
      database.connection.exec(`
        UPDATE logical_page_preferences SET user_importance=3,
          recorded_by='user', record_method='manual', importance_updated_at='${anchor}',
          updated_at='${anchor}' WHERE logical_page_id=501;
        UPDATE tabs SET importance=3 WHERE logical_page_id=501;
        INSERT INTO page_retention (tab_id,state,decided_by,decided_at)
        VALUES (601,'kept','user','${anchor}');
      `);
      expect(catalog.read({ type: "page", logicalPageId: 501 }, anchor).featureFingerprint)
        .toBe(before.featureFingerprint);
      const tomorrow = catalog.read(
        { type: "page", logicalPageId: 501 }, "2026-08-14T12:00:00.000Z",
      );
      expect(tomorrow.featureFingerprint).not.toBe(before.featureFingerprint);
      expect(tomorrow.features.age_days).toBe((before.features.age_days as number) + 1);
    } finally { database.close(); }
  });

  it("preserves non-null captured content and migrated summaries without a job id", () => {
    const database = fixture();
    try {
      database.connection.prepare(`
        UPDATE contents SET text = '', summary = 'Legacy summary', summary_job_id = NULL
        WHERE tab_id = 601
      `).run();
      const features = createPriorityFeatureCatalog(database.connection)
        .read({ type: "page", logicalPageId: 501 }, anchor).features;
      expect(features.has_captured_content).toBe(true);
      expect(features.has_current_summary).toBe(true);
    } finally {
      database.close();
    }
  });

  it("maps canonical resolution policy and fails malformed pairs closed", () => {
    const database = fixture();
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      const insert = database.connection.prepare(`
        INSERT INTO resource_resolution_events (
          id,logical_page_id,state,reason,candidate_resource_ids_json,
          source_fingerprint,research_eligible,research_exclusion_reason,
          supersedes_id,created_at
        ) VALUES (?,?,?,?, '[]', ?,0,?,?,?)
      `);
      const cases = [
        ["excluded", "invalid_url", "unsupported_url"],
        ["excluded", "localhost", "private_or_internal"],
        ["ambiguous", "authoritative_tie", "eligible"],
        ["unmatched", "weak_sensitive_signal", "eligible"],
      ] as const;
      let previous = 901;
      let eventId = 902;
      for (const [state, reason, expected] of cases) {
        insert.run(eventId, 501, state, reason, `resolution-${eventId}`, reason,
          previous, anchor);
        database.connection.prepare(`UPDATE resource_resolution_heads
          SET resolution_event_id=? WHERE logical_page_id=501`).run(eventId);
        previous = eventId++;
        const eligibility = catalog.read(
          { type: "page", logicalPageId: 501 }, anchor,
        ).eligibility;
        expect(eligibility.kind === "eligible" ? "eligible" : eligibility.reason)
          .toBe(expected);
      }
      insert.run(eventId, 501, "ambiguous", "invalid_url", `resolution-${eventId}`,
        "invalid_url", previous, anchor);
      database.connection.prepare(`UPDATE resource_resolution_heads
        SET resolution_event_id=? WHERE logical_page_id=501`).run(eventId);
      expect(catalog.read({ type: "page", logicalPageId: 501 }, anchor).eligibility)
        .toMatchObject({ kind: "excluded", reason: "temporarily_unavailable",
          detail: { code: "corrupt_resource_resolution_head" } });
    } finally { database.close(); }
  });

  it("keeps batch projection identical, ordered, and duplicate-preserving", () => {
    const database = fixture();
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      const subject = { type: "page" as const, logicalPageId: 501 };
      const direct = catalog.read(subject, anchor);
      expect(catalog.readBatch([subject, subject], anchor)).toEqual([direct, direct]);
      expect(() => catalog.readBatch(Array.from({ length: 101 }, () => subject), anchor))
        .toThrow(/at most 100/);
    } finally { database.close(); }
  });

  it("preloads current research heads once for a 100-subject batch", () => {
    const database = fixture();
    const originalPrepare = database.connection.prepare.bind(database.connection);
    let researchHeadExecutions = 0;
    const prepareSpy = vi.spyOn(database.connection, "prepare");
    prepareSpy.mockImplementation(((source: string) => {
      const statement = originalPrepare(source);
      if (!source.includes("research_target_heads AS heads")) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            const all = target.all.bind(target) as (...parameters: unknown[]) => unknown;
            return (...parameters: unknown[]) => {
              researchHeadExecutions += 1;
              return all(...parameters);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof database.connection.prepare);
    try {
      const catalog = createPriorityFeatureCatalog(database.connection);
      researchHeadExecutions = 0;
      const subject = { type: "page" as const, logicalPageId: 501 };
      expect(catalog.readBatch(Array.from({ length: 100 }, () => subject), anchor))
        .toHaveLength(100);
      expect(researchHeadExecutions).toBe(1);
    } finally {
      prepareSpy.mockRestore();
      database.close();
    }
  });

  it("keeps a later batch subject intact when an earlier page overflows topics", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO logical_pages (id,identity_key,url_normalized,representative_url,
          created_at,updated_at) VALUES (502,'https://later.test/','https://later.test/',
          'https://later.test/','2026-07-01T00:00:00.000Z','${anchor}');
        INSERT INTO tabs (id,url,url_normalized,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id) VALUES (603,'https://later.test/',
          'https://later.test/','chrome','done',0,0,'${anchor}','${anchor}',502);
        INSERT INTO tags(id,name,parent_id) VALUES (9000,'Later topic',NULL);
        INSERT INTO tab_tags(tab_id,tag_id,assigned_by) VALUES (603,9000,'user');
        INSERT INTO resource_resolution_events (id,logical_page_id,state,reason,
          candidate_resource_ids_json,source_fingerprint,research_eligible,
          research_exclusion_reason,created_at) VALUES (904,502,'unmatched',
          'weak_sensitive_signal','[]','later',0,'weak_sensitive_signal','${anchor}');
        INSERT INTO resource_resolution_heads VALUES (502,904);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO tags(id,name,parent_id) SELECT 10000+x,'Overflow-'||x,NULL FROM n;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
        INSERT INTO tab_tags(tab_id,tag_id,assigned_by) SELECT 601,10000+x,'user' FROM n;
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const reads = catalog.readBatch([
        { type: "page", logicalPageId: 501 }, { type: "page", logicalPageId: 502 },
      ], anchor);
      expect(reads[0]!.features).not.toHaveProperty("topic_paths");
      expect(reads[1]!.features.topic_paths).toEqual(["Later topic"]);
      expect(reads[1]).toEqual(catalog.read({ type: "page", logicalPageId: 502 }, anchor));
    } finally { database.close(); }
  });

  it("keeps set-wise Resource batch projection identical to direct reads", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resources (id,resource_key,created_at)
        VALUES (502,'website:priority.test','${anchor}');
        INSERT INTO resource_events (id,resource_id,version,name,kind,access_class,
          lifecycle_state,created_by,creation_method,created_at)
        VALUES (902,502,1,'Priority','website','public','active','user','manual','${anchor}');
        INSERT INTO resource_heads VALUES (502,902);
        INSERT INTO logical_page_resource_assignments (id,logical_page_id,action,resource_id,
          provenance_class,assigned_by,assignment_method,source_fingerprint,created_at)
        VALUES (903,501,'assigned',502,'user_manual','user','manual','assignment','${anchor}');
        INSERT INTO logical_page_resource_heads VALUES (501,903);
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const subject = { type: "resource" as const, resourceId: 502 };
      expect(catalog.readBatch([subject, subject], anchor)).toEqual([
        catalog.read(subject, anchor), catalog.read(subject, anchor),
      ]);
    } finally { database.close(); }
  });

  it("fails corrupt topic hierarchy equally in direct and batch reads", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO tags(id,name,parent_id) VALUES (8999,'Parent',NULL),(9000,'Orphan',8999);
        INSERT INTO tab_tags(tab_id,tag_id,assigned_by) VALUES (601,9000,'user');
      `);
      database.connection.pragma("foreign_keys=OFF");
      database.connection.prepare("DELETE FROM tags WHERE id=8999").run();
      database.connection.pragma("foreign_keys=ON");
      const catalog = createPriorityFeatureCatalog(database.connection);
      expect(() => catalog.read({ type: "page", logicalPageId: 501 }, anchor))
        .toThrow(/Topic hierarchy is invalid/);
      expect(() => catalog.readBatch([{ type: "page", logicalPageId: 501 }], anchor))
        .toThrow(/Topic hierarchy is invalid/);
    } finally { database.close(); }
  });

  it("paginates review subjects in page-then-resource keyset order", () => {
    const database = fixture();
    try {
      database.connection.exec(`
        INSERT INTO logical_pages (id,identity_key,url_normalized,representative_url,
          created_at,updated_at) VALUES (502,'https://next.test/','https://next.test/',
          'https://next.test/','2026-07-01T00:00:00.000Z','${anchor}');
        INSERT INTO tabs (id,url,url_normalized,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id) VALUES (603,'https://next.test/',
          'https://next.test/','chrome','inbox',0,0,'${anchor}','${anchor}',502);
        INSERT INTO resource_resolution_events (id,logical_page_id,state,reason,
          candidate_resource_ids_json,source_fingerprint,research_eligible,
          research_exclusion_reason,created_at) VALUES (904,502,'unmatched',
          'weak_sensitive_signal','[]','next',0,'weak_sensitive_signal','${anchor}');
        INSERT INTO resource_resolution_heads VALUES (502,904);
      `);
      const catalog = createPriorityFeatureCatalog(database.connection);
      const first = catalog.reviewQueue({ anchor, limit: 1 });
      expect(first.items[0]?.subject).toEqual({ type: "page", logicalPageId: 501 });
      expect(first.nextCursor).not.toBeNull();
      const second = catalog.reviewQueue({ anchor, limit: 1, cursor: first.nextCursor! });
      expect(second.items[0]?.subject).toEqual({ type: "page", logicalPageId: 502 });
      expect(() => catalog.reviewQueue({ anchor, limit: 1, cursor: "not-canonical" }))
        .toThrowError(expect.objectContaining({ code: "PRIORITY_FEATURE_INVALID_CURSOR" }));
    } finally { database.close(); }
  });

});
