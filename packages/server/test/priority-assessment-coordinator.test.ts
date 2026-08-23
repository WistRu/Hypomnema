import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { createPriorityAssessmentCoordinator } from
  "../src/priority-assessment-coordinator.js";
import { priorityCoverageGuardSql } from "../src/priority-assessment-coordinator.js";
import { createPriorityEngine } from "../src/priority-engine.js";

const now = "2026-08-13T12:00:00.000Z";

function fixture(writerEnabled = true, hooks: {
  readonly afterAssess?: () => void;
  readonly afterBatchCheckpoint?: () => void;
  readonly afterListSubjects?: () => void;
  readonly afterPreflight?: () => void;
  readonly beforeGuard?: () => void;
  readonly clock?: () => Date;
} = {}) {
  const database = openDatabase(":memory:", {
    migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
  });
  database.connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES (501, 'https://coordinator.test/', 'https://coordinator.test/',
      'https://coordinator.test/', '2026-07-01T00:00:00.000Z', '${now}');
    INSERT INTO tabs (
      id, url, url_normalized, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES (601, 'https://coordinator.test/', 'https://coordinator.test/',
      'chrome', 'inbox', 0, 1, '2026-07-01T00:00:00.000Z', '${now}', 501);
    INSERT INTO resource_resolution_events (
      id, logical_page_id, state, reason, candidate_resource_ids_json,
      source_fingerprint, research_eligible, research_exclusion_reason, created_at
    ) VALUES (701, 501, 'unmatched', 'weak_sensitive_signal', '[]',
      'resolution', 0, 'weak_sensitive_signal', '${now}');
    INSERT INTO resource_resolution_heads (logical_page_id, resolution_event_id)
    VALUES (501, 701);
  `);
  let token = 0;
  let ledger: ReturnType<typeof createAiJobLedger> | undefined;
  const coordinator = createPriorityAssessmentCoordinator({
    connection: database.connection,
    clock: hooks.clock ?? (() => new Date(now)),
    createLedger: (guards) => {
      ledger = createAiJobLedger(database.connection, {
        clock: hooks.clock ?? (() => new Date(now)),
        kindAvailable: (kind) => kind === "priority_assessment" && writerEnabled,
        token: () => `coordinator-lease-${String(++token).padStart(4, "0")}`,
        guards,
      });
      return ledger;
    },
    writerEnabled,
    ...(hooks.afterAssess === undefined ? {} : { afterAssess: hooks.afterAssess }),
    ...(hooks.afterBatchCheckpoint === undefined ? {} : {
      afterBatchCheckpoint: hooks.afterBatchCheckpoint,
    }),
    ...(hooks.afterListSubjects === undefined ? {} : {
      afterListSubjects: hooks.afterListSubjects,
    }),
    ...(hooks.afterPreflight === undefined ? {} : { afterPreflight: hooks.afterPreflight }),
    ...(hooks.beforeGuard === undefined ? {} : { beforeGuard: hooks.beforeGuard }),
  });
  return { database, coordinator, ledger: ledger! };
}

describe("PriorityAssessmentCoordinator", () => {
  it("keeps the reviewed guard within C52a bounds and out of raw private bodies", () => {
    expect(Buffer.byteLength(priorityCoverageGuardSql, "utf8")).toBeLessThanOrEqual(16_384);
    expect(priorityCoverageGuardSql).not.toContain("THEN contents.summary");
    expect(priorityCoverageGuardSql).not.toContain("entries.body");
    expect(priorityCoverageGuardSql).not.toContain("group_concat");
  });

  it("submits and processes a bounded single-page assessment", () => {
    const { database, coordinator } = fixture();
    try {
      const job = coordinator.submit({
        subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "single-page",
      });
      expect(job).toMatchObject({ kind: "priority_assessment", status: "queued" });
      expect(coordinator.process("test-worker")).toMatchObject({
        status: "succeeded",
        result: { type: "priority_assessment" },
      });
      expect(coordinator.read({ type: "page", logicalPageId: 501 })).toMatchObject({
        currentOutcome: { kind: "assessment" },
        dirty: false,
        isCurrent: true,
      });
      expect(database.connection.prepare(
        "SELECT importance FROM tabs WHERE id = 601",
      ).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("replays the same idempotency key after wall-clock advance", () => {
    let current = new Date(now);
    const { database, coordinator } = fixture(true, { clock: () => current });
    try {
      const input = { subject: { type: "page" as const, logicalPageId: 501 },
        provenance: { requestedBy: "user" as const, requestMethod: "manual" as const },
        idempotencyKey: "stable-replay" };
      const first = coordinator.submit(input);
      current = new Date("2026-08-13T13:00:00.000Z");
      expect(coordinator.submit(input)).toEqual(first);
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(1);
    } finally { database.close(); }
  });

  it("recomputes the stored request fingerprint whatever order the input is written in", () => {
    const { database, coordinator } = fixture();
    try {
      const first = coordinator.submit({
        subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "fingerprint-roundtrip",
      });
      const stored = database.connection
        .prepare("SELECT input_fingerprint FROM ai_jobs WHERE id = 1")
        .pluck().get() as string;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);

      // The replay path recomputes the fingerprint from this input and compares it
      // against the stored one. Writing the properties in a different order is the
      // exact case where every retired copy that kept insertion order diverged.
      const replay = coordinator.submit({
        idempotencyKey: "fingerprint-roundtrip",
        provenance: { requestMethod: "manual", requestedBy: "user" },
        subject: { logicalPageId: 501, type: "page" },
      });

      expect(replay).toEqual(first);
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get())
        .toBe(1);
      expect(database.connection
        .prepare("SELECT input_fingerprint FROM ai_jobs WHERE id = 1")
        .pluck().get()).toBe(stored);
    } finally {
      database.close();
    }
  });

  it("performs zero job or assessment writes while the writer is disabled", () => {
    const { database, coordinator } = fixture(false);
    try {
      const writesBefore = database.connection.prepare("SELECT total_changes()").pluck().get();
      coordinator.read({ type: "page", logicalPageId: 501 });
      coordinator.readBatch([{ type: "page", logicalPageId: 501 }]);
      coordinator.reviewQueue({ limit: 10 });
      expect(coordinator.process("disabled-worker")).toBeUndefined();
      expect(() => coordinator.submit({
        subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "system", requestMethod: "scheduled" },
        idempotencyKey: "writer-off",
      })).toThrowError(expect.objectContaining({ code: "JOB_KIND_UNAVAILABLE" }));
      expect(database.connection.prepare("SELECT COUNT(*) FROM ai_jobs").pluck().get()).toBe(0);
      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM priority_assessments",
      ).pluck().get()).toBe(0);
      expect(database.connection.prepare("SELECT total_changes()").pluck().get())
        .toBe(writesBefore);
    } finally {
      database.close();
    }
  });

  it("cannot publish a stale outcome when a source changes before preflight", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let mutated = false;
    const result = fixture(true, { afterAssess: () => {
      if (mutated) return;
      mutated = true;
      databaseRef!.connection.prepare("UPDATE tabs SET status='done' WHERE id=601").run();
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "before-preflight-race" });
      expect(result.coordinator.process("race-worker")).toMatchObject({ status: "succeeded" });
      expect(result.database.connection.prepare(
        "SELECT spent_steps FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(4);
      expect(result.coordinator.read({ type: "page", logicalPageId: 501 })).toMatchObject({
        dirty: false, features: { status: ["done"] },
      });
    } finally { result.database.close(); }
  });

  it("restarts at scanning:0 after a mutation between preflight and guarded verify", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let mutated = false;
    const result = fixture(true, { beforeGuard: () => {
      if (mutated) return;
      mutated = true;
      databaseRef!.connection.prepare("UPDATE tabs SET status='archived' WHERE id=601").run();
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "guard-race" });
      expect(result.coordinator.process("race-worker")).toMatchObject({
        status: "succeeded",
      });
      expect(JSON.parse(String(result.database.connection.prepare(
        "SELECT checkpoint_json FROM ai_jobs WHERE id=1",
      ).pluck().get()))).toEqual({ nextOffset: 0, version: 1 });
    } finally { result.database.close(); }
  });

  it("does not invalidate the guard for a local-only context mutation", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    const result = fixture(true, { beforeGuard: () => {
      databaseRef!.connection.prepare(`INSERT INTO context_entries (
        logical_page_id,kind,body,actor,method,visibility,state,operation,revision,
        idempotency_key,created_at
      ) VALUES (501,'project','PRIVATE-GUARD-SENTINEL','user','manual','local_only',
        'active','append',1,'guard-private',?)`).run(now);
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "local-only-guard" });
      expect(result.coordinator.process("private-worker")).toMatchObject({
        status: "succeeded",
      });
    } finally { result.database.close(); }
  });

  it("terminates a perpetually dirty single subject as bounded partial after three cycles", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let status = "inbox";
    const result = fixture(true, { afterAssess: () => {
      status = status === "inbox" ? "done" : "inbox";
      databaseRef!.connection.prepare("UPDATE tabs SET status=? WHERE id=601").run(status);
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "perpetually-dirty" });
      expect(result.coordinator.process("dirty-worker")).toMatchObject({ status: "partial" });
      expect(result.database.connection.prepare(
        "SELECT spent_steps FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(6);
    } finally { result.database.close(); }
  });

  it("processes a collection above the public batch cap with exact 3N accounting", () => {
    const { database, coordinator } = fixture();
    try {
      database.connection.exec(`
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
        INSERT INTO logical_pages (id,identity_key,url_normalized,representative_url,
          created_at,updated_at)
        SELECT 1000+x,'https://bulk.test/'||x,'https://bulk.test/'||x,
          'https://bulk.test/'||x,'2026-07-01T00:00:00.000Z','${now}' FROM n;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
        INSERT INTO tabs (id,url,url_normalized,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id)
        SELECT 2000+x,'https://bulk.test/'||x,'https://bulk.test/'||x,'chrome',
          'inbox',0,0,'2026-07-01T00:00:00.000Z','${now}',1000+x FROM n;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
        INSERT INTO resource_resolution_events (id,logical_page_id,state,reason,
          candidate_resource_ids_json,source_fingerprint,research_eligible,
          research_exclusion_reason,created_at)
        SELECT 3000+x,1000+x,'unmatched','weak_sensitive_signal','[]','r-'||x,0,
          'weak_sensitive_signal','${now}' FROM n;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
        INSERT INTO resource_resolution_heads(logical_page_id,resolution_event_id)
        SELECT 1000+x,3000+x FROM n;
      `);
      coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "bulk-collection", stepBatchSize: 50 });
      expect(coordinator.process("collection-worker")).toMatchObject({ status: "succeeded" });
      expect(database.connection.prepare("SELECT spent_steps FROM ai_jobs WHERE id=1")
        .pluck().get()).toBe(306);
    } finally { database.close(); }
  });

  it("stops immediately when cancellation is observed at the first batch checkpoint", () => {
    let ledgerRef: ReturnType<typeof createAiJobLedger> | undefined;
    let requested = false;
    const result = fixture(true, { afterAssess: () => {
      if (requested) return;
      requested = true;
      ledgerRef!.cancel("priority_assessment", 1, "user");
    } });
    ledgerRef = result.ledger;
    try {
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "cancel-first-batch", stepBatchSize: 1 });
      expect(result.coordinator.process("cancel-worker")).toMatchObject({
        status: "cancelled", progress: { completed: 1, total: null },
      });
      expect(result.database.connection.prepare(
        "SELECT spent_steps FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(1);
      expect(result.database.connection.prepare(
        "SELECT COUNT(*) FROM ai_job_events WHERE job_id=1 AND event_type='progress'",
      ).pluck().get()).toBe(1);
    } finally { result.database.close(); }
  });

  it("resumes a collection from the first durable batch checkpoint after interruption", () => {
    let current = new Date(now);
    let interrupt = true;
    const result = fixture(true, {
      clock: () => current,
      afterBatchCheckpoint: () => {
        if (!interrupt) return;
        interrupt = false;
        throw new Error("simulated-worker-exit");
      },
    });
    try {
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "resume-first-batch", stepBatchSize: 1 });
      expect(() => result.coordinator.process("first-worker")).toThrow("simulated-worker-exit");
      expect(JSON.parse(String(result.database.connection.prepare(
        "SELECT checkpoint_json FROM ai_jobs WHERE id=1",
      ).pluck().get()))).toEqual({ nextOffset: 1, version: 1 });
      expect(result.database.connection.prepare(
        "SELECT progress_completed FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(1);

      current = new Date("2026-08-13T13:00:00.000Z");
      expect(result.ledger.recoverInterrupted()).toBe(1);
      expect(result.coordinator.process("second-worker")).toMatchObject({
        status: "succeeded", progress: { completed: 2, total: null },
      });
      expect(result.database.connection.prepare(
        "SELECT spent_steps FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(6);
    } finally { result.database.close(); }
  });

  it("terminal-fails an unsupported model claim without starving the next rule job", () => {
    const { database, coordinator, ledger } = fixture();
    try {
      const ruleset = database.connection.prepare(`
        SELECT ruleset_id AS rulesetId, version
        FROM priority_ruleset_activations WHERE scope='global'
      `).get() as { rulesetId: number; version: number };
      ledger.submit({
        version: 1, kind: "priority_assessment",
        subject: { type: "page", logicalPageId: 501 }, ruleset,
        assessmentProvenance: { method: "model", model: {
          provider: "test", name: "test-model", promptVersion: "v1",
        } },
        inputFingerprint: "a".repeat(64), idempotencyKey: "queued-model",
        stepBatchSize: 1,
        provenance: { requestedBy: "system", requestMethod: "scheduled" },
        schedulingPriority: 100,
        budget: { maxSteps: 6, maxTokens: 0, maxCostUsd: 0, maxWallTimeMs: 60_000 },
      });
      const resourceId = database.connection.prepare(`
        SELECT resources.id FROM resources
        JOIN resource_heads ON resource_heads.resource_id=resources.id
        JOIN resource_events ON resource_events.id=resource_heads.event_id
        WHERE resource_events.lifecycle_state='active' ORDER BY resources.id LIMIT 1
      `).pluck().get() as number;
      coordinator.submit({ subject: { type: "resource", resourceId },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "rule-after-model" });

      expect(coordinator.process("model-worker")).toMatchObject({
        status: "failed", error: { code: "JOB_INPUT_UNAVAILABLE" },
        progress: { completed: 0 },
      });
      expect(coordinator.process("rule-worker")).toMatchObject({ status: "succeeded" });
      expect(database.connection.prepare(
        "SELECT status FROM ai_jobs ORDER BY id",
      ).pluck().all()).toEqual(["failed", "succeeded"]);
    } finally { database.close(); }
  });

  it("keeps a matching exclusion method-independent for a model-bound queued identity", () => {
    const { database, coordinator, ledger } = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resource_resolution_events (
          id,logical_page_id,state,reason,candidate_resource_ids_json,
          source_fingerprint,research_eligible,research_exclusion_reason,
          supersedes_id,created_at
        ) VALUES (702,501,'excluded','invalid_url','[]','excluded',0,'invalid_url',
          701,'${now}');
        UPDATE resource_resolution_heads SET resolution_event_id=702
        WHERE logical_page_id=501;
      `);
      const read = coordinator.read({ type: "page", logicalPageId: 501 }, now);
      createPriorityEngine(database.connection, { now: () => now }).assess([{
        subject: read.subject, features: read.features, eligibility: read.eligibility,
        assessmentMethod: "rule",
      }], read.ruleset);
      ledger.submit({
        version: 1, kind: "priority_assessment", subject: read.subject,
        ruleset: read.ruleset,
        assessmentProvenance: { method: "model", model: {
          provider: "test", name: "test-model", promptVersion: "v1",
        } },
        inputFingerprint: "b".repeat(64), idempotencyKey: "model-exclusion-identity",
        stepBatchSize: 1,
        provenance: { requestedBy: "system", requestMethod: "scheduled" },
        schedulingPriority: 100,
        budget: { maxSteps: 6, maxTokens: 0, maxCostUsd: 0, maxWallTimeMs: 60_000 },
      });

      const rows = database.connection.prepare(priorityCoverageGuardSql)
        .raw(true).all(1) as unknown[][];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[10]).toBe("exclusion");
      expect(rows[0]?.[14]).toBe(1);
    } finally { database.close(); }
  });

  it("restarts a collection after denominator growth with unknown total and bounded work", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let grown = false;
    const result = fixture(true, { beforeGuard: () => {
      if (grown) return;
      grown = true;
      databaseRef!.connection.exec(`
        INSERT INTO logical_pages (id,identity_key,url_normalized,representative_url,
          created_at,updated_at)
        VALUES (9100501,'https://growth.test/','https://growth.test/',
          'https://growth.test/','2026-07-01T00:00:00.000Z','${now}');
        INSERT INTO tabs (id,url,url_normalized,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id)
        VALUES (9100601,'https://growth.test/','https://growth.test/','chrome','inbox',
          0,0,'2026-07-01T00:00:00.000Z','${now}',9100501);
        INSERT INTO resource_resolution_events (id,logical_page_id,state,reason,
          candidate_resource_ids_json,source_fingerprint,research_eligible,
          research_exclusion_reason,created_at)
        VALUES (9100701,9100501,'unmatched','weak_sensitive_signal','[]','growth',0,
          'weak_sensitive_signal','${now}');
        INSERT INTO resource_resolution_heads(logical_page_id,resolution_event_id)
        VALUES (9100501,9100701);
      `);
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "collection-growth", stepBatchSize: 1 });
      expect(result.coordinator.process("growth-worker")).toMatchObject({
        status: "succeeded", progress: { total: null },
      });
      expect(result.database.connection.prepare(
        "SELECT spent_steps <= max_steps FROM ai_jobs WHERE id=1",
      ).pluck().get()).toBe(1);
    } finally { result.database.close(); }
  });

  it("restarts a collection after denominator shrink with monotonic unknown-total progress", () => {
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let shrunk = false;
    const result = fixture(true, { beforeGuard: () => {
      if (shrunk) return;
      shrunk = true;
      databaseRef!.connection.exec(`
        INSERT INTO resource_events (resource_id,version,name,kind,access_class,
          lifecycle_state,merged_into_resource_id,created_by,creation_method,
          supersedes_id,created_at)
        SELECT events.resource_id,events.version+1,events.name,events.kind,
          events.access_class,'merged',9100801,'user','manual',events.id,'${now}'
        FROM resource_heads AS heads JOIN resource_events AS events ON events.id=heads.event_id
        WHERE events.lifecycle_state='active' AND events.resource_id<>9100801;
        UPDATE resource_heads SET event_id=(
          SELECT MAX(events.id) FROM resource_events AS events
          WHERE events.resource_id=resource_heads.resource_id
        );
      `);
    } });
    databaseRef = result.database;
    try {
      result.database.connection.prepare(
        "INSERT INTO resources(id,resource_key,created_at) VALUES (9100801,?,?)",
      ).run("website:shrink-target.test", now);
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "collection-shrink", stepBatchSize: 1 });
      expect(result.coordinator.process("shrink-worker")).toMatchObject({
        status: "succeeded", progress: { total: null },
      });
      const progress = result.database.connection.prepare(`
        SELECT progress_completed AS completed,progress_total AS total
        FROM ai_job_events WHERE job_id=1 AND event_type='progress'
        ORDER BY sequence_no
      `).all() as Array<{ completed: number; total: number | null }>;
      expect(progress.every((event) => event.total === null)).toBe(true);
      expect(progress.map((event) => event.completed)).toEqual(
        [...progress.map((event) => event.completed)].sort((a, b) => a - b),
      );
    } finally { result.database.close(); }
  });

  it("rejects assessment feedback whose expected path subject does not match", () => {
    const { database, coordinator } = fixture();
    try {
      coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "feedback-source" });
      coordinator.process("feedback-worker");
      const outcome = coordinator.read({ type: "page", logicalPageId: 501 }).currentOutcome;
      expect(outcome?.kind).toBe("assessment");
      const assessmentId = outcome?.kind === "assessment" ? outcome.assessment.id : 0;
      expect(() => coordinator.recordFeedback({
        expectedSubject: { type: "page", logicalPageId: 999 }, assessmentId,
        verdict: "accept", provenance: { actor: "user", method: "manual" },
        idempotencyKey: "wrong-path",
      })).toThrowError(expect.objectContaining({ code: "INVALID_PRIORITY_INPUT" }));
      expect(database.connection.prepare("SELECT COUNT(*) FROM priority_feedback")
        .pluck().get()).toBe(0);
    } finally { database.close(); }
  });
});

