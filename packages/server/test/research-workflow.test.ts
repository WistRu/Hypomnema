import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createResearchWorkflow,
  researchWorkflowRefV1,
  type ResearchCurrentProjection,
} from "../src/research-workflow.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const budget = {
  maxSteps: 8,
  maxTokens: 4_000,
  maxCostUsd: 0.5,
  maxWallTimeMs: 30_000,
};

function lifecycleDependencies() {
  return {
    cancelResearch: vi.fn(() => {
      throw new Error("Unexpected research cancellation");
    }),
    redactResearch: vi.fn(() => ({
      sources: 0,
      snapshots: 0,
      evidence: 0,
      reports: 0,
      runs: 0,
      cancelledJobs: 0,
    })),
  };
}

function capturedProjection(): ResearchCurrentProjection {
  const authenticatedOrigin = digest("https://auth.example");
  const draft = {
    version: 1 as const,
    target: { type: "page" as const, logicalPageId: 1 },
    question: "What is useful?",
    scope: {
      acquisitionLevel: "captured_only" as const,
      includeShareableContext: true,
      maxIncludedSources: 100,
      privacyConfirmation: {
        confirmed: true as const,
        authenticatedOriginDigests: [authenticatedOrigin],
        sensitiveOriginDigests: [],
      },
    },
    parentReportId: null,
    approvalFingerprint: "0".repeat(64),
    corpusFingerprint: digest("corpus"),
    workflowRef: researchWorkflowRefV1,
    budget,
    estimate: {
      estimateVersion: "research_estimate:v1" as const,
      estimateKind: "reservation_envelope" as const,
      calls: 1,
      inputTokens: 532,
      outputTokens: 1024,
      costUsd: 0.5,
      wallTimeMs: 30_000,
    },
    sources: [{
      sourceKind: "captured" as const,
      ordinal: 1,
      logicalPageId: 1,
      tabId: 11,
      selectedTabId: 11,
      contentRevision: 2,
      contentDigest: digest("captured material"),
      extractedAt: "2026-08-13T17:00:00.000Z",
      acquisitionMethod: "captured" as const,
      accessClass: "authenticated" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      handoffSourceReceiptId: null,
      handoffSourceReceiptDigest: null,
      payload: {
        url: "https://auth.example/private",
        title: "Secret title that must not escape",
        evidenceMaterial: "captured material",
        chunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: 17,
          chunkDigest: digest("captured material"),
          truncated: false,
        },
      },
    }],
    snapshots: [{
      kind: "page_context" as const,
      ordinal: 1,
      contextEntryId: 101,
      logicalPageId: 1,
      snapshotDigest: digest("snapshot"),
      material: { body: "SHAREABLE BODY", bodyTruncated: false },
    }],
  };
  return {
    draft,
    sources: [{
      ordinal: 1,
      exclusionReason: null,
      exclusionCategory: null,
      originDigest: authenticatedOrigin,
      originDisplay: "https://auth.example",
      confirmationRequired: true,
    }],
  };
}

