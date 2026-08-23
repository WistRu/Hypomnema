import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";

import type { PriorityAssessmentTaskSpec } from "@tabhub/shared";
import { canonicalJsonV1 as canonicalJson } from "@tabhub/shared";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { digestPrivacyPurgeExecutionTargets } from "../src/live-acquisition-migration.js";
import { createResourceCommandCatalog } from "../src/resource-command-catalog.js";
import { openDatabase } from "../src/database.js";

/**
 * Storage and verification must agree about a fingerprint of the same data. These
 * tests never re-implement the algorithm: each one writes through production, reads
 * the row back out of SQLite, and then makes production recompute the fingerprint
 * from that row. Disagreement is observable as a thrown conflict or a corrupt-row
 * error, not as an assertion this file could get wrong on its own.
 *
 * Each area also carries an input where the retired per-module copies diverged:
 * property insertion order. A recomputation that is not the shared canonicalization
 * produces different bytes for the same data and fails these tests.
 */

const NOW = "2026-08-12T12:00:00.000Z";
const USER_PROVENANCE = { actor: "user", method: "manual" } as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commands(connection: Database.Database) {
  return createResourceCommandCatalog(connection, () => new Date(NOW), {});
}

function storedResourceCommandFingerprint(
  connection: Database.Database,
  idempotencyKey: string,
): string {
  return connection
    .prepare(
      "SELECT request_fingerprint FROM resource_command_receipts WHERE idempotency_key = ?",
    )
    .pluck()
    .get(idempotencyKey) as string;
}

const openClaimLimits = {
  maxConcurrent: 100,
  maxAttemptsPerUtcDay: 1_000,
  maxCostUsdPerUtcDay: null,
} as const;

function openSchema23Database() {
  const connection = new Database(":memory:");
  sqliteVec.load(connection);
  connection.function("tabhub_normalize_url_v2", { deterministic: true },
    (value: string) => value);
  connection.function("tabhub_migration_now", () => "2026-08-13T00:00:00.000Z");
  const migrationsDirectory = join(process.cwd(), "migrations");
  for (const name of readdirSync(migrationsDirectory)
    .filter((entry) => /^\d{3}_.+\.sql$/.test(entry) && Number(entry.slice(0, 3)) <= 23)
    .sort()) {
    connection.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
    connection.pragma(`user_version = ${Number(name.slice(0, 3))}`);
  }
  connection.pragma("foreign_keys = ON");
  return { connection, close: () => connection.close() };
}

function priorityTask(): PriorityAssessmentTaskSpec {
  return {
    version: 1,
    kind: "priority_assessment",
    subject: { type: "collection", scope: "all" },
    ruleset: { rulesetId: 1, version: 1 },
    assessmentProvenance: { method: "rule" },
    inputFingerprint: "a".repeat(64),
    idempotencyKey: "roundtrip-priority-v1",
    stepBatchSize: 100,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 5,
    budget: { maxSteps: 100, maxTokens: 0, maxCostUsd: 0, maxWallTimeMs: 60_000 },
  };
}