type GuardMutationCase = {
  readonly family: string;
  readonly subject?: { readonly type: "page"; readonly logicalPageId: number }
    | { readonly type: "resource"; readonly resourceId: number };
  readonly prepare?: (connection: ReturnType<typeof openDatabase>["connection"]) => void;
  readonly mutate: (connection: ReturnType<typeof openDatabase>["connection"]) => void;
};

const guardMutationCases: readonly GuardMutationCase[] = [
  {
    family: "topics and hierarchy",
    mutate(connection) {
      connection.exec(`
        INSERT INTO tags(id,name,parent_id) VALUES
          (9201,'Current projects',NULL),(9202,'Guard matrix',9201);
        INSERT INTO tab_tags(tab_id,tag_id,assigned_by) VALUES (601,9202,'user');
      `);
    },
  },
  {
    family: "workspace membership",
    mutate(connection) {
      connection.exec(`
        INSERT INTO saved_workspaces(id,name,created_at,updated_at)
        VALUES (9210,'Current projects/Guard matrix','${now}','${now}');
        INSERT INTO saved_workspace_items(workspace_id,ordinal,source_instance_id,
          canonical_tab_id,browser,installation_id,url,window_id,tab_index,active,
          pinned,audible,muted,discarded)
        VALUES (9210,0,9211,601,'chrome','guard-install','https://coordinator.test/',
          1,0,1,0,0,0,0);
      `);
    },
  },
  {
    family: "tab instances open pinned and last seen",
    mutate(connection) {
      connection.exec(`
        UPDATE tabs SET is_open=0,last_seen_at='2026-08-01T00:00:00.000Z' WHERE id=601;
        INSERT INTO tab_instances(tab_id,installation_id,instance_key,browser_tab_id,url,
          title,window_id,tab_index,active,pinned,first_seen_at,last_seen_at,
          browser_session_id)
        VALUES (601,'guard-install','guard-instance',1,'https://coordinator.test/',
          'Guard instance',1,0,0,1,'${now}','${now}','guard-session');
      `);
    },
  },
  {
    family: "relations and entities",
    mutate(connection) {
      connection.exec(`
        INSERT INTO logical_pages(id,identity_key,url_normalized,representative_url,
          created_at,updated_at)
        VALUES (9220,'https://guard-related.test/','https://guard-related.test/',
          'https://guard-related.test/','2026-07-01T00:00:00.000Z','${now}');
        INSERT INTO tabs(id,url,url_normalized,browser,status,importance,is_open,
          first_seen_at,last_seen_at,logical_page_id)
        VALUES (9221,'https://guard-related.test/','https://guard-related.test/',
          'chrome','inbox',0,0,'2026-07-01T00:00:00.000Z','${now}',9220);
        INSERT INTO relations(from_entity_id,to_entity_id,kind,created_by)
        SELECT source.id,target.id,'related','user'
        FROM knowledge_entities AS source CROSS JOIN knowledge_entities AS target
        WHERE source.tab_id=601 AND target.tab_id=9221;
      `);
    },
  },
  {
    family: "contents and summary",
    mutate(connection) {
      connection.exec(`
        INSERT INTO contents(tab_id,text,summary,extracted_at,content_revision)
        VALUES (601,'captured after preflight','guard summary','${now}',1);
      `);
    },
  },
  {
    family: "shareable page context reviews and staleness",
    mutate(connection) {
      connection.exec(`
        INSERT INTO context_entries(id,logical_page_id,kind,body,actor,method,
          visibility,source_fingerprint,state,operation,revision,idempotency_key,created_at)
        VALUES (9230,501,'project','guard action','agent','rule','share_with_ai',
          'guard-page-context','active','append',1,'guard-page-context','${now}');
        INSERT INTO context_entry_reviews(context_entry_id,verdict,reviewed_by,
          review_method,idempotency_key,created_at)
        VALUES (9230,'accepted','user','manual','guard-page-review','${now}');
      `);
    },
  },
  {
    family: "resource membership lifecycle context reviews and staleness",
    subject: { type: "resource", resourceId: 9240 },
    prepare(connection) {
      connection.exec(`
        INSERT INTO resources(id,resource_key,created_at)
        VALUES (9240,'website:guard-resource.test','${now}');
        INSERT INTO resource_events(id,resource_id,version,name,kind,access_class,
          lifecycle_state,created_by,creation_method,created_at)
        VALUES (9241,9240,1,'Guard Resource','website','public','active',
          'user','manual','${now}');
        INSERT INTO resource_heads(resource_id,event_id) VALUES (9240,9241);
        INSERT INTO logical_page_resource_assignments(id,logical_page_id,action,
          resource_id,provenance_class,assigned_by,assignment_method,
          source_fingerprint,created_at)
        VALUES (9242,501,'assigned',9240,'user_manual','user','manual',
          'guard-membership','${now}');
        INSERT INTO logical_page_resource_heads(logical_page_id,assignment_id)
        VALUES (501,9242);
      `);
    },
    mutate(connection) {
      connection.exec(`
        INSERT INTO resource_context_entries(id,resource_id,kind,body,actor,method,
          visibility,source_fingerprint,state,operation,revision,idempotency_key,created_at)
        VALUES (9243,9240,'project','guard resource context','agent','rule',
          'share_with_ai','guard-resource-context','active','append',1,
          'guard-resource-context','${now}');
        INSERT INTO resource_context_entry_reviews(context_entry_id,verdict,reviewed_by,
          review_method,idempotency_key,created_at)
        VALUES (9243,'accepted','user','manual','guard-resource-review','${now}');
        INSERT INTO resource_events(id,resource_id,version,name,kind,access_class,
          lifecycle_state,created_by,creation_method,supersedes_id,created_at)
        VALUES (9244,9240,2,'Guard Resource renamed','website','public','active',
          'user','manual',9241,'${now}');
        UPDATE resource_heads SET event_id=9244 WHERE resource_id=9240;
      `);
    },
  },
  {
    family: "resolution head",
    mutate(connection) {
      connection.exec(`
        INSERT INTO resource_resolution_events(id,logical_page_id,state,reason,
          candidate_resource_ids_json,source_fingerprint,research_eligible,
          research_exclusion_reason,supersedes_id,created_at)
        VALUES (9250,501,'excluded','invalid_url','[]','guard-resolution',0,
          'invalid_url',701,'${now}');
        UPDATE resource_resolution_heads SET resolution_event_id=9250
        WHERE logical_page_id=501;
      `);
    },
  },
  {
    family: "daily activity and writer epoch",
    mutate(connection) {
      connection.exec(`
        UPDATE activity_daily_writer_state SET state='enabled',
          coverage_started_at='2026-07-01T00:00:00.000Z',
          updated_at='2026-07-01T00:00:00.000Z' WHERE singleton_id=1;
        INSERT INTO logical_page_activity_daily(logical_page_id,activity_date,
          foreground_ms,engaged_ms,updated_at)
        VALUES (501,'2026-08-12',2000,500,'${now}');
      `);
    },
  },
  {
    family: "active ruleset",
    prepare(connection) {
      connection.exec(`
        INSERT INTO priority_rulesets(id,name,created_at,updated_at)
        VALUES (9260,'Guard alternate','${now}','${now}');
        INSERT INTO priority_rule_versions(ruleset_id,version,rule_ast_json,
          natural_language_source,created_by,created_at)
        SELECT 9260,1,rule_ast_json,'guard alternate','user','${now}'
        FROM priority_rule_versions WHERE ruleset_id=1 AND version=1;
      `);
    },
    mutate(connection) {
      connection.exec(`
        UPDATE priority_ruleset_activations SET ruleset_id=9260,version=1,
          activated_at='${now}' WHERE scope='global';
      `);
    },
  },
  {
    family: "outcome identity and XOR",
    mutate(connection) {
      connection.exec(`
        UPDATE priority_assessments SET superseded_at='${now}'
        WHERE logical_page_id=501 AND superseded_at IS NULL;
      `);
    },
  },
];

