import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  agentUserImportanceResponseSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  priorityFeedbackReceiptSchema,
  prioritySafeReadSchema,
  type PriorityFeedbackReceipt,
  type PrioritySafeRead,
  type PrioritySubjectContract,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpServer,
  type McpServerOptions,
  type TabHubApi,
} from "../src/server.js";
import { createTabHubApi } from "../src/tabhub-api.js";

const timestamp = "2026-08-13T07:00:00.000Z";
const privateCanary = "LOCAL_ONLY_PRIORITY_CONTEXT_MUST_NEVER_ESCAPE";

const priorityJobRef = durableJobRefSchema.parse({
  id: "priority_assessment:41",
  kind: "priority_assessment",
  status: "queued",
});

const priorityJobView = durableJobViewSchema.parse({
  ...priorityJobRef,
  subject: { type: "collection", scope: "all" },
  attempts: 0,
  maxAttempts: 3,
  progress: { completed: 0, total: null, stage: "queued" },
  canCancel: true,
  cancellationRequest: null,
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
  nextAttemptAt: timestamp,
  error: null,
  result: null,
});

const pagePriority = prioritySafeReadSchema.parse({
  subject: { type: "page", logicalPageId: 42 },
  outcome: {
    kind: "assessment",
    assessment: {
      id: 71,
      subject: { type: "page", logicalPageId: 42 },
      agentScore: 78,
      agentBand: "high",
      confidence: 0.82,
      needsReview: false,
      reasons: [{
        code: "active-project",
        kind: "contribution",
        label: "Linked to an active project",
        scoreDelta: 15,
        confidenceDelta: 0.1,
        appliedRuleKey: "active-project",
      }],
      missingSignals: ["captured_content"],
      ruleset: { rulesetId: 1, version: 1 },
      featureFingerprint: "a".repeat(64),
      assessmentMethod: "rule",
      modelProvenance: null,
      revision: 1,
      evaluatedAt: timestamp,
      supersededAt: null,
    },
  },
  isCurrent: true,
  dirty: false,
  needsReview: false,
});

const resourcePriority = prioritySafeReadSchema.parse({
  subject: { type: "resource", resourceId: 9 },
  outcome: {
    kind: "exclusion",
    exclusion: {
      id: 81,
      subject: { type: "resource", resourceId: 9 },
      reason: "private_or_internal",
      detail: { source: "url_policy", code: "private_resource" },
      ruleset: { rulesetId: 1, version: 1 },
      featureFingerprint: "b".repeat(64),
      revision: 1,
      evaluatedAt: timestamp,
      supersededAt: null,
    },
  },
  isCurrent: true,
  dirty: false,
  needsReview: false,
});

const pageFeedback = priorityFeedbackReceiptSchema.parse({
  id: 91,
  subject: { type: "page", logicalPageId: 42 },
  assessmentId: 71,
  verdict: "too_high",
  note: "The page is no longer part of the current project.",
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  supersedesId: null,
  supersededAt: null,
  revision: 1,
  createdAt: timestamp,
});

const resourceFeedback = priorityFeedbackReceiptSchema.parse({
  id: 92,
  subject: { type: "resource", resourceId: 9 },
  assessmentId: 72,
  verdict: "accept",
  note: null,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  supersedesId: null,
  supersededAt: null,
  revision: 1,
  createdAt: timestamp,
});

