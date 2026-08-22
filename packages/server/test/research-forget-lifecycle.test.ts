import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp, type TabHubApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from
  "../src/attention-feature-flags.js";
import { openDatabase } from "../src/database.js";
import type {
  ResearchProvider,
  ResearchProviderInput,
} from "../src/research-provider.js";

const installationId = "122e4567-e89b-42d3-a456-426614174008";
const browserSessionId = "222e4567-e89b-42d3-a456-426614174008";
const exactScope = {
  installationId,
  browserSessionId,
  browserTabId: 81,
} as const;
const initialTime = "2026-08-14T09:00:00.000Z";
const promotedContextCanary = "PROMOTED_CONTEXT_RESEARCH_FORGET_CANARY";
const capturedContentCanary = "CAPTURED_RESEARCH_FORGET_CANARY";
const reportCanary = "REPORT_RESEARCH_FORGET_CANARY";
const localSecret = "research-forget-lifecycle-secret";

const featureFlags = {
  ...personalAttentionFeatureFlagsOff,
  context: true,
  research: true,
} as const;

function dossier(summary: string) {
  return {
    executiveSummary: summary,
    valueForUser: summary,
    capabilities: [] as string[],
    limitations: [] as string[],
    risks: [] as string[],
    unknowns: [] as string[],
    nextSteps: [] as string[],
  };
}

function researchProvider(seen: ResearchProviderInput[]): ResearchProvider {
  return {
    metadata: Object.freeze({
      provider: "anthropic",
      model: "research-forget-test-model",
      promptVersion: "research-forget-test-prompt-v1",
      pricingVersion: "research-forget-test-pricing-v1",
    }),
    quote(input) {
      seen.push(input);
      return {
        version: "research_provider_quote:v1",
        inputDigest: "a".repeat(64),
        calls: 1,
        inputTokens: 100,
        outputTokens: 100,
        costUsd: 0.01,
        wallTimeMs: 1_000,
      };
    },
    async start(input) {
      const context = input.snapshots.find(
        (snapshot) => snapshot.kind === "page_context",
      );
      if (context === undefined) {
        throw new Error("Expected promoted page context in provider input");
      }
      return {
        requestId: "research-forget-test-request",
        async read() {
          return {
            version: 1,
            dossier: dossier(reportCanary),
            claims: [{
              claim: "The promoted exact-tab intent informed this report.",
              confidence: 1,
              isInference: false,
              rationale: null,
              evidence: [{
                kind: "page_context" as const,
                snapshotOrdinal: context.ordinal,
                locator: { version: "whole_snapshot:v1" as const },
              }],
            }],
            usage: {
              steps: 1,
              inputTokens: 1,
              outputTokens: 1,
              costUsd: 0.001,
              wallTimeMs: 1,
            },
            stopReason: "complete" as const,
          };
        },
      };
    },
  };
}

async function localCookie(app: TabHubApp): Promise<string> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": localSecret },
  });
  expect(bootstrap.statusCode).toBe(204);
  return String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
}

async function waitForTerminalJob(app: TabHubApp, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/ai/jobs/${id}`,
    });
    expect(response.statusCode).toBe(200);
    const job = response.json();
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Research job ${id} did not become terminal`);
}

