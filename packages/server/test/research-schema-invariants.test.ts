import { createHash } from "node:crypto";

import {
  estimateResearchReservationV1,
  researchSelectionFingerprintPayload,
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
  createResearchStore, fingerprintResearchApproval, fingerprintResearchCorpus,
} from "../src/research-store.js";

const at = "2026-08-13T15:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const budget = { maxSteps: 10, maxTokens: 1000, maxCostUsd: 1, maxWallTimeMs: 60_000 };
const limits = { maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2 };

function dossier(summary: string) {
  return {
    executiveSummary: summary, valueForUser: summary,
    capabilities: [] as string[], limitations: [] as string[], risks: [] as string[],
    unknowns: [] as string[], nextSteps: [] as string[],
  };
}

function publicationProvenance() {
  return {
    provider: "test", model: "test", promptVersion: "v1", pricingVersion: "test-v1",
    requestId: null, generatedAt: at,
    usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, wallTimeMs: 1 },
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
    usage: publicationProvenance().usage,
  };
}

function preparePublication(ledger: AiJobLedger, claim: AiJobClaim): void {
  ledger.checkpoint(claim, claimedCheckpoint());
  ledger.checkpoint(claim, providerReadyCheckpoint());
}

function persistedCorpus(
  connection: ReturnType<typeof openDatabase>["connection"],
  runId = 1,
): string {
  return connection.prepare(`
    SELECT corpus_fingerprint FROM research_runs WHERE id = ?
  `).pluck().get(runId) as string;
}

function seed(connection: ReturnType<typeof openDatabase>["connection"]): void {
  connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (1, 'https://r.openai.com/1', 'https://r.openai.com/1', 'https://r.openai.com/1', '${at}', '${at}'),
      (2, 'https://r.openai.com/2', 'https://r.openai.com/2', 'https://r.openai.com/2', '${at}', '${at}');
    INSERT INTO tabs (
      id, url, url_normalized, title, browser, status, importance, is_open,
      first_seen_at, last_seen_at, logical_page_id
    ) VALUES
      (11, 'https://r.openai.com/1', 'https://r.openai.com/1', 'One', 'chrome', 'inbox', 0, 1,
        '${at}', '${at}', 1),
      (22, 'https://r.openai.com/2', 'https://r.openai.com/2', 'Two', 'chrome', 'inbox', 0, 1,
        '${at}', '${at}', 2);
    INSERT INTO contents (tab_id, text, extracted_at, content_revision) VALUES
      (11, 'one evidence', '${at}', 1),
      (22, 'two evidence', '${at}', 1);
  `);
}

function pageTask(page = 1, key = `page-${page}`): ResourceResearchTaskSpec {
  return {
    version: 1,
    kind: "resource_research",
    subject: { type: "page", logicalPageId: page },
    workflowRef: { id: "captured-only", version: 1 },
    inputFingerprint: pageDraft(page).approvalFingerprint,
    idempotencyKey: key,
    provenance: { requestedBy: "user", requestMethod: "manual" },
    schedulingPriority: 0,
    budget,
  };
}

function pageDraft(
  page = 1,
  text = page === 1 ? "one evidence" : "two evidence",
  contentRevision = 1,
) {
  const tabId = page === 1 ? 11 : 22;
  const draft = {
    version: 1 as const,
    target: { type: "page" as const, logicalPageId: page },
    question: "What matters?",
    scope: {
      acquisitionLevel: "captured_only" as const,
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    corpusFingerprint: "0".repeat(64),
    workflowRef: { id: "captured-only", version: 1 },
    budget,
    estimate: estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Buffer.byteLength(text, "utf8"),
      snapshotBytes: 0,
      questionBytes: Buffer.byteLength("What matters?", "utf8"),
      budget,
    }),
    sources: [{
      ordinal: 1,
      logicalPageId: page,
      tabId,
      contentRevision,
      contentDigest: hash(text),
      extractedAt: at,
      acquisitionMethod: "captured" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      payload: {
        url: `https://r.openai.com/${page}`,
        title: page === 1 ? "One" : "Two",
        evidenceMaterial: text,
        chunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: Buffer.byteLength(text, "utf8"),
          chunkDigest: hash(text),
          truncated: false,
        },
      },
    }],
  };
  const withApproval = { ...draft, approvalFingerprint: fingerprintResearchApproval(draft) };
  return { ...withApproval, corpusFingerprint: fingerprintResearchCorpus(withApproval) };
}

