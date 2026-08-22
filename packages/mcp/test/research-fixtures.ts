import {
  agentResearchReportDetailSchema,
  agentResearchStartResponseSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  researchReportListResponseSchema,
} from "@tabhub/shared";

export const researchDigest = (value: string) => value.repeat(64).slice(0, 64);
export const authenticatedOriginDigest = researchDigest("a");
export const sensitiveOriginDigest = researchDigest("b");
export const timestamp = "2026-08-14T10:00:00.000Z";
export const researchBudget = {
  maxSteps: 4,
  maxTokens: 8_000,
  maxCostUsd: 0.5,
  maxWallTimeMs: 30_000,
};

export const privateResearchCanaries = [
  "https://private.example/path?token=secret",
  "PRIVATE TITLE CANARY",
  "PRIVATE EXCERPT CANARY",
  "PRIVATE LOCATOR CANARY",
  "PRIVATE ORIGIN CANARY",
  "PRIVATE LOCAL CONTEXT CANARY",
  "PRIVATE RAW PROMPT CANARY",
  "PRIVATE PROVIDER BODY CANARY",
  "PRIVATE PROVIDER ERROR CANARY",
  "PRIVATE CAPABILITY SECRET CANARY",
];

export const researchJobRef = durableJobRefSchema.parse({
  id: "resource_research:41",
  kind: "resource_research",
  status: "queued",
});

export const confirmationRequired = agentResearchStartResponseSchema.parse({
  status: "confirmation_required",
  confirmationRequirements: {
    authenticatedOriginDigests: [authenticatedOriginDigest],
    sensitiveOriginDigests: [sensitiveOriginDigest],
  },
});

export const queuedResearchJob = durableJobViewSchema.parse({
  ...researchJobRef,
  subject: { type: "page", logicalPageId: 1 },
  attempts: 0,
  maxAttempts: 3,
  progress: { completed: 0, total: 1, stage: "queued" },
  canCancel: true,
  cancellationRequest: null,
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
  nextAttemptAt: timestamp,
  error: null,
  result: null,
});

export const cancelledResearchJob = durableJobViewSchema.parse({
  ...queuedResearchJob,
  status: "cancelled",
  progress: { completed: 0, total: 1, stage: "cancelled" },
  canCancel: false,
  cancellationRequest: { requestedBy: "agent", requestedAt: timestamp },
  completedAt: timestamp,
  nextAttemptAt: null,
});

const coverage = {
  discovered: 1,
  captured: 1,
  eligible: 1,
  used: 1,
  missing: 0,
  failed: 0,
};
const headFlags = {
  isLatestPublished: true,
  isCurrentFresh: true,
  isLastSuccessful: true,
};

export const agentResearchReportDetail = agentResearchReportDetailSchema.parse({
  id: 21,
  runId: 41,
  jobId: researchJobRef.id,
  runStatus: "succeeded",
  target: { type: "page", logicalPageId: 1 },
  version: 4,
  parentReportId: null,
  publishStatus: "succeeded",
  state: "fresh",
  reason: null,
  coverage,
  createdAt: timestamp,
  headFlags,
  dossier: {
    executiveSummary: "Safe research conclusion",
    valueForUser: "Useful for the active project",
    capabilities: ["Compare captured evidence"],
    limitations: [],
    risks: [],
    unknowns: [],
    nextSteps: ["Review the conclusion"],
  },
  reportText: "# Safe research conclusion",
  provenance: {
    provider: "fixture",
    model: "fixture-model",
    promptVersion: "fixture-v1",
    pricingVersion: "fixture-pricing-v1",
    requestId: "fixture-request-1",
    generatedAt: timestamp,
    usage: {
      steps: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      wallTimeMs: 50,
    },
    inputFingerprint: researchDigest("c"),
    terminalAttemptId: 8,
  },
  claims: [{
    id: 31,
    ordinal: 1,
    claimDigest: researchDigest("d"),
    claimText: "The captured resource is useful.",
    confidence: 0.9,
    isInference: false,
    rationaleDigest: null,
    rationale: null,
    evidence: [{
      id: 51,
      ordinal: 1,
      kind: "tab_content",
      sourceId: 61,
      sourceKind: "captured",
      acquisitionMethod: "captured",
      contentRevision: 3,
      contentDigest: researchDigest("e"),
      state: "valid",
      stateReason: null,
      locatorDigest: researchDigest("f"),
      excerptHash: researchDigest("1"),
    }],
  }],
});

export const redactedAgentResearchReportDetail =
  agentResearchReportDetailSchema.parse({
    ...agentResearchReportDetail,
    id: 22,
    jobId: "resource_research:42",
    version: 3,
    state: "redacted",
    headFlags: {
      isLatestPublished: false,
      isCurrentFresh: false,
      isLastSuccessful: false,
    },
    dossier: null,
    reportText: null,
    claims: agentResearchReportDetail.claims.map((claim) => ({
      ...claim,
      claimText: null,
      rationale: null,
      evidence: claim.evidence.map((evidence) => ({
        ...evidence,
        state: "redacted" as const,
        stateReason: "User requested removal",
      })),
    })),
  });

export const researchReportList = researchReportListResponseSchema.parse({
  target: { type: "page", logicalPageId: 1 },
  head: {
    latestPublishedReportId: 21,
    currentFreshReportId: 21,
    lastSuccessfulReportId: 21,
  },
  latestRun: {
    runId: 41,
    jobId: researchJobRef.id,
    status: "succeeded",
    parentReportId: null,
    reportId: 21,
    createdAt: timestamp,
  },
  items: [{
    id: 21,
    runId: 41,
    jobId: researchJobRef.id,
    version: 4,
    parentReportId: null,
    publishStatus: "succeeded",
    state: "fresh",
    reason: null,
    coverage,
    createdAt: timestamp,
    executiveSummary: "Safe research conclusion",
    headFlags,
  }],
  nextBeforeVersion: 3,
});
