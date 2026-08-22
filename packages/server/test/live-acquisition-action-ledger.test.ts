import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { researchCanonicalSha256PayloadV1 } from "@tabhub/shared";
import type Database from "better-sqlite3";

import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import { createLiveAcquisitionHandoff } from "../src/live-acquisition-handoff.js";
import type { AiJobClaim } from "../src/ai-job-ledger.js";
import { createResearchCorpusReader } from "../src/research-corpus.js";
import { classifyPublicDnsAnswers, parseRobotsPolicy } from "../src/live-acquisition-policy.js";
import { openDatabase } from "../src/database.js";
import { createLogicalPageCatalog } from "../src/logical-page-catalog.js";
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const at = "2026-08-14T12:00:00.000Z";
const permissiveRobotsText = "User-agent: TabHubResearch\nDisallow:\n";
const parsedPermissiveRobotsPolicy = parseRobotsPolicy(permissiveRobotsText);
if (parsedPermissiveRobotsPolicy.kind !== "parsed") throw new Error("fixture robots policy rejected");
const permissiveRobotsPolicy = {
  policyDigest: parsedPermissiveRobotsPolicy.policyDigest,
  crawlDelayMs: parsedPermissiveRobotsPolicy.crawlDelayMs,
};

function completePermissiveRobots(
  ledger: ReturnType<typeof createLiveAcquisitionActionLedger>,
  actionId: number,
): void {
  ledger.completeRobots(actionId, {
    policyDigest: permissiveRobotsPolicy.policyDigest,
    crawlDelayMs: permissiveRobotsPolicy.crawlDelayMs,
    policyText: permissiveRobotsText,
  });
}

