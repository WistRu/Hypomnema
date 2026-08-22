import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  buildPrivacyPurgeDerivedSourceGuards,
  buildPrivacyPurgeExpectedViews,
  buildPrivacyPurgeMutationFences,
  buildPrivacyPurgeRootGuards,
} from "../src/privacy-purge-fence-spec.js";
import {
  adoptLegacy25PrivacyPurgeTerminals,
  createPrivacyPurgeIntentStore,
  installPrivacyPurgeIntentCapabilities,
} from "../src/privacy-purge-intent-capabilities.js";
import {
  liveResearchFixtureAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";
import { createTrackedC90ClaimExecutor,
  TrackedC90AbortError } from "../src/research-acquisition-coordinator.js";
import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { createResearchStore } from "../src/research-store.js";
import { createLiveAcquisitionWorkflow } from "../src/live-acquisition-workflow.js";
import { classifyPublicDnsAnswers } from "../src/live-acquisition-policy.js";
import { createPrivacyPurgeCoordinator } from "../src/privacy-purge-coordinator.js";

const AT = "2026-08-21T12:00:00.000Z";
const E2E_AT = "2026-08-15T09:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function trackedExecutionDigest(input: {
  jobId: number; attemptId: number; attemptNo: number; leaseTokenDigest: string;
}): string {
  return sha256(`tabhub:c90-tracked-execution:v1\0${JSON.stringify(input)}`);
}

function acknowledgedAbort(input: {
  actionId: number; jobId: number; attemptId: number; attemptNo: number;
  leaseTokenDigest: string; executionKeyDigest: string; abortRequestDigest: string;
}) {
  const base = {
    status: "acknowledged" as const,
    ...input,
    signalled: true as const,
    settled: true as const,
    settlement: "fulfilled" as const,
  };
  return { ...base, acknowledgementDigest: sha256(
    `tabhub:c90-tracked-abort-ack:v1\0${JSON.stringify(base)}`,
  ) };
}

function alreadySettledAbort(input: {
  actionId: number; jobId: number; attemptId: number; attemptNo: number;
  leaseTokenDigest: string; executionKeyDigest: string; abortRequestDigest: string;
}) {
  const base = {
    status: "already_settled" as const,
    ...input,
    signalled: false as const,
    settled: true as const,
    settlement: "fulfilled" as const,
    terminalOutcome: "settled_after_external_abort" as const,
  };
  return { ...base, resultDigest: sha256(
    `tabhub:c90-tracked-settled:v1\0${JSON.stringify(base)}`,
  ) };
}

function installSchema26(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeIntentCapabilities(connection);
  connection.exec(readFileSync(
    new URL("../migrations/026_privacy_purge_intents.sql", import.meta.url),
    "utf8",
  ));
  for (const sql of buildPrivacyPurgeExpectedViews(connection)) connection.exec(sql);
  for (const fence of buildPrivacyPurgeMutationFences(connection)) connection.exec(fence.sql);
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) connection.exec(sql);
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

async function productionE2eFixture() {
  let currentAt = E2E_AT;
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(E2E_AT),
  });
  const { connection } = database;
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed',
      'https://www.cloudflare.com/seed', '${E2E_AT}', '${E2E_AT}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (7001, 'https://www.cloudflare.com/seed', 'https://www.cloudflare.com/seed',
      'Seed', 'chrome', 'inbox', 0, 1, '${E2E_AT}', '${E2E_AT}', 7001);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision)
      VALUES (7001, 'captured seed evidence', '${E2E_AT}', 1);
    INSERT INTO resources (id, resource_key, created_at)
      VALUES (7001, 'host:cloudflare.com', '${E2E_AT}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (7001, 7001, 1, 'Cloudflare', 'website', 'public', 'active',
      'system', 'derived', '${E2E_AT}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (7001, 7001);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES (7001, 7001, 'assigned', 7001, 'registrable_domain', 'system',
      'derived', 'seed', '${E2E_AT}');
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      VALUES (7001, 7001);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible,
      research_exclusion_reason, created_at
    ) VALUES (7001, 7001, 'matched', 'explicit_alias', 7001, 7001,
      '[]', 'seed-resolution', 1, NULL, '${E2E_AT}');
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
      VALUES (7001, 7001);
    INSERT INTO resource_match_rules (
      id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (7001, 'cloudflare-test', 1, 7001, 'cloudflare.com', 'suffix_host', '/',
      100, 'system_seed', 'system', 'derived', '${E2E_AT}');
    INSERT INTO resource_match_rule_heads (rule_key, rule_id)
      VALUES ('cloudflare-test', 7001);
  `);
  const research = createResearchStore(connection, { clock: () => new Date(currentAt) });
  const workflow = createLiveAcquisitionWorkflow({
    connection, research, clock: () => new Date(currentAt),
    digestKey: () => Buffer.alloc(32, 7),
    provider: {
      metadata: { provider: "anthropic", model: "test", promptVersion: "p1",
        pricingVersion: "price1" },
      quote: (input) => ({ version: "research_provider_quote:v1",
        inputDigest: sha256("provider-input"), calls: 1,
        inputTokens: 2_000, outputTokens: 8_192,
        costUsd: 0.25, wallTimeMs: 120_000 }),
    },
  });
  const request = {
    version: 1 as const,
    research: { version: 1 as const,
      target: { type: "resource" as const, resourceId: 7001 },
      question: "What should be researched?", includeShareableContext: false,
      maxIncludedSources: 10, parentReportId: null,
      budget: { maxSteps: 100, maxTokens: 20_000, maxCostUsd: 1,
        maxWallTimeMs: 420_000 },
      captureIntent: { selectedTabIds: [7001], knownFailures: [] },
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
    },
    approvedOrigins: ["https://www.cloudflare.com"],
    limits: { maxPages: 10, maxDepth: 1, durationMs: 300_000, maxCostUsd: 1 },
  };
  const preflight = workflow.preflight(request);
  const receipt = workflow.start({ version: 1, preflight: request,
    approvalFingerprint: preflight.approvalFingerprint,
    researchApprovalFingerprint: preflight.researchApprovalFingerprint,
    idempotencyKey: "privacy-purge-e2e-start" });
  const jobId = Number(receipt.id.split(":")[1]);
  const consentId = Number(connection.prepare(`
    SELECT id FROM live_acquisition_consents WHERE coordinator_job_id = ?
  `).pluck().get(jobId));
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(currentAt), token: () => `privacy-purge-e2e-claim-${currentAt}`,
    kindAvailable: (kind) => kind === "resource_research", research,
  });
  let claim = ledger.claimNext("resource_research", "privacy-purge-e2e-worker",
    { maxConcurrent: 1, maxAttemptsPerUtcDay: 20, maxCostUsdPerUtcDay: null },
    undefined, [{ id: "research_acquisition:c90:v1", version: 1 }]);
  if (claim === undefined) throw new Error("expected production C90 claim");
  const executor = createTrackedC90ClaimExecutor({ ledger,
    executeClaim: async (_claim, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  });
  executor.runTrackedClaim(claim);
  await Promise.resolve();
  await Promise.resolve();
  claim = ledger.refresh(claim);
  const actions = createLiveAcquisitionActionLedger(connection, {
    clock: () => new Date(currentAt),
  });
  const action = actions.planRobots({ consentId,
    canonicalOrigin: "https://www.cloudflare.com" });
  actions.beginResolution(action.id);
  const resolution = classifyPublicDnsAnswers([{ address: "1.1.1.1", family: 4 }]);
  if (resolution.kind !== "allowed") throw new Error("expected public DNS answer");
  actions.recordResolution(action.id, resolution);
  actions.authorize(action.id);
  actions.start(action.id);
  installSchema26(connection);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(jobId));
  const intentKey = sha256("privacy-purge-production-e2e-intent");
  const identity = { idempotencyKeyHash: sha256("privacy-purge-production-e2e-idem"),
    requestFingerprint: sha256("privacy-purge-production-e2e-request"),
    targetKind: "run" as const, subjectGenerationId, historyEpochId: null };
  const store = createPrivacyPurgeIntentStore(connection, { clock: () => new Date(currentAt) });
  store.publishWaiting({ intentKey,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestFingerprint: identity.requestFingerprint,
    target: { kind: "run", subjectGenerationId } });
  return { database, connection, ledger, claim, executor,
    actionId: action.id, intentKey, identity,
    setAt: (at: string) => { currentAt = at; } };
}

function withoutTableTriggers(
  connection: ReturnType<typeof openDatabase>["connection"],
  tableName: string,
  operation: () => void,
): void {
  const triggers = connection.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ? ORDER BY name
  `).all(tableName) as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) {
    if (!/^[a-z0-9_]+$/i.test(trigger.name)) throw new Error("unsafe trigger name");
    connection.exec(`DROP TRIGGER "${trigger.name}";`);
  }
  try {
    operation();
  } finally {
    for (const trigger of triggers) connection.exec(trigger.sql);
  }
}

