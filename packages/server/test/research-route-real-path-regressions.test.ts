import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { researchSelectionFingerprintPayload } from "@tabhub/shared";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";
import { installPrivacyPurgeAuthorization } from "../src/live-acquisition-migration.js";
import { installPrivacyPurgeIntentCapabilities } from "../src/privacy-purge-intent-capabilities.js";
import type { ResearchProvider } from "../src/research-provider.js";

const NOW = "2026-08-14T10:00:00.000Z";
const SECRET = "research-real-path-secret";
const budget = {
  maxSteps: 10,
  maxTokens: 10_000,
  maxCostUsd: 2,
  maxWallTimeMs: 60_000,
} as const;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

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
      const requestId = `fixture-real-path-request-${++requestSequence}`;
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
  const directory = await mkdtemp(join(tmpdir(), "tabhub-research-real-routes-"));
  const databasePath = join(directory, "tabhub.sqlite");
  const app = createApp({
    databasePath,
    logger: false,
    localDevProxySecret: SECRET,
    featureFlags: {
      ...personalAttentionFeatureFlagsOff,
      resources: true,
      research: true,
    },
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
    databasePath,
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
  suffix: string,
  capturedText?: string,
  origin = "https://openai.com",
): { logicalPageId: number; tabId: number } {
  const url = `${origin}/research-route/${suffix}`;
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
  `).run(url, url, `Page ${suffix}`, NOW, NOW, logicalPageId).lastInsertRowid);
  if (capturedText !== undefined) {
    connection.prepare(`
      INSERT INTO contents (tab_id, text, extracted_at, content_revision)
      VALUES (?, ?, ?, 1)
    `).run(tabId, capturedText, NOW);
  }
  return { logicalPageId, tabId };
}

function seedResource(
  connection: Database.Database,
  key: string,
  accessClass: "public" | "authenticated" | "sensitive" = "public",
): { resourceId: number; eventId: number } {
  const resourceId = Number(connection.prepare(`
    INSERT INTO resources (resource_key, created_at) VALUES (?, ?)
  `).run(key, NOW).lastInsertRowid);
  const eventId = Number(connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (?, 1, ?, 'website', ?, 'active', 'user', 'manual', ?)
  `).run(resourceId, key, accessClass, NOW).lastInsertRowid);
  connection.prepare(`
    INSERT INTO resource_heads (resource_id, event_id) VALUES (?, ?)
  `).run(resourceId, eventId);
  return { resourceId, eventId };
}

function mergeResource(
  connection: Database.Database,
  source: { resourceId: number; eventId: number },
  targetResourceId: number,
): void {
  const current = connection.prepare(`
    SELECT resource_events.id, resource_events.version
    FROM resource_heads
    JOIN resource_events ON resource_events.id = resource_heads.event_id
    WHERE resource_heads.resource_id = ?
  `).get(source.resourceId) as { id: number; version: number };
  const mergedEventId = Number(connection.prepare(`
    INSERT INTO resource_events (
      resource_id, version, name, kind, access_class, lifecycle_state,
      merged_into_resource_id, created_by, creation_method, supersedes_id, created_at
    ) VALUES (?, ?, 'Merged', 'website', 'public', 'merged', ?,
      'user', 'manual', ?, ?)
  `).run(
    source.resourceId, current.version + 1, targetResourceId, current.id, NOW,
  ).lastInsertRowid);
  connection.prepare(`
    UPDATE resource_heads SET event_id = ? WHERE resource_id = ?
  `).run(mergedEventId, source.resourceId);
}

