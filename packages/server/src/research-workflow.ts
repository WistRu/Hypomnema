import { createHash } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  agentResearchCancelRequestSchema,
  agentResearchRunApprovalRequestSchema,
  agentResearchStartRequestSchema,
  agentResearchStartResponseSchema,
  durableJobIdSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  estimateResearchReservationV1,
  researchCanonicalSha256PayloadV1,
  researchPreflightRequestSchema,
  researchPreflightSchema,
  researchRedactionReceiptSchema,
  researchRedactionRequestSchema,
  researchRunApprovalRequestSchema,
  researchSafePageManifestEntrySchema,
  researchWorkflowApprovalFingerprintPayloadV1,
  type DurableJobId,
  type DurableJobRef,
  type DurableJobView,
  type AgentResearchCancelRequest,
  type AgentResearchRunApprovalRequest,
  type AgentResearchStartRequest,
  type AgentResearchStartResponse,
  type ResearchApprovedDraft,
  type ResearchApprovalRequest,
  type ResearchPreflight,
  type ResearchPreflightRequest,
  type ResearchRedactionReceipt,
  type ResearchRedactionRequest,
  type ResearchRunApprovalRequest,
  type ResearchSafeSnapshotManifestEntry,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";

export const researchWorkflowRefV1 = Object.freeze({
  id: "research_workflow:c81:v1",
  version: 1,
} as const);

type ExclusionReason =
  | "invalid_url" | "browser_internal" | "extension" | "file" | "data"
  | "unsupported_scheme" | "embedded_credentials" | "localhost" | "private_ip"
  | "private_hostname" | "registrable_domain_unavailable" | "weak_sensitive_signal"
  | "empty_captured_text" | "source_limit" | "corpus_byte_limit";
type ExclusionCategory = "format" | "privacy" | "size" | "limit";

export interface ResearchCurrentProjection {
  readonly draft: ResearchApprovedDraft;
  readonly sources: readonly {
    readonly ordinal: number;
    readonly exclusionReason: ExclusionReason | null;
    readonly exclusionCategory: ExclusionCategory | null;
    readonly originDigest: string | null;
    readonly originDisplay?: string | null;
    readonly confirmationRequired: boolean;
  }[];
}

export type ResearchPreflightInput = Omit<ResearchPreflightRequest, "confirmedOrigins"> & {
  readonly confirmedOrigins?: ResearchPreflightRequest["confirmedOrigins"];
};

export interface ResearchWorkflowDependencies {
  readonly current: (request: ResearchApprovalRequest) => ResearchCurrentProjection;
  readonly parentAvailability?: (
    target: ResearchPreflightRequest["target"],
    parentReportId: number,
  ) => "available" | "not_found" | "unavailable";
  readonly submitResearch: (
    task: ResourceResearchTaskSpec,
    approval: ResearchApprovalRequest,
  ) => DurableJobRef;
  readonly submitAgentResearch?: (
    task: ResourceResearchTaskSpec,
    approval: ResearchApprovalRequest,
    command: { readonly idempotencyKey: string; readonly authorizationRef: string },
  ) => DurableJobRef;
  readonly replayAgentResearchStart?: (
    request: AgentResearchStartRequest,
  ) => DurableJobRef | undefined;
  readonly cancelResearch: (jobId: DurableJobId) => DurableJobView;
  readonly cancelAgentResearch?: (
    jobId: DurableJobId,
    command: AgentResearchCancelRequest,
  ) => DurableJobView;
  readonly redactResearch: (request: ResearchRedactionRequest) => ResearchRedactionReceipt;
}

export type ResearchWorkflowErrorCode =
  | "RESEARCH_PARENT_NOT_FOUND"
  | "RESEARCH_PARENT_UNAVAILABLE"
  | "RESEARCH_PREFLIGHT_STALE";

