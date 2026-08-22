import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createPrivacyLifecycle } from "../src/privacy-lifecycle.js";
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
  PrivacyPurgeIntentStoreError,
} from "../src/privacy-purge-intent-capabilities.js";
import {
  liveResearchFixtureCompletedAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

const T1 = "2026-08-21T12:00:01.000Z";
const T2 = "2026-08-21T12:00:02.000Z";
const T3 = "2026-08-21T12:00:03.000Z";

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

function fixture() {
  const database = openDatabase(":memory:", {
    maximumMigrationVersion: 25,
    migrationClock: () => new Date(T1),
  });
  const live = seedReceiptBackedLiveResearchRun(database.connection);
  database.connection.prepare(`
    INSERT INTO ai_job_events (
      job_id, sequence_no, event_type, from_status, to_status, occurred_at
    ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
  `).run(live.finalJobId, liveResearchFixtureCompletedAt);
  installSchema26(database.connection);
  const subjectGenerationId = Number(database.connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'research_run' AND research_run_id = ?
      AND is_active = 1
  `).pluck().get(live.coordinatorJobId));
  const idempotencyKey = "trusted-clock-run-7001";
  const intentKey = sha256("trusted-clock-intent-7001");
  const target = { kind: "run" as const, subjectGenerationId };
  const idempotencyKeyHash = sha256(
    `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
  );
  const requestFingerprint = sha256(
    `tabhub:privacy-purge:request:v1\0run:${subjectGenerationId}`,
  );
  return {
    database,
    sourceId: live.sourceId,
    intentKey,
    idempotencyKey,
    target,
    publication: { intentKey, idempotencyKeyHash, requestFingerprint, target },
    identity: {
      idempotencyKeyHash,
      requestFingerprint,
      targetKind: "run" as const,
      subjectGenerationId,
      historyEpochId: null,
    },
  };
}

function sequenceClock(values: readonly (string | "invalid")[]): {
  readonly clock: () => Date;
  readonly calls: () => number;
} {
  let index = 0;
  return {
    clock: () => {
      const value = values[index++];
      return value === "invalid" ? new Date(Number.NaN) : new Date(value!);
    },
    calls: () => index,
  };
}

describe("schema026 trusted privacy-purge intent store", () => {
  it("owns one clock sample per transition and allows equal timestamps", () => {
    const { database, intentKey, publication, identity } = fixture();
    try {
      const sampled = sequenceClock([T2, T2, T2, T2]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      expect(store.publishWaiting(publication).status)
        .toBe("waiting");
      expect(store.freezeReady(intentKey).status).toBe("ready");
      const commandId = store.linkReadyCommand(identity);
      store.executeCommitted(commandId);

      expect(sampled.calls()).toBe(4);
      expect(database.connection.prepare(`
        SELECT status, created_at, updated_at
        FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({
        status: "completed",
        created_at: T2,
        updated_at: T2,
      });
      expect(database.connection.prepare(`
        SELECT created_at FROM privacy_purge_commands WHERE id = ?
      `).pluck().get(commandId)).toBe(T2);
      expect(database.connection.prepare(`
        SELECT completed_at FROM privacy_purge_results WHERE command_id = ?
      `).pluck().get(commandId)).toBe(T2);
    } finally {
      database.close();
    }
  });

  it("rejects freeze clock regression before any freeze writes", () => {
    const { database, intentKey, publication } = fixture();
    try {
      const sampled = sequenceClock([T2, T1]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      store.publishWaiting(publication);
      let regression: unknown;
      try {
        store.freezeReady(intentKey);
      } catch (error) {
        regression = error;
      }
      expect(regression).toBeInstanceOf(PrivacyPurgeIntentStoreError);
      expect(regression).toMatchObject({ code: "PURGE_CLOCK_REGRESSION" });
      expect(sampled.calls()).toBe(2);
      expect(database.connection.prepare(`
        SELECT status, updated_at FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({ status: "waiting", updated_at: T2 });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_execution_targets
        WHERE intent_key = ?
      `).pluck().get(intentKey)).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ?
      `).pluck().get(intentKey)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects link clock regression before command publication", () => {
    const { database, intentKey, publication, identity } = fixture();
    try {
      const sampled = sequenceClock([T1, T2, T1]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      store.publishWaiting(publication);
      store.freezeReady(intentKey);
      expect(() => store.linkReadyCommand(identity)).toThrow("PURGE_CLOCK_REGRESSION");
      expect(sampled.calls()).toBe(3);
      expect(database.connection.prepare(`
        SELECT status, updated_at FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({ status: "ready", updated_at: T2 });
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_commands",
      ).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects execute clock regression before terminal writes", () => {
    const { database, sourceId, intentKey, publication, identity } = fixture();
    try {
      const sampled = sequenceClock([T1, T2, T3, T2]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      store.publishWaiting(publication);
      store.freezeReady(intentKey);
      const commandId = store.linkReadyCommand(identity);
      expect(() => store.executeCommitted(commandId)).toThrow(
        "PURGE_CLOCK_REGRESSION",
      );
      expect(sampled.calls()).toBe(4);
      expect(database.connection.prepare(`
        SELECT status, updated_at FROM privacy_purge_intents WHERE intent_key = ?
      `).get(intentKey)).toEqual({ status: "committed", updated_at: T3 });
      expect(database.connection.prepare(`
        SELECT status FROM privacy_purge_commands WHERE id = ?
      `).pluck().get(commandId)).toBe("pending");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_results WHERE command_id = ?
      `).pluck().get(commandId)).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_receipts WHERE intent_key = ?
      `).pluck().get(intentKey)).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_sources WHERE id = ?
      `).pluck().get(sourceId)).toBe(1);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_budget_carryover_days
        WHERE intent_key = ? AND state <> 'frozen'
      `).pluck().get(intentKey)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects an invalid trusted clock before publication writes", () => {
    const { database, publication } = fixture();
    try {
      const sampled = sequenceClock(["invalid"]);
      const store = createPrivacyPurgeIntentStore(database.connection, {
        clock: sampled.clock,
      });
      expect(() => store.publishWaiting(publication))
        .toThrow("PURGE_CLOCK_INVALID");
      expect(sampled.calls()).toBe(1);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM privacy_purge_intents",
      ).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps createPrivacyLifecycle compatible and replay does not sample", () => {
    const { database, intentKey, idempotencyKey, target, publication } = fixture();
    try {
      const setup = createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date(T2),
      });
      setup.publishWaiting(publication);
      setup.freezeReady(intentKey);

      const sampled = sequenceClock([T2, T2]);
      const lifecycle = createPrivacyLifecycle(database.connection, {
        clock: sampled.clock,
      });
      const result = lifecycle.purge({ idempotencyKey, target });
      expect(sampled.calls()).toBe(2);
      expect(lifecycle.purge({ idempotencyKey, target })).toEqual(result);
      expect(sampled.calls()).toBe(2);
    } finally {
      database.close();
    }
  });
});

describe("schema026 privacy-purge lifecycle successors", () => {
  it("completes an empty logical-page purge through one exact successor insertion", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(T1),
    });
    try {
      const { connection } = database;
      connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url,
          created_at, updated_at
        ) VALUES (
          26101, 'https://successor.example/empty',
          'https://successor.example/empty',
          'https://successor.example/empty', '${T1}', '${T1}'
        )
      `);
      const oldGeneration = connection.prepare(`
        SELECT id, generation_token FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 26101
          AND is_active = 1
      `).get() as { id: number; generation_token: string };
      installSchema26(connection);

      const idempotencyKey = "schema26-empty-logical-page-successor";
      const intentKey = sha256("schema26-empty-logical-page-successor-intent");
      const target = {
        kind: "logical_page" as const,
        subjectGenerationId: oldGeneration.id,
      };
      const store = createPrivacyPurgeIntentStore(connection, {
        clock: () => new Date(T2),
      });
      store.publishWaiting({
        intentKey,
        idempotencyKeyHash: sha256(
          `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
        ),
        requestFingerprint: sha256(
          `tabhub:privacy-purge:request:v1\0logical_page:${oldGeneration.id}`,
        ),
        target,
      });
      store.freezeReady(intentKey);
      store.linkReadyCommand({
        idempotencyKeyHash: sha256(
          `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
        ),
        requestFingerprint: sha256(
          `tabhub:privacy-purge:request:v1\0logical_page:${oldGeneration.id}`,
        ),
        targetKind: "logical_page",
        subjectGenerationId: oldGeneration.id,
        historyEpochId: null,
      });

      expect(() => connection.prepare(`
        INSERT INTO privacy_subject_generations (
          subject_kind, logical_page_id, generation_token,
          is_active, created_at
        ) VALUES ('logical_page', 26101, ?, 1, ?)
      `).run("e".repeat(64), T3))
        .toThrow(/schema26 privacy purge root fence/);

      const lifecycle = createPrivacyLifecycle(connection, {
        clock: () => new Date(T3),
      });
      connection.exec(`
        CREATE TEMP TRIGGER inject_second_logical_page_successor
        AFTER INSERT ON privacy_subject_generations
        WHEN NEW.subject_kind = 'logical_page'
          AND NEW.logical_page_id = 26101 AND NEW.is_active = 1
        BEGIN
          INSERT INTO privacy_subject_generations (
            subject_kind, logical_page_id, generation_token,
            is_active, created_at, retired_at
          ) VALUES (
            'logical_page', 26101,
            '${"d".repeat(64)}', 0, '${T3}', '${T3}'
          );
        END;
      `);
      expect(() => lifecycle.purge({ idempotencyKey, target }))
        .toThrow(/schema26 privacy purge root fence/);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 26101
      `).pluck().get()).toBe(1);
      expect(connection.prepare(`
        SELECT is_active, retired_at FROM privacy_subject_generations WHERE id = ?
      `).get(oldGeneration.id)).toEqual({ is_active: 1, retired_at: null });
      connection.exec("DROP TRIGGER inject_second_logical_page_successor");

      expect(lifecycle.purge({ idempotencyKey, target })).toMatchObject({
        status: "completed",
        deletedRows: 0,
      });
      const successors = connection.prepare(`
        SELECT id, generation_token, created_at
        FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 26101
          AND is_active = 1
      `).all() as Array<{
        id: number;
        generation_token: string;
        created_at: string;
      }>;
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ created_at: T3 });
      expect(successors[0]!.id).not.toBe(oldGeneration.id);
      expect(successors[0]!.generation_token).toMatch(/^[0-9a-f]{64}$/);
      expect(successors[0]!.generation_token).not.toBe(oldGeneration.generation_token);
      expect(connection.prepare(`
        SELECT is_active, retired_at FROM privacy_subject_generations WHERE id = ?
      `).get(oldGeneration.id)).toEqual({ is_active: 0, retired_at: T3 });

      expect(lifecycle.purge({ idempotencyKey, target })).toMatchObject({
        status: "completed",
      });
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_subject_generations
        WHERE subject_kind = 'logical_page' AND logical_page_id = 26101
          AND is_active = 1
      `).pluck().get()).toBe(1);
      expect(() => connection.prepare(`
        INSERT INTO privacy_subject_generations (
          subject_kind, logical_page_id, generation_token,
          is_active, created_at
        ) VALUES ('logical_page', 26101, ?, 1, ?)
      `).run("f".repeat(64), T3)).toThrow();
    } finally {
      database.close();
    }
  });

  it("purges exact direct-history run members and creates one history successor", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 25,
      migrationClock: () => new Date(T1),
    });
    try {
      const { connection } = database;
      const live = seedReceiptBackedLiveResearchRun(connection);
      connection.prepare(`
        INSERT INTO ai_job_events (
          job_id, sequence_no, event_type, from_status, to_status, occurred_at
        ) VALUES (?, 2, 'superseded', 'queued', 'superseded', ?)
      `).run(live.finalJobId, liveResearchFixtureCompletedAt);
      const history = connection.prepare(`
        SELECT id, resource_id, resource_generation_id, epoch_no
        FROM research_history_epochs
        WHERE resource_id = 7001 AND is_active = 1
      `).get() as {
        id: number;
        resource_id: number;
        resource_generation_id: number;
        epoch_no: number;
      };
      const oldRunGenerations = connection.prepare(`
        SELECT generation.id
        FROM research_runs AS run
        JOIN privacy_subject_generations AS generation
          ON generation.subject_kind = 'research_run'
          AND generation.research_run_id = run.id
          AND generation.is_active = 1
        WHERE run.history_epoch_id = ? ORDER BY generation.id
      `).pluck().all(history.id) as number[];
      expect(oldRunGenerations.length).toBeGreaterThan(0);
      installSchema26(connection);

      const idempotencyKey = "schema26-resource-history-successor";
      const intentKey = sha256("schema26-resource-history-successor-intent");
      const target = { kind: "resource_history" as const, historyEpochId: history.id };
      const store = createPrivacyPurgeIntentStore(connection, {
        clock: () => new Date(T2),
      });
      const published = store.publishWaiting({
        intentKey,
        idempotencyKeyHash: sha256(
          `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`,
        ),
        requestFingerprint: sha256(
          `tabhub:privacy-purge:request:v1\0resource_history:${history.id}`,
        ),
        target,
      });
      expect(published.runTargetCount).toBe(oldRunGenerations.length);
      expect(connection.prepare(`
        SELECT COUNT(*) FROM privacy_purge_intent_run_targets
        WHERE intent_key = ? AND is_root = 0
          AND membership_kind = 'direct_history'
          AND handoff_id IS NULL AND handoff_status IS NULL
          AND handoff_receipt_digest IS NULL
          AND handoff_receipt_completed_at IS NULL
      `).pluck().get(intentKey)).toBe(oldRunGenerations.length);
      store.freezeReady(intentKey);

      expect(createPrivacyLifecycle(connection, {
        clock: () => new Date(T3),
      }).purge({ idempotencyKey, target })).toMatchObject({ status: "completed" });
      expect(connection.prepare(`
        SELECT is_active, retired_at FROM research_history_epochs WHERE id = ?
      `).get(history.id)).toEqual({ is_active: 0, retired_at: T3 });
      expect(connection.prepare(`
        SELECT resource_id, resource_generation_id, epoch_no, created_at
        FROM research_history_epochs
        WHERE resource_id = ? AND is_active = 1
      `).all(history.resource_id)).toEqual([{
        resource_id: history.resource_id,
        resource_generation_id: history.resource_generation_id,
        epoch_no: history.epoch_no + 1,
        created_at: T3,
      }]);
      for (const generationId of oldRunGenerations) {
        expect(connection.prepare(`
          SELECT is_active, research_run_id, retired_at
          FROM privacy_subject_generations WHERE id = ?
        `).get(generationId)).toEqual({
          is_active: 0,
          research_run_id: null,
          retired_at: T3,
        });
      }
      expect(connection.prepare(`
        SELECT intent.status, receipt.outcome
        FROM privacy_purge_intents AS intent
        JOIN privacy_purge_intent_receipts AS receipt
          ON receipt.intent_key = intent.intent_key
        WHERE intent.intent_key = ?
      `).get(intentKey)).toEqual({ status: "completed", outcome: "completed" });
    } finally {
      database.close();
    }
  });
});