function assignPageToResource(
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
    `research-route-assignment:${logicalPageId}:${resourceId}`,
    NOW,
  ).lastInsertRowid);
  connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id) VALUES (?, ?)
  `).run(logicalPageId, assignmentId);
}

function preflightRequest(
  target: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    target,
    question: "What is useful here?",
    includeShareableContext: false,
    maxIncludedSources: 100,
    parentReportId: null,
    budget,
    captureIntent: { selectedTabIds: [], knownFailures: [] },
    confirmedOrigins: {
      authenticatedOriginDigests: [],
      sensitiveOriginDigests: [],
    },
    ...overrides,
  };
}

function writeCounts(connection: Database.Database) {
  return {
    jobs: Number(connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()),
    runs: Number(connection.prepare("SELECT COUNT(*) FROM research_runs").pluck().get()),
    receipts: Number(connection.prepare(`
      SELECT COUNT(*) FROM ai_job_idempotency_receipts
    `).pluck().get()),
  };
}

function privacyWriteCounts(connection: Database.Database) {
  return {
    requests: Number(connection.prepare(`
      SELECT COUNT(*) FROM research_privacy_requests
    `).pluck().get()),
    receipts: Number(connection.prepare(`
      SELECT COUNT(*) FROM research_redaction_receipts
    `).pluck().get()),
  };
}

async function createParentReport(
  value: Awaited<ReturnType<typeof fixture>>,
  logicalPageId: number,
): Promise<number> {
  const request = preflightRequest({ type: "page", logicalPageId });
  const preflight = await value.app.inject({
    method: "POST",
    url: "/api/research/preflight",
    headers: value.headers,
    payload: request,
  });
  expect(preflight.statusCode).toBe(200);
  const approval = preflight.json();
  const run = await value.app.inject({
    method: "POST",
    url: "/api/research/runs",
    headers: value.headers,
    payload: {
      ...request,
      estimate: approval.estimate,
      approvalFingerprint: approval.approvalFingerprint,
      idempotencyKey: "seed-parent-report",
    },
  });
  expect(run.statusCode, JSON.stringify(run.json())).toBe(202);
  const persistedRun = value.connection.prepare(`
    SELECT id, approval_fingerprint FROM research_runs ORDER BY id DESC LIMIT 1
  `).get() as { id: number; approval_fingerprint: string };
  const reportId = Number(value.connection.prepare(`
    INSERT INTO research_reports (
      run_id, target_logical_page_id, target_resource_id, selection_fingerprint,
      target_key, version, parent_report_id, publish_status, coverage_json,
      coverage_fingerprint, provenance_json, input_fingerprint, created_at
    ) VALUES (?, ?, NULL, NULL, ?, 1, NULL, 'succeeded', ?, ?, ?, ?, ?)
  `).run(
    persistedRun.id,
    logicalPageId,
    `page:${logicalPageId}`,
    JSON.stringify(approval.coverage),
    sha256(JSON.stringify(approval.coverage)),
    JSON.stringify({ provider: "fixture", model: "fixture", promptVersion: "fixture-v1" }),
    persistedRun.approval_fingerprint,
    NOW,
  ).lastInsertRowid);
  value.connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 1, 'published', 'fresh', NULL, ?, ?)
  `).run(reportId, `seed-parent-published-${reportId}`, NOW);
  return reportId;
}

function setParentState(
  connection: Database.Database,
  reportId: number,
  state: "superseded" | "redacted",
): void {
  if (state === "superseded") {
    connection.prepare(`
      INSERT INTO research_report_state_events (
        report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
      ) VALUES (?, 2, 'superseded', 'superseded', NULL, ?, ?)
    `).run(reportId, `seed-parent-superseded-${reportId}`, NOW);
    return;
  }
  const privacyKey = `seed-parent-redaction-${reportId}`;
  const eventKey = `seed-parent-redacted-event-${reportId}`;
  connection.prepare(`
    INSERT INTO research_privacy_requests (
      idempotency_key, request_fingerprint, target_type, target_key, reason, created_at
    ) VALUES (?, ?, 'report', ?, 'Fixture redaction', ?)
  `).run(privacyKey, sha256(privacyKey), `report:${reportId}`, NOW);
  connection.prepare(`
    INSERT INTO research_privacy_event_bindings (
      event_key, idempotency_key, child_type, child_key
    ) VALUES (?, ?, 'report', ?)
  `).run(eventKey, privacyKey, String(reportId));
  connection.prepare(`
    INSERT INTO research_report_state_events (
      report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
    ) VALUES (?, 3, 'redacted', 'redacted', 'Fixture redaction', ?, ?)
  `).run(reportId, eventKey, NOW);
}

