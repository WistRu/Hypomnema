import { describe, expect, it } from "vitest";

import {
  agentResearchStartResponseSchema,
  featureFlagsResponseSchema,
} from "./index.js";

import {
  agentResearchCancelRequestSchema,
  agentResearchEvidenceDetailSchema,
  agentResearchPreflightSchema,
  agentResearchRunApprovalRequestSchema,
  agentResearchStartRequestSchema,
  agentResearchStartCommandFingerprintPayloadV1,
  agentResearchStartRequestFingerprintPayloadV1,
  estimateResearchReservationV1,
  researchApprovalFingerprintPayloadV1,
  researchApprovedDraftSchema,
  researchApprovalRequestSchema,
  researchCapturedTextChunkManifestSchema,
  researchClaimDraftSchema,
  researchClaimListSchema,
  researchContentDigestPayloadV1,
  researchCanonicalSha256PayloadV1,
  researchCoverageSchema,
  researchDossierSchema,
  researchEstimateFitsBudgetV1,
  researchEvidenceDetailSchema,
  researchEvidenceDraftSchema,
  researchPreflightRequestSchema,
  researchPreflightSchema,
  researchPrivacyRequestSchema,
  researchPublicationDraftSchema,
  researchRedactionRequestSchema,
  researchRedactionReceiptSchema,
  researchReportDetailSchema,
  projectAgentResearchPreflight,
  projectAgentResearchReportDetail,
  researchReportIdParamsSchema,
  researchReportListQuerySchema,
  researchReportListResponseSchema,
  researchRefineApprovalRequestSchema,
  researchRunApprovalRequestSchema,
  researchSafePageManifestEntrySchema,
  researchSelectionFingerprintPayload,
  researchSourceDraftSchema,
  researchTargetSchema,
} from "./research-contracts.js";

const hash = "a".repeat(64);
const zeroEstimate = {
  estimateVersion: "research_estimate:v1" as const,
  estimateKind: "reservation_envelope" as const,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  wallTimeMs: 0,
};

