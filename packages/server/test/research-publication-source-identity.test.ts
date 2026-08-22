import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { ResearchPublicationDraft } from "@tabhub/shared";

import {
  assertResearchPublicationSourceIdentity,
  createResearchStore,
  type ResearchPublicationSourceIdentity,
} from "../src/research-store.js";
import { createAiJobLedger } from "../src/ai-job-ledger.js";
import { openDatabase } from "../src/database.js";
import { createResearchCorpusReader } from "../src/research-corpus.js";
import {
  liveResearchFixtureCompletedAt,
  liveResearchFixtureEvidence,
  seedReceiptBackedLiveResearchRun,
} from "./live-research-fixture.js";

const DIGEST = "a".repeat(64);
const EXTRACTED_AT = "2026-08-14T12:00:00.000Z";

function liveSource(): ResearchPublicationSourceIdentity {
  return {
    sourceId: 31,
    runId: 17,
    ordinal: 2,
    logicalPageId: 41,
    tabId: null,
    capturedTabIdSnapshot: null,
    contentRevision: 1,
    contentDigest: DIGEST,
    extractedAt: EXTRACTED_AT,
    sourceKind: "live_acquisition",
    acquisitionMethod: "safe_public_http_v1",
    handoffSourceReceiptId: 71,
    accessClass: "public",
    eligibility: "eligible",
    inclusionState: "included",
    includedOrder: 2,
  };
}

