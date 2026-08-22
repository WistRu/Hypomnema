import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import {
  agentResearchReportDetail,
  cancelledResearchJob,
  privateResearchCanaries,
  queuedResearchJob,
  researchBudget,
  researchJobRef,
  researchReportList,
} from "./research-fixtures.js";

function textResult(content: unknown): string {
  if (
    typeof content !== "object" ||
    content === null ||
    !("content" in content) ||
    !Array.isArray(content.content) ||
    content.content[0]?.type !== "text"
  ) {
    throw new Error("Expected a text MCP tool result");
  }
  return content.content[0].text as string;
}

describe("TabHub built research stdio server", () => {
  it("executes all five tools as one-call privacy-safe REST adapter transcripts", async () => {
    const calls: Array<{
      method: string;
      url: string;
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const boundaryServer = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/features") {
        response.end(JSON.stringify({
          context: false,
          logicalImportance: false,
          research: true,
        }));
        return;
      }

      let rawBody = "";
      for await (const chunk of request) rawBody += String(chunk);
      calls.push({
        method: request.method ?? "GET",
        url: request.url ?? "",
        body: rawBody === "" ? undefined : JSON.parse(rawBody),
        headers: request.headers,
      });

      if (
        request.method === "POST" &&
        request.url === "/api/agent/research/start"
      ) {
        const body = JSON.parse(rawBody) as { idempotencyKey?: string };
        if (body.idempotencyKey === "provider-down") {
          response.writeHead(503).end(JSON.stringify({
            error: "RESEARCH_PROVIDER_UNAVAILABLE",
            message: privateResearchCanaries[8],
          }));
          return;
        }
        response.writeHead(202).end(JSON.stringify(researchJobRef));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/api/ai/jobs/resource_research:41"
      ) {
        response.end(JSON.stringify(queuedResearchJob));
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/api/agent/ai/jobs/resource_research:41/cancel"
      ) {
        response.end(JSON.stringify(cancelledResearchJob));
        return;
      }
      if (
        request.method === "GET" &&
        request.url ===
          "/api/agent/research/reports?targetType=page&targetId=1&limit=25&beforeVersion=4"
      ) {
        response.end(JSON.stringify(researchReportList));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/api/agent/research/reports/21"
      ) {
        response.end(JSON.stringify(agentResearchReportDetail));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
    });
    await new Promise<void>((resolve, reject) => {
      boundaryServer.once("error", reject);
      boundaryServer.listen(0, "127.0.0.1", resolve);
    });

    let client: Client | undefined;
    try {
      const address = boundaryServer.address() as AddressInfo;
      const entrypoint = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        cwd: workspaceRoot,
        env: {
          ...getDefaultEnvironment(),
          TABHUB_API_URL: `http://127.0.0.1:${address.port}`,
        },
        stderr: "pipe",
      });
      client = new Client(
        { name: "tabhub-research-stdio-test", version: "0.1.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).filter((name) =>
        ["start_research", "get_ai_job", "cancel_ai_job",
          "list_research_reports", "get_research_report"].includes(name)))
        .toEqual([
          "start_research",
          "get_ai_job",
          "cancel_ai_job",
          "list_research_reports",
          "get_research_report",
        ]);

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
      const start = await client.callTool({
        name: "start_research",
        arguments: startArguments,
      });
      const job = await client.callTool({
        name: "get_ai_job",
        arguments: { id: researchJobRef.id },
      });
      const cancelled = await client.callTool({
        name: "cancel_ai_job",
        arguments: {
          id: researchJobRef.id,
          idempotency_key: "cancel-research-41",
          authorization_ref: "user-instruction:cancel-research-41",
        },
      });
      const reports = await client.callTool({
        name: "list_research_reports",
        arguments: {
          target: { type: "page", logical_page_id: 1 },
          limit: 25,
          before_version: 4,
        },
      });
      const report = await client.callTool({
        name: "get_research_report",
        arguments: { id: 21 },
      });

      expect(start.structuredContent).toEqual(researchJobRef);
      expect(job.structuredContent).toEqual(queuedResearchJob);
      expect(cancelled.structuredContent).toEqual(cancelledResearchJob);
      expect(reports.structuredContent).toEqual(researchReportList);
      expect(report.structuredContent).toEqual(agentResearchReportDetail);
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "POST", url: "/api/agent/research/start" },
        { method: "GET", url: "/api/ai/jobs/resource_research:41" },
        {
          method: "POST",
          url: "/api/agent/ai/jobs/resource_research:41/cancel",
        },
        {
          method: "GET",
          url: "/api/agent/research/reports?targetType=page&targetId=1&limit=25&beforeVersion=4",
        },
        { method: "GET", url: "/api/agent/research/reports/21" },
      ]);
      expect(calls[0]?.body).toEqual({
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
      expect(calls[2]?.body).toEqual({
        authorizationRef: "user-instruction:cancel-research-41",
        idempotencyKey: "cancel-research-41",
      });
      for (const call of calls) {
        expect(call.headers.authorization).toBeUndefined();
        expect(call.headers.cookie).toBeUndefined();
        expect(call.headers["x-tabhub-dev-proxy-secret"]).toBeUndefined();
      }
      const transcript = [start, job, cancelled, reports, report]
        .map(textResult).join("\n");
      expect(transcript).not.toContain(startArguments.authorization_ref);
      expect(transcript).not.toContain(startArguments.idempotency_key);
      for (const canary of privateResearchCanaries) {
        expect(transcript).not.toContain(canary);
      }

      const beforeInvalid = calls.length;
      const invalid = await client.callTool({
        name: "start_research",
        arguments: {
          ...startArguments,
          parent_report_id: 21,
          provenance: { requested_by: "agent" },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(calls).toHaveLength(beforeInvalid);

      const providerFailure = await client.callTool({
        name: "start_research",
        arguments: {
          ...startArguments,
          idempotency_key: "provider-down",
        },
      });
      expect(providerFailure.isError).toBe(true);
      expect(textResult(providerFailure)).toContain("RESEARCH_PROVIDER_UNAVAILABLE");
      expect(textResult(providerFailure)).not.toContain(privateResearchCanaries[8]);
      expect(calls.map(({ url }) => url)).not.toContain("/api/research/preflight");
      expect(calls.map(({ url }) => url)).not.toContain("/api/agent/research/runs");
    } finally {
      await client?.close();
      await new Promise<void>((resolve, reject) => {
        boundaryServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  }, 30_000);
});