function installFixtureConsentPayloads(
  connection: Database.Database,
  options: { readonly allowPages?: boolean } = {},
): void {
  if (options.allowPages === true) {
    const owner = connection.prepare(`
      SELECT generation.research_run_id AS run_id,
        consent.coordinator_run_generation_id AS run_generation_id
      FROM live_acquisition_consents AS consent
      JOIN privacy_subject_generations AS generation
        ON generation.id = consent.coordinator_run_generation_id
      WHERE consent.id = 1
    `).get() as { run_id: number; run_generation_id: number };
    const originDigest = createHash("sha256").update("https://www.cloudflare.com").digest("hex");
    connection.prepare(`
      INSERT INTO live_acquisition_origin_courtesy_state (
        coordinator_run_id, coordinator_run_generation_id, consent_id,
        canonical_origin_digest, origin_digest, robots_policy_digest, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(owner.run_id, owner.run_generation_id, originDigest, originDigest,
      "8".repeat(64), at);
  }
}

function installResolvedFixturePage(
  connection: Database.Database,
  url: string,
  consentId = 1,
): number {
  const page = createLogicalPageCatalog(connection, () => new Date(at)).resolve({
    observedAt: at,
    url,
    urlNormalized: url,
  });
  const resourceId = Number(connection.prepare(`
    SELECT generation.resource_id
    FROM live_acquisition_consents AS consent
    JOIN privacy_subject_generations AS generation
      ON generation.id = consent.resource_generation_id
    WHERE consent.id = ?
  `).pluck().get(consentId));
  const assignmentId = Number(connection.prepare(`
    SELECT COALESCE(MAX(id), 0) + 1 FROM logical_page_resource_assignments
  `).pluck().get());
  const resolutionId = Number(connection.prepare(`
    SELECT COALESCE(MAX(id), 0) + 1 FROM resource_resolution_events
  `).pluck().get());
  connection.prepare(`
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class,
      assigned_by, assignment_method, source_fingerprint, created_at
    ) VALUES (?, ?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
  `).run(assignmentId, page.id, resourceId, `action-test-assignment:${page.id}`, at);
  connection.prepare(`
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (?, ?)
  `).run(page.id, assignmentId);
  connection.prepare(`
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible, created_at
    ) VALUES (?, ?, 'matched', 'user_manual', ?, ?, ?, ?, 1, ?)
  `).run(resolutionId, page.id, resourceId, assignmentId, JSON.stringify([resourceId]),
    `action-test-resolution:${page.id}`, at);
  connection.prepare(`
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (?, ?)
  `).run(page.id, resolutionId);
  return page.id;
}

function resolveAndAuthorize(
  ledger: ReturnType<typeof createLiveAcquisitionActionLedger>,
  actionId: number,
): void {
  ledger.beginResolution(actionId);
  const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
  if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
  ledger.recordResolution(actionId, resolution);
  ledger.authorize(actionId);
}

function seedRunningC90Coordinator(connection: Database.Database): {
  readonly jobId: number;
  readonly consentId: number;
} {
  const jobId = 8_501;
  const limitBase = {
    max_pages: 2,
    max_depth: 1,
    duration_ms: 300_000,
    max_cost_usd: 1,
    max_origins: 1,
    max_output_tokens: 2_000,
    provider_digest: createHash("sha256").update("anthropic").digest("hex"),
    model_digest: createHash("sha256").update("fixture-model").digest("hex"),
    pricing_digest: createHash("sha256").update("fixture-price").digest("hex"),
    max_source_bytes: 65_536,
    max_total_bytes: 4_194_304,
    dns_timeout_ms: 3_000,
    connect_timeout_ms: 5_000,
    headers_timeout_ms: 8_000,
    body_idle_timeout_ms: 3_000,
    request_timeout_ms: 15_000,
    max_header_bytes: 16_384,
  };
  connection.exec(`
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (${jobId}, 'host:recovery.example', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (${jobId}, ${jobId}, 1, 'Recovery fixture', 'website', 'public',
      'active', 'system', 'derived', '${at}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (${jobId}, ${jobId});
    INSERT INTO resource_match_rules (
      id, rule_key, version, resource_id, host_pattern, match_kind, path_prefix,
      priority, provenance_class, created_by, creation_method, created_at
    ) VALUES (${jobId}, 'recovery-cloudflare', 1, ${jobId}, 'cloudflare.com',
      'suffix_host', '/', 100, 'system_seed', 'system', 'derived', '${at}');
    INSERT INTO resource_match_rule_heads (rule_key, rule_id)
    VALUES ('recovery-cloudflare', ${jobId});
    INSERT INTO ai_jobs (
      id, kind, subject_type, resource_id, subject_key, requested_by,
      request_method, idempotency_key, submission_fingerprint,
      input_fingerprint, workflow_id, workflow_version, scheduling_priority,
      progress_total, available_at, max_attempts, max_steps, max_tokens,
      max_cost_usd, max_wall_time_ms, created_at, updated_at
    ) VALUES (
      ${jobId}, 'resource_research', 'resource', ${jobId}, 'resource:${jobId}',
      'user', 'manual', 'recovery-c90-job', '${"a".repeat(64)}',
      '${"b".repeat(64)}', 'research_acquisition:c90:v1', 1, 0, 1, '${at}',
      3, 100, 2000, 1, 420000, '${at}', '${at}'
    );
    INSERT INTO research_runs (
      id, job_id, target_resource_id, history_epoch_id, target_key,
      question_digest, scope_json,
      approval_fingerprint, corpus_fingerprint, submission_fingerprint,
      workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
      max_wall_time_ms, created_at
    ) VALUES (
      ${jobId}, ${jobId}, ${jobId},
      (SELECT id FROM research_history_epochs
       WHERE resource_id = ${jobId} AND is_active = 1),
      'resource:${jobId}', '${createHash("sha256").update("What was acquired?").digest("hex")}',
      '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}',
      '${"b".repeat(64)}', '${"d".repeat(64)}', '${"a".repeat(64)}',
      'research_acquisition:c90:v1', 1, 100, 2000, 1, 420000, '${at}'
    );
    INSERT INTO research_run_events (
      run_id, sequence_no, event_type, status, idempotency_key, occurred_at
    ) VALUES (${jobId}, 1, 'queued', 'queued', 'recovery-run-queued', '${at}');
  `);
  const ownership = connection.prepare(`
    SELECT
      (SELECT id FROM privacy_subject_generations
       WHERE subject_kind = 'resource' AND resource_id = ?) AS resource_generation_id,
      (SELECT id FROM research_history_epochs
       WHERE resource_id = ? AND is_active = 1) AS history_epoch_id,
      (SELECT id FROM privacy_subject_generations
       WHERE subject_kind = 'research_run' AND research_run_id = ?) AS run_generation_id
  `).get(jobId, jobId, jobId) as {
    resource_generation_id: number;
    history_epoch_id: number;
    run_generation_id: number;
  };
  const ruleset = connection.prepare(`
    SELECT event.id, event.version FROM resource_ruleset_heads AS head
    JOIN resource_ruleset_events AS event ON event.id = head.ruleset_event_id
    WHERE head.scope = 'global'
  `).get() as { id: number; version: number };
  const rules = connection.prepare(`
    SELECT rule.rule_key, rule.version, rule.host_pattern, rule.path_prefix,
      rule.priority, rule.enabled, rule.resource_id
    FROM resource_match_rule_heads AS head
    JOIN resource_match_rules AS rule ON rule.id = head.rule_id
    ORDER BY rule.rule_key
  `).all();
  const canonical = (value: unknown) =>
    new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
  const limits = canonical({
    ...limitBase,
    ruleset_generation_digest: createHash("sha256").update(canonical({
      eventId: ruleset.id,
      version: ruleset.version,
      rules,
    })).digest("hex"),
    resource_generation_digest: connection.prepare(`
      SELECT generation_token FROM privacy_subject_generations WHERE id = ?
    `).pluck().get(ownership.resource_generation_id),
  });
  connection.prepare(`
    INSERT INTO live_acquisition_consents (
      id, resource_generation_id, history_epoch_id, coordinator_job_id,
      coordinator_run_generation_id, runtime_epoch, consent_fingerprint,
      origin_set_digest, limits_json, status, created_at, expires_at
    ) VALUES (85, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)
  `).run(
    ownership.resource_generation_id,
    ownership.history_epoch_id,
    jobId,
    ownership.run_generation_id,
    "6".repeat(64),
    "7".repeat(64),
    limits,
    at,
    "2026-08-14T12:05:00.000Z",
  );
  connection.prepare(`
    INSERT INTO live_acquisition_consent_payloads VALUES (85, ?)
  `).run('["https://www.cloudflare.com"]');
  connection.prepare(`
    INSERT INTO live_acquisition_digest_keys VALUES (85, ?)
  `).run(Buffer.alloc(32, 8));
  connection.exec(`
    INSERT INTO ai_job_attempts (
      id, job_id, attempt_no, lease_token, worker_id, started_at, outcome
    ) VALUES (
      ${jobId}, ${jobId}, 1, 'recovery-lease-token-8501',
      'recovery-worker', '${at}', 'running'
    );
  `);
  return { jobId, consentId: 85 };
}

function seedReadyHandoff(connection: Database.Database) {
  const fixture = seedRunningC90Coordinator(connection);
  connection.prepare(`INSERT INTO research_run_payloads (run_id, question, scope_json)
    VALUES (?, 'What was acquired?',
      '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}')`)
    .run(fixture.jobId);
  const owner = connection.prepare(`SELECT generation.research_run_id run_id,
    consent.coordinator_run_generation_id run_generation_id
    FROM live_acquisition_consents consent JOIN privacy_subject_generations generation
      ON generation.id=consent.coordinator_run_generation_id WHERE consent.id=?`)
    .get(fixture.consentId) as { run_id: number; run_generation_id: number };
  const originDigest = createHash("sha256").update("https://www.cloudflare.com").digest("hex");
  connection.prepare(`INSERT INTO live_acquisition_origin_courtesy_state
    (coordinator_run_id, coordinator_run_generation_id, consent_id,
    canonical_origin_digest, origin_digest, robots_policy_digest, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(owner.run_id, owner.run_generation_id, fixture.consentId,
      originDigest, originDigest, "8".repeat(64), at);
  let now = new Date(at);
  const ledger = createLiveAcquisitionActionLedger(connection, { clock: () => now });
  const page = ledger.planUnknownPage({ consentId: fixture.consentId,
    url: "https://www.cloudflare.com/stable-drift" });
  resolveAndAuthorize(ledger, page.id);
  now = new Date("2026-08-14T12:00:01.000Z");
  ledger.start(page.id);
  const rawBody = new TextEncoder().encode("Stable drift evidence. ".repeat(30));
  ledger.completePage(page.id, { rawBody, extractedText: new TextDecoder().decode(rawBody),
    contentDigest: createHash("sha256").update(rawBody).digest("hex"),
    responseMetadataDigest: "9".repeat(64) });
  return { fixture, page };
}

describe("live acquisition action ledger", () => {
  it.each(["ruleset", "membership"] as const)("rejects stable pre-existing %s drift", (kind) => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const { fixture, page } = seedReadyHandoff(database.connection);
      if (kind === "ruleset") {
        const current = database.connection.prepare(`SELECT event.id,event.version
          FROM resource_ruleset_heads head JOIN resource_ruleset_events event
            ON event.id=head.ruleset_event_id WHERE head.scope='global'`)
          .get() as { id: number; version: number };
        const nextId = current.id + 100_000;
        database.connection.prepare(`INSERT INTO resource_ruleset_events
          (id,version,supersedes_id,created_by,creation_method,created_at)
          VALUES (?,?,?,'system','derived',?)`).run(nextId, current.version + 1, current.id, at);
        database.connection.prepare(`UPDATE resource_ruleset_heads SET ruleset_event_id=?
          WHERE scope='global'`).run(nextId);
      } else {
        const current = database.connection.prepare(`SELECT head.resolution_event_id,
          resolution.logical_page_id FROM live_acquisition_capture_manifests manifest
          JOIN privacy_subject_generations generation ON generation.id=manifest.logical_page_generation_id
          JOIN resource_resolution_heads head ON head.logical_page_id=generation.logical_page_id
          JOIN resource_resolution_events resolution ON resolution.id=head.resolution_event_id
          WHERE manifest.action_id=?`).get(page.id) as
          { resolution_event_id: number; logical_page_id: number };
        const nextId = current.resolution_event_id + 100_000;
        database.connection.prepare(`INSERT INTO resource_resolution_events
          (id,logical_page_id,state,reason,candidate_resource_ids_json,source_fingerprint,
          research_eligible,research_exclusion_reason,supersedes_id,created_at)
          VALUES (?,?,'excluded','weak_sensitive_signal','[]','v5-membership-drift',0,
            'weak_sensitive_signal',?,?)`).run(nextId, current.logical_page_id,
              current.resolution_event_id, at);
        database.connection.prepare(`UPDATE resource_resolution_heads SET resolution_event_id=?
          WHERE logical_page_id=?`).run(nextId, current.logical_page_id);
      }
      let quoteCalls = 0;
      const handoff = createLiveAcquisitionHandoff(database.connection, { provider: {
        metadata: { provider: "anthropic", model: "fixture-model", promptVersion: "p",
          pricingVersion: "fixture-price" }, quote() { quoteCalls += 1; throw new Error("closed"); },
        async start() { throw new Error("closed"); } } });
      expect(() => handoff.completeClaim({ id: fixture.jobId, attemptId: fixture.jobId,
        attemptNo: 1, leaseToken: "recovery-lease-token-8501" } as AiJobClaim)).toThrow(
          kind === "ruleset" ? "Live handoff provider identity drifted" :
            "Live handoff acquired membership drifted");
      expect(quoteCalls).toBe(0);
    } finally { database.close(); }
  });

  it("rejects a parent-head drift that occurs while the provider quote is computed", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      database.connection.exec(`
        DROP INDEX ai_jobs_one_active_research_subject_idx;
        INSERT INTO ai_jobs (id, kind, subject_type, resource_id, subject_key, requested_by,
          request_method, idempotency_key, submission_fingerprint, input_fingerprint,
          workflow_id, workflow_version, scheduling_priority, progress_total, available_at,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at, updated_at)
        VALUES (8400, 'resource_research', 'resource', ${fixture.jobId},
          'resource:${fixture.jobId}', 'user', 'manual', 'v5-parent-job', '${"f".repeat(64)}',
          '${"e".repeat(64)}', 'research_workflow:c81:v1', 1, 0, 1, '${at}',
          10, 1000, 1, 60000, '${at}', '${at}');
        INSERT INTO research_runs (id, job_id, target_resource_id, history_epoch_id,
          target_key, question_digest, scope_json, approval_fingerprint,
          corpus_fingerprint, submission_fingerprint, workflow_id, workflow_version,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at)
        VALUES (8400, 8400, ${fixture.jobId},
          (SELECT id FROM research_history_epochs WHERE resource_id=${fixture.jobId} AND is_active=1),
          'resource:${fixture.jobId}', '${"d".repeat(64)}', '{}', '${"e".repeat(64)}',
          '${"c".repeat(64)}', '${"f".repeat(64)}', 'research_workflow:c81:v1', 1,
          10, 1000, 1, 60000, '${at}');
        INSERT INTO research_reports (id, run_id, target_resource_id, target_key, version,
          publish_status, coverage_json, coverage_fingerprint, provenance_json,
          input_fingerprint, created_at) VALUES (8400, 8400, ${fixture.jobId},
          'resource:${fixture.jobId}', 1, 'succeeded', '{}', '${"b".repeat(64)}', '{}',
          '${"e".repeat(64)}', '${at}');
        INSERT INTO research_report_payloads (report_id, report_text, structured_json,
          payload_digest) VALUES (8400, 'Prior report text', '{}', '${"a".repeat(64)}');
        INSERT INTO research_report_state_events (report_id, sequence_no, event_type, state,
          reason, idempotency_key, occurred_at) VALUES
          (8400, 1, 'published', 'fresh', NULL, 'v5-parent-published', '${at}');
        DROP TRIGGER research_runs_immutable_update;
        UPDATE research_runs SET parent_report_id=8400 WHERE id=${fixture.jobId};
      `);
      database.connection.prepare(`INSERT INTO research_run_payloads (run_id, question, scope_json)
        VALUES (?, 'What was acquired?',
          '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}')`)
        .run(fixture.jobId);
      const parentOwnership = database.connection.prepare(`SELECT generation.research_run_id run_id,
        consent.coordinator_run_generation_id run_generation_id
        FROM live_acquisition_consents consent JOIN privacy_subject_generations generation
          ON generation.id=consent.coordinator_run_generation_id WHERE consent.id=?`)
        .get(fixture.consentId) as { run_id: number; run_generation_id: number };
      const parentOriginDigest = createHash("sha256").update("https://www.cloudflare.com").digest("hex");
      database.connection.prepare(`INSERT INTO live_acquisition_origin_courtesy_state
        (coordinator_run_id, coordinator_run_generation_id, consent_id,
        canonical_origin_digest, origin_digest, robots_policy_digest, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(parentOwnership.run_id, parentOwnership.run_generation_id, fixture.consentId,
          parentOriginDigest, parentOriginDigest, "8".repeat(64), at);
      let parentNow = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection,
        { clock: () => parentNow });
      const page = ledger.planUnknownPage({ consentId: fixture.consentId,
        url: "https://www.cloudflare.com/parent-drift" });
      resolveAndAuthorize(ledger, page.id);
      parentNow = new Date("2026-08-14T12:00:01.000Z");
      ledger.start(page.id);
      const rawBody = new TextEncoder().encode("Parent drift evidence. ".repeat(30));
      ledger.completePage(page.id, { rawBody, extractedText: new TextDecoder().decode(rawBody),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64) });
      const handoff = createLiveAcquisitionHandoff(database.connection, {
        provider: { metadata: { provider: "anthropic", model: "fixture-model",
          promptVersion: "fixture-prompt", pricingVersion: "fixture-price" },
        quote() {
          expect(database.connection.inTransaction).toBe(false);
          database.connection.prepare(`INSERT INTO research_report_state_events
            (report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at)
            VALUES (8400, 2, 'stale', 'stale', 'drifted', 'v5-parent-stale', ?)`)
            .run("2026-08-14T12:00:01.000Z");
          return { version: "research_provider_quote:v1", inputDigest: "a".repeat(64),
            calls: 1, inputTokens: 100, outputTokens: 100, costUsd: 0.25,
            wallTimeMs: 1000 };
        }, async start() { throw new Error("provider start must remain closed"); } },
        clock: () => new Date("2026-08-14T12:00:02.000Z"),
      });
      expect(() => handoff.completeClaim({ id: fixture.jobId, attemptId: fixture.jobId,
        attemptNo: 1, leaseToken: "recovery-lease-token-8501" } as AiJobClaim))
        .toThrow("Live handoff snapshot changed during quote");
      expect(database.connection.prepare("SELECT COUNT(*) FROM live_acquisition_handoffs")
        .pluck().get()).toBe(0);
    } finally { database.close(); }
  });

  it("rejects ambiguous terminal actions before provider access", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      database.connection.prepare(`INSERT INTO research_run_payloads (run_id, question, scope_json)
        VALUES (?, 'What was acquired?',
          '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}')`)
        .run(fixture.jobId);
      const ledger = createLiveAcquisitionActionLedger(database.connection,
        { clock: () => new Date(at) });
      const page = ledger.planUnknownPage({ consentId: fixture.consentId,
        url: "https://www.cloudflare.com/ambiguous" });
      ledger.beginResolution(page.id);
      ledger.block(page.id, "DNS_RESULT_UNKNOWN", true);
      let quoteCalls = 0;
      const handoff = createLiveAcquisitionHandoff(database.connection, {
        provider: { metadata: { provider: "anthropic", model: "fixture-model",
          promptVersion: "fixture-prompt", pricingVersion: "fixture-price" },
        quote() { quoteCalls += 1; throw new Error("provider must remain closed"); },
        async start() { throw new Error("provider must remain closed"); } },
      });
      expect(() => handoff.completeClaim({ id: fixture.jobId, attemptId: fixture.jobId,
        attemptNo: 1, leaseToken: "recovery-lease-token-8501" } as AiJobClaim))
        .toThrow("Live handoff actions are not terminal");
      expect(quoteCalls).toBe(0);
      expect(database.connection.prepare("SELECT COUNT(*) FROM live_acquisition_handoffs")
        .pluck().get()).toBe(0);
    } finally { database.close(); }
  });

  it("terminalizes and replays a zero-usable-source coordinator without provider access", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      database.connection.prepare(`INSERT INTO research_run_payloads (run_id, question, scope_json)
        VALUES (?, 'What was acquired?',
          '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}')`)
        .run(fixture.jobId);
      const ledger = createLiveAcquisitionActionLedger(database.connection,
        { clock: () => new Date(at) });
      const page = ledger.planUnknownPage({ consentId: fixture.consentId,
        url: "https://www.cloudflare.com/no-source" });
      ledger.beginResolution(page.id);
      ledger.block(page.id, "TRANSPORT_DNS_FAILURE");
      let providerReads = 0;
      const handoff = createLiveAcquisitionHandoff(database.connection, {
        provider: { metadata: { provider: "anthropic", model: "fixture-model",
          promptVersion: "fixture-prompt", pricingVersion: "fixture-price" },
        quote() { providerReads += 1; throw new Error("provider must remain closed"); },
        async start() { providerReads += 1; throw new Error("provider must remain closed"); } },
        clock: () => new Date("2026-08-14T12:00:01.000Z"),
      });
      const claim = { id: fixture.jobId, attemptId: fixture.jobId, attemptNo: 1,
        leaseToken: "recovery-lease-token-8501" } as AiJobClaim;
      expect(handoff.completeClaim(claim)).toEqual({ kind: "no_eligible_source" });
      expect(handoff.completeClaim(claim)).toEqual({ kind: "no_eligible_source" });
      expect(providerReads).toBe(0);
      expect(database.connection.prepare(`SELECT status FROM ai_jobs WHERE id=?`)
        .pluck().get(fixture.jobId)).toBe("superseded");
      expect(database.connection.prepare(`SELECT COUNT(*) FROM live_acquisition_workflow_outcomes
        WHERE coordinator_job_id=? AND outcome_code='NO_ELIGIBLE_SOURCE'`).pluck()
        .get(fixture.jobId)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("assembles a fresh immutable C81 handoff from one terminal capture", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      database.connection.prepare(`
        INSERT INTO research_run_payloads (run_id, question, scope_json)
        VALUES (?, 'What was acquired?',
          '{"acquisitionLevel":"captured_only","includeShareableContext":false,"maxIncludedSources":100,"privacyConfirmation":{"authenticatedOriginDigests":[],"confirmed":true,"sensitiveOriginDigests":[]}}')
      `).run(fixture.jobId);
      const snapshotMaterial = new TextDecoder().decode(
        researchCanonicalSha256PayloadV1({ body: "shareable handoff context" }),
      );
      const snapshotDigest = createHash("sha256").update(snapshotMaterial).digest("hex");
      database.connection.prepare(`INSERT INTO resource_context_entries (
        id, resource_id, kind, body, actor, method, visibility, state, operation,
        revision, idempotency_key, created_at) VALUES (?, ?, 'project', ?, 'user',
        'manual', 'share_with_ai', 'active', 'append', 1, ?, ?)`)
        .run(86_001, fixture.jobId, "shareable handoff context", "v5-handoff-context", at);
      database.connection.prepare(`INSERT INTO research_resource_context_snapshots (
        id, run_id, context_entry_audit_id, resource_audit_id, context_entry_id,
        snapshot_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(86_001, fixture.jobId, 86_001, fixture.jobId, 86_001, snapshotDigest, at);
      database.connection.prepare(`INSERT INTO research_snapshot_state_events (
        kind, snapshot_id, sequence_no, event_type, state, reason, idempotency_key,
        occurred_at) VALUES ('resource_context', ?, 1, 'accepted', 'valid', NULL, ?, ?)`)
        .run(86_001, "v5-handoff-snapshot-accepted", at);
      database.connection.prepare(`INSERT INTO research_snapshot_payloads
        (kind, snapshot_id, material_json) VALUES ('resource_context', ?, ?)`)
        .run(86_001, snapshotMaterial);
      const ownership = database.connection.prepare(`
        SELECT generation.research_run_id AS run_id,
          consent.coordinator_run_generation_id AS run_generation_id
        FROM live_acquisition_consents AS consent
        JOIN privacy_subject_generations AS generation
          ON generation.id=consent.coordinator_run_generation_id WHERE consent.id=?
      `).get(fixture.consentId) as { run_id: number; run_generation_id: number };
      const originDigest = createHash("sha256")
        .update("https://www.cloudflare.com").digest("hex");
      database.connection.prepare(`
        INSERT INTO live_acquisition_origin_courtesy_state (
          coordinator_run_id, coordinator_run_generation_id, consent_id,
          canonical_origin_digest, origin_digest, robots_policy_digest, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(ownership.run_id, ownership.run_generation_id, fixture.consentId,
        originDigest, originDigest, "8".repeat(64), at);
      let now = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const url = "https://www.cloudflare.com/v5-handoff";
      const page = ledger.planUnknownPage({ consentId: fixture.consentId, url });
      resolveAndAuthorize(ledger, page.id);
      ledger.start(page.id);
      const rawBody = new TextEncoder().encode("Useful handoff evidence. ".repeat(30));
      ledger.completePage(page.id, { rawBody,
        extractedText: new TextDecoder().decode(rawBody),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64) });
      now = new Date("2026-08-14T12:00:01.000Z");
      let quoteCalls = 0;
      const provider = {
        metadata: { provider: "anthropic" as const, model: "fixture-model",
          promptVersion: "fixture-prompt", pricingVersion: "fixture-price" },
        quote: () => {
          expect(database.connection.inTransaction).toBe(false);
          quoteCalls += 1;
          return { version: "research_provider_quote:v1" as const,
          inputDigest: "a".repeat(64), calls: 1 as const, inputTokens: 100,
          outputTokens: 100, costUsd: 0.25, wallTimeMs: 1_000 };
        },
        async start() { throw new Error("provider must not start during handoff"); },
      };
      const claim = { id: fixture.jobId, attemptId: fixture.jobId,
        attemptNo: 1, leaseToken: "recovery-lease-token-8501" } as AiJobClaim;
      const counts = () => database.connection.prepare(`SELECT
        (SELECT COUNT(*) FROM live_acquisition_handoffs) AS handoffs,
        (SELECT COUNT(*) FROM live_acquisition_source_receipts) AS receipts,
        (SELECT COUNT(*) FROM live_acquisition_handoff_receipts) AS terminals,
        (SELECT COUNT(*) FROM live_acquisition_provider_reservations) AS reservations,
        (SELECT COUNT(*) FROM ai_jobs) AS jobs,
        (SELECT COUNT(*) FROM research_runs) AS runs
      `).get();
      for (const phase of ["after_supersede", "after_final_run", "after_sources",
        "after_reservation"] as const) {
        const before = counts();
        const failing = createLiveAcquisitionHandoff(database.connection, {
          provider, clock: () => now,
          faultPhase: phase,
        });
        expect(() => failing.completeClaim(claim)).toThrow(`injected ${phase}`);
        expect(counts()).toEqual(before);
      }
      const invalidQuote = createLiveAcquisitionHandoff(database.connection, {
        provider: { ...provider, quote: () => ({ ...provider.quote(), inputDigest: "invalid" }) },
        clock: () => now,
      });
      const beforeInvalidQuote = counts();
      expect(() => invalidQuote.completeClaim(claim)).toThrow("Live handoff quote drifted");
      expect(counts()).toEqual(beforeInvalidQuote);

      let driftPageId = 0;
      const drifting = createLiveAcquisitionHandoff(database.connection, {
        provider: { ...provider, quote: () => {
          expect(database.connection.inTransaction).toBe(false);
          driftPageId = ledger.planUnknownPage({ consentId: fixture.consentId,
            url: "https://www.cloudflare.com/v5-drift" }).id;
          return provider.quote();
        } },
        clock: () => now,
      });
      expect(() => drifting.completeClaim(claim)).toThrow(
        "Live handoff snapshot changed during quote",
      );
      expect(counts()).toEqual(beforeInvalidQuote);
      ledger.beginResolution(driftPageId);
      ledger.block(driftPageId, "TRANSPORT_DNS_FAILURE");
      const handoff = createLiveAcquisitionHandoff(database.connection, {
        provider,
        clock: () => now,
      });
      const result = handoff.completeClaim(claim);
      expect(result.kind).toBe("handoff");
      if (result.kind !== "handoff") throw new Error("fresh handoff was not created");
      const finalCorpus = createResearchCorpusReader(database.connection).readForJob(
        `resource_research:${result.finalJobId}`,
      );
      expect(finalCorpus.sources).toHaveLength(1);
      expect(finalCorpus.snapshots).toHaveLength(1);
      expect(finalCorpus.snapshots[0]).toMatchObject({ kind: "resource_context",
        snapshotDigest, material: { body: "shareable handoff context" } });
      expect(database.connection.prepare(`
        SELECT handoff.status AS handoff_status, terminal.receipt_digest,
          reservation.status AS reservation_status,
          source.source_kind, source.inclusion_state
        FROM live_acquisition_handoffs AS handoff
        JOIN live_acquisition_handoff_receipts AS terminal ON terminal.handoff_id=handoff.id
        JOIN live_acquisition_provider_reservations AS reservation
          ON reservation.handoff_id=handoff.id
        JOIN research_sources AS source ON source.run_id=handoff.final_run_id
      `).get()).toMatchObject({ handoff_status: "completed", reservation_status: "active",
        source_kind: "live_acquisition", inclusion_state: "included" });
      const completedCounts = counts();
      const completedQuoteCalls = quoteCalls;
      expect(handoff.completeClaim(claim)).toEqual(result);
      expect(counts()).toEqual(completedCounts);
      expect(quoteCalls).toBe(completedQuoteCalls);
    } finally {
      database.close();
    }
  });

  it("rejects sensitive and unapproved unknown URLs without durable writes", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const counts = () => database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_actions) AS actions,
          (SELECT COUNT(*) FROM live_acquisition_url_payloads) AS urls,
          (SELECT COUNT(*) FROM live_acquisition_action_events) AS events,
          (SELECT COUNT(*) FROM live_acquisition_checkpoints) AS checkpoints
      `).get();
      const before = counts();
      expect(() => ledger.planUnknownPage({
        consentId: 1,
        url: "https://user:secret@www.cloudflare.com/private",
      })).toThrow();
      expect(() => ledger.planUnknownPage({
        consentId: 1,
        url: "https://example.com/",
      })).toThrow();
      expect(counts()).toEqual(before);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM logical_pages
        WHERE url_normalized IN (?, ?)
      `).pluck().get(
        "https://www.cloudflare.com/private",
        "https://example.com/",
      )).toBe(0);
    } finally {
      database.close();
    }
  });

  it("fails closed when an idempotent replay payload no longer matches its URL HMAC", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const url = "https://www.cloudflare.com/replay-hmac";
      const action = ledger.planUnknownPage({ consentId: 1, url });
      database.connection.exec("DROP TRIGGER live_acquisition_url_payloads_immutable_update");
      database.connection.prepare(`
        UPDATE live_acquisition_url_payloads SET keyed_url_digest = ? WHERE action_id = ?
      `).run("f".repeat(64), action.id);
      const before = database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_actions) AS actions,
          (SELECT COUNT(*) FROM live_acquisition_url_payloads) AS urls,
          (SELECT COUNT(*) FROM live_acquisition_action_events) AS events,
          (SELECT COUNT(*) FROM live_acquisition_checkpoints) AS checkpoints
      `).get();
      expect(() => ledger.planUnknownPage({ consentId: 1, url }))
        .toThrow(/replay identity mismatch/);
      expect(database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM live_acquisition_actions) AS actions,
          (SELECT COUNT(*) FROM live_acquisition_url_payloads) AS urls,
          (SELECT COUNT(*) FROM live_acquisition_action_events) AS events,
          (SELECT COUNT(*) FROM live_acquisition_checkpoints) AS checkpoints
      `).get()).toEqual(before);
    } finally {
      database.close();
    }
  });


  it("plans an unknown URL without prefetch identity and materializes it atomically on completion", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection, { allowPages: true });
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const url = "https://www.cloudflare.com/unknown-root";
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE url_normalized = ?",
      ).pluck().get(url)).toBe(0);

      const action = ledger.planUnknownPage({ consentId: 1, url });
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE url_normalized = ?",
      ).pluck().get(url)).toBe(0);
      expect(ledger.planUnknownPage({ consentId: 1, url }).id).toBe(action.id);

      resolveAndAuthorize(ledger, action.id);
      ledger.start(action.id);
      const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
      ledger.completePage(action.id, {
        rawBody,
        extractedText: "Useful public evidence. ".repeat(30),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64),
      });

      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM logical_pages WHERE url_normalized = ?
      `).pluck().get(url)).toBe(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*)
        FROM live_acquisition_capture_manifests AS capture
        JOIN privacy_subject_generations AS generation
          ON generation.id = capture.logical_page_generation_id
          AND generation.subject_kind = 'logical_page' AND generation.is_active = 1
        JOIN resource_resolution_heads AS resolution
          ON resolution.logical_page_id = generation.logical_page_id
        WHERE capture.action_id = ?
      `).pluck().get(action.id)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rolls back every unknown identity row when terminal materialization fails", () => {
    for (const phase of ["logical_page", "resource_resolution"] as const) {
      const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
      try {
        seedReceiptBackedLiveResearchRun(database.connection);
        installFixtureConsentPayloads(database.connection, { allowPages: true });
        const ledger = createLiveAcquisitionActionLedger(database.connection, {
          clock: () => new Date(at),
          testOnlyMaterializationCheckpoint(current) {
            if (current === phase) throw new Error(`injected ${phase}`);
          },
        });
        const url = `https://www.cloudflare.com/fail-${phase}`;
        const action = ledger.planUnknownPage({ consentId: 1, url });
        resolveAndAuthorize(ledger, action.id);
        ledger.start(action.id);
        const counts = () => database.connection.prepare(`
          SELECT
            (SELECT COUNT(*) FROM logical_pages WHERE url_normalized = @url) AS pages,
            (SELECT COUNT(*) FROM logical_page_preferences AS preference
              JOIN logical_pages AS page ON page.id = preference.logical_page_id
              WHERE page.url_normalized = @url) AS preferences,
            (SELECT COUNT(*) FROM privacy_subject_generations AS generation
              JOIN logical_pages AS page ON page.id = generation.logical_page_id
              WHERE page.url_normalized = @url) AS generations,
            (SELECT COUNT(*) FROM resource_resolution_events AS resolution
              JOIN logical_pages AS page ON page.id = resolution.logical_page_id
              WHERE page.url_normalized = @url) AS resolutions,
            (SELECT COUNT(*) FROM live_acquisition_body_payloads
              WHERE action_id = @actionId) AS bodies,
            (SELECT COUNT(*) FROM live_acquisition_capture_manifests
              WHERE action_id = @actionId) AS captures
        `).get({ url, actionId: action.id });
        const before = counts();
        const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
        expect(() => ledger.completePage(action.id, {
          rawBody,
          extractedText: "Useful public evidence. ".repeat(30),
          contentDigest: createHash("sha256").update(rawBody).digest("hex"),
          responseMetadataDigest: "9".repeat(64),
        })).toThrow(`injected ${phase}`);
        expect(counts()).toEqual(before);
        expect(ledger.read(action.id).state).toBe("started");
      } finally {
        database.close();
      }
    }
  });

  it("rolls back unknown materialization when the actual resolution conflicts with consent", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection, { overlappingPathResource: true });
      installFixtureConsentPayloads(database.connection, { allowPages: true });
      const url = "https://www.cloudflare.com/terminal-conflict";
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
        testOnlyMaterializationCheckpoint(phase) {
          if (phase !== "logical_page") return;
          const pageId = Number(database.connection.prepare(
            "SELECT id FROM logical_pages WHERE url_normalized = ?",
          ).pluck().get(url));
          const consentedResourceId = Number(database.connection.prepare(`
            SELECT generation.resource_id FROM live_acquisition_consents AS consent
            JOIN privacy_subject_generations AS generation
              ON generation.id = consent.resource_generation_id WHERE consent.id = 1
          `).pluck().get());
          const foreignResourceId = Number(database.connection.prepare(`
            SELECT id FROM resources WHERE id <> ? ORDER BY id DESC LIMIT 1
          `).pluck().get(consentedResourceId));
          const assignmentId = Number(database.connection.prepare(`
            SELECT COALESCE(MAX(id), 0) + 1 FROM logical_page_resource_assignments
          `).pluck().get());
          database.connection.prepare(`
            INSERT INTO logical_page_resource_assignments (
              id, logical_page_id, action, resource_id, provenance_class,
              assigned_by, assignment_method, source_fingerprint, created_at
            ) VALUES (?, ?, 'assigned', ?, 'user_manual', 'user', 'manual', ?, ?)
          `).run(assignmentId, pageId, foreignResourceId,
            `terminal-conflict:${pageId}`, at);
          database.connection.prepare(`
            INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
            VALUES (?, ?)
          `).run(pageId, assignmentId);
        },
      });
      const action = ledger.planUnknownPage({ consentId: 1, url });
      resolveAndAuthorize(ledger, action.id);
      ledger.start(action.id);
      const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
      expect(() => ledger.completePage(action.id, {
        rawBody,
        extractedText: "Useful public evidence. ".repeat(30),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64),
      })).toThrow(/ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH/);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE url_normalized = ?",
      ).pluck().get(url)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_body_payloads WHERE action_id = ?",
      ).pluck().get(action.id)).toBe(0);
      expect(ledger.read(action.id).state).toBe("started");
    } finally {
      database.close();
    }
  });

  it("rejects an overlapping path rule outside the consented Resource at queue admission", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      (seedReceiptBackedLiveResearchRun as unknown as (
        connection: Database.Database,
        options: { readonly overlappingPathResource: boolean },
      ) => unknown)(database.connection, { overlappingPathResource: true });
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const url = "https://www.cloudflare.com/foreign/page";
      const logicalPageId = installResolvedFixturePage(database.connection, url);
      const actionsBefore = Number(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_actions",
      ).pluck().get());

      expect(() => ledger.planPage({ consentId: 1, logicalPageId, url }))
        .toThrow(/ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH/);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_actions",
      ).pluck().get()).toBe(actionsBefore);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_page_reservations",
      ).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("linearizes one page action and fences every post-terminal write", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection, { allowPages: true });
      let now = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const logicalPageId = installResolvedFixturePage(
        database.connection,
        "https://www.cloudflare.com/research",
      );
      const action = ledger.planPage({
        consentId: 1,
        logicalPageId,
        url: "https://www.cloudflare.com/research",
      });
      ledger.beginResolution(action.id);
      const resolution = classifyPublicDnsAnswers([
        { address: "104.16.132.229", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      ledger.recordResolution(action.id, resolution);
      ledger.authorize(action.id);
      ledger.start(action.id);
      now = new Date("2026-08-14T12:00:01.000Z");
      const rawBody = new TextEncoder().encode("Useful public research evidence. ".repeat(20));
      ledger.completePage(action.id, {
        rawBody,
        extractedText: "Useful public research evidence. ".repeat(20),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "4".repeat(64),
      });
      expect(database.connection.prepare(`
        SELECT state, sequence_no FROM live_acquisition_actions WHERE id = ?
      `).get(action.id)).toEqual({ state: "completed", sequence_no: 6 });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_capture_manifests WHERE action_id = ?
      `).pluck().get(action.id)).toBe(1);
      expect(() => ledger.start(action.id)).toThrow(/authorized action/i);
      const sequenceBeforeReplay = ledger.read(action.id).sequence_no;
      expect(ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/research",
      })).toMatchObject({ id: action.id, state: "completed" });
      expect(ledger.read(action.id).sequence_no).toBe(sequenceBeforeReplay);
    } finally {
      database.close();
    }
  });

  it("rejects a changed DNS callback fence and never commits resolution material", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      let now = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const action = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/fenced" });
      ledger.beginResolution(action.id);
      now = new Date("2026-08-14T12:05:00.000Z");
      const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");

      expect(() => ledger.recordResolution(action.id, resolution)).toThrow(/fence/i);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_dns_payloads WHERE action_id = ?",
      ).pluck().get(action.id)).toBe(0);
      expect(ledger.read(action.id).state).toBe("resolution_started");
    } finally {
      database.close();
    }
  });

  it("fences expiry at queue, resolution, authorization, start, and materialization", () => {
    const phases = ["queue", "resolution", "authorization", "start", "materialization"] as const;
    for (const [phaseIndex, phase] of phases.entries()) {
      const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
      try {
        seedReceiptBackedLiveResearchRun(database.connection);
        installFixtureConsentPayloads(database.connection, { allowPages: true });
        let now = new Date(at);
        const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
        if (phase === "queue") {
          now = new Date("2026-08-14T12:05:00.000Z");
          expect(() => ledger.planPage({ consentId: 1, logicalPageId: 7_001,
            url: "https://www.cloudflare.com/expired" })).toThrow(/consent/i);
          continue;
        }
        const url = `https://www.cloudflare.com/expiry-${phaseIndex}`;
        const logicalPageId = phase === "materialization"
          ? installResolvedFixturePage(database.connection, url)
          : 7_001;
        const action = ledger.planPage({ consentId: 1, logicalPageId, url });
        if (phase === "resolution") {
          now = new Date("2026-08-14T12:05:00.000Z");
          expect(() => ledger.beginResolution(action.id)).toThrow(/fence/i);
          continue;
        }
        ledger.beginResolution(action.id);
        const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
        if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
        ledger.recordResolution(action.id, resolution);
        if (phase === "authorization") {
          now = new Date("2026-08-14T12:05:00.000Z");
          expect(() => ledger.authorize(action.id)).toThrow(/fence/i);
          continue;
        }
        ledger.authorize(action.id);
        if (phase === "start") {
          now = new Date("2026-08-14T12:00:15.000Z");
          expect(() => ledger.start(action.id)).toThrow(/expired/i);
          continue;
        }
        ledger.start(action.id);
        now = new Date("2026-08-14T12:00:15.000Z");
        const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
        expect(() => ledger.completePage(action.id, {
          rawBody,
          extractedText: "Useful public evidence. ".repeat(30),
          contentDigest: createHash("sha256").update(rawBody).digest("hex"),
          responseMetadataDigest: "9".repeat(64),
        })).toThrow(/expired/i);
        expect(database.connection.prepare(
          "SELECT COUNT(*) FROM live_acquisition_body_payloads WHERE action_id = ?",
        ).pluck().get(action.id)).toBe(0);
      } finally {
        database.close();
      }
    }
  });

  it("advances the runtime epoch and terminalizes every prior phase without replay", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection, { allowPages: true });
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:00:02.000Z"),
      });
      const resolution = classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 4 }]);
      if (resolution.kind !== "allowed") throw new Error("fixture resolution rejected");
      const resolving = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/a" });
      ledger.beginResolution(resolving.id);
      const resolved = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/b" });
      ledger.beginResolution(resolved.id);
      ledger.recordResolution(resolved.id, resolution);
      const started = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/c" });
      ledger.beginResolution(started.id);
      ledger.recordResolution(started.id, resolution);
      ledger.authorize(started.id);
      ledger.start(started.id);

      expect(ledger.advanceRuntimeEpochAndRecover(false)).toEqual({
        runtimeEpoch: 2,
        recoveredActions: 3,
        recoveredJobs: 0,
        releasedReservations: 1,
      });
      expect(database.connection.prepare(`
        SELECT state FROM live_acquisition_actions
        WHERE id IN (?, ?, ?) ORDER BY id
      `).all(resolving.id, resolved.id, started.id)).toEqual([
        { state: "ambiguous" },
        { state: "blocked" },
        { state: "ambiguous" },
      ]);
      expect(database.connection.prepare(`
        SELECT off_recovery_marker FROM live_acquisition_runtime_state WHERE singleton_id = 1
      `).pluck().get()).toBe("completed");
    } finally {
      database.close();
    }
  });

  it("advances the runtime epoch when the runtime clock is behind migration time", () => {
    const migrationAt = "2026-08-15T12:00:00.000Z";
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(migrationAt),
    });
    try {
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:00:00.000Z"),
      });

      expect(ledger.advanceRuntimeEpochAndRecover(false)).toEqual({
        runtimeEpoch: 2,
        recoveredActions: 0,
        recoveredJobs: 0,
        releasedReservations: 0,
      });
      expect(database.connection.prepare(`
        SELECT runtime_epoch, off_recovery_marker, updated_at
        FROM live_acquisition_runtime_state WHERE singleton_id = 1
      `).get()).toEqual({
        runtime_epoch: 2,
        off_recovery_marker: "completed",
        updated_at: migrationAt,
      });
    } finally {
      database.close();
    }
  });

  it("off recovery consumes the exact C90 attempt and revokes old consent", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:01:00.000Z"),
      });
      const action = ledger.planRobots({
        consentId: fixture.consentId,
        canonicalOrigin: "https://www.cloudflare.com",
      });
      ledger.beginResolution(action.id);

      expect(ledger.advanceRuntimeEpochAndRecover(false)).toMatchObject({
        runtimeEpoch: 2,
        recoveredActions: 1,
        recoveredJobs: 1,
      });
      expect(database.connection.prepare(
        "SELECT status FROM ai_jobs WHERE id = ?",
      ).pluck().get(fixture.jobId)).toBe("superseded");
      expect(database.connection.prepare(
        "SELECT outcome FROM ai_job_attempts WHERE id = ?",
      ).pluck().get(fixture.jobId)).toBe("superseded");
      expect(database.connection.prepare(
        "SELECT status FROM live_acquisition_consents WHERE id = ?",
      ).pluck().get(fixture.consentId)).toBe("revoked");
      expect(ledger.read(action.id).state).toBe("ambiguous");
      expect(JSON.parse(database.connection.prepare(`
        SELECT checkpoint_json FROM live_acquisition_checkpoints WHERE attempt_id = ?
      `).pluck().get(fixture.jobId) as string)).toMatchObject({
        stage: "ambiguous",
        counters: { robotsActions: 0, networkActions: 0 },
        queue: { plannedActionIds: [], activeActionIds: [] },
      });
    } finally {
      database.close();
    }
  });

  it("rolls back and replays exact final-attempt recovery through the terminal event", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const attemptId = 9_702;
      const leaseToken = "final-recovery-lease-token-9702";
      database.connection.prepare(`
        INSERT INTO ai_job_attempts (
          id, job_id, attempt_no, lease_token, worker_id, started_at, outcome
        ) VALUES (?, ?, 1, ?, 'final-recovery-worker', ?, 'running')
      `).run(attemptId, fixture.finalJobId, leaseToken, at);
      database.connection.exec(`
        CREATE TEMP TRIGGER fail_provider_release_for_exact_replay
        BEFORE UPDATE ON live_acquisition_provider_reservations
        BEGIN
          SELECT RAISE(ABORT, 'forced provider release rollback');
        END;
      `);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:01:00.000Z"),
      });

      expect(() => ledger.advanceRuntimeEpochAndRecover(false))
        .toThrow(/forced provider release rollback/i);
      expect(database.connection.prepare(`
        SELECT runtime_epoch FROM live_acquisition_runtime_state WHERE singleton_id = 1
      `).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT status, event_sequence, lease_token FROM ai_jobs WHERE id = ?
      `).get(fixture.finalJobId)).toEqual({
        status: "running",
        event_sequence: 2,
        lease_token: leaseToken,
      });
      expect(database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(attemptId)).toBe("running");
      expect(database.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({ status: "active", terminal_at: null });

      database.connection.exec(`DROP TRIGGER fail_provider_release_for_exact_replay;`);
      expect(ledger.advanceRuntimeEpochAndRecover(false)).toMatchObject({
        runtimeEpoch: 2,
        releasedReservations: 1,
      });
      expect(database.connection.prepare(`
        SELECT event_type, from_status, to_status, attempt_id, lease_token
        FROM ai_job_events WHERE job_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).get(fixture.finalJobId)).toEqual({
        event_type: "superseded",
        from_status: "running",
        to_status: "superseded",
        attempt_id: attemptId,
        lease_token: leaseToken,
      });
      expect(database.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({
        status: "released",
        terminal_at: "2026-08-14T12:01:00.000Z",
      });
      expect(database.connection.prepare(`
        SELECT outcome FROM ai_job_attempts WHERE id = ?
      `).pluck().get(attemptId)).toBe("superseded");
    } finally {
      database.close();
    }
  });

  it("preserves a handed-off final-provider reservation during enabled restart recovery", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:01:00.000Z"),
      });

      expect(ledger.advanceRuntimeEpochAndRecover(true)).toMatchObject({
        releasedReservations: 0,
      });
      expect(database.connection.prepare(`
        SELECT status, terminal_at FROM live_acquisition_provider_reservations WHERE id = 1
      `).get()).toEqual({ status: "active", terminal_at: null });
    } finally {
      database.close();
    }
  });

  it("persists page 429 Retry-After across restart and never retries the action", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection);
      let now = new Date(at);
      let ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const robots = ledger.planRobots({
        consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com",
      });
      resolveAndAuthorize(ledger, robots.id);
      ledger.start(robots.id);
      completePermissiveRobots(ledger, robots.id);

      now = new Date("2026-08-14T12:00:02.001Z");
      const throttled = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/throttled",
      });
      resolveAndAuthorize(ledger, throttled.id);
      ledger.start(throttled.id);
      ledger.block(throttled.id, "HTTP_CLIENT_ERROR", false, "600");

      expect(database.connection.prepare(`
        SELECT retry_after_until FROM live_acquisition_origin_courtesy_state
      `).pluck().get()).toBe("2026-08-14T12:05:00.000Z");
      expect(ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/throttled",
      })).toMatchObject({ id: throttled.id, state: "blocked" });

      ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const afterRestart = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_001,
        url: "https://www.cloudflare.com/after-restart",
      });
      resolveAndAuthorize(ledger, afterRestart.id);
      expect(() => ledger.start(afterRestart.id)).toThrow(/courtesy/i);
    } finally {
      database.close();
    }
  });

  it("rejects robots completion without durable policy evidence and rolls back courtesy", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      const robots = ledger.planRobots({ consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com" });
      resolveAndAuthorize(ledger, robots.id);
      ledger.start(robots.id);
      expect(() => ledger.completeRobots(robots.id, {
        policyDigest: permissiveRobotsPolicy.policyDigest,
        crawlDelayMs: permissiveRobotsPolicy.crawlDelayMs,
      } as never)).toThrow(/policy evidence/i);
      expect(ledger.read(robots.id).state).toBe("started");
      expect(database.connection.prepare(`
        SELECT robots_policy_digest FROM live_acquisition_origin_courtesy_state
      `).pluck().get()).toBeNull();
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_body_payloads WHERE action_id = ?
      `).pluck().get(robots.id)).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([undefined, "1.5"])(
    "blocks an origin for the rest of the run for missing or malformed Retry-After %j",
    (retryAfter) => {
      const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
      try {
        seedReceiptBackedLiveResearchRun(database.connection);
        installFixtureConsentPayloads(database.connection);
        let now = new Date(at);
        const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
        const robots = ledger.planRobots({ consentId: 1,
          canonicalOrigin: "https://www.cloudflare.com" });
        resolveAndAuthorize(ledger, robots.id);
        ledger.start(robots.id);
        completePermissiveRobots(ledger, robots.id);
        now = new Date("2026-08-14T12:00:02.001Z");
        const page = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
          url: "https://www.cloudflare.com/throttle-without-valid-header" });
        resolveAndAuthorize(ledger, page.id);
        ledger.start(page.id);
        ledger.block(page.id, "HTTP_CLIENT_ERROR", false, retryAfter);
        expect(database.connection.prepare(`
          SELECT retry_after_until FROM live_acquisition_origin_courtesy_state
        `).pluck().get()).toBe("2026-08-14T12:05:00.000Z");
      } finally {
        database.close();
      }
    },
  );

  it("enforces the persisted two-second cadence atomically across ledger instances", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection);
      let now = new Date(at);
      const firstLedger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const robots = firstLedger.planRobots({ consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com" });
      resolveAndAuthorize(firstLedger, robots.id);
      firstLedger.start(robots.id);
      completePermissiveRobots(firstLedger, robots.id);
      expect(database.connection.prepare(`
        SELECT last_request_at, next_allowed_at
        FROM live_acquisition_origin_courtesy_state
      `).get()).toEqual({
        last_request_at: at,
        next_allowed_at: "2026-08-14T12:00:02.000Z",
      });

      now = new Date("2026-08-14T12:00:02.001Z");
      const first = firstLedger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/race-a" });
      const second = firstLedger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/race-b" });
      resolveAndAuthorize(firstLedger, first.id);
      resolveAndAuthorize(firstLedger, second.id);
      const restartedLedger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      firstLedger.start(first.id);
      expect(() => restartedLedger.start(second.id)).toThrow(/concurrency|courtesy/i);
      expect(restartedLedger.read(second.id).state).toBe("authorized");
      expect(database.connection.prepare(`
        SELECT last_request_at, next_allowed_at FROM live_acquisition_origin_courtesy_state
      `).get()).toEqual({
        last_request_at: "2026-08-14T12:00:02.001Z",
        next_allowed_at: "2026-08-14T12:00:04.001Z",
      });
    } finally {
      database.close();
    }
  });

  it("atomically admits only canonical approved robots-allowed children and replay adds none", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      let now = new Date(at);
      let ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const robotsText = "User-agent: TabHubResearch\nDisallow: /private\nAllow: /private/public\n";
      const robotsPolicy = parseRobotsPolicy(robotsText);
      if (robotsPolicy.kind !== "parsed") throw new Error("fixture robots policy rejected");
      const robots = ledger.planRobots({ consentId: 1,
        canonicalOrigin: "https://www.cloudflare.com" });
      resolveAndAuthorize(ledger, robots.id);
      ledger.start(robots.id);
      ledger.completeRobots(robots.id, {
        policyDigest: robotsPolicy.policyDigest,
        crawlDelayMs: robotsPolicy.crawlDelayMs,
        policyText: robotsText,
      });

      now = new Date("2026-08-14T12:00:02.001Z");
      const parent = ledger.planPage({ consentId: 1, logicalPageId: 7_001,
        url: "https://www.cloudflare.com/parent" });
      resolveAndAuthorize(ledger, parent.id);
      ledger.start(parent.id);
      const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
      const completion = ledger.completePage(parent.id, {
        rawBody,
        extractedText: new TextDecoder().decode(rawBody),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64),
        discoveredLinks: [
          "https://www.cloudflare.com/child#first",
          "https://www.cloudflare.com/child#second",
          "https://www.cloudflare.com/private/blocked",
          "https://example.com/unapproved",
          "https://www.cloudflare.com/accessToken",
        ],
      });
      expect(completion.admittedActionIds).toHaveLength(1);
      const child = database.connection.prepare(`
        SELECT action.id, action.depth, action.discovered_from_action_id, url.exact_url
        FROM live_acquisition_actions AS action
        JOIN live_acquisition_url_payloads AS url ON url.action_id = action.id
        WHERE action.id = ?
      `).get(completion.admittedActionIds[0]) as Record<string, unknown>;
      expect(child).toMatchObject({
        depth: 1,
        discovered_from_action_id: parent.id,
        exact_url: "https://www.cloudflare.com/child",
      });

      ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      expect(() => ledger.completePage(parent.id, {
        rawBody,
        extractedText: new TextDecoder().decode(rawBody),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64),
        discoveredLinks: ["https://www.cloudflare.com/child"],
      })).toThrow(/started page action/i);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions
        WHERE action_kind = 'page' AND depth = 1
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it.each([301, 1_000])(
  "atomically drains a %i-page frontier after maxPages and stays drained after restart",
  (frontierSize) => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      let ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      for (let index = 0; index < frontierSize; index += 1) {
        ledger.planPage({ consentId: 1, logicalPageId: 7_001,
          url: `https://www.cloudflare.com/queue-${index}` });
      }
      if (frontierSize === 1_000) {
        expect(() => ledger.planPage({ consentId: 1, logicalPageId: 7_001,
          url: "https://www.cloudflare.com/queue-overflow" })).toThrow(/queue limit/i);
      }
      const ids = database.connection.prepare(`
        SELECT id FROM live_acquisition_actions
        WHERE consent_id = 1 AND action_kind = 'page' AND state = 'planned'
        ORDER BY id
      `).all() as Array<{ id: number }>;
      expect(ids).toHaveLength(frontierSize);
      for (const { id } of ids.slice(0, 9)) ledger.beginResolution(id);
      expect(() => ledger.beginResolution(ids[9]!.id))
        .toThrow(/page reservation budget exhausted/i);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions
        WHERE consent_id = 1 AND action_kind = 'page' AND state = 'planned'
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_actions
        WHERE consent_id = 1 AND action_kind = 'page' AND state = 'blocked'
      `).pluck().get()).toBe(frontierSize - 9);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM live_acquisition_page_reservations WHERE consent_id = 1
      `).pluck().get()).toBe(10);
      ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      expect(ledger.read(ids[9]!.id).state).toBe("blocked");
    } finally {
      database.close();
    }
  }, 60_000);

  it("admits beyond maxPages and deterministically blocks the unreserveable suffix", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      seedReceiptBackedLiveResearchRun(database.connection);
      installFixtureConsentPayloads(database.connection);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date(at),
      });
      ledger.planRobots({ consentId: 1, canonicalOrigin: "https://www.cloudflare.com" });
      const pages: Array<ReturnType<typeof ledger.planPage>> = Array.from(
        { length: 11 }, (_, index) =>
        ledger.planPage({ consentId: 1, logicalPageId: 7_001,
          url: `https://www.cloudflare.com/capped-${index}` }));
      for (const page of pages.slice(0, 9)) ledger.beginResolution(page.id);
      expect(() => ledger.beginResolution(pages[9]!.id))
        .toThrow(/page reservation budget exhausted/i);
      for (const page of pages.slice(9)) expect(ledger.read(page.id).state).toBe("blocked");
      expect(database.connection.prepare(`
        SELECT action_kind, COUNT(*) AS count
        FROM live_acquisition_actions
        GROUP BY action_kind ORDER BY action_kind
      `).all()).toEqual([
        { action_kind: "page", count: 12 },
        { action_kind: "robots", count: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("commits typed reconstructable counters with each terminal action", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedRunningC90Coordinator(database.connection);
      let now = new Date(at);
      const ledger = createLiveAcquisitionActionLedger(database.connection, { clock: () => now });
      const robots = ledger.planRobots({ consentId: fixture.consentId,
        canonicalOrigin: "https://www.cloudflare.com" });
      resolveAndAuthorize(ledger, robots.id);
      ledger.start(robots.id);
      completePermissiveRobots(ledger, robots.id);
      expect(JSON.parse(database.connection.prepare(`
        SELECT checkpoint_json FROM live_acquisition_checkpoints WHERE attempt_id = ?
      `).pluck().get(fixture.jobId) as string)).toMatchObject({
        version: 1,
        stage: "no_eligible_source",
        counters: {
          reservedPages: 0,
          visitedPages: 0,
          capturedPages: 0,
          blockedPages: 0,
          ambiguousPages: 0,
          robotsActions: 1,
          networkActions: 1,
        },
      });

      now = new Date("2026-08-14T12:00:02.001Z");
      const logicalPageId = installResolvedFixturePage(
        database.connection,
        "https://www.cloudflare.com/checkpoint",
        fixture.consentId,
      );
      const page = ledger.planPage({ consentId: fixture.consentId,
        logicalPageId,
        url: "https://www.cloudflare.com/checkpoint" });
      resolveAndAuthorize(ledger, page.id);
      ledger.start(page.id);
      const rawBody = new TextEncoder().encode("Useful public evidence. ".repeat(30));
      ledger.completePage(page.id, { rawBody,
        extractedText: "Useful public evidence. ".repeat(30),
        contentDigest: createHash("sha256").update(rawBody).digest("hex"),
        responseMetadataDigest: "9".repeat(64) });
      const checkpointRow = database.connection.prepare(`
        SELECT checkpoint_json, checkpoint_digest
        FROM live_acquisition_checkpoints WHERE attempt_id = ?
      `).get(fixture.jobId) as { checkpoint_json: string; checkpoint_digest: string };
      expect(JSON.parse(checkpointRow.checkpoint_json)).toEqual({
        version: 1,
        stage: "ready_for_handoff",
        consentId: fixture.consentId,
        runtimeEpoch: 1,
        counters: {
          reservedPages: 1,
          visitedPages: 1,
          capturedPages: 1,
          blockedPages: 0,
          ambiguousPages: 0,
          robotsActions: 1,
          networkActions: 2,
        },
        queue: { plannedActionIds: [], activeActionIds: [] },
      });
      expect(checkpointRow.checkpoint_digest).toBe(
        createHash("sha256").update(checkpointRow.checkpoint_json).digest("hex"),
      );

      now = new Date("2026-08-14T12:00:04.002Z");
      const unusablePage = createLogicalPageCatalog(database.connection, () => now).resolve({
        observedAt: now.toISOString(),
        url: "https://www.cloudflare.com/unusable-checkpoint",
        urlNormalized: "https://www.cloudflare.com/unusable-checkpoint",
      });
      const unusable = ledger.planPage({ consentId: fixture.consentId,
        logicalPageId: unusablePage.id,
        url: "https://www.cloudflare.com/unusable-checkpoint" });
      ledger.beginResolution(unusable.id);
      ledger.block(unusable.id, "TRANSPORT_DNS_FAILURE");
      expect(JSON.parse(database.connection.prepare(`
        SELECT checkpoint_json FROM live_acquisition_checkpoints WHERE attempt_id = ?
      `).pluck().get(fixture.jobId) as string)).toMatchObject({
        stage: "ready_for_handoff",
        counters: {
          reservedPages: 2,
          visitedPages: 1,
          capturedPages: 1,
          blockedPages: 1,
          ambiguousPages: 0,
          robotsActions: 1,
          networkActions: 2,
        },
      });
    } finally {
      database.close();
    }
  });
});