function fixture(actionCount = 2) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(AT),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const ownership = connection.prepare(`
    SELECT coordinator_run_generation_id, runtime_epoch,
      resource_generation_id, history_epoch_id
    FROM live_acquisition_actions WHERE id = 7001
  `).get() as {
    coordinator_run_generation_id: number;
    runtime_epoch: number;
    resource_generation_id: number;
    history_epoch_id: number;
  };
  const actionIds: number[] = [];
  for (let ordinal = 0; ordinal < actionCount; ordinal += 1) {
    const actionId = 8_001 + ordinal;
    actionIds.push(actionId);
    connection.prepare(`
      INSERT INTO live_acquisition_actions (
        id, consent_id, coordinator_run_generation_id, resource_generation_id,
        history_epoch_id, runtime_epoch, action_kind, depth,
        discovered_from_action_id, canonical_fetch_url_fingerprint,
        canonical_origin_digest, action_key_digest, state, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, 'page', 0, NULL, ?, NULL, ?, 'planned', ?)
    `).run(
      actionId,
      ownership.coordinator_run_generation_id,
      ownership.resource_generation_id,
      ownership.history_epoch_id,
      ownership.runtime_epoch,
      sha256(`fetch-${actionId}`),
      sha256(`action-${actionId}`),
      AT,
    );
    connection.prepare(`
      INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
      VALUES (?, ?, ?)
    `).run(actionId, `https://www.cloudflare.com/robots-${actionId}.txt`, sha256(`url-${actionId}`));
    connection.prepare(`
      INSERT INTO live_acquisition_action_events (
        action_id, sequence_no, from_state, to_state, outcome_code,
        safe_details_json, occurred_at
      ) VALUES (?, 1, 'planned', 'planned', NULL, '{}', ?)
    `).run(actionId, AT);
  }
  installSchema26(connection);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const intentKey = sha256("action-drain-intent");
  const idempotencyKeyHash = sha256("action-drain-idempotency");
  const requestFingerprint = sha256("action-drain-request");
  const store = createPrivacyPurgeIntentStore(connection, { clock: () => new Date(AT) });
  store.publishWaiting({
    intentKey,
    idempotencyKeyHash,
    requestFingerprint,
    target: { kind: "run", subjectGenerationId },
  });
  return {
    database, connection, intentKey, actionIds, store,
    identity: {
      idempotencyKeyHash,
      requestFingerprint,
      targetKind: "run" as const,
      subjectGenerationId,
      historyEpochId: null,
    },
  };
}

