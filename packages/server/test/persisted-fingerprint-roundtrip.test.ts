import { describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import { canonicalJsonV1 as canonicalJson } from "@tabhub/shared";

import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { createPriorityAssessmentCoordinator } from
  "../src/priority-assessment-coordinator.js";
import { digestPrivacyPurgeExecutionTargets } from "../src/live-acquisition-migration.js";
import { createResearchCorpusReader } from "../src/research-corpus.js";
import { createResourceCatalog } from "../src/resource-catalog.js";
import {
  createResourceCommandCatalog,
  ResourceCommandCatalogError,
} from "../src/resource-command-catalog.js";
import { openDatabase } from "../src/database.js";
import { seedReceiptBackedLiveResearchRun } from "./live-research-fixture.js";

const NOW = "2026-08-13T12:00:00.000Z";

/**
 * Every `*_json` column is written by production through the shared canonicalization.
 * Re-canonicalizing the parsed value has to reproduce the stored text byte for byte;
 * if a module kept its own serializer, this is where storage and verification start
 * disagreeing.
 */
function expectEveryStoredJsonColumnIsCanonical(
  connection: Database.Database,
  table: string,
): number {
  const columns = (connection.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[]).map((column) => column.name).filter((name) => name.endsWith("_json"));
  expect(columns, `${table} must have a JSON column to check`).not.toEqual([]);
  let checked = 0;
  for (const column of columns) {
    const rows = connection
      .prepare(`SELECT ${column} AS stored FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as { stored: string }[];
    for (const row of rows) {
      expect(canonicalJson(JSON.parse(row.stored) as unknown), `${table}.${column}`)
        .toBe(row.stored);
      checked += 1;
    }
  }
  return checked;
}

/**
 * The bytes a module carrying an unsorted-key copy of the algorithm would have
 * written: the same data, keys in the opposite order.
 */
function reversedKeyRewrite(stored: string): string {
  const parsed = JSON.parse(stored) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  expect(keys.length, "the value needs at least two keys to reorder").toBeGreaterThan(1);
  const reversed: Record<string, unknown> = {};
  for (const key of [...keys].reverse()) reversed[key] = parsed[key];
  return JSON.stringify(reversed);
}

function priorityFixture() {
  const database = openDatabase(":memory:", {
    migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
  });
  database.connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (501, 'https://roundtrip.test/', 'https://roundtrip.test/',
      'https://roundtrip.test/', '2026-07-01T00:00:00.000Z', '${NOW}');
    INSERT INTO tabs (
      id, url, url_normalized, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (601, 'https://roundtrip.test/', 'https://roundtrip.test/',
      'chrome', 'inbox', 0, 1, '2026-07-01T00:00:00.000Z', '${NOW}', 501);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, candidate_resource_ids_json,
      source_fingerprint, research_eligible, research_exclusion_reason, created_at
    ) VALUES (701, 501, 'unmatched', 'weak_sensitive_signal', '[]',
      'resolution', 0, 'weak_sensitive_signal', '${NOW}');
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (501, 701);
  `);
  let token = 0;
  const coordinator = createPriorityAssessmentCoordinator({
    connection: database.connection,
    clock: () => new Date(NOW),
    createLedger: (guards) => createAiJobLedger(database.connection, {
      clock: () => new Date(NOW),
      kindAvailable: (kind) => kind === "priority_assessment",
      token: () => `roundtrip-lease-${String(++token).padStart(4, "0")}`,
      guards,
    }),
    writerEnabled: true,
  });
  return { database, coordinator };
}

describe("persisted fingerprints round-trip through the shared helper", () => {
  it("keeps a priority assessment readable by recomputing its stored fingerprint", () => {
    const { database, coordinator } = priorityFixture();
    try {
      const input = {
        subject: { type: "page" as const, logicalPageId: 501 },
        provenance: { requestedBy: "user" as const, requestMethod: "manual" as const },
        idempotencyKey: "roundtrip-assessment",
      };
      const submitted = coordinator.submit(input);
      expect(coordinator.process("roundtrip-worker")).toMatchObject({
        status: "succeeded",
      });

      // Production recomputes the input fingerprint on replay and returns the original
      // job only when it matches what it stored.
      expect(coordinator.submit(input)).toMatchObject({ id: submitted.id });

      // The same subject under a different idempotency key is a different request, so
      // the stored fingerprint cannot be a constant.
      const other = coordinator.submit({ ...input, idempotencyKey: "roundtrip-other" });
      expect(other.id).not.toBe(submitted.id);

      const storedFingerprints = database.connection.prepare(`
        SELECT input_fingerprint FROM ai_jobs WHERE input_fingerprint IS NOT NULL
      `).pluck().all() as string[];
      expect(storedFingerprints.length).toBeGreaterThan(0);
      for (const fingerprint of storedFingerprints) {
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }

      expect(expectEveryStoredJsonColumnIsCanonical(database.connection, "ai_jobs"))
        .toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("rejects an AI job checkpoint rewritten by an unsorted-key serializer", () => {
    const { database, coordinator } = priorityFixture();
    try {
      coordinator.submit({
        subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "roundtrip-checkpoint",
      });
      coordinator.process("roundtrip-worker");

      const stored = database.connection.prepare(`
        SELECT id, checkpoint_json AS stored FROM ai_jobs
        WHERE checkpoint_json IS NOT NULL LIMIT 1
      `).get() as { id: number; stored: string } | undefined;
      expect(stored, "the run must persist at least one checkpoint").toBeDefined();
      if (stored === undefined) return;

      expect(canonicalJson(JSON.parse(stored.stored) as unknown)).toBe(stored.stored);
      const rewritten = reversedKeyRewrite(stored.stored);
      expect(rewritten).not.toBe(stored.stored);

      // The stored form is enforced in SQL as well as in the reader, so the rewrite
      // cannot even reach the row.
      expect(() => database.connection
        .prepare("UPDATE ai_jobs SET checkpoint_json = ? WHERE id = ?")
        .run(rewritten, stored.id)).toThrow(/checkpoint/i);
    } finally {
      database.close();
    }
  });

  it("replays a resource command only when its stored fingerprint recomputes", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
    });
    try {
      createResourceCatalog(database.connection, () => new Date(NOW));
      const commands = createResourceCommandCatalog(
        database.connection, () => new Date(NOW), {},
      );
      const create = {
        kind: "create" as const,
        resourceKey: "domain:roundtrip.test",
        name: "roundtrip.test",
        resourceKind: "platform" as const,
        accessClass: "public" as const,
        provenance: { actor: "user" as const, method: "manual" as const },
        idempotencyKey: "roundtrip-create",
      };
      const first = commands.change(create);

      // Same payload, keys supplied in a different order: canonicalization means the
      // recomputed fingerprint still matches the stored one, so this is a replay.
      const reordered = {
        idempotencyKey: create.idempotencyKey,
        provenance: create.provenance,
        accessClass: create.accessClass,
        resourceKind: create.resourceKind,
        name: create.name,
        resourceKey: create.resourceKey,
        kind: create.kind,
      };
      expect(commands.change(reordered)).toEqual(first);

      // A genuinely different payload under the same key must not replay.
      expect(() => commands.change({ ...create, name: "different name" }))
        .toThrow(ResourceCommandCatalogError);

      const storedFingerprints = database.connection.prepare(`
        SELECT request_fingerprint AS fingerprint FROM resource_command_receipts
      `).all() as { fingerprint: string }[];
      expect(storedFingerprints).toHaveLength(1);
      expect(storedFingerprints[0]?.fingerprint).toMatch(/;sha256=[0-9a-f]{64}$/);

      expect(expectEveryStoredJsonColumnIsCanonical(
        database.connection, "resource_command_receipts",
      )).toBe(1);
    } finally {
      database.close();
    }
  });

  it("detects a live-acquisition payload rewritten by a divergent serializer", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const corpus = createResearchCorpusReader(database.connection);
      const jobRef = `resource_research:${fixture.finalJobId}`;
      expect(corpus.readForJob(jobRef).sources).toHaveLength(1);

      const stored = database.connection.prepare(`
        SELECT source_id AS id, chunk_manifest_json AS stored
        FROM research_source_payloads LIMIT 1
      `).get() as { id: number; stored: string };
      expect(canonicalJson(JSON.parse(stored.stored) as unknown)).toBe(stored.stored);

      const rewritten = reversedKeyRewrite(stored.stored);
      expect(rewritten).not.toBe(stored.stored);

      // The payload is immutable once written, so bytes only a divergent serializer
      // would produce cannot replace what the shared helper stored.
      expect(() => database.connection
        .prepare(
          "UPDATE research_source_payloads SET chunk_manifest_json = ? WHERE source_id = ?",
        )
        .run(rewritten, stored.id)).toThrow(/immutable/i);
      expect(corpus.readForJob(jobRef).sources).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("digests an execution plan reproducibly from whatever the caller wrote", () => {
    // The SQL byte mirror keeps insertion order on purpose, so a digest that hashed
    // the caller's objects directly would depend on how the caller spelled them.
    // Production snapshots each target into a fixed shape first, which is what makes
    // the persisted deletion_plan_digest reproducible from the stored rows.
    const written = digestPrivacyPurgeExecutionTargets([
      { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7001" },
      { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7002" },
    ]);
    expect(written).toMatch(/^[0-9a-f]{64}$/);
    expect(digestPrivacyPurgeExecutionTargets([
      { pkV1: "pk:v1|1|i:4:7001", tableName: "research_runs" },
      { pkV1: "pk:v1|1|i:4:7002", tableName: "research_runs" },
    ])).toBe(written);

    // Target order stays significant, because the plan is an ordered plan.
    expect(digestPrivacyPurgeExecutionTargets([
      { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7002" },
      { tableName: "research_runs", pkV1: "pk:v1|1|i:4:7001" },
    ])).not.toBe(written);
  });
});
