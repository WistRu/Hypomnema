import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import {
  estimateResearchReservationV1,
  researchCanonicalSha256PayloadV1,
  researchLiveAcquisitionSourceDraftSchema,
  researchSelectionFingerprintPayload,
  type ResearchApprovalRequest,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  createAiJobLedger,
  type AiJobCheckpointInput,
} from "../src/ai-job-ledger.js";
import {
  createResearchCorpusReader,
  materializeResearchCorpusSource,
} from "../src/research-corpus.js";
import { openDatabase } from "../src/database.js";
import { renderResearchReportText } from "../src/research-report-renderer.js";
import {
  buildCurrentResearchDraft,
  createResearchStore,
  fingerprintResearchApproval,
} from "../src/research-store.js";
import {
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

const at = "2026-08-13T18:00:00.000Z";
const budget = { maxSteps: 10, maxTokens: 2_000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const limits = { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));
}

function reportDossier(summary: string) {
  return {
    executiveSummary: summary,
    valueForUser: `Value: ${summary}`,
    capabilities: [] as string[],
    limitations: [] as string[],
    risks: [] as string[],
    unknowns: [] as string[],
    nextSteps: [] as string[],
  };
}

function terminalCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 1, total: null, stage: "terminal_publication" },
    checkpoint: {
      version: 1,
      nextStep: 2,
      stage: "terminal_publication",
      corpusDigest: "1".repeat(64),
      parentDigest: null,
      providerInputDigest: "2".repeat(64),
      quoteDigest: "3".repeat(64),
      providerOutputDigest: "4".repeat(64),
    },
    usage: {
      steps: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.01, wallTimeMs: 100,
    },
  };
}

function claimedCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: null, stage: "claimed" },
    checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function providerReadyCheckpoint(): AiJobCheckpointInput {
  return {
    progress: { completed: 0, total: null, stage: "provider_ready" },
    checkpoint: {
      version: 1,
      nextStep: 1,
      stage: "provider_ready",
      corpusDigest: "1".repeat(64),
      parentDigest: null,
      providerInputDigest: "2".repeat(64),
      quoteDigest: "3".repeat(64),
    },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
  };
}

