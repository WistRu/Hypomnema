import {
  agentResearchStartRequestSchema,
  aiTaskSpecSchema,
  durableJobIdSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  type AiTaskSpec,
  type AgentResearchStartRequest,
  type DurableJobId,
  type DurableJobKind,
  type DurableJobRef,
  type DurableJobView,
  type PriorityAssessmentTaskSpec,
  type ResearchApprovalRequest,
  type ResourceResearchTaskSpec,
} from "@tabhub/shared";

import type { SummaryJobAdapter } from "./summary-job-adapter.js";

export type DurableAiJobErrorCode =
  | "INVALID_JOB_ID"
  | "INVALID_JOB_INPUT"
  | "JOB_SUBJECT_NOT_FOUND"
  | "JOB_INPUT_UNAVAILABLE"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_CANCELLABLE"
  | "JOB_ACTIVE_CONFLICT"
  | "JOB_KIND_UNAVAILABLE"
  | "JOB_BUDGET_EXHAUSTED"
  | "JOB_LEASE_LOST"
  | "JOB_CLOCK_REGRESSION"
  | "RESEARCH_SCOPE_TOO_LARGE"
  | "RESEARCH_PREFLIGHT_STALE"
  | "RESEARCH_CAPTURE_REQUIRED"
  | "INVALID_JOB_TRANSITION"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "JOB_STORAGE_CORRUPT";

export class DurableAiJobError extends Error {
  constructor(
    readonly code: DurableAiJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DurableAiJobError";
  }
}

export type NewAiTaskSpec =
  | PriorityAssessmentTaskSpec
  | ResourceResearchTaskSpec;

export interface NewAiJobAdapter {
  replayAgentResearchStart?(
    request: AgentResearchStartRequest,
  ): DurableJobRef | undefined;
  submit(task: NewAiTaskSpec): DurableJobRef;
  submitResearch?(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
  ): DurableJobRef;
  submitAgentResearch?(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
    command: AgentResearchCommand,
  ): DurableJobRef;
  get(
    kind: Exclude<DurableJobKind, "page_summary">,
    id: number,
  ): DurableJobView | undefined;
  cancel(
    kind: Exclude<DurableJobKind, "page_summary">,
    id: number,
    requestedBy?: "user" | "agent",
  ): DurableJobView;
  cancelAgentResearch?(id: number, command: AgentResearchCommand): DurableJobView;
}

export interface AgentResearchCommand {
  readonly idempotencyKey: string;
  readonly authorizationRef: string;
}

export interface DurableAiJobs {
  replayAgentResearchStart(
    request: AgentResearchStartRequest,
  ): DurableJobRef | undefined;
  submit(task: AiTaskSpec): DurableJobRef;
  submitResearch(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
  ): DurableJobRef;
  submitAgentResearch(
    task: ResourceResearchTaskSpec,
    request: ResearchApprovalRequest,
    command: AgentResearchCommand,
  ): DurableJobRef;
  get(id: DurableJobId): DurableJobView;
  cancel(id: DurableJobId): DurableJobView;
  cancelAgentResearch(id: DurableJobId, command: AgentResearchCommand): DurableJobView;
}

interface ParsedJobId {
  kind: "summary" | "priority_assessment" | "resource_research";
  id: number;
}

function parseJobId(value: unknown): ParsedJobId {
  const parsed = durableJobIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableAiJobError("INVALID_JOB_ID", "Invalid durable job ID");
  }
  const separator = parsed.data.indexOf(":");
  return {
    kind: parsed.data.slice(0, separator) as ParsedJobId["kind"],
    id: Number(parsed.data.slice(separator + 1)),
  };
}

function parseView(value: DurableJobView): DurableJobView {
  const parsed = durableJobViewSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "Stored job is invalid");
  }
  return parsed.data;
}

export function createDurableAiJobs(dependencies: {
  readonly summary: SummaryJobAdapter;
  readonly newJobs: NewAiJobAdapter;
}): DurableAiJobs {
  return {
    replayAgentResearchStart(value) {
      const parsed = agentResearchStartRequestSchema.safeParse(value);
      if (!parsed.success || dependencies.newJobs.replayAgentResearchStart === undefined) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research replay");
      }
      const ref = dependencies.newJobs.replayAgentResearchStart(parsed.data);
      if (ref === undefined) return undefined;
      const validRef = durableJobRefSchema.safeParse(ref);
      if (!validRef.success || validRef.data.kind !== "resource_research") {
        throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "Stored job reference is invalid");
      }
      return validRef.data;
    },

    submit(value) {
      const parsed = aiTaskSpecSchema.safeParse(value);
      if (!parsed.success) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid AI job input");
      }
      const ref = parsed.data.kind === "page_summary"
        ? dependencies.summary.submit(parsed.data)
        : dependencies.newJobs.submit(parsed.data);
      const validRef = durableJobRefSchema.safeParse(ref);
      if (!validRef.success) {
        throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "Stored job reference is invalid");
      }
      return validRef.data;
    },

    submitResearch(value, approvedDraft) {
      const parsed = aiTaskSpecSchema.safeParse(value);
      if (!parsed.success || parsed.data.kind !== "resource_research" ||
          dependencies.newJobs.submitResearch === undefined) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid research submission");
      }
      const ref = dependencies.newJobs.submitResearch(parsed.data, approvedDraft);
      const validRef = durableJobRefSchema.safeParse(ref);
      if (!validRef.success) {
        throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "Stored job reference is invalid");
      }
      return validRef.data;
    },

    submitAgentResearch(value, approvedDraft, command) {
      const parsed = aiTaskSpecSchema.safeParse(value);
      if (!parsed.success || parsed.data.kind !== "resource_research" ||
          dependencies.newJobs.submitAgentResearch === undefined) {
        throw new DurableAiJobError("INVALID_JOB_INPUT", "Invalid agent research submission");
      }
      const ref = dependencies.newJobs.submitAgentResearch(parsed.data, approvedDraft, command);
      const validRef = durableJobRefSchema.safeParse(ref);
      if (!validRef.success) {
        throw new DurableAiJobError("JOB_STORAGE_CORRUPT", "Stored job reference is invalid");
      }
      return validRef.data;
    },

    get(value) {
      const parsed = parseJobId(value);
      const view = parsed.kind === "summary"
        ? dependencies.summary.get(parsed.id)
        : dependencies.newJobs.get(parsed.kind, parsed.id);
      if (view === undefined) {
        throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
      }
      return parseView(view);
    },

    cancel(value) {
      const parsed = parseJobId(value);
      if (parsed.kind === "summary") {
        if (dependencies.summary.get(parsed.id) === undefined) {
          throw new DurableAiJobError("JOB_NOT_FOUND", "AI job does not exist");
        }
        throw new DurableAiJobError(
          "JOB_NOT_CANCELLABLE",
          "Legacy summary jobs cannot be cancelled",
        );
      }
      return parseView(dependencies.newJobs.cancel(parsed.kind, parsed.id));
    },

    cancelAgentResearch(value, command) {
      const parsed = parseJobId(value);
      if (parsed.kind !== "resource_research" ||
          dependencies.newJobs.cancelAgentResearch === undefined) {
        throw new DurableAiJobError("JOB_NOT_CANCELLABLE", "Only agent research jobs can be cancelled");
      }
      return parseView(dependencies.newJobs.cancelAgentResearch(parsed.id, command));
    },
  };
}