function pageApproval(page = 1) {
  const draft = pageDraft(page);
  return {
    version: draft.version, target: draft.target, question: draft.question, scope: draft.scope,
    parentReportId: draft.parentReportId, approvalFingerprint: draft.approvalFingerprint,
    workflowRef: draft.workflowRef, budget: draft.budget, estimate: draft.estimate,
    captureIntent: { selectedTabIds: [], knownFailures: [] },
  };
}

describe("research schema/store negative invariants", () => {
  it("rejects a split UTF-8 locator and accepts the exact multibyte byte range", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const text = "évidence";
    database.connection.prepare(`
      UPDATE contents SET text = ?, content_revision = 2 WHERE tab_id = 11
    `).run(text);
    const draft = pageDraft(1, text, 2);
    const task: ResourceResearchTaskSpec = {
      version: 1, kind: "resource_research", subject: draft.target,
      workflowRef: draft.workflowRef, inputFingerprint: draft.approvalFingerprint,
      idempotencyKey: "utf8-range", provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0, budget,
    };
    const approval = {
      version: draft.version, target: draft.target, question: draft.question, scope: draft.scope,
      parentReportId: draft.parentReportId, approvalFingerprint: draft.approvalFingerprint,
      workflowRef: draft.workflowRef, budget: draft.budget, estimate: draft.estimate,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
    };
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true, clock: () => new Date(at),
      token: () => "utf8-range-lease-token", research,
    });
    try {
      ledger.submitResearch(task, approval);
      const claim = ledger.claimNext("resource_research", "utf8-worker", limits)!;
      preparePublication(ledger, claim);
      ledger.bindAttemptProvider(claim, {
        provider: "test", model: "test", promptVersion: "v1", pricingVersion: "test-v1",
      });
      const sourceId = database.connection.prepare(`SELECT id FROM research_sources`).pluck()
        .get() as number;
      const publication = {
        version: 1 as const, status: "succeeded" as const,
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: draft.approvalFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [sourceId], provenance: publicationProvenance(),
        dossier: dossier("UTF-8 evidence"),
        claims: [{ claim: "Multibyte evidence", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content" as const, sourceId,
            locator: { version: "utf8_range:v1" as const, byteStart: 1, byteEnd: 2 },
            excerptHash: "f".repeat(64) }] }],
      };
      expect(() => ledger.completeResearch(claim, terminalCheckpoint(), publication))
        .toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`).pluck().get())
        .toBe(0);
      expect(ledger.completeResearch(claim, terminalCheckpoint(), {
        ...publication,
        claims: [{ ...publication.claims[0]!, evidence: [{
          kind: "tab_content", sourceId,
          locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 2 },
          excerptHash: hash("é"),
        }] }],
      })).toMatchObject({ status: "succeeded", result: { type: "resource_research" } });
    } finally {
      database.close();
    }
  });

  it("fails closed without a registered schema-24 research adapter and writes nothing", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "no-adapter-token-0001",
    });
    try {
      expect(() => ledger.submit(pageTask())).toThrowError(expect.objectContaining({
        code: "INVALID_JOB_TRANSITION",
      }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ai_jobs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_runs`).pluck().get())
        .toBe(0);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM ai_job_idempotency_receipts
      `).pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("refuses schema-24 claims whose queued research job has no bound run", () => {
    const database = openDatabase(":memory:", { maximumMigrationVersion: 24 });
    seed(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true, clock: () => new Date(at),
      token: () => "unbound-claim-token", research,
    });
    try {
      const task = pageTask();
      database.connection.pragma("foreign_keys = OFF");
      database.connection.exec(`
        PRAGMA ignore_check_constraints = ON;
        INSERT INTO ai_jobs (
          kind, subject_type, logical_page_id, subject_key, requested_by, request_method,
          idempotency_key, submission_fingerprint, input_fingerprint, workflow_id,
          workflow_version, scheduling_priority, progress_total, max_steps, max_tokens,
          max_cost_usd, max_wall_time_ms, available_at, created_at, updated_at
        ) VALUES (
          'resource_research', 'page', 1, 'page:1', 'user', 'manual',
          'orphan-claim-job', '${"0".repeat(64)}', '${task.inputFingerprint}',
          'captured-only', 1, 0, 1, 10, 1000, 1, 60000, '${at}', '${at}', '${at}'
        );
        PRAGMA ignore_check_constraints = OFF;
      `);
      database.connection.pragma("foreign_keys = ON");
      const before = database.connection.prepare(`SELECT total_changes()`).pluck().get();
      expect(() => ledger.claimNext("resource_research", "orphan-worker", limits))
        .toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
      expect(database.connection.prepare(`SELECT total_changes()`).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("keeps typed snapshot identities immutable around polymorphic payloads", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "snapshot-identity-token-0001",
      research,
    });
    try {
      ledger.submitResearch(pageTask(), pageApproval());
      const expectedTriggers = [
        "research_page_context_snapshots_immutable_update",
        "research_page_context_snapshots_immutable_delete",
        "research_resource_context_snapshots_immutable_update",
        "research_resource_context_snapshots_immutable_delete",
        "research_activity_snapshots_immutable_update",
        "research_activity_snapshots_immutable_delete",
        "research_relation_snapshots_immutable_update",
        "research_relation_snapshots_immutable_delete",
      ];
      const triggers = database.connection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'research_%_snapshots_immutable_%'
        ORDER BY name
      `).pluck().all() as string[];
      expect(triggers).toEqual(expect.arrayContaining(expectedTriggers));

      database.connection.exec(`
        INSERT INTO logical_page_activity_daily (
          logical_page_id, activity_date, foreground_ms, engaged_ms, updated_at
        ) VALUES (1, '2026-08-13', 1000, 500, '${at}');
        INSERT INTO research_activity_snapshots (
          id, run_id, logical_page_audit_id, activity_date_audit,
          logical_page_id, activity_date, snapshot_digest, created_at
        ) VALUES (91, 1, 1, '2026-08-13', 1, '2026-08-13', '${"9".repeat(64)}', '${at}');
        INSERT INTO research_snapshot_state_events (
          kind, snapshot_id, sequence_no, event_type, state,
          reason, idempotency_key, occurred_at
        ) VALUES (
          'activity', 91, 1, 'accepted', 'valid', NULL,
          'snapshot-accepted-91', '${at}'
        );
        INSERT INTO research_snapshot_payloads (kind, snapshot_id, material_json)
        VALUES ('activity', 91, '{"foregroundMs":1000,"engagedMs":500}');
      `);
      expect(() => database.connection.prepare(`
        UPDATE research_activity_snapshots SET snapshot_digest = ? WHERE id = 91
      `).run("8".repeat(64))).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        DELETE FROM research_activity_snapshots WHERE id = 91
      `).run()).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        UPDATE research_snapshot_payloads SET material_json = '{}'
        WHERE kind = 'activity' AND snapshot_id = 91
      `).run()).toThrow(/immutable/i);

      database.connection.prepare(`
        INSERT INTO research_snapshot_state_events (
          kind, snapshot_id, sequence_no, event_type, state,
          reason, idempotency_key, occurred_at
        ) VALUES (
          'activity', 91, 2, 'invalidated', 'invalid',
          'parent changed', 'snapshot-invalidated-91', ?
        )
      `).run(at);
      database.connection.prepare(`
        INSERT INTO research_snapshot_state_events (
          kind, snapshot_id, sequence_no, event_type, state,
          reason, idempotency_key, occurred_at
        ) VALUES (
          'activity', 91, 3, 'redacted', 'redacted',
          'privacy request', 'snapshot-redacted-91', ?
        )
      `).run(at);
      database.connection.prepare(`
        DELETE FROM research_snapshot_payloads
        WHERE kind = 'activity' AND snapshot_id = 91
      `).run();
      database.connection.prepare(`
        DELETE FROM logical_page_activity_daily
        WHERE logical_page_id = 1 AND activity_date = '2026-08-13'
      `).run();
      expect(() => database.connection.prepare(`
        DELETE FROM research_activity_snapshots WHERE id = 91
      `).run()).toThrow(/immutable/i);
      expect(() => database.connection.prepare(`
        DELETE FROM research_snapshot_state_events
        WHERE kind = 'activity' AND snapshot_id = 91
      `).run()).toThrow(/append-only/i);
      expect(database.connection.prepare(`
        SELECT logical_page_audit_id, activity_date_audit, logical_page_id, activity_date
        FROM research_activity_snapshots WHERE id = 91
      `).get()).toEqual({
        logical_page_audit_id: 1, activity_date_audit: "2026-08-13",
        logical_page_id: null, activity_date: null,
      });
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM research_snapshot_payloads
        WHERE kind = 'activity' AND snapshot_id = 91
      `).pluck().get()).toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces target XOR and selection cardinality/canonical fingerprint", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "bare-research-token-0001",
      research,
    });
    try {
      ledger.submitResearch(pageTask(), pageApproval());
      const canonical = hash(researchSelectionFingerprintPayload([2, 1]));
      const cloned = database.connection.prepare(`SELECT * FROM ai_jobs WHERE id = 1`).get() as
        Record<string, unknown>;
      const clonedApproval = cloned.input_fingerprint as string;
      delete cloned.id;
      Object.assign(cloned, {
        subject_type: "selection",
        logical_page_id: null,
        selection_fingerprint: canonical,
        subject_key: `selection:${canonical}`,
        idempotency_key: "selection-raw-job",
        event_sequence: 0,
        progress_total: null,
      });
      const columns = Object.keys(cloned);
      database.connection.prepare(`
        INSERT INTO ai_jobs (${columns.join(",")})
        VALUES (${columns.map((column) => `@${column}`).join(",")})
      `).run(cloned);
      const insert = database.connection.prepare(`
        INSERT INTO research_runs (
          job_id, target_logical_page_id, target_resource_id, target_selection,
          selection_fingerprint, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, parent_report_id,
          max_steps, max_tokens, max_cost_usd, max_wall_time_ms, created_at
        ) VALUES (
          2, @page, @resource, @selection, @selectionFingerprint, @targetKey,
          @questionDigest, '{}', @approval, @corpus, @submission,
          'captured-only', 1, NULL, 10, 1000, 1, 60000, @createdAt
        )
      `);
      expect(() => insert.run({
        page: 1, resource: 1, selection: 0, selectionFingerprint: null,
        targetKey: "page:1", approval: "a".repeat(64), corpus: "c".repeat(64),
        submission: "d".repeat(64), questionDigest: "e".repeat(64), createdAt: at,
      })).toThrow();
      expect(researchSelectionFingerprintPayload([2, 1]))
        .toBe(researchSelectionFingerprintPayload([1, 2]));
      expect(canonical).toMatch(/^[0-9a-f]{64}$/);
      database.connection.prepare(`
        INSERT INTO research_runs (
          job_id, target_logical_page_id, target_resource_id, target_selection,
          selection_fingerprint, target_key, question_digest, scope_json,
          approval_fingerprint, corpus_fingerprint, submission_fingerprint,
          workflow_id, workflow_version, max_steps, max_tokens, max_cost_usd,
          max_wall_time_ms, created_at
        ) VALUES (2, NULL, NULL, 1, ?, ?, ?, '{}', ?, ?, ?,
          'captured-only', 1, 10, 1000, 1, 60000, ?)
      `).run(canonical, `selection:${canonical}`, "e".repeat(64), clonedApproval,
        "c".repeat(64), "d".repeat(64), at);
      expect(() => database.connection.prepare(`
        INSERT INTO research_run_selection_pages (run_id, logical_page_id, selection_order)
        VALUES (1, 1, 1)
      `).run()).toThrow(/selection.*target/i);
      database.connection.prepare(`
        INSERT INTO research_run_selection_pages (run_id, logical_page_id, selection_order)
        VALUES (2, 1, 1)
      `).run();
      expect(() => database.connection.prepare(`
        INSERT INTO research_run_selection_pages (run_id, logical_page_id, selection_order)
        VALUES (2, 1, 2)
      `).run()).toThrow();
      expect(() => database.connection.prepare(`
        INSERT INTO research_run_selection_pages (run_id, logical_page_id, selection_order)
        VALUES (2, 2, 101)
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects duplicate/mismatched sources and cross-run evidence", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "typed-research-token-0001",
      research,
    });
    try {
      ledger.submitResearch(pageTask(1), pageApproval(1));
      ledger.cancel("resource_research", 1);
      ledger.submitResearch(pageTask(2), pageApproval(2));
      const source1 = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1
      `).pluck().get() as number;
      const source2 = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 2
      `).pluck().get() as number;
      expect(source2).not.toBe(source1);
      expect(() => database.connection.prepare(`
        INSERT INTO research_sources (
          run_id, ordinal, logical_page_id, tab_id, captured_tab_id_snapshot,
          content_revision, content_digest, extracted_at, acquisition_method,
          access_class_snapshot, eligibility, inclusion_state, included_order, created_at
        ) VALUES (2, 2, 1, 22, 22, 1, ?, ?, 'captured', 'public',
          'eligible', 'included', 2, ?)
      `).run(hash("two evidence"), at, at)).toThrow();
      const fkRows = database.connection.prepare(`
        SELECT [table], [from], [to] FROM pragma_foreign_key_list('research_claim_evidence')
      `).all() as Array<{ table: string; from: string; to: string }>;
      expect(fkRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "research_sources", from: "source_id", to: "id" }),
        expect.objectContaining({ table: "research_sources", from: "run_id", to: "run_id" }),
        expect.objectContaining({ table: "research_claims", from: "claim_id", to: "id" }),
        expect.objectContaining({ table: "research_claims", from: "report_id", to: "report_id" }),
        expect.objectContaining({ table: "research_page_context_snapshots",
          from: "page_context_snapshot_id", to: "id" }),
        expect.objectContaining({ table: "research_resource_context_snapshots",
          from: "resource_context_snapshot_id", to: "id" }),
        expect.objectContaining({ table: "research_activity_snapshots",
          from: "activity_snapshot_id", to: "id" }),
        expect.objectContaining({ table: "research_relation_snapshots",
          from: "relation_snapshot_id", to: "id" }),
      ]));
      const claim = ledger.claimNext("resource_research", "cross-run-worker", limits)!;
      preparePublication(ledger, claim);
      ledger.bindAttemptProvider(claim, {
        provider: "test", model: "test", promptVersion: "v1", pricingVersion: "test-v1",
      });
      const basePublication = {
        version: 1 as const,
        status: "succeeded" as const,
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection, 2),
        inputFingerprint: pageTask(2).inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [source2],
        provenance: publicationProvenance(),
        dossier: dossier("report"),
      };
      const completionCheckpoint = terminalCheckpoint();
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        claims: [{ claim: "cross-run", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content", sourceId: source1,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 12 },
            excerptHash: hash("one evidence") }] }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        usedSourceIds: [],
        coverage: { ...basePublication.coverage, used: 0 },
        claims: [{ claim: "uncounted citation", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content", sourceId: source2,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 12 },
            excerptHash: hash("two evidence") }] }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        claims: [{ claim: "wrong hash", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content", sourceId: source2,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 12 },
            excerptHash: hash("forged evidence") }] }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        claims: [{ claim: "out of range", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content", sourceId: source2,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 13 },
            excerptHash: hash("two evidence") }] }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        claims: [],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(() => ledger.completeResearch(claim, completionCheckpoint, {
        ...basePublication,
        claims: [{ claim: "orphan", confidence: 1, isInference: false,
          rationale: null, evidence: [] }],
      })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`).pluck().get())
        .toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back stale corpus, orphan claims, cross-connection adapter and divergent replay", () => {
    const database = openDatabase(":memory:");
    seed(database.connection);
    const research = createResearchStore(database.connection, { clock: () => new Date(at) });
    const ledger = createAiJobLedger(database.connection, {
      kindAvailable: () => true,
      clock: () => new Date(at),
      token: () => "negative-research-token-0001",
      research,
    });
    try {
      ledger.submitResearch(pageTask(1), pageApproval(1));
      const divergent = { ...pageApproval(1), question: "A different question" };
      expect(() => ledger.submitResearch(pageTask(1), divergent)).toThrowError(
        expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }),
      );
      const claim = ledger.claimNext("resource_research", "negative-worker", limits)!;
      preparePublication(ledger, claim);
      ledger.bindAttemptProvider(claim, {
        provider: "test", model: "test", promptVersion: "v1", pricingVersion: "test-v1",
      });
      const sourceId = database.connection.prepare(`
        SELECT id FROM research_sources WHERE run_id = 1
      `).pluck().get() as number;
      database.connection.prepare(`
        UPDATE contents SET text = 'changed', content_revision = 2 WHERE tab_id = 11
      `).run();
      const publication = {
        version: 1 as const,
        status: "succeeded" as const,
        reason: null,
        corpusFingerprint: persistedCorpus(database.connection),
        inputFingerprint: pageTask(1).inputFingerprint,
        coverage: { discovered: 1, captured: 1, eligible: 1, used: 1,
          missing: 0, failed: 0 },
        usedSourceIds: [sourceId],
        provenance: publicationProvenance(),
        dossier: dossier("report"),
        claims: [{ claim: "fact", confidence: 1, isInference: false,
          rationale: null, evidence: [{ kind: "tab_content" as const, sourceId,
            locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 12 },
            excerptHash: hash("one evidence") }] }],
      };
      expect(() => ledger.completeResearch(claim, terminalCheckpoint(), publication))
        .toThrowError(expect.objectContaining({ code: "JOB_INPUT_UNAVAILABLE" }));
      expect(database.connection.prepare(`SELECT COUNT(*) FROM research_reports`).pluck().get())
        .toBe(0);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);

      const other = openDatabase(":memory:");
      try {
        expect(() => createAiJobLedger(other.connection, {
          kindAvailable: () => true,
          research,
        })).toThrowError(expect.objectContaining({ code: "INVALID_JOB_INPUT" }));
      } finally {
        other.close();
      }
    } finally {
      database.close();
    }
  });
});