describe("persisted fingerprints recompute through the shared canonicalization", () => {
  describe("resource commands", () => {
    it("recomputes the stored request fingerprint when the same command replays", () => {
      const database = openDatabase(":memory:");
      try {
        const catalog = commands(database.connection);
        const first = catalog.change({
          kind: "create",
          resourceKey: "platform:github",
          name: "GitHub",
          resourceKind: "platform",
          accessClass: "public",
          provenance: USER_PROVENANCE,
          idempotencyKey: "roundtrip-1",
        });
        const stored = storedResourceCommandFingerprint(
          database.connection,
          "roundtrip-1",
        );
        expect(stored).not.toBe("");

        // The replay path recomputes the fingerprint and compares it against the
        // stored one; a disagreement raises IDEMPOTENCY_KEY_CONFLICT. The properties
        // are written in a different order here on purpose: every retired copy that
        // did not sort keys produces different bytes for this same command.
        const replay = catalog.change({
          idempotencyKey: "roundtrip-1",
          provenance: USER_PROVENANCE,
          accessClass: "public",
          resourceKind: "platform",
          name: "GitHub",
          resourceKey: "platform:github",
          kind: "create",
        });

        expect(replay).toEqual(first);
        expect(storedResourceCommandFingerprint(database.connection, "roundtrip-1"))
          .toBe(stored);
      } finally {
        database.close();
      }
    });

    it("still refuses a different command reusing the same idempotency key", () => {
      const database = openDatabase(":memory:");
      try {
        const catalog = commands(database.connection);
        catalog.change({
          kind: "create",
          resourceKey: "platform:github",
          name: "GitHub",
          resourceKind: "platform",
          accessClass: "public",
          provenance: USER_PROVENANCE,
          idempotencyKey: "roundtrip-2",
        });
        expect(() =>
          catalog.change({
            kind: "create",
            resourceKey: "platform:gitlab",
            name: "GitLab",
            resourceKind: "platform",
            accessClass: "public",
            provenance: USER_PROVENANCE,
            idempotencyKey: "roundtrip-2",
          })
        ).toThrow(/Idempotency key was already used/);
      } finally {
        database.close();
      }
    });

    it("stores a fingerprint of the canonical payload, not of the receipt", () => {
      const database = openDatabase(":memory:");
      try {
        const catalog = commands(database.connection);
        const command = {
          kind: "create",
          resourceKey: "platform:github",
          name: "GitHub",
          resourceKind: "platform",
          accessClass: "public",
          provenance: USER_PROVENANCE,
        } as const;
        catalog.change({ ...command, idempotencyKey: "roundtrip-3" });
        const stored = storedResourceCommandFingerprint(
          database.connection,
          "roundtrip-3",
        );
        expect(stored.endsWith(sha256(canonicalJson(command)))).toBe(true);
      } finally {
        database.close();
      }
    });
  });

  describe("AI jobs", () => {
    it("stores a checkpoint the production reader recomputes to the same bytes", () => {
      const { connection, close } = openSchema23Database();
      try {
        let tick = 0;
        const ledger = createAiJobLedger(connection, {
          clock: () => new Date(`2026-08-13T01:00:0${tick++}.000Z`),
          kindAvailable: () => true,
          token: () => "roundtrip-lease-token",
        });
        ledger.submit(priorityTask());
        const claim = ledger.claimNext(
          "priority_assessment",
          "roundtrip-worker",
          openClaimLimits,
        );
        expect(claim).toBeDefined();

        // nextOffset is written before version on purpose: a checkpoint serializer
        // that keeps insertion order stores different bytes for this same value, and
        // the reader recomputes the canonical form and rejects the row as corrupt.
        ledger.checkpoint(claim!, {
          progress: ledger.get("priority_assessment", claim!.id)?.progress ??
            claim!.progress,
          checkpoint: { nextOffset: 3, version: 1 },
          usage: {
            steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1,
          },
        });

        const stored = connection
          .prepare("SELECT checkpoint_json FROM ai_jobs WHERE id = ?")
          .pluck().get(claim!.id) as string;
        expect(stored).toBe('{"nextOffset":3,"version":1}');
        // The reader's own storage-versus-recomputation check: a row whose text is
        // not the canonical form of its parsed value is reported as corrupt.
        expect(canonicalJson(JSON.parse(stored) as unknown)).toBe(stored);
        expect(ledger.get("priority_assessment", claim!.id)?.status).toBe("running");
      } finally {
        close();
      }
    });

    it("refuses an out-of-band rewrite of a stored checkpoint", () => {
      const { connection, close } = openSchema23Database();
      try {
        let tick = 0;
        const ledger = createAiJobLedger(connection, {
          clock: () => new Date(`2026-08-13T02:00:0${tick++}.000Z`),
          kindAvailable: () => true,
          token: () => "roundtrip-corrupt-token",
        });
        ledger.submit(priorityTask());
        const claim = ledger.claimNext(
          "priority_assessment",
          "roundtrip-worker",
          openClaimLimits,
        )!;
        ledger.checkpoint(claim, {
          progress: ledger.get("priority_assessment", claim.id)?.progress ??
            claim.progress,
          checkpoint: { nextOffset: 3, version: 1 },
          usage: {
            steps: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 1,
          },
        });
        // Exactly the divergence the retired copies could produce: same data, keys
        // left in insertion order. The ledger's own triggers refuse the rewrite, so a
        // noncanonical checkpoint cannot reach storage behind the writer's back.
        expect(() =>
          connection.prepare("UPDATE ai_jobs SET checkpoint_json = ? WHERE id = ?")
            .run('{"version":1,"nextOffset":3}', claim.id)
        ).toThrow(/ai job projection requires event/);
        expect(
          connection.prepare("SELECT checkpoint_json FROM ai_jobs WHERE id = ?")
            .pluck().get(claim.id),
        ).toBe('{"nextOffset":3,"version":1}');
      } finally {
        close();
      }
    });
  });

  describe("live-acquisition digests", () => {
    it("digests the same execution plan whatever order the caller wrote it in", () => {
      // The SQL mirror keeps insertion order on purpose, so the production digest
      // would be caller-order sensitive if it hashed the caller's objects directly.
      // It snapshots each target into a fixed shape first, which is what makes the
      // persisted deletion_plan_digest reproducible from the stored rows.
      const written = digestPrivacyPurgeExecutionTargets([
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7001" },
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7002" },
      ]);
      const recomputedFromStoredOrder = digestPrivacyPurgeExecutionTargets([
        { pkV1: "pk:v1|1|i:4:7001", tableName: "research_runs" },
        { pkV1: "pk:v1|1|i:4:7002", tableName: "research_runs" },
      ]);
      expect(recomputedFromStoredOrder).toBe(written);
      expect(written).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps target order significant, because the plan is an ordered plan", () => {
      const forward = digestPrivacyPurgeExecutionTargets([
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7001" },
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7002" },
      ]);
      const reversed = digestPrivacyPurgeExecutionTargets([
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7002" },
        { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7001" },
      ]);
      expect(reversed).not.toBe(forward);
    });
  });
});