function guardMismatchCycles(connection: ReturnType<typeof openDatabase>["connection"]): number {
  return Number(connection.prepare(`
    SELECT COUNT(*) FROM ai_job_events WHERE job_id=1 AND event_type='progress'
      AND progress_stage GLOB 'ledger:guard-cycle:*'
  `).pluck().get());
}

describe("C51 acceptance proof matrix", () => {
  for (const scenario of guardMutationCases) {
    it(`rejects a stale guarded completion after ${scenario.family} mutation`, () => {
      let databaseRef: ReturnType<typeof openDatabase> | undefined;
      let mutated = false;
      const result = fixture(true, { beforeGuard: () => {
        if (mutated) return;
        mutated = true;
        scenario.mutate(databaseRef!.connection);
      } });
      databaseRef = result.database;
      try {
        scenario.prepare?.(result.database.connection);
        const subject = scenario.subject ?? { type: "page" as const, logicalPageId: 501 };
        result.coordinator.submit({ subject,
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `guard-family:${scenario.family}` });
        const view = result.coordinator.process(`guard-${scenario.family}`);
        expect(view).toBeDefined();
        expect(mutated).toBe(true);
        expect(guardMismatchCycles(result.database.connection)).toBeGreaterThanOrEqual(1);
        expect(view!.status).not.toBe("failed");
        expect(result.coordinator.read(subject).dirty)
          .toBe(false);
      } finally { result.database.close(); }
    });
  }

  it("does not mutate personal importance evaluation provenance timestamps or retention", () => {
    const { database, coordinator } = fixture();
    try {
      const resourceId = database.connection.prepare(`
        SELECT resources.id FROM resources JOIN resource_heads
          ON resource_heads.resource_id=resources.id
        JOIN resource_events ON resource_events.id=resource_heads.event_id
        WHERE resource_events.lifecycle_state='active' ORDER BY resources.id LIMIT 1
      `).pluck().get() as number;
      database.connection.exec(`
        UPDATE tabs SET importance=3 WHERE id=601;
        UPDATE logical_page_preferences SET user_importance=2,recorded_by='user',
          record_method='manual',importance_updated_at='2026-08-01T00:00:00.000Z',
          updated_at='2026-08-02T00:00:00.000Z' WHERE logical_page_id=501;
        UPDATE resource_preferences SET user_evaluation=3,recorded_by='agent',
          record_method='on_behalf_of_user',updated_at='2026-08-03T00:00:00.000Z'
          WHERE resource_id=${resourceId};
        INSERT INTO page_retention(tab_id,state,decided_by,decided_at)
        VALUES (601,'kept','user','2026-08-04T00:00:00.000Z');
      `);
      const personalSnapshot = () => ({
        tabs: database.connection.prepare(
          "SELECT id,importance FROM tabs ORDER BY id").all(),
        pages: database.connection.prepare(`
          SELECT logical_page_id,user_importance,recorded_by,record_method,
            importance_updated_at,updated_at FROM logical_page_preferences
          ORDER BY logical_page_id
        `).all(),
        resources: database.connection.prepare(`
          SELECT resource_id,user_evaluation,recorded_by,record_method,updated_at
          FROM resource_preferences ORDER BY resource_id
        `).all(),
        retention: database.connection.prepare(
          "SELECT * FROM page_retention ORDER BY tab_id").all(),
      });
      const before = personalSnapshot();
      for (const [index, subject] of [
        { type: "page" as const, logicalPageId: 501 },
        { type: "resource" as const, resourceId },
        { type: "collection" as const, scope: "all" as const },
      ].entries()) {
        coordinator.submit({ subject,
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `personal-noninterference:${index}` });
        expect(coordinator.process(`personal-noninterference-${index}`))
          .toMatchObject({ status: "succeeded" });
        expect(personalSnapshot()).toEqual(before);
      }
    } finally { database.close(); }
  });
});