describe("captured-only research contracts", () => {
  it("represents immutable tabless live acquisition sources without inventing a tab", () => {
    const live = researchSourceDraftSchema.parse({
      sourceKind: "live_acquisition",
      ordinal: 1,
      logicalPageId: 7,
      tabId: null,
      selectedTabId: null,
      contentRevision: 1,
      contentDigest: hash,
      extractedAt: "2026-08-14T12:00:00.000Z",
      acquisitionMethod: "safe_public_http_v1",
      accessClass: "public",
      eligibility: "eligible",
      inclusionState: "included",
      includedOrder: 1,
      handoffSourceReceiptId: 19,
      handoffSourceReceiptDigest: "b".repeat(64),
      payload: {
        url: "https://public.example/research",
        title: "Public research",
        evidenceMaterial: "public evidence",
        chunkManifest: {
          version: "captured_text_chunks:v1",
          byteStart: 0,
          byteEnd: 15,
          chunkDigest: hash,
          truncated: false,
        },
      },
    });

    expect(live).toMatchObject({
      sourceKind: "live_acquisition",
      tabId: null,
      selectedTabId: null,
      contentRevision: 1,
      acquisitionMethod: "safe_public_http_v1",
      handoffSourceReceiptId: 19,
    });
    expect(() => researchSourceDraftSchema.parse({ ...live, tabId: 11 })).toThrow();
    expect(() => researchSourceDraftSchema.parse({
      ...live,
      acquisitionMethod: "captured",
    })).toThrow();
  });

  it("projects safe captured and live manifests as a source-kind discriminated union", () => {
    const live = researchSafePageManifestEntrySchema.parse({
      sourceKind: "live_acquisition",
      acquisitionMethod: "safe_public_http_v1",
      ordinal: 1,
      logicalPageId: 7,
      selectedTabId: null,
      contentRevision: 1,
      contentDigest: hash,
      state: "captured",
      exclusionReason: null,
      exclusionCategory: null,
      accessClass: "public",
      originDigest: null,
      requiresConfirmation: false,
      failureCode: null,
      capturedChunkManifest: {
        version: "captured_text_chunks:v1",
        byteStart: 0,
        byteEnd: 15,
        chunkDigest: hash,
        truncated: false,
      },
    });

    expect(live).toMatchObject({
      sourceKind: "live_acquisition",
      acquisitionMethod: "safe_public_http_v1",
      selectedTabId: null,
    });
    expect(() => researchSafePageManifestEntrySchema.parse({
      ...live,
      selectedTabId: 11,
    })).toThrow();

    const exactCaptureLegacy = {
      ordinal: 2,
      logicalPageId: 8,
      selectedTabId: 12,
      contentRevision: 3,
      contentDigest: hash,
      acquisitionMethod: "exact_capture",
      state: "captured",
      exclusionReason: null,
      exclusionCategory: null,
      accessClass: "public",
      originDigest: null,
      requiresConfirmation: false,
      failureCode: null,
      capturedChunkManifest: {
        version: "captured_text_chunks:v1",
        byteStart: 0,
        byteEnd: 15,
        chunkDigest: hash,
        truncated: false,
      },
    } as const;
    expect(researchSafePageManifestEntrySchema.parse(exactCaptureLegacy))
      .toMatchObject({
        sourceKind: "captured",
        acquisitionMethod: "exact_capture",
      });
  });

  it("keeps legacy tab_content evidence while requiring captured/live provenance", () => {
    const identity = {
      id: 31,
      ordinal: 1,
      kind: "tab_content" as const,
      sourceId: 19,
      sourceKind: "live_acquisition" as const,
      acquisitionMethod: "safe_public_http_v1" as const,
      contentRevision: 1,
      contentDigest: hash,
      state: "valid" as const,
      stateReason: null,
      locatorDigest: hash,
      excerptHash: hash,
    };
    const local = researchEvidenceDetailSchema.parse({
      ...identity,
      locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 6 },
      excerpt: "public",
      url: "https://public.example/research",
      title: "Public research",
    });
    const agent = agentResearchEvidenceDetailSchema.parse(identity);

    expect(local).toMatchObject({
      kind: "tab_content",
      sourceKind: "live_acquisition",
      acquisitionMethod: "safe_public_http_v1",
    });
    expect(agent).toMatchObject({
      kind: "tab_content",
      sourceKind: "live_acquisition",
      acquisitionMethod: "safe_public_http_v1",
    });
    expect(() => agentResearchEvidenceDetailSchema.parse({
      ...identity,
      sourceKind: "captured",
    })).toThrow();
  });

  it("exposes research as a rollout-safe optional feature flag", () => {
    const legacy = { context: false, logicalImportance: false };
    expect(featureFlagsResponseSchema.parse(legacy)).toEqual(legacy);
    expect(featureFlagsResponseSchema.parse({ ...legacy, research: true }).research).toBe(true);
  });
  it("accepts only declarative public preflight input and an explicit digest confirmation intent", () => {
    const request = {
      version: 1 as const,
      target: { type: "resource" as const, resourceId: 7 },
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 100,
      parentReportId: null,
      budget: { maxSteps: 10, maxTokens: 20_000, maxCostUsd: 2, maxWallTimeMs: 60_000 },
      captureIntent: { selectedTabIds: [], knownFailures: [] },
    };
    expect(researchPreflightRequestSchema.parse(request).confirmedOrigins).toEqual({
      authenticatedOriginDigests: [],
      sensitiveOriginDigests: [],
    });
    expect(researchPreflightRequestSchema.parse({
      ...request,
      confirmedOrigins: {
        authenticatedOriginDigests: [hash],
        sensitiveOriginDigests: [],
      },
    }).confirmedOrigins.authenticatedOriginDigests).toEqual([hash]);
    for (const injected of [
      { workflowRef: { id: "attacker", version: 1 } },
      { provenance: { requestedBy: "system", requestMethod: "scheduled" } },
      { schedulingPriority: 100 },
      { approvalFingerprint: hash },
      { corpusFingerprint: hash },
      { inputFingerprint: hash },
      { acquisitionLevel: "captured_only" },
    ]) {
      expect(() => researchPreflightRequestSchema.parse({ ...request, ...injected })).toThrow();
    }
    expect(() => researchPreflightRequestSchema.parse({
      ...request,
      confirmed: true,
    })).toThrow();
  });

  it("accepts only the bounded declarative agent start-or-replay command", () => {
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 25,
      budget: { maxSteps: 4, maxTokens: 8_000, maxCostUsd: 0.5,
        maxWallTimeMs: 30_000 },
      confirmedOrigins: {
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
      idempotencyKey: "agent-research-page-1",
      authorizationRef: "user-instruction:agent-research-page-1",
    };
    expect(agentResearchStartRequestSchema.parse(request)).toEqual(request);
    for (const forbidden of [
      { parentReportId: null },
      { captureIntent: { selectedTabIds: [], knownFailures: [] } },
      { estimate: zeroEstimate },
      { approvalFingerprint: hash },
      { provenance: { requestedBy: "agent", requestMethod: "on_behalf_of_user" } },
    ]) {
      expect(() => agentResearchStartRequestSchema.parse({ ...request, ...forbidden }))
        .toThrow();
    }
  });

  it("fingerprints start-or-replay exactly like a derived null-parent empty-capture run", () => {
    const request = agentResearchStartRequestSchema.parse({
      version: 1,
      target: { type: "page", logicalPageId: 1 },
      question: "What matters?",
      includeShareableContext: true,
      maxIncludedSources: 25,
      budget: { maxSteps: 4, maxTokens: 8_000, maxCostUsd: 0.5,
        maxWallTimeMs: 30_000 },
      confirmedOrigins: {
        authenticatedOriginDigests: [], sensitiveOriginDigests: [],
      },
      idempotencyKey: "agent-research-page-1",
      authorizationRef: "user-instruction:agent-research-page-1",
    });
    expect(agentResearchStartRequestFingerprintPayloadV1(request)).toEqual(
      agentResearchStartCommandFingerprintPayloadV1({
        ...request,
        parentReportId: null,
        captureIntent: { selectedTabIds: [], knownFailures: [] },
        estimate: zeroEstimate,
        approvalFingerprint: hash,
      }),
    );
  });

  it("parses only the strict agent start-or-replay wire result union", () => {
    expect(agentResearchStartResponseSchema.parse({
      id: "resource_research:7", kind: "resource_research", status: "queued",
    })).toEqual({
      id: "resource_research:7", kind: "resource_research", status: "queued",
    });
    const confirmation = {
      status: "confirmation_required" as const,
      confirmationRequirements: {
        authenticatedOriginDigests: [hash], sensitiveOriginDigests: [],
      },
    };
    expect(agentResearchStartResponseSchema.parse(confirmation)).toEqual(confirmation);
    expect(() => agentResearchStartResponseSchema.parse({
      ...confirmation, manifest: [{ url: "https://private.example" }],
    })).toThrow();
    expect(() => agentResearchStartResponseSchema.parse({
      id: "priority_assessment:7", kind: "priority_assessment", status: "queued",
    })).toThrow();
  });

  it("computes the frozen reservation envelope from exact UTF-8 byte counts", () => {
    const budget = { maxSteps: 3, maxTokens: 5000, maxCostUsd: 1.25, maxWallTimeMs: 90_000 };
    expect(estimateResearchReservationV1({
      includedSources: 0,
      includedSourceBytes: 0,
      snapshotBytes: 0,
      questionBytes: new TextEncoder().encode("что").byteLength,
      budget,
    })).toEqual({
      estimateVersion: "research_estimate:v1",
      estimateKind: "reservation_envelope",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
    });
    expect(estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: new TextEncoder().encode("🙂").byteLength,
      snapshotBytes: new TextEncoder().encode("界").byteLength,
      questionBytes: new TextEncoder().encode("é").byteLength,
      budget,
    })).toEqual({
      estimateVersion: "research_estimate:v1",
      estimateKind: "reservation_envelope",
      calls: 1,
      inputTokens: 515,
      outputTokens: 1024,
      costUsd: 1.25,
      wallTimeMs: 90_000,
    });
    expect(estimateResearchReservationV1({
      includedSources: 100,
      includedSourceBytes: 4 * 1024 * 1024,
      snapshotBytes: 100 * 65_536,
      questionBytes: 4000,
      budget: { maxSteps: 100, maxTokens: 200_000, maxCostUsd: 2,
        maxWallTimeMs: 1_800_000 },
    })).toMatchObject({
      calls: 1,
      inputTokens: 2_688_488,
      outputTokens: 6656,
      costUsd: 2,
      wallTimeMs: 1_800_000,
    });
    expect(() => estimateResearchReservationV1({
      includedSources: 1,
      includedSourceBytes: Number.MAX_SAFE_INTEGER,
      snapshotBytes: 0,
      questionBytes: 0,
      budget,
    })).toThrow();
  });

  it("keeps public run approval declarative and fingerprints every approval-sensitive field", () => {
    const request = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "Question",
      includeShareableContext: true,
      maxIncludedSources: 1,
      parentReportId: null,
      budget: { maxSteps: 3, maxTokens: 2000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      captureIntent: { selectedTabIds: [11], knownFailures: [] },
      confirmedOrigins: { authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
    };
    expect(researchRunApprovalRequestSchema.parse({
      ...request,
      approvalFingerprint: hash,
      idempotencyKey: "research-page-1",
    }).approvalFingerprint).toBe(hash);
    const agentRun = agentResearchRunApprovalRequestSchema.parse({
      ...request,
      approvalFingerprint: hash,
      idempotencyKey: "agent-research-page-1",
      authorizationRef: "user-approved-research-1",
    });
    expect(agentRun.authorizationRef).toBe("user-approved-research-1");
    const stable = new TextDecoder().decode(
      agentResearchStartCommandFingerprintPayloadV1(agentRun),
    );
    expect(stable).not.toContain(agentRun.authorizationRef);
    expect(stable).not.toContain(agentRun.idempotencyKey);
    expect(stable).not.toContain(agentRun.approvalFingerprint);
    expect(stable).not.toContain("estimateVersion");
    expect(agentResearchStartCommandFingerprintPayloadV1({
      ...agentRun,
      approvalFingerprint: "b".repeat(64),
      estimate: { ...agentRun.estimate, costUsd: 0.5 },
    })).toEqual(agentResearchStartCommandFingerprintPayloadV1(agentRun));
    expect(agentResearchCancelRequestSchema.parse({
      authorizationRef: "user-approved-research-1",
      idempotencyKey: "agent-research-cancel-1",
    })).toMatchObject({ idempotencyKey: "agent-research-cancel-1" });
    for (const injected of [
      { actor: "agent" },
      { requestMethod: "on_behalf_of_user" },
      { capability: "must-not-enter-agent-contract" },
    ]) {
      expect(() => agentResearchRunApprovalRequestSchema.parse({
        ...agentRun,
        ...injected,
      })).toThrow();
    }
    expect(() => researchRunApprovalRequestSchema.parse({
      ...request,
      approvalFingerprint: hash,
      idempotencyKey: "research-page-1",
      workflowRef: { id: "attacker", version: 1 },
    })).toThrow();
    const refine = {
      ...request,
      approvalFingerprint: hash,
      idempotencyKey: "research-refine-1",
    };
    const { parentReportId: _parentReportId, ...refineWithoutParent } = refine;
    expect(researchRefineApprovalRequestSchema.parse(refineWithoutParent))
      .not.toHaveProperty("parentReportId");
    expect(() => researchRefineApprovalRequestSchema.parse(refine)).toThrow();

    const internalApproval = {
      version: 1 as const,
      target: request.target,
      question: request.question,
      scope: {
        acquisitionLevel: "captured_only" as const,
        includeShareableContext: true,
        maxIncludedSources: 1,
        privacyConfirmation: {
          confirmed: true as const,
          authenticatedOriginDigests: [],
          sensitiveOriginDigests: [],
        },
      },
      parentReportId: null,
      workflowRef: { id: "research_workflow:c81", version: 1 },
      budget: request.budget,
      estimate: zeroEstimate,
      sources: [{
        sourceKind: "captured" as const,
        ordinal: 1,
        logicalPageId: 1,
        tabId: null,
        selectedTabId: null,
        contentRevision: null,
        contentDigest: null,
        extractedAt: null,
        acquisitionMethod: "inventory" as const,
        accessClass: "public" as const,
        eligibility: "not_captured" as const,
        inclusionState: "missing" as const,
        failureCode: null,
        includedOrder: null,
        handoffSourceReceiptId: null,
        handoffSourceReceiptDigest: null,
        payload: null,
      }],
      snapshots: [],
    };
    const bytes = researchApprovalFingerprintPayloadV1(internalApproval);
    expect(new TextDecoder().decode(bytes)).toContain('"estimateVersion":"research_estimate:v1"');
    expect(new TextDecoder().decode(bytes)).toContain('"maxCostUsd":1');
    expect(new TextDecoder().decode(bytes)).toContain('"id":"research_workflow:c81"');
    expect(researchApprovalFingerprintPayloadV1({
      ...internalApproval, question: "Changed",
    })).not.toEqual(bytes);
    expect(researchEstimateFitsBudgetV1(zeroEstimate, request.budget)).toBe(true);
    expect(researchEstimateFitsBudgetV1(
      { ...zeroEstimate, calls: 1, inputTokens: 1000, outputTokens: 1024,
        costUsd: 1, wallTimeMs: 60_000 },
      request.budget,
    )).toBe(false);
  });

  it("returns only safe typed page and snapshot manifests", () => {
    const preflight = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      approvalFingerprint: null,
      corpusFingerprint: hash,
      coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
      approvedBudget: { maxSteps: 3, maxTokens: 2000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      acquisitionLevel: "captured_only" as const,
      manifest: [{
        ordinal: 1,
        logicalPageId: 1,
        selectedTabId: 11,
        contentRevision: 2,
        contentDigest: hash,
        state: "captured" as const,
        exclusionReason: null,
        exclusionCategory: null,
        accessClass: "authenticated" as const,
        originDigest: hash,
        requiresConfirmation: true,
        failureCode: null,
        capturedChunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: 4,
          chunkDigest: hash,
          truncated: true,
        },
      }],
      snapshots: [{
        kind: "page_context" as const,
        ordinal: 1,
        snapshotDigest: hash,
        materialBytes: 16,
        truncated: false,
        contextEntryId: 9,
        logicalPageId: 1,
      }],
      confirmationRequirements: {
        authenticatedOriginDigests: [hash],
        sensitiveOriginDigests: [],
      },
      confirmationDisplay: [{
        accessClass: "authenticated" as const,
        originDigest: hash,
        origin: "https://example.com",
      }],
      estimate: {
        estimateVersion: "research_estimate:v1" as const,
        estimateKind: "reservation_envelope" as const,
        calls: 1, inputTokens: 513, outputTokens: 1024, costUsd: 1, wallTimeMs: 60_000,
      },
      requiresConfirmation: true,
      limitations: [],
    };
    expect(researchPreflightSchema.parse(preflight).snapshots[0]).toMatchObject({
      kind: "page_context",
      materialBytes: 16,
    });
    const agentPreflight = projectAgentResearchPreflight(
      researchPreflightSchema.parse(preflight),
    );
    expect(agentResearchPreflightSchema.parse(agentPreflight)).not.toHaveProperty(
      "confirmationDisplay",
    );
    expect(JSON.stringify(agentPreflight)).not.toContain("https://example.com");
    for (const unsafe of [
      { url: "https://private.test" },
      { title: "Private" },
      { capturedText: "secret" },
      { material: { body: "secret" } },
      { local_only: false },
    ]) {
      expect(() => researchPreflightSchema.parse({
        ...preflight,
        manifest: [{ ...preflight.manifest[0], ...unsafe }],
      })).toThrow();
    }
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      manifest: [{ ...preflight.manifest[0], state: "excluded",
        exclusionReason: "private_ip", exclusionCategory: "format" }],
      limitations: ["private_ip"],
    })).toThrow(/category/i);
  });

  it("excludes direct snapshots from public redaction while retaining internal privacy support", () => {
    const snapshot = {
      target: { type: "snapshot" as const, kind: "activity" as const, snapshotId: 9 },
      reason: "Remove material",
      idempotencyKey: "redact-9",
    };
    expect(() => researchRedactionRequestSchema.parse(snapshot)).toThrow();
    expect(researchPrivacyRequestSchema.parse(snapshot).target.type).toBe("snapshot");
    expect(researchRedactionReceiptSchema.parse({
      sources: 1,
      snapshots: 2,
      evidence: 3,
      reports: 4,
      runs: 5,
      cancelledJobs: 1,
    })).toMatchObject({ reports: 4, cancelledJobs: 1 });
    expect(() => researchRedactionRequestSchema.parse({
      target: { type: "report", reportId: 1 },
      reason: "Remove material",
      idempotencyKey: "redact-1",
      snapshotId: 9,
    })).toThrow();
  });
  it("accepts exactly one typed target and rejects duplicate selection pages", () => {
    expect(researchTargetSchema.parse({ type: "page", logicalPageId: 1 })).toEqual({
      type: "page",
      logicalPageId: 1,
    });
    expect(() => researchTargetSchema.parse({
      type: "selection",
      logicalPageIds: [1, 1],
      fingerprint: hash,
    })).toThrow(/unique/i);
    expect(() => researchTargetSchema.parse({
      type: "selection",
      logicalPageIds: [],
      fingerprint: hash,
    })).toThrow();
    expect(() => researchTargetSchema.parse({
      type: "selection",
      logicalPageIds: Array.from({ length: 101 }, (_, index) => index + 1),
      fingerprint: hash,
    })).toThrow();
    expect(researchSelectionFingerprintPayload([3, 1, 2])).toBe("[1,2,3]");
    expect(new TextDecoder().decode(researchContentDigestPayloadV1("exact text")))
      .toBe("exact text");
    expect(new TextDecoder().decode(researchCanonicalSha256PayloadV1({ b: 2, a: 1 })))
      .toBe('{"a":1,"b":2}');
  });

  it("enforces coverage arithmetic and evidence-bearing non-inference claims", () => {
    expect(() => researchCoverageSchema.parse({
      discovered: 3,
      captured: 1,
      eligible: 1,
      used: 1,
      missing: 1,
      failed: 0,
    })).toThrow(/arithmetic/i);
    expect(() => researchClaimDraftSchema.parse({
      claim: "A factual claim",
      confidence: 0.9,
      isInference: false,
      rationale: null,
      evidence: [],
    })).toThrow(/requires evidence/i);
  });

  it("bounds the immutable approved corpus and rejects private undeclared fields", () => {
    const base = {
      version: 1,
      target: { type: "page", logicalPageId: 1 },
      question: "What matters?",
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
      approvalFingerprint: hash,
      corpusFingerprint: hash,
      workflowRef: { id: "research-v1", version: 1 },
      budget: { maxSteps: 10, maxTokens: 1000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      sources: [{
        ordinal: 1,
        logicalPageId: 1,
        tabId: null,
        contentRevision: null,
        contentDigest: null,
        extractedAt: null,
        acquisitionMethod: "inventory",
        accessClass: "public",
        eligibility: "not_captured",
        inclusionState: "missing",
        failureCode: null,
        includedOrder: null,
        payload: null,
      }],
    } as const;
    expect(researchApprovedDraftSchema.parse(base).sources).toHaveLength(1);
    expect(() => researchApprovedDraftSchema.parse({ ...base, local_only: true })).toThrow();
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      scope: {
        ...base.scope,
        privacyConfirmation: { ...base.scope.privacyConfirmation, confirmed: false },
      },
    })).toThrow();
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      scope: {
        ...base.scope,
        privacyConfirmation: {
          confirmed: true,
          authenticatedOriginDigests: ["b".repeat(64), "a".repeat(64)],
          sensitiveOriginDigests: [],
        },
      },
    })).toThrow(/canonically sorted/i);

    const included = {
      ordinal: 1,
      logicalPageId: 1,
      tabId: 11,
      contentRevision: 1,
      contentDigest: hash,
      extractedAt: "2026-08-13T00:00:00.000Z",
      acquisitionMethod: "captured" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "included" as const,
      includedOrder: 1,
      payload: {
        url: "https://research.test/1",
        title: "One",
        evidenceMaterial: "one",
        chunkManifest: {
          version: "captured_text_chunks:v1" as const,
          byteStart: 0 as const,
          byteEnd: 3,
          chunkDigest: hash,
          truncated: false,
        },
      },
    };
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      scope: { ...base.scope, maxIncludedSources: 1 },
      sources: [included, {
        ...included,
        ordinal: 2,
        logicalPageId: 2,
        tabId: 22,
        includedOrder: 2,
        payload: { ...included.payload, url: "https://research.test/2", title: "Two" },
      }],
    })).toThrow(/ordering is invalid/i);

    expect(researchApprovedDraftSchema.parse({
      ...base,
      sources: [{ ...included, payload: { ...included.payload, title: "界".repeat(2048) } }],
    }).sources[0]?.payload?.title).toBe("界".repeat(2048));
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      sources: [{ ...included, payload: { ...included.payload, title: "界".repeat(2049) } }],
    })).toThrow();
  });

  it("allows an empty approved source manifest only for a Resource target", () => {
    const base = {
      version: 1 as const,
      target: { type: "resource" as const, resourceId: 7 },
      question: "What matters?",
      scope: {
        acquisitionLevel: "captured_only" as const,
        includeShareableContext: false,
        maxIncludedSources: 100,
        privacyConfirmation: {
          confirmed: true as const,
          authenticatedOriginDigests: [],
          sensitiveOriginDigests: [],
        },
      },
      parentReportId: null,
      approvalFingerprint: hash,
      corpusFingerprint: hash,
      workflowRef: { id: "research_workflow:c81:v1", version: 1 },
      budget: { maxSteps: 10, maxTokens: 4_000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      sources: [],
      snapshots: [],
    };
    expect(researchApprovedDraftSchema.parse(base).sources).toEqual([]);
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      target: { type: "page", logicalPageId: 7 },
    })).toThrow(/Only a Resource preflight may have an empty source manifest/);
    expect(() => researchApprovedDraftSchema.parse({
      ...base,
      target: { type: "selection", logicalPageIds: [7], fingerprint: hash },
    })).toThrow(/Only a Resource preflight may have an empty source manifest/);
  });

  it("admits noncanonical run confirmation lists for typed stale-preflight handling", () => {
    const base = {
      version: 1 as const,
      target: { type: "page" as const, logicalPageId: 1 },
      question: "What matters?",
      includeShareableContext: false,
      maxIncludedSources: 100,
      parentReportId: null,
      budget: { maxSteps: 10, maxTokens: 4_000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
      confirmedOrigins: {
        authenticatedOriginDigests: ["b".repeat(64), "a".repeat(64)],
        sensitiveOriginDigests: [hash, hash],
      },
      approvalFingerprint: hash,
      idempotencyKey: "noncanonical-confirmation-run",
    };
    expect(researchRunApprovalRequestSchema.parse(base).confirmedOrigins).toEqual(
      base.confirmedOrigins,
    );
    expect(() => researchPreflightRequestSchema.parse({
      version: 1,
      target: base.target,
      question: base.question,
      includeShareableContext: base.includeShareableContext,
      maxIncludedSources: base.maxIncludedSources,
      parentReportId: null,
      budget: base.budget,
      captureIntent: base.captureIntent,
      confirmedOrigins: base.confirmedOrigins,
    })).toThrow(/canonically sorted/i);
  });

  it("represents captured sources excluded only by the 100-source cap", () => {
    const excluded = {
      ordinal: 1,
      logicalPageId: 101,
      tabId: 1101,
      contentRevision: 1,
      contentDigest: hash,
      extractedAt: "2026-08-13T00:00:00.000Z",
      acquisitionMethod: "captured" as const,
      accessClass: "public" as const,
      eligibility: "eligible" as const,
      inclusionState: "excluded" as const,
      exclusionReason: "source_limit" as const,
      includedOrder: null,
      payload: null,
    };
    const base = {
      version: 1 as const,
      target: { type: "resource" as const, resourceId: 1 },
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
      approvalFingerprint: hash,
      corpusFingerprint: hash,
      workflowRef: { id: "research-v1", version: 1 },
      budget: { maxSteps: 10, maxTokens: 1000, maxCostUsd: 2, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      sources: [excluded],
    };
    expect(researchApprovedDraftSchema.parse(base).sources[0]).toMatchObject({
      eligibility: "eligible",
      inclusionState: "excluded",
      exclusionReason: "source_limit",
    });
  });

  it("validates preflight manifest uniqueness and exact coverage arithmetic", () => {
    const entry = {
      ordinal: 1,
      logicalPageId: 1,
      selectedTabId: 11,
      contentRevision: 1,
      contentDigest: hash,
      state: "excluded" as const,
      exclusionReason: "source_limit" as const,
      exclusionCategory: "limit" as const,
      accessClass: "public" as const,
      originDigest: null,
      requiresConfirmation: false,
      failureCode: null,
      capturedChunkManifest: {
        version: "captured_text_chunks:v1" as const,
        byteStart: 0 as const,
        byteEnd: 3,
        chunkDigest: hash,
        truncated: false,
      },
    };
    const preflight = {
      version: 1 as const,
      target: { type: "resource" as const, resourceId: 1 },
      approvalFingerprint: hash,
      corpusFingerprint: hash,
      coverage: { discovered: 1, captured: 1, eligible: 1, used: 0, missing: 0, failed: 0 },
      approvedBudget: { maxSteps: 1, maxTokens: 0, maxCostUsd: 2, maxWallTimeMs: 1 },
      acquisitionLevel: "captured_only" as const,
      manifest: [entry],
      snapshots: [],
      confirmationRequirements: {
        authenticatedOriginDigests: [],
        sensitiveOriginDigests: [],
      },
      confirmationDisplay: [],
      estimate: {
        estimateVersion: "research_estimate:v1" as const,
        estimateKind: "reservation_envelope" as const,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallTimeMs: 0,
      },
      requiresConfirmation: false,
      limitations: ["source_limit" as const],
    };
    expect(researchPreflightSchema.parse(preflight).coverage.eligible).toBe(1);
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      manifest: [entry, { ...entry, selectedTabId: 12 }],
      coverage: { ...preflight.coverage, discovered: 2, captured: 2, eligible: 2 },
    })).toThrow(/unique/i);
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      coverage: { ...preflight.coverage, eligible: 0 },
    })).toThrow(/manifest/i);
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      coverage: { ...preflight.coverage, used: 1 },
    })).toThrow(/preflight.*used/i);
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      manifest: [{ ...entry, state: "failed", contentRevision: null,
        contentDigest: null, exclusionReason: null, exclusionCategory: null,
        capturedChunkManifest: null, failureCode: null }],
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 0, failed: 1 },
      limitations: [],
    })).toThrow(/field matrix/i);
    expect(() => researchPreflightSchema.parse({
      ...preflight,
      manifest: [{ ...entry, state: "missing", contentRevision: 1,
        contentDigest: hash, exclusionReason: null, exclusionCategory: null,
        capturedChunkManifest: null, failureCode: null }],
      coverage: { discovered: 1, captured: 0, eligible: 0, used: 0, missing: 1, failed: 0 },
      limitations: [],
    })).toThrow(/field matrix/i);
    expect(researchPreflightSchema.parse({
      ...preflight,
      manifest: [
        { ...entry, selectedTabId: null, contentRevision: null, contentDigest: null,
          state: "missing", exclusionReason: null, exclusionCategory: null,
          capturedChunkManifest: null, failureCode: null },
        { ...entry, ordinal: 2, logicalPageId: 2, selectedTabId: 22,
          contentRevision: null, contentDigest: null, state: "failed",
          exclusionReason: null, exclusionCategory: null,
          capturedChunkManifest: null, failureCode: "TAB_CLOSED" },
      ],
      coverage: { discovered: 2, captured: 0, eligible: 0, used: 0, missing: 1, failed: 1 },
      limitations: [],
    }).coverage).toMatchObject({ missing: 1, failed: 1, used: 0 });
  });

  it("accepts only declarative capture intent in approval requests", () => {
    const request = {
      version: 1 as const,
      target: { type: "selection" as const, logicalPageIds: [2, 1], fingerprint: hash },
      question: "What matters?",
      scope: {
        acquisitionLevel: "captured_only" as const, includeShareableContext: true,
        maxIncludedSources: 100,
        privacyConfirmation: { confirmed: true as const,
          authenticatedOriginDigests: [], sensitiveOriginDigests: [] },
      },
      parentReportId: null, approvalFingerprint: hash,
      workflowRef: { id: "research-v1", version: 1 },
      budget: { maxSteps: 10, maxTokens: 1000, maxCostUsd: 1, maxWallTimeMs: 60_000 },
      estimate: zeroEstimate,
      captureIntent: {
        selectedTabIds: [22],
        knownFailures: [{ logicalPageId: 1, tabId: 11, failureCode: "TAB_CLOSED" }],
      },
    };
    expect(researchApprovalRequestSchema.parse(request).captureIntent.selectedTabIds)
      .toEqual([22]);
    expect(() => researchApprovalRequestSchema.parse({ ...request, sources: [] })).toThrow();
    expect(() => researchApprovalRequestSchema.parse({
      ...request,
      captureIntent: { ...request.captureIntent, selectedTabIds: [22, 22] },
    })).toThrow(/unique/i);
  });

  it("enforces fixed research budgets and closes dossier and evidence publication", () => {
    const dossier = {
      executiveSummary: "Executive summary",
      valueForUser: "Useful because it saves review time",
      capabilities: ["Indexes captured evidence"],
      limitations: ["Captured sources only"],
      risks: ["Sources may become stale"],
      unknowns: ["Long-term value"],
      nextSteps: ["Review the strongest claim"],
    };
    const base = {
      version: 1 as const, status: "succeeded" as const, reason: null,
      corpusFingerprint: hash, inputFingerprint: hash,
      coverage: { discovered: 0, captured: 0, eligible: 0, used: 0, missing: 0, failed: 0 },
      usedSourceIds: [],
      provenance: {
        provider: "p", model: "m", promptVersion: "v1", pricingVersion: "2026-08-01",
        requestId: "request-1", generatedAt: "2026-08-14T00:00:00.000Z",
        usage: { steps: 1, inputTokens: 10, outputTokens: 20, costUsd: 0.01, wallTimeMs: 30 },
      },
      dossier,
      claims: [],
    };
    expect(researchDossierSchema.parse(dossier)).toEqual(dossier);
    expect(researchPublicationDraftSchema.parse(base).dossier).toEqual(dossier);
    expect(researchPublicationDraftSchema.parse({
      ...base,
      status: "partial",
      reason: "corpus_became_stale",
    }).reason).toBe("corpus_became_stale");
    expect(() => researchPublicationDraftSchema.parse({
      ...base,
      status: "partial",
      reason: null,
    })).toThrow(/reason/i);
    expect(() => researchPublicationDraftSchema.parse({
      ...base,
      reason: "budget_exhausted",
    })).toThrow(/reason/i);
    expect(() => researchDossierSchema.parse({
      ...dossier,
      capabilities: Array.from({ length: 65 }, () => "x".repeat(4096)),
    })).toThrow(/256 KiB/i);
    const boundedEvidence = {
      kind: "tab_content" as const,
      sourceId: 1,
      locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 1 },
      excerptHash: hash,
    };
    expect(() => researchClaimListSchema.parse(Array.from({ length: 33 }, () => ({
      claim: "x".repeat(16_384),
      confidence: 1,
      isInference: false,
      rationale: null,
      evidence: [boundedEvidence],
    })))).toThrow(/512 KiB/i);
    for (const legacy of [
      { text: "caller-supplied report" },
      { structured: dossier },
      { dossier: { ...dossier, attackerField: true } },
    ]) {
      expect(() => researchPublicationDraftSchema.parse({ ...base, ...legacy })).toThrow();
    }
    expect(researchApprovalRequestSchema.parse({
      version: 1, target: { type: "page", logicalPageId: 1 }, question: "q",
      scope: { acquisitionLevel: "captured_only", includeShareableContext: false,
        maxIncludedSources: 1, privacyConfirmation: { confirmed: true,
          authenticatedOriginDigests: [], sensitiveOriginDigests: [] } },
      parentReportId: null, approvalFingerprint: hash,
      workflowRef: { id: "w", version: 1 },
      budget: { maxSteps: 100, maxTokens: 200000, maxCostUsd: 2,
        maxWallTimeMs: 1800000 },
      estimate: zeroEstimate,
      captureIntent: { selectedTabIds: [], knownFailures: [] },
    }).budget).toEqual({
      maxSteps: 100, maxTokens: 200000, maxCostUsd: 2, maxWallTimeMs: 1800000,
    });
    expect(() => researchApprovedDraftSchema.parse({
      version: 1, target: { type: "page", logicalPageId: 1 }, question: "q",
      scope: { acquisitionLevel: "captured_only", includeShareableContext: false,
        maxIncludedSources: 1, privacyConfirmation: { confirmed: true,
          authenticatedOriginDigests: [], sensitiveOriginDigests: [] } },
      parentReportId: null, approvalFingerprint: hash, corpusFingerprint: hash,
      workflowRef: { id: "w", version: 1 },
      budget: { maxSteps: 101, maxTokens: 200001, maxCostUsd: 2, maxWallTimeMs: 1800001 },
      estimate: zeroEstimate,
      sources: [{ ordinal: 1, logicalPageId: 1, tabId: null, contentRevision: null,
        contentDigest: null, extractedAt: null, acquisitionMethod: "inventory",
        accessClass: "public",
        eligibility: "not_captured", inclusionState: "missing", failureCode: null,
        includedOrder: null, payload: null }],
    })).toThrow();
    expect(researchEvidenceDraftSchema.parse({
      kind: "tab_content", sourceId: 1,
      locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 3 },
      excerptHash: hash,
    }).locator).toEqual({ version: "utf8_range:v1", byteStart: 0, byteEnd: 3 });
    expect(researchEvidenceDraftSchema.parse({
      kind: "activity", snapshotId: 1,
      locator: { version: "whole_snapshot:v1" }, excerptHash: hash,
    }).locator).toEqual({ version: "whole_snapshot:v1" });
    for (const invalidEvidence of [
      { kind: "tab_content", sourceId: 1, locator: { chunk: 0 }, excerptHash: hash },
      { kind: "tab_content", sourceId: 1,
        locator: { version: "utf8_range:v1", byteStart: 3, byteEnd: 3 }, excerptHash: hash },
      { kind: "activity", snapshotId: 1,
        locator: { version: "utf8_range:v1", byteStart: 0, byteEnd: 1 }, excerptHash: hash },
      { kind: "activity", snapshotId: 1,
        locator: { version: "whole_snapshot:v1", extra: true }, excerptHash: hash },
    ]) {
      expect(() => researchEvidenceDraftSchema.parse(invalidEvidence)).toThrow();
    }
  });

  it("freezes the captured_text_chunks:v1 manifest shape", () => {
    expect(researchCapturedTextChunkManifestSchema.parse({
      version: "captured_text_chunks:v1",
      byteStart: 0,
      byteEnd: 65_536,
      chunkDigest: hash,
      truncated: true,
    })).toEqual({
      version: "captured_text_chunks:v1",
      byteStart: 0,
      byteEnd: 65_536,
      chunkDigest: hash,
      truncated: true,
    });
    expect(() => researchCapturedTextChunkManifestSchema.parse({
      version: 1, byteStart: 0, byteEnd: 1, chunkDigest: hash, truncated: false,
    })).toThrow();
  });

  it("bounds and discriminates report history queries and descending list results", () => {
    expect(researchReportListQuerySchema.parse({
      targetType: "page", targetId: "41", limit: "25", beforeVersion: "8",
    })).toEqual({ targetType: "page", targetId: 41, limit: 25, beforeVersion: 8 });
    expect(researchReportListQuerySchema.parse({
      targetType: "selection", targetId: hash,
    })).toEqual({ targetType: "selection", targetId: hash, limit: 50 });
    expect(researchReportIdParamsSchema.parse({ id: "9" })).toEqual({ id: 9 });
    expect(researchReportIdParamsSchema.parse({ id: String(Number.MAX_SAFE_INTEGER) }))
      .toEqual({ id: Number.MAX_SAFE_INTEGER });
    for (const invalid of [
      { targetType: "page", targetId: hash },
      { targetType: "selection", targetId: "41" },
      { targetType: "resource", targetId: "0" },
      { targetType: "page", targetId: "041" },
      { targetType: "page", targetId: "1e2" },
      { targetType: "page", targetId: "+41" },
      { targetType: "page", targetId: " 41" },
      { targetType: "page", targetId: "41", limit: "5.0" },
      { targetType: "page", targetId: "41", beforeVersion: "08" },
      { targetType: "page", targetId: "9007199254740992" },
      { targetType: "page", targetId: "41", limit: "101" },
      { targetType: "page", targetId: "41", attackerField: true },
    ]) {
      expect(() => researchReportListQuerySchema.parse(invalid)).toThrow();
    }
    for (const id of ["09", "1e2", "+9", " 9", "9.0", "9007199254740992"]) {
      expect(() => researchReportIdParamsSchema.parse({ id })).toThrow();
    }

    const coverage = {
      discovered: 2, captured: 1, eligible: 1, used: 1, missing: 1, failed: 0,
    };
    const item = {
      id: 9,
      runId: 12,
      jobId: "resource_research:15",
      version: 2,
      parentReportId: 8,
      publishStatus: "succeeded" as const,
      state: "fresh" as const,
      reason: null,
      coverage,
      createdAt: "2026-08-14T00:00:00.000Z",
      executiveSummary: "Current summary",
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: true,
        isLastSuccessful: true,
      },
    };
    const response = {
      target: { type: "page" as const, logicalPageId: 41 },
      head: {
        latestPublishedReportId: 9,
        currentFreshReportId: 9,
        lastSuccessfulReportId: 9,
      },
      latestRun: {
        runId: 12,
        jobId: "resource_research:15",
        status: "succeeded" as const,
        parentReportId: 8,
        reportId: 9,
        createdAt: "2026-08-14T00:00:00.000Z",
      },
      items: [item, {
        ...item,
        id: 8,
        runId: 11,
        jobId: "resource_research:14",
        version: 1,
        parentReportId: null,
        state: "stale" as const,
        createdAt: "2026-08-13T00:00:00.000Z",
        executiveSummary: "Older summary",
        headFlags: {
          isLatestPublished: false,
          isCurrentFresh: false,
          isLastSuccessful: false,
        },
      }],
      nextBeforeVersion: null,
    };
    expect(researchReportListResponseSchema.parse(response).items.map((entry) => entry.version))
      .toEqual([2, 1]);
    expect(() => researchReportListResponseSchema.parse({
      ...response, items: [...response.items].reverse(),
    })).toThrow(/descending/i);
    expect(() => researchReportListResponseSchema.parse({
      ...response,
      items: [{ ...item, state: "redacted", executiveSummary: "must not survive" }],
    })).toThrow(/redacted/i);
    expect(() => researchReportListResponseSchema.parse({ ...response, extra: true })).toThrow();
  });

  it("validates full local report detail and nulls all redacted material", () => {
    const dossier = {
      executiveSummary: "Executive summary",
      valueForUser: "Useful because it saves review time",
      capabilities: ["Indexes captured evidence"],
      limitations: ["Captured sources only"],
      risks: ["Sources may become stale"],
      unknowns: ["Long-term value"],
      nextSteps: ["Review the strongest claim"],
    };
    const detail = {
      id: 9,
      runId: 12,
      jobId: "resource_research:15",
      runStatus: "succeeded" as const,
      target: { type: "page" as const, logicalPageId: 41 },
      version: 2,
      parentReportId: 8,
      publishStatus: "succeeded" as const,
      state: "fresh" as const,
      reason: null,
      coverage: { discovered: 2, captured: 1, eligible: 1, used: 1, missing: 1, failed: 0 },
      createdAt: "2026-08-14T00:00:00.000Z",
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: true,
        isLastSuccessful: true,
      },
      dossier,
      reportText: "# Executive summary\n\nExecutive summary",
      provenance: {
        provider: "provider", model: "model", promptVersion: "prompt-v1",
        pricingVersion: "pricing-v1", requestId: "request-1",
        generatedAt: "2026-08-14T00:00:00.000Z", inputFingerprint: hash,
        terminalAttemptId: 18,
        usage: { steps: 3, inputTokens: 100, outputTokens: 50, costUsd: 0.02,
          wallTimeMs: 500 },
      },
      claims: [{
        id: 21,
        ordinal: 1,
        claimDigest: hash,
        claimText: "The source supports the claim.",
        confidence: 0.9,
        isInference: false,
        rationaleDigest: null,
        rationale: null,
        evidence: [{
          id: 31,
          ordinal: 1,
          kind: "tab_content" as const,
          sourceId: 7,
          sourceKind: "captured" as const,
          acquisitionMethod: "captured" as const,
          contentRevision: 3,
          contentDigest: hash,
          state: "valid" as const,
          stateReason: null,
          locatorDigest: hash,
          locator: { version: "utf8_range:v1" as const, byteStart: 0, byteEnd: 6 },
          excerptHash: hash,
          excerpt: "source",
          url: "https://research.openai.com/report",
          title: "Research report",
        }, {
          id: 32,
          ordinal: 2,
          kind: "activity" as const,
          snapshotId: 4,
          state: "valid" as const,
          stateReason: null,
          locatorDigest: hash,
          locator: { version: "whole_snapshot:v1" as const },
          excerptHash: hash,
          excerpt: '{"engagedMs":100}',
        }],
      }, {
        id: 22,
        ordinal: 2,
        claimDigest: "b".repeat(64),
        claimText: "The resource may remain useful.",
        confidence: 0.6,
        isInference: true,
        rationaleDigest: "c".repeat(64),
        rationale: "The captured capabilities remain relevant.",
        evidence: [],
      }],
    };
    expect(researchReportDetailSchema.parse(detail).provenance).toMatchObject({
      terminalAttemptId: 18,
      usage: { inputTokens: 100 },
    });
    const agentDetail = projectAgentResearchReportDetail(
      researchReportDetailSchema.parse(detail),
    );
    expect(agentDetail).toMatchObject({ dossier, reportText: detail.reportText });
    expect(agentDetail.claims[0]).toMatchObject({
      claimText: "The source supports the claim.",
    });
    expect(agentDetail.claims[0]?.evidence[0]).toMatchObject({
      kind: "tab_content",
      contentDigest: hash,
      locatorDigest: hash,
      excerptHash: hash,
    });
    for (const forbidden of [
      "https://research.openai.com/report",
      "Research report",
      '\"excerpt\":\"source\"',
      '\"locator\":',
      "byteStart",
      "whole_snapshot",
    ]) {
      expect(JSON.stringify(agentDetail)).not.toContain(forbidden);
    }
    expect(() => researchReportDetailSchema.parse({
      ...detail,
      provenance: { ...detail.provenance, terminalAttemptId: 0 },
    })).toThrow();
    expect(() => researchReportDetailSchema.parse({
      ...detail,
      provenance: { ...detail.provenance, rawProviderBody: "secret" },
    })).toThrow();
    expect(() => researchReportDetailSchema.parse({
      ...detail,
      claims: detail.claims.map((claim) => claim.id === 22
        ? { ...claim, rationaleDigest: null }
        : claim),
    })).toThrow(/rationale digest/i);

    const redacted = {
      ...detail,
      state: "redacted" as const,
      headFlags: {
        isLatestPublished: true,
        isCurrentFresh: false,
        isLastSuccessful: true,
      },
      dossier: null,
      reportText: null,
      claims: detail.claims.map((claim) => ({
        ...claim,
        claimText: null,
        rationale: null,
        evidence: claim.evidence.map((evidence) => ({
          ...evidence,
          state: "redacted" as const,
          stateReason: "Report redacted",
          locator: null,
          excerpt: null,
          ...(evidence.kind === "tab_content" ? { url: null, title: null } : {}),
        })),
      })),
    };
    const parsedRedacted = researchReportDetailSchema.parse(redacted);
    const agentRedacted = projectAgentResearchReportDetail(parsedRedacted);
    expect(agentRedacted).toMatchObject({ dossier: null, reportText: null });
    expect(agentRedacted.claims.every((claim) =>
      claim.claimText === null && claim.rationale === null)).toBe(true);
    expect(parsedRedacted).toMatchObject({ dossier: null, reportText: null });
    expect(parsedRedacted.claims[0]).toMatchObject({
      claimDigest: hash,
      claimText: null,
      rationaleDigest: null,
    });
    expect(parsedRedacted.claims[1]).toMatchObject({
      claimDigest: "b".repeat(64),
      claimText: null,
      rationaleDigest: "c".repeat(64),
      rationale: null,
    });
    expect(parsedRedacted.runStatus).toBe("succeeded");
    expect(parsedRedacted.claims[0]?.evidence[0]).toMatchObject({
      contentRevision: 3,
      contentDigest: hash,
      locatorDigest: hash,
    });
    expect(parsedRedacted.claims[0]?.evidence.every((evidence) =>
      evidence.locator === null && evidence.excerpt === null)).toBe(true);
    expect(() => researchReportDetailSchema.parse({
      ...redacted,
      reportText: "resurrected material",
    })).toThrow(/redacted/i);
    expect(() => researchReportDetailSchema.parse({
      ...detail,
      dossier: null,
    })).toThrow(/non-redacted/i);
    expect(() => researchReportDetailSchema.parse({
      ...detail,
      runStatus: "failed",
    })).toThrow(/run status/i);
  });
});
