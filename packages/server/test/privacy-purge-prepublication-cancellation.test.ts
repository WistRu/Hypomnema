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
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const PUBLISHED_AT = "2026-08-21T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installSchema26(
  connection: ReturnType<typeof openDatabase>["connection"],
): void {
  connection.pragma("recursive_triggers = ON");
  installPrivacyPurgeIntentCapabilities(connection);
  connection.exec(readFileSync(
    new URL("../migrations/026_privacy_purge_intents.sql", import.meta.url),
    "utf8",
  ));
  for (const sql of buildPrivacyPurgeExpectedViews(connection)) connection.exec(sql);
  for (const fence of buildPrivacyPurgeMutationFences(connection)) {
    connection.exec(fence.sql);
  }
  for (const sql of buildPrivacyPurgeRootGuards()) connection.exec(sql);
  for (const sql of buildPrivacyPurgeDerivedSourceGuards(connection)) {
    connection.exec(sql);
  }
  connection.pragma("user_version = 26");
  adoptLegacy25PrivacyPurgeTerminals(connection);
}

function fixture(running: boolean) {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(PUBLISHED_AT),
  });
  const live = seedReceiptBackedLiveResearchRun(database.connection);
  if (running) {
    database.connection.prepare(`
      INSERT INTO ai_job_attempts (
        job_id, attempt_no, lease_token, worker_id, started_at, outcome
      ) VALUES (?, 1, 'prepublish-unbound-token', 'prepublish-worker', ?, 'running')
    `).run(live.finalJobId, "2026-08-14T12:00:02.000Z");
  }
  installSchema26(database.connection);
  const subjectGenerationId = Number(database.connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ? AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const intentKey = sha256(`prepublish-intent-${running}`);
  return {
    database,
    finalJobId: live.finalJobId,
    intentKey,
    publication: {
      intentKey,
      idempotencyKeyHash: sha256(`prepublish-key-${running}`),
      requestFingerprint: sha256(`prepublish-request-${running}`),
      target: { kind: "run" as const, subjectGenerationId },
    },
  };
}

describe("schema026 pre-publication cancellation", () => {
  it("atomically cancels queued owned work and excludes it from wait snapshots", () => {
    const { database, finalJobId, publication } = fixture(false);
    try {
      const published = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(PUBLISHED_AT),
      }).publishWaiting(publication);

      expect(published.jobWaitCount).toBe(0);
      expect(database.connection.prepare(`
        SELECT status, cancellation_requested_by, cancellation_requested_at
        FROM ai_jobs WHERE id = ?
      `).get(finalJobId)).toEqual({
        status: "cancelled",
        cancellation_requested_by: "user",
        cancellation_requested_at: PUBLISHED_AT,
      });
      expect(database.connection.prepare(`
        SELECT event_type, from_status, to_status, cancellation_requested_by,
          occurred_at
        FROM ai_job_events WHERE job_id = ? ORDER BY sequence_no DESC LIMIT 1
      `).get(finalJobId)).toEqual({
        event_type: "cancelled",
        from_status: "queued",
        to_status: "cancelled",
        cancellation_requested_by: "user",
        occurred_at: PUBLISHED_AT,
      });
    } finally {
      database.close();
    }
  });

  it("requests running-unbound cancellation and binds it into the wait snapshot", () => {
    const { database, finalJobId, intentKey, publication } = fixture(true);
    try {
      const published = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(PUBLISHED_AT),
      }).publishWaiting(publication);

      expect(published.jobWaitCount).toBe(1);
      const wait = database.connection.prepare(`
        SELECT status, event_sequence, request_bound, cancellation_requested_by,
          cancellation_requested_at, cancellation_snapshot_digest
        FROM privacy_purge_intent_job_waits
        WHERE intent_key = ? AND job_id = ?
      `).get(intentKey, finalJobId) as Record<string, unknown>;
      expect(wait).toMatchObject({
        status: "running",
        event_sequence: 3,
        request_bound: 0,
        cancellation_requested_by: "user",
        cancellation_requested_at: PUBLISHED_AT,
      });
      expect(wait.cancellation_snapshot_digest).toBe(sha256(JSON.stringify({
        intentKey,
        jobId: finalJobId,
        eventSequence: 3,
        cancellationRequestedBy: "user",
        cancellationRequestedAt: PUBLISHED_AT,
      })));
    } finally {
      database.close();
    }
  });

  for (const running of [false, true]) {
    it(`rolls back ${running ? "running" : "queued"} cancellation when publication fails`, () => {
      const { database, finalJobId, publication } = fixture(running);
      try {
        const before = database.connection.prepare(`
          SELECT status, event_sequence, cancellation_requested_by,
            cancellation_requested_at
          FROM ai_jobs WHERE id = ?
        `).get(finalJobId);
        const eventCount = Number(database.connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
        `).pluck().get(finalJobId));
        database.connection.exec(`
          CREATE TEMP TRIGGER fail_prepublication_after_intent
          AFTER INSERT ON privacy_purge_intents
          BEGIN
            SELECT RAISE(ABORT, 'fixture publication failure');
          END;
        `);

        expect(() => createPrivacyPurgeIntentStore(database.connection, {
          clock: () => new Date(PUBLISHED_AT),
        }).publishWaiting(publication)).toThrow("fixture publication failure");
        expect(database.connection.prepare(`
          SELECT status, event_sequence, cancellation_requested_by,
            cancellation_requested_at
          FROM ai_jobs WHERE id = ?
        `).get(finalJobId)).toEqual(before);
        expect(Number(database.connection.prepare(`
          SELECT COUNT(*) FROM ai_job_events WHERE job_id = ?
        `).pluck().get(finalJobId))).toBe(eventCount);
        expect(database.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intents
        `).pluck().get()).toBe(0);
        expect(database.connection.prepare(`
          SELECT COUNT(*) FROM privacy_purge_intent_job_waits
        `).pluck().get()).toBe(0);
      } finally {
        database.close();
      }
    });
  }
});
