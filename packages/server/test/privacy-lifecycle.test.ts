import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createPrivacyLifecycle } from "../src/privacy-lifecycle.js";
import { createLiveAcquisitionActionLedger } from "../src/live-acquisition-action-ledger.js";
import {
  digestPrivacyPurgeExecutionTargets,
  executePrivacyPurgePlan,
} from "../src/live-acquisition-migration.js";
import { createPrivacyPurgeIntentStore } from "../src/privacy-purge-intent-capabilities.js";
import {
  liveResearchFixtureCompletedAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type PrivacyPurgeTarget =
  | Readonly<{ kind: "run" | "logical_page"; subjectGenerationId: number }>
  | Readonly<{ kind: "resource_history"; historyEpochId: number }>;

function publishPrivacyPurgeIntent(
  connection: Database.Database,
  input: {
    readonly idempotencyKey: string;
    readonly target: PrivacyPurgeTarget;
    readonly at: string;
  },
) {
  const canonicalTarget = input.target.kind === "resource_history"
    ? `resource_history:${input.target.historyEpochId}`
    : `${input.target.kind}:${input.target.subjectGenerationId}`;
  const idempotencyKeyHash = sha256(
    `tabhub:privacy-purge:idempotency:v1\0${input.idempotencyKey}`,
  );
  const requestFingerprint = sha256(
    `tabhub:privacy-purge:request:v1\0${canonicalTarget}`,
  );
  const intentKey = sha256(
    `tabhub:test:privacy-purge-intent:v1\0${input.idempotencyKey}\0${canonicalTarget}`,
  );
  const store = createPrivacyPurgeIntentStore(connection, {
    clock: () => new Date(input.at),
  });
  const published = store.publishWaiting({
    intentKey,
    idempotencyKeyHash,
    requestFingerprint,
    target: input.target,
  });
  return { intentKey, published, store };
}

function seedCapturedDescendant(
  connection: Database.Database,
  input: {
    readonly actionId: number;
    readonly parentActionId: number;
    readonly depth: number;
    readonly url: string;
  },
): void {
  const pageId = input.actionId;
  const owner = connection.prepare(`
    SELECT consent.resource_generation_id, consent.history_epoch_id,
      consent.coordinator_run_generation_id, consent.runtime_epoch,
      generation.resource_id
    FROM live_acquisition_consents AS consent
    JOIN privacy_subject_generations AS generation
      ON generation.id = consent.resource_generation_id
    WHERE consent.id = 1
  `).get() as {
    resource_generation_id: number;
    history_epoch_id: number;
    coordinator_run_generation_id: number;
    runtime_epoch: number;
    resource_id: number;
  };
  const body = `captured descendant ${input.actionId}`;
  const bodyDigest = sha256(body);
  const urlDigest = sha256(`privacy-descendant-url:${input.actionId}`);
  const reservationSequence = Number(connection.prepare(`
    SELECT COUNT(*) + 1 FROM live_acquisition_page_reservations WHERE consent_id = 1
  `).pluck().get());
  const captureSequence = Number(connection.prepare(`
    SELECT COUNT(*) + 1 FROM live_acquisition_capture_manifests WHERE consent_id = 1
  `).pluck().get());
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (
      ${pageId}, '${input.url}', '${input.url}', '${input.url}',
      '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z'
    );
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class,
      assigned_by, assignment_method, source_fingerprint, created_at
    ) VALUES (
      ${pageId}, ${pageId}, 'assigned', ${owner.resource_id}, 'user_manual',
      'user', 'manual', 'privacy-descendant-assignment:${pageId}',
      '2026-08-14T12:00:00.000Z'
    );
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
    VALUES (${pageId}, ${pageId});
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, resource_id, assignment_id,
      candidate_resource_ids_json, source_fingerprint, research_eligible, created_at
    ) VALUES (
      ${pageId}, ${pageId}, 'matched', 'user_manual', ${owner.resource_id}, ${pageId},
      '[${owner.resource_id}]', 'privacy-descendant-resolution:${pageId}', 1,
      '2026-08-14T12:00:00.000Z'
    );
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (${pageId}, ${pageId});
  `);
  const pageGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = ? AND is_active = 1
  `).pluck().get(pageId));
  connection.prepare(`
    INSERT INTO live_acquisition_actions (
      id, consent_id, coordinator_run_generation_id, resource_generation_id,
      history_epoch_id, runtime_epoch, action_kind, depth, discovered_from_action_id,
      canonical_fetch_url_fingerprint, canonical_origin_digest, action_key_digest,
      state, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, 'page', ?, ?, ?, NULL, ?, 'planned', ?)
  `).run(
    input.actionId,
    owner.coordinator_run_generation_id,
    owner.resource_generation_id,
    owner.history_epoch_id,
    owner.runtime_epoch,
    input.depth,
    input.parentActionId,
    sha256(input.url),
    sha256(`privacy-descendant-action:${input.actionId}`),
    "2026-08-14T12:00:00.000Z",
  );
  connection.prepare(`
    INSERT INTO live_acquisition_url_payloads (action_id, exact_url, keyed_url_digest)
    VALUES (?, ?, ?)
  `).run(input.actionId, input.url, urlDigest);
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 1, 'planned', 'planned', NULL, '{}', ?)
  `).run(input.actionId, "2026-08-14T12:00:00.000Z");
  const reservationId = Number(connection.prepare(`
    INSERT INTO live_acquisition_page_reservations (
      consent_id, action_id, reservation_sequence, reserved_at
    ) VALUES (1, ?, ?, ?)
  `).run(input.actionId, reservationSequence,
    "2026-08-14T12:00:00.000Z").lastInsertRowid);
  connection.prepare(`
    INSERT INTO live_acquisition_dns_payloads (
      action_id, answers_json, selected_ipv4, resolved_at
    ) VALUES (?, '["203.0.113.1"]', '203.0.113.1', ?)
  `).run(input.actionId, "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 3, 'resolution_started', 'resolved', NULL, '{}', ?)
  `).run(input.actionId, "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_action_authorizations (
      action_id, runtime_epoch, selected_ipv4_digest, authorization_digest,
      authorized_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-14T12:05:00.000Z')
  `).run(input.actionId, owner.runtime_epoch, sha256(`selected:${input.actionId}`),
    sha256(`authorization:${input.actionId}`), "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 4, 'resolved', 'authorized', NULL, '{}', ?)
  `).run(input.actionId, "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 5, 'authorized', 'started', NULL, '{}', ?)
  `).run(input.actionId, "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_body_payloads (
      action_id, raw_body, extracted_text, body_digest,
      response_metadata_json, acquired_at
    ) VALUES (?, ?, ?, ?, '{}', ?)
  `).run(input.actionId, Buffer.from(body, "utf8"), body, bodyDigest,
    "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_capture_manifests (
      id, consent_id, logical_page_generation_id, action_id, reservation_id,
      depth, capture_sequence, url_digest, content_digest, manifest_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(input.actionId, pageGenerationId, input.actionId, reservationId, input.depth,
    captureSequence, urlDigest, bodyDigest, "2026-08-14T12:00:00.000Z");
  connection.prepare(`
    INSERT INTO live_acquisition_action_events (
      action_id, sequence_no, from_state, to_state, outcome_code,
      safe_details_json, occurred_at
    ) VALUES (?, 6, 'started', 'completed', 'FETCH_COMPLETED', '{}', ?)
  `).run(input.actionId, "2026-08-14T12:00:01.000Z");
}

