import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { createApp } from "../../server/src/app.js";
import { openDatabase } from "../../server/src/database.js";

const privateCanary = "LOCAL_ONLY_PRIORITY_STDIO_CANARY_MUST_NEVER_ESCAPE";

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

describe("TabHub built priority stdio server", () => {
  it(
    "caches fail-closed feature discovery for the lifetime of the stdio process",
    async () => {
      let featureRequests = 0;
      let featureBody: Record<string, boolean> = {
        context: false,
        logicalImportance: true,
        resources: true,
      };
      const discoveryServer = createServer((request, response) => {
        if (request.url !== "/api/features") {
          response.writeHead(404).end();
          return;
        }
        featureRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(featureBody));
      });
      await new Promise<void>((resolve, reject) => {
        discoveryServer.once("error", reject);
        discoveryServer.listen(0, "127.0.0.1", resolve);
      });
      let client: Client | undefined;
      try {
        const address = discoveryServer.address() as AddressInfo;
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
          { name: "tabhub-priority-discovery-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        const firstNames = (await client.listTools()).tools.map(({ name }) => name);
        expect(firstNames).not.toContain("set_user_importance");
        expect(firstNames).not.toContain("recompute_priority");
        expect(firstNames).not.toContain("get_job_status");
        const requestsAfterStartup = featureRequests;
        expect(requestsAfterStartup).toBeGreaterThan(0);
        featureBody = {
          context: false,
          logicalImportance: true,
          resources: true,
          agentUserImportance: true,
        };
        const secondNames = (await client.listTools()).tools.map(({ name }) => name);
        expect(secondNames).toEqual(firstNames);
        expect(featureRequests).toBe(requestsAfterStartup);
      } finally {
        await client?.close();
        await new Promise<void>((resolve, reject) => {
          discoveryServer.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    },
    30_000,
  );

  it(
    "submits priority recompute and reads durable status through the built stdio process",
    async () => {
      const httpCalls: Array<{
        method: string;
        url: string;
        body: unknown;
      }> = [];
      const ref = {
        id: "priority_assessment:41",
        kind: "priority_assessment",
        status: "queued",
      } as const;
      const view = {
        ...ref,
        subject: { type: "collection", scope: "all" },
        attempts: 0,
        maxAttempts: 3,
        progress: { completed: 0, total: null, stage: "queued" },
        canCancel: true,
        cancellationRequest: null,
        createdAt: "2026-08-13T07:00:00.000Z",
        startedAt: null,
        completedAt: null,
        nextAttemptAt: "2026-08-13T07:00:00.000Z",
        error: null,
        result: null,
      } as const;
      const boundaryServer = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/features") {
          response.end(JSON.stringify({
            context: false,
            logicalImportance: false,
            resources: false,
            priorityAssessmentWriter: true,
          }));
          return;
        }
        let rawBody = "";
        for await (const chunk of request) rawBody += String(chunk);
        httpCalls.push({
          method: request.method ?? "GET",
          url: request.url ?? "",
          body: rawBody === "" ? undefined : JSON.parse(rawBody),
        });
        if (
          request.method === "POST" &&
          request.url === "/api/agent/personalization/priority/recompute"
        ) {
          response.end(JSON.stringify(ref));
          return;
        }
        if (
          request.method === "GET" &&
          request.url === "/api/ai/jobs/priority_assessment:41"
        ) {
          response.end(JSON.stringify(view));
          return;
        }
        if (
          request.method === "GET" &&
          request.url === "/api/ai/jobs/priority_assessment:404"
        ) {
          response.writeHead(404).end(JSON.stringify({
            error: "JOB_NOT_FOUND",
            message: "The requested AI job is unavailable",
            privateDetail: privateCanary,
          }));
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
          { name: "tabhub-priority-jobs-stdio-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        const tools = (await client.listTools()).tools;
        const names = tools.map(({ name }) => name);
        expect(names).toContain("recompute_priority");
        expect(names).toContain("get_job_status");
        expect(names.filter((name) => name.includes("rule"))).toEqual([]);
        const publishedInputs = JSON.stringify(tools.filter(({ name }) =>
          name === "recompute_priority" || name === "get_job_status")
          .map(({ inputSchema }) => inputSchema));
        expect(publishedInputs).not.toContain("provenance");
        expect(publishedInputs).not.toContain("rawFeatures");
        expect(publishedInputs).not.toContain("budget");

        const authorizationRef = "user-instruction:priority-recompute-stdio";
        const idempotencyKey = "priority-recompute-stdio";
        const submitted = await client.callTool({
          name: "recompute_priority",
          arguments: {
            subject_type: "collection",
            idempotency_key: idempotencyKey,
            authorization_ref: authorizationRef,
            step_batch_size: 17,
          },
        });
        expect(JSON.parse(textResult(submitted))).toEqual(ref);
        expect(submitted.structuredContent).toEqual(ref);
        expect(httpCalls).toEqual([{
          method: "POST",
          url: "/api/agent/personalization/priority/recompute",
          body: {
            idempotencyKey,
            authorizationRef,
            stepBatchSize: 17,
          },
        }]);
        expect(textResult(submitted)).not.toContain(authorizationRef);
        expect(textResult(submitted)).not.toContain(idempotencyKey);

        const status = await client.callTool({
          name: "get_job_status",
          arguments: { id: ref.id },
        });
        expect(JSON.parse(textResult(status))).toEqual(view);
        expect(status.structuredContent).toEqual(view);
        expect(httpCalls.at(-1)).toEqual({
          method: "GET",
          url: "/api/ai/jobs/priority_assessment:41",
          body: undefined,
        });

        const callsBeforeInvalid = httpCalls.length;
        const invalid = await client.callTool({
          name: "recompute_priority",
          arguments: {
            subject_type: "collection",
            logical_page_id: 42,
            idempotency_key: "invalid-collection",
            authorization_ref: privateCanary,
            provenance: { requestedBy: "user", requestMethod: "manual" },
          },
        });
        expect(invalid.isError).toBe(true);
        expect(textResult(invalid)).not.toContain(privateCanary);
        expect(httpCalls).toHaveLength(callsBeforeInvalid);

        const wrongKind = await client.callTool({
          name: "get_job_status",
          arguments: { id: "resource_research:7" },
        });
        expect(wrongKind.isError).toBe(true);
        expect(textResult(wrongKind)).not.toContain(privateCanary);
        expect(httpCalls).toHaveLength(callsBeforeInvalid);

        const missing = await client.callTool({
          name: "get_job_status",
          arguments: { id: "priority_assessment:404" },
        });
        expect(missing.isError).toBe(true);
        expect(textResult(missing)).toBe(
          "TabHub API GET /api/ai/jobs/priority_assessment:404 returned HTTP 404: JOB_NOT_FOUND: The requested AI job is unavailable",
        );
        expect(textResult(missing)).not.toContain(privateCanary);
      } finally {
        await client?.close();
        await new Promise<void>((resolve, reject) => {
          boundaryServer.close((error) =>
            error === undefined ? resolve() : reject(error));
        });
      }
    },
    30_000,
  );

  it(
    "fails closed when a built stdio process receives a nested subject mismatch",
    async () => {
      const malformedServer = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/features") {
          response.end(JSON.stringify({
            context: false,
            logicalImportance: false,
            resources: false,
            priorityReaders: true,
          }));
          return;
        }
        if (request.url === "/api/logical-pages/42/priority") {
          response.end(JSON.stringify({
            subject: { type: "page", logicalPageId: 42 },
            outcome: {
              kind: "assessment",
              assessment: {
                id: 71,
                subject: { type: "page", logicalPageId: 43 },
                agentScore: 78,
                agentBand: "high",
                confidence: 0.82,
                needsReview: false,
                reasons: [],
                missingSignals: [],
                ruleset: { rulesetId: 1, version: 1 },
                featureFingerprint: "a".repeat(64),
                assessmentMethod: "rule",
                modelProvenance: null,
                revision: 1,
                evaluatedAt: "2026-08-13T07:00:00.000Z",
                supersededAt: null,
              },
            },
            isCurrent: true,
            dirty: false,
            needsReview: false,
          }));
          return;
        }
        response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
      });
      await new Promise<void>((resolve, reject) => {
        malformedServer.once("error", reject);
        malformedServer.listen(0, "127.0.0.1", resolve);
      });
      let client: Client | undefined;
      try {
        const address = malformedServer.address() as AddressInfo;
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
          { name: "tabhub-priority-malformed-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);
        const result = await client.callTool({
          name: "explain_priority",
          arguments: { subject_type: "page", logical_page_id: 42 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(textResult(result)).toBe(
          "TabHub API GET /api/logical-pages/42/priority returned an invalid response",
        );
      } finally {
        await client?.close();
        await new Promise<void>((resolve, reject) => {
          malformedServer.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    },
    30_000,
  );

  it(
    "discovers priority tools and executes privacy-safe explain/feedback transcripts",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-mcp-priority-stdio-"));
      const databasePath = join(directory, "tabhub.sqlite");
      const now = new Date("2026-08-13T07:30:00.000Z");
      const app = createApp({
        databasePath,
        featureFlags: {
          activityDailyWriter: false,
          activityWindows: false,
          context: true,
          logicalImportance: true,
          resources: true,
          priorityAssessmentWriter: true,
          priorityReaders: true,
          priorityShadow: true,
          research: false,
        },
        localDevProxySecret: "stdio-priority-local-secret",
        logger: false,
        clock: () => now,
        migrationClock: () => now,
      });
      let client: Client | undefined;
      try {
        const bootstrap = await app.inject({
          method: "POST",
          url: "/api/local/session/bootstrap",
          headers: {
            "x-tabhub-dev-proxy-secret": "stdio-priority-local-secret",
          },
        });
        expect(bootstrap.statusCode).toBe(204);
        const webCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;

        const ingest = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "133e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "233e4567-e89b-42d3-a456-426614174000",
            tabs: [{
              tabId: 27,
              url: "https://priority-stdio.example/research",
              title: "Priority stdio fixture",
              windowId: 1,
              index: 0,
              pinned: true,
            }],
          },
        });
        expect(ingest.statusCode).toBe(200);

        const database = openDatabase(databasePath);
        const logicalPageId = database.connection
          .prepare("SELECT logical_page_id FROM tabs WHERE url = ?")
          .pluck()
          .get("https://priority-stdio.example/research") as number;
        database.close();

        const localContext = await app.inject({
          method: "POST",
          url: `/api/local/pages/${logicalPageId}/context/commands`,
          headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: privateCanary,
            visibility: "local_only",
            idempotencyKey: "priority-stdio-local-only",
          },
        });
        expect(localContext.statusCode).toBe(200);

        const recompute = await app.inject({
          method: "POST",
          url: "/api/agent/personalization/priority/recompute",
          payload: {
            idempotencyKey: "priority-stdio-collection",
            authorizationRef: "user-instruction:priority-stdio-collection",
            stepBatchSize: 10,
          },
        });
        expect(recompute.statusCode).toBe(200);
        const jobId = (recompute.json() as { id: string }).id;
        let jobStatus = "queued";
        for (let attempt = 0; attempt < 100 &&
            (jobStatus === "queued" || jobStatus === "running"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const view = await app.inject({
            method: "GET",
            url: `/api/ai/jobs/${jobId}`,
          });
          expect(view.statusCode).toBe(200);
          jobStatus = (view.json() as { status: string }).status;
        }
        expect(jobStatus).toBe("succeeded");

        const directPage = await app.inject({
          method: "GET",
          url: `/api/logical-pages/${logicalPageId}/priority`,
        });
        expect(directPage.statusCode).toBe(200);
        expect(directPage.json()).toMatchObject({
          subject: { type: "page", logicalPageId },
          outcome: { kind: "assessment" },
          isCurrent: true,
          dirty: false,
        });
        expect(directPage.body).not.toContain(privateCanary);

        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const entrypoint = fileURLToPath(new URL("../dist/main.js", import.meta.url));
        const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [entrypoint],
          cwd: workspaceRoot,
          env: {
            ...getDefaultEnvironment(),
            TABHUB_API_URL: origin,
          },
          stderr: "pipe",
        });
        client = new Client(
          { name: "tabhub-priority-stdio-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        const tools = await client.listTools();
        const names = tools.tools.map(({ name }) => name);
        expect(names).toContain("explain_priority");
        expect(names).toContain("record_priority_feedback");
        expect(names).toContain("set_user_importance");
        expect(names).toContain("set_importance");

        const explained = await client.callTool({
          name: "explain_priority",
          arguments: { subject_type: "page", logical_page_id: logicalPageId },
        });
        const explainedText = textResult(explained);
        expect(JSON.parse(explainedText)).toEqual(directPage.json());
        expect(explained.structuredContent).toEqual(directPage.json());
        expect(explainedText).not.toContain(privateCanary);
        expect(explainedText).not.toContain("local_only");
        expect(explainedText).not.toContain("hiddenCount");
        expect(explainedText).not.toContain("rawFeatures");

        const assessmentId = (directPage.json() as {
          outcome: { assessment: { id: number } };
        }).outcome.assessment.id;
        const feedbackArguments = {
          subject_type: "page",
          logical_page_id: logicalPageId,
          assessment_id: assessmentId,
          verdict: "too_low",
          note: "The user explicitly marked this active research as more important.",
          idempotency_key: "priority-stdio-feedback",
          authorization_ref: "user-instruction:priority-stdio-feedback",
        };
        const feedback = await client.callTool({
          name: "record_priority_feedback",
          arguments: feedbackArguments,
        });
        const replay = await client.callTool({
          name: "record_priority_feedback",
          arguments: feedbackArguments,
        });
        expect(textResult(replay)).toBe(textResult(feedback));
        expect(JSON.parse(textResult(feedback))).toMatchObject({
          subject: { type: "page", logicalPageId },
          assessmentId,
          verdict: "too_low",
          provenance: { actor: "agent", method: "on_behalf_of_user" },
        });
        expect(textResult(feedback)).not.toContain("authorizationRef");
        expect(textResult(feedback)).not.toContain("idempotencyKey");
        expect(textResult(feedback)).not.toContain(privateCanary);
        const feedbackConflict = await client.callTool({
          name: "record_priority_feedback",
          arguments: { ...feedbackArguments, verdict: "accept" },
        });
        expect(feedbackConflict.isError).toBe(true);
        expect(textResult(feedbackConflict)).toContain("IDEMPOTENCY_KEY_CONFLICT");
        expect(textResult(feedbackConflict)).not.toContain(
          feedbackArguments.authorization_ref,
        );
        expect(textResult(feedbackConflict)).not.toContain(
          feedbackArguments.idempotency_key,
        );
        expect(textResult(feedbackConflict)).not.toContain(privateCanary);

        const importanceArguments = {
          subject_type: "page",
          logical_page_id: logicalPageId,
          value: 3,
          idempotency_key: "priority-stdio-user-importance",
          authorization_ref: "user-instruction:priority-stdio-user-importance",
        };
        const importance = await client.callTool({
          name: "set_user_importance",
          arguments: importanceArguments,
        });
        const importanceReplay = await client.callTool({
          name: "set_user_importance",
          arguments: importanceArguments,
        });
        expect(textResult(importanceReplay)).toBe(textResult(importance));
        expect(JSON.parse(textResult(importance))).toMatchObject({
          subject: { type: "page", logicalPageId },
          value: 3,
          provenance: { actor: "agent", method: "on_behalf_of_user" },
        });
        expect(textResult(importance)).not.toContain("authorizationRef");
        expect(textResult(importance)).not.toContain("idempotencyKey");
        expect(textResult(importance)).not.toContain(privateCanary);

        const missingImportance = await client.callTool({
          name: "set_user_importance",
          arguments: {
            ...importanceArguments,
            logical_page_id: 999_999,
            idempotency_key: "priority-stdio-missing-user-importance",
            authorization_ref: "user-instruction:priority-stdio-missing",
          },
        });
        expect(missingImportance.isError).toBe(true);
        expect(textResult(missingImportance)).toContain("SUBJECT_NOT_FOUND");
        expect(textResult(missingImportance)).not.toContain(
          "user-instruction:priority-stdio-missing",
        );
        expect(textResult(missingImportance)).not.toContain(
          "priority-stdio-missing-user-importance",
        );
        expect(textResult(missingImportance)).not.toContain(privateCanary);

        const importanceConflict = await client.callTool({
          name: "set_user_importance",
          arguments: { ...importanceArguments, value: 2 },
        });
        expect(importanceConflict.isError).toBe(true);
        expect(textResult(importanceConflict)).toContain(
          "IDEMPOTENCY_KEY_CONFLICT",
        );
        expect(textResult(importanceConflict)).not.toContain(
          importanceArguments.authorization_ref,
        );
        expect(textResult(importanceConflict)).not.toContain(
          importanceArguments.idempotency_key,
        );
        expect(textResult(importanceConflict)).not.toContain(privateCanary);

        const explainedAfterImportance = await client.callTool({
          name: "explain_priority",
          arguments: { subject_type: "page", logical_page_id: logicalPageId },
        });
        expect(textResult(explainedAfterImportance)).toBe(explainedText);

        const missing = await client.callTool({
          name: "explain_priority",
          arguments: { subject_type: "page", logical_page_id: 999_999 },
        });
        expect(missing.isError).toBe(true);
        expect(textResult(missing)).toContain("returned HTTP 404");
        expect(textResult(missing)).toContain(
          "The requested priority subject was not found",
        );
        expect(textResult(missing)).not.toContain(privateCanary);

        const readOnly = openDatabase(databasePath);
        try {
          expect(readOnly.connection.prepare(
            "SELECT COUNT(*) FROM priority_feedback",
          ).pluck().get()).toBe(1);
          expect(readOnly.connection.prepare(`
            SELECT user_importance, recorded_by, record_method
            FROM logical_page_preferences
            WHERE logical_page_id = ?
          `).get(logicalPageId)).toEqual({
            user_importance: 3,
            recorded_by: "agent",
            record_method: "on_behalf_of_user",
          });
          expect(readOnly.connection.prepare(
            "SELECT COUNT(*) FROM priority_assessments WHERE superseded_at IS NULL",
          ).pluck().get()).toBe(1);
        } finally {
          readOnly.close();
        }
      } finally {
        await client?.close();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
