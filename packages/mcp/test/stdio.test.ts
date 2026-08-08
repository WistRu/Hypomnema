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
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => new Date("2026-08-08T21:00:00.000Z"),
      });
      let client: Client | undefined;

      try {
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
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;
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
          "get_stats",
          "get_tab",
          "list_tabs",
          "list_tags",
          "search_tabs",
          "set_status",
          "tag_tabs",
        ]);

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
        expect(statsResult.total).toBe(1);
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
});
