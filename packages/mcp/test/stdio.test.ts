import { mkdtemp, rm } from "node:fs/promises";
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

function embeddingFor(text: string): number[] {
  const vector = Array<number>(512).fill(0);
  vector[/narwhal|research|extension/i.test(text) ? 0 : 1] = 1;
  return vector;
}

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

describe("TabHub built stdio server", () => {
  it(
    "serves all tools and mutates a live TabHub REST server",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-mcp-stdio-"));
      let now = new Date("2026-08-08T21:00:00.000Z");
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        featureFlags: {
          context: false,
          liveAcquisition: false,
          logicalImportance: true,
          priorityShadow: false,
          research: false,
          resources: false,
        },
        logger: false,
        clock: () => now,
        embeddingProvider: {
          provider: "fake",
          model: "fake-512",
          dimensions: 512,
          async embed(input) {
            return input.map(embeddingFor);
          },
        },
      });
      let client: Client | undefined;

      try {
        const enabledFeatures = await app.inject({
          method: "GET",
          url: "/api/features",
        });
        expect(enabledFeatures.statusCode).toBe(200);
        expect(enabledFeatures.json()).toEqual({
          context: false,
          liveAcquisition: false,
          logicalImportance: true,
          pageSummaryCapture: false,
          resources: false,
          activityWindows: false,
          agentUserImportance: true,
          priorityAssessmentWriter: false,
          priorityPersonalization: false,
          priorityReaders: false,
          priorityShadow: false,
          privacyPurge: false,
          research: false,
        });

        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "edge",
            tabs: [
              {
                url: "https://example.com/mcp-e2e",
                title: "Narwhal MCP acceptance",
                windowId: 1,
                index: 0,
              },
              {
                url: "https://www.google.com/search?q=mcp-related",
                title: "Related MCP reference",
                windowId: 1,
                index: 1,
              },
            ],
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/content",
          payload: {
            browser: "edge",
            url: "https://example.com/mcp-e2e",
            text: "Narwhal research captured through the extension.",
            htmlExcerpt: "<article>Narwhal research</article>",
          },
        });
        const reindex = await app.inject({
          method: "POST",
          url: "/api/embeddings/reindex",
          payload: { limit: 10 },
        });
        expect(reindex.statusCode).toBe(200);
        expect(reindex.json()).toMatchObject({ indexed: 1, dimensions: 512 });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const listedTabs = list.json().items as Array<{
          id: number;
          title: string;
        }>;
        const tabId = listedTabs.find(
          ({ title }) => title === "Narwhal MCP acceptance",
        )!.id;
        const relatedTabId = listedTabs.find(
          ({ title }) => title === "Related MCP reference",
        )!.id;
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const entrypoint = fileURLToPath(
          new URL("../dist/main.js", import.meta.url),
        );
        const workspaceRoot = fileURLToPath(
          new URL("../../..", import.meta.url),
        );
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
          { name: "tabhub-stdio-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "close_and_forget_page",
          "cluster_inbox",
          "get_ai_job",
          "get_research_report",
          "get_stats",
          "get_tab",
          "link_tabs",
          "list_research_reports",
          "list_retention_trash",
          "list_tabs",
          "list_tags",
          "restore_retention_page",
          "review_disposable_pages",
          "search_tabs",
          "set_importance",
          "set_page_retention",
          "set_status",
          "set_user_importance",
          "summarize_tab",
          "tag_tabs",
        ]);

        const retentionReview = await client.callTool({
          name: "review_disposable_pages",
          arguments: {},
        });
        const retentionReviewResult = JSON.parse(
          textResult(retentionReview),
        ) as { items: Array<{ tab: { id: number } }> };
        expect(
          retentionReviewResult.items.some(
            ({ tab }) => tab.id === relatedTabId,
          ),
        ).toBe(true);

        const semanticSearch = await client.callTool({
          name: "search_tabs",
          arguments: {
            query: "narwhal research",
            mode: "semantic",
          },
        });
        expect(JSON.parse(textResult(semanticSearch))).toMatchObject({
          total: 1,
          items: [{ id: tabId }],
        });

        const clustered = await client.callTool({
          name: "cluster_inbox",
          arguments: { max_clusters: 4 },
        });
        const clusterResult = JSON.parse(textResult(clustered)) as {
          clusters: Array<{ tabIds: number[]; size: number }>;
          indexed: number;
          unclustered: number;
        };
        expect(clusterResult.indexed).toBe(0);
        expect(clusterResult.unclustered).toBe(1);
        expect(
          clusterResult.clusters.reduce(
            (total, cluster) => total + cluster.size,
            clusterResult.unclustered,
          ),
        ).toBe(2);
        expect(clusterResult.clusters.flatMap(({ tabIds }) => tabIds)).toContain(
          tabId,
        );

        const search = await client.callTool({
          name: "search_tabs",
          arguments: { query: "narwhal", mode: "fulltext" },
        });
        expect(JSON.parse(textResult(search))).toMatchObject({
          total: 1,
          items: [{ id: tabId }],
        });

        await client.callTool({
          name: "set_status",
          arguments: { ids: [tabId], status: "done" },
        });
        await client.callTool({
          name: "tag_tabs",
          arguments: { ids: [tabId], tag_path: "Research/MCP" },
        });
        const duplicateSnapshot = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [
              {
                url: "https://example.com/mcp-e2e",
                title: "Narwhal MCP acceptance in Chrome",
                windowId: 2,
                index: 0,
              },
            ],
          },
        });
        expect(duplicateSnapshot.statusCode).toBe(200);
        const duplicateList = await app.inject({
          method: "GET",
          url: "/api/tabs?browser=chrome",
        });
        const duplicateTabId = (duplicateList.json().items as Array<{
          id: number;
        }>)[0]!.id;

        const auditDatabase = openDatabase(join(directory, "tabhub.sqlite"));
        try {
          const logicalPageId = auditDatabase.connection
            .prepare("SELECT logical_page_id FROM tabs WHERE id = ?")
            .pluck()
            .get(tabId) as number;
          auditDatabase.connection
            .prepare(`
              INSERT INTO logical_page_importance_migration_audit (
                logical_page_id,
                legacy_values_json,
                suggested_value,
                resolution_state,
                created_at,
                reviewed_at
              ) VALUES (?, ?, 2, 'legacy_unknown', ?, NULL)
            `)
            .run(
              logicalPageId,
              JSON.stringify([
                { tabId, browser: "edge", value: 2 },
                { tabId: duplicateTabId, browser: "chrome", value: 2 },
              ]),
              "2026-08-08T20:00:00.000Z",
            );
        } finally {
          auditDatabase.close();
        }

        const importance = await client.callTool({
          name: "set_importance",
          arguments: { ids: [tabId, duplicateTabId], level: 3 },
        });
        expect(JSON.parse(textResult(importance))).toEqual({
          updated: 2,
          importance: 3,
        });

        const firstLogicalPage = await app.inject({
          method: "GET",
          url: `/api/logical-pages/by-tab/${tabId}`,
        });
        expect(firstLogicalPage.statusCode).toBe(200);
        const firstLogicalPageBody = firstLogicalPage.json();
        expect(firstLogicalPageBody).toMatchObject({
          preference: {
            userImportance: 3,
            recordedBy: "agent",
            recordMethod: "on_behalf_of_user",
            importanceUpdatedAt: "2026-08-08T21:00:00.000Z",
            updatedAt: "2026-08-08T21:00:00.000Z",
          },
          legacyImportanceAudit: {
            resolutionState: "confirmed",
            reviewedAt: "2026-08-08T21:00:00.000Z",
          },
        });

        now = new Date("2026-08-08T21:05:00.000Z");
        const replayedImportance = await client.callTool({
          name: "set_importance",
          arguments: { ids: [tabId, duplicateTabId], level: 3 },
        });
        expect(JSON.parse(textResult(replayedImportance))).toEqual({
          updated: 2,
          importance: 3,
        });
        const replayedLogicalPage = await app.inject({
          method: "GET",
          url: `/api/logical-pages/by-tab/${tabId}`,
        });
        expect(replayedLogicalPage.statusCode).toBe(200);
        expect(replayedLogicalPage.body).toBe(firstLogicalPage.body);
        expect(replayedLogicalPage.json()).toEqual(firstLogicalPageBody);

        const missingImportance = await client.callTool({
          name: "set_importance",
          arguments: { ids: [999_999], level: 3 },
        });
        expect(missingImportance.isError).toBe(true);
        expect(textResult(missingImportance)).toContain(
          "PATCH /api/agent/tabs/importance returned HTTP 404",
        );
        await client.callTool({
          name: "link_tabs",
          arguments: {
            from: tabId,
            to: relatedTabId,
            kind: "follows",
            note: "Agent-created acceptance link",
          },
        });

        const managedDetail = await app.inject({
          method: "GET",
          url: `/api/tabs/${tabId}`,
        });
        expect(managedDetail.json()).toMatchObject({
          importance: 3,
          tags: [{ path: "Research/MCP", assignedBy: "agent" }],
          links: [
            {
              fromTab: tabId,
              toTab: relatedTabId,
              kind: "follows",
              note: "Agent-created acceptance link",
              createdBy: "agent",
            },
          ],
        });
        const duplicateDetail = await app.inject({
          method: "GET",
          url: `/api/tabs/${duplicateTabId}`,
        });
        expect(duplicateDetail.json()).toMatchObject({ importance: 3 });

        const logicalPage = await app.inject({
          method: "GET",
          url: `/api/logical-pages/by-tab/${tabId}`,
        });
        expect(logicalPage.statusCode).toBe(200);
        const logicalPageBody = logicalPage.json() as {
          preference: Record<string, unknown>;
          browserPages: Array<Record<string, unknown>>;
        };
        expect(logicalPageBody.preference).toMatchObject({
          userImportance: 3,
          recordedBy: "agent",
          recordMethod: "on_behalf_of_user",
        });
        expect(logicalPageBody.browserPages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tabId, browser: "edge" }),
            expect.objectContaining({
              tabId: duplicateTabId,
              browser: "chrome",
            }),
          ]),
        );

        const resource = await client.readResource({
          uri: `tabhub://tab/${tabId}`,
        });
        expect(resource.contents[0]).toMatchObject({
          uri: `tabhub://tab/${tabId}`,
          mimeType: "text/markdown",
        });
        const resourceContent = resource.contents[0];
        if (resourceContent === undefined || !("text" in resourceContent)) {
          throw new Error("Expected a text MCP resource");
        }
        expect(resourceContent.text).toContain("Narwhal research");
        expect(resourceContent.text).toContain("Research/MCP");

        const stats = await client.callTool({
          name: "get_stats",
          arguments: {},
        });
        const statsResult = JSON.parse(textResult(stats)) as {
          total: number;
          byStatus: Array<{ status: string; count: number }>;
          byTag: Array<{ path: string; total: number }>;
        };
        expect(statsResult.total).toBe(3);
        expect(
          statsResult.byStatus.find(({ status }) => status === "done"),
        ).toEqual({ status: "done", count: 1 });
        expect(
          statsResult.byTag.find(({ path }) => path === "Research"),
        ).toMatchObject({ path: "Research", total: 1 });
      } finally {
        await client?.close();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "discovers context before construction and serves privacy-safe context transcripts",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-mcp-context-stdio-"));
      const databasePath = join(directory, "tabhub.sqlite");
      const installationId = "122e4567-e89b-42d3-a456-426614174000";
      const browserSessionId = "222e4567-e89b-42d3-a456-426614174000";
      const browserTabId = 7;
      const url = "https://example.com/context-stdio";
      const app = createApp({
        databasePath,
        featureFlags: {
          context: true,
          logicalImportance: false,
          priorityShadow: false,
          research: false,
          resources: false,
        },
        localDevProxySecret: "stdio-context-local-secret",
        logger: false,
        clock: () => new Date("2026-08-12T12:00:00.000Z"),
      });
      let client: Client | undefined;
      try {
        const bootstrap = await app.inject({
          method: "POST",
          url: "/api/local/session/bootstrap",
          headers: {
            "x-tabhub-dev-proxy-secret": "stdio-context-local-secret",
          },
        });
        const webCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId,
            browserSessionId,
            tabs: [
              {
                tabId: browserTabId,
                url,
                title: "Context stdio fixture",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const database = openDatabase(databasePath);
        const logicalPageId = database.connection
          .prepare("SELECT logical_page_id FROM tabs WHERE url = ?")
          .pluck()
          .get(url) as number;
        database.close();

        await app.inject({
          method: "POST",
          url: `/api/local/pages/${logicalPageId}/context/commands`,
          headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: "PRIVATE_LOCAL_CONTEXT_CANARY",
            visibility: "local_only",
            idempotencyKey: "local-hidden-context",
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/local/session-intents/commands",
          headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "set",
            scope: { installationId, browserSessionId, browserTabId },
            expectedUrl: url,
            body: "PRIVATE_LOCAL_INTENT_CANARY",
            visibility: "local_only",
            idempotencyKey: "local-hidden-intent",
          },
        });

        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const entrypoint = fileURLToPath(
          new URL("../dist/main.js", import.meta.url),
        );
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
          { name: "tabhub-context-stdio-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
          "close_and_forget_page",
          "cluster_inbox",
          "get_ai_job",
          "get_page_context",
          "get_research_report",
          "get_stats",
          "get_tab",
          "get_tab_session_intent",
          "link_tabs",
          "list_research_reports",
          "list_retention_trash",
          "list_tabs",
          "list_tags",
          "restore_retention_page",
          "review_disposable_pages",
          "search_page_context",
          "search_tabs",
          "set_importance",
          "set_page_context",
          "set_page_retention",
          "set_status",
          "set_tab_session_intent",
          "summarize_tab",
          "tag_tabs",
        ]);
        expect(
          (await client.listResourceTemplates()).resourceTemplates
            .map(({ uriTemplate }) => uriTemplate)
            .sort(),
        ).toEqual(["tabhub://logical-page/{id}", "tabhub://tab/{id}"]);

        const pageArguments = {
          logical_page_id: logicalPageId,
          entry_kind: "purpose",
          body: "PUBLIC_CONTEXT_CANARY",
          idempotency_key: "stdio-public-context",
        };
        const firstPageReceipt = await client.callTool({
          name: "set_page_context",
          arguments: pageArguments,
        });
        const replayedPageReceipt = await client.callTool({
          name: "set_page_context",
          arguments: pageArguments,
        });
        expect(textResult(replayedPageReceipt)).toBe(textResult(firstPageReceipt));
        const receiptText = textResult(firstPageReceipt);
        expect(receiptText).toContain("PUBLIC_CONTEXT_CANARY");
        expect(receiptText).not.toContain("PRIVATE_LOCAL_CONTEXT_CANARY");
        expect(receiptText).not.toContain("idempotency");
        expect(receiptText).not.toContain('"id"');
        expect(receiptText).not.toContain("revision");

        const pageContext = await client.callTool({
          name: "get_page_context",
          arguments: { logical_page_id: logicalPageId },
        });
        const pageContextText = textResult(pageContext);
        expect(pageContextText).toContain("PUBLIC_CONTEXT_CANARY");
        expect(pageContextText).not.toContain("PRIVATE_LOCAL_CONTEXT_CANARY");
        expect(pageContextText).not.toContain("local_only");

        const searchedContext = await client.callTool({
          name: "search_page_context",
          arguments: {
            logical_page_id: logicalPageId,
            query: "CANARY",
          },
        });
        expect(textResult(searchedContext)).toContain("PUBLIC_CONTEXT_CANARY");
        expect(textResult(searchedContext)).not.toContain(
          "PRIVATE_LOCAL_CONTEXT_CANARY",
        );

        const setIntent = await client.callTool({
          name: "set_tab_session_intent",
          arguments: {
            installation_id: installationId,
            browser_session_id: browserSessionId,
            browser_tab_id: browserTabId,
            expected_url: url,
            body: "PUBLIC_INTENT_CANARY",
            idempotency_key: "stdio-public-intent",
            provenance: {
              method: "model",
              source_fingerprint: "stdio-model-source-v1",
              model: {
                provider: "fixture",
                name: "model-1",
                prompt_version: "prompt-v1",
              },
              confidence: 0.7,
            },
          },
        });
        const intentReceiptText = textResult(setIntent);
        expect(intentReceiptText).toContain("PUBLIC_INTENT_CANARY");
        expect(intentReceiptText).not.toContain("PRIVATE_LOCAL_INTENT_CANARY");
        expect(intentReceiptText).not.toContain("idempotency");
        expect(intentReceiptText).not.toContain('"id"');

        const intent = await client.callTool({
          name: "get_tab_session_intent",
          arguments: {
            installation_id: installationId,
            browser_session_id: browserSessionId,
            browser_tab_id: browserTabId,
          },
        });
        expect(textResult(intent)).toContain("PUBLIC_INTENT_CANARY");
        expect(textResult(intent)).not.toContain("PRIVATE_LOCAL_INTENT_CANARY");
        expect(textResult(intent)).not.toContain("local_only");

        const resource = await client.readResource({
          uri: `tabhub://logical-page/${logicalPageId}`,
        });
        const resourceContent = resource.contents[0];
        expect(resourceContent).toMatchObject({
          uri: `tabhub://logical-page/${logicalPageId}`,
          mimeType: "application/json",
        });
        if (resourceContent === undefined || !("text" in resourceContent)) {
          throw new Error("Expected logical-page text resource");
        }
        expect(resourceContent.text).toContain("PUBLIC_CONTEXT_CANARY");
        expect(resourceContent.text).not.toContain("PRIVATE_LOCAL_CONTEXT_CANARY");
      } finally {
        await client?.close();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "serves resource tools and URI through trusted REST projections",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-mcp-resource-stdio-"));
      const databasePath = join(directory, "tabhub.sqlite");
      let resourceNow = new Date("2026-08-12T12:00:00.000Z");
      const app = createApp({
        databasePath,
        featureFlags: {
          activityDailyWriter: true,
          activityWindows: true,
          context: false,
          logicalImportance: false,
          priorityShadow: false,
          research: false,
          resources: true,
        },
        localDevProxySecret: "stdio-resource-local-secret",
        logger: false,
        clock: () => resourceNow,
        migrationClock: () => new Date("2026-08-12T11:59:00.000Z"),
      });
      resourceNow = new Date("2026-08-12T13:00:00.000Z");
      let client: Client | undefined;
      try {
        const bootstrap = await app.inject({
          method: "POST",
          url: "/api/local/session/bootstrap",
          headers: {
            "x-tabhub-dev-proxy-secret": "stdio-resource-local-secret",
          },
        });
        const webCookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "123e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
            tabs: [
              {
                tabId: 17,
                url: "https://example.com/resource-stdio",
                title: "Resource stdio fixture",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const listed = await app.inject({ method: "GET", url: "/api/resources" });
        expect(listed.statusCode).toBe(200);
        const resourceId = (listed.json().items as Array<{
          resource: { id: number };
        }>)[0]!.resource.id;
        const activityIngest = await app.inject({
          method: "POST",
          url: "/api/ingest/activity",
          payload: {
            id: "323e4567-e89b-42d3-a456-426614174000",
            browser: "chrome",
            installationId: "123e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
            browserTabId: 17,
            sequence: 1,
            url: "https://example.com/resource-stdio",
            startedAt: "2026-08-12T12:00:00.000Z",
            endedAt: "2026-08-12T12:00:10.000Z",
            foregroundMs: 10_000,
            engagedMs: 4_000,
          },
        });
        expect(activityIngest.statusCode).toBe(200);
        expect(activityIngest.json()).toEqual({ accepted: true });
        const restActivity = await app.inject({
          method: "GET",
          url: `/api/resources/${resourceId}/activity?window=7d`,
        });
        expect(restActivity.statusCode).toBe(200);
        const localContext = await app.inject({
          method: "POST",
          url: `/api/resources/${resourceId}/context`,
          headers: { cookie: webCookie, "sec-fetch-site": "same-origin" },
          payload: {
            kind: "append",
            entryKind: "note",
            body: "PRIVATE_RESOURCE_CONTEXT_CANARY",
            visibility: "local_only",
            idempotencyKey: "local-hidden-resource-context",
          },
        });
        expect(localContext.statusCode).toBe(200);

        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const entrypoint = fileURLToPath(
          new URL("../dist/main.js", import.meta.url),
        );
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
          { name: "tabhub-resource-stdio-test", version: "0.1.0" },
          { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(transport);

        const names = (await client.listTools()).tools.map(({ name }) => name);
        for (const name of [
          "list_resources",
          "get_resource",
          "get_resource_activity",
          "get_resource_context",
          "set_resource_context",
          "set_resource_evaluation",
        ]) {
          expect(names).toContain(name);
        }
        expect(
          (await client.listResourceTemplates()).resourceTemplates.map(
            ({ uriTemplate }) => uriTemplate,
          ),
        ).toContain("tabhub://resource/{id}");

        const resources = await client.callTool({
          name: "list_resources",
          arguments: { page_size: 10 },
        });
        expect(textResult(resources)).toContain('"logicalPageCount":1');
        expect(textResult(resources)).toContain('"coverageStart":null');

        const activity = await client.callTool({
          name: "get_resource_activity",
          arguments: { resource_id: resourceId, window: "7d" },
        });
        const expectedActivity = restActivity.json();
        expect(expectedActivity).toMatchObject({
          resourceId,
          activity: {
            window: "7d",
            onScreenMs: 10_000,
            activeUseMs: 4_000,
            coverageStart: expect.any(String),
            windowStart: "2026-08-06T00:00:00.000Z",
            windowEnd: "2026-08-13T00:00:00.000Z",
          },
        });
        expect(JSON.parse(textResult(activity))).toEqual(expectedActivity);
        expect(activity.structuredContent).toEqual(expectedActivity);

        const contextArguments = {
          resource_id: resourceId,
          entry_kind: "purpose",
          body: "PUBLIC_RESOURCE_CONTEXT_CANARY",
          idempotency_key: "stdio-public-resource-context",
        };
        const firstContext = await client.callTool({
          name: "set_resource_context",
          arguments: contextArguments,
        });
        const replayedContext = await client.callTool({
          name: "set_resource_context",
          arguments: contextArguments,
        });
        expect(textResult(replayedContext)).toBe(textResult(firstContext));
        expect(textResult(firstContext)).toContain("PUBLIC_RESOURCE_CONTEXT_CANARY");
        expect(textResult(firstContext)).not.toContain("PRIVATE_RESOURCE_CONTEXT_CANARY");

        const evaluationArguments = {
          resource_id: resourceId,
          evaluation: 3,
          idempotency_key: "stdio-resource-evaluation",
          authorization_ref: "user-instruction:stdio-resource-evaluation",
        };
        const firstEvaluation = await client.callTool({
          name: "set_resource_evaluation",
          arguments: evaluationArguments,
        });
        const replayedEvaluation = await client.callTool({
          name: "set_resource_evaluation",
          arguments: evaluationArguments,
        });
        expect(textResult(replayedEvaluation)).toBe(textResult(firstEvaluation));
        expect(JSON.parse(textResult(firstEvaluation)).provenance).toEqual({
          actor: "agent",
          method: "on_behalf_of_user",
        });

        const context = await client.callTool({
          name: "get_resource_context",
          arguments: { resource_id: resourceId },
        });
        expect(textResult(context)).toContain("PUBLIC_RESOURCE_CONTEXT_CANARY");
        expect(textResult(context)).not.toContain("PRIVATE_RESOURCE_CONTEXT_CANARY");
        expect(textResult(context)).not.toContain("local_only");

        const detail = await client.callTool({
          name: "get_resource",
          arguments: { resource_id: resourceId },
        });
        const detailJson = JSON.parse(textResult(detail)) as {
          counts: Record<string, number>;
          allTimeActivity: { coverageStart: string | null };
          preference: { userEvaluation: number | null };
        };
        expect(detailJson.counts).toEqual({
          logicalPageCount: 1,
          browserPageCount: 1,
          physicalOpenCopyCount: 1,
        });
        expect(detailJson.allTimeActivity.coverageStart).toBeNull();
        expect(detailJson.preference.userEvaluation).toBe(3);

        const uri = await client.readResource({
          uri: `tabhub://resource/${resourceId}`,
        });
        const uriText = uri.contents[0];
        if (uriText === undefined || !("text" in uriText)) {
          throw new Error("Expected resource JSON text");
        }
        expect(uriText.text).toContain("PUBLIC_RESOURCE_CONTEXT_CANARY");
        expect(uriText.text).not.toContain("PRIVATE_RESOURCE_CONTEXT_CANARY");
        expect(uriText.text).not.toContain("local_only");
      } finally {
        await client?.close();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
