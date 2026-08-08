import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { TabDetailResponse } from "@tabhub/shared";
import * as z from "zod/v4";

import type { ListTabsInput, TabHubApi } from "./tabhub-api.js";

export type { ListTabsInput, TabHubApi } from "./tabhub-api.js";

const tabStatusInputSchema = z.enum([
  "inbox",
  "in_progress",
  "done",
  "archived",
]);
const tabImportanceInputSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const listTabsInputSchema = z.object({
  browser: z.string().trim().min(1).max(64).optional(),
  status: tabStatusInputSchema.optional(),
  importance: tabImportanceInputSchema.optional(),
  is_open: z.boolean().optional(),
  q: z.string().trim().min(1).max(500).optional(),
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const getTabInputSchema = z.object({
  id: z.number().int().positive(),
  include_content: z.boolean().default(false),
});

const searchTabsInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(["fulltext"]).default("fulltext"),
  browser: z.string().trim().min(1).max(64).optional(),
  status: tabStatusInputSchema.optional(),
  importance: tabImportanceInputSchema.optional(),
  is_open: z.boolean().optional(),
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const tabIdsInputSchema = z.array(z.number().int().positive()).min(1).max(1_000);

const setStatusInputSchema = z.object({
  ids: tabIdsInputSchema,
  status: tabStatusInputSchema,
});

const tagTabsInputSchema = z.object({
  ids: tabIdsInputSchema,
  tag_path: z.string().trim().min(1).max(2_048),
});

const emptyInputSchema = z.object({});

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const capturedTextLimit = 20_000;

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          error instanceof Error
            ? error.message
            : "The TabHub operation failed unexpectedly",
      },
    ],
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

function truncateCapturedText(text: string): string {
  if (text.length <= capturedTextLimit) {
    return text;
  }

  return `${text.slice(0, capturedTextLimit)}\n\n[Captured text truncated]`;
}

function formatTabForTool(tab: TabDetailResponse, includeContent: boolean) {
  return {
    ...tab,
    content:
      tab.content === null
        ? null
        : {
            ...(includeContent && tab.content.text !== null
              ? { text: truncateCapturedText(tab.content.text) }
              : {}),
            summary: tab.content.summary,
            summaryModel: tab.content.summaryModel,
            extractedAt: tab.content.extractedAt,
          },
  };
}

function formatTabResource(tab: TabDetailResponse): string {
  const title = tab.title?.trim() || tab.url;
  const tags = tab.tags.map((tag) => tag.path).join(", ") || "None";
  const summary = tab.content?.summary?.trim() || "No summary captured.";
  const capturedText =
    tab.content?.text === null || tab.content?.text === undefined
      ? "No page text captured."
      : truncateCapturedText(tab.content.text);

  return [
    `# ${title}`,
    "",
    `- URL: ${tab.url}`,
    `- Tab ID: ${tab.id}`,
    `- Browser: ${tab.browser}`,
    `- Status: ${tab.status}`,
    `- Importance: ${tab.importance}`,
    `- Open: ${tab.isOpen ? "yes" : "no"}`,
    `- Tags: ${tags}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Captured text",
    "",
    capturedText,
  ].join("\n");
}

function toListTabsInput(
  input: z.infer<typeof listTabsInputSchema>,
): ListTabsInput {
  return {
    ...(input.browser === undefined ? {} : { browser: input.browser }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.importance === undefined
      ? {}
      : { importance: input.importance }),
    ...(input.is_open === undefined ? {} : { isOpen: input.is_open }),
    ...(input.q === undefined ? {} : { q: input.q }),
    page: input.page,
    pageSize: input.page_size,
  };
}

export function createMcpServer(api: TabHubApi): McpServer {
  const server = new McpServer({ name: "tabhub", version: "0.1.0" });

  server.registerTool(
    "list_tabs",
    {
      description: "List TabHub tabs with optional filters and pagination.",
      inputSchema: listTabsInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => runTool(() => api.listTabs(toListTabsInput(input))),
  );

  server.registerTool(
    "get_tab",
    {
      description:
        "Get one TabHub tab. Captured page text is omitted unless include_content is true.",
      inputSchema: getTabInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ id, include_content: includeContent }) =>
      runTool(async () => formatTabForTool(await api.getTab(id), includeContent)),
  );

  server.registerTool(
    "search_tabs",
    {
      description: "Search captured TabHub tabs using full-text search.",
      inputSchema: searchTabsInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool(() =>
        api.listTabs(
          toListTabsInput({
            ...(input.browser === undefined ? {} : { browser: input.browser }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.importance === undefined
              ? {}
              : { importance: input.importance }),
            ...(input.is_open === undefined ? {} : { is_open: input.is_open }),
            q: input.query,
            page: input.page,
            page_size: input.page_size,
          }),
        ),
      ),
  );

  server.registerTool(
    "set_status",
    {
      description: "Set the workflow status for one or more TabHub tabs.",
      inputSchema: setStatusInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, status }) => runTool(() => api.setStatus({ ids, status })),
  );

  server.registerTool(
    "tag_tabs",
    {
      description:
        "Assign a hierarchical tag path to one or more TabHub tabs.",
      inputSchema: tagTabsInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, tag_path: tagPath }) =>
      runTool(() => api.tagTabs({ ids, tagPath })),
  );

  server.registerTool(
    "list_tags",
    {
      description: "List the TabHub tag tree with tab counts.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => api.listTags()),
  );

  server.registerTool(
    "get_stats",
    {
      description: "Get aggregate TabHub counts by status, browser, and tag.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => api.getStats()),
  );

  server.registerResource(
    "tab",
    new ResourceTemplate("tabhub://tab/{id}", { list: undefined }),
    {
      title: "TabHub tab",
      description: "A TabHub tab with metadata and captured page content.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables.id)
        ? variables.id[0]
        : variables.id;
      const id = Number(rawId);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Invalid TabHub tab ID: ${String(rawId)}`);
      }

      const tab = await api.getTab(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: formatTabResource(tab),
          },
        ],
      };
    },
  );

  return server;
}