describe("research publication source identity", () => {
  it("publishes a live source only against its immutable terminal handoff identity", () => {
    const identity = {
      kind: "live_acquisition" as const,
      handoffSourceReceiptId: 71,
      receiptDigest: "b".repeat(64),
      finalRunId: 17,
      ordinal: 2,
      logicalPageId: 41,
      logicalPageGenerationId: 61,
      logicalPageGenerationToken: "c".repeat(64),
      targetGenerationLogicalPageId: 41,
      contentRevision: 1 as const,
      contentDigest: DIGEST,
      extractedAt: EXTRACTED_AT,
      payloadDigest: DIGEST,
      inclusionState: "included" as const,
      includedOrder: 2,
      targetGenerationActive: true as const,
      handoffStatus: "completed" as const,
      handoffCompletedAt: EXTRACTED_AT,
      terminalCompletedAt: EXTRACTED_AT,
      handoffTerminal: true as const,
    };
    expect(() => assertResearchPublicationSourceIdentity(liveSource(), identity))
      .not.toThrow();
    expect(() => assertResearchPublicationSourceIdentity(liveSource(), {
      ...identity,
      handoffSourceReceiptId: 72,
    })).toThrow("Used live research source changed");
    expect(() => assertResearchPublicationSourceIdentity(liveSource(), {
      ...identity,
      ordinal: 3,
    })).toThrow("Used live research source changed");
    expect(() => assertResearchPublicationSourceIdentity(liveSource(), {
      ...identity,
      targetGenerationLogicalPageId: 42,
    })).toThrow("Used live research source changed");
    expect(() => assertResearchPublicationSourceIdentity(liveSource(), {
      ...identity,
      terminalCompletedAt: "2026-08-14T12:00:01.000Z",
    })).toThrow("Used live research source changed");
  });

  it("keeps captured publication bound to current tab content", () => {
    const source: ResearchPublicationSourceIdentity = {
      ...liveSource(),
      sourceKind: "captured",
      acquisitionMethod: "captured",
      tabId: 51,
      capturedTabIdSnapshot: 51,
      handoffSourceReceiptId: null,
    };
    expect(() => assertResearchPublicationSourceIdentity(source, {
      logicalPageId: 41,
      contentRevision: 1,
      contentDigest: DIGEST,
    })).not.toThrow();
    expect(() => assertResearchPublicationSourceIdentity(source, undefined))
      .toThrow("Used research source changed");
  });

  it("publishes a tabless C81 report only from the exact terminal receipt graph", () => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(EXTRACTED_AT),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      const research = createResearchStore(database.connection, {
        clock: () => new Date(liveResearchFixtureCompletedAt),
      });
      const ledger = createAiJobLedger(database.connection, {
        clock: () => new Date(liveResearchFixtureCompletedAt),
        token: () => "live-publication-lease-token-0001",
        kindAvailable: () => true,
        research,
      });
      const claim = ledger.claimNext("resource_research", "live-publication-worker", {
        maxConcurrent: 1, maxAttemptsPerUtcDay: 10, maxCostUsdPerUtcDay: 2,
      }, undefined, [{ id: "research_workflow:c81:v1", version: 1 }]);
      if (claim === undefined) throw new Error("Expected final C81 claim");
      const corpus = createResearchCorpusReader(database.connection)
        .readForJob(`resource_research:${fixture.finalJobId}`);
      const checkpointDigests = {
        corpusDigest: corpus.corpusDigest,
        parentDigest: null,
        providerInputDigest: "1".repeat(64),
        quoteDigest: "2".repeat(64),
      } as const;
      const usage = {
        steps: 1, inputTokens: 10, outputTokens: 10, costUsd: 0.01, wallTimeMs: 100,
      } as const;
      ledger.checkpoint(claim, {
        progress: { completed: 0, total: 1, stage: "claimed" },
        checkpoint: { version: 1, nextStep: 0, stage: "claimed" },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      });
      ledger.checkpoint(claim, {
        progress: { completed: 0, total: 1, stage: "provider_ready" },
        checkpoint: { version: 1, nextStep: 1, stage: "provider_ready", ...checkpointDigests },
        usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, wallTimeMs: 0 },
      });
      ledger.bindAttemptProvider(claim, {
        provider: "fixture-provider", model: "fixture-model",
        promptVersion: "fixture-v1", pricingVersion: "fixture-pricing-v1",
      });
      ledger.recordAttemptRequest(claim, "fixture-request");
      const publication: ResearchPublicationDraft = {
        version: 1,
        status: "succeeded",
        reason: null,
        corpusFingerprint: fixture.draft.corpusFingerprint,
        inputFingerprint: fixture.draft.approvalFingerprint,
        coverage: {
          discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0,
        },
        usedSourceIds: [fixture.sourceId],
        provenance: {
          provider: "fixture-provider",
          model: "fixture-model",
          promptVersion: "fixture-v1",
          pricingVersion: "fixture-pricing-v1",
          requestId: "fixture-request",
          generatedAt: liveResearchFixtureCompletedAt,
          usage,
        },
        dossier: {
          executiveSummary: "Receipt-backed live evidence",
          valueForUser: "The acquired public source is usable.",
          capabilities: [], limitations: [], risks: [], unknowns: [], nextSteps: [],
        },
        claims: [{
          claim: "The live source contains receipt-backed public evidence.",
          confidence: 1,
          isInference: false,
          rationale: null,
          evidence: [{
            kind: "tab_content",
            sourceId: fixture.sourceId,
            locator: {
              version: "utf8_range:v1",
              byteStart: 0,
              byteEnd: Buffer.byteLength(liveResearchFixtureEvidence, "utf8"),
            },
            excerptHash: createHash("sha256")
              .update(liveResearchFixtureEvidence, "utf8").digest("hex"),
          }],
        }],
      };
      ledger.completeResearch(claim, {
        progress: { completed: 1, total: 1, stage: "terminal_publication" },
        checkpoint: {
          version: 1, nextStep: 2, stage: "terminal_publication", ...checkpointDigests,
          providerOutputDigest: "3".repeat(64),
        },
        usage,
      }, publication);

      expect(database.connection.prepare(
        "SELECT COUNT(*) FROM research_reports WHERE run_id = ?",
      ).pluck().get(fixture.finalRunId)).toBe(1);
      expect(database.connection.prepare("SELECT COUNT(*) FROM tabs").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([
    ["source receipt tuple", (connection: ReturnType<typeof openDatabase>["connection"]) => {
      connection.exec("DROP TRIGGER live_acquisition_source_receipts_immutable_update");
      connection.prepare("UPDATE live_acquisition_source_receipts SET ordinal = 2 WHERE id = 1")
        .run();
    }],
    ["logical-page generation", (connection: ReturnType<typeof openDatabase>["connection"]) => {
      connection.exec("DROP TRIGGER live_acquisition_source_receipts_immutable_update");
      connection.prepare(`
        UPDATE live_acquisition_source_receipts
        SET logical_page_generation_id = (
          SELECT id FROM privacy_subject_generations
          WHERE subject_kind = 'resource' AND resource_id = 7001 AND is_active = 1
        ) WHERE id = 1
      `).run();
    }],
    ["terminal handoff time", (connection: ReturnType<typeof openDatabase>["connection"]) => {
      connection.exec("DROP TRIGGER live_acquisition_handoffs_validate_update");
      connection.prepare(`
        UPDATE live_acquisition_handoffs
        SET completed_at = '2026-08-14T12:00:02.000Z' WHERE id = 1
      `).run();
    }],
  ] as const)("rejects publication after %s drift", (_label, corrupt) => {
    const database = openDatabase(":memory:", {
      migrationClock: () => new Date(EXTRACTED_AT),
    });
    try {
      const fixture = seedReceiptBackedLiveResearchRun(database.connection);
      corrupt(database.connection);
      const research = createResearchStore(database.connection, {
        clock: () => new Date(liveResearchFixtureCompletedAt),
      });
      expect(() => research.publish(fixture.finalJobId, {
        version: 1,
        status: "succeeded",
        reason: null,
        corpusFingerprint: fixture.draft.corpusFingerprint,
        inputFingerprint: fixture.draft.approvalFingerprint,
        coverage: {
          discovered: 1, captured: 1, eligible: 1, used: 1, missing: 0, failed: 0,
        },
        usedSourceIds: [fixture.sourceId],
        provenance: {
          provider: "fixture-provider", model: "fixture-model", promptVersion: "fixture-v1",
          pricingVersion: "fixture-pricing-v1", requestId: null,
          generatedAt: liveResearchFixtureCompletedAt,
          usage: { steps: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01,
            wallTimeMs: 1 },
        },
        dossier: { executiveSummary: "x", valueForUser: "x", capabilities: [],
          limitations: [], risks: [], unknowns: [], nextSteps: [] },
        claims: [{
          claim: "x", confidence: 1, isInference: false, rationale: null,
          evidence: [{ kind: "tab_content", sourceId: fixture.sourceId,
            locator: { version: "utf8_range:v1", byteStart: 0,
              byteEnd: Buffer.byteLength(liveResearchFixtureEvidence, "utf8") },
            excerptHash: createHash("sha256").update(liveResearchFixtureEvidence).digest("hex") }],
        }],
      }, liveResearchFixtureCompletedAt)).toThrow("Used live research source changed");
      expect(database.connection.prepare("SELECT COUNT(*) FROM research_reports").pluck().get())
        .toBe(0);
    } finally {
      database.close();
    }
  });
});