describe("C81 real application research boundaries", () => {
  it("replays through the real app after provider removal while a new start stays unavailable", async () => {
    const value = await fixture();
    let offlineApp: ReturnType<typeof createApp> | undefined;
    let liveConnection = true;
    let liveApp = true;
    try {
      const page = seedPage(value.connection, "agent-provider-replay", "captured evidence");
      const command = {
        version: 1,
        target: { type: "page", logicalPageId: page.logicalPageId },
        question: "What is useful here?",
        includeShareableContext: false,
        maxIncludedSources: 100,
        budget,
        confirmedOrigins: {
          authenticatedOriginDigests: [], sensitiveOriginDigests: [],
        },
        idempotencyKey: "real-agent-provider-replay",
        authorizationRef: "real-agent-provider-replay-authorization",
      };
      const first = await value.app.inject({
        method: "POST", url: "/api/agent/research/start", payload: command,
      });
      expect(first.statusCode, first.body).toBe(202);

      value.connection.close();
      liveConnection = false;
      await value.app.close();
      liveApp = false;
      offlineApp = createApp({
        databasePath: value.databasePath,
        logger: false,
        localDevProxySecret: SECRET,
        featureFlags: {
          ...personalAttentionFeatureFlagsOff,
          resources: true,
          research: true,
        },
        clock: () => new Date(NOW),
        migrationClock: () => new Date(NOW),
      });

      const replay = await offlineApp.inject({
        method: "POST", url: "/api/agent/research/start", payload: command,
      });
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toMatchObject({ id: first.json().id, kind: first.json().kind });
      const newStart = await offlineApp.inject({
        method: "POST", url: "/api/agent/research/start",
        payload: { ...command, idempotencyKey: "real-agent-provider-new-start" },
      });
      expect(newStart.statusCode).toBe(503);
      expect(newStart.json()).toEqual({ error: "RESEARCH_PROVIDER_UNAVAILABLE" });
    } finally {
      if (liveConnection) value.connection.close();
      if (liveApp) await value.app.close();
      await offlineApp?.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  });

  it("starts or durably replays one declarative agent command before corpus/target drift", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "agent-start-or-replay", "captured evidence");
      const resource = seedResource(
        value.connection, "custom:agent-start-or-replay", "authenticated",
      );
      assignPageToResource(value.connection, page.logicalPageId, resource.resourceId);
      const base = preflightRequest({ type: "resource", resourceId: resource.resourceId });
      const { parentReportId: _parentReportId, captureIntent: _captureIntent,
        ...declarativeBase } = base;
      const command = {
        ...declarativeBase,
        idempotencyKey: "real-agent-start-or-replay",
        authorizationRef: "real-user-start-or-replay-authorization",
      };

      const confirmation = await value.app.inject({
        method: "POST", url: "/api/agent/research/start", payload: command,
      });
      expect(confirmation.statusCode, confirmation.body).toBe(200);
      expect(confirmation.json()).toMatchObject({
        status: "confirmation_required",
        confirmationRequirements: { authenticatedOriginDigests: [expect.any(String)] },
      });
      expect(writeCounts(value.connection)).toEqual({ jobs: 0, runs: 0, receipts: 0 });
      expect(value.connection.prepare(`
        SELECT COUNT(*) FROM agent_research_command_receipts
      `).pluck().get()).toBe(0);

      const approvedCommand = {
        ...command,
        confirmedOrigins: confirmation.json().confirmationRequirements,
      };
      const first = await value.app.inject({
        method: "POST", url: "/api/agent/research/start", payload: approvedCommand,
      });
      expect(first.statusCode, first.body).toBe(202);
      expect(first.json()).toMatchObject({
        id: expect.stringMatching(/^resource_research:/), kind: "resource_research",
      });

      const sensitiveEventId = Number(value.connection.prepare(`
        INSERT INTO resource_events (
          resource_id, version, name, kind, access_class, lifecycle_state,
          created_by, creation_method, supersedes_id, created_at
        ) VALUES (?, 2, 'agent-start-or-replay', 'website', 'sensitive', 'active',
          'user', 'manual', ?, ?)
      `).run(resource.resourceId, resource.eventId, NOW).lastInsertRowid);
      value.connection.prepare(`
        UPDATE resource_heads SET event_id = ? WHERE resource_id = ?
      `).run(sensitiveEventId, resource.resourceId);
      const currentPreflight = await value.app.inject({
        method: "POST", url: "/api/agent/research/preflight",
        payload: {
          ...base,
          confirmedOrigins: approvedCommand.confirmedOrigins,
        },
      });
      expect(currentPreflight.statusCode, currentPreflight.body).toBe(200);
      expect(currentPreflight.json()).toMatchObject({
        approvalFingerprint: null,
        requiresConfirmation: true,
      });
      expect(currentPreflight.json().confirmationRequirements)
        .not.toEqual(approvedCommand.confirmedOrigins);

      const beforeReplay = {
        ...writeCounts(value.connection),
        agentReceipts: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get()),
      };
      const replay = await value.app.inject({
        method: "POST", url: "/api/agent/research/start", payload: approvedCommand,
      });
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toMatchObject({ id: first.json().id, kind: first.json().kind });
      expect({
        ...writeCounts(value.connection),
        agentReceipts: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get()),
      }).toEqual(beforeReplay);

      mergeResource(value.connection, resource, seedResource(
        value.connection, "custom:agent-replay-target", "public",
      ).resourceId);
      const unavailableTargetReplay = await value.app.inject({
        method: "POST", url: "/api/agent/research/start", payload: approvedCommand,
      });
      expect(unavailableTargetReplay.statusCode, unavailableTargetReplay.body).toBe(202);
      expect(unavailableTargetReplay.json().id).toBe(first.json().id);

      for (const changed of [
        { ...approvedCommand, question: "Changed declarative request" },
        { ...approvedCommand, confirmedOrigins: {
          authenticatedOriginDigests: approvedCommand.confirmedOrigins
            .authenticatedOriginDigests,
          sensitiveOriginDigests: [sha256("https://changed-confirmation.example")],
        } },
        { ...approvedCommand, authorizationRef: "changed-authorization" },
      ]) {
        const conflict = await value.app.inject({
          method: "POST", url: "/api/agent/research/start", payload: changed,
        });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toEqual({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("serves agent research without a local cookie and owns replay/provenance/cancel receipts", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "agent-boundary", "agent captured evidence");
      const resource = seedResource(
        value.connection,
        "custom:agent-authenticated-resource",
        "authenticated",
      );
      assignPageToResource(value.connection, page.logicalPageId, resource.resourceId);
      const request = preflightRequest({ type: "resource", resourceId: resource.resourceId });

      const localWithoutCookie = await value.app.inject({
        method: "POST",
        url: "/api/research/preflight",
        payload: request,
      });
      expect(localWithoutCookie.statusCode).toBe(401);

      const discovery = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/preflight",
        payload: request,
      });
      expect(discovery.statusCode, discovery.body).toBe(200);
      expect(discovery.body).not.toContain("openai.com");
      expect(discovery.json()).not.toHaveProperty("confirmationDisplay");
      const confirmationRequirements = discovery.json().confirmationRequirements;
      expect(confirmationRequirements.authenticatedOriginDigests).toHaveLength(1);

      const local = await value.app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers: value.headers,
        payload: request,
      });
      expect(local.statusCode).toBe(200);
      expect(local.json().confirmationDisplay).toEqual([{
        accessClass: "authenticated",
        originDigest: confirmationRequirements.authenticatedOriginDigests[0],
        origin: "https://openai.com",
      }]);

      const confirmedRequest = {
        ...request,
        confirmedOrigins: confirmationRequirements,
      };
      const approved = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/preflight",
        payload: confirmedRequest,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(approved.json()).not.toHaveProperty("confirmationDisplay");

      const approval = {
        ...confirmedRequest,
        estimate: approved.json().estimate,
        approvalFingerprint: approved.json().approvalFingerprint,
        idempotencyKey: "real-agent-start",
        authorizationRef: "real-user-authorization",
      };
      const callerSuppliedProvenance = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/runs",
        payload: {
          ...approval,
          requestedBy: "user",
          requestMethod: "manual",
        },
      });
      expect(callerSuppliedProvenance.statusCode).toBe(400);
      expect(callerSuppliedProvenance.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      expect(value.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get()).toBe(0);

      const first = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/runs",
        payload: approval,
      });
      expect(first.statusCode, first.body).toBe(202);
      expect(first.json().id).toMatch(/^resource_research:/);
      expect(value.connection.prepare(`
        SELECT requested_by, request_method, authorization_ref
        FROM ai_jobs WHERE id = 1
      `).get()).toEqual({
        requested_by: "agent",
        request_method: "on_behalf_of_user",
        authorization_ref: approval.authorizationRef,
      });

      await vi.waitFor(() => {
        expect(value.connection.prepare(`
          SELECT status FROM ai_jobs WHERE id = 1
        `).pluck().get()).toBe("running");
      });
      const commandState = () => ({
        jobs: value.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get(),
        runs: value.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get(),
        events: value.connection.prepare(`SELECT COUNT(*) FROM ai_job_events`).pluck().get(),
        receipts: value.connection.prepare(`
          SELECT COUNT(*) FROM agent_research_command_receipts
        `).pluck().get(),
      });
      const beforeReplay = commandState();
      expect(beforeReplay).toMatchObject({ jobs: 1, runs: 1, receipts: 1 });
      expect(Number(beforeReplay.events)).toBeGreaterThan(0);

      value.connection.prepare(`
        UPDATE tabs SET title = 'agent replay drift' WHERE id = ?
      `).run(page.tabId);
      const replay = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/runs",
        payload: approval,
      });
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({
        id: first.json().id,
        kind: first.json().kind,
        status: "running",
      });
      expect(commandState()).toEqual(beforeReplay);

      const changed = await value.app.inject({
        method: "POST",
        url: "/api/agent/research/runs",
        payload: { ...approval, question: "Changed declarative request" },
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toEqual({ error: "IDEMPOTENCY_KEY_CONFLICT" });

      const cancelPayload = {
        idempotencyKey: "real-agent-cancel",
        authorizationRef: approval.authorizationRef,
      };
      const cancelled = await value.app.inject({
        method: "POST",
        url: `/api/agent/ai/jobs/${first.json().id}/cancel`,
        payload: cancelPayload,
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const cancelReplay = await value.app.inject({
        method: "POST",
        url: `/api/agent/ai/jobs/${first.json().id}/cancel`,
        payload: cancelPayload,
      });
      expect(cancelReplay.statusCode).toBe(200);
      expect(cancelReplay.json()).toEqual(cancelled.json());
      const cancelConflict = await value.app.inject({
        method: "POST",
        url: `/api/agent/ai/jobs/${first.json().id}/cancel`,
        payload: { ...cancelPayload, authorizationRef: "changed-authorization" },
      });
      expect(cancelConflict.statusCode).toBe(409);
      expect(cancelConflict.json()).toEqual({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(value.connection.prepare(`
        SELECT operation, COUNT(*) AS count FROM agent_research_command_receipts
        GROUP BY operation ORDER BY operation
      `).all()).toEqual([
        { operation: "cancel", count: 1 },
        { operation: "start", count: 1 },
      ]);
      expect(value.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_events
        WHERE event_type IN ('cancelled', 'cancel_requested')
      `).pluck().get()).toBe(1);

      const localCancelWithoutCookie = await value.app.inject({
        method: "POST",
        url: `/api/ai/jobs/${first.json().id}/cancel`,
      });
      expect(localCancelWithoutCookie.statusCode).toBe(401);
    } finally {
      await closeFixture(value);
    }
  });

  it("maps missing page and missing or non-current Resource targets to exact 404s", async () => {
    const value = await fixture();
    try {
      const current = seedResource(value.connection, "custom:current-empty");
      const merged = seedResource(value.connection, "custom:merged-away");
      mergeResource(value.connection, merged, current.resourceId);

      for (const target of [
        { type: "page", logicalPageId: 999_999 },
        { type: "resource", resourceId: 999_999 },
        { type: "resource", resourceId: merged.resourceId },
      ]) {
        const response = await value.app.inject({
          method: "POST",
          url: "/api/research/preflight",
          headers: value.headers,
          payload: preflightRequest(target),
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "RESEARCH_TARGET_NOT_FOUND" });
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("maps invalid selection identity and capture intent to exact 422s", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "selection");
      const missingPageId = page.logicalPageId + 999_999;
      const cases = [
        preflightRequest({
          type: "selection",
          logicalPageIds: [page.logicalPageId],
          fingerprint: "0".repeat(64),
        }),
        preflightRequest({
          type: "selection",
          logicalPageIds: [page.logicalPageId, missingPageId],
          fingerprint: sha256(researchSelectionFingerprintPayload([
            page.logicalPageId,
            missingPageId,
          ])),
        }),
        preflightRequest(
          { type: "page", logicalPageId: page.logicalPageId },
          { captureIntent: { selectedTabIds: [page.tabId + 999_999], knownFailures: [] } },
        ),
      ];
      for (const payload of cases) {
        const response = await value.app.inject({
          method: "POST",
          url: "/api/research/preflight",
          headers: value.headers,
          payload,
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: "RESEARCH_SELECTION_INVALID" });
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("returns an actionable zero-member Resource preflight and rejects its run atomically", async () => {
    const value = await fixture();
    try {
      const resource = seedResource(value.connection, "custom:empty-research-resource");
      const request = preflightRequest({ type: "resource", resourceId: resource.resourceId });
      const response = await value.app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers: value.headers,
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      const preflight = response.json();
      expect(preflight).toMatchObject({
        target: request.target,
        approvalFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        corpusFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
        manifest: [],
        snapshots: [],
        estimate: {
          estimateVersion: "research_estimate:v1",
          estimateKind: "reservation_envelope",
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
        requiresConfirmation: false,
      });

      const before = writeCounts(value.connection);
      const run = await value.app.inject({
        method: "POST",
        url: "/api/research/runs",
        headers: value.headers,
        payload: {
          ...request,
          estimate: preflight.estimate,
          approvalFingerprint: preflight.approvalFingerprint,
          idempotencyKey: "empty-resource-run",
        },
      });
      expect(run.statusCode).toBe(422);
      expect(run.json()).toEqual({ error: "RESEARCH_CAPTURE_REQUIRED" });
      expect(writeCounts(value.connection)).toEqual(before);
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects missing, wrong-target, superseded and redacted parents transactionally", async () => {
    const value = await fixture();
    try {
      const parentPage = seedPage(value.connection, "parent", "parent evidence");
      const otherPage = seedPage(value.connection, "other-parent-target");
      const parentReportId = await createParentReport(value, parentPage.logicalPageId);
      const base = {
        ...preflightRequest({ type: "page", logicalPageId: parentPage.logicalPageId }),
        estimate: {
          estimateVersion: "research_estimate:v1",
          estimateKind: "reservation_envelope",
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          wallTimeMs: 0,
        },
        approvalFingerprint: "0".repeat(64),
      };
      const assertRejectedWithoutWrites = async (
        target: Record<string, unknown>,
        candidateParentId: number,
        idempotencyKey: string,
        error: "RESEARCH_PARENT_NOT_FOUND" | "RESEARCH_PARENT_UNAVAILABLE",
        statusCode: 404 | 409,
      ) => {
        const before = writeCounts(value.connection);
        const response = await value.app.inject({
          method: "POST",
          url: "/api/research/runs",
          headers: value.headers,
          payload: {
            ...base,
            target,
            parentReportId: candidateParentId,
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(statusCode);
        expect(response.json()).toEqual({ error });
        expect(writeCounts(value.connection)).toEqual(before);
      };

      await assertRejectedWithoutWrites(
        base.target,
        parentReportId + 999_999,
        "missing-parent-run",
        "RESEARCH_PARENT_NOT_FOUND",
        404,
      );
      await assertRejectedWithoutWrites(
        { type: "page", logicalPageId: otherPage.logicalPageId },
        parentReportId,
        "wrong-target-parent-run",
        "RESEARCH_PARENT_UNAVAILABLE",
        409,
      );

      setParentState(value.connection, parentReportId, "superseded");
      await assertRejectedWithoutWrites(
        base.target,
        parentReportId,
        "superseded-parent-run",
        "RESEARCH_PARENT_UNAVAILABLE",
        409,
      );

      setParentState(value.connection, parentReportId, "redacted");
      await assertRejectedWithoutWrites(
        base.target,
        parentReportId,
        "redacted-parent-run",
        "RESEARCH_PARENT_UNAVAILABLE",
        409,
      );
    } finally {
      await closeFixture(value);
    }
  });

  it("owns noncanonical run confirmations as exact stale-preflight conflicts with zero writes", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "noncanonical-confirmations", "captured evidence");
      const request = preflightRequest({ type: "page", logicalPageId: page.logicalPageId });
      const response = await value.app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers: value.headers,
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      const preflight = response.json();
      const first = "a".repeat(64);
      const second = "b".repeat(64);
      for (const [idempotencyKey, authenticatedOriginDigests] of [
        ["duplicate-confirmations", [first, first]],
        ["descending-confirmations", [second, first]],
      ] as const) {
        const before = writeCounts(value.connection);
        const run = await value.app.inject({
          method: "POST",
          url: "/api/research/runs",
          headers: value.headers,
          payload: {
            ...request,
            confirmedOrigins: { authenticatedOriginDigests, sensitiveOriginDigests: [] },
            estimate: preflight.estimate,
            approvalFingerprint: preflight.approvalFingerprint,
            idempotencyKey,
          },
        });
        expect(run.statusCode).toBe(409);
        expect(run.json()).toEqual({ error: "RESEARCH_PREFLIGHT_STALE" });
        expect(writeCounts(value.connection)).toEqual(before);
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects missing page and Resource redaction targets before privacy writes", async () => {
    const value = await fixture();
    try {
      for (const [idempotencyKey, target] of [
        ["redact-missing-page", { type: "page", logicalPageId: 999_998 }],
        ["redact-missing-resource", { type: "resource", resourceId: 999_999 }],
      ] as const) {
        const before = privacyWriteCounts(value.connection);
        const response = await value.app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: value.headers,
          payload: {
            target: { type: "target", target },
            reason: "Missing target must not create privacy history",
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "RESEARCH_TARGET_NOT_FOUND" });
        expect(privacyWriteCounts(value.connection)).toEqual(before);
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects invalid selection redaction targets before privacy writes", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "redaction-selection");
      const missingPageId = page.logicalPageId + 999_999;
      for (const [idempotencyKey, target] of [
        ["redact-bad-selection-fingerprint", {
          type: "selection",
          logicalPageIds: [page.logicalPageId],
          fingerprint: "0".repeat(64),
        }],
        ["redact-missing-selection-page", {
          type: "selection",
          logicalPageIds: [page.logicalPageId, missingPageId],
          fingerprint: sha256(researchSelectionFingerprintPayload([
            page.logicalPageId,
            missingPageId,
          ])),
        }],
      ] as const) {
        const before = privacyWriteCounts(value.connection);
        const response = await value.app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: value.headers,
          payload: {
            target: { type: "target", target },
            reason: "Invalid selection must not create privacy history",
            idempotencyKey,
          },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: "RESEARCH_SELECTION_INVALID" });
        expect(privacyWriteCounts(value.connection)).toEqual(before);
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("stores and idempotently replays zero receipts for existing targets without runs", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "empty-redaction-page");
      const resource = seedResource(value.connection, "custom:empty-redaction-resource");
      const expected = {
        sources: 0,
        snapshots: 0,
        evidence: 0,
        reports: 0,
        runs: 0,
        cancelledJobs: 0,
      };
      for (const [idempotencyKey, target] of [
        ["redact-existing-empty-page", { type: "page", logicalPageId: page.logicalPageId }],
        ["redact-existing-empty-resource", {
          type: "resource",
          resourceId: resource.resourceId,
        }],
      ] as const) {
        const payload = {
          target: { type: "target", target },
          reason: "Record an idempotent empty privacy decision",
          idempotencyKey,
        };
        const first = await value.app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: value.headers,
          payload,
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual(expected);
        const afterFirst = privacyWriteCounts(value.connection);
        const replay = await value.app.inject({
          method: "POST",
          url: "/api/research/redactions",
          headers: value.headers,
          payload,
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(expected);
        expect(privacyWriteCounts(value.connection)).toEqual(afterFirst);
      }
      expect(privacyWriteCounts(value.connection)).toEqual({ requests: 2, receipts: 2 });
    } finally {
      await closeFixture(value);
    }
  });

  it("redacts retained research history after its Resource is merged", async () => {
    const value = await fixture();
    try {
      const page = seedPage(value.connection, "merged-resource-history", "retained evidence");
      const source = seedResource(value.connection, "custom:resource-with-history");
      const mergeTarget = seedResource(value.connection, "custom:resource-merge-target");
      assignPageToResource(value.connection, page.logicalPageId, source.resourceId);
      const request = preflightRequest({ type: "resource", resourceId: source.resourceId });
      const preflightResponse = await value.app.inject({
        method: "POST",
        url: "/api/research/preflight",
        headers: value.headers,
        payload: request,
      });
      expect(preflightResponse.statusCode).toBe(200);
      const preflight = preflightResponse.json();
      const run = await value.app.inject({
        method: "POST",
        url: "/api/research/runs",
        headers: value.headers,
        payload: {
          ...request,
          estimate: preflight.estimate,
          approvalFingerprint: preflight.approvalFingerprint,
          idempotencyKey: "merged-resource-history-run",
        },
      });
      expect(run.statusCode, JSON.stringify(run.json())).toBe(202);

      mergeResource(value.connection, source, mergeTarget.resourceId);
      const redaction = await value.app.inject({
        method: "POST",
        url: "/api/research/redactions",
        headers: value.headers,
        payload: {
          target: {
            type: "target",
            target: { type: "resource", resourceId: source.resourceId },
          },
          reason: "Merged Resource history must remain redactable",
          idempotencyKey: "redact-merged-resource-history",
        },
      });
      expect(redaction.statusCode).toBe(200);
      expect(redaction.json()).toEqual({
        sources: 1,
        snapshots: 0,
        evidence: 0,
        reports: 0,
        runs: 1,
        cancelledJobs: 1,
      });
      expect(value.connection.prepare(`
        SELECT state FROM research_source_heads ORDER BY source_id LIMIT 1
      `).pluck().get()).toBe("redacted");
      expect(value.connection.prepare(`
        SELECT status, cancellation_requested_by, cancellation_requested_at
        FROM ai_jobs ORDER BY id LIMIT 1
      `).get()).toEqual({
        status: "running",
        cancellation_requested_by: "user",
        cancellation_requested_at: NOW,
      });
    } finally {
      await closeFixture(value);
    }
  });
});