function privacyState(connection: Database.Database) {
  return {
    privacyRequests: connection.prepare(`
      SELECT idempotency_key, target_type, target_key, reason
      FROM research_privacy_requests ORDER BY idempotency_key
    `).all(),
    privacyRunBindings: connection.prepare(`
      SELECT idempotency_key, run_id
      FROM research_privacy_run_bindings ORDER BY idempotency_key, run_id
    `).all(),
    privacyEventBindings: connection.prepare(`
      SELECT event_key, idempotency_key, child_type, child_key
      FROM research_privacy_event_bindings ORDER BY child_type, child_key
    `).all(),
    receipts: connection.prepare(`
      SELECT idempotency_key, request_fingerprint, result_json
      FROM research_redaction_receipts ORDER BY idempotency_key
    `).all(),
    reportHeads: connection.prepare(`
      SELECT report_id, event_id, state
      FROM research_report_heads ORDER BY report_id
    `).all(),
    evidenceHeads: connection.prepare(`
      SELECT evidence_id, event_id, state
      FROM research_evidence_heads ORDER BY evidence_id
    `).all(),
    snapshotHeads: connection.prepare(`
      SELECT kind, snapshot_id, event_id, state
      FROM research_snapshot_heads ORDER BY kind, snapshot_id
    `).all(),
    sourceHeads: connection.prepare(`
      SELECT source_id, event_id, state
      FROM research_source_heads ORDER BY source_id
    `).all(),
    payloadCounts: connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM research_run_payloads) AS runs,
        (SELECT COUNT(*) FROM research_source_payloads) AS sources,
        (SELECT COUNT(*) FROM research_snapshot_payloads) AS snapshots,
        (SELECT COUNT(*) FROM research_report_payloads) AS reports,
        (SELECT COUNT(*) FROM research_claim_payloads) AS claims,
        (SELECT COUNT(*) FROM research_evidence_payloads) AS evidence
    `).get(),
    sourceLiveIdentity: connection.prepare(`
      SELECT logical_page_id, tab_id, captured_tab_id_snapshot,
        content_revision, content_digest
      FROM research_sources ORDER BY id
    `).all(),
    snapshotLiveIdentity: connection.prepare(`
      SELECT context_entry_audit_id, logical_page_audit_id, context_entry_id,
        snapshot_digest
      FROM research_page_context_snapshots ORDER BY id
    `).all(),
  };
}

describe("schema-24 promoted-intent research forget lifecycle", () => {
  it(
    "redacts dependent evidence before retention purge, rolls back failures, and replays exactly",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-research-forget-"));
      const databasePath = join(directory, "tabhub.sqlite");
      let now = new Date(initialTime);
      const seenProviderInputs: ResearchProviderInput[] = [];
      let app = createApp({
        databasePath,
        featureFlags,
        researchProvider: researchProvider(seenProviderInputs),
        localDevProxySecret: localSecret,
        logger: false,
        clock: () => now,
        migrationClock: () => new Date(initialTime),
        summaryWorkerPollMs: 10,
      });
      let databaseHandle: ReturnType<typeof openDatabase> | undefined;
      let database: Database.Database | undefined;

      try {
        const cookie = await localCookie(app);
        const localHeaders = { cookie, "sec-fetch-site": "same-origin" };
        const url = "https://openai.com/research-forget-lifecycle";
        const snapshot = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId,
            browserSessionId,
            tabs: [{
              tabId: exactScope.browserTabId,
              url,
              title: "Research forget lifecycle",
              windowId: 1,
              index: 0,
            }],
          },
        });
        expect(snapshot.statusCode).toBe(200);
        const captured = await app.inject({
          method: "POST",
          url: "/api/ingest/content",
          payload: {
            browser: "chrome",
            url,
            text: capturedContentCanary,
            htmlExcerpt: `<main>${capturedContentCanary}</main>`,
          },
        });
        expect(captured.statusCode).toBe(200);
        const library = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(library.statusCode).toBe(200);
        const tabId = Number(library.json().items[0].id);
        const logicalPageId = Number(library.json().items[0].logicalPageId);

        const setIntent = await app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: localHeaders,
          payload: {
            kind: "set",
            scope: exactScope,
            expectedUrl: url,
            body: promotedContextCanary,
            visibility: "share_with_ai",
            idempotencyKey: "research-forget-intent-set",
          },
        });
        expect(setIntent.statusCode, setIntent.body).toBe(200);
        const promoted = await app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: localHeaders,
          payload: {
            kind: "promote",
            intentId: setIntent.json().intent.id,
            scope: exactScope,
            expectedPage: setIntent.json().intent.expectedPage,
            contextKind: "next_action",
            idempotencyKey: "research-forget-intent-promote",
          },
        });
        expect(promoted.statusCode, promoted.body).toBe(200);
        expect(promoted.json()).toMatchObject({
          intent: {
            state: "promoted",
            promotedContextEntryId: promoted.json().context.id,
          },
          context: {
            body: promotedContextCanary,
            visibility: "share_with_ai",
          },
        });

        const preflightRequest = {
          version: 1,
          target: { type: "page", logicalPageId },
          question: "Why was this exact page retained?",
          includeShareableContext: true,
          maxIncludedSources: 100,
          parentReportId: null,
          budget: {
            maxSteps: 10,
            maxTokens: 10_000,
            maxCostUsd: 2,
            maxWallTimeMs: 60_000,
          },
          captureIntent: { selectedTabIds: [], knownFailures: [] },
          confirmedOrigins: {
            authenticatedOriginDigests: [],
            sensitiveOriginDigests: [],
          },
        } as const;
        const preflight = await app.inject({
          method: "POST",
          url: "/api/research/preflight",
          headers: localHeaders,
          payload: preflightRequest,
        });
        expect(preflight.statusCode, preflight.body).toBe(200);
        expect(preflight.json()).toMatchObject({
          coverage: { discovered: 1, captured: 1, eligible: 1, used: 0 },
        });
        const submitted = await app.inject({
          method: "POST",
          url: "/api/research/runs",
          headers: localHeaders,
          payload: {
            ...preflightRequest,
            estimate: preflight.json().estimate,
            approvalFingerprint: preflight.json().approvalFingerprint,
            idempotencyKey: "research-forget-run",
          },
        });
        expect(submitted.statusCode, submitted.body).toBe(202);
        const job = await waitForTerminalJob(app, String(submitted.json().id));
        expect(job).toMatchObject({
          status: "succeeded",
          result: { type: "resource_research" },
        });
        const reportId = Number(job.result.reportId);
        expect(seenProviderInputs.some((input) => input.snapshots.some(
          (item) => item.kind === "page_context" &&
            JSON.stringify(item.material).includes(promotedContextCanary),
        ))).toBe(true);

        const beforeRedaction = await app.inject({
          method: "GET",
          url: `/api/research/reports/${reportId}`,
          headers: localHeaders,
        });
        expect(beforeRedaction.statusCode, beforeRedaction.body).toBe(200);
        expect(beforeRedaction.json()).toMatchObject({
          state: "fresh",
          dossier: { executiveSummary: reportCanary },
          claims: [{
            claimText: "The promoted exact-tab intent informed this report.",
            evidence: [{
              kind: "page_context",
              state: "valid",
              locator: { version: "whole_snapshot:v1" },
            }],
          }],
        });

        databaseHandle = openDatabase(databasePath);
        database = databaseHandle.connection;
        const sourceBefore = database.prepare(`
          SELECT id, tab_id, captured_tab_id_snapshot, logical_page_id
          FROM research_sources
        `).get() as {
          id: number;
          tab_id: number;
          captured_tab_id_snapshot: number;
          logical_page_id: number;
        };
        expect(sourceBefore).toEqual({
          id: 1,
          tab_id: tabId,
          captured_tab_id_snapshot: tabId,
          logical_page_id: logicalPageId,
        });
        const beforeWrongOrder = privacyState(database);
        expect(() => database!.prepare("DELETE FROM tabs WHERE id = ?").run(tabId))
          .toThrow(/FOREIGN KEY constraint failed/);
        expect(privacyState(database)).toEqual(beforeWrongOrder);
        expect(database.prepare("SELECT COUNT(*) FROM tabs WHERE id = ?").pluck().get(tabId))
          .toBe(1);
        expect(database.prepare("SELECT COUNT(*) FROM contents WHERE tab_id = ?").pluck().get(tabId))
          .toBe(1);

        database.exec(`
          CREATE TRIGGER g8_test_abort_late_research_redaction
          BEFORE DELETE ON research_report_payloads
          BEGIN
            SELECT RAISE(ABORT, 'g8 forced late redaction failure');
          END;
        `);
        const redactionRequest = {
          target: { type: "logical_page", logicalPageId },
          reason: "Forget page-bound research material",
          idempotencyKey: "research-forget-logical-page",
        } as const;
        const beforeFailedRedaction = privacyState(database);
        const failedRedaction = await app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: localHeaders,
          payload: redactionRequest,
        });
        expect(failedRedaction.statusCode).toBe(500);
        expect(privacyState(database)).toEqual(beforeFailedRedaction);
        database.exec("DROP TRIGGER g8_test_abort_late_research_redaction");

        const redacted = await app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: localHeaders,
          payload: redactionRequest,
        });
        expect(redacted.statusCode, redacted.body).toBe(200);
        expect(redacted.json()).toEqual({
          sources: 1,
          snapshots: 1,
          evidence: 1,
          reports: 1,
          runs: 1,
          cancelledJobs: 0,
        });
        const afterRedaction = privacyState(database);
        expect(afterRedaction.payloadCounts).toEqual({
          runs: 0,
          sources: 0,
          snapshots: 0,
          reports: 0,
          claims: 0,
          evidence: 0,
        });
        expect(afterRedaction.sourceLiveIdentity).toEqual([{
          logical_page_id: logicalPageId,
          tab_id: null,
          captured_tab_id_snapshot: tabId,
          content_revision: 1,
          content_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }]);
        expect(afterRedaction.snapshotLiveIdentity).toEqual([{
          context_entry_audit_id: promoted.json().context.id,
          logical_page_audit_id: logicalPageId,
          context_entry_id: null,
          snapshot_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }]);

        const redactedDetail = await app.inject({
          method: "GET",
          url: `/api/research/reports/${reportId}`,
          headers: localHeaders,
        });
        expect(redactedDetail.statusCode, redactedDetail.body).toBe(200);
        expect(redactedDetail.json()).toMatchObject({
          id: reportId,
          state: "redacted",
          dossier: null,
          reportText: null,
          claims: [{
            claimDigest: beforeRedaction.json().claims[0].claimDigest,
            claimText: null,
            evidence: [{
              kind: "page_context",
              state: "redacted",
              locatorDigest:
                beforeRedaction.json().claims[0].evidence[0].locatorDigest,
              locator: null,
              excerpt: null,
            }],
          }],
        });
        expect(redactedDetail.body).not.toContain(promotedContextCanary);
        expect(redactedDetail.body).not.toContain(capturedContentCanary);
        expect(redactedDetail.body).not.toContain(reportCanary);

        const dataVersionBeforeReplay = database.pragma("data_version", {
          simple: true,
        });
        const replay = await app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: localHeaders,
          payload: redactionRequest,
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(redacted.json());
        expect(database.pragma("data_version", { simple: true }))
          .toBe(dataVersionBeforeReplay);
        expect(privacyState(database)).toEqual(afterRedaction);

        const closed = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId,
            browserSessionId,
            tabs: [],
          },
        });
        expect(closed.statusCode).toBe(200);
        const trashed = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: { decision: "trash", decidedBy: "user", confirmed: true },
        });
        expect(trashed.statusCode, trashed.body).toBe(200);
        expect(trashed.json()).toMatchObject({ tabId, state: "trashed" });

        now = new Date("2026-08-22T09:00:00.000Z");
        await app.close();
        app = createApp({
          databasePath,
          featureFlags: { ...featureFlags, research: false },
          localDevProxySecret: localSecret,
          logger: false,
          clock: () => now,
          migrationClock: () => new Date(initialTime),
        });
        await app.ready();

        expect((await app.inject({
          method: "GET",
          url: `/api/tabs/${tabId}`,
        })).statusCode).toBe(404);
        expect(database.prepare("SELECT COUNT(*) FROM tabs WHERE id = ?").pluck().get(tabId))
          .toBe(0);
        expect(database.prepare("SELECT COUNT(*) FROM contents WHERE tab_id = ?").pluck().get(tabId))
          .toBe(0);
        expect(database.prepare(`
          SELECT state, promoted_context_entry_id
          FROM tab_session_intents WHERE id = ?
        `).get(setIntent.json().intent.id)).toEqual({
          state: "promoted",
          promoted_context_entry_id: promoted.json().context.id,
        });
        expect(database.prepare(`
          SELECT logical_page_id, body, visibility, state
          FROM context_entries WHERE id = ?
        `).get(promoted.json().context.id)).toEqual({
          logical_page_id: logicalPageId,
          body: promotedContextCanary,
          visibility: "share_with_ai",
          state: "active",
        });
        expect(database.prepare(`
          SELECT COUNT(*) FROM logical_pages WHERE id = ?
        `).pluck().get(logicalPageId)).toBe(1);
        expect(database.prepare(`
          SELECT tab_id, captured_tab_id_snapshot, logical_page_id
          FROM research_sources
        `).get()).toEqual({
          tab_id: null,
          captured_tab_id_snapshot: tabId,
          logical_page_id: logicalPageId,
        });
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        databaseHandle?.close();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