function seedPages(
  connection: ReturnType<typeof openDatabase>["connection"],
  options: { readonly localOnly?: boolean } = {},
): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (1, 'https://corpus.openai.com/1', 'https://corpus.openai.com/1',
        'https://corpus.openai.com/1', '${at}', '${at}'),
      (2, 'https://corpus.openai.com/2', 'https://corpus.openai.com/2',
        'https://corpus.openai.com/2', '${at}', '${at}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES
      (11, 'https://corpus.openai.com/1', 'https://corpus.openai.com/1', 'One',
        'chrome', 'inbox', 0, 1, '${at}', '${at}', 1),
      (22, 'https://corpus.openai.com/2', 'https://corpus.openai.com/2', 'Two',
        'chrome', 'inbox', 0, 1, '${at}', '${at}', 2);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES
      (11, 'first source', '${at}', 3),
      (22, 'second source', '${at}', 7);
    INSERT INTO resources (id, resource_key, created_at)
      VALUES (9, 'host:corpus.openai.com', '${at}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      created_by, creation_method, created_at
    ) VALUES (90, 9, 1, 'Corpus', 'website', 'public', 'active',
      'system', 'derived', '${at}');
    INSERT INTO resource_heads (resource_id, event_id) VALUES (9, 90);
    INSERT INTO logical_page_resource_assignments (
      id, logical_page_id, action, resource_id, provenance_class, assigned_by,
      assignment_method, source_fingerprint, created_at
    ) VALUES
      (91, 1, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'c1', '${at}'),
      (92, 2, 'assigned', 9, 'registrable_domain', 'system', 'derived', 'c2', '${at}');
    INSERT INTO logical_page_resource_heads (logical_page_id, assignment_id)
      VALUES (1, 91), (2, 92);
    INSERT INTO context_entries (
      id, logical_page_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES (101, 1, 'purpose', 'shareable page context', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'corpus-page-context', '${at}');
    INSERT INTO resource_context_entries (
      id, resource_id, kind, body, actor, method, visibility, state, operation,
      revision, idempotency_key, created_at
    ) VALUES (201, 9, 'project', 'shareable resource context', 'user', 'manual',
      'share_with_ai', 'active', 'append', 1, 'corpus-resource-context', '${at}');
    INSERT INTO logical_page_activity_daily (
      logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
    ) VALUES (1, '2026-08-13', 1000, 500, '${at}');
    INSERT INTO relations (from_entity_id, to_entity_id, kind, note, created_by)
      SELECT first.id, second.id, 'related', 'shareable relation note', 'user'
      FROM knowledge_entities AS first, knowledge_entities AS second
      WHERE first.tab_id = 11 AND second.tab_id = 22;
  `);
  if (options.localOnly === true) {
    connection.exec(`
      INSERT INTO context_entries (
        id, logical_page_id, kind, body, actor, method, visibility, state, operation,
        revision, idempotency_key, created_at
      ) VALUES (102, 1, 'note', 'LOCAL_PAGE_CANARY', 'user', 'manual',
        'local_only', 'active', 'append', 2, 'local-page-canary', '${at}');
      INSERT INTO resource_context_entries (
        id, resource_id, kind, body, actor, method, visibility, state, operation,
        revision, idempotency_key, created_at
      ) VALUES (202, 9, 'note', 'LOCAL_RESOURCE_CANARY', 'user', 'manual',
        'local_only', 'active', 'append', 2, 'local-resource-canary', '${at}');
    `);
  }
}

function submitSelection(
  connection: ReturnType<typeof openDatabase>["connection"],
  includeShareableContext = false,
  options: {
    readonly parentReportId?: number | null;
    readonly idempotencyKey?: string;
  } = {},
): ReturnType<typeof buildCurrentResearchDraft> {
  const target = {
    type: "selection" as const,
    logicalPageIds: [2, 1],
    fingerprint: sha256(researchSelectionFingerprintPayload([2, 1])),
  };
  const base: ResearchApprovalRequest = {
    version: 1,
    target,
    question: "Compare the selected pages",
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: options.parentReportId ?? null,
    approvalFingerprint: "0".repeat(64),
    workflowRef: { id: "captured-only", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 0,
      includedSourceBytes: 0,
      snapshotBytes: 0,
      questionBytes: 0,
      budget,
    }),
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
  const initial = buildCurrentResearchDraft(connection, base, { clock: () => new Date(at) });
  const request = { ...base, approvalFingerprint: fingerprintResearchApproval(initial) };
  const draft = buildCurrentResearchDraft(connection, request, { clock: () => new Date(at) });
  const task: ResourceResearchTaskSpec = {
    version: 1,
    kind: "resource_research",
    subject: { type: "selection", fingerprint: target.fingerprint },
    workflowRef: request.workflowRef,
    inputFingerprint: request.approvalFingerprint,
    idempotencyKey: options.idempotencyKey ?? "research-corpus-selection",
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget,
  };
  const research = createResearchStore(connection, { clock: () => new Date(at) });
  createAiJobLedger(connection, {
    clock: () => new Date(at),
    token: () => "research-corpus-token-0001",
    kindAvailable: () => true,
    research,
  }).submitResearch(task, request);
  return draft;
}

function publishSelectionParent(
  connection: ReturnType<typeof openDatabase>["connection"],
  status: "succeeded" | "partial" = "succeeded",
): { readonly reportId: number; readonly draft: ReturnType<typeof buildCurrentResearchDraft> } {
  const draft = submitSelection(connection, false, {
    idempotencyKey: `research-corpus-parent-${status}`,
  });
  const research = createResearchStore(connection, { clock: () => new Date(at) });
  const ledger = createAiJobLedger(connection, {
    clock: () => new Date(at),
    token: () => `research-corpus-parent-token-${status}`,
    kindAvailable: () => true,
    research,
  });
  const claim = ledger.claimNext("resource_research", `parent-worker-${status}`, limits)!;
  ledger.bindAttemptProvider(claim, {
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "fixture-v1",
    pricingVersion: "fixture-pricing-v1",
  });
  ledger.recordAttemptRequest(claim, `parent-request-${status}`);
  ledger.checkpoint(claim, claimedCheckpoint());
  ledger.checkpoint(claim, providerReadyCheckpoint());
  const run = connection.prepare(`
    SELECT id, corpus_fingerprint FROM research_runs WHERE job_id = ?
  `).get(claim.id) as { id: number; corpus_fingerprint: string };
  const result = ledger.completeResearch(claim, terminalCheckpoint(), {
    version: 1,
    status,
    reason: status === "succeeded" ? null : "budget_exhausted",
    corpusFingerprint: run.corpus_fingerprint,
    inputFingerprint: draft.approvalFingerprint,
    coverage: { discovered: 2, captured: 2, eligible: 2, used: 0, missing: 0, failed: 0 },
    usedSourceIds: [],
    provenance: {
      provider: "fixture-provider",
      model: "fixture-model",
      promptVersion: "fixture-v1",
      pricingVersion: "fixture-pricing-v1",
      requestId: `parent-request-${status}`,
      generatedAt: at,
      usage: terminalCheckpoint().usage,
    },
    dossier: reportDossier(`${status} parent`),
    claims: [],
  });
  const outcome = result.result;
  if (outcome === null || outcome.type !== "resource_research") {
    throw new Error("Expected a research parent report");
  }
  return { reportId: outcome.reportId, draft };
}

function submitChildWithParent(
  connection: ReturnType<typeof openDatabase>["connection"],
  parentReportId: number,
): ReturnType<typeof buildCurrentResearchDraft> {
  return submitSelection(connection, false, {
    parentReportId,
    idempotencyKey: `research-corpus-child-${parentReportId}`,
  });
}

describe("internal approved research corpus reader", () => {
  it("materializes a receipt-bound live source without a physical tab", () => {
    const evidenceMaterial = "public live source";
    const source = researchLiveAcquisitionSourceDraftSchema.parse({
      sourceKind: "live_acquisition",
      ordinal: 1,
      logicalPageId: 7,
      tabId: null,
      selectedTabId: null,
      contentRevision: 1,
      contentDigest: "a".repeat(64),
      extractedAt: at,
      acquisitionMethod: "safe_public_http_v1",
      accessClass: "public",
      eligibility: "eligible",
      inclusionState: "included",
      includedOrder: 1,
      handoffSourceReceiptId: 19,
      handoffSourceReceiptDigest: "b".repeat(64),
      payload: {
        url: "https://example.com/live",
        title: "Live",
        evidenceMaterial,
        chunkManifest: {
          version: "captured_text_chunks:v1",
          byteStart: 0,
          byteEnd: Buffer.byteLength(evidenceMaterial),
          chunkDigest: sha256(evidenceMaterial),
          truncated: false,
        },
      },
    });

    expect(materializeResearchCorpusSource(source, 31)).toMatchObject({
      sourceId: 31,
      sourceKind: "live_acquisition",
      tabId: null,
      acquisitionMethod: "safe_public_http_v1",
      handoffSourceReceiptId: 19,
      payload: { trust: "untrusted_source_material", evidenceMaterial },
    });
  });

  it("reads a receipt-backed schema-25 live source without a physical tab", () => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      expect(database.schemaVersion).toBe(26);
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);

      const corpus = createResearchCorpusReader(database.connection).readForJob(
        `resource_research:${fixture.finalJobId}`,
      );

      expect(corpus).toMatchObject({
        runId: fixture.finalRunId,
        target: fixture.draft.target,
        approvalFingerprint: fixture.draft.approvalFingerprint,
        corpusFingerprint: fixture.draft.corpusFingerprint,
        sources: [{
          sourceId: fixture.sourceId,
          sourceKind: "live_acquisition",
          tabId: null,
          acquisitionMethod: "safe_public_http_v1",
          handoffSourceReceiptId: fixture.sourceReceiptId,
          handoffSourceReceiptDigest: fixture.sourceReceiptDigest,
          payload: {
            trust: "untrusted_source_material",
            evidenceMaterial: "receipt-backed public live evidence",
          },
        }],
      });
      expect(database.connection.prepare("SELECT COUNT(*) FROM tabs").pluck().get()).toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["receipt identity", (connection: Database.Database) => {
      connection.exec("DROP TRIGGER live_acquisition_source_receipts_immutable_update");
      connection.prepare("UPDATE live_acquisition_source_receipts SET ordinal = 2 WHERE id = 1")
        .run();
    }],
    ["terminal handoff receipt", (connection: Database.Database) => {
      connection.exec("DROP TRIGGER live_acquisition_handoff_receipts_immutable_delete");
      connection.prepare("DELETE FROM live_acquisition_handoff_receipts WHERE handoff_id = 1")
        .run();
    }],
  ] as const)("rejects a live source with mismatched %s", (_variant, corrupt) => {
    const database = openDatabase(":memory:", { migrationClock: () => new Date(at) });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      corrupt(database.connection);

      expect(() => createResearchCorpusReader(database.connection).readForJob(
        `resource_research:${fixture.finalJobId}`,
      )).toThrowError(expect.objectContaining({ code: "RESEARCH_CORPUS_MISMATCH" }));
    } finally {
      database.close();
    }
  });

  it("restores the exact ordered selection and approved source payloads by durable job ID", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      const draft = submitSelection(database.connection);
      const before = database.connection.prepare("SELECT total_changes()").pluck().get();

      const corpus = createResearchCorpusReader(database.connection)
        .readForJob("resource_research:1");

      expect(corpus).toMatchObject({
        version: 1,
        jobId: "resource_research:1",
        runId: 1,
        target: draft.target,
        selectionLogicalPageIds: [2, 1],
        question: draft.question,
        approvalFingerprint: draft.approvalFingerprint,
        corpusFingerprint: draft.corpusFingerprint,
        parent: null,
      });
      const { parent: _parent, corpusDigest, ...material } = corpus;
      expect(corpusDigest).toBe(sha256(canonicalJson(material)));
      expect(corpus.sources.map((source) => ({
        sourceId: source.sourceId,
        ordinal: source.ordinal,
        includedOrder: source.includedOrder,
        logicalPageId: source.logicalPageId,
        sourceKind: source.sourceKind,
        acquisitionMethod: source.acquisitionMethod,
        contentRevision: source.contentRevision,
        contentDigest: source.contentDigest,
        evidenceMaterial: source.payload.evidenceMaterial,
        trust: source.payload.trust,
      }))).toEqual([
        {
          sourceId: 1,
          ordinal: 1,
          includedOrder: 1,
          logicalPageId: 2,
          sourceKind: "captured",
          acquisitionMethod: "captured",
          contentRevision: 7,
          contentDigest: sha256("second source"),
          evidenceMaterial: "second source",
          trust: "untrusted_source_material",
        },
        {
          sourceId: 2,
          ordinal: 2,
          includedOrder: 2,
          logicalPageId: 1,
          sourceKind: "captured",
          acquisitionMethod: "captured",
          contentRevision: 3,
          contentDigest: sha256("first source"),
          evidenceMaterial: "first source",
          trust: "untrusted_source_material",
        },
      ]);
      expect(corpus.snapshots).toEqual([]);
      expect(database.connection.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("constructs and reads a captured-only corpus on raw schema 24", () => {
    const database = openDatabase(":memory:", {
      maximumMigrationVersion: 24,
    });
    try {
      expect(database.connection.pragma("user_version", { simple: true })).toBe(24);
      seedPages(database.connection);
      submitSelection(database.connection);

      const reader = createResearchCorpusReader(database.connection);
      const corpus = reader.readForJob("resource_research:1");

      expect(corpus.sources).toHaveLength(2);
      expect(corpus.sources.map((source) => ({
        sourceKind: source.sourceKind,
        acquisitionMethod: source.acquisitionMethod,
        tabId: source.tabId,
      }))).toEqual([
        {
          sourceKind: "captured",
          acquisitionMethod: "captured",
          tabId: 22,
        },
        {
          sourceKind: "captured",
          acquisitionMethod: "captured",
          tabId: 11,
        },
      ]);
      expect(corpus.sources.every((source) =>
        !("handoffSourceReceiptId" in source) &&
        !("handoffSourceReceiptDigest" in source)
      )).toBe(true);
    } finally {
      database.close();
    }
  });

  it.each([
    ["fresh", "succeeded", null],
    ["stale", "succeeded", "stale"],
    ["partial", "partial", null],
  ] as const)("atomically projects a %s parent with a canonical digest", (
    _label, publishStatus, laterState,
  ) => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      const parent = publishSelectionParent(database.connection, publishStatus);
      if (laterState === "stale") {
        database.connection.prepare(`
          INSERT INTO research_report_state_events (
            report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
          ) VALUES (?, 2, 'stale', 'stale', 'source changed', 'parent-stale', ?)
        `).run(parent.reportId, at);
      }
      submitChildWithParent(database.connection, parent.reportId);
      const corpus = createResearchCorpusReader(database.connection)
        .readForJob("resource_research:2");
      const stored = database.connection.prepare(`
        SELECT report.version, report.publish_status, head.state,
          payload.report_text, payload.payload_digest
        FROM research_reports AS report
        JOIN research_report_heads AS head ON head.report_id = report.id
        JOIN research_report_payloads AS payload ON payload.report_id = report.id
        WHERE report.id = ?
      `).get(parent.reportId) as {
        version: number;
        publish_status: "succeeded" | "partial";
        state: "fresh" | "stale";
        report_text: string;
        payload_digest: string;
      };
      const expectedParent = {
        reportId: parent.reportId,
        reportVersion: stored.version,
        state: stored.state,
        reportText: stored.report_text,
        payloadDigest: stored.payload_digest,
      };
      expect(corpus.parent).toEqual({
        ...expectedParent,
        digest: sha256(canonicalJson(expectedParent)),
      });
      expect(stored.publish_status).toBe(publishStatus);
      const { parent: _parent, corpusDigest, ...material } = corpus;
      expect(corpusDigest).toBe(sha256(canonicalJson(material)));
    } finally {
      database.close();
    }
  });

  it("changes only the parent digest when a valid immutable parent projection changes", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      const parent = publishSelectionParent(database.connection);
      submitChildWithParent(database.connection, parent.reportId);
      const reader = createResearchCorpusReader(database.connection);
      const before = reader.readForJob("resource_research:2");
      const dossier = reportDossier("mutated parent");
      const reportText = renderResearchReportText(dossier, []);
      const payloadDigest = sha256(canonicalJson({ text: reportText, dossier }));
      database.connection.exec("DROP TRIGGER research_report_payloads_immutable_update");
      database.connection.prepare(`
        UPDATE research_report_payloads
        SET report_text = ?, structured_json = ?, payload_digest = ?
        WHERE report_id = ?
      `).run(reportText, canonicalJson(dossier), payloadDigest, parent.reportId);
      const after = reader.readForJob("resource_research:2");
      expect(after.parent?.digest).not.toBe(before.parent?.digest);
      expect(after.parent).toMatchObject({ reportText, payloadDigest });
      expect(after.corpusDigest).toBe(before.corpusDigest);
    } finally {
      database.close();
    }
  });

  it.each([
    ["wrong target", "RESEARCH_CORPUS_MISMATCH"],
    ["missing", "RESEARCH_CORPUS_MISMATCH"],
    ["redacted", "RESEARCH_REDACTION_REQUIRED"],
    ["superseded", "RESEARCH_CORPUS_MISMATCH"],
  ] as const)("rejects a %s parent", (variant, code) => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      const parent = publishSelectionParent(database.connection);
      submitChildWithParent(database.connection, parent.reportId);
      if (variant === "wrong target") {
        database.connection.exec("DROP TRIGGER research_reports_immutable_update");
        database.connection.prepare(`
          UPDATE research_reports
          SET target_logical_page_id = 1, target_resource_id = NULL,
            selection_fingerprint = NULL, target_key = 'page:1'
          WHERE id = ?
        `).run(parent.reportId);
      } else if (variant === "missing") {
        database.connection.pragma("foreign_keys = OFF");
        database.connection.exec(`
          DROP TRIGGER research_runs_immutable_update;
          DROP TRIGGER privacy_purge26_research_runs_update_fence;
        `);
        database.connection.prepare(`
          UPDATE research_runs SET parent_report_id = 999 WHERE job_id = 2
        `).run();
      } else if (variant === "redacted") {
        createResearchStore(database.connection, { clock: () => new Date(at) }).redactResearch({
          target: { type: "report", reportId: parent.reportId },
          reason: "privacy request",
          idempotencyKey: "parent-redacted",
        });
      } else {
        database.connection.prepare(`
          INSERT INTO research_report_state_events (
            report_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
          ) VALUES (?, 2, ?, ?, ?, ?, ?)
        `).run(
          parent.reportId,
          variant,
          variant,
          null,
          `parent-${variant}`,
          at,
        );
      }
      expect(() => createResearchCorpusReader(database.connection)
        .readForJob("resource_research:2")).toThrowError(expect.objectContaining({ code }));
    } finally {
      database.close();
    }
  });

  it("restores all four approved snapshot kinds without a local-only existence signal", () => {
    const withPrivate = openDatabase(":memory:");
    const withoutPrivate = openDatabase(":memory:");
    try {
      seedPages(withPrivate.connection, { localOnly: true });
      seedPages(withoutPrivate.connection);
      const draft = submitSelection(withPrivate.connection, true);
      submitSelection(withoutPrivate.connection, true);

      const privateCorpus = createResearchCorpusReader(withPrivate.connection)
        .readForJob("resource_research:1");
      const publicCorpus = createResearchCorpusReader(withoutPrivate.connection)
        .readForJob("resource_research:1");

      expect(privateCorpus).toEqual(publicCorpus);
      expect(privateCorpus.snapshots.map((snapshot) => snapshot.kind)).toEqual([
        "page_context", "resource_context", "activity", "relation",
      ]);
      expect(privateCorpus.snapshots.map(({ snapshotId: _snapshotId, ...snapshot }) => snapshot))
        .toEqual(draft.snapshots);
      expect(JSON.stringify(privateCorpus)).not.toContain("LOCAL_PAGE_CANARY");
      expect(JSON.stringify(privateCorpus)).not.toContain("LOCAL_RESOURCE_CANARY");
    } finally {
      withPrivate.close();
      withoutPrivate.close();
    }
  });

  it("returns a deterministic material-free stale-guard audit with exact coverage", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection, { localOnly: true });
      const draft = submitSelection(database.connection, true);
      const reader = createResearchCorpusReader(database.connection);
      const before = database.connection.prepare("SELECT total_changes()").pluck().get();
      const first = reader.readAuditForJob("resource_research:1");
      const second = reader.readAuditForJob("resource_research:1");
      const expected = {
        version: 1 as const,
        jobId: "resource_research:1" as const,
        runId: 1,
        target: draft.target,
        corpusFingerprint: draft.corpusFingerprint,
        coverage: {
          discovered: 2, captured: 2, eligible: 2, used: 0, missing: 0, failed: 0,
        },
      };
      expect(first).toEqual({ ...expected, digest: sha256(canonicalJson(expected)) });
      expect(second).toEqual(first);
      expect(Object.keys(first).sort()).toEqual([
        "corpusFingerprint", "coverage", "digest", "jobId", "runId", "target", "version",
      ]);
      const serialized = JSON.stringify(first);
      for (const canary of [
        "first source", "second source", "shareable page context",
        "shareable resource context", "shareable relation note",
        "LOCAL_PAGE_CANARY", "LOCAL_RESOURCE_CANARY", "Compare the selected pages",
      ]) {
        expect(serialized).not.toContain(canary);
      }
      expect(database.connection.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("keeps invalid material out of execution while retaining its material-free audit", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      submitSelection(database.connection);
      database.connection.prepare(`
        INSERT INTO research_source_state_events (
          source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (1, 2, 'invalidated', 'invalid', 'content changed',
          'audit-invalid-source', ?)
      `).run(at);
      const reader = createResearchCorpusReader(database.connection);
      expect(() => reader.readForJob("resource_research:1")).toThrowError(
        expect.objectContaining({ code: "RESEARCH_CORPUS_MISMATCH" }),
      );
      expect(reader.readAuditForJob("resource_research:1").coverage).toEqual({
        discovered: 2, captured: 2, eligible: 2, used: 0, missing: 0, failed: 0,
      });
    } finally {
      database.close();
    }
  });

  it.each(["run", "source", "snapshot", "report"] as const)(
    "rejects a redacted %s from the material-free audit boundary",
    (variant) => {
      const database = openDatabase(":memory:");
      try {
        seedPages(database.connection);
        let jobId: "resource_research:1" | "resource_research:2" = "resource_research:1";
        if (variant === "report") {
          const parent = publishSelectionParent(database.connection);
          submitChildWithParent(database.connection, parent.reportId);
          jobId = "resource_research:2";
          createResearchStore(database.connection, { clock: () => new Date(at) }).redactResearch({
            target: { type: "report", reportId: parent.reportId },
            reason: "privacy request",
            idempotencyKey: "audit-redacted-report",
          });
        } else {
          submitSelection(database.connection, true);
          if (variant === "run") {
            database.connection.prepare(`
              INSERT INTO research_privacy_requests (
                idempotency_key, request_fingerprint, target_type, target_key, reason, created_at
              ) VALUES ('audit-redacted-run', ?, 'target', 'selection:redacted',
                'privacy request', ?)
            `).run("a".repeat(64), at);
            database.connection.prepare(`
              INSERT INTO research_privacy_run_bindings (idempotency_key, run_id)
              VALUES ('audit-redacted-run', 1)
            `).run();
          } else if (variant === "source") {
            database.connection.prepare(`
              INSERT INTO research_source_state_events (
                source_id, sequence_no, event_type, state, reason,
                idempotency_key, occurred_at
              ) VALUES (1, 2, 'redacted', 'redacted', 'privacy request',
                'audit-redacted-source', ?)
            `).run(at);
          } else {
            const snapshot = database.connection.prepare(`
              SELECT kind, snapshot_id FROM research_snapshot_heads
              ORDER BY kind, snapshot_id LIMIT 1
            `).get() as { kind: string; snapshot_id: number };
            database.connection.prepare(`
              INSERT INTO research_snapshot_state_events (
                kind, snapshot_id, sequence_no, event_type, state, reason,
                idempotency_key, occurred_at
              ) VALUES (?, ?, 2, 'redacted', 'redacted', 'privacy request',
                'audit-redacted-snapshot', ?)
            `).run(snapshot.kind, snapshot.snapshot_id, at);
          }
        }
        expect(() => createResearchCorpusReader(database.connection).readAuditForJob(jobId))
          .toThrowError(expect.objectContaining({ code: "RESEARCH_REDACTION_REQUIRED" }));
      } finally {
        database.close();
      }
    },
  );

  it("fails closed when an included source payload is missing without a privacy receipt", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      submitSelection(database.connection);
      database.connection.exec(`
        DROP TRIGGER research_source_payloads_redaction_guard;
        DELETE FROM research_source_payloads WHERE source_id = 1;
      `);

      expect(() => createResearchCorpusReader(database.connection)
        .readForJob("resource_research:1")).toThrowError(expect.objectContaining({
          code: "RESEARCH_CORPUS_MISMATCH",
        }));
    } finally {
      database.close();
    }
  });

  it("requires the privacy lifecycle after approved corpus material is redacted", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      submitSelection(database.connection, true);
      createResearchStore(database.connection, { clock: () => new Date(at) }).redactResearch({
        target: { type: "source", sourceId: 1 },
        reason: "Forget approved source",
        idempotencyKey: "forget-corpus-source-1",
      });

      expect(() => createResearchCorpusReader(database.connection)
        .readForJob("resource_research:1")).toThrowError(expect.objectContaining({
          code: "RESEARCH_REDACTION_REQUIRED",
        }));
    } finally {
      database.close();
    }
  });

  it("lets a durable privacy fence dominate still-present corpus material", () => {
    const database = openDatabase(":memory:");
    try {
      seedPages(database.connection);
      submitSelection(database.connection);
      database.connection.prepare(`
        INSERT INTO research_privacy_requests (
          idempotency_key, request_fingerprint, target_type, target_key, reason, created_at
        ) VALUES (?, ?, 'source', '1', 'Interrupted privacy phase', ?)
      `).run("fence-corpus-before-delete", "a".repeat(64), at);
      database.connection.prepare(`
        INSERT INTO research_privacy_run_bindings (idempotency_key, run_id)
        VALUES ('fence-corpus-before-delete', 1)
      `).run();
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_source_payloads
      `).pluck().get()).toBe(2);

      expect(() => createResearchCorpusReader(database.connection)
        .readForJob("resource_research:1")).toThrowError(expect.objectContaining({
          code: "RESEARCH_REDACTION_REQUIRED",
        }));
    } finally {
      database.close();
    }
  });

  it("rejects invalid source state and recomputed approval/corpus fingerprint mismatches", () => {
    const invalidState = openDatabase(":memory:");
    const mismatchedApproval = openDatabase(":memory:");
    const mismatchedCorpus = openDatabase(":memory:");
    try {
      seedPages(invalidState.connection);
      seedPages(mismatchedApproval.connection);
      seedPages(mismatchedCorpus.connection);
      submitSelection(invalidState.connection);
      submitSelection(mismatchedApproval.connection);
      submitSelection(mismatchedCorpus.connection);
      invalidState.connection.prepare(`
        INSERT INTO research_source_state_events (
          source_id, sequence_no, event_type, state, reason, idempotency_key, occurred_at
        ) VALUES (1, 2, 'invalidated', 'invalid', 'content changed',
          'invalidate-corpus-source-1', ?)
      `).run(at);
      mismatchedApproval.connection.exec(`
        DROP TRIGGER research_runs_immutable_update;
        DROP TRIGGER research_run_payloads_immutable_update;
        UPDATE research_run_payloads SET question = 'tampered question' WHERE run_id = 1;
        UPDATE research_runs SET question_digest = '${sha256("tampered question")}' WHERE id = 1;
      `);
      mismatchedCorpus.connection.exec(`
        DROP TRIGGER research_runs_immutable_update;
        UPDATE research_runs SET corpus_fingerprint = '${"f".repeat(64)}' WHERE id = 1;
      `);

      for (const connection of [
        invalidState.connection, mismatchedApproval.connection, mismatchedCorpus.connection,
      ]) {
        expect(() => createResearchCorpusReader(connection)
          .readForJob("resource_research:1")).toThrowError(expect.objectContaining({
            code: "RESEARCH_CORPUS_MISMATCH",
          }));
      }
    } finally {
      invalidState.close();
      mismatchedApproval.close();
      mismatchedCorpus.close();
    }
  });

  it("batch-reads a complete approved corpus in four SQL statements", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-research-corpus-"));
    const databasePath = join(directory, "corpus.sqlite");
    const fixture = openDatabase(databasePath);
    try {
      seedPages(fixture.connection, { localOnly: true });
      submitSelection(fixture.connection, true);
    } finally {
      fixture.close();
    }

    const statements: string[] = [];
    const measured = new Database(databasePath, {
      verbose: (statement) => statements.push(String(statement)),
    });
    try {
      const reader = createResearchCorpusReader(measured);
      statements.length = 0;
      expect(reader.readForJob("resource_research:1").snapshots).toHaveLength(4);
      expect(statements).toHaveLength(6);
      expect(statements.filter((statement) => /^\s*(SELECT|WITH)\b/i.test(statement)))
        .toHaveLength(4);
      expect(statements[0]).toMatch(/^\s*BEGIN\b/i);
      expect(statements.at(-1)).toMatch(/^\s*COMMIT\b/i);
    } finally {
      measured.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads parent-aware execution and material-free audit projections in five selects", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-research-parent-corpus-"));
    const databasePath = join(directory, "corpus.sqlite");
    const fixture = openDatabase(databasePath);
    try {
      seedPages(fixture.connection);
      const parent = publishSelectionParent(fixture.connection);
      submitChildWithParent(fixture.connection, parent.reportId);
    } finally {
      fixture.close();
    }

    const statements: string[] = [];
    const measured = new Database(databasePath, {
      verbose: (statement) => statements.push(String(statement)),
    });
    try {
      const reader = createResearchCorpusReader(measured);
      statements.length = 0;
      expect(reader.readForJob("resource_research:2").parent?.reportId).toBe(1);
      expect(statements.filter((statement) => /^\s*(SELECT|WITH)\b/i.test(statement)))
        .toHaveLength(5);
      expect(statements).toHaveLength(7);

      statements.length = 0;
      expect(reader.readAuditForJob("resource_research:2").runId).toBe(2);
      expect(statements.filter((statement) => /^\s*(SELECT|WITH)\b/i.test(statement)))
        .toHaveLength(5);
      expect(statements).toHaveLength(7);
    } finally {
      measured.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes corpus materialization before a concurrent WAL privacy redaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-research-corpus-race-"));
    const databasePath = join(directory, "corpus.sqlite");
    const fixture = openDatabase(databasePath);
    try {
      seedPages(fixture.connection);
      submitSelection(fixture.connection);
    } finally {
      fixture.close();
    }

    const writer = openDatabase(databasePath);
    writer.connection.pragma("busy_timeout = 0");
    const privacy = createResearchStore(writer.connection, { clock: () => new Date(at) });
    let selected = 0;
    let blocked: unknown;
    const readerConnection = new Database(databasePath, {
      verbose(statement) {
        if (!/^\s*(SELECT|WITH)\b/i.test(String(statement))) return;
        selected += 1;
        if (selected !== 4) return;
        try {
          privacy.redactResearch({
            target: { type: "source", sourceId: 1 },
            reason: "Concurrent privacy request",
            idempotencyKey: "concurrent-corpus-redaction",
          });
        } catch (error) {
          blocked = error;
        }
      },
    });
    try {
      readerConnection.pragma("journal_mode = WAL");
      const corpus = createResearchCorpusReader(readerConnection)
        .readForJob("resource_research:1");
      expect(corpus.sources[0]?.payload.evidenceMaterial).toBe("second source");
      expect(blocked).toMatchObject({ code: "SQLITE_BUSY" });
      expect(writer.connection.prepare(`
        SELECT COUNT(*) FROM research_privacy_requests
      `).pluck().get()).toBe(0);

      selected = 0;
      blocked = undefined;
      const audit = createResearchCorpusReader(readerConnection)
        .readAuditForJob("resource_research:1");
      expect(audit.coverage).toEqual({
        discovered: 2, captured: 2, eligible: 2, used: 0, missing: 0, failed: 0,
      });
      expect(blocked).toMatchObject({ code: "SQLITE_BUSY" });
      expect(writer.connection.prepare(`
        SELECT COUNT(*) FROM research_privacy_requests
      `).pluck().get()).toBe(0);

      expect(privacy.redactResearch({
        target: { type: "source", sourceId: 1 },
        reason: "Concurrent privacy request",
        idempotencyKey: "concurrent-corpus-redaction",
      })).toMatchObject({ sources: 1, runs: 1 });
      expect(() => createResearchCorpusReader(writer.connection)
        .readForJob("resource_research:1")).toThrowError(expect.objectContaining({
          code: "RESEARCH_REDACTION_REQUIRED",
        }));
    } finally {
      readerConnection.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
