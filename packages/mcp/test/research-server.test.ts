import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpServer,
  type McpServerOptions,
  type TabHubApi,
} from "../src/server.js";
import {
  agentResearchReportDetail,
  cancelledResearchJob,
  confirmationRequired,
  privateResearchCanaries,
  queuedResearchJob,
  researchBudget,
  researchJobRef,
  researchReportList,
} from "./research-fixtures.js";

const researchToolNames = [
  "start_research",
  "get_ai_job",
  "cancel_ai_job",
  "list_research_reports",
  "get_research_report",
] as const;

const researchFeatures = (research: boolean): McpServerOptions => ({
  features: {
    context: false,
    logicalImportance: false,
    research,
  },
});

function researchApi(overrides: Partial<TabHubApi>): TabHubApi {
  return new Proxy(overrides as TabHubApi, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (property === "then") return undefined;
      return async () => {
        throw new Error(`Unexpected API call: ${String(property)}`);
      };
    },
  });
}

async function connectClient(api: TabHubApi, options: McpServerOptions) {
  const server = createMcpServer(api, options);
  const client = new Client({ name: "tabhub-research-test", version: "0.1.0" });
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
  if (block?.type !== "text") throw new Error("Expected a text MCP result");
  return block.text;
}

const startArguments = {
  target: { type: "page", logical_page_id: 1 },
  question: "What is useful for this project?",
  include_shareable_context: true,
  max_included_sources: 25,
  budget: {
    max_steps: researchBudget.maxSteps,
    max_tokens: researchBudget.maxTokens,
    max_cost_usd: researchBudget.maxCostUsd,
    max_wall_time_ms: researchBudget.maxWallTimeMs,
  },
  idempotency_key: "research-page-1-v1",
  authorization_ref: "user-instruction:research-page-1-v1",
};

