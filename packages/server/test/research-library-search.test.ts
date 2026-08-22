import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  researchSelectionFingerprintPayload,
  type ResearchTarget,
} from "@tabhub/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";
import { installPrivacyPurgeAuthorization } from "../src/live-acquisition-migration.js";
import { installPrivacyPurgeIntentCapabilities } from "../src/privacy-purge-intent-capabilities.js";
import type { ResearchProvider } from "../src/research-provider.js";

const NOW = "2026-08-14T11:00:00.000Z";
const SECRET = "research-library-search-secret";
const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const budget = {
  maxSteps: 10,
  maxTokens: 10_000,
  maxCostUsd: 2,
  maxWallTimeMs: 60_000,
} as const;

function pendingResearchProvider(): ResearchProvider {
  let requestSequence = 0;
  return {
    metadata: {
      provider: "anthropic",
      model: "fixture-model",
      promptVersion: "fixture-v1",
      pricingVersion: "fixture-pricing-v1",
    },
    quote: () => ({
      version: "research_provider_quote:v1",
      inputDigest: "1".repeat(64),
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      wallTimeMs: 1,
    }),
    async start(_input, _quote, signal) {
      const requestId = `fixture-library-request-${++requestSequence}`;
      return {
        requestId,
        read: () => new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("Fixture research provider aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      };
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-research-library-search-"));
  const databasePath = join(directory, "tabhub.sqlite");
  const app = createApp({
    databasePath,
    logger: false,
    localDevProxySecret: SECRET,
    featureFlags: { ...personalAttentionFeatureFlagsOff, resources: true, research: true },
    researchProvider: pendingResearchProvider(),
    clock: () => new Date(NOW),
    migrationClock: () => new Date(NOW),
  });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": SECRET },
  });
  expect(bootstrap.statusCode).toBe(204);
  const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
  const connection = new Database(databasePath);
  connection.pragma("foreign_keys = ON");
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeAuthorization(connection);
  installPrivacyPurgeIntentCapabilities(connection);
  return {
    app,
    connection,
    directory,
    headers: { cookie, "sec-fetch-site": "same-origin" },
  };
}

async function closeFixture(value: Awaited<ReturnType<typeof fixture>>) {
  value.connection.close();
  await value.app.close();
  await rm(value.directory, { recursive: true, force: true });
}

function seedPage(
  connection: Database.Database,
  ordinal: number,
): { logicalPageId: number; tabId: number } {
  const url = `https://openai.com/library-search-fixture/${ordinal}`;
  const logicalPageId = Number(connection.prepare(`
    INSERT INTO logical_pages (
      identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(url, url, url, NOW, NOW).lastInsertRowid);
  const tabId = Number(connection.prepare(`
    INSERT INTO tabs (
      url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (?, ?, ?, 'chrome', 'inbox', 0, 1, ?, ?, ?)
  `).run(url, url, `Library fixture ${ordinal}`, NOW, NOW, logicalPageId).lastInsertRowid);
  connection.prepare(`
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
    VALUES (?, 'neutral captured material', ?, 1)
  `).run(tabId, NOW);
  return { logicalPageId, tabId };
}

function seedResource(connection: Database.Database, key: string): number {
  const resourceId = Number(connection.prepare(`
    INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
  `).run(key, NOW).lastInsertRowid);
  const eventId = Number(connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'website', 'public', 'active', 'user', 'manual', ?)
  `).run(resourceId, key, NOW).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `).run(resourceId, eventId);
  return resourceId;
}

function assignPage(
  connection: Database.Database,
  logicalPageId: number,
  resourceId: number,
): void {
  const assignmentId = Number(connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
  `).run(
    logicalPageId,
    resourceId,
    `library-search-assignment:${logicalPageId}:${resourceId}`,
    NOW,
  ).lastInsertRowid);
  connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id) VALUES (?, ?)
  `).run(logicalPageId, assignmentId);
}

function reassignPage(
  connection: Database.Database,
  logicalPageId: number,
  resourceId: number,
): void {
  const currentAssignmentId = Number(connection.prepare(`
    SELECT assignment_id FROM logical_page_resource_heads WHERE logical_page_id = ?
  `).pluck().get(logicalPageId));
  const assignmentId = Number(connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, supersedes_id, created_at
    ) VALUES (?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?, ?)
  `).run(
    logicalPageId,
    resourceId,
    `library-search-reassignment:${logicalPageId}:${resourceId}`,
    currentAssignmentId,
    NOW,
  ).lastInsertRowid);
  connection.prepare(`
    UPDATE logical_page_resource_heads SET assignment_id = ? WHERE logical_page_id = ?
  `).run(assignmentId, logicalPageId);
}