export class ResearchWorkflowError extends Error {
  constructor(readonly code: ResearchWorkflowErrorCode, message: string) {
    super(message);
    this.name = "ResearchWorkflowError";
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function toInternalApproval(
  request: ResearchPreflightRequest,
  approvalFingerprint: string,
  estimate: ResearchApprovalRequest["estimate"] = estimateResearchReservationV1({
    includedSources: 0,
    includedSourceBytes: 0,
    snapshotBytes: 0,
    questionBytes: 0,
    budget: request.budget,
  }),
): ResearchApprovalRequest {
  return {
    version: 1,
    target: request.target,
    question: request.question,
    scope: {
      acquisitionLevel: "captured_only",
      includeShareableContext: request.includeShareableContext,
      maxIncludedSources: request.maxIncludedSources,
      privacyConfirmation: {
        confirmed: true,
        authenticatedOriginDigests: request.confirmedOrigins.authenticatedOriginDigests,
        sensitiveOriginDigests: request.confirmedOrigins.sensitiveOriginDigests,
      },
    },
    parentReportId: request.parentReportId,
    approvalFingerprint,
    workflowRef: researchWorkflowRefV1,
    budget: request.budget,
    estimate,
    captureIntent: request.captureIntent,
  };
}

function sameFingerprintSets(
  left: ResearchPreflightRequest["confirmedOrigins"],
  right: ResearchPreflight["confirmationRequirements"],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isCanonicalFingerprintSet(value: readonly string[]): boolean {
  return value.every((item, index) => index === 0 || value[index - 1]! < item);
}

function snapshotProjection(snapshot: ResearchApprovedDraft["snapshots"] extends
  readonly (infer Snapshot)[] | undefined ? Snapshot : never):
  ResearchSafeSnapshotManifestEntry {
  const material = snapshot.material;
  const truncated = Object.entries(material).some(([key, value]) =>
    key.toLowerCase().endsWith("truncated") && value === true);
  const common = {
    ordinal: snapshot.ordinal,
    snapshotDigest: snapshot.snapshotDigest,
    materialBytes: researchCanonicalSha256PayloadV1(material).byteLength,
    truncated,
  };
  switch (snapshot.kind) {
    case "page_context":
      return { ...common, kind: "page_context", contextEntryId: snapshot.contextEntryId,
        logicalPageId: snapshot.logicalPageId };
    case "resource_context":
      return { ...common, kind: "resource_context", contextEntryId: snapshot.contextEntryId,
        resourceId: snapshot.resourceId };
    case "activity":
      return { ...common, kind: "activity", logicalPageId: snapshot.logicalPageId,
        activityDate: snapshot.activityDate };
    case "relation":
      return { ...common, kind: "relation", relationId: snapshot.relationId };
  }
}

function coverage(draft: ResearchApprovedDraft) {
  return {
    discovered: draft.sources.length,
    captured: draft.sources.filter((source) =>
      source.inclusionState === "included" || source.inclusionState === "excluded").length,
    eligible: draft.sources.filter((source) => source.eligibility === "eligible").length,
    used: 0,
    missing: draft.sources.filter((source) => source.inclusionState === "missing").length,
    failed: draft.sources.filter((source) => source.inclusionState === "failed").length,
  };
}

export function projectResearchPreflight(
  request: ResearchPreflightRequest,
  projection: ResearchCurrentProjection,
): ResearchPreflight {
  const details = new Map(projection.sources.map((source) => [source.ordinal, source]));
  const manifest: ResearchPreflight["manifest"] = projection.draft.sources.map((source) => {
    const detail = details.get(source.ordinal);
    if (detail === undefined) throw new Error("Research source projection is incomplete");
    const common = {
      acquisitionMethod: source.acquisitionMethod,
      ordinal: source.ordinal,
      logicalPageId: source.logicalPageId,
      contentRevision: source.contentRevision,
      contentDigest: source.contentDigest,
      state: source.inclusionState === "included" ? "captured" : source.inclusionState,
      exclusionReason: detail.exclusionReason,
      exclusionCategory: detail.exclusionCategory,
      accessClass: source.accessClass,
      originDigest: detail.originDigest,
      requiresConfirmation: detail.confirmationRequired,
      failureCode: "failureCode" in source ? source.failureCode : null,
      capturedChunkManifest: source.payload?.chunkManifest ?? null,
    };
    return researchSafePageManifestEntrySchema.parse({
      ...common,
      sourceKind: source.sourceKind,
      selectedTabId: source.sourceKind === "live_acquisition"
        ? null
        : (source.selectedTabId ?? source.tabId),
    });
  });
  const snapshots: ResearchPreflight["snapshots"] =
    (projection.draft.snapshots ?? []).map(snapshotProjection);
  const authenticatedOriginDigests = [...new Set(manifest
    .filter((source) => source.requiresConfirmation && source.accessClass === "authenticated")
    .map((source) => source.originDigest!))].sort();
  const sensitiveOriginDigests = [...new Set(manifest
    .filter((source) => source.requiresConfirmation && source.accessClass === "sensitive")
    .map((source) => source.originDigest!))].sort();
  const confirmationDisplay = [
    ...authenticatedOriginDigests.map((originDigest) => {
      const source = projection.sources.find((candidate) =>
        candidate.confirmationRequired && candidate.originDigest === originDigest);
      if (source?.originDisplay === null || source?.originDisplay === undefined) {
        throw new Error("Research confirmation display is incomplete");
      }
      if (createHash("sha256").update(source.originDisplay, "utf8").digest("hex") !==
          originDigest) {
        throw new Error("Research confirmation display digest is inconsistent");
      }
      return { accessClass: "authenticated" as const, originDigest, origin: source.originDisplay };
    }),
    ...sensitiveOriginDigests.map((originDigest) => {
      const source = projection.sources.find((candidate) =>
        candidate.confirmationRequired && candidate.originDigest === originDigest);
      if (source?.originDisplay === null || source?.originDisplay === undefined) {
        throw new Error("Research confirmation display is incomplete");
      }
      if (createHash("sha256").update(source.originDisplay, "utf8").digest("hex") !==
          originDigest) {
        throw new Error("Research confirmation display digest is inconsistent");
      }
      return { accessClass: "sensitive" as const, originDigest, origin: source.originDisplay };
    }),
  ];
  const included = projection.draft.sources.filter(
    (source) => source.inclusionState === "included",
  );
  const estimate = estimateResearchReservationV1({
    includedSources: included.length,
    includedSourceBytes: included.reduce((total, source) => total +
      utf8Bytes(source.payload?.evidenceMaterial ?? ""), 0),
    snapshotBytes: (projection.draft.snapshots ?? []).reduce((total, snapshot) =>
      total + researchCanonicalSha256PayloadV1(snapshot.material).byteLength, 0),
    questionBytes: utf8Bytes(request.question),
    budget: request.budget,
  });
  const limitations = [...new Set(manifest.flatMap((source) =>
    source.exclusionReason === null ? [] : [source.exclusionReason]))].sort();
  const resultWithoutFingerprint = {
    version: 1 as const,
    target: request.target,
    corpusFingerprint: projection.draft.corpusFingerprint,
    coverage: coverage(projection.draft),
    approvedBudget: request.budget,
    acquisitionLevel: "captured_only" as const,
    manifest,
    snapshots,
    confirmationRequirements: { authenticatedOriginDigests, sensitiveOriginDigests },
    confirmationDisplay,
    estimate,
    requiresConfirmation: authenticatedOriginDigests.length > 0 ||
      sensitiveOriginDigests.length > 0,
    limitations,
  };
  const confirmed = sameFingerprintSets(
    request.confirmedOrigins,
    resultWithoutFingerprint.confirmationRequirements,
  );
  const approvalFingerprint = confirmed
    ? createHash("sha256").update(researchWorkflowApprovalFingerprintPayloadV1(
        request,
        resultWithoutFingerprint,
      )).digest("hex")
    : null;
  return researchPreflightSchema.parse({
    ...resultWithoutFingerprint,
    approvalFingerprint,
  });
}

export function createResearchWorkflow(dependencies: ResearchWorkflowDependencies) {
  const prepareRun = (
    approval: ResearchRunApprovalRequest,
    provenance: ResourceResearchTaskSpec["provenance"],
  ) => {
    if (!isCanonicalFingerprintSet(approval.confirmedOrigins.authenticatedOriginDigests) ||
        !isCanonicalFingerprintSet(approval.confirmedOrigins.sensitiveOriginDigests)) {
      throw new ResearchWorkflowError(
        "RESEARCH_PREFLIGHT_STALE",
        "Research origin confirmations are not a canonical approved set",
      );
    }
    const preflightRequest: ResearchPreflightRequest = {
      version: 1,
      target: approval.target,
      question: approval.question,
      includeShareableContext: approval.includeShareableContext,
      maxIncludedSources: approval.maxIncludedSources,
      parentReportId: approval.parentReportId,
      budget: approval.budget,
      captureIntent: approval.captureIntent,
      confirmedOrigins: approval.confirmedOrigins,
    };
    const internalApproval = toInternalApproval(
      preflightRequest,
      approval.approvalFingerprint,
      approval.estimate,
    );
    const subject = approval.target.type === "page"
      ? { type: "page" as const, logicalPageId: approval.target.logicalPageId }
      : approval.target.type === "resource"
        ? { type: "resource" as const, resourceId: approval.target.resourceId }
        : { type: "selection" as const, fingerprint: approval.target.fingerprint };
    const task: ResourceResearchTaskSpec = {
      version: 1,
      kind: "resource_research",
      subject,
      workflowRef: researchWorkflowRefV1,
      inputFingerprint: approval.approvalFingerprint,
      idempotencyKey: approval.idempotencyKey,
      provenance,
      schedulingPriority: 0,
      budget: approval.budget,
    };
    return { task, internalApproval };
  };

  const preflight = (rawRequest: ResearchPreflightInput): ResearchPreflight => {
    const request = researchPreflightRequestSchema.parse(rawRequest);
    if (request.parentReportId !== null) {
      const availability = dependencies.parentAvailability?.(
        request.target, request.parentReportId,
      ) ?? "not_found";
      if (availability !== "available") {
        throw new ResearchWorkflowError(
          availability === "not_found"
            ? "RESEARCH_PARENT_NOT_FOUND" : "RESEARCH_PARENT_UNAVAILABLE",
          availability === "not_found"
            ? "Parent research report does not exist"
            : "Parent research report is unavailable for this target",
        );
      }
    }
    const projection = dependencies.current(toInternalApproval(request, "0".repeat(64)));
    return projectResearchPreflight(request, projection);
  };

  return {
    preflight,

    replayAgentStart(rawRequest: AgentResearchStartRequest): DurableJobRef | undefined {
      const request = agentResearchStartRequestSchema.parse(rawRequest);
      if (dependencies.replayAgentResearchStart === undefined) {
        throw new Error("Agent research replay is unavailable");
      }
      const replay = dependencies.replayAgentResearchStart(request);
      return replay === undefined ? undefined : durableJobRefSchema.parse(replay);
    },

    requestAgentStart(rawRequest: AgentResearchStartRequest): AgentResearchStartResponse {
      const request = agentResearchStartRequestSchema.parse(rawRequest);
      if (dependencies.replayAgentResearchStart === undefined ||
          dependencies.submitAgentResearch === undefined) {
        throw new Error("Agent research start is unavailable");
      }
      const replay = dependencies.replayAgentResearchStart(request);
      if (replay !== undefined) return agentResearchStartResponseSchema.parse(replay);

      const preflightRequest: ResearchPreflightRequest = {
        version: 1,
        target: request.target,
        question: request.question,
        includeShareableContext: request.includeShareableContext,
        maxIncludedSources: request.maxIncludedSources,
        parentReportId: null,
        budget: request.budget,
        captureIntent: { selectedTabIds: [], knownFailures: [] },
        confirmedOrigins: request.confirmedOrigins,
      };
      const current = preflight(preflightRequest);
      if (current.approvalFingerprint === null) {
        return agentResearchStartResponseSchema.parse({
          status: "confirmation_required",
          confirmationRequirements: current.confirmationRequirements,
        });
      }
      const approval = agentResearchRunApprovalRequestSchema.parse({
        ...preflightRequest,
        estimate: current.estimate,
        approvalFingerprint: current.approvalFingerprint,
        idempotencyKey: request.idempotencyKey,
        authorizationRef: request.authorizationRef,
      });
      const { authorizationRef, ...runApproval } = approval;
      const { task, internalApproval } = prepareRun(runApproval, {
        requestedBy: "agent",
        requestMethod: "on_behalf_of_user",
        authorizationRef,
      });
      return agentResearchStartResponseSchema.parse(dependencies.submitAgentResearch(
        task,
        internalApproval,
        {
          idempotencyKey: approval.idempotencyKey,
          authorizationRef,
        },
      ));
    },

    requestRun(rawApproval: ResearchRunApprovalRequest): DurableJobRef {
      const approval = researchRunApprovalRequestSchema.parse(rawApproval);
      const { task, internalApproval } = prepareRun(
        approval,
        { requestedBy: "user", requestMethod: "manual" },
      );
      return dependencies.submitResearch(task, internalApproval);
    },

    requestAgentRun(rawApproval: AgentResearchRunApprovalRequest): DurableJobRef {
      const approval = agentResearchRunApprovalRequestSchema.parse(rawApproval);
      const { authorizationRef, ...runApproval } = approval;
      const { task, internalApproval } = prepareRun(runApproval, {
        requestedBy: "agent",
        requestMethod: "on_behalf_of_user",
        authorizationRef,
      });
      if (dependencies.submitAgentResearch === undefined) {
        throw new Error("Agent research submission is unavailable");
      }
      return dependencies.submitAgentResearch(task, internalApproval, {
        idempotencyKey: approval.idempotencyKey,
        authorizationRef,
      });
    },

    cancel(rawJobId: DurableJobId): DurableJobView {
      const jobId = durableJobIdSchema.parse(rawJobId);
      if (!jobId.startsWith("resource_research:")) {
        throw new Error("ResearchWorkflow can cancel only resource research jobs");
      }
      return durableJobViewSchema.parse(dependencies.cancelResearch(jobId));
    },

    cancelAgent(
      rawJobId: DurableJobId,
      rawCommand: AgentResearchCancelRequest,
    ): DurableJobView {
      const jobId = durableJobIdSchema.parse(rawJobId);
      const command = agentResearchCancelRequestSchema.parse(rawCommand);
      if (!jobId.startsWith("resource_research:")) {
        throw new Error("ResearchWorkflow can cancel only resource research jobs");
      }
      if (dependencies.cancelAgentResearch === undefined) {
        throw new Error("Agent research cancellation is unavailable");
      }
      return durableJobViewSchema.parse(dependencies.cancelAgentResearch(jobId, command));
    },

    redact(rawRequest: ResearchRedactionRequest): ResearchRedactionReceipt {
      const request = researchRedactionRequestSchema.parse(rawRequest);
      return researchRedactionReceiptSchema.parse(dependencies.redactResearch(request));
    },
  };
}

export type ResearchWorkflow = ReturnType<typeof createResearchWorkflow>;
