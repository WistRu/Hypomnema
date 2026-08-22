import { createHash } from "node:crypto";

import {
  estimateResearchReservationV1,
  type ResearchApprovalRequest,
  type ResearchEvidenceDraft,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  createAiJobLedger,
  type AiJobCheckpointInput,
  type AiJobClaim,
  type AiJobLedger,
} from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import {
  buildCurrentResearchDraft,
  createResearchStore,
  fingerprintResearchApproval,
} from "../src/research-store.js";

const at = "2026-08-13T17:00:00.000Z";
const budget = { maxSteps: 10, maxTokens: 1_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const limits = { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function dossier(summary: string) {
  return {
    executiveSummary: summary,
    valueForUser: summary,
    capabilities: [] as string[], limitations: [] as string[], risks: [] as string[],
    unknowns: [] as string[], nextSteps: [] as string[],
  };
}

function publicationProvenance(model: string) {
  return {
    provider: "test", model, promptVersion: "v1", pricingVersion: "test-v1",
    requestId: null, generatedAt: at, usage: terminalCheckpoint().usage,
  };
}

function seed(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (1, 'https://privacy.openai.com/1', 'https://privacy.openai.com/1',
        'https://privacy.openai.com/1', '${at}', '${at}'),
      (2, 'https://privacy.openai.com/2', 'https://privacy.openai.com/2',
        'https://privacy.openai.com/2', '${at}', '${at}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES
      (11, 'https://privacy.openai.com/1', 'https://privacy.openai.com/1', 'One', 'chrome',
        'inbox', 0, 1, '${at}', '${at}', 1),
      (21, 'https://privacy.openai.com/2', 'https://privacy.openai.com/2', 'Two', 'chrome',
        'inbox', 0, 1, '${at}', '${at}', 2);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES
      (11, 'private research material', '${at}', 1),
      (21, 'related material', '${at}', 1);
    INSERT INTO resources (id, resource_key, created_at)
      VALUES (9, 'host:privacy.openai.com', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (90, 9, 1, 'Privacy', 'website', 'public', 'active',
      'system', 'derived', '${at}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES
      (91, 1, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'p1', '${at}'),
      (92, 2, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'p2', '${at}');
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      VALUES (1, 91), (2, 92);
    INSERT INTO context_entries (
      id, logical_page_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES (101, 1, 'purpose', 'private page purpose', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'privacy-page-context', '${at}');
    INSERT INTO resource_context_entries (
      id, resource_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES (201, 9, 'project', 'private resource purpose', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'privacy-resource-context', '${at}');
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (1, '2026-08-13', 1000, 500, '${at}');
    INSERT INTO relations (from_entity_id, to_entity_id, kind, note, created_by)
      SELECT first.id, second.id, 'related', 'private relation', 'user'
      FROM knowledge_entities AS first, knowledge_entities AS second
      WHERE first.tab_id = 11 AND second.tab_id = 21;
  `);
}

function approval(connection: ReturnType<typeof openDatabase>["connection"]): {
  readonly request: ResearchApprovalRequest;
  readonly task: ResourceResearchTaskSpec;
  readonly draft: ReturnType<typeof buildCurrentResearchDraft>;
} {
  const base: ResearchApprovalRequest = {
    version: 1,
    target: { type: "page", logicalPageId: 1 },
    question: "What must be forgotten?",
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "captured-only", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({ includedSources: 0,
      includedSourceBytes: 0, snapshotBytes: 0, questionBytes: 0, budget }),
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
  const initial = buildCurrentResearchDraft(connection, base, { clock: () => new Date(at) });
  const request = { ...base, approvalFingerprint: fingerprintResearchApproval(initial) };
  const draft = buildCurrentResearchDraft(connection, request, { clock: () => new Date(at) });
  return {
    request,
    draft,
    task: {
      version: 1,
      kind: "resource_research",
      subject: { type: "page", logicalPageId: 1 },
      workflowRef: request.workflowRef,
      inputFingerprint: request.approvalFingerprint,
      idempotencyKey: "privacy-research-page-1",
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget,
    },
  };
}

const checkpointDigests = {
  corpusDigest: "1".repeat(64),
  parentDigest: null,
  providerInputDigest: "2".repeat(64),
  quoteDigest: "3".repeat(64),
} as const;

function claimedCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: 1, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function providerReadyCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: 1, stage: "provider_ready" },
    checkpoint: {
      version: 1,
      nextStep: 1,
      stage: "provider_ready",
      ...checkpointDigests,
    },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function terminalCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 1, total: 1, stage: "terminal_publication" },
    checkpoint: {
      version: 1,
      nextStep: 2,
      stage: "terminal_publication",
      ...checkpointDigests,
      providerOutputDigest: "4".repeat(64),
    },
    usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01, wallTimeMs: 1 },
  };
}

function preparePublication(ledger: AiJobLedger, claim: AiJobClaim): void {
  ledger.checkpoint(claim, claimedCheckpoint());
  ledger.checkpoint(claim, providerReadyCheckpoint());
}

describe("closed research privacy primitive", () => {
  it("redacts invalid snapshots of all four kinds after dependent evidence/report", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const prepared = approval(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "privacy-lease-token-0001",
      research,
    });
    try {
      ledger.submitResearch(prepared.task, prepared.request);
      const claim = ledger.claimNext("resource_research", "privacy-worker", limits)!;
      preparePublication(ledger, claim);
      ledger.bindAttemptProvider(claim, {
        provider: "test", model: "privacy", promptVersion: "v1", pricingVersion: "test-v1",
      });
      const sources = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1 AND inclusion_state = 'included'
        ORDER BY included_order
      `).pluck().all() as number[];
      const snapshots = database.connection.prepare(`
        SELECT head.kind, head.snapshot_id AS id, payload.material_json
        FROM research_snapshot_heads AS head
        JOIN research_snapshot_payloads AS payload
          ON payload.kind = head.kind AND payload.snapshot_id = head.snapshot_id
        ORDER BY head.kind, head.snapshot_id
      `).all() as Array<{
        kind: "page_context" | "resource_context" | "activity" | "relation";
        id: number;
        material_json: string;
      }>;
      expect(snapshots.map((snapshot) => snapshot.kind).sort()).toEqual(
        ["activity", "page_context", "relation", "resource_context"],
      );
      const evidence: ResearchEvidenceDraft[] = snapshots.map((snapshot) => {
        const identity = {
          snapshotId: snapshot.id,
          locator: { version: "whole_snapshot:v1" as const },
          excerptHash: hash(snapshot.material_json),
        };
        switch (snapshot.kind) {
          case "page_context": return { kind: "page_context", ...identity };
          case "resource_context": return { kind: "resource_context", ...identity };
          case "activity": return { kind: "activity", ...identity };
          case "relation": return { kind: "relation", ...identity };
        }
      });
      const publication = {
        version: 1 as const,
        status: "succeeded" as const,
        reason: null,
        corpusFingerprint: prepared.draft.corpusFingerprint,
        inputFingerprint: prepared.task.inputFingerprint,
        coverage: {
          discovered: prepared.draft.sources.length,
          captured: prepared.draft.sources.filter((source) =>
            source.inclusionState === "included" || source.inclusionState === "excluded").length,
          eligible: prepared.draft.sources.filter((source) => source.eligibility === "eligible").length,
          used: 0,
          missing: prepared.draft.sources.filter((source) => source.inclusionState === "missing").length,
          failed: prepared.draft.sources.filter((source) => source.inclusionState === "failed").length,
        },
        usedSourceIds: [],
        provenance: publicationProvenance("privacy"),
        dossier: dossier("Privacy report"),
        claims: [{
          claim: "Snapshot-backed claim",
          confidence: 1,
          isInference: false,
          rationale: null,
          evidence,
        }],
      };
      expect(() => ledger.completeResearch(claim, terminalCheckpoint(), {
        ...publication,
        claims: [{
          ...publication.claims[0]!,
          evidence: [{ ...evidence[0]!, excerptHash: "f".repeat(64) }, ...evidence.slice(1)],
        }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`).pluck().get())
        .toBe(0);
      ledger.completeResearch(claim, terminalCheckpoint(), publication);
      database.connection.prepare(`
        INSERT INTO research_report_state_events (
          report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (1, 2, 'superseded', 'superseded', 'newer report',
          'supersede-before-privacy', ?)
      `).run(at);
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("superseded");
      for (const snapshot of snapshots) {
        database.connection.prepare(`
          INSERT INTO research_snapshot_state_events (
            kind, snapshot_id, sequence_no, event_type, state, reason,
            idempotency_key, occurred_at
          ) VALUES (?, ?, 2, 'invalidated', 'invalid', 'source changed', ?, ?)
        `).run(snapshot.kind, snapshot.id, `invalidate-${snapshot.kind}`, at);
      }
      const exactBoundaryKey = "k".repeat(200);
      const result = research.redactResearch({
        target: { type: "report", reportId: 1 },
        reason: "Forget exact-boundary research",
        idempotencyKey: exactBoundaryKey,
      });
      expect(result).toMatchObject({
        sources: 1, snapshots: 4, evidence: 4, reports: 1, runs: 1,
      });
      const childEvents = database.connection.prepare(`
        SELECT event_key, idempotency_key, child_type, child_key
        FROM research_privacy_event_bindings ORDER BY child_type, child_key
      `).all() as Array<{
        event_key: string; idempotency_key: string; child_type: string; child_key: string;
      }>;
      expect(childEvents).toHaveLength(10);
      expect(new Set(childEvents.map((event) => event.event_key)).size).toBe(10);
      expect(childEvents.every((event) => event.idempotency_key === exactBoundaryKey)).toBe(true);
      expect(childEvents.every((event) =>
        /^privacy-event:v1:[0-9a-f]{64}$/.test(event.event_key) &&
        Buffer.byteLength(event.event_key, "utf8") <= 200)).toBe(true);
      const beforeReplay = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(research.redactResearch({
        target: { type: "report", reportId: 1 },
        reason: "Forget exact-boundary research",
        idempotencyKey: exactBoundaryKey,
      })).toEqual(result);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(beforeReplay);
      expect(research.redactResearch({
        target: { type: "source", sourceId: sources[0]! },
        reason: "Forget source material",
        idempotencyKey: "forget-source-material",
      }).sources).toBe(1);
      expect(database.connection.prepare(`
        SELECT state FROM research_snapshot_heads ORDER BY kind
      `).pluck().all()).toEqual(["redacted", "redacted", "redacted", "redacted"]);
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("redacted");
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_snapshot_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_evidence_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_source_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_report_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_run_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_page_context_snapshots WHERE context_entry_id IS NOT NULL
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_resource_context_snapshots WHERE context_entry_id IS NOT NULL
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_activity_snapshots WHERE logical_page_id IS NOT NULL
      `).pluck().get()).toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_relation_snapshots WHERE relation_id IS NOT NULL
      `).pluck().get()).toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("removes a failed no-report run question and replays its receipt exactly", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const prepared = approval(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "privacy-failed-token-0001",
      research,
    });
    try {
      ledger.submitResearch(prepared.task, prepared.request);
      const claim = ledger.claimNext("resource_research", "privacy-failed-worker", limits)!;
      expect(ledger.fail(claim, claimedCheckpoint(), { code: "JOB_INPUT_UNAVAILABLE" }).status)
        .toBe("failed");
      const request = {
        target: { type: "logical_page" as const, logicalPageId: 1 },
        reason: "Forget failed research question",
        idempotencyKey: "forget-failed-page-1",
      };
      const result = research.redactResearch(request);
      const beforeReplay = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(research.redactResearch(request)).toEqual(result);
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(beforeReplay);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_run_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_redaction_receipts`)
        .pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("purges an explicit empty report together with its complete run corpus", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const prepared = approval(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "privacy-empty-report-token",
      research,
    });
    try {
      ledger.submitResearch(prepared.task, prepared.request);
      const claim = ledger.claimNext("resource_research", "empty-report-worker", limits)!;
      preparePublication(ledger, claim);
      ledger.bindAttemptProvider(claim, {
        provider: "test", model: "empty", promptVersion: "v1", pricingVersion: "test-v1",
      });
      ledger.completeResearch(claim, terminalCheckpoint(), {
        version: 1,
        status: "partial",
        reason: "budget_exhausted",
        corpusFingerprint: prepared.draft.corpusFingerprint,
        inputFingerprint: prepared.task.inputFingerprint,
        coverage: {
          discovered: prepared.draft.sources.length,
          captured: prepared.draft.sources.filter((source) =>
            source.inclusionState === "included" || source.inclusionState === "excluded").length,
          eligible: prepared.draft.sources.filter((source) => source.eligibility === "eligible").length,
          used: 0,
          missing: prepared.draft.sources.filter((source) => source.inclusionState === "missing").length,
          failed: prepared.draft.sources.filter((source) => source.inclusionState === "failed").length,
        },
        usedSourceIds: [],
        provenance: publicationProvenance("empty"),
        dossier: dossier("No usable findings"),
        claims: [],
      });
      expect(research.redactResearch({
        target: { type: "report", reportId: 1 },
        reason: "Forget empty report",
        idempotencyKey: "forget-empty-report",
      })).toMatchObject({ sources: 1, snapshots: 4, evidence: 0, reports: 1, runs: 1 });
      for (const table of [
        "research_source_payloads",
        "research_snapshot_payloads",
        "research_report_payloads",
        "research_run_payloads",
      ]) {
        expect(database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get())
          .toBe(0);
      }
      expect(database.connection.prepare(`
        SELECT state FROM research_report_heads WHERE report_id = 1
      `).pluck().get()).toBe("redacted");
    } finally {
      database.close();
    }
  });

  it("cancels queued work before redacting its target corpus", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const prepared = approval(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "privacy-queued-token",
      research,
    });
    try {
      ledger.submitResearch(prepared.task, prepared.request);
      expect(research.redactResearch({
        target: { type: "target", target: { type: "page", logicalPageId: 1 } },
        reason: "Forget active target",
        idempotencyKey: "forget-active-page-target",
      }).cancelledJobs).toBe(1);
      expect(ledger.get("resource_research", 1)?.status).toBe("cancelled");
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_run_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_source_payloads`)
        .pluck().get()).toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_snapshot_payloads`)
        .pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