function resolutionFixture(
  mode: "boundary" | "prior" | "predeadline" | "started",
  corruptStartEvent?: "missing" | "wrong",
  startedActionCount = 1,
) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(liveResearchFixtureAt),
  });
  const { connection } = database;
  const live = seedReceiptBackedLiveResearchRun(connection);
  const owner = connection.prepare(`
    SELECT consent.coordinator_run_generation_id, consent.resource_generation_id,
      consent.history_epoch_id, consent.runtime_epoch, consent.expires_at
    FROM live_acquisition_consents AS consent WHERE consent.id = 1
  `).get() as {
    coordinator_run_generation_id: number;
    resource_generation_id: number;
    history_epoch_id: number;
    runtime_epoch: number;
    expires_at: string;
  };
  const actionId = 8_101;
  connection.prepare(`
    INSERT INTO live_acquisition_actions (
      id, consent_id, coordinator_run_generation_id, resource_generation_id,
      history_epoch_id, runtime_epoch, action_kind, depth,
      discovered_from_action_id, canonical_fetch_url_fingerprint,
      canonical_origin_digest, action_key_digest, state, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, 'robots', NULL, NULL, NULL, ?, ?, 'planned', ?)
  `).run(
    actionId,
    owner.coordinator_run_generation_id,
    owner.resource_generation_id,
    owner.history_epoch_id,
    owner.runtime_epoch,
    sha256("resolution-origin"),
    sha256("resolution-action"),
    liveResearchFixtureAt,
  );
  connection.prepare(`
    INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
    VALUES (?, 'https://www.cloudflare.com/robots.txt', ?)
  `).run(actionId, sha256("resolution-url"));
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 1, 'planned', 'planned', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 2, 'planned', 'resolution_started', NULL, '{}', ?)
  `).run(actionId, liveResearchFixtureAt);
  if (corruptStartEvent === "missing") {
    connection.exec(`DROP TRIGGER live_acquisition_action_events_immutable_delete;`);
    connection.prepare(`
      DELETE FROM live_acquisition_action_events
      WHERE action_id = ? AND sequence_no = 2
    `).run(actionId);
  } else if (corruptStartEvent === "wrong") {
    connection.exec(`DROP TRIGGER live_acquisition_action_events_immutable_update;`);
    connection.prepare(`
      UPDATE live_acquisition_action_events SET from_state = 'resolution_started'
      WHERE action_id = ? AND sequence_no = 2
    `).run(actionId);
  }
  if (mode === "started") {
    connection.prepare(`
      INSERT INTO live_acquisition_dns_payloads (
        action_id, answers_json, selected_ipv4, resolved_at
      ) VALUES (?, '["203.0.113.1"]', '203.0.113.1', ?)
    `).run(actionId, liveResearchFixtureAt);
    connection.prepare(`
      INSERT INTO live_acquisition_action_events (
        action_id, sequence_no, from_state, to_state, outcome_code,
        safe_details_json, occurred_at
      ) VALUES (?, 3, 'resolution_started', 'resolved', NULL, '{}', ?)
    `).run(actionId, liveResearchFixtureAt);
    const startedActionIds = [actionId];
    for (let index = 1; index < startedActionCount; index += 1) {
      const extraActionId = actionId + index;
      startedActionIds.push(extraActionId);
      withoutTableTriggers(connection, "live_acquisition_actions", () => {
        connection.prepare(`
          INSERT INTO live_acquisition_actions (
            id, consent_id, coordinator_run_generation_id, resource_generation_id,
            history_epoch_id, runtime_epoch, action_kind, depth,
            discovered_from_action_id, canonical_fetch_url_fingerprint,
            canonical_origin_digest, action_key_digest, state, created_at
          ) SELECT ?, consent_id, coordinator_run_generation_id, resource_generation_id,
            history_epoch_id, runtime_epoch, action_kind, depth,
            discovered_from_action_id, canonical_fetch_url_fingerprint,
            ?, ?, 'planned', created_at
          FROM live_acquisition_actions WHERE id = ?
        `).run(extraActionId, sha256(`resolution-origin-${index}`),
          sha256(`resolution-action-${index}`), actionId);
      });
      connection.prepare(`
        INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
        VALUES (?, ?, ?)
      `).run(extraActionId,
        `https://www.cloudflare.com/robots-${extraActionId}.txt`,
        sha256(`resolution-url-${index}`));
      for (const sequenceNo of [1, 2]) {
        connection.prepare(`
          INSERT INTO live_acquisition_action_events (
            action_id, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          ) SELECT ?, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          FROM live_acquisition_action_events
          WHERE action_id = ? AND sequence_no = ?
        `).run(extraActionId, actionId, sequenceNo);
      }
      connection.prepare(`
        INSERT INTO live_acquisition_dns_payloads (
          action_id, answers_json, selected_ipv4, resolved_at
        ) SELECT ?, answers_json, selected_ipv4, resolved_at
          FROM live_acquisition_dns_payloads WHERE action_id = ?
      `).run(extraActionId, actionId);
      connection.prepare(`
        INSERT INTO live_acquisition_action_events (
          action_id, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        ) SELECT ?, sequence_no, from_state, to_state, outcome_code,
          safe_details_json, occurred_at
        FROM live_acquisition_action_events
        WHERE action_id = ? AND sequence_no = 3
      `).run(extraActionId, actionId);
      connection.prepare(`
        INSERT INTO live_acquisition_action_authorizations (
          action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
          authorized_at, expires_at
        ) SELECT ?, runtime_epoch, selected_ipv4_digest, ?, authorized_at, expires_at
          FROM live_acquisition_action_authorizations WHERE action_id = ?
      `).run(extraActionId, sha256(`started-authorization-${index}`), actionId);
    }
    connection.prepare(`
      INSERT INTO live_acquisition_action_authorizations (
        action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
        authorized_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(actionId, owner.runtime_epoch, sha256("started-selected-ip"),
      sha256("started-authorization"),
      liveResearchFixtureAt, owner.expires_at);
    connection.prepare(`
      INSERT INTO live_acquisition_action_events (
        action_id, sequence_no, from_state, to_state, outcome_code,
        safe_details_json, occurred_at
      ) VALUES (?, 4, 'resolved', 'authorized', NULL, '{}', ?)
    `).run(actionId, liveResearchFixtureAt);
    connection.prepare(`
      INSERT INTO live_acquisition_action_events (
        action_id, sequence_no, from_state, to_state, outcome_code,
        safe_details_json, occurred_at
      ) VALUES (?, 5, 'authorized', 'started', NULL, '{}', ?)
    `).run(actionId, liveResearchFixtureAt);
    for (const [index, extraActionId] of startedActionIds.slice(1).entries()) {
      connection.prepare(`
        INSERT INTO live_acquisition_action_authorizations (
          action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
          authorized_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(extraActionId, owner.runtime_epoch, sha256("started-selected-ip"),
        sha256(`started-authorization-${index + 1}`),
        liveResearchFixtureAt, owner.expires_at);
      for (const sequenceNo of [4, 5]) {
        connection.prepare(`
          INSERT INTO live_acquisition_action_events (
            action_id, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          ) SELECT ?, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          FROM live_acquisition_action_events
          WHERE action_id = ? AND sequence_no = ?
        `).run(extraActionId, actionId, sequenceNo);
      }
    }
    const attemptId = 9901;
    const leaseToken = "started-action-exact-lease";
    withoutTableTriggers(connection, "ai_job_attempts", () => {
      connection.prepare(`
        INSERT INTO ai_job_attempts (
          id, job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (9901, ?, 1, ?, 'started-action-worker', ?, 'running')
      `).run(live.coordinatorJobId, leaseToken, liveResearchFixtureAt);
    });
    withoutTableTriggers(connection, "ai_jobs", () => {
      connection.prepare(`
        UPDATE ai_jobs SET status = 'superseded', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(liveResearchFixtureAt, liveResearchFixtureAt, live.finalJobId);
      connection.prepare(`
        UPDATE ai_jobs SET status = 'running', attempts = 1,
          lease_owner = 'started-action-worker', lease_token = ?,
          lease_expires_at = ?, started_at = ?, completed_at = NULL,
          updated_at = ? WHERE id = ?
      `).run(leaseToken, owner.expires_at, liveResearchFixtureAt,
        liveResearchFixtureAt, live.coordinatorJobId);
    });
    const checkpointJson = JSON.stringify({
      version: 1,
      stage: "acquiring",
      consentId: 1,
      runtimeEpoch: owner.runtime_epoch,
      counters: {
        reservedPages: 0, visitedPages: 0, capturedPages: 0,
        blockedPages: 0, ambiguousPages: 0, robotsActions: 1,
        networkActions: 1,
      },
      queue: { plannedActionIds: [], activeActionIds: startedActionIds },
    });
    connection.prepare(`
      INSERT INTO live_acquisition_checkpoints (
        attempt_id, coordinator_job_id, consent_id, runtime_epoch,
        checkpoint_json, checkpoint_digest, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(attemptId, live.coordinatorJobId, owner.runtime_epoch, checkpointJson,
      sha256(checkpointJson), liveResearchFixtureAt);
  }
  if (mode === "prior") {
    connection.prepare(`
      UPDATE live_acquisition_runtime_state
      SET runtime_epoch = runtime_epoch + 1, updated_at = ? WHERE singleton_id = 1
    `).run(liveResearchFixtureAt);
  }
  installSchema26(connection);
  const resolutionDeadline = new Date(Date.parse(liveResearchFixtureAt) + 3_000).toISOString();
  const now = mode === "boundary" ? resolutionDeadline
    : mode === "predeadline"
    ? new Date(Date.parse(resolutionDeadline) - 1).toISOString()
    : new Date(Date.parse(owner.expires_at) - 1).toISOString();
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const intentKey = sha256(`resolution-${mode}-intent`);
  const idempotencyKeyHash = sha256(`resolution-${mode}-idempotency`);
  const requestFingerprint = sha256(`resolution-${mode}-request`);
  const store = createPrivacyPurgeIntentStore(connection, { clock: () => new Date(now) });
  store.publishWaiting({
    intentKey,
    idempotencyKeyHash,
    requestFingerprint,
    target: { kind: "run", subjectGenerationId },
  });
  return {
    database, connection, actionId, actionIds: mode === "started"
      ? Array.from({ length: startedActionCount }, (_, index) => actionId + index)
      : [actionId], intentKey, store, now, resolutionDeadline,
    consentExpiresAt: owner.expires_at,
    identity: {
      idempotencyKeyHash,
      requestFingerprint,
      targetKind: "run" as const,
      subjectGenerationId,
      historyEpochId: null,
    },
  };
}

function forgeActionQuiescence(
  connection: ReturnType<typeof openDatabase>["connection"],
  intentKey: string,
): void {
  connection.exec(`
    DROP TRIGGER privacy_purge_intent_action_waits_terminal_update;
    DROP TRIGGER privacy_purge_intents_update_guard;
  `);
  const forged = "d".repeat(64);
  connection.prepare(`
    UPDATE privacy_purge_intent_action_waits
    SET quiescence_snapshot_digest = ? WHERE intent_key = ?
  `).run(forged, intentKey);
  connection.prepare(`
    UPDATE privacy_purge_intents
    SET action_quiescence_digest = ? WHERE intent_key = ?
  `).run(sha256(JSON.stringify([forged])), intentKey);
}

function rebindResultToForgedActionQuiescence(
  connection: ReturnType<typeof openDatabase>["connection"],
  intentKey: string,
): void {
  const row = connection.prepare(`
    SELECT execution_plan_digest, action_quiescence_digest,
      carryover_manifest_count, carryover_manifest_digest,
      terminal_evidence_digest
    FROM privacy_purge_intents WHERE intent_key = ?
  `).get(intentKey) as {
    execution_plan_digest: string;
    action_quiescence_digest: string;
    carryover_manifest_count: number;
    carryover_manifest_digest: string;
    terminal_evidence_digest: string;
  };
  const resultDigest = sha256(JSON.stringify({
    version: "tabhub:privacy-purge:result:v3",
    intentKey,
    planDigest: row.execution_plan_digest,
    actionQuiescenceDigest: row.action_quiescence_digest,
    carryoverManifestCount: row.carryover_manifest_count,
    carryoverManifestDigest: row.carryover_manifest_digest,
    terminalEvidenceDigest: row.terminal_evidence_digest,
  }));
  connection.prepare(`
    UPDATE privacy_purge_intents SET result_digest = ? WHERE intent_key = ?
  `).run(resultDigest, intentKey);
}

function deleteFrozenActionWaits(
  connection: ReturnType<typeof openDatabase>["connection"],
  intentKey: string,
  whereSql = "1 = 1",
): void {
  connection.exec(`DROP TRIGGER privacy_purge_intent_action_waits_delete_guard;`);
  connection.prepare(`
    DELETE FROM privacy_purge_intent_action_waits
    WHERE intent_key = ? AND ${whereSql}
  `).run(intentKey);
}

function prepareCommittedResolution() {
  const value = resolutionFixture("boundary");
  value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 });
  value.store.freezeReady(value.intentKey);
  const commandId = value.store.linkReadyCommand(value.identity);
  return { ...value, commandId };
}

function observeAuthoritiesAndDeleteWaitAfter(
  value: ReturnType<typeof prepareCommittedResolution>,
  authorityOrdinal: number | null,
): void {
  value.connection.exec(`
    CREATE TEMP TABLE observed_privacy_purge_authorities (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      pk_v1 TEXT NOT NULL
    );
    CREATE TEMP TRIGGER observe_privacy_purge_authority
    AFTER INSERT ON privacy_purge_authorities
    WHEN NEW.command_id = ${value.commandId}
    BEGIN
      INSERT INTO observed_privacy_purge_authorities (table_name, pk_v1)
      VALUES (NEW.table_name, NEW.pk_v1);
      DELETE FROM privacy_purge_intent_action_waits
      WHERE intent_key = '${value.intentKey}'
        AND ${authorityOrdinal === null ? "0" :
          `(SELECT COUNT(*) FROM observed_privacy_purge_authorities) = ${authorityOrdinal}`};
    END;
  `);
}

function deleteWaitAfterAuthorityRemoval(
  value: ReturnType<typeof prepareCommittedResolution>,
  removalOrdinal: number,
): void {
  value.connection.exec(`
    CREATE TEMP TABLE observed_privacy_purge_authority_removals (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TEMP TRIGGER mutate_after_privacy_purge_authority_removal
    AFTER DELETE ON privacy_purge_authorities
    WHEN OLD.command_id = ${value.commandId}
    BEGIN
      INSERT INTO observed_privacy_purge_authority_removals (ordinal)
      VALUES (NULL);
      DELETE FROM privacy_purge_intent_action_waits
      WHERE intent_key = '${value.intentKey}'
        AND (SELECT COUNT(*)
          FROM observed_privacy_purge_authority_removals) = ${removalOrdinal};
    END;
  `);
}

function dropActionEventDeleteGuards(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  const guards = connection.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'live_acquisition_action_events'
  `).all() as Array<{ name: string; sql: string }>;
  for (const guard of guards.filter((row) => /BEFORE\s+DELETE/i.test(row.sql))) {
    if (!/^[a-z0-9_]+$/i.test(guard.name)) throw new Error("unsafe trigger name");
    connection.exec(`DROP TRIGGER "${guard.name}";`);
  }
}

function assertNoExecutedPurgeEffects(
  value: ReturnType<typeof prepareCommittedResolution>,
): void {
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM privacy_purge_intent_action_waits
    WHERE intent_key = ?
  `).pluck().get(value.intentKey))).toBe(1);
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM live_acquisition_actions WHERE id = ?
  `).pluck().get(value.actionId))).toBe(1);
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = ?
  `).pluck().get(value.commandId))).toBe(0);
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM privacy_purge_action_quiescence_attestations
    WHERE command_id = ?
  `).pluck().get(value.commandId))).toBe(0);
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = ?
  `).pluck().get(value.commandId))).toBe(0);
  expect(Number(value.connection.prepare(`
    SELECT COUNT(*) FROM privacy_purge_intent_receipts
    WHERE purge_command_id = ?
  `).pluck().get(value.commandId))).toBe(0);
}