describe("privacy lifecycle", () => {
  it("purges the complete coordinator-to-final-run graph and preserves identities", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      seedCapturedDescendant(database.connection, {
        actionId: 9_302,
        parentActionId: 7_001,
        depth: 1,
        url: "https://www.cloudflare.com/descendant-child",
      });
      seedCapturedDescendant(database.connection, {
        actionId: 9_201,
        parentActionId: 9_302,
        depth: 2,
        url: "https://www.cloudflare.com/descendant-grandchild",
      });
      database.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
      const generationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));

      const idempotencyKey = "forget-live-coordinator-7001";
      const target = { kind: "run" as const, subjectGenerationId: generationId };
      const intent = publishPrivacyPurgeIntent(database.connection, {
        idempotencyKey,
        target,
        at: "2026-08-14T12:00:02.000Z",
      });
      intent.store.freezeReady(intent.intentKey);

      const lifecycle = createPrivacyLifecycle(database.connection, {
        clock: () => new Date("2026-08-14T12:00:02.000Z"),
      });
      const result = lifecycle.purge({
        idempotencyKey,
        target,
      });

      expect(result.status).toBe("completed");
      expect(result.deletedRows).toBeGreaterThan(10);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_runs WHERE id IN (?, ?)",
      ).pluck().get(fixture.coordinatorJobId, fixture.finalRunId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM ai_jobs WHERE id IN (?, ?)",
      ).pluck().get(fixture.coordinatorJobId, fixture.finalJobId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_handoffs WHERE id = ?",
      ).pluck().get(fixture.handoffId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM live_acquisition_actions WHERE id IN (7001, 9302, 9201)",
      ).pluck().get()).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_source_payloads WHERE source_id = ?",
      ).pluck().get(fixture.sourceId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id = 7001",
      ).pluck().get()).toBe(1);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id IN (9201, 9302)",
      ).pluck().get()).toBe(2);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM resources WHERE id = 7001",
      ).pluck().get()).toBe(1);

      const lifecycleTargets = database.connection.prepare(`
        SELECT subject_generation_id, research_run_id, is_root
        FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = ? ORDER BY research_run_id
      `).all(result.commandId);
      expect(lifecycleTargets).toHaveLength(2);
      expect(lifecycleTargets.map((target) =>
        (target as { research_run_id: number }).research_run_id)).toEqual([
        fixture.coordinatorJobId, fixture.finalRunId,
      ]);
      expect(lifecycleTargets.filter((target) =>
        (target as { is_root: number }).is_root === 1)).toHaveLength(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = ?
      `).pluck().get(result.commandId)).toBe(2);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations AS generation
        JOIN privacy_purge_lifecycle_targets AS target
          ON target.subject_generation_id = generation.id
        WHERE target.purge_command_id = ? AND generation.is_active = 0
          AND generation.research_run_id IS NULL
      `).pluck().get(result.commandId)).toBe(2);

      const changesBeforeReplay = database.connection.prepare("SELECT total_changes()")
        .pluck().get();
      expect(lifecycle.purge({
        idempotencyKey,
        target,
      })).toEqual(result);
      expect(database.connection.prepare("SELECT total_changes()").pluck().get())
        .toBe(changesBeforeReplay);
      expect(() => lifecycle.purge({
        idempotencyKey: "forget-live-coordinator-7001",
        target: { kind: "logical_page", subjectGenerationId: generationId },
      })).toThrow(/idempotency/i);
    } finally {
      database.close();
    }
  });

  it("rejects an exact action plan that would retain a discovered child", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      seedCapturedDescendant(database.connection, {
        actionId: 9_302,
        parentActionId: 7_001,
        depth: 1,
        url: "https://www.cloudflare.com/retained-child",
      });
      const generationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));
      const orderedTargets = [{
        tableName: "live_acquisition_actions",
        pkV1: "pk:v1|1|i:4:7001",
      }, {
        tableName: "research_runs",
        pkV1: "pk:v1|1|i:4:7001",
      }, {
        tableName: "research_runs",
        pkV1: "pk:v1|1|i:4:7002",
      }] as const;
      const deletionPlanDigest = digestPrivacyPurgeExecutionTargets(orderedTargets);
      const inserted = database.connection.prepare(`
        INSERT INTO privacy_purge_commands (
          idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, deletion_target_count,
          deletion_plan_digest, status, created_at
        ) VALUES (?, ?, 'run', ?, NULL, 3, ?, 'pending', ?)
      `).run(
        sha256("retained-child-command"),
        sha256("retained-child-request"),
        generationId,
        deletionPlanDigest,
        "2026-08-14T12:00:02.000Z",
      );
      const commandId = Number(inserted.lastInsertRowid);

      expect(() => executePrivacyPurgePlan(database.connection, {
        version: "privacy_purge_execution:v1",
        commandId,
        outcome: "completed",
        orderedTargets,
        tombstoneDigest: "a".repeat(64),
        safeCounts: { deleted_rows: 3 },
        resultDigest: "b".repeat(64),
        completedAt: "2026-08-14T12:00:02.000Z",
      })).toThrow(/cannot retain a discovered live acquisition child/i);
      expect(database.connection.prepare(`
        SELECT id, discovered_from_action_id FROM live_acquisition_actions
        WHERE id IN (7001, 9302) ORDER BY id
      `).all()).toEqual([
        { id: 7_001, discovered_from_action_id: null },
        { id: 9_302, discovered_from_action_id: 7_001 },
      ]);
      expect(database.connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = ?
      `).pluck().get(commandId)).toBe("pending");
    } finally {
      database.close();
    }
  });

  it("keeps a failed lifecycle commitment retryable only through a fresh command", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      database.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
      const generationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
      `).pluck().get(fixture.coordinatorJobId));
      const failedKey = "failed-live-coordinator-7001";
      const idempotencyHash = sha256(
        `tabhub:privacy-purge:idempotency:v1\0${failedKey}`,
      );
      const requestFingerprint = sha256(
        `tabhub:privacy-purge:request:v1\0run:${generationId}`,
      );
      const at = "2026-08-14T12:00:02.000Z";
      const inserted = database.connection.prepare(`
        INSERT INTO privacy_purge_commands (
          idempotency_key_hash, request_fingerprint, target_kind,
          subject_generation_id, history_epoch_id, deletion_target_count,
          deletion_plan_digest, status, created_at
        ) VALUES (?, ?, 'run', ?, NULL, 0, ?, 'pending', ?)
      `).run(
        idempotencyHash,
        requestFingerprint,
        generationId,
        digestPrivacyPurgeExecutionTargets([]),
        at,
      );
      const failedCommandId = Number(inserted.lastInsertRowid);
      executePrivacyPurgePlan(database.connection, {
        version: "privacy_purge_execution:v1",
        commandId: failedCommandId,
        outcome: "failed",
        safeCounts: {},
        resultDigest: "e".repeat(64),
        completedAt: at,
      });

      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
        WHERE purge_command_id = ?
      `).pluck().get(failedCommandId)).toBe(2);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = ?
      `).pluck().get(failedCommandId)).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations AS generation
        JOIN privacy_purge_lifecycle_targets AS target
          ON target.subject_generation_id = generation.id
        WHERE target.purge_command_id = ? AND generation.is_active = 1
      `).pluck().get(failedCommandId)).toBe(2);

      const lifecycle = createPrivacyLifecycle(database.connection, {
        clock: () => new Date("2026-08-14T12:00:03.000Z"),
      });
      expect(() => lifecycle.purge({
        idempotencyKey: failedKey,
        target: { kind: "run", subjectGenerationId: generationId },
      })).toThrow(/already failed/i);
      const retry = lifecycle.purge({
        idempotencyKey: "retry-live-coordinator-7001",
        target: { kind: "run", subjectGenerationId: generationId },
      });
      expect(retry.status).toBe("completed");
      expect(retry.commandId).not.toBe(failedCommandId);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_tombstones WHERE purge_command_id = ?
      `).pluck().get(retry.commandId)).toBe(2);
    } finally {
      database.close();
    }
  });

  it.each(["pending", "waiting"] as const)(
    "rejects a fresh command overlapping a %s root/final lifecycle commitment",
    (status) => {
      const database = openDatabase(":memory:", {
        maximumMigrationVersion: 25,
        migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      try {
        const fixture = seedReceiptBackedLiveResearchRun(database.connection);
        database.connection.prepare(`
          INSERT INTO ai_job_events (
            job_id, sequence_no, event_type, from_status, to_status, occurred_at
          ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
        `).run(fixture.finalJobId, liveResearchFixtureCompletedAt);
        const generationId = Number(database.connection.prepare(`
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
        `).pluck().get(fixture.coordinatorJobId));
        const inserted = database.connection.prepare(`
          INSERT INTO privacy_purge_commands (
            idempotency_key_hash, request_fingerprint, target_kind,
            subject_generation_id, history_epoch_id, deletion_target_count,
            deletion_plan_digest, status, created_at
          ) VALUES (?, ?, 'run', ?, NULL, 0, ?, 'pending', ?)
        `).run(
          sha256(`overlap-owner:${status}`),
          sha256(`overlap-request:${status}`),
          generationId,
          digestPrivacyPurgeExecutionTargets([]),
          "2026-08-14T12:00:02.000Z",
        );
        const ownerCommandId = Number(inserted.lastInsertRowid);
        if (status === "waiting") {
          database.connection.prepare(`
            UPDATE privacy_purge_commands SET status = 'waiting' WHERE id = ?
          `).run(ownerCommandId);
        }
        const lifecycle = createPrivacyLifecycle(database.connection, {
          clock: () => new Date("2026-08-14T12:00:03.000Z"),
        });

        expect(() => lifecycle.purge({
          idempotencyKey: `overlap-contender-${status}`,
          target: { kind: "run", subjectGenerationId: generationId },
        })).toThrow(/lifecycle target|unique/i);
        expect(database.connection.prepare(
          "SELECT COUNT(*) FROM privacy_purge_commands",
        ).pluck().get()).toBe(1);
        expect(database.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_lifecycle_targets
          WHERE purge_command_id = ?
        `).pluck().get(ownerCommandId)).toBe(2);
      } finally {
        database.close();
      }
    },
  );

  it("keeps a resource-history purge waiting while a live action is active", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      database.connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(fixture.finalJobId, "2026-08-14T12:00:00.000Z");
      const originDigest = sha256("https://www.cloudflare.com");
      database.connection.prepare(`
        INSERT INTO live_acquisition_origin_courtesy_state (
          coordinator_run_id, coordinator_run_generation_id, consent_id,
          canonical_origin_digest, origin_digest, robots_policy_digest, updated_at
        ) SELECT ?, coordinator_run_generation_id, id, ?, ?, ?, ?
          FROM live_acquisition_consents WHERE id = 1
      `).run(
        fixture.coordinatorJobId,
        originDigest,
        originDigest,
        "8".repeat(64),
        "2026-08-14T12:00:00.000Z",
      );
      const historyEpochId = Number(database.connection.prepare(`
        SELECT history_epoch_id FROM live_acquisition_consents WHERE id = 1
      `).pluck().get());
      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          7301, 'https://www.cloudflare.com/private-query?q=opaque-value',
          'https://www.cloudflare.com/private-query?q=opaque-value',
          'https://www.cloudflare.com/private-query?q=opaque-value',
          '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO logical_page_resource_assignments (
          id, logical_page_id, action, resource_id, provenance_class,
          assigned_by, assignment_method, source_fingerprint, created_at
        ) VALUES (
          7301, 7301, 'assigned', 7001, 'user_manual', 'user', 'manual',
          'privacy-live-assignment:7301', '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
        VALUES (7301, 7301);
        INSERT INTO resource_resolution_events (
          id, logical_page_id, state, reason, resource_id, assignment_id,
          candidate_resource_ids_json, source_fingerprint, research_eligible, created_at
        ) VALUES (
          7301, 7301, 'matched', 'user_manual', 7001, 7301, '[7001]',
          'privacy-live-resolution:7301', 1, '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
        VALUES (7301, 7301);
      `);
      const ledger = createLiveAcquisitionActionLedger(database.connection, {
        clock: () => new Date("2026-08-14T12:00:00.000Z"),
      });
      const action = ledger.planPage({
        consentId: 1,
        logicalPageId: 7_301,
        url: "https://www.cloudflare.com/private-query?q=opaque-value",
      });
      ledger.beginResolution(action.id);

      const idempotencyKey = "purge-busy-resource-history-7001";
      const target = { kind: "resource_history" as const, historyEpochId };
      const intent = publishPrivacyPurgeIntent(database.connection, {
        idempotencyKey,
        target,
        at: "2026-08-14T12:00:00.000Z",
      });

      expect(() => intent.store.freezeReady(intent.intentKey))
        .toThrow("PURGE_SUBJECT_BUSY");
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_commands",
      ).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT status, action_wait_count
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intent.intentKey)).toEqual({
        status: "waiting",
        action_wait_count: 1,
      });
      expect(database.connection.prepare(`
        SELECT state FROM live_acquisition_actions WHERE id = ?
      `).pluck().get(action.id)).toBe("resolution_started");
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_source_payloads WHERE source_id = ?",
      ).pluck().get(fixture.sourceId)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("forgets page-owned material and live evidence while preserving page/Resource identity", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      database.connection.exec(`
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (
          7001, 3, 'user', 'manual',
          '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO context_entries (
          id, logical_page_id, kind, body, actor, method, visibility,
          state, operation, revision, idempotency_key, created_at
        ) VALUES (
          17001, 7001, 'project', 'private page context', 'agent', 'on_behalf_of_user',
          'local_only', 'active', 'append', 1,
          'privacy-page-context', '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO context_entry_reviews (
          id, context_entry_id, verdict, reviewed_by, review_method,
          idempotency_key, created_at
        ) VALUES (
          17002, 17001, 'accepted', 'user', 'manual',
          'privacy-page-review', '2026-08-14T12:00:00.000Z'
        );
        INSERT INTO logical_page_activity_daily (
          logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
        ) VALUES (
          7001, '2026-08-14', 9000, 4000, '2026-08-14T12:00:00.000Z'
        );
      `);
      const generationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 7001
          AND is_active = 1
      `).pluck().get());
      const idempotencyKey = "forget-page-owned-7001";
      const target = {
        kind: "logical_page" as const,
        subjectGenerationId: generationId,
      };
      const intent = publishPrivacyPurgeIntent(database.connection, {
        idempotencyKey,
        target,
        at: "2026-08-14T12:00:02.000Z",
      });
      intent.store.freezeReady(intent.intentKey);
      const result = createPrivacyLifecycle(database.connection, {
        clock: () => new Date("2026-08-14T12:00:02.000Z"),
      }).purge({
        idempotencyKey,
        target,
      });

      expect(result.status).toBe("completed");
      for (const tableName of [
        "logical_page_preferences",
        "context_entries",
        "context_entry_reviews",
        "logical_page_activity_daily",
      ]) {
        expect(database.connection.prepare(
          `SELECT COUNT(*) FROM ${tableName}`,
        ).pluck().get(), tableName).toBe(0);
      }
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_sources WHERE id = ?",
      ).pluck().get(fixture.sourceId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_source_payloads WHERE source_id = ?",
      ).pluck().get(fixture.sourceId)).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id = 7001",
      ).pluck().get()).toBe(1);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM resources WHERE id = 7001",
      ).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 7001
          AND is_active = 1 AND id <> ?
      `).pluck().get(generationId)).toBe(1);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_runs WHERE id = ?",
      ).pluck().get(fixture.finalRunId)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rolls an empty logical-page generation without deleting its identity", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    try {
      database.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (
          8101, 'https://empty.example/page', 'https://empty.example/page',
          'https://empty.example/page', '2026-08-14T12:00:00.000Z',
          '2026-08-14T12:00:00.000Z'
        );
      `);
      const generationId = Number(database.connection.prepare(`
        SELECT id FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 8101
          AND is_active = 1
      `).pluck().get());
      const lifecycle = createPrivacyLifecycle(database.connection, {
        clock: () => new Date("2026-08-14T12:00:01.000Z"),
      });

      const idempotencyKey = "forget-empty-page-8101";
      const target = {
        kind: "logical_page" as const,
        subjectGenerationId: generationId,
      };
      const intent = publishPrivacyPurgeIntent(database.connection, {
        idempotencyKey,
        target,
        at: "2026-08-14T12:00:01.000Z",
      });
      intent.store.freezeReady(intent.intentKey);

      const result = lifecycle.purge({
        idempotencyKey,
        target,
      });

      expect(result).toMatchObject({ status: "completed", deletedRows: 0 });
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM logical_pages WHERE id = 8101",
      ).pluck().get()).toBe(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 8101
          AND is_active = 1 AND id <> ?
      `).pluck().get(generationId)).toBe(1);
    } finally {
      database.close();
    }
  });
});
