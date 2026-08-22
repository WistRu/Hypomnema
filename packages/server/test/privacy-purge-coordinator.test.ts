import type { PrivacyPurgePublicTarget, PrivacyPurgeStatusResponse } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createPrivacyPurgeCoordinator,
  createPrivacyPurgeCoordinatorDependencies,
  createPrivacyPurgeCoordinatorFromDependencies,
  PrivacyPurgeCoordinatorError,
  readPrivacyPurgeNextWakeAt,
  type PrivacyPurgeCoordinatorDependencies } from
  "../src/privacy-purge-coordinator.js";
import { openDatabase } from "../src/database.js";

const AT = "2026-08-21T12:00:00.000Z";
const KEY = "a".repeat(64);
const PURGE_ID = `purge_${KEY}`;

function status(state: PrivacyPurgeStatusResponse["state"] = "waiting",
  completedSteps = 0, totalSteps = 2): PrivacyPurgeStatusResponse {
  return { version: 1, purgeId: PURGE_ID,
    target: { kind: "logical_page", logicalPageId: 91 }, state,
    progress: { completedSteps, totalSteps },
    holdReason: state === "failed_hold" ? "awaiting_provider_settlement" : null,
    canRetry: state === "failed_hold",
    timestamps: { createdAt: AT, updatedAt: AT,
      completedAt: state === "completed" || state === "failed" ? AT : null },
    result: state === "completed" || state === "failed" ? { deletedRows: 1 } : null };
}

function dependencies(): PrivacyPurgeCoordinatorDependencies & {
  current: PrivacyPurgeStatusResponse; calls: string[];
} {
  const value = { current: status(), calls: [] as string[] };
  const method = (name: string, update?: () => void) => vi.fn(() => {
    value.calls.push(name); update?.(); return { processed: 0, remaining: 0 };
  });
  return Object.assign(value, {
    statusReader: { read: vi.fn(() => value.current) },
    findByIdempotencyHash: vi.fn(() => null),
    resolveTarget: vi.fn(() => ({ kind: "logical_page", subjectGenerationId: 9 })),
    readIdentity: vi.fn(() => ({ idempotencyKeyHash: "b".repeat(64),
      requestFingerprint: "c".repeat(64), targetKind: "logical_page",
      subjectGenerationId: 9, historyEpochId: null, commandId: 7 })),
    readNextWakeAt: vi.fn(() => null),
    store: {
      publishWaiting: vi.fn(),
      reconcileActionWaits: method("actions"),
      abortStartedActionWait: vi.fn(async () => {
        value.calls.push("abort"); return { intentKey: KEY,
          processed: 0, remaining: 0, results: [] };
      }),
      terminalizeResourceResearchJobWaits: method("resource-jobs"),
      terminalizeJobWaits: method("jobs"),
      reconcileJobWaits: method("reconcile-jobs"),
      reconcileWaiting: method("reconcile-waiting"),
      repairFinalSettlements: vi.fn(async () => {
        value.calls.push("repair"); return { intentKey: KEY, inspectedJobs: 0,
          recordedEvidence: 0, status: "failed_hold" as const,
          transitioned: false, settlementProofGeneration: 0 };
      }),
      freezeReady: method("freeze", () => { value.current = status("ready", 1); }),
      linkReadyCommand: method("link", () => { value.current = status("committed", 1); }),
      executeCommitted: method("execute", () => { value.current = status("completed", 2); }),
    },
  }) as unknown as ReturnType<typeof dependencies>;
}

