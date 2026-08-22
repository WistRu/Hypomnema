import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { openDatabase } from "../src/database.js";
import { createLiveAcquisitionStatusReader, deriveLiveAcquisitionOutcome,
  deriveLiveRunSuccess, projectExactTabFallback, assertLiveAcquisitionActionRowBound } from
  "../src/live-acquisition-status-reader.js";
import { compareLiveAcquisitionStatusActions } from
  "../src/live-acquisition-status-reader.js";
import type { LiveAcquisitionRunStatus } from "@tabhub/shared";
import { createPrivacyPurgeIntentStore } from
  "../src/privacy-purge-intent-capabilities.js";
import {
  liveResearchFixtureAt,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

function seedReadableFixture(database: ReturnType<typeof openDatabase>,
  mutateCheckpoint?: (value: Record<string, unknown>) => Record<string, unknown>) {
  const fixture = seedReceiptBackedLiveResearchRun(database.connection);
  database.connection.exec(`DROP TRIGGER ai_job_attempts_validate_claim;
    DROP TRIGGER ai_job_attempts_project_claim`);
  database.connection.prepare(`INSERT INTO ai_job_attempts (
    id, job_id, attempt_no, lease_token, worker_id, started_at, completed_at, outcome
  ) VALUES (99001, ?, 1, 'status-reader-lease', 'fixture', ?, ?, 'superseded')`)
    .run(fixture.coordinatorJobId, liveResearchFixtureAt, liveResearchFixtureAt);
  const checkpoint = { version: 1, stage: "ready_for_handoff", consentId: 1,
    runtimeEpoch: 1, counters: { reservedPages: 1, visitedPages: 1, capturedPages: 1,
      blockedPages: 0, ambiguousPages: 0, robotsActions: 0, networkActions: 1 },
    queue: { plannedActionIds: [] as number[], activeActionIds: [] as number[] } };
  const persistedCheckpoint = mutateCheckpoint?.(checkpoint) ?? checkpoint;
  const checkpointJson = JSON.stringify(persistedCheckpoint);
  database.connection.exec("DROP TRIGGER live_acquisition_checkpoints_insert_guard");
  database.connection.prepare(`INSERT INTO live_acquisition_checkpoints (
    attempt_id, coordinator_job_id, consent_id, runtime_epoch,
    checkpoint_json, checkpoint_digest, updated_at
  ) VALUES (99001, ?, 1, 1, ?, ?, ?)`)
    .run(fixture.coordinatorJobId, checkpointJson,
      createHash("sha256").update(checkpointJson).digest("hex"), liveResearchFixtureAt);
  database.connection.prepare(`INSERT INTO live_acquisition_workflow_outcomes (
    coordinator_job_id, coordinator_run_generation_id, outcome, outcome_code,
    safe_details_json, created_at
  ) SELECT ?, coordinator_run_generation_id, 'handoff', 'WORKFLOW_COMPLETED', '{}', ?
    FROM live_acquisition_consents WHERE coordinator_job_id=?`).run(
    fixture.coordinatorJobId, liveResearchFixtureAt, fixture.coordinatorJobId);
  return { fixture, checkpoint };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("live acquisition status reader", () => {
  it("enforces the persisted action-row 1016/1017 boundary before projection", () => {
    expect(() => assertLiveAcquisitionActionRowBound(1_016)).not.toThrow();
    expect(() => assertLiveAcquisitionActionRowBound(1_017))
      .toThrow("Live acquisition status unavailable");
  });

  it("projects exact-tab fallback only for the frozen actionable set", () => {
    for (const allowed of ["SENSITIVE_URL_CAPTURE_REQUIRED", "AUTH_REQUIRED", "CHALLENGE_PAGE",
      "SPA_SHELL", "INSUFFICIENT_PUBLIC_TEXT", "META_REFRESH", "HTTP_REDIRECT",
      "IPV4_REQUIRED_V1", "DNS_RESULT_UNKNOWN", "TRANSPORT_DNS_FAILURE",
      "TRANSPORT_CONNECT_FAILURE", "TRANSPORT_TLS_FAILURE", "TRANSPORT_TIMEOUT",
      "PARTIAL_RESPONSE", "INVALID_UTF8", "RESPONSE_SIZE_LIMIT", "POLICY_BLOCKED"]) {
      expect(projectExactTabFallback(allowed)).toEqual({
        recommendedKind: "exact_tab_capture", reason: allowed });
    }
    for (const forbidden of [null, "CANCELLED", "BUDGET_EXHAUSTED",
      "LIVE_ACQUISITION_DISABLED", "CONSENT_EXPIRED_IN_FLIGHT",
      "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH", "RUNTIME_RESTARTED_BEFORE_REQUEST"]) {
      expect(projectExactTabFallback(forbidden)).toBeNull();
    }
  });
  it("freezes terminal live-success truth independently from later redaction", () => {
    expect(deriveLiveRunSuccess({ workflowOutcome: null, finalTerminal: false,
      finalConsistentSucceeded: false, usedLive: false })).toBeNull();
    expect(deriveLiveRunSuccess({ workflowOutcome: "handoff", finalTerminal: false,
      finalConsistentSucceeded: false, usedLive: true })).toBeNull();
    const succeeded = deriveLiveRunSuccess({ workflowOutcome: "handoff", finalTerminal: true,
      finalConsistentSucceeded: true, usedLive: true });
    expect(succeeded).toBe(true);
    expect(deriveLiveRunSuccess({ workflowOutcome: "handoff", finalTerminal: true,
      finalConsistentSucceeded: false, usedLive: true })).toBe(false);
    expect(deriveLiveRunSuccess({ workflowOutcome: "handoff", finalTerminal: true,
      finalConsistentSucceeded: true, usedLive: false })).toBe(false);
    expect(deriveLiveAcquisitionOutcome({ reportRedacted: true, purging: false,
      workflowOutcome: "handoff", outcomeCode: "WORKFLOW_COMPLETED", finalTerminal: true,
      runLiveSuccess: succeeded, mixed: false })).toBe("redacted");
    expect(succeeded).toBe(true);
  });

  it.each([
    ["LIVE_ACQUISITION_RESOURCE_REQUIRED", "blocked"],
    ["LIVE_ACQUISITION_TARGET_UNSUPPORTED", "blocked"],
    ["RESEARCH_WORKFLOW_UNSUPPORTED", "blocked"],
    ["LIVE_ACQUISITION_DISABLED", "blocked"],
    ["LIVE_ACQUISITION_DISABLED_IN_FLIGHT", "blocked"],
    ["ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH", "blocked"],
    ["SENSITIVE_URL_CAPTURE_REQUIRED", "blocked"],
    ["CONSENT_EXPIRED_IN_FLIGHT", "blocked"],
    ["PURGE_WAITING_FOR_ACTION", "purging"],
    ["SUBJECT_FORGOTTEN", "redacted"],
    ["WORKFLOW_COMPLETED", "live_complete"],
    ["WORKFLOW_BLOCKED", "blocked"],
    ["WORKFLOW_AMBIGUOUS", "ambiguous"],
    ["WORKFLOW_FAILED", "failed"],
    ["WORKFLOW_CANCELLED", "cancelled"],
    ["NO_ELIGIBLE_SOURCE", "zero_usable"],
    ["BUDGET_EXHAUSTED", "zero_usable"],
    ["POLICY_BLOCKED", "blocked"],
    ["PROVIDER_UNAVAILABLE", "failed"],
  ] as const)("maps authoritative workflow code %s", (outcomeCode, expected) => {
    expect(deriveLiveAcquisitionOutcome({ reportRedacted: false, purging: false,
      workflowOutcome: outcomeCode === "WORKFLOW_COMPLETED" ? "handoff" : "superseded",
      outcomeCode, finalTerminal: true,
      runLiveSuccess: outcomeCode === "WORKFLOW_COMPLETED", mixed: false })).toBe(expected);
  });
  it("orders robots by UTF-8 origin before pages by depth, URL, and id", () => {
    const action = (id: number, kind: "robots" | "page", origin: string | null,
      depth: number | null, exactUrl: string | null) => ({ id, kind, origin, depth, exactUrl,
        state: "planned", latestOutcome: null, createdAt: liveResearchFixtureAt,
        terminalAt: null, redacted: false, usability: kind === "page" ? "pending" : null,
        sourceUsable: null, omissionReason: null, fallback: null, capture: null,
        finalInclusion: null }) as LiveAcquisitionRunStatus["actions"][number];
    const actions = [action(5, "page", "https://b.example", 1, "https://b.example/z"),
      action(4, "robots", "https://z.example", null, null),
      action(3, "page", "https://a.example", 0, "https://a.example/z"),
      action(2, "robots", "https://a.example", null, null),
      action(1, "page", "https://a.example", 1, "https://a.example/a")];
    expect(actions.sort(compareLiveAcquisitionStatusActions).map(({ id }) => id))
      .toEqual([2, 4, 3, 1, 5]);
  });
  it("projects persisted action and handoff provenance without private transport material", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      database.connection.exec(`DROP TRIGGER ai_job_attempts_validate_claim;
        DROP TRIGGER ai_job_attempts_project_claim`);
      database.connection.prepare(`INSERT INTO ai_job_attempts (
        id, job_id, attempt_no, lease_token, worker_id, started_at, completed_at, outcome
      ) VALUES (99001, ?, 1, 'status-reader-lease', 'fixture', ?, ?, 'superseded')`)
        .run(fixture.coordinatorJobId, liveResearchFixtureAt, liveResearchFixtureAt);
      const checkpoint = JSON.stringify({ version: 1, stage: "ready_for_handoff", consentId: 1,
        runtimeEpoch: 1, counters: { reservedPages: 1, visitedPages: 1, capturedPages: 1,
          blockedPages: 0, ambiguousPages: 0, robotsActions: 0, networkActions: 1 },
        queue: { plannedActionIds: [], activeActionIds: [] } });
      database.connection.exec("DROP TRIGGER live_acquisition_checkpoints_insert_guard");
      database.connection.prepare(`INSERT INTO live_acquisition_checkpoints (
        attempt_id, coordinator_job_id, consent_id, runtime_epoch,
        checkpoint_json, checkpoint_digest, updated_at
      ) VALUES (99001, ?, 1, 1, ?, ?, ?)`)
        .run(fixture.coordinatorJobId, checkpoint,
          createHash("sha256").update(checkpoint).digest("hex"), liveResearchFixtureAt);
      database.connection.prepare(`INSERT INTO live_acquisition_workflow_outcomes (
        coordinator_job_id, coordinator_run_generation_id, outcome, outcome_code,
        safe_details_json, created_at
      ) SELECT ?, coordinator_run_generation_id, 'handoff', 'WORKFLOW_COMPLETED', '{}', ?
        FROM live_acquisition_consents WHERE coordinator_job_id=?`).run(
        fixture.coordinatorJobId, liveResearchFixtureAt, fixture.coordinatorJobId);

      const status = createLiveAcquisitionStatusReader(database.connection)
        .read(`resource_research:${fixture.coordinatorJobId}`);
      expect(status).not.toBeNull();
      expect(status).toMatchObject({
        jobId: `resource_research:${fixture.coordinatorJobId}`,
        coordinator: { runId: fixture.coordinatorJobId, status: "superseded" },
        final: { jobId: `resource_research:${fixture.finalJobId}`,
          runId: fixture.finalRunId, status: "queued", reportId: null },
        runLiveSuccess: null,
        workflowOutcome: "handoff",
        workflowOutcomeCode: "WORKFLOW_COMPLETED",
        acquisitionOutcome: "running",
        counters: { reservedPages: 1, visitedPages: 1, capturedPages: 1,
          blockedPages: 0, ambiguousPages: 0, robotsActions: 0, networkActions: 1,
          plannedActions: 0, activeActions: 0 },
      });
      expect(status!.actions).toHaveLength(1);
      expect(status!.actions[0]).toMatchObject({
        kind: "page", state: "completed", latestOutcome: "FETCH_COMPLETED",
        sourceUsable: true, usability: "usable", omissionReason: null, fallback: null,
        exactUrl: "https://www.cloudflare.com/live-research-source",
        finalInclusion: { finalRunId: fixture.finalRunId, sourceKind: "live_acquisition",
          acquisitionMethod: "safe_public_http_v1" },
      });
      const json = JSON.stringify(status);
      expect(json).not.toContain("203.0.113.1");
      expect(json).not.toContain("receipt-backed public live evidence");
      expect(json).not.toContain("digest_key");

      const pageGenerationId = Number(database.connection.prepare(`SELECT id
        FROM privacy_subject_generations WHERE subject_kind='logical_page'
          AND logical_page_id=7001 AND is_active=1`).pluck().get());
      const idempotencyKey = "status-reader-logical-page-purge";
      createPrivacyPurgeIntentStore(database.connection, {
        clock: () => new Date("2026-08-14T12:00:02.000Z"),
      }).publishWaiting({
        intentKey: createHash("sha256").update("status-reader-logical-page-intent").digest("hex"),
        idempotencyKeyHash: createHash("sha256").update(
          `tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`).digest("hex"),
        requestFingerprint: createHash("sha256").update(
          `tabhub:privacy-purge:request:v1\0logical_page:${pageGenerationId}`).digest("hex"),
        target: { kind: "logical_page", subjectGenerationId: pageGenerationId },
      });
      const purging = createLiveAcquisitionStatusReader(database.connection)
        .read(`resource_research:${fixture.coordinatorJobId}`)!;
      expect(purging.acquisitionOutcome).toBe("purging");
      expect(purging.consent.approvedOrigins).toEqual([]);
      expect(purging.actions[0]).toMatchObject({ exactUrl: null, origin: null, redacted: true,
        capture: null, finalInclusion: null });
    } finally { database.close(); }
  });

  it("returns null for malformed or non-C90 job identities", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const reader = createLiveAcquisitionStatusReader(database.connection);
      expect(reader.read("7")).toBeNull();
      expect(reader.read("resource_research:0")).toBeNull();
      expect(reader.read("resource_research:999999")).toBeNull();
    } finally { database.close(); }
  });

  it("fails closed when actions exist without their mandatory checkpoint", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      expect(() => createLiveAcquisitionStatusReader(database.connection)
        .read(`resource_research:${fixture.coordinatorJobId}`))
        .toThrow("Live acquisition status unavailable");
    } finally { database.close(); }
  });

  it.each(["run", "resource_history"] as const)(
    "redacts the whole projection for an active %s purge",
    (kind) => {
      const database = openDatabase(":memory:", {
        migrationClock: () => new Date(liveResearchFixtureAt),
      });
      try {
        const { fixture } = seedReadableFixture(database);
        const connection = database.connection;
        const target = kind === "run" ? { kind, subjectGenerationId: Number(
          connection.prepare(`SELECT id FROM privacy_subject_generations
            WHERE subject_kind='research_run' AND research_run_id=? AND is_active=1`)
            .pluck().get(fixture.coordinatorJobId)) }
          : { kind, historyEpochId: Number(connection.prepare(`SELECT history_epoch_id
              FROM research_runs WHERE id=?`).pluck().get(fixture.coordinatorJobId)) };
        const identity = kind === "run" ? String(target.subjectGenerationId)
          : String(target.historyEpochId);
        const idempotencyKey = `status-reader-${kind}-purge`;
        createPrivacyPurgeIntentStore(connection, {
          clock: () => new Date("2026-08-14T12:00:02.000Z"),
        }).publishWaiting({ intentKey: sha256(`${kind}-intent`),
          idempotencyKeyHash: sha256(`tabhub:privacy-purge:idempotency:v1\0${idempotencyKey}`),
          requestFingerprint: sha256(`tabhub:privacy-purge:request:v1\0${kind}:${identity}`),
          target });
        const status = createLiveAcquisitionStatusReader(connection)
          .read(`resource_research:${fixture.coordinatorJobId}`)!;
        expect(status.acquisitionOutcome).toBe("purging");
        expect(status.consent.approvedOrigins).toEqual([]);
        expect(status.actions.every((action) => action.redacted && action.exactUrl === null &&
          action.origin === null && action.capture === null && action.finalInclusion === null))
          .toBe(true);
      } finally { database.close(); }
    },
  );

  it.each([
    ["stage", (value: Record<string, unknown>) => ({ ...value, stage: "acquiring" })],
    ["ordered IDs", (value: Record<string, unknown>) => ({ ...value,
      queue: { plannedActionIds: [7001], activeActionIds: [] } })],
    ["counters", (value: Record<string, unknown>) => ({ ...value,
      counters: { ...(value.counters as object), networkActions: 0 } })],
  ] as const)("fails closed on drifted checkpoint %s", (_name, mutate) => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(liveResearchFixtureAt),
    });
    try {
      const { fixture } = seedReadableFixture(database, mutate);
      expect(() => createLiveAcquisitionStatusReader(database.connection)
        .read(`resource_research:${fixture.coordinatorJobId}`))
        .toThrow("Live acquisition status unavailable");
    } finally { database.close(); }
  });
});