function addPriorityPages(
  connection: ReturnType<typeof openDatabase>["connection"],
  count: number,
  base: number,
): void {
  connection.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO logical_pages(id,identity_key,url_normalized,representative_url,
      created_at,updated_at)
    SELECT ${base}+x,'https://budget.test/'||(${base}+x),
      'https://budget.test/'||(${base}+x),'https://budget.test/'||(${base}+x),
      '2026-07-01T00:00:00.000Z','${now}' FROM n;
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO tabs(id,url,url_normalized,browser,status,importance,is_open,
      first_seen_at,last_seen_at,logical_page_id)
    SELECT ${base + 1000}+x,'https://budget.test/'||(${base}+x),
      'https://budget.test/'||(${base}+x),'chrome','inbox',0,0,
      '2026-07-01T00:00:00.000Z','${now}',${base}+x FROM n;
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO resource_resolution_events(id,logical_page_id,state,reason,
      candidate_resource_ids_json,source_fingerprint,research_eligible,
      research_exclusion_reason,created_at)
    SELECT ${base + 2000}+x,${base}+x,'unmatched','weak_sensitive_signal','[]',
      'budget-'||(${base}+x),0,'weak_sensitive_signal','${now}' FROM n;
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO resource_resolution_heads(logical_page_id,resolution_event_id)
    SELECT ${base}+x,${base + 2000}+x FROM n;
  `);
}

describe("C51 bounded phase ladder", () => {
  it("charges collection denominator enumeration and stops at the wall budget", () => {
    let current = new Date(now);
    let chargeEnumeration = false;
    let beforeGuardCount = 0;
    let status = "inbox";
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    const result = fixture(true, {
      clock: () => current,
      afterListSubjects: () => {
        if (chargeEnumeration) current = new Date(current.getTime() + 20_000);
      },
      beforeGuard: () => {
        beforeGuardCount += 1;
        status = status === "inbox" ? "done" : "inbox";
        databaseRef!.connection.prepare(
          "UPDATE tabs SET status=? WHERE id=601",
        ).run(status);
      },
    });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "enumeration-wall-budget", stepBatchSize: 100 });
      chargeEnumeration = true;
      expect(result.coordinator.process("enumeration-wall-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(beforeGuardCount).toBe(2);
      expect(result.database.connection.prepare(`
        SELECT spent_wall_time_ms,max_wall_time_ms,status FROM ai_jobs WHERE id=1
      `).get()).toEqual({
        spent_wall_time_ms: 60_000,
        max_wall_time_ms: 60_000,
        status: "partial",
      });
    } finally { result.database.close(); }
  });

  it("completes an explicitly empty collection without inventing work", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date("2026-07-01T00:00:00.000Z"),
    });
    let ledger: ReturnType<typeof createAiJobLedger> | undefined;
    try {
      database.connection.prepare(
        "INSERT INTO resources(id,resource_key,created_at) VALUES (999,?,?)",
      ).run("website:empty-collection-target.test", now);
      database.connection.exec(`
        INSERT INTO resource_events(resource_id,version,name,kind,access_class,
          lifecycle_state,merged_into_resource_id,created_by,creation_method,
          supersedes_id,created_at)
        SELECT events.resource_id,events.version+1,events.name,events.kind,
          events.access_class,'merged',999,'user','manual',events.id,'${now}'
        FROM resource_heads AS heads JOIN resource_events AS events
          ON events.id=heads.event_id AND events.resource_id=heads.resource_id
        WHERE events.lifecycle_state='active';
        UPDATE resource_heads SET event_id=(SELECT MAX(events.id)
          FROM resource_events AS events
          WHERE events.resource_id=resource_heads.resource_id);
      `);
      const coordinator = createPriorityAssessmentCoordinator({
        connection: database.connection,
        clock: () => new Date(now),
        writerEnabled: true,
        createLedger(guards) {
          ledger = createAiJobLedger(database.connection, {
            clock: () => new Date(now),
            kindAvailable: (kind) => kind === "priority_assessment",
            token: () => "empty-collection-lease-token-0001",
            guards,
          });
          return ledger;
        },
      });
      coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "empty-collection", stepBatchSize: 100 });
      expect(coordinator.process("empty-collection-worker")).toMatchObject({
        status: "succeeded", progress: { completed: 0, total: null },
      });
      expect(database.connection.prepare(`
        SELECT spent_steps,spent_wall_time_ms,status FROM ai_jobs WHERE id=1
      `).get()).toEqual({ spent_steps: 0, spent_wall_time_ms: 0, status: "succeeded" });
    } finally { database.close(); }
  });

  it("terminal-partials the exact intermediate overflow interval I=3000 to N=14000", () => {
    let beforeGuardCount = 0;
    const { database, coordinator } = fixture(true, { beforeGuard: () => {
      beforeGuardCount += 1;
    } });
    try {
      addPriorityPages(database.connection, 2_998, 100_000);
      coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "intermediate-overflow", stepBatchSize: 100 });
      addPriorityPages(database.connection, 11_000, 200_000);
      expect(coordinator.process("intermediate-overflow-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
        progress: { completed: 14_000, total: null },
      });
      expect(beforeGuardCount).toBe(0);
      expect(database.connection.prepare(`
        SELECT spent_steps,max_steps,status FROM ai_jobs WHERE id=1
      `).get()).toEqual({ spent_steps: 34_002, max_steps: 36_000, status: "partial" });
    } finally { database.close(); }
  }, 120_000);

  it("terminal-partials after >4x growth before a success guard can overrun steps", () => {
    let beforeGuardCount = 0;
    const { database, coordinator } = fixture(true, { beforeGuard: () => {
      beforeGuardCount += 1;
    } });
    try {
      coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "growth-over-four-x", stepBatchSize: 100 });
      addPriorityPages(database.connection, 8, 9300);
      expect(coordinator.process("growth-over-four-x-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
        progress: { completed: 10, total: null },
      });
      expect(beforeGuardCount).toBe(0);
      expect(database.connection.prepare(`
        SELECT spent_steps,max_steps FROM ai_jobs WHERE id=1
      `).get()).toEqual({ spent_steps: 20, max_steps: 24 });
    } finally { database.close(); }
  });

  it("resumes into terminal partial when extreme growth no longer fits one scan", () => {
    let current = new Date(now);
    let interrupt = true;
    let beforeGuardCount = 0;
    const result = fixture(true, {
      clock: () => current,
      afterBatchCheckpoint: () => {
        if (!interrupt) return;
        interrupt = false;
        throw new Error("phase-ladder-interruption");
      },
      beforeGuard: () => { beforeGuardCount += 1; },
    });
    try {
      result.coordinator.submit({ subject: { type: "collection", scope: "all" },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "extreme-growth-resume", stepBatchSize: 1 });
      expect(() => result.coordinator.process("growth-first-worker"))
        .toThrow("phase-ladder-interruption");
      addPriorityPages(result.database.connection, 30, 9400);
      current = new Date("2026-08-13T13:00:00.000Z");
      expect(result.ledger.recoverInterrupted()).toBe(1);
      expect(result.coordinator.process("growth-resume-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
        progress: { completed: 1, total: null },
      });
      expect(beforeGuardCount).toBe(0);
      expect(result.database.connection.prepare(`
        SELECT spent_steps,max_steps,checkpoint_json FROM ai_jobs WHERE id=1
      `).get()).toEqual({
        spent_steps: 1, max_steps: 24,
        checkpoint_json: JSON.stringify({ nextOffset: 1, version: 1 }),
      });
    } finally { result.database.close(); }
  });

  it("charges single extract and assess wall time up to the exact terminal budget", () => {
    let current = new Date(now);
    let status = "inbox";
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    const result = fixture(true, { clock: () => current, afterAssess: () => {
      current = new Date(current.getTime() + 20_000);
    }, beforeGuard: () => {
      status = status === "inbox" ? "done" : "inbox";
      databaseRef!.connection.prepare("UPDATE tabs SET status=? WHERE id=601").run(status);
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "single-wall-budget" });
      expect(result.coordinator.process("single-wall-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(result.database.connection.prepare(`
        SELECT spent_steps,spent_wall_time_ms,max_wall_time_ms FROM ai_jobs WHERE id=1
      `).get()).toEqual({
        spent_steps: 5, spent_wall_time_ms: 60_000, max_wall_time_ms: 60_000,
      });
    } finally { result.database.close(); }
  });

  it("charges canonical preflight wall time before deciding not to run the guard", () => {
    let current = new Date(now);
    let beforeGuardCount = 0;
    let databaseRef: ReturnType<typeof openDatabase> | undefined;
    let status = "inbox";
    const result = fixture(true, { clock: () => current, afterPreflight: () => {
      current = new Date(current.getTime() + 20_000);
    }, beforeGuard: () => {
      beforeGuardCount += 1;
      status = status === "inbox" ? "done" : "inbox";
      databaseRef!.connection.prepare("UPDATE tabs SET status=? WHERE id=601").run(status);
    } });
    databaseRef = result.database;
    try {
      result.coordinator.submit({ subject: { type: "page", logicalPageId: 501 },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "preflight-wall-budget" });
      expect(result.coordinator.process("preflight-wall-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(beforeGuardCount).toBe(2);
      expect(result.database.connection.prepare(`
        SELECT spent_steps,spent_wall_time_ms FROM ai_jobs WHERE id=1
      `).get()).toEqual({ spent_steps: 5, spent_wall_time_ms: 60_000 });
    } finally { result.database.close(); }
  });

  for (const subject of [
    { type: "page" as const, logicalPageId: 501 },
    { type: "collection" as const, scope: "all" as const },
  ]) {
    it(`returns cancellation observed by the ${subject.type} success guard`, () => {
      let ledgerRef: ReturnType<typeof createAiJobLedger> | undefined;
      let cancelled = false;
      const result = fixture(true, { beforeGuard: () => {
        if (cancelled) return;
        cancelled = true;
        ledgerRef!.cancel("priority_assessment", 1, "user");
      } });
      ledgerRef = result.ledger;
      try {
        result.coordinator.submit({ subject,
          provenance: { requestedBy: "user", requestMethod: "manual" },
          idempotencyKey: `cancel-in-${subject.type}-guard` });
        expect(result.coordinator.process(`cancel-in-${subject.type}-guard-worker`))
          .toMatchObject({ status: "cancelled" });
      } finally { result.database.close(); }
    });
  }

  it("bounds a Resource that becomes inactive before its claim is processed", () => {
    const { database, coordinator } = fixture();
    try {
      const resourceId = database.connection.prepare(`
        SELECT resources.id FROM resources JOIN resource_heads
          ON resource_heads.resource_id=resources.id
        JOIN resource_events ON resource_events.id=resource_heads.event_id
        WHERE resource_events.lifecycle_state='active' ORDER BY resources.id LIMIT 1
      `).pluck().get() as number;
      coordinator.submit({ subject: { type: "resource", resourceId },
        provenance: { requestedBy: "user", requestMethod: "manual" },
        idempotencyKey: "inactive-before-claim" });
      database.connection.prepare(
        "INSERT INTO resources(id,resource_key,created_at) VALUES (9500,?,?)",
      ).run("website:inactive-target.test", now);
      database.connection.exec(`
        INSERT INTO resource_events(resource_id,version,name,kind,access_class,
          lifecycle_state,merged_into_resource_id,created_by,creation_method,
          supersedes_id,created_at)
        SELECT events.resource_id,events.version+1,events.name,events.kind,
          events.access_class,'merged',9500,'user','manual',events.id,'${now}'
        FROM resource_heads AS heads JOIN resource_events AS events ON events.id=heads.event_id
        WHERE events.resource_id=${resourceId};
        UPDATE resource_heads SET event_id=(SELECT MAX(id) FROM resource_events
          WHERE resource_id=${resourceId}) WHERE resource_id=${resourceId};
      `);
      expect(coordinator.process("inactive-resource-worker")).toMatchObject({
        status: "partial", error: { code: "JOB_BUDGET_EXHAUSTED" },
      });
      expect(database.connection.prepare(`
        SELECT spent_steps<=max_steps AS bounded,status FROM ai_jobs WHERE id=1
      `).get()).toEqual({ bounded: 1, status: "partial" });
    } finally { database.close(); }
  });
});