describe("TabHub research MCP protocol", () => {
  it("keeps the surface absent for old servers, exposes readers when disabled, and all five in order when enabled", async () => {
    const oldServer = await connectClient(researchApi({}), {
      features: { context: false, logicalImportance: false },
    });
    const disabled = await connectClient(researchApi({}), researchFeatures(false));
    const enabled = await connectClient(researchApi({}), researchFeatures(true));
    try {
      const oldNames = (await oldServer.client.listTools()).tools.map(({ name }) => name);
      const disabledNames = (await disabled.client.listTools()).tools.map(({ name }) => name);
      const enabledNames = (await enabled.client.listTools()).tools.map(({ name }) => name);
      expect(oldNames.filter((name) => researchToolNames.includes(name as never))).toEqual([]);
      expect(disabledNames.filter((name) => researchToolNames.includes(name as never))).toEqual([
        "get_ai_job",
        "list_research_reports",
        "get_research_report",
      ]);
      expect(enabledNames.filter((name) => researchToolNames.includes(name as never))).toEqual(
        researchToolNames,
      );
    } finally {
      await oldServer.close();
      await disabled.close();
      await enabled.close();
    }
  });

  it("publishes strict safe schemas, descriptions, and annotations without workflow internals", async () => {
    const connection = await connectClient(researchApi({}), researchFeatures(true));
    try {
      const tools = (await connection.client.listTools()).tools;
      const start = tools.find(({ name }) => name === "start_research");
      const getJob = tools.find(({ name }) => name === "get_ai_job");
      const cancel = tools.find(({ name }) => name === "cancel_ai_job");
      const list = tools.find(({ name }) => name === "list_research_reports");
      const detail = tools.find(({ name }) => name === "get_research_report");

      expect(start?.description).toContain("immediately returns");
      expect(start?.description).toContain("never fetches, navigates, captures, or polls");
      expect(start?.description).toContain("exact per-run confirmation");
      expect(getJob?.description).toContain("one status read");
      expect(cancel?.description).toContain("canCancel");
      expect(list?.description).toContain("bounded report history");
      expect(detail?.description).toContain("safe evidence audit identity");
      expect(start?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(cancel?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      for (const tool of [start, getJob, cancel, list, detail]) {
        expect(tool?.inputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
      const serialized = JSON.stringify(researchToolNames.map((name) =>
        tools.find((tool) => tool.name === name)?.inputSchema));
      for (const forbidden of [
        "parentReportId", "parent_report_id", "captureIntent", "capture_intent",
        "estimate", "approvalFingerprint", "approval_fingerprint", "provenance",
      ]) {
        expect(serialized).not.toContain(`\"${forbidden}\"`);
      }
      const resources = await connection.client.listResourceTemplates();
      expect(resources.resourceTemplates.map(({ uriTemplate }) => uriTemplate))
        .not.toContain(expect.stringContaining("research"));
    } finally {
      await connection.close();
    }
  });

  it("starts once with default empty confirmations and returns immediately without polling", async () => {
    const startResearch = vi.fn(async () => researchJobRef);
    const getAiJob = vi.fn(async () => queuedResearchJob);
    const connection = await connectClient(
      researchApi({ startResearch, getAiJob }),
      researchFeatures(true),
    );
    try {
      const result = await connection.client.callTool({
        name: "start_research",
        arguments: startArguments,
      });
      expect(JSON.parse(textResult(result))).toEqual(researchJobRef);
      expect(result.structuredContent).toEqual(researchJobRef);
      expect(startResearch).toHaveBeenCalledOnce();
      expect(startResearch).toHaveBeenCalledWith({
        version: 1,
        target: { type: "page", logicalPageId: 1 },
        question: startArguments.question,
        includeShareableContext: true,
        maxIncludedSources: 25,
        budget: researchBudget,
        confirmedOrigins: {
          authenticatedOriginDigests: [],
          sensitiveOriginDigests: [],
        },
        idempotencyKey: startArguments.idempotency_key,
        authorizationRef: startArguments.authorization_ref,
      });
      expect(getAiJob).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("returns confirmation requirements and performs no hidden follow-up", async () => {
    const startResearch = vi.fn(async () => confirmationRequired);
    const getAiJob = vi.fn(async () => queuedResearchJob);
    const connection = await connectClient(
      researchApi({ startResearch, getAiJob }),
      researchFeatures(true),
    );
    try {
      const result = await connection.client.callTool({
        name: "start_research",
        arguments: startArguments,
      });
      expect(JSON.parse(textResult(result))).toEqual(confirmationRequired);
      expect(result.structuredContent).toEqual(confirmationRequired);
      expect(startResearch).toHaveBeenCalledOnce();
      expect(getAiJob).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("performs exactly one job read, cancel, report list, and report detail operation", async () => {
    const getAiJob = vi.fn(async () => queuedResearchJob);
    const cancelAiJob = vi.fn(async () => cancelledResearchJob);
    const listResearchReports = vi.fn(async () => researchReportList);
    const getResearchReport = vi.fn(async () => agentResearchReportDetail);
    const connection = await connectClient(researchApi({
      getAiJob,
      cancelAiJob,
      listResearchReports,
      getResearchReport,
    }), researchFeatures(true));
    try {
      const job = await connection.client.callTool({
        name: "get_ai_job",
        arguments: { id: "resource_research:41" },
      });
      const cancelled = await connection.client.callTool({
        name: "cancel_ai_job",
        arguments: {
          id: "resource_research:41",
          idempotency_key: "cancel-research-41",
          authorization_ref: "user-instruction:cancel-research-41",
        },
      });
      const listed = await connection.client.callTool({
        name: "list_research_reports",
        arguments: {
          target: { type: "page", logical_page_id: 1 },
          limit: 25,
          before_version: 4,
        },
      });
      const detail = await connection.client.callTool({
        name: "get_research_report",
        arguments: { id: 21 },
      });

      expect(job.structuredContent).toEqual(queuedResearchJob);
      expect(cancelled.structuredContent).toEqual(cancelledResearchJob);
      expect(listed.structuredContent).toEqual(researchReportList);
      expect(detail.structuredContent).toEqual(agentResearchReportDetail);
      expect(getAiJob).toHaveBeenCalledWith("resource_research:41");
      expect(cancelAiJob).toHaveBeenCalledWith("resource_research:41", {
        authorizationRef: "user-instruction:cancel-research-41",
        idempotencyKey: "cancel-research-41",
      });
      expect(listResearchReports).toHaveBeenCalledWith({
        targetType: "page",
        targetId: 1,
        limit: 25,
        beforeVersion: 4,
      });
      expect(getResearchReport).toHaveBeenCalledWith(21);
      expect(getAiJob).toHaveBeenCalledOnce();
      expect(cancelAiJob).toHaveBeenCalledOnce();
      expect(listResearchReports).toHaveBeenCalledOnce();
      expect(getResearchReport).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it.each([
    ["parent_report_id", null],
    ["capture_intent", { selected_tab_ids: [] }],
    ["estimate", { calls: 1 }],
    ["approval_fingerprint", "a".repeat(64)],
    ["provenance", { requested_by: privateResearchCanaries[6] }],
  ])("rejects forbidden start field %s before the API boundary", async (key, value) => {
    const startResearch = vi.fn(async () => researchJobRef);
    const connection = await connectClient(
      researchApi({ startResearch }),
      researchFeatures(true),
    );
    try {
      const result = await connection.client.callTool({
        name: "start_research",
        arguments: { ...startArguments, [key]: value },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(textResult(result)).not.toContain(privateResearchCanaries[6]);
      expect(startResearch).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("rejects non-research jobs, invalid selections, and unbounded authorization before the API boundary", async () => {
    const startResearch = vi.fn(async () => researchJobRef);
    const getAiJob = vi.fn(async () => queuedResearchJob);
    const cancelAiJob = vi.fn(async () => cancelledResearchJob);
    const connection = await connectClient(
      researchApi({ startResearch, getAiJob, cancelAiJob }),
      researchFeatures(true),
    );
    try {
      const wrongKind = await connection.client.callTool({
        name: "get_ai_job",
        arguments: { id: "priority_assessment:41" },
      });
      const invalidSelection = await connection.client.callTool({
        name: "start_research",
        arguments: {
          ...startArguments,
          target: {
            type: "selection",
            logical_page_ids: [1, 1],
            fingerprint: "a".repeat(64),
          },
        },
      });
      const unboundedCancel = await connection.client.callTool({
        name: "cancel_ai_job",
        arguments: {
          id: "resource_research:41",
          idempotency_key: "x".repeat(201),
          authorization_ref: "y".repeat(257),
        },
      });
      const normalizedReplayKey = await connection.client.callTool({
        name: "start_research",
        arguments: {
          ...startArguments,
          idempotency_key: " padded-replay-key ",
        },
      });
      expect(wrongKind.isError).toBe(true);
      expect(invalidSelection.isError).toBe(true);
      expect(unboundedCancel.isError).toBe(true);
      expect(normalizedReplayKey.isError).toBe(true);
      expect(startResearch).not.toHaveBeenCalled();
      expect(getAiJob).not.toHaveBeenCalled();
      expect(cancelAiJob).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("fails closed when an API implementation returns another research job identity", async () => {
    const getAiJob = vi.fn(async () => ({
      ...queuedResearchJob,
      id: "resource_research:42" as const,
    }));
    const connection = await connectClient(
      researchApi({ getAiJob }),
      researchFeatures(false),
    );
    try {
      const result = await connection.client.callTool({
        name: "get_ai_job",
        arguments: { id: "resource_research:41" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(textResult(result)).toContain("mismatched response");
    } finally {
      await connection.close();
    }
  });
});
