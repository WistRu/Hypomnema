import { createHash } from "node:crypto";

import { privacyPurgeStatusResponseSchema } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createPrivacyPurgeIntentStore } from "../src/privacy-purge-intent-capabilities.js";
import { createPrivacyPurgeStatusReader } from "../src/privacy-purge-status-reader.js";

const AT = "2026-08-21T12:00:00.000Z";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const database = openDatabase(":memory:", { migrationClock: () => new Date(AT) });
  const { connection } = database;
  connection.prepare(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (91001, 'https://private.example/secret',
      'https://private.example/secret', 'https://private.example/secret', ?, ?)
  `).run(AT, AT);
  const subjectGenerationId = Number(connection.prepare(`
    SELECT id FROM privacy_subject_generations
    WHERE subject_kind = 'logical_page' AND logical_page_id = 91001 AND is_active = 1
  `).pluck().get());
  const intentKey = sha256("status-reader-intent");
  const identity = {
    idempotencyKeyHash: sha256("status-reader-idempotency"),
    requestFingerprint: sha256("status-reader-request"),
    targetKind: "logical_page" as const,
    subjectGenerationId,
    historyEpochId: null,
  };
  const store = createPrivacyPurgeIntentStore(connection, { clock: () => new Date(AT) });
  store.publishWaiting({ intentKey,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestFingerprint: identity.requestFingerprint,
    target: { kind: "logical_page", subjectGenerationId },
  });
  return { database, connection, store, intentKey, identity,
    purgeId: `purge_${intentKey}` };
}

function withoutTriggers(
  connection: ReturnType<typeof openDatabase>["connection"],
  tableName: string,
  body: () => void,
): void {
  const triggers = connection.prepare(`
    SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?
  `).all(tableName) as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) connection.exec(`DROP TRIGGER "${trigger.name}"`);
  try { body(); } finally {
    for (const trigger of triggers) connection.exec(trigger.sql);
  }
}

describe("privacy purge status reader", () => {
  it("returns a strict redacted waiting snapshot without writes", () => {
    const value = fixture();
    try {
      const before = Number(value.connection.prepare("SELECT total_changes()").pluck().get());
      const status = createPrivacyPurgeStatusReader(value.connection).read(value.purgeId);
      expect(Number(value.connection.prepare("SELECT total_changes()").pluck().get())).toBe(before);
      expect(status).toEqual({
        version: 1, purgeId: value.purgeId,
        target: { kind: "logical_page", logicalPageId: 91001 },
        state: "waiting", progress: { completedSteps: 0, totalSteps: 2 },
        holdReason: null, canRetry: false,
        timestamps: { createdAt: AT, updatedAt: AT, completedAt: null },
        result: null,
      });
      expect(privacyPurgeStatusResponseSchema.safeParse(status).success).toBe(true);
      const serialized = JSON.stringify(status);
      for (const secret of ["private.example", "secret", "actionId", "jobId",
        "provider", "model", "requestId", "leaseToken", "fingerprint",
        "digest", "tableName", "internalError"]) {
        expect(serialized).not.toContain(secret);
      }
      expect(createPrivacyPurgeStatusReader(value.connection)
        .read(`purge_${"f".repeat(64)}`)).toBeNull();
      expect(createPrivacyPurgeStatusReader(value.connection).read("bad")).toBeNull();
    } finally { value.database.close(); }
  });

  it("returns only deletedRows for a terminal committed execution", () => {
    const value = fixture();
    try {
      value.store.freezeReady(value.intentKey);
      const commandId = value.store.linkReadyCommand(value.identity);
      value.store.executeCommitted(commandId);
      const status = createPrivacyPurgeStatusReader(value.connection).read(value.purgeId)!;
      expect(status.state).toBe("completed");
      expect(status.progress.completedSteps).toBe(status.progress.totalSteps);
      expect(status.timestamps.completedAt).toBe(AT);
      expect(status.result).toEqual({ deletedRows: expect.any(Number) });
      expect(Object.keys(status.result!)).toEqual(["deletedRows"]);
    } finally { value.database.close(); }
  });

  it("covers ready and committed projections", () => {
    for (const state of ["ready", "committed"] as const) {
      const value = fixture();
      try {
        value.store.freezeReady(value.intentKey);
        if (state === "committed") value.store.linkReadyCommand(value.identity);
        const status = createPrivacyPurgeStatusReader(value.connection).read(value.purgeId)!;
        expect(status.state).toBe(state);
        expect(status.progress).toEqual({ completedSteps: 1, totalSteps: 2 });
        expect(status.canRetry).toBe(false);
      } finally { value.database.close(); }
    }

  });

  it("covers the failed-hold projection", () => {
    const held = fixture();
    try {
      withoutTriggers(held.connection, "privacy_purge_intents", () => {
        held.connection.prepare(`
          UPDATE privacy_purge_intents
          SET status = 'failed_hold', hold_code = 'PROVIDER_USAGE_UNKNOWN'
          WHERE intent_key = ?
        `).run(held.intentKey);
      });
      expect(createPrivacyPurgeStatusReader(held.connection).read(held.purgeId))
        .toMatchObject({ state: "failed_hold",
          holdReason: "awaiting_provider_settlement", canRetry: true });
    } finally { held.database.close(); }

  });

  it.each([
    ["WAIT_SNAPSHOT_DRIFT", "manual_review", false],
    ["PURGE_INVARIANT_VIOLATION", "manual_review", false],
    ["PROVIDER_USAGE_UNKNOWN", "awaiting_provider_settlement", true],
  ] as const)("derives retry only for the repairable %s hold", (holdCode,
    holdReason, canRetry) => {
    const value = fixture();
    try {
      withoutTriggers(value.connection, "privacy_purge_intents", () => {
        value.connection.prepare(`
          UPDATE privacy_purge_intents SET status = 'failed_hold', hold_code = ?
          WHERE intent_key = ?
        `).run(holdCode, value.intentKey);
      });
      expect(createPrivacyPurgeStatusReader(value.connection).read(value.purgeId))
        .toMatchObject({ state: "failed_hold", holdReason, canRetry });
    } finally { value.database.close(); }
  });

  it("covers the legacy failed projection", () => {
    const failed = fixture();
    try {
      failed.store.freezeReady(failed.intentKey);
      const commandId = failed.store.linkReadyCommand(failed.identity);
      failed.store.executeCommitted(commandId);
      withoutTriggers(failed.connection, "privacy_purge_results", () => {
        failed.connection.prepare(`
          UPDATE privacy_purge_results SET outcome = 'failed' WHERE command_id = ?
        `).run(commandId);
      });
      withoutTriggers(failed.connection, "privacy_purge_commands", () => {
        failed.connection.prepare(`
          UPDATE privacy_purge_commands SET status = 'failed' WHERE id = ?
        `).run(commandId);
      });
      withoutTriggers(failed.connection, "privacy_purge_intents", () => {
        failed.connection.prepare(`
          UPDATE privacy_purge_intents SET origin = 'legacy25', status = 'failed',
            logical_page_id_snapshot = NULL, root_generation_token = NULL
          WHERE intent_key = ?
        `).run(failed.intentKey);
      });
      expect(createPrivacyPurgeStatusReader(failed.connection).read(failed.purgeId))
        .toMatchObject({ state: "failed", canRetry: false,
          result: { deletedRows: expect.any(Number) } });
    } finally { failed.database.close(); }
  });

  it("fails closed on an inconsistent durable snapshot", () => {
    const value = fixture();
    try {
      value.connection.exec("DROP TRIGGER privacy_purge_intents_update_guard");
      value.connection.prepare(`
        UPDATE privacy_purge_intents SET action_wait_count = 1 WHERE intent_key = ?
      `).run(value.intentKey);
      expect(() => createPrivacyPurgeStatusReader(value.connection).read(value.purgeId))
        .toThrow("Privacy purge status unavailable");
    } finally { value.database.close(); }
  });
});