describe("schema026 bounded action drain", () => {
  it("runs production C90 abort through committed purge and cascades provenance", async () => {
    const value = await productionE2eFixture();
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(E2E_AT),
        trackedC90Executor: value.executor,
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "terminalized", outcome: "acknowledged" });
      const afterLease = new Date(
        Date.parse(value.claim.leaseExpiresAt) + 1,
      ).toISOString();
      value.setAt(afterLease);
      const finishing = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(afterLease),
      });
      expect(finishing.terminalizeResourceResearchJobWaits(
        value.intentKey, { maxJobs: 1 },
      )).toMatchObject({ terminalized: 1, adopted: 1, remaining: 0 });
      expect(finishing.reconcileJobWaits(value.intentKey, { maxJobs: 1 }).remaining).toBe(0);
      expect(finishing.freezeReady(value.intentKey).status).toBe("ready");
      const commandId = finishing.linkReadyCommand(value.identity);

      finishing.executeCommitted(commandId);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionId))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_abort_provenance
      `).pluck().get())).toBe(0);
      // A production-valid unrelated provenance row cannot coexist here:
      // schema 26 permits only one active purge intent, while executing the
      // intent that owns such a row necessarily removes that row with its action.
      // Direct deletion is covered separately and remains fail-closed.
    } finally {
      value.database.close();
    }
  });

  it("two-phase aborts one exact active started action without holding SQLite", async () => {
    const value = resolutionFixture("started");
    try {
      let calls = 0;
      let clockCalls = 0;
      const receivedAt = new Date(Date.parse(value.now) + 1_000).toISOString();
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(clockCalls++ === 0 ? value.now : receivedAt),
        trackedC90Executor: {
          abortAndWait: async (input) => {
            calls += 1;
            expect(value.connection.inTransaction).toBe(false);
            expect(input).toMatchObject({
              actionId: value.actionId,
              jobId: 7001,
              attemptId: 9901,
              attemptNo: 1,
              leaseTokenDigest: sha256("started-action-exact-lease"),
            });
            return acknowledgedAbort(input);
          },
        },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({
          intentKey: value.intentKey, ordinal: 0,
          status: "terminalized", outcome: "acknowledged",
        });
      expect(calls).toBe(1);
      expect(value.connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual({ state: "ambiguous", sequence_no: 6 });
      expect(value.connection.prepare(`
        SELECT terminal_state, terminal_sequence_no
        FROM privacy_purge_intent_action_waits WHERE intent_key = ?
      `).get(value.intentKey)).toEqual({
        terminal_state: "ambiguous", terminal_sequence_no: 6,
      });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(1);
      expect(value.connection.prepare(`
        SELECT requested_at FROM privacy_purge_action_abort_requests
        WHERE intent_key = ?
      `).pluck().get(value.intentKey)).toBe(value.now);
      expect(value.connection.prepare(`
        SELECT received_at FROM privacy_purge_action_abort_receipts
        WHERE intent_key = ?
      `).pluck().get(value.intentKey)).toBe(receivedAt);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("commits Phase A before await and snapshots an ordinal getter once", async () => {
    const value = resolutionFixture("started");
    try {
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: (result: ReturnType<typeof acknowledgedAbort>) => void;
      let captured!: Parameters<typeof acknowledgedAbort>[0];
      const bridge = new Promise<ReturnType<typeof acknowledgedAbort>>(
        (resolve) => { release = resolve; },
      );
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          captured = input;
          expect(value.connection.inTransaction).toBe(false);
          entered();
          return bridge;
        } },
      });
      let reads = 0;
      const input = Object.defineProperty({}, "maxActions", {
        get: () => { reads += 1; return 1; },
      }) as { readonly maxActions: number };
      const completing = store.abortStartedActionWait(value.intentKey, input);
      await enteredPromise;
      expect(reads).toBe(1);
      expect(value.connection.inTransaction).toBe(false);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
      release(acknowledgedAbort(captured));
      await expect(completing).resolves.toMatchObject({ status: "terminalized" });
    } finally {
      value.database.close();
    }
  });

  it("processes a bounded ordinal prefix and stops the suffix at the first pending barrier", async () => {
    const value = resolutionFixture("started", undefined, 3);
    try {
      const called: number[] = [];
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          called.push(input.actionId);
          if (called.length === 2) {
            throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
          }
          return acknowledgedAbort(input);
        } },
      });
      const result = await store.abortStartedActionWait(value.intentKey, {
        maxActions: 3,
      });
      expect(called).toEqual(value.actionIds.slice(0, 2));
      expect(result).toMatchObject({ processed: 1, remaining: 2 });
      expect(result.results.map(({ ordinal, status }) => ({ ordinal, status })))
        .toEqual([
          { ordinal: 0, status: "terminalized" },
          { ordinal: 1, status: "pending" },
        ]);
      expect(value.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionIds[2]!)).toBe("started");
    } finally {
      value.database.close();
    }
  });

  it("rolls back Phase B and resumes from the trusted cached bridge result", async () => {
    const value = resolutionFixture("started");
    try {
      let calls = 0;
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        testOnlyFailActionAbortPhaseBOnce: true,
        trackedC90Executor: { abortAndWait: async (input) => {
          calls += 1;
          return acknowledgedAbort(input);
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("TEST_ONLY_ACTION_ABORT_PHASE_B_ROLLBACK");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
      expect(value.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionId)).toBe("started");
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "terminalized", outcome: "acknowledged" });
      expect(calls).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("deduplicates concurrent aborts and replays a receipt without the bridge", async () => {
    const value = resolutionFixture("started");
    try {
      let calls = 0;
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          calls += 1;
          await Promise.resolve();
          return acknowledgedAbort(input);
        } },
      });
      const [first, second] = await Promise.all([
        store.abortStartedActionWait(value.intentKey, { maxActions: 1 }),
        store.abortStartedActionWait(value.intentKey, { maxActions: 1 }),
      ]);
      expect(first.status).toBe("terminalized");
      expect(second.status).toBe("terminalized");
      expect(calls).toBe(1);
      await store.abortStartedActionWait(value.intentKey, { maxActions: 1 });
      expect(calls).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("keeps cross-store concurrent aborts exact without duplicate terminalization", async () => {
    const value = resolutionFixture("started");
    try {
      let release!: (result: ReturnType<typeof acknowledgedAbort>) => void;
      let firstInput!: Parameters<typeof acknowledgedAbort>[0];
      const bridge = new Promise<ReturnType<typeof acknowledgedAbort>>(
        (resolve) => { release = resolve; },
      );
      let calls = 0;
      const executor = { abortAndWait: async (input: Parameters<
        typeof acknowledgedAbort>[0]) => {
        calls += 1;
        if (calls === 1) {
          firstInput = input;
          return bridge;
        }
        throw new TrackedC90AbortError("C90_ABORT_ALREADY_REQUESTED");
      } };
      const firstStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now), trackedC90Executor: executor,
      });
      const secondStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now), trackedC90Executor: executor,
      });
      const first = firstStore.abortStartedActionWait(value.intentKey, { maxActions: 1 });
      await Promise.resolve();
      await expect(secondStore.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "pending", processed: 0 });
      release(acknowledgedAbort(firstInput));
      await expect(first).resolves.toMatchObject({ status: "terminalized", processed: 1 });
      expect(calls).toBe(2);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("keeps known external-abort results pending and blocks sync adoption", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          const base = {
            status: "already_settled" as const, ...input,
            abortRequestDigest: null,
            signalled: false as const, settled: true as const,
            settlement: "fulfilled" as const,
            terminalOutcome: "settled_after_external_abort" as const,
          };
          return { ...base, resultDigest: sha256(
            `tabhub:c90-tracked-settled:v1\0${JSON.stringify(base)}`,
          ) };
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "pending" });
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 0, remaining: 1 });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("recovers a prior-epoch started request conservatively without the bridge", async () => {
    const value = resolutionFixture("started");
    try {
      value.connection.prepare(`
        UPDATE live_acquisition_runtime_state
        SET runtime_epoch = runtime_epoch + 1, updated_at = ? WHERE singleton_id = 1
      `).run(value.now);
      let calls = 0;
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          calls += 1;
          throw new Error("must not call bridge");
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({
          status: "terminalized", outcome: "prior_epoch_ambiguous",
        });
      expect(calls).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("recovers an immutable current-exact request after the runtime epoch advances", async () => {
    const value = resolutionFixture("started");
    try {
      const first = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
      });
      await expect(first.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "pending", processed: 0 });
      expect(value.connection.prepare(`
        SELECT request_kind FROM privacy_purge_action_abort_requests
        WHERE intent_key = ? AND ordinal = 0
      `).pluck().get(value.intentKey)).toBe("current_exact");

      value.connection.prepare(`
        UPDATE live_acquisition_runtime_state
        SET runtime_epoch = runtime_epoch + 1, updated_at = ? WHERE singleton_id = 1
      `).run(value.now);
      const recoveryEpoch = Number(value.connection.prepare(`
        SELECT runtime_epoch FROM live_acquisition_runtime_state WHERE singleton_id = 1
      `).pluck().get());
      let calls = 0;
      const restarted = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          calls += 1;
          throw new Error("must not call bridge after runtime restart");
        } },
      });
      await expect(restarted.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({
          status: "terminalized", outcome: "prior_epoch_recovery",
        });
      expect(calls).toBe(0);
      expect(value.connection.prepare(`
        SELECT outcome, bridge_status, recovery_runtime_epoch
        FROM privacy_purge_action_abort_receipts
        WHERE intent_key = ? AND ordinal = 0
      `).get(value.intentKey)).toEqual({
        outcome: "prior_epoch_recovery",
        bridge_status: "prior_epoch",
        recovery_runtime_epoch: recoveryEpoch,
      });
      await expect(restarted.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ processed: 0, remaining: 0 });
      expect(calls).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("adopts the real terminal event when the response wins", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          withoutTableTriggers(value.connection, "live_acquisition_action_events", () => {
            value.connection.prepare(`
              INSERT INTO live_acquisition_action_events (
                action_id, sequence_no, from_state, to_state, outcome_code,
                safe_details_json, occurred_at
              ) VALUES (?, 6, 'started', 'ambiguous', 'CANCELLED', '{}', ?)
            `).run(value.actionId, value.now);
          });
          withoutTableTriggers(value.connection, "live_acquisition_actions", () => {
            value.connection.prepare(`
              UPDATE live_acquisition_actions
              SET state = 'ambiguous', sequence_no = 6, terminal_at = ?
              WHERE id = ?
            `).run(value.now, value.actionId);
          });
          const base = {
            status: "already_settled" as const,
            ...input,
            abortRequestDigest: null,
            signalled: false as const,
            settled: true as const,
            settlement: "fulfilled" as const,
            terminalOutcome: "settled_without_abort" as const,
          };
          return { ...base, resultDigest: sha256(
            `tabhub:c90-tracked-settled:v1\0${JSON.stringify(base)}`,
          ) };
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "terminalized", outcome: "response_wins" });
      expect(value.connection.prepare(`
        SELECT terminal_sequence_no FROM privacy_purge_intent_action_waits
        WHERE intent_key = ?
      `).pluck().get(value.intentKey)).toBe(6);
    } finally {
      value.database.close();
    }
  });

  it("fails closed on bridge identity mismatch and checkpoint drift", async () => {
    const value = resolutionFixture("started");
    try {
      const mismatchStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => ({
          ...acknowledgedAbort(input), executionKeyDigest: "d".repeat(64),
        }) },
      });
      await expect(mismatchStore.abortStartedActionWait(
        value.intentKey, { maxActions: 1 },
      )).rejects.toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects a Phase B clock regression before any terminal mutation", async () => {
    const value = resolutionFixture("started");
    try {
      let current = value.now;
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(current),
        trackedC90Executor: { abortAndWait: async (input) => {
          current = "2026-01-01T00:00:00.000Z";
          return acknowledgedAbort(input);
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual({ state: "started", sequence_no: 5 });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("leaves a durable request pending for known bridge errors", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "pending" });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(1);
      expect(value.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionId)).toBe("started");
    } finally {
      value.database.close();
    }
  });

  it("guards immutable abort requests and rejects forged receipts", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        } },
      });
      await store.abortStartedActionWait(value.intentKey, { maxActions: 1 });
      expect(() => value.connection.prepare(`
        UPDATE privacy_purge_action_abort_requests SET requested_at = requested_at
      `).run()).toThrow("privacy purge action abort request is immutable");
      expect(() => value.connection.prepare(`
        DELETE FROM privacy_purge_action_abort_requests
      `).run()).toThrow("privacy purge action abort request is permanent");
      expect(() => value.connection.prepare(`
        INSERT INTO privacy_purge_action_abort_receipts (
          intent_key, ordinal, request_digest, outcome, bridge_result_digest,
          terminal_state, terminal_sequence_no, terminal_event_digest,
          terminal_at, receipt_digest, received_at
        ) SELECT intent_key, ordinal, request_digest, 'acknowledged',
          ?, 'ambiguous', 999, ?, requested_at, ?, requested_at
        FROM privacy_purge_action_abort_requests
      `).run("e".repeat(64), "f".repeat(64), "1".repeat(64)))
        .toThrow("invalid privacy purge action abort receipt");
    } finally {
      value.database.close();
    }
  });

  it("does not publish Phase A without the exact active attempt", async () => {
    const value = resolutionFixture("started");
    try {
      withoutTableTriggers(value.connection, "live_acquisition_checkpoints", () => {
        value.connection.prepare(`
          DELETE FROM live_acquisition_checkpoints WHERE attempt_id = 9901
        `).run();
      });
      withoutTableTriggers(value.connection, "ai_job_attempts", () => {
        value.connection.prepare(`DELETE FROM ai_job_attempts WHERE id = 9901`).run();
      });
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new Error("must not call");
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("PURGE_SUBJECT_BUSY");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rolls back Phase B when the exact checkpoint drifts during await", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async (input) => {
          withoutTableTriggers(value.connection, "live_acquisition_checkpoints", () => {
            value.connection.prepare(`
              UPDATE live_acquisition_checkpoints
              SET checkpoint_digest = ?, updated_at = ? WHERE attempt_id = 9901
            `).run("9".repeat(64), value.now);
          });
          return acknowledgedAbort(input);
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
      expect(value.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionId)).toBe("started");
    } finally {
      value.database.close();
    }
  });

  it("adopts exact durable abort provenance in a fresh store after Phase B crashes", async () => {
    const value = resolutionFixture("started");
    try {
      const first = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        testOnlyFailActionAbortPhaseBOnce: true,
        trackedC90Executor: { abortAndWait: async (input) => {
          createLiveAcquisitionActionLedger(value.connection, {
            clock: () => new Date(value.now),
          }).blockForPrivacyPurgeAbort(value.actionId, {
            requestDigest: input.abortRequestDigest,
            executionKeyDigest: input.executionKeyDigest,
          });
          return acknowledgedAbort(input);
        } },
      });
      await expect(first.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("TEST_ONLY_ACTION_ABORT_PHASE_B_ROLLBACK");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_abort_provenance
      `).pluck().get())).toBe(1);
      const durable = value.connection.prepare(`
        SELECT event.safe_details_json, provenance.request_digest
        FROM live_acquisition_action_abort_provenance AS provenance
        JOIN live_acquisition_action_events AS event ON event.id = provenance.event_id
      `).get() as { safe_details_json: string; request_digest: string };
      expect(durable.safe_details_json).toBe(JSON.stringify({
        outcome_class: "ambiguous",
        abort_request_digest: durable.request_digest,
      }));
      expect(() => value.connection.prepare(`
        DELETE FROM live_acquisition_action_abort_provenance
        WHERE request_digest = ?
      `).run(durable.request_digest))
        .toThrow("live acquisition action abort provenance is immutable");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);

      const restarted = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        } },
      });
      await expect(restarted.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "terminalized", outcome: "acknowledged" });
    } finally {
      value.database.close();
    }
  });

  it("rejects an unrelated external CANCELLED event after restart", async () => {
    const value = resolutionFixture("started");
    try {
      const first = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
      });
      await first.abortStartedActionWait(value.intentKey, { maxActions: 1 });
      const request = value.connection.prepare(`
        SELECT * FROM privacy_purge_action_abort_requests
      `).get() as Record<string, unknown>;
      expect(value.connection.prepare(`
        SELECT tabhub_purge26_external_abort_v1(?, ?, ?, ?, ?, ?, ?, ?)
      `).pluck().get(request.request_digest, request.action_id,
        request.execution_key_digest, "live_acquisition_actions", "UPDATE",
        "", "", "0".repeat(64))).toBe(0);
      expect(() => createLiveAcquisitionActionLedger(value.connection, {
        clock: () => new Date(value.now),
      }).block(value.actionId, "CANCELLED", true))
        .toThrow("schema26 privacy purge mutation fence");
      withoutTableTriggers(value.connection, "live_acquisition_action_events", () => {
        value.connection.prepare(`
          INSERT INTO live_acquisition_action_events (
            action_id, sequence_no, from_state, to_state, outcome_code,
            safe_details_json, occurred_at
          ) VALUES (?, 6, 'started', 'ambiguous', 'CANCELLED',
            '{"outcome_class":"ambiguous"}', ?)
        `).run(value.actionId, value.now);
      });
      const unrelatedEvent = value.connection.prepare(`
        SELECT id, sequence_no FROM live_acquisition_action_events
        WHERE action_id = ? AND sequence_no = 6
      `).get(value.actionId) as { id: number; sequence_no: number };
      const forgedBase = {
        requestDigest: request.request_digest,
        actionId: request.action_id,
        executionKeyDigest: request.execution_key_digest,
        eventId: unrelatedEvent.id,
        eventSequenceNo: unrelatedEvent.sequence_no,
        recordedAt: value.now,
      };
      expect(() => value.connection.prepare(`
        INSERT INTO live_acquisition_action_abort_provenance (
          request_digest, action_id, execution_key_digest, event_id,
          event_sequence_no, recorded_at, row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(request.request_digest, request.action_id,
        request.execution_key_digest, unrelatedEvent.id,
        unrelatedEvent.sequence_no, value.now,
        sha256(JSON.stringify(forgedBase))))
        .toThrow("invalid live acquisition action abort provenance");
      withoutTableTriggers(value.connection, "live_acquisition_actions", () => {
        value.connection.prepare(`
          UPDATE live_acquisition_actions
          SET state = 'ambiguous', sequence_no = 6, terminal_at = ? WHERE id = ?
        `).run(value.now, value.actionId);
      });
      const restarted = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new TrackedC90AbortError("C90_EXECUTION_NOT_ACTIVE");
        } },
      });
      await expect(restarted.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .resolves.toMatchObject({ status: "pending", processed: 0, remaining: 1 });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rolls back after partial external-abort capability consumption", async () => {
    const value = resolutionFixture("started");
    try {
      await createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
      }).abortStartedActionWait(value.intentKey, { maxActions: 1 });
      const request = value.connection.prepare(`
        SELECT request_digest, action_id, execution_key_digest
        FROM privacy_purge_action_abort_requests
      `).get() as {
        request_digest: string; action_id: number; execution_key_digest: string;
      };
      const eventId = Number(value.connection.prepare(`
        SELECT COALESCE(MAX(id), 0) + 1 FROM live_acquisition_action_events
      `).pluck().get());
      value.connection.exec(`
        DROP TRIGGER privacy_purge26_live_acquisition_action_events_insert_fence;
        CREATE TRIGGER privacy_purge26_live_acquisition_action_events_insert_fence
        AFTER INSERT ON live_acquisition_action_events
        WHEN NEW.action_id = ${value.actionId}
        BEGIN
          SELECT RAISE(ABORT, 'forced event fence after action capability');
        END;
      `);
      expect(() => createLiveAcquisitionActionLedger(value.connection, {
        clock: () => new Date(value.now),
      }).blockForPrivacyPurgeAbort(value.actionId, {
        requestDigest: request.request_digest,
        executionKeyDigest: request.execution_key_digest,
      })).toThrow("forced event fence after action capability");
      expect(value.connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual({ state: "started", sequence_no: 5 });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_events WHERE id = ?
      `).pluck().get(eventId))).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("refuses the dedicated abort path inside a caller-owned transaction", async () => {
    const value = resolutionFixture("started");
    try {
      await createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
      }).abortStartedActionWait(value.intentKey, { maxActions: 1 });
      const request = value.connection.prepare(`
        SELECT request_digest, execution_key_digest
        FROM privacy_purge_action_abort_requests
      `).get() as { request_digest: string; execution_key_digest: string };
      value.connection.exec("BEGIN IMMEDIATE");
      try {
        expect(() => createLiveAcquisitionActionLedger(value.connection, {
          clock: () => new Date(value.now),
        }).blockForPrivacyPurgeAbort(value.actionId, {
          requestDigest: request.request_digest,
          executionKeyDigest: request.execution_key_digest,
        })).toThrow("live acquisition action requires autocommit");
      } finally {
        value.connection.exec("ROLLBACK");
      }
      expect(value.connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual({ state: "started", sequence_no: 5 });
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_abort_provenance
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("fails closed for every malformed direct acknowledgement field", async () => {
    const value = resolutionFixture("started");
    try {
      const corruptions: Array<(result: ReturnType<typeof acknowledgedAbort>) => unknown> = [
        (v) => ({ ...v, actionId: v.actionId + 1 }),
        (v) => ({ ...v, jobId: v.jobId + 1 }),
        (v) => ({ ...v, attemptId: v.attemptId + 1 }),
        (v) => ({ ...v, attemptNo: v.attemptNo + 1 }),
        (v) => ({ ...v, leaseTokenDigest: "0".repeat(64) }),
        (v) => ({ ...v, executionKeyDigest: "1".repeat(64) }),
        (v) => ({ ...v, abortRequestDigest: "2".repeat(64) }),
        (v) => ({ ...v, signalled: false }),
        (v) => ({ ...v, settled: false }),
        (v) => ({ ...v, settlement: "invalid" }),
        (v) => ({ ...v, acknowledgementDigest: "3".repeat(64) }),
        (v) => ({ ...v, extra: "forbidden" }),
      ];
      for (const corrupt of corruptions) {
        const store = createPrivacyPurgeIntentStore(value.connection, {
          clock: () => new Date(value.now),
          trackedC90Executor: { abortAndWait: async (input) =>
            corrupt(acknowledgedAbort(input)) as never },
        });
        await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
          .rejects.toThrow();
      }
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("fails closed for every malformed already-settled field", async () => {
    const corruptions: Array<(result: ReturnType<typeof alreadySettledAbort>) => unknown> = [
      (v) => ({ ...v, actionId: v.actionId + 1 }),
      (v) => ({ ...v, jobId: v.jobId + 1 }),
      (v) => ({ ...v, attemptId: v.attemptId + 1 }),
      (v) => ({ ...v, attemptNo: v.attemptNo + 1 }),
      (v) => ({ ...v, leaseTokenDigest: "0".repeat(64) }),
      (v) => ({ ...v, executionKeyDigest: "1".repeat(64) }),
      (v) => ({ ...v, abortRequestDigest: "2".repeat(64) }),
      (v) => ({ ...v, signalled: true }),
      (v) => ({ ...v, settled: false }),
      (v) => ({ ...v, settlement: "invalid" }),
      (v) => ({ ...v, terminalOutcome: "invalid" }),
      (v) => ({ ...v, resultDigest: "3".repeat(64) }),
      (v) => ({ ...v, extra: "forbidden" }),
    ];
    for (const corrupt of corruptions) {
      const value = resolutionFixture("started");
      try {
        const store = createPrivacyPurgeIntentStore(value.connection, {
          clock: () => new Date(value.now),
          trackedC90Executor: { abortAndWait: async (input) =>
            corrupt(alreadySettledAbort(input)) as never },
        });
        await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
          .rejects.toThrow();
        expect(Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
        `).pluck().get())).toBe(0);
      } finally {
        value.database.close();
      }
    }
  }, 20_000);

  it("checks action quiescence before Phase A and again after the bridge await", async () => {
    for (const timing of ["before", "between"] as const) {
      const value = resolutionFixture("started");
      try {
        if (timing === "before") {
          withoutTableTriggers(value.connection, "privacy_purge_intent_action_waits", () => {
            value.connection.prepare(`
              UPDATE privacy_purge_intent_action_waits SET row_digest = ?
              WHERE intent_key = ? AND ordinal = 0
            `).run("7".repeat(64), value.intentKey);
          });
        }
        const store = createPrivacyPurgeIntentStore(value.connection, {
          clock: () => new Date(value.now),
          trackedC90Executor: { abortAndWait: async (input) => {
            if (timing === "between") {
              withoutTableTriggers(value.connection,
                "privacy_purge_intent_action_waits", () => {
                  value.connection.prepare(`
                    UPDATE privacy_purge_intent_action_waits SET row_digest = ?
                    WHERE intent_key = ? AND ordinal = 0
                  `).run("7".repeat(64), value.intentKey);
                });
            }
            return acknowledgedAbort(input);
          } },
        });
        await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
          .rejects.toThrow("PURGE_INVARIANT_VIOLATION");
        expect(Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_action_abort_receipts
        `).pluck().get())).toBe(0);
      } finally {
        value.database.close();
      }
    }
  });

  it("rechecks quiescence inside Phase A after an injected pre-transaction race", async () => {
    const value = resolutionFixture("started");
    try {
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        testOnlyBeforeActionAbortPhaseA: () => {
          forgeActionQuiescence(value.connection, value.intentKey);
        },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects checkpoint JSON whose persisted digest no longer matches", async () => {
    const value = resolutionFixture("started");
    try {
      withoutTableTriggers(value.connection, "live_acquisition_checkpoints", () => {
        value.connection.prepare(`
          UPDATE live_acquisition_checkpoints
          SET checkpoint_json = json_set(checkpoint_json, '$.tampered', 1)
          WHERE attempt_id = 9901
        `).run();
      });
      const store = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.now),
        trackedC90Executor: { abortAndWait: async () => {
          throw new Error("must not call bridge");
        } },
      });
      await expect(store.abortStartedActionWait(value.intentKey, { maxActions: 1 }))
        .rejects.toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_abort_requests
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });
  it("processes a deterministic bounded prefix and records exact terminal proofs", () => {
    const value = fixture();
    try {
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 1 });
      expect(value.connection.prepare(`
        SELECT id, state, sequence_no, terminal_at FROM live_acquisition_actions
        WHERE id IN (?, ?) ORDER BY id
      `).all(...value.actionIds)).toEqual([
        { id: value.actionIds[0], state: "blocked", sequence_no: 2, terminal_at: AT },
        { id: value.actionIds[1], state: "planned", sequence_no: 1, terminal_at: null },
      ]);
      expect(value.connection.prepare(`
        SELECT action_id, terminal_state, terminal_sequence_no, terminal_at
        FROM privacy_purge_intent_action_waits
        WHERE intent_key = ? ORDER BY ordinal
      `).all(value.intentKey)).toEqual([
        { action_id: value.actionIds[0], terminal_state: "blocked", terminal_sequence_no: 2,
          terminal_at: AT },
        { action_id: value.actionIds[1], terminal_state: null, terminal_sequence_no: null,
          terminal_at: null },
      ]);
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 256 }))
        .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 0 });
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 0, remaining: 0 });
    } finally {
      value.database.close();
    }
  });

  it("rejects invalid bounds without sampling durable work", () => {
    const value = fixture(1);
    try {
      for (const maxActions of [0, 257, 1.5, Number.NaN]) {
        expect(() => value.store.reconcileActionWaits(value.intentKey, { maxActions }))
          .toThrow("maxActions");
      }
      expect(value.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionIds[0])).toBe("planned");
    } finally {
      value.database.close();
    }
  });

  it("snapshots a changing maxActions getter exactly once", () => {
    const value = fixture();
    try {
      let reads = 0;
      const input = {
        get maxActions() {
          reads += 1;
          return reads === 1 ? 1 : 256;
        },
      };
      expect(value.store.reconcileActionWaits(value.intentKey, input)).toEqual({
        intentKey: value.intentKey,
        processed: 1,
        remaining: 1,
      });
      expect(reads).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("rolls back the whole batch when the second terminal proof fails", () => {
    const value = fixture();
    try {
      value.connection.exec(`
        CREATE TEMP TRIGGER fail_second_action_proof
        BEFORE UPDATE ON privacy_purge_intent_action_waits
        WHEN OLD.ordinal = 1
        BEGIN
          SELECT RAISE(ABORT, 'fixture second action proof failure');
        END;
      `);
      expect(() => value.store.reconcileActionWaits(value.intentKey, { maxActions: 2 }))
        .toThrow("fixture second action proof failure");
      expect(value.connection.prepare(`
        SELECT state, sequence_no, terminal_at FROM live_acquisition_actions
        WHERE id IN (?, ?) ORDER BY id
      `).all(...value.actionIds)).toEqual([
        { state: "planned", sequence_no: 1, terminal_at: null },
        { state: "planned", sequence_no: 1, terminal_at: null },
      ]);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_events
        WHERE action_id IN (?, ?) AND sequence_no = 2
      `).pluck().get(...value.actionIds))).toBe(0);
    } finally {
      value.database.close();
    }
  });

  for (const mode of ["boundary", "prior"] as const) {
    it(`marks ${mode} DNS resolution as ambiguous with exact proof`, () => {
      const value = resolutionFixture(mode);
      try {
        expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
          .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 0 });
        expect(value.connection.prepare(`
          SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
        `).get(value.actionId)).toEqual({
          state: "ambiguous",
          sequence_no: 3,
          terminal_at: value.now,
        });
        expect(value.connection.prepare(`
          SELECT terminal_state, terminal_sequence_no, terminal_at
          FROM privacy_purge_intent_action_waits WHERE intent_key = ?
        `).get(value.intentKey)).toEqual({
          terminal_state: "ambiguous",
          terminal_sequence_no: 3,
          terminal_at: value.now,
        });
      } finally {
        value.database.close();
      }
    });
  }

  for (const mode of ["predeadline", "started"] as const) {
    it(`leaves ${mode} action untouched`, () => {
      const value = resolutionFixture(mode);
      try {
        const before = value.connection.prepare(`
          SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
        `).get(value.actionId);
        expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
          .toEqual({ intentKey: value.intentKey, processed: 0, remaining: 1 });
        expect(value.connection.prepare(`
          SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
        `).get(value.actionId)).toEqual(before);
      } finally {
        value.database.close();
      }
    });
  }

  it("uses the frozen three-second DNS deadline instead of the consent expiry", () => {
    const value = resolutionFixture("predeadline");
    try {
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 0, remaining: 1 });
      const boundaryStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.resolutionDeadline),
      });
      expect(boundaryStore.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 0 });
      expect(value.connection.prepare(`
        SELECT state, sequence_no, terminal_at
        FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual({
        state: "ambiguous",
        sequence_no: 3,
        terminal_at: value.resolutionDeadline,
      });
    } finally {
      value.database.close();
    }
  });

  it("rejects publication without the exact current DNS-resolution start event", () => {
    expect(() => resolutionFixture("boundary", "missing"))
      .toThrow("PURGE_INVARIANT_VIOLATION");
  });

  it("rejects publication with the wrong current DNS-resolution start event", () => {
    expect(() => resolutionFixture("boundary", "wrong"))
      .toThrow("PURGE_INVARIANT_VIOLATION");
  });

  it("preserves the frozen expected-view row bytes and legacy consent deadline", () => {
    const value = resolutionFixture("predeadline");
    try {
      const frozen = value.connection.prepare(`
        SELECT wait.deadline_at, wait.row_digest,
          wait.resolution_start_sequence_no, wait.resolution_started_at,
          wait.resolution_deadline_at, wait.quiescence_snapshot_digest,
          expected.deadline_at AS expected_deadline_at,
          expected.row_digest AS expected_row_digest
        FROM privacy_purge_intent_action_waits AS wait
        JOIN privacy_purge26_expected_action_waits AS expected
          ON expected.intent_key = wait.intent_key
          AND expected.ordinal = wait.ordinal
        WHERE wait.intent_key = ?
      `).get(value.intentKey) as Record<string, unknown>;
      expect(frozen.deadline_at).toBe(value.consentExpiresAt);
      expect(frozen.expected_deadline_at).toBe(value.consentExpiresAt);
      expect(frozen.row_digest).toBe(frozen.expected_row_digest);
      expect(frozen.resolution_start_sequence_no).toBe(2);
      expect(frozen.resolution_started_at).toBe(liveResearchFixtureAt);
      expect(frozen.resolution_deadline_at).toBe(value.resolutionDeadline);
      expect(String(frozen.quiescence_snapshot_digest)).toHaveLength(64);
    } finally {
      value.database.close();
    }
  });

  it("rejects coordinated quiescence digest tampering before action mutation", () => {
    const value = resolutionFixture("predeadline");
    try {
      forgeActionQuiescence(value.connection, value.intentKey);
      const before = value.connection.prepare(`
        SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId);
      const boundaryStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(value.resolutionDeadline),
      });
      expect(() => boundaryStore.reconcileActionWaits(
        value.intentKey, { maxActions: 1 },
      )).toThrow("PURGE_INVARIANT_VIOLATION");
      expect(value.connection.prepare(`
        SELECT state, sequence_no, terminal_at FROM live_acquisition_actions WHERE id = ?
      `).get(value.actionId)).toEqual(before);
    } finally {
      value.database.close();
    }
  });

  it("rejects a reconciliation clock before the frozen resolution start", () => {
    const value = resolutionFixture("predeadline");
    try {
      const regressedStore = createPrivacyPurgeIntentStore(value.connection, {
        clock: () => new Date(Date.parse(liveResearchFixtureAt) - 1),
      });
      expect(() => regressedStore.reconcileActionWaits(
        value.intentKey, { maxActions: 1 },
      )).toThrow("PURGE_CLOCK_REGRESSION");
    } finally {
      value.database.close();
    }
  });

  it("rejects coordinated post-terminal quiescence tampering before ready freeze", () => {
    const value = resolutionFixture("boundary");
    try {
      expect(value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 }))
        .toEqual({ intentKey: value.intentKey, processed: 1, remaining: 0 });
      forgeActionQuiescence(value.connection, value.intentKey);
      expect(() => value.store.freezeReady(value.intentKey))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_execution_targets
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(0);
      expect(value.connection.prepare(`
        SELECT status, result_digest FROM privacy_purge_intents WHERE intent_key = ?
      `).get(value.intentKey)).toEqual({ status: "waiting", result_digest: null });
    } finally {
      value.database.close();
    }
  });

  it("rejects coordinated post-ready quiescence tampering before command linkage", () => {
    const value = resolutionFixture("boundary");
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 });
      expect(value.store.freezeReady(value.intentKey).status).toBe("ready");
      forgeActionQuiescence(value.connection, value.intentKey);
      expect(() => value.store.linkReadyCommand(value.identity))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects coordinated post-commit quiescence tampering before execution", () => {
    const value = resolutionFixture("boundary");
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 });
      value.store.freezeReady(value.intentKey);
      const commandId = value.store.linkReadyCommand(value.identity);
      forgeActionQuiescence(value.connection, value.intentKey);
      rebindResultToForgedActionQuiescence(value.connection, value.intentKey);
      const before = {
        results: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_results
        `).pluck().get()),
        receipts: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intent_receipts
        `).pluck().get()),
        authorities: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_authorities
        `).pluck().get()),
      };
      expect(() => value.store.executeCommitted(commandId))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect({
        results: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_results
        `).pluck().get()),
        receipts: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intent_receipts
        `).pluck().get()),
        authorities: Number(value.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_authorities
        `).pluck().get()),
      }).toEqual(before);
      expect(value.connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = ?
      `).pluck().get(commandId)).toBe("pending");
    } finally {
      value.database.close();
    }
  });

  it("carries nonempty DNS quiescence through result:v3 and the final receipt", () => {
    const value = resolutionFixture("boundary");
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 });
      const ready = value.store.freezeReady(value.intentKey);
      const attestation = value.connection.prepare(`
        SELECT action_quiescence_digest, result_digest
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(value.intentKey) as {
        action_quiescence_digest: string;
        result_digest: string;
      };
      const waitDigest = String(value.connection.prepare(`
        SELECT quiescence_snapshot_digest
        FROM privacy_purge_intent_action_waits WHERE intent_key = ?
      `).pluck().get(value.intentKey));
      expect(waitDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(attestation.action_quiescence_digest)
        .toBe(sha256(JSON.stringify([waitDigest])));
      expect(attestation.action_quiescence_digest).not.toBe(sha256("[]"));

      const commandId = value.store.linkReadyCommand(value.identity);
      observeAuthoritiesAndDeleteWaitAfter({ ...value, commandId }, null);
      value.store.executeCommitted(commandId);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM observed_privacy_purge_authorities
      `).pluck().get())).toBeGreaterThan(1);
      expect(value.connection.prepare(`
        SELECT intent.status, intent.result_digest,
          receipt.outcome, receipt.origin,
          receipt.execution_target_count, receipt.execution_plan_digest,
          receipt.result_digest AS receipt_result_digest
        FROM privacy_purge_intents AS intent
        JOIN privacy_purge_intent_receipts AS receipt
          ON receipt.intent_key = intent.intent_key
        WHERE intent.intent_key = ?
      `).get(value.intentKey)).toEqual({
        status: "completed",
        result_digest: attestation.result_digest,
        outcome: "completed",
        origin: "schema26",
        execution_target_count: ready.executionTargetCount,
        execution_plan_digest: ready.executionPlanDigest,
        receipt_result_digest: attestation.result_digest,
      });
      expect(value.connection.prepare(`
        SELECT outcome, result_digest FROM privacy_purge_results
        WHERE command_id = ?
      `).get(commandId)).toEqual({
        outcome: "completed",
        result_digest: attestation.result_digest,
      });
      expect(value.connection.prepare(`
        SELECT intent_key, action_quiescence_digest
        FROM privacy_purge_action_quiescence_attestations
        WHERE command_id = ?
      `).get(commandId)).toEqual({
        intent_key: value.intentKey,
        action_quiescence_digest: attestation.action_quiescence_digest,
      });
    } finally {
      value.database.close();
    }
  });

  it("rejects a deleted frozen wait suffix before ready freeze", () => {
    const value = fixture();
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 2 });
      deleteFrozenActionWaits(value.connection, value.intentKey, "ordinal = 1");
      expect(() => value.store.freezeReady(value.intentKey))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_execution_targets
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects deletion of every frozen wait before command linkage", () => {
    const value = fixture();
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 2 });
      value.store.freezeReady(value.intentKey);
      deleteFrozenActionWaits(value.connection, value.intentKey);
      expect(() => value.store.linkReadyCommand(value.identity))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_commands
      `).pluck().get())).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects in-transaction wait deletion before authority or any purge mutation", () => {
    const value = resolutionFixture("boundary");
    try {
      value.store.reconcileActionWaits(value.intentKey, { maxActions: 1 });
      value.store.freezeReady(value.intentKey);
      const commandId = value.store.linkReadyCommand(value.identity);
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_action_waits_delete_guard;
        CREATE TEMP TRIGGER inject_wait_deletion_before_authority
        BEFORE INSERT ON privacy_purge_authorities
        WHEN NEW.command_id = ${commandId}
        BEGIN
          DELETE FROM privacy_purge_intent_action_waits
          WHERE intent_key = '${value.intentKey}';
        END;
      `);
      expect(() => value.store.executeCommitted(commandId))
        .toThrow("privacy purge action quiescence invariant failed");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_action_waits
        WHERE intent_key = ?
      `).pluck().get(value.intentKey))).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(value.actionId))).toBe(1);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_authorities WHERE command_id = ?
      `).pluck().get(commandId))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_quiescence_attestations
        WHERE command_id = ?
      `).pluck().get(commandId))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = ?
      `).pluck().get(commandId))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_receipts
        WHERE purge_command_id = ?
      `).pluck().get(commandId))).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rejects forged attestation after an injected source-event deletion", () => {
    const value = prepareCommittedResolution();
    try {
      dropActionEventDeleteGuards(value.connection);
      value.connection.function(
        "tabhub_purge_finalization_active_v1",
        () => 1,
      );
      value.connection.exec(`
        CREATE TEMP TABLE forged_attestation_requests (id INTEGER PRIMARY KEY);
        CREATE TEMP TRIGGER forge_attestation_after_source_event_deletion
        AFTER INSERT ON forged_attestation_requests
        BEGIN
          DELETE FROM live_acquisition_action_events
          WHERE action_id = ${value.actionId} AND sequence_no = 2;
          INSERT OR IGNORE INTO privacy_purge_action_quiescence_attestations (
            command_id, intent_key, action_quiescence_digest, attested_at
          )
          SELECT ${value.commandId}, intent_key, action_quiescence_digest,
            '${value.now}'
          FROM privacy_purge_intents WHERE intent_key = '${value.intentKey}';
        END;
      `);
      expect(() => value.connection.prepare(`
        INSERT INTO forged_attestation_requests (id) VALUES (1)
      `).run())
        .toThrow("privacy purge action quiescence attestation requires active executor");
      assertNoExecutedPurgeEffects(value);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_action_events
        WHERE action_id = ? AND sequence_no = 2
      `).pluck().get(value.actionId))).toBe(1);
    } finally {
      value.database.close();
    }
  });

  it("rejects source-event-only corruption when no durable proof exists", () => {
    const value = prepareCommittedResolution();
    try {
      dropActionEventDeleteGuards(value.connection);
      value.connection.prepare(`
        DELETE FROM live_acquisition_action_events
        WHERE action_id = ? AND sequence_no = 2
      `).run(value.actionId);
      expect(() => value.store.executeCommitted(value.commandId))
        .toThrow("PURGE_INVARIANT_VIOLATION");
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_action_quiescence_attestations
        WHERE command_id = ?
      `).pluck().get(value.commandId))).toBe(0);
      expect(Number(value.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = ?
      `).pluck().get(value.commandId))).toBe(0);
    } finally {
      value.database.close();
    }
  });

  it("rechecks membership after mutation on a second or later authority", () => {
    const value = prepareCommittedResolution();
    try {
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_action_waits_delete_guard;
      `);
      observeAuthoritiesAndDeleteWaitAfter(value, 2);
      expect(() => value.store.executeCommitted(value.commandId))
        .toThrow("privacy purge action quiescence invariant failed");
      assertNoExecutedPurgeEffects(value);
    } finally {
      value.database.close();
    }
  });

  it("rechecks membership at finalize after mutation on the last authority", () => {
    const probe = prepareCommittedResolution();
    let authorityCount: number;
    try {
      observeAuthoritiesAndDeleteWaitAfter(probe, null);
      probe.store.executeCommitted(probe.commandId);
      authorityCount = Number(probe.connection.prepare(`
        SELECT COUNT(*) FROM observed_privacy_purge_authorities
      `).pluck().get());
      expect(authorityCount).toBeGreaterThan(1);
    } finally {
      probe.database.close();
    }

    const value = prepareCommittedResolution();
    try {
      value.connection.exec(`
        DROP TRIGGER privacy_purge_intent_action_waits_delete_guard;
      `);
      deleteWaitAfterAuthorityRemoval(value, authorityCount);
      expect(() => value.store.executeCommitted(value.commandId))
        .toThrow("privacy purge action quiescence invariant failed");
      assertNoExecutedPurgeEffects(value);
    } finally {
      value.database.close();
    }
  });

  it("single-flights one durable started-action abort across coordinator instances", async () => {
    const value = resolutionFixture("started");
    try {
      let firstInput!: Parameters<typeof acknowledgedAbort>[0];
      let release!: (result: ReturnType<typeof acknowledgedAbort>) => void;
      const bridge = new Promise<ReturnType<typeof acknowledgedAbort>>(
        (resolve) => { release = resolve; },
      );
      let calls = 0;
      let externalSideEffects = 0;
      const executor = { abortAndWait: async (input: Parameters<
        typeof acknowledgedAbort>[0]) => {
        calls += 1;
        if (calls === 1) {
          externalSideEffects += 1;
          firstInput = input;
          return bridge;
        }
        throw new TrackedC90AbortError("C90_ABORT_ALREADY_REQUESTED");
      } };
      const firstCoordinator = createPrivacyPurgeCoordinator(value.connection, {
        clock: () => new Date(value.now), trackedC90Executor: executor,
      });
      const secondCoordinator = createPrivacyPurgeCoordinator(value.connection, {
        clock: () => new Date(value.now), trackedC90Executor: executor,
      });
      const purgeId = `purge_${value.intentKey}`;
      const first = firstCoordinator.driveOnce(purgeId);
      await Promise.resolve();
      await expect(secondCoordinator.driveOnce(purgeId)).resolves.toMatchObject({
        status: { state: "waiting" }, progressed: false,
      });
      expect(externalSideEffects).toBe(1);
      expect(Number(value.connection.prepare(`SELECT COUNT(*) FROM
        privacy_purge_action_abort_requests`).pluck().get())).toBe(1);
      release(acknowledgedAbort(firstInput));
      await expect(first).resolves.toMatchObject({ progressed: true });
      expect(Number(value.connection.prepare(`SELECT COUNT(*) FROM
        privacy_purge_action_abort_receipts`).pluck().get())).toBe(1);
      expect(externalSideEffects).toBe(1);
    } finally { value.database.close(); }
  });
});