const pageImportance = agentUserImportanceResponseSchema.parse({
  subject: { type: "page", logicalPageId: 42 },
  value: 3,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

const resourceImportance = agentUserImportanceResponseSchema.parse({
  subject: { type: "resource", resourceId: 9 },
  value: null,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const priorityFeatures: McpServerOptions = {
  features: {
    context: false,
    logicalImportance: true,
    resources: true,
    agentUserImportance: true,
    priorityReaders: true,
    priorityAssessmentWriter: true,
    priorityShadow: true,
  },
};

function priorityApi(overrides: Partial<TabHubApi>): TabHubApi {
  return overrides as TabHubApi;
}

async function connectClient(api: TabHubApi, options: McpServerOptions) {
  const server = createMcpServer(api, options);
  const client = new Client({ name: "tabhub-priority-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  if (block?.type !== "text") throw new Error("Expected a text MCP result");
  return block.text;
}

describe("TabHub priority MCP protocol", () => {
  it("registers each priority tool only for its effective server feature", async () => {
    const allOff = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: false,
        resources: false,
      },
    });
    const disabled = await connectClient(priorityApi({}), {
      features: { context: false, logicalImportance: true },
    });
    const readers = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: true,
        priorityReaders: true,
      },
    });
    const writer = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: true,
        priorityAssessmentWriter: true,
      },
    });
    const explicitFalse = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: true,
        resources: true,
        agentUserImportance: false,
        priorityReaders: true,
        priorityAssessmentWriter: true,
      },
    });
    const pageEnabled = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: true,
        resources: false,
        agentUserImportance: true,
        priorityReaders: false,
        priorityAssessmentWriter: false,
      },
    });
    const resourceEnabled = await connectClient(priorityApi({}), {
      features: {
        context: false,
        logicalImportance: false,
        resources: true,
        agentUserImportance: true,
        priorityReaders: false,
        priorityAssessmentWriter: false,
      },
    });
    try {
      const allOffNames = (await allOff.client.listTools()).tools.map(({ name }) => name);
      const disabledNames = (await disabled.client.listTools()).tools.map(({ name }) => name);
      const readerNames = (await readers.client.listTools()).tools.map(({ name }) => name);
      const writerNames = (await writer.client.listTools()).tools.map(({ name }) => name);
      const explicitFalseNames = (await explicitFalse.client.listTools()).tools.map(
        ({ name }) => name,
      );
      const pageEnabledNames = (await pageEnabled.client.listTools()).tools.map(
        ({ name }) => name,
      );
      const resourceEnabledNames = (await resourceEnabled.client.listTools()).tools.map(
        ({ name }) => name,
      );
      expect(allOffNames).not.toContain("explain_priority");
      expect(allOffNames).not.toContain("record_priority_feedback");
      expect(allOffNames).not.toContain("recompute_priority");
      expect(allOffNames).not.toContain("get_job_status");
      expect(allOffNames).not.toContain("set_user_importance");
      expect(allOffNames).toContain("set_importance");
      expect(disabledNames).not.toContain("explain_priority");
      expect(disabledNames).not.toContain("record_priority_feedback");
      expect(disabledNames).not.toContain("recompute_priority");
      expect(disabledNames).not.toContain("get_job_status");
      expect(disabledNames).not.toContain("set_user_importance");
      expect(readerNames).toContain("explain_priority");
      expect(readerNames).not.toContain("record_priority_feedback");
      expect(readerNames).not.toContain("recompute_priority");
      expect(readerNames).not.toContain("get_job_status");
      expect(writerNames).not.toContain("explain_priority");
      expect(writerNames).toContain("record_priority_feedback");
      expect(writerNames).toContain("recompute_priority");
      expect(writerNames).toContain("get_job_status");
      expect(readerNames).not.toContain("set_user_importance");
      expect(writerNames).not.toContain("set_user_importance");
      expect(explicitFalseNames).not.toContain("set_user_importance");
      expect(pageEnabledNames).toContain("set_user_importance");
      expect(resourceEnabledNames).toContain("set_user_importance");
      expect(pageEnabledNames).not.toContain("explain_priority");
      expect(pageEnabledNames).not.toContain("record_priority_feedback");
      expect(resourceEnabledNames).not.toContain("explain_priority");
      expect(resourceEnabledNames).not.toContain("record_priority_feedback");
      expect(readerNames).toContain("set_importance");
      expect(writerNames).toContain("set_importance");
    } finally {
      await allOff.close();
      await disabled.close();
      await readers.close();
      await writer.close();
      await explicitFalse.close();
      await pageEnabled.close();
      await resourceEnabled.close();
    }
  });

  it("publishes strict documented schemas without provenance or engine internals", async () => {
    const connection = await connectClient(priorityApi({}), priorityFeatures);
    try {
      const tools = (await connection.client.listTools()).tools;
      const explain = tools.find(({ name }) => name === "explain_priority");
      const feedback = tools.find(({ name }) => name === "record_priority_feedback");
      const importance = tools.find(({ name }) => name === "set_user_importance");
      const recompute = tools.find(({ name }) => name === "recompute_priority");
      const status = tools.find(({ name }) => name === "get_job_status");
      expect(explain?.description).toContain("safe current priority outcome");
      expect(explain?.description).toContain("never returns local-only context");
      expect(feedback?.description).toContain("explicit user instruction");
      expect(feedback?.description).toContain("agent/on_behalf_of_user");
      expect(importance?.description).toContain("explicit user instruction");
      expect(importance?.description).toContain("never writes, replaces, or masquerades as an AI priority assessment");
      expect(recompute?.description).toContain("immediately return its job reference");
      expect(status?.description).toContain("never polls or waits");
      expect(feedback?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: [
          "subject_type",
          "assessment_id",
          "verdict",
          "idempotency_key",
          "authorization_ref",
        ],
      });
      expect(importance?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: [
          "subject_type",
          "value",
          "idempotency_key",
          "authorization_ref",
        ],
      });
      expect(recompute?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["idempotency_key", "authorization_ref"],
      });
      expect(status?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["id"],
      });
      const serialized = JSON.stringify([
        explain?.inputSchema,
        feedback?.inputSchema,
        importance?.inputSchema,
        recompute?.inputSchema,
        status?.inputSchema,
      ]);
      for (const forbidden of [
        "actor", "method", "model", "ruleset", "raw_features",
        "feature_fingerprint", "scheduling_priority", "budget",
      ]) {
        expect(serialized).not.toContain(`\"${forbidden}\"`);
      }
    } finally {
      await connection.close();
    }
  });

  it("returns an immediate recompute JobRef and reads status only when asked", async () => {
    const recomputePriority = vi.fn(async () => priorityJobRef);
    const getJobStatus = vi.fn(async () => priorityJobView);
    const connection = await connectClient(
      priorityApi({ recomputePriority, getJobStatus }),
      priorityFeatures,
    );
    try {
      const submitted = await connection.client.callTool({
        name: "recompute_priority",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          idempotency_key: "priority-recompute-page-42",
          authorization_ref: "user-instruction:priority-recompute-page-42",
          step_batch_size: 25,
        },
      });
      expect(JSON.parse(textResult(submitted))).toEqual(priorityJobRef);
      expect(submitted.structuredContent).toEqual(priorityJobRef);
      expect(recomputePriority).toHaveBeenCalledWith({
        subject: { type: "page", logicalPageId: 42 },
        idempotencyKey: "priority-recompute-page-42",
        authorizationRef: "user-instruction:priority-recompute-page-42",
        stepBatchSize: 25,
      });
      expect(getJobStatus).not.toHaveBeenCalled();

      const status = await connection.client.callTool({
        name: "get_job_status",
        arguments: { id: priorityJobRef.id },
      });
      expect(JSON.parse(textResult(status))).toEqual(priorityJobView);
      expect(status.structuredContent).toEqual(priorityJobView);
      expect(getJobStatus).toHaveBeenCalledOnce();
      expect(getJobStatus).toHaveBeenCalledWith(priorityJobRef.id);
    } finally {
      await connection.close();
    }
  });

  it("rejects invalid or spoofed job inputs before the API boundary", async () => {
    const recomputePriority = vi.fn(async () => priorityJobRef);
    const getJobStatus = vi.fn(async () => priorityJobView);
    const connection = await connectClient(
      priorityApi({ recomputePriority, getJobStatus }),
      priorityFeatures,
    );
    try {
      const invalidSubject = await connection.client.callTool({
        name: "recompute_priority",
        arguments: {
          subject_type: "collection",
          logical_page_id: 42,
          idempotency_key: "invalid-collection",
          authorization_ref: privateCanary,
          provenance: { requestedBy: "user", requestMethod: "manual" },
        },
      });
      const invalidId = await connection.client.callTool({
        name: "get_job_status",
        arguments: { id: "priority_assessment:not-a-number" },
      });
      const wrongKind = await connection.client.callTool({
        name: "get_job_status",
        arguments: { id: "resource_research:7" },
      });
      expect(invalidSubject.isError).toBe(true);
      expect(invalidId.isError).toBe(true);
      expect(wrongKind.isError).toBe(true);
      expect(textResult(invalidSubject)).not.toContain(privateCanary);
      expect(recomputePriority).not.toHaveBeenCalled();
      expect(getJobStatus).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("executes page and resource explanations through the real MCP adapter", async () => {
    const explainPriority = vi.fn(async (
      subject: PrioritySubjectContract,
    ): Promise<PrioritySafeRead> => subject.type === "page"
      ? pagePriority
      : resourcePriority);
    const connection = await connectClient(
      priorityApi({ explainPriority }),
      priorityFeatures,
    );
    try {
      const page = await connection.client.callTool({
        name: "explain_priority",
        arguments: { subject_type: "page", logical_page_id: 42 },
      });
      const resource = await connection.client.callTool({
        name: "explain_priority",
        arguments: { subject_type: "resource", resource_id: 9 },
      });
      expect(JSON.parse(textResult(page))).toEqual(pagePriority);
      expect(page.structuredContent).toEqual(pagePriority);
      expect(JSON.parse(textResult(resource))).toEqual(resourcePriority);
      expect(resource.structuredContent).toEqual(resourcePriority);
      expect(explainPriority.mock.calls).toEqual([
        [{ type: "page", logicalPageId: 42 }],
        [{ type: "resource", resourceId: 9 }],
      ]);
      const transcript = `${textResult(page)}\n${textResult(resource)}`;
      expect(transcript).not.toContain("local_only");
      expect(transcript).not.toContain("hiddenCount");
      expect(transcript).not.toContain("rawFeatures");
      expect(transcript).not.toContain(privateCanary);
    } finally {
      await connection.close();
    }
  });

  it("records typed page/resource feedback and preserves idempotent replay inputs", async () => {
    const recordPriorityFeedback = vi.fn(async (
      input: Parameters<TabHubApi["recordPriorityFeedback"]>[0],
    ): Promise<PriorityFeedbackReceipt> => input.subject.type === "page"
      ? pageFeedback
      : resourceFeedback);
    const connection = await connectClient(
      priorityApi({ recordPriorityFeedback }),
      priorityFeatures,
    );
    const pageArguments = {
      subject_type: "page",
      logical_page_id: 42,
      assessment_id: 71,
      verdict: "too_high",
      note: "The page is no longer part of the current project.",
      idempotency_key: "priority-feedback-page-42",
      authorization_ref: "user-instruction:priority-review:42",
    };
    try {
      const first = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: pageArguments,
      });
      const replay = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: pageArguments,
      });
      const resource = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: {
          subject_type: "resource",
          resource_id: 9,
          assessment_id: 72,
          verdict: "accept",
          idempotency_key: "priority-feedback-resource-9",
          authorization_ref: "user-instruction:priority-review:resource-9",
        },
      });
      expect(textResult(replay)).toBe(textResult(first));
      expect(JSON.parse(textResult(first))).toEqual(pageFeedback);
      expect(JSON.parse(textResult(resource))).toEqual(resourceFeedback);
      expect(recordPriorityFeedback.mock.calls).toEqual([
        [{
          subject: { type: "page", logicalPageId: 42 },
          assessmentId: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotencyKey: "priority-feedback-page-42",
          authorizationRef: "user-instruction:priority-review:42",
        }],
        [{
          subject: { type: "page", logicalPageId: 42 },
          assessmentId: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotencyKey: "priority-feedback-page-42",
          authorizationRef: "user-instruction:priority-review:42",
        }],
        [{
          subject: { type: "resource", resourceId: 9 },
          assessmentId: 72,
          verdict: "accept",
          idempotencyKey: "priority-feedback-resource-9",
          authorizationRef: "user-instruction:priority-review:resource-9",
        }],
      ]);
    } finally {
      await connection.close();
    }
  });

  it("fails closed through the real SDK when feedback receipts mismatch each command", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ ...pageFeedback, verdict: "accept" }))
      .mockResolvedValueOnce(jsonResponse({ ...pageFeedback, note: null }))
      .mockResolvedValueOnce(jsonResponse({
        ...resourceFeedback,
        supersedesId: 17,
      }));
    const connection = await connectClient(
      createTabHubApi({ fetchImpl }),
      priorityFeatures,
    );
    try {
      for (const arguments_ of [
        {
          subject_type: "page",
          logical_page_id: 42,
          assessment_id: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotency_key: "priority-feedback-verdict-mismatch",
          authorization_ref: "user-instruction:priority-review:42",
        },
        {
          subject_type: "page",
          logical_page_id: 42,
          assessment_id: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotency_key: "priority-feedback-note-mismatch",
          authorization_ref: "user-instruction:priority-review:42",
        },
        {
          subject_type: "resource",
          resource_id: 9,
          assessment_id: 72,
          verdict: "accept",
          idempotency_key: "priority-feedback-supersession-mismatch",
          authorization_ref: "user-instruction:priority-review:resource-9",
        },
      ]) {
        const result = await connection.client.callTool({
          name: "record_priority_feedback",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(textResult(result)).toContain("returned a mismatched response");
      }
    } finally {
      await connection.close();
    }
  });

  it("sets page/resource user importance only through explicit authorized inputs", async () => {
    const setUserImportance = vi.fn(async (
      input: Parameters<TabHubApi["setUserImportance"]>[0],
    ) => input.subject.type === "page" ? pageImportance : resourceImportance);
    const connection = await connectClient(
      priorityApi({ setUserImportance }),
      priorityFeatures,
    );
    const pageArguments = {
      subject_type: "page",
      logical_page_id: 42,
      value: 3,
      idempotency_key: "set-page-importance-42",
      authorization_ref: "user-instruction:set-page-importance:42",
    };
    try {
      const first = await connection.client.callTool({
        name: "set_user_importance",
        arguments: pageArguments,
      });
      const replay = await connection.client.callTool({
        name: "set_user_importance",
        arguments: pageArguments,
      });
      const cleared = await connection.client.callTool({
        name: "set_user_importance",
        arguments: {
          subject_type: "resource",
          resource_id: 9,
          value: null,
          idempotency_key: "clear-resource-importance-9",
          authorization_ref: "user-instruction:clear-resource-importance:9",
        },
      });
      expect(textResult(replay)).toBe(textResult(first));
      expect(JSON.parse(textResult(first))).toEqual(pageImportance);
      expect(first.structuredContent).toEqual(pageImportance);
      expect(JSON.parse(textResult(cleared))).toEqual(resourceImportance);
      expect(setUserImportance.mock.calls).toEqual([
        [{
          subject: { type: "page", logicalPageId: 42 },
          value: 3,
          idempotencyKey: "set-page-importance-42",
          authorizationRef: "user-instruction:set-page-importance:42",
        }],
        [{
          subject: { type: "page", logicalPageId: 42 },
          value: 3,
          idempotencyKey: "set-page-importance-42",
          authorizationRef: "user-instruction:set-page-importance:42",
        }],
        [{
          subject: { type: "resource", resourceId: 9 },
          value: null,
          idempotencyKey: "clear-resource-importance-9",
          authorizationRef: "user-instruction:clear-resource-importance:9",
        }],
      ]);
      for (const call of setUserImportance.mock.calls) {
        expect(call[0]).not.toHaveProperty("actor");
        expect(call[0]).not.toHaveProperty("method");
        expect(call[0]).not.toHaveProperty("model");
        expect(call[0]).not.toHaveProperty("ruleset");
        expect(call[0]).not.toHaveProperty("rawFeatures");
        expect(call[0]).not.toHaveProperty("featureFingerprint");
        expect(call[0]).not.toHaveProperty("schedulingPriority");
        expect(call[0]).not.toHaveProperty("budget");
      }
    } finally {
      await connection.close();
    }
  });

  it("rejects invalid, ambiguous, and provenance-spoofing tool inputs", async () => {
    const explainPriority = vi.fn();
    const recordPriorityFeedback = vi.fn();
    const setUserImportance = vi.fn();
    const connection = await connectClient(
      priorityApi({ explainPriority, recordPriorityFeedback, setUserImportance }),
      priorityFeatures,
    );
    try {
      const ambiguous = await connection.client.callTool({
        name: "explain_priority",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          resource_id: 9,
        },
      });
      const invalidValue = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: {
          subject_type: "resource",
          resource_id: 9,
          assessment_id: 72,
          verdict: "increase_score",
          idempotency_key: "bad-verdict",
          authorization_ref: "user-instruction:priority-review:resource-9",
        },
      });
      const spoofed = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          assessment_id: 71,
          verdict: "accept",
          idempotency_key: "spoofed-feedback",
          authorization_ref: "user-instruction:priority-review:42",
          actor: "user",
          method: "manual",
          raw_features: { local_context_body: privateCanary },
        },
      });
      const spoofedImportance = await connection.client.callTool({
        name: "set_user_importance",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          value: 2,
          idempotency_key: "spoofed-importance",
          authorization_ref: "user-instruction:set-page-importance:42",
          actor: "user",
          method: "manual",
          raw_features: { local_context_body: privateCanary },
        },
      });
      const invalidImportance = await connection.client.callTool({
        name: "set_user_importance",
        arguments: {
          subject_type: "resource",
          resource_id: 9,
          value: 0,
          idempotency_key: "invalid-importance",
          authorization_ref: "user-instruction:set-resource-importance:9",
        },
      });
      expect(ambiguous.isError).toBe(true);
      expect(invalidValue.isError).toBe(true);
      expect(spoofed.isError).toBe(true);
      expect(spoofedImportance.isError).toBe(true);
      expect(invalidImportance.isError).toBe(true);
      expect(textResult(spoofed)).not.toContain(privateCanary);
      expect(explainPriority).not.toHaveBeenCalled();
      expect(recordPriorityFeedback).not.toHaveBeenCalled();
      expect(setUserImportance).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("revalidates adapter output so private or malformed fields fail closed", async () => {
    const explainPriority = vi.fn()
      .mockResolvedValueOnce({
        ...pagePriority,
        rawFeatures: { localContextBody: privateCanary },
        hiddenCount: 1,
      } as unknown as PrioritySafeRead)
      .mockResolvedValueOnce({
        ...resourcePriority,
        outcome: {
          ...resourcePriority.outcome,
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            detail: { localContextBody: privateCanary },
          },
        },
      } as unknown as PrioritySafeRead);
    const connection = await connectClient(
      priorityApi({ explainPriority }),
      priorityFeatures,
    );
    try {
      const result = await connection.client.callTool({
        name: "explain_priority",
        arguments: { subject_type: "page", logical_page_id: 42 },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result)).not.toContain(privateCanary);
      expect(result.structuredContent).toBeUndefined();
      const nested = await connection.client.callTool({
        name: "explain_priority",
        arguments: { subject_type: "resource", resource_id: 9 },
      });
      expect(nested.isError).toBe(true);
      expect(textResult(nested)).not.toContain(privateCanary);
      expect(nested.structuredContent).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it("rejects every nested outcome subject mismatch at the real MCP SDK seam", async () => {
    const explainPriority = vi.fn()
      .mockResolvedValueOnce({
        ...pagePriority,
        outcome: {
          kind: "assessment",
          assessment: {
            ...(pagePriority.outcome?.kind === "assessment"
              ? pagePriority.outcome.assessment
              : {}),
            subject: { type: "page", logicalPageId: 43 },
          },
        },
      } as PrioritySafeRead)
      .mockResolvedValueOnce({
        ...pagePriority,
        outcome: {
          kind: "assessment",
          assessment: {
            ...(pagePriority.outcome?.kind === "assessment"
              ? pagePriority.outcome.assessment
              : {}),
            subject: { type: "resource", resourceId: 42 },
          },
        },
      } as PrioritySafeRead)
      .mockResolvedValueOnce({
        ...resourcePriority,
        outcome: {
          kind: "exclusion",
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            subject: { type: "resource", resourceId: 10 },
          },
        },
      } as PrioritySafeRead)
      .mockResolvedValueOnce({
        ...resourcePriority,
        outcome: {
          kind: "exclusion",
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            subject: { type: "page", logicalPageId: 9 },
          },
        },
      } as PrioritySafeRead);
    const connection = await connectClient(
      priorityApi({ explainPriority }),
      priorityFeatures,
    );
    try {
      for (const arguments_ of [
        { subject_type: "page", logical_page_id: 42 },
        { subject_type: "page", logical_page_id: 42 },
        { subject_type: "resource", resource_id: 9 },
        { subject_type: "resource", resource_id: 9 },
      ]) {
        const result = await connection.client.callTool({
          name: "explain_priority",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(textResult(result)).toMatch(
          /Priority (assessment|exclusion) has a mismatched subject/,
        );
      }
    } finally {
      await connection.close();
    }
  });

  it("rejects user/manual feedback receipts at the MCP seam", async () => {
    const recordPriorityFeedback = vi.fn(async () => ({
      ...pageFeedback,
      provenance: { actor: "user", method: "manual" },
    }) as PriorityFeedbackReceipt);
    const connection = await connectClient(
      priorityApi({ recordPriorityFeedback }),
      priorityFeatures,
    );
    try {
      const result = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          assessment_id: 71,
          verdict: "accept",
          idempotency_key: "invalid-provenance",
          authorization_ref: "user-instruction:priority-review:42",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(textResult(result)).toBe(
        "Priority feedback receipt has invalid agent provenance",
      );
    } finally {
      await connection.close();
    }
  });

  it("preserves stable typed REST errors as MCP error transcripts", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        error: "NOT_FOUND",
        code: "PRIORITY_OUTCOME_NOT_FOUND",
        message: "The requested priority outcome was not found",
      }, 404))
      .mockResolvedValueOnce(jsonResponse({
        error: "IDEMPOTENCY_KEY_CONFLICT",
        message: "The priority mutation conflicts with current state",
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        error: "IDEMPOTENCY_KEY_CONFLICT",
      }, 409));
    const connection = await connectClient(
      createTabHubApi({ fetchImpl }),
      priorityFeatures,
    );
    try {
      const missing = await connection.client.callTool({
        name: "explain_priority",
        arguments: { subject_type: "page", logical_page_id: 404 },
      });
      const conflict = await connection.client.callTool({
        name: "record_priority_feedback",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          assessment_id: 71,
          verdict: "accept",
          idempotency_key: "conflicting-key",
          authorization_ref: "user-instruction:priority-review:42",
        },
      });
      const importanceConflict = await connection.client.callTool({
        name: "set_user_importance",
        arguments: {
          subject_type: "page",
          logical_page_id: 42,
          value: 3,
          idempotency_key: "conflicting-importance-key",
          authorization_ref: "user-instruction:set-page-importance:42",
        },
      });
      expect(missing.isError).toBe(true);
      expect(textResult(missing)).toBe(
        "TabHub API GET /api/logical-pages/404/priority returned HTTP 404: PRIORITY_OUTCOME_NOT_FOUND: The requested priority outcome was not found",
      );
      expect(conflict.isError).toBe(true);
      expect(textResult(conflict)).toBe(
        "TabHub API POST /api/agent/logical-pages/42/priority-feedback returned HTTP 409: IDEMPOTENCY_KEY_CONFLICT: The priority mutation conflicts with current state",
      );
      expect(importanceConflict.isError).toBe(true);
      expect(textResult(importanceConflict)).toBe(
        "TabHub API PUT /api/agent/user-importance returned HTTP 409: IDEMPOTENCY_KEY_CONFLICT",
      );
    } finally {
      await connection.close();
    }
  });
});