describe("privacy purge coordinator", () => {
  it("replays before generation resolution and rejects conflicting idempotency", async () => {
    const deps = dependencies();
    vi.mocked(deps.findByIdempotencyHash).mockReturnValue({ intentKey: KEY,
      target: status().target });
    const coordinator = createPrivacyPurgeCoordinatorFromDependencies(deps);
    await expect(coordinator.start({ version: 1, idempotencyKey: "same",
      target: status().target })).resolves.toEqual(status());
    expect(deps.resolveTarget).not.toHaveBeenCalled();

    vi.mocked(deps.findByIdempotencyHash).mockReturnValue({ intentKey: KEY,
      target: { kind: "run", researchRunId: 1 } });
    const conflicting = createPrivacyPurgeCoordinatorFromDependencies(deps);
    await expect(conflicting.start({ version: 1, idempotencyKey: "same",
      target: status().target })).rejects.toMatchObject({
        code: "PURGE_IDEMPOTENCY_CONFLICT", httpStatus: 409 });

    const disabled = dependencies();
    await expect(createPrivacyPurgeCoordinatorFromDependencies(disabled).start({
      version: 1, idempotencyKey: "unknown-disabled", target: status().target,
    }, { allowCreate: false })).rejects.toMatchObject({
      code: "PURGE_NEW_START_DISABLED", httpStatus: 409 });
    expect(disabled.resolveTarget).not.toHaveBeenCalled();
    expect(disabled.store.publishWaiting).not.toHaveBeenCalled();
  });

  it("accepts all public targets, snapshots getters once, and fails closed on TOCTOU", async () => {
    const targets: PrivacyPurgePublicTarget[] = [
      { kind: "logical_page", logicalPageId: 91 }, { kind: "run", researchRunId: 92 },
      { kind: "resource_history", resourceId: 93 },
    ];
    for (const target of targets) {
      const deps = dependencies();
      deps.current = { ...status(), target };
      const coordinator = createPrivacyPurgeCoordinatorFromDependencies(deps);
      await coordinator.start({ version: 1, idempotencyKey: `key-${target.kind}`, target });
      expect(deps.resolveTarget).toHaveBeenCalledWith(target);
    }
    let idempotencyReads = 0; let targetReads = 0;
    const deps = dependencies();
    const request = { version: 1 as const,
      get idempotencyKey() { idempotencyReads += 1; return "getter-key"; },
      get target() { targetReads += 1; return status().target; } };
    await createPrivacyPurgeCoordinatorFromDependencies(deps).start(request);
    expect({ idempotencyReads, targetReads }).toEqual({ idempotencyReads: 1, targetReads: 1 });

    deps.store.publishWaiting = vi.fn(() => { throw new Error("generation retired"); });
    await expect(createPrivacyPurgeCoordinatorFromDependencies(deps).start({ version: 1,
      idempotencyKey: "toctou", target: status().target })).rejects
      .toEqual(new PrivacyPurgeCoordinatorError("PURGE_UNAVAILABLE"));
  });

  it("drives one bounded waiting pass in order, stops at state barriers, and reports wake", async () => {
    const deps = dependencies();
    vi.mocked(deps.readNextWakeAt).mockReturnValue("2026-08-21T12:01:00.000Z");
    const result = await createPrivacyPurgeCoordinatorFromDependencies(deps).driveOnce(PURGE_ID);
    expect(deps.calls).toEqual(["actions", "abort", "resource-jobs", "jobs",
      "reconcile-jobs", "reconcile-waiting", "freeze"]);
    expect(result).toMatchObject({ status: { state: "ready" }, progressed: true });
    expect(result).not.toHaveProperty("nextWakeAt");

    const held = dependencies();
    held.store.reconcileActionWaits = vi.fn(() => {
      held.calls.push("actions"); held.current = status("failed_hold");
      return { intentKey: KEY, processed: 0, remaining: 1 };
    });
    await createPrivacyPurgeCoordinatorFromDependencies(held).driveOnce(PURGE_ID);
    expect(held.calls).toEqual(["actions"]);

    const pending = dependencies();
    pending.current = status("waiting", 0, 3);
    vi.mocked(pending.readNextWakeAt).mockReturnValue("2026-08-21T12:00:30.000Z");
    const pendingResult = await createPrivacyPurgeCoordinatorFromDependencies(pending)
      .driveOnce(PURGE_ID);
    expect(pendingResult).toMatchObject({ progressed: false,
      nextWakeAt: "2026-08-21T12:00:30.000Z" });
  });

  it.each([
    ["actions", ["actions"]],
    ["abort", ["actions", "abort"]],
    ["resource-jobs", ["actions", "abort", "resource-jobs"]],
    ["jobs", ["actions", "abort", "resource-jobs", "jobs"]],
    ["reconcile-jobs", ["actions", "abort", "resource-jobs", "jobs", "reconcile-jobs"]],
  ] as const)("stops at the first durable %s remaining barrier", async (lane, prefix) => {
    const deps = dependencies(); deps.current = status("waiting", 0, 3);
    vi.mocked(deps.readNextWakeAt).mockReturnValue("2026-08-21T12:00:30.000Z");
    if (lane === "abort") {
      deps.store.abortStartedActionWait = vi.fn(async () => {
        deps.calls.push("abort"); return { intentKey: KEY,
          processed: 0, remaining: 1, results: [] };
      });
    } else {
      const name = lane === "actions" ? "reconcileActionWaits"
        : lane === "resource-jobs" ? "terminalizeResourceResearchJobWaits"
        : lane === "jobs" ? "terminalizeJobWaits" : "reconcileJobWaits";
      deps.store[name] = vi.fn(() => {
        deps.calls.push(lane); return lane === "resource-jobs" || lane === "jobs"
          ? { intentKey: KEY, terminalized: 0, adopted: 0, remaining: 1 }
          : { intentKey: KEY, processed: 0, remaining: 1 };
      }) as never;
    }
    const result = await createPrivacyPurgeCoordinatorFromDependencies(deps)
      .driveOnce(PURGE_ID);
    expect(deps.calls).toEqual(prefix);
    expect(result).toEqual({ status: deps.current, progressed: false,
      nextWakeAt: "2026-08-21T12:00:30.000Z" });
  });

  it("resumes ready and committed, and leaves terminal or held states idle", async () => {
    for (const [from, called, to] of [
      ["ready", "link", "committed"], ["committed", "execute", "completed"],
    ] as const) {
      const deps = dependencies(); deps.current = status(from, 1);
      const result = await createPrivacyPurgeCoordinatorFromDependencies(deps).driveOnce(PURGE_ID);
      expect(deps.calls).toEqual([called]); expect(result.status.state).toBe(to);
    }
    for (const state of ["completed", "failed", "failed_hold"] as const) {
      const deps = dependencies(); deps.current = status(state, 2);
      const result = await createPrivacyPurgeCoordinatorFromDependencies(deps).driveOnce(PURGE_ID);
      expect(deps.calls).toEqual([]); expect(result.progressed).toBe(false);
    }
  });

  it("repairs provider holds only on explicit retry and serializes same purge", async () => {
    const deps = dependencies(); deps.current = status("failed_hold");
    let release!: () => void;
    deps.store.repairFinalSettlements = vi.fn(() => new Promise<void>((resolve) => {
      release = () => { deps.current = status("waiting"); resolve(); };
    }) as never);
    const coordinator = createPrivacyPurgeCoordinatorFromDependencies(deps);
    const first = coordinator.retry(PURGE_ID); const second = coordinator.retry(PURGE_ID);
    expect(deps.store.repairFinalSettlements).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([status("waiting"), status("waiting")]);

    deps.current = status("failed");
    await expect(coordinator.retry(PURGE_ID)).rejects.toMatchObject({
      code: "PURGE_RETRY_NOT_ALLOWED" });
  });

  it("preserves durable retry outcomes for zero, positive, and unknown evidence", async () => {
    for (const outcome of ["zero", "positive", "unknown"] as const) {
      const deps = dependencies(); deps.current = status("failed_hold");
      deps.store.repairFinalSettlements = vi.fn(async () => {
        if (outcome !== "unknown") deps.current = status("waiting");
        return { intentKey: KEY, inspectedJobs: 1,
          recordedEvidence: outcome === "unknown" ? 0 : 1,
          status: outcome === "unknown" ? "failed_hold" as const : "waiting" as const,
          transitioned: outcome !== "unknown", settlementProofGeneration: 1 };
      });
      const result = await createPrivacyPurgeCoordinatorFromDependencies(deps).retry(PURGE_ID);
      expect(result.state).toBe(outcome === "unknown" ? "failed_hold" : "waiting");
      expect(deps.store.repairFinalSettlements).toHaveBeenCalledTimes(1);
    }
  });

  it("single-flights an asynchronous started-action abort and awaits its barrier", async () => {
    const deps = dependencies(); deps.current = status("waiting", 0, 3);
    let release!: () => void;
    deps.store.abortStartedActionWait = vi.fn(() => new Promise<{
      intentKey: string; processed: number; remaining: number; results: [];
    }>((resolve) => {
      release = () => resolve({ intentKey: KEY, processed: 0, remaining: 1, results: [] });
    }));
    const coordinator = createPrivacyPurgeCoordinatorFromDependencies(deps);
    const first = coordinator.driveOnce(PURGE_ID);
    const second = coordinator.driveOnce(PURGE_ID);
    expect(deps.store.abortStartedActionWait).toHaveBeenCalledTimes(1);
    expect(deps.store.terminalizeResourceResearchJobWaits).not.toHaveBeenCalled();
    release(); await Promise.all([first, second]);
    expect(deps.store.abortStartedActionWait).toHaveBeenCalledTimes(1);
  });

  it("runs the immediate empty production path and replays across instances", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(AT) });
    try {
      database.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (91, 'https://example.test/91', 'https://example.test/91',
        'https://example.test/91', ?, ?)`)
        .run(AT, AT);
      const one = createPrivacyPurgeCoordinator(database.connection, { clock: () => new Date(AT) });
      const two = createPrivacyPurgeCoordinator(database.connection, { clock: () => new Date(AT) });
      const request = { version: 1 as const, idempotencyKey: "cross-instance",
        target: { kind: "logical_page" as const, logicalPageId: 91 } };
      const started = await one.start(request);
      expect((await two.start(request)).purgeId).toBe(started.purgeId);
      await expect(two.start({ ...request,
        target: { kind: "logical_page", logicalPageId: 92 } }))
        .rejects.toMatchObject({ code: "PURGE_IDEMPOTENCY_CONFLICT", httpStatus: 409 });
      expect((await one.driveOnce(started.purgeId)).status.state).toBe("ready");
      expect((await two.driveOnce(started.purgeId)).status.state).toBe("committed");
      expect((await one.driveOnce(started.purgeId)).status.state).toBe("completed");
    } finally { database.close(); }
  });

  it("computes the exact earliest production wake and excludes terminal/null rows", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(AT) });
    try {
      database.connection.exec(`
        CREATE TEMP TABLE privacy_purge_intent_action_waits (
          intent_key TEXT, state TEXT, terminal_state TEXT, resolution_deadline_at TEXT
        );
        CREATE TEMP TABLE privacy_purge_intent_job_waits (
          intent_key TEXT, terminal_status TEXT, request_bound INTEGER,
          lease_expires_at TEXT,
          settlement_deadline_at TEXT
        );
      `);
      const actionInsert = database.connection.prepare(`
        INSERT INTO privacy_purge_intent_action_waits VALUES (?, ?, ?, ?)
      `);
      actionInsert.run(KEY, "resolution_started", null, "2026-08-21T12:04:00.000Z");
      actionInsert.run(KEY, "resolution_started", "blocked", "2026-08-21T11:00:00.000Z");
      actionInsert.run(KEY, "planned", null, "2026-08-21T11:30:00.000Z");
      const jobInsert = database.connection.prepare(`
        INSERT INTO privacy_purge_intent_job_waits VALUES (?, ?, ?, ?, ?)
      `);
      jobInsert.run(KEY, null, 0, "2026-08-21T12:02:00.000Z",
        null);
      jobInsert.run(KEY, null, 1, "2026-08-21T11:00:00.000Z",
        "2026-08-21T12:03:00.000Z");
      jobInsert.run(KEY, "completed", 0, "2026-08-21T10:00:00.000Z", null);
      jobInsert.run("bound-only", null, 1, "2026-08-21T11:00:00.000Z",
        "2026-08-21T12:03:00.000Z");
      expect(readPrivacyPurgeNextWakeAt(database.connection, KEY))
        .toBe("2026-08-21T12:02:00.000Z");
      expect(readPrivacyPurgeNextWakeAt(database.connection, "bound-only"))
        .toBe("2026-08-21T12:03:00.000Z");
      expect(readPrivacyPurgeNextWakeAt(database.connection, "missing")).toBeNull();
    } finally { database.close(); }
  });

  it("fails closed when a real active generation changes after resolution", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(AT) });
    try {
      database.connection.prepare(`INSERT INTO logical_pages (
        id, identity_key, url_normalized, representative_url, created_at, updated_at
      ) VALUES (191, 'https://example.test/191', 'https://example.test/191',
        'https://example.test/191', ?, ?)` ).run(AT, AT);
      const base = createPrivacyPurgeCoordinatorDependencies(database.connection,
        { clock: () => new Date(AT) });
      const resolveTarget = base.resolveTarget;
      const deps = { ...base, resolveTarget: (target: PrivacyPurgePublicTarget) => {
        const resolved = resolveTarget(target);
        const old = resolved?.kind === "logical_page" ? resolved.subjectGenerationId : 0;
        const triggers = database.connection.prepare(`
          SELECT name, sql FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = 'privacy_subject_generations'
        `).all() as Array<{ name: string; sql: string }>;
        for (const trigger of triggers) database.connection.exec(`DROP TRIGGER "${trigger.name}"`);
        try {
          database.connection.prepare(`UPDATE privacy_subject_generations
            SET is_active = 0, retired_at = ? WHERE id = ?`).run(AT, old);
          database.connection.prepare(`INSERT INTO privacy_subject_generations (
            subject_kind, logical_page_id, generation_token, is_active, created_at
          ) VALUES ('logical_page', 191, ?, 1, ?)` ).run("d".repeat(64), AT);
        } finally { for (const trigger of triggers) database.connection.exec(trigger.sql); }
        return resolved;
      } };
      const coordinator = createPrivacyPurgeCoordinatorFromDependencies(deps);
      await expect(coordinator.start({ version: 1, idempotencyKey: "real-toctou",
        target: { kind: "logical_page", logicalPageId: 191 } }))
        .rejects.toMatchObject({ code: "PURGE_UNAVAILABLE" });
      expect(Number(database.connection.prepare(`SELECT COUNT(*)
        FROM privacy_purge_intents`).pluck().get())).toBe(0);
    } finally { database.close(); }
  });

  it("fails closed when a real active history epoch changes after resolution", async () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(AT) });
    try {
      database.connection.prepare(`INSERT INTO resources (id, resource_key, created_at)
        VALUES (291, 'resource-291', ?)` ).run(AT);
      const base = createPrivacyPurgeCoordinatorDependencies(database.connection,
        { clock: () => new Date(AT) });
      const resolveTarget = base.resolveTarget;
      const deps = { ...base, resolveTarget: (target: PrivacyPurgePublicTarget) => {
        const resolved = resolveTarget(target);
        const old = resolved?.kind === "resource_history" ? resolved.historyEpochId : 0;
        const epoch = database.connection.prepare(`SELECT resource_generation_id, epoch_no
          FROM research_history_epochs WHERE id = ?`).get(old) as {
            resource_generation_id: number; epoch_no: number;
          };
        const triggers = database.connection.prepare(`SELECT name, sql FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = 'research_history_epochs'`)
          .all() as Array<{ name: string; sql: string }>;
        for (const trigger of triggers) database.connection.exec(`DROP TRIGGER "${trigger.name}"`);
        try {
          database.connection.prepare(`UPDATE research_history_epochs
            SET is_active = 0, retired_at = ? WHERE id = ?`).run(AT, old);
          database.connection.prepare(`INSERT INTO research_history_epochs (
            resource_id, resource_generation_id, epoch_no, is_active, created_at
          ) VALUES (291, ?, ?, 1, ?)`)
            .run(epoch.resource_generation_id, epoch.epoch_no + 1, AT);
        } finally { for (const trigger of triggers) database.connection.exec(trigger.sql); }
        return resolved;
      } };
      await expect(createPrivacyPurgeCoordinatorFromDependencies(deps).start({
        version: 1, idempotencyKey: "real-epoch-toctou",
        target: { kind: "resource_history", resourceId: 291 },
      })).rejects.toMatchObject({ code: "PURGE_UNAVAILABLE" });
      expect(Number(database.connection.prepare(`SELECT COUNT(*)
        FROM privacy_purge_intents`).pluck().get())).toBe(0);
    } finally { database.close(); }
  });
});