describe("ResearchWorkflow", () => {
  it("returns confirmation-only agent start without writes and fixes derived scope", () => {
    const replayAgentResearchStart = vi.fn(() => undefined);
    const current = vi.fn(() => capturedProjection());
    const submitAgentResearch = vi.fn();
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(), current, submitResearch: vi.fn(),
      replayAgentResearchStart, submitAgentResearch,
    });
    const command = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      budget,
      confirmedOrigins: {
        authenticatedOriginDigests: [] as string[], sensitiveOriginDigests: [] as string[],
      },
      idempotencyKey: "agent-start-confirmation",
      authorizationRef: "user-instruction:agent-start-confirmation",
    };

    expect(workflow.requestAgentStart(command)).toEqual({
      status: "confirmation_required",
      confirmationRequirements: {
        authenticatedOriginDigests: [digest("https://auth.example")],
        sensitiveOriginDigests: [],
      },
    });
    expect(replayAgentResearchStart).toHaveBeenCalledWith(command);
    expect(current).toHaveBeenCalledWith(expect.objectContaining({
      parentReportId: null,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
    }));
    expect(submitAgentResearch).not.toHaveBeenCalled();
  });

  it("submits an approved declarative agent start with server-derived workflow fields", () => {
    const projection = capturedProjection();
    const confirmedOrigins = {
      authenticatedOriginDigests: [digest("https://auth.example")],
      sensitiveOriginDigests: [] as string[],
    };
    const submitAgentResearch = vi.fn(() => ({
      id: "resource_research:7" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    }));
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(), current: () => projection, submitResearch: vi.fn(),
      replayAgentResearchStart: vi.fn(() => undefined), submitAgentResearch,
    });
    const command = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      budget,
      confirmedOrigins,
      idempotencyKey: "agent-start-approved",
      authorizationRef: "user-instruction:agent-start-approved",
    };

    expect(workflow.requestAgentStart(command)).toEqual({
      id: "resource_research:7", kind: "resource_research", status: "queued",
    });
    expect(submitAgentResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resource_research",
        subject: command.target,
        idempotencyKey: command.idempotencyKey,
        provenance: {
          requestedBy: "agent", requestMethod: "on_behalf_of_user",
          authorizationRef: command.authorizationRef,
        },
      }),
      expect.objectContaining({
        parentReportId: null,
        captureIntent: { selectedTabIds: [], knownFailures: [] },
        estimate: expect.objectContaining({ estimateVersion: "research_estimate:v1" }),
        scope: expect.objectContaining({
          privacyConfirmation: { confirmed: true, ...confirmedOrigins },
        }),
      }),
      {
        idempotencyKey: command.idempotencyKey,
        authorizationRef: command.authorizationRef,
      },
    );
  });

  it("owns research cancellation and public redaction behind the same seam", () => {
    const cancelled = {
      id: "resource_research:7" as const,
      kind: "resource_research" as const,
      subject: { type: "page" as const, logicalPageId: 1 },
      status: "cancelled" as const,
      attempts: 0,
      maxAttempts: 3,
      progress: { completed: 0, total: null, stage: "cancelled" },
      canCancel: false,
      cancellationRequest: {
        requestedBy: "user" as const,
        requestedAt: "2026-08-13T17:00:00.000Z",
      },
      createdAt: "2026-08-13T17:00:00.000Z",
      startedAt: null,
      completedAt: "2026-08-13T17:00:00.000Z",
      nextAttemptAt: null,
      error: null,
      result: null,
    };
    const cancelResearch = vi.fn(() => cancelled);
    const receipt = {
      sources: 1, snapshots: 2, evidence: 3, reports: 4, runs: 5, cancelledJobs: 1,
    };
    const redactResearch = vi.fn(() => receipt);
    const workflow = createResearchWorkflow({
      current: () => capturedProjection(),
      submitResearch: vi.fn(),
      cancelResearch,
      redactResearch,
    });
    const redaction = {
      target: { type: "report" as const, reportId: 9 },
      reason: "User requested removal",
      idempotencyKey: "workflow-redaction-9",
    };

    expect(workflow.cancel("resource_research:7")).toEqual(cancelled);
    expect(cancelResearch).toHaveBeenCalledWith("resource_research:7");
    expect(workflow.redact(redaction)).toEqual(receipt);
    expect(redactResearch).toHaveBeenCalledWith(redaction);
    expect(() => workflow.cancel("priority_assessment:7"))
      .toThrow(/only resource research/i);
  });

  it("projects a deterministic write-free preflight without source material", () => {
    const current = vi.fn(() => capturedProjection());
    const submitResearch = vi.fn();
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(), current, submitResearch,
    });

    const preflight = workflow.preflight({
      version: 1,
      target: { type: "page", logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: [digest("https://auth.example")],
        sensitiveOriginDigests: [],
      },
    });

    expect(current).toHaveBeenCalledOnce();
    expect(submitResearch).not.toHaveBeenCalled();
    expect(preflight).toMatchObject({
      version: 1,
      coverage: { discovered: 1, captured: 1, eligible: 1, used: 0,
        missing: 0, failed: 0 },
      confirmationRequirements: {
        authenticatedOriginDigests: [digest("https://auth.example")],
        sensitiveOriginDigests: [],
      },
      estimate: {
        estimateVersion: "research_estimate:v1",
        estimateKind: "reservation_envelope",
        calls: 1,
        inputTokens: 532,
        outputTokens: 1024,
        costUsd: 0.5,
        wallTimeMs: 30_000,
      },
    });
    expect(preflight.manifest[0]).toMatchObject({
      ordinal: 1,
      logicalPageId: 1,
      selectedTabId: 11,
      contentRevision: 2,
      contentDigest: digest("captured material"),
      state: "captured",
      accessClass: "authenticated",
      originDigest: digest("https://auth.example"),
      requiresConfirmation: true,
      capturedChunkManifest: expect.objectContaining({
        chunkDigest: digest("captured material"),
      }),
    });
    expect(preflight.snapshots).toEqual([{
      kind: "page_context",
      ordinal: 1,
      contextEntryId: 101,
      logicalPageId: 1,
      snapshotDigest: digest("snapshot"),
      materialBytes: 47,
      truncated: false,
    }]);
    const serialized = JSON.stringify(preflight);
    expect(serialized).not.toContain("Secret title");
    expect(serialized).not.toContain("captured material");
    expect(serialized).not.toContain("SHAREABLE BODY");
    expect(serialized).not.toContain("local_only");
    expect(preflight.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves tabless live acquisition provenance in the safe manifest", () => {
    const captured = capturedProjection();
    const original = captured.draft.sources[0]!;
    const projection = {
      draft: {
        ...captured.draft,
        target: { type: "resource" as const, resourceId: 7 },
        sources: [{
          sourceKind: "live_acquisition" as const,
          ordinal: original.ordinal,
          logicalPageId: original.logicalPageId,
          tabId: null,
          selectedTabId: null,
          contentRevision: 1 as const,
          contentDigest: digest("captured material"),
          extractedAt: "2026-08-13T17:00:00.000Z",
          acquisitionMethod: "safe_public_http_v1" as const,
          accessClass: "public" as const,
          eligibility: "eligible" as const,
          inclusionState: "included" as const,
          includedOrder: 1,
          handoffSourceReceiptId: 19,
          handoffSourceReceiptDigest: digest("receipt"),
          payload: original.payload!,
        }],
      },
      sources: [{
        ordinal: 1,
        exclusionReason: null,
        exclusionCategory: null,
        originDigest: null,
        confirmationRequired: false,
      }],
    } satisfies ResearchCurrentProjection;
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(),
      current: () => projection,
      submitResearch: vi.fn(),
    });

    const preflight = workflow.preflight({
      version: 1,
      target: { type: "resource", resourceId: 7 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
    });

    expect(preflight.manifest[0]).toMatchObject({
      sourceKind: "live_acquisition",
      acquisitionMethod: "safe_public_http_v1",
      selectedTabId: null,
      contentRevision: 1,
    });
  });

  it("maps a public approval to the server-owned durable research task", () => {
    const projection = capturedProjection();
    const current = vi.fn(() => projection);
    const submitResearch = vi.fn(() => ({
      id: "resource_research:7" as const,
      kind: "resource_research" as const,
      status: "queued" as const,
    }));
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(), current, submitResearch,
    });
    const declarative = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: [digest("https://auth.example")],
        sensitiveOriginDigests: [] as string[],
      },
    };
    const preflight = workflow.preflight(declarative);

    expect(workflow.requestRun({
      ...declarative,
      estimate: preflight.estimate,
      approvalFingerprint: preflight.approvalFingerprint!,
      idempotencyKey: "research-workflow-run-1",
    })).toEqual({
      id: "resource_research:7",
      kind: "resource_research",
      status: "queued",
    });
    expect(current).toHaveBeenCalledOnce();
    expect(submitResearch).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      kind: "resource_research",
      subject: { type: "page", logicalPageId: 1 },
      workflowRef: researchWorkflowRefV1,
      inputFingerprint: preflight.approvalFingerprint,
      idempotencyKey: "research-workflow-run-1",
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 0,
      budget,
    }), expect.objectContaining({
      version: 1,
      target: declarative.target,
      question: declarative.question,
      workflowRef: researchWorkflowRefV1,
      approvalFingerprint: preflight.approvalFingerprint,
      scope: {
        acquisitionLevel: "captured_only",
        includeShareableContext: true,
        maxIncludedSources: 100,
        privacyConfirmation: {
          confirmed: true,
          ...declarative.confirmedOrigins,
        },
      },
    }));
  });

  it("maps noncanonical run confirmations to a stale-preflight conflict", () => {
    const submitResearch = vi.fn();
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(),
      current: () => capturedProjection(),
      submitResearch,
    });
    const first = digest("https://a.example");
    const second = digest("https://b.example");
    const descending = [first, second].sort().reverse();

    expect(() => workflow.requestRun({
      version: 1,
      target: { type: "page", logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      estimate: capturedProjection().draft.estimate,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: descending,
        sensitiveOriginDigests: [],
      },
      approvalFingerprint: digest("approval"),
      idempotencyKey: "noncanonical-confirmations",
    })).toThrowError(expect.objectContaining({ code: "RESEARCH_PREFLIGHT_STALE" }));
    expect(submitResearch).not.toHaveBeenCalled();
  });

  it("binds approval to the exact safe manifest and corpus fingerprint", () => {
    const first = capturedProjection();
    const second = capturedProjection();
    second.draft.corpusFingerprint = digest("changed corpus");
    second.draft.sources[0]!.payload!.url = "https://example.com/private";
    (second.sources[0] as { originDigest: string | null }).originDigest =
      digest("https://example.com");
    (second.sources[0] as { originDisplay?: string | null }).originDisplay =
      "https://example.com";
    const confirmed = {
      authenticatedOriginDigests: [digest("https://auth.example")],
      sensitiveOriginDigests: [] as string[],
    };
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
      confirmedOrigins: confirmed,
    };
    const approvedFirst = createResearchWorkflow({
      ...lifecycleDependencies(), current: () => first, submitResearch: vi.fn(),
    }).preflight(request);
    const approvedSecond = createResearchWorkflow({
      ...lifecycleDependencies(), current: () => second, submitResearch: vi.fn(),
    }).preflight({ ...request, confirmedOrigins: {
      authenticatedOriginDigests: [digest("https://example.com")],
      sensitiveOriginDigests: [],
    } });

    expect(approvedFirst.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(approvedSecond.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(approvedSecond.corpusFingerprint).not.toBe(approvedFirst.corpusFingerprint);
    expect(approvedSecond.manifest[0]!.originDigest)
      .not.toBe(approvedFirst.manifest[0]!.originDigest);
    expect(approvedSecond.approvalFingerprint).not.toBe(approvedFirst.approvalFingerprint);
  });

  it("binds approval to exact exclusion reasons even when the corpus digest is unchanged", () => {
    const excludedProjection = (
      exclusionReason: "invalid_url" | "browser_internal",
    ): ResearchCurrentProjection => {
      const projection = capturedProjection();
      projection.draft.sources = [{
        sourceKind: "captured",
        ordinal: 1,
        logicalPageId: 1,
        tabId: 11,
        selectedTabId: 11,
        contentRevision: 2,
        contentDigest: digest("captured material"),
        extractedAt: "2026-08-13T17:00:00.000Z",
        acquisitionMethod: "captured",
        accessClass: "public",
        eligibility: "format_excluded",
        inclusionState: "excluded",
        exclusionReason: "format",
        includedOrder: null,
        handoffSourceReceiptId: null,
        handoffSourceReceiptDigest: null,
        payload: null,
      }];
      projection.draft.snapshots = [];
      return {
        draft: projection.draft,
        sources: [{
          ordinal: 1,
          exclusionReason,
          exclusionCategory: "format",
          originDigest: null,
          originDisplay: null,
          confirmationRequired: false,
        }],
      };
    };
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
      confirmedOrigins: { authenticatedOriginDigests: [] as string[],
        sensitiveOriginDigests: [] as string[] },
    };
    const invalid = createResearchWorkflow({
      ...lifecycleDependencies(),
      current: () => excludedProjection("invalid_url"), submitResearch: vi.fn(),
    }).preflight(request);
    const internal = createResearchWorkflow({
      ...lifecycleDependencies(),
      current: () => excludedProjection("browser_internal"), submitResearch: vi.fn(),
    }).preflight(request);

    expect(invalid.corpusFingerprint).toBe(internal.corpusFingerprint);
    expect(invalid.approvalFingerprint).not.toBe(internal.approvalFingerprint);
  });

  it("reveals exact confirmations first and rejects unavailable parents before projection", () => {
    const current = vi.fn(() => capturedProjection());
    const parentAvailability = vi.fn(() => "unavailable" as const);
    const workflow = createResearchWorkflow({
      ...lifecycleDependencies(), current, submitResearch: vi.fn(), parentAvailability,
    });
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What is useful?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget,
      captureIntent: { selectedTabIds: [] as number[], knownFailures: [] },
    };

    const discovery = workflow.preflight(request);
    expect(discovery.approvalFingerprint).toBeNull();
    expect(discovery.confirmationRequirements).toEqual({
      authenticatedOriginDigests: [digest("https://auth.example")],
      sensitiveOriginDigests: [],
    });

    expect(() => workflow.preflight({ ...request, parentReportId: 44 })).toThrowError(
      expect.objectContaining({ code: "RESEARCH_PARENT_UNAVAILABLE" }),
    );
    expect(parentAvailability).toHaveBeenCalledWith(request.target, 44);
    expect(current).toHaveBeenCalledOnce();
  });
});