function preflightRequest(target: ResearchTarget) {
  return {
    version: 1,
    target,
    question: "What is useful?",
    includeShareableContext: false,
    maxIncludedSources: 100,
    parentReportId: null,
    budget,
    captureIntent: { selectedTabIds: [], knownFailures: [] },
    confirmedOrigins: {
      authenticatedOriginDigests: [],
      sensitiveOriginDigests: [],
    },
  };
}

async function publishReport(
  value: Awaited<ReturnType<typeof fixture>>,
  target: ResearchTarget,
  reportText: string,
  idempotencyKey: string,
): Promise<{ reportId: number; jobId: number; runId: number }> {
  const request = preflightRequest(target);
  const preflightResponse = await value.app.inject({
    method: "POST",
    url: "/api/research/preflight",
    headers: value.headers,
    payload: request,
  });
  expect(preflightResponse.statusCode, JSON.stringify(preflightResponse.json())).toBe(200);
  const preflight = preflightResponse.json();
  const runResponse = await value.app.inject({
    method: "POST",
    url: "/api/research/runs",
    headers: value.headers,
    payload: {
      ...request,
      estimate: preflight.estimate,
      approvalFingerprint: preflight.approvalFingerprint,
      idempotencyKey,
    },
  });
  expect(runResponse.statusCode, JSON.stringify(runResponse.json())).toBe(202);
  const jobId = Number(String(runResponse.json().id).split(":")[1]);
  const run = value.connection.prepare(`
    SELECT id, target_key, target_logical_page_id, target_resource_id,
      selection_fingerprint, approval_fingerprint
    FROM research_runs WHERE job_id = ?
  `).get(jobId) as {
    id: number;
    target_key: string;
    target_logical_page_id: number | null;
    target_resource_id: number | null;
    selection_fingerprint: string | null;
    approval_fingerprint: string;
  };
  const version = Number(value.connection.prepare(`
    SELECT COALESCE(MAX(version), 0) + 1 FROM research_reports WHERE target_key = ?
  `).pluck().get(run.target_key));
  const reportId = Number(value.connection.prepare(`
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
    JSON.stringify(preflight.coverage),
    hash(JSON.stringify(preflight.coverage)),
    JSON.stringify({ provider: "fixture", model: "fixture", promptVersion: "fixture-v1" }),
    run.approval_fingerprint,
    NOW,
  ).lastInsertRowid);
  value.connection.prepare(`
    INSERT INTO research_report_payloads (
      report_id, report_text, structured_json, payload_digest
    ) VALUES (?, ?, '{}', ?)
  `).run(reportId, reportText, hash(reportText));
  const sourceId = value.connection.prepare(`
    SELECT id FROM research_sources
    WHERE run_id = ? AND inclusion_state = 'included'
    ORDER BY included_order LIMIT 1
  `).pluck().get(run.id) as number | undefined;
  if (sourceId !== undefined) {
    value.connection.prepare(`
      INSERT INTO research_report_sources (report_id, source_id, used_order)
      VALUES (?, ?, 1)
    `).run(reportId, sourceId);
  }
  value.connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'published', 'fresh', NULL, ?, ?)
  `).run(reportId, `library-search-publish:${reportId}`, NOW);
  return { reportId, jobId, runId: run.id };
}

describe("current research report Library search", () => {
  it("maps only current fresh report heads through page, current Resource and selection scope", async () => {
    const value = await fixture();
    try {
      const pages = Array.from({ length: 9 }, (_, index) =>
        seedPage(value.connection, index + 1));
      const resource = seedResource(value.connection, "custom:library-search-resource");
      const replacement = seedResource(value.connection, "custom:library-search-replacement");
      for (const page of pages.slice(1, 4)) {
        assignPage(value.connection, page!.logicalPageId, resource);
      }

      await publishReport(
        value,
        { type: "page", logicalPageId: pages[0]!.logicalPageId },
        "freshpageopal appears only in the direct current report",
        "library-direct-report",
      );
      await publishReport(
        value,
        { type: "resource", resourceId: resource },
        "resourceraven appears only in the Resource current report",
        "library-resource-report",
      );
      const selectionPageIds = pages.slice(4, 6).map((page) => page!.logicalPageId);
      const selectionFingerprint = hash(researchSelectionFingerprintPayload(selectionPageIds));
      await publishReport(
        value,
        { type: "selection", logicalPageIds: selectionPageIds, fingerprint: selectionFingerprint },
        "selectionlemur appears only in the selection current report",
        "library-selection-report",
      );
      const stale = await publishReport(
        value,
        { type: "page", logicalPageId: pages[6]!.logicalPageId },
        "staleibis must not remain searchable",
        "library-stale-report",
      );
      const recapture = await value.app.inject({
        method: "POST",
        url: "/api/ingest/content",
        payload: {
          browser: "chrome",
          url: "https://openai.com/library-search-fixture/7",
          text: "recaptured material",
          htmlExcerpt: "<p>recaptured material</p>",
        },
      });
      expect(recapture.statusCode).toBe(200);
      expect(value.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = ?
      `).pluck().get(stale.reportId)).toBe("stale");

      const redacted = await publishReport(
        value,
        { type: "page", logicalPageId: pages[7]!.logicalPageId },
        "redactedyak must not remain searchable",
        "library-redacted-report",
      );
      const redaction = await value.app.inject({
        method: "POST",
        url: "/api/research/redactions",
        headers: value.headers,
        payload: {
          target: { type: "report", reportId: redacted.reportId },
          reason: "Remove report from search",
          idempotencyKey: "library-redact-report",
        },
      });
      expect(redaction.statusCode).toBe(200);

      const historical = await publishReport(
        value,
        { type: "page", logicalPageId: pages[8]!.logicalPageId },
        "historicalotter belongs only to the old non-head report",
        "library-historical-report",
      );
      const cancelled = await value.app.inject({
        method: "POST",
        url: `/api/ai/jobs/resource_research:${historical.jobId}/cancel`,
        headers: value.headers,
      });
      expect(cancelled.statusCode).toBe(200);
      await publishReport(
        value,
        { type: "page", logicalPageId: pages[8]!.logicalPageId },
        "currentbadger belongs only to the replacement current head",
        "library-current-replacement-report",
      );

      reassignPage(value.connection, pages[1]!.logicalPageId, replacement);

      const search = async (term: string, page = 1, pageSize = 50) => {
        const response = await value.app.inject({
          method: "GET",
          url: `/api/tabs?q=${encodeURIComponent(term)}&page=${page}&pageSize=${pageSize}`,
        });
        expect(response.statusCode).toBe(200);
        return response.json();
      };
      expect((await search("freshpageopal")).items.map(
        (item: { logicalPageId: number }) => item.logicalPageId,
      )).toEqual([pages[0]!.logicalPageId]);
      expect((await search("selectionlemur")).items.map(
        (item: { logicalPageId: number }) => item.logicalPageId,
      ).sort((left: number, right: number) => left - right)).toEqual(selectionPageIds);
      expect((await search("currentbadger")).items.map(
        (item: { logicalPageId: number }) => item.logicalPageId,
      )).toEqual([pages[8]!.logicalPageId]);
      for (const excluded of ["staleibis", "redactedyak", "historicalotter"]) {
        expect((await search(excluded)).total).toBe(0);
      }

      const expectedResourcePages = pages.slice(2, 4).map((page) => page!.logicalPageId);
      const first = await search("resourceraven", 1, 1);
      const second = await search("resourceraven", 2, 1);
      expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(second).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect([first.items[0].logicalPageId, second.items[0].logicalPageId].sort(
        (left: number, right: number) => left - right,
      )).toEqual(expectedResourcePages);
      const bulk = await value.app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?q=resourceraven",
      });
      expect(bulk.statusCode).toBe(200);
      expect(bulk.json()).toMatchObject({ logicalPageCount: 2 });
      expect(bulk.json().ids.sort((left: number, right: number) => left - right)).toEqual([
        pages[2]!.tabId,
        pages[3]!.tabId,
      ].sort((left, right) => left - right));
    } finally {
      await closeFixture(value);
    }
  });
});
