import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import {
  tagPathSchema,
  type SummaryJob,
  type TabDetailResponse,
} from "@tabhub/shared";
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
const searchModeInputSchema = z.enum(["fulltext", "semantic"]);

const listTabsInputSchema = z
  .object({
    browser: z.string().trim().min(1).max(64).optional(),
    status: tabStatusInputSchema.optional(),
    importance: tabImportanceInputSchema.optional(),
    is_open: z.boolean().optional(),
    tag: tagPathSchema.optional(),
    q: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("A full-text or semantic query; cannot be combined with similar_to.")
      .optional(),
    search_mode: searchModeInputSchema
      .describe(
        "How to interpret q; semantic mode requires either q or similar_to.",
      )
      .optional(),
    similar_to: z
      .number()
      .int()
      .positive()
      .describe(
        "Find tabs similar to this positive TabHub tab ID; cannot be combined with q.",
      )
      .optional(),
    page: z.number().int().positive().default(1),
    page_size: z.number().int().positive().max(200).default(50),
  })
  .superRefine((input, context) => {
    if (input.q !== undefined && input.similar_to !== undefined) {
      context.addIssue({
        code: "custom",
        message: "q and similar_to cannot be combined",
      });
    }

    if (
      input.search_mode === "semantic" &&
      input.q === undefined &&
      input.similar_to === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Semantic search requires q or similar_to",
      });
    }
  });

const getTabInputSchema = z.object({
  id: z.number().int().positive(),
  include_content: z.boolean().default(false),
});

const searchTabsInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: searchModeInputSchema.default("fulltext"),
  browser: z.string().trim().min(1).max(64).optional(),
  status: tabStatusInputSchema.optional(),
  importance: tabImportanceInputSchema.optional(),
  is_open: z.boolean().optional(),
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const tabIdsInputSchema = z.array(z.number().int().positive()).min(1);

const setStatusInputSchema = z.object({
  ids: tabIdsInputSchema,
  status: tabStatusInputSchema,
});

const setImportanceInputSchema = z.object({
  ids: tabIdsInputSchema,
  level: tabImportanceInputSchema,
});

const tagTabsInputSchema = z.object({
  ids: tabIdsInputSchema,
  tag_path: tagPathSchema,
});

const linkTabsInputSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  kind: z.string().trim().min(1).max(128).default("related"),
  note: z.string().max(10_000).optional(),
});

const summarizeTabInputSchema = z.object({
  id: z.number().int().positive(),
  depth: z.enum(["short", "deep"]),
});

const clusterInboxInputSchema = z.object({
  max_clusters: z.number().int().min(1).max(50).default(8),
});

const retentionPageInputSchema = z.object({
  page: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(200).default(50),
});

const setPageRetentionInputSchema = z.object({
  id: z.number().int().positive(),
  decision: z.enum(["keep", "later"]),
});

const closeAndForgetPageInputSchema = z.object({
  id: z.number().int().positive(),
  confirmed: z
    .literal(true)
    .describe("Must be true only after the user explicitly confirms closure."),
});

const restoreRetentionPageInputSchema = z.object({
  id: z.number().int().positive(),
});

const emptyInputSchema = z.object({});

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
} as const;

const openWorldReadOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const summaryMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const createMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const destructiveMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const capturedTextLimit = 20_000;
const defaultSummaryPollIntervalMs = 250;
const defaultSummaryPollTimeoutMs = 55_000;

export interface McpServerOptions {
  summaryPollIntervalMs?: number;
  summaryPollTimeoutMs?: number;
}

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

function isPendingSummaryJob(job: SummaryJob): boolean {
  return job.status === "queued" || job.status === "running";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type TimedResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);

    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function pollSummaryJob(
  api: TabHubApi,
  jobId: number,
  intervalMs: number,
  timeoutMs: number,
): Promise<SummaryJob> {
  const deadline = Date.now() + timeoutMs;
  let job = await api.getSummaryJob(jobId);

  while (isPendingSummaryJob(job)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return job;
    }

    await delay(Math.min(intervalMs, remainingMs));
    const requestTimeMs = deadline - Date.now();
    if (requestTimeMs <= 0) {
      return job;
    }

    const next = await settleWithin(api.getSummaryJob(jobId), requestTimeMs);
    if (next.timedOut) {
      return job;
    }

    job = next.value;
  }

  return job;
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
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.q === undefined ? {} : { q: input.q }),
    ...(input.search_mode === undefined
      ? {}
      : { searchMode: input.search_mode }),
    ...(input.similar_to === undefined
      ? {}
      : { similarTo: input.similar_to }),
    page: input.page,
    pageSize: input.page_size,
  };
}

export function createMcpServer(
  api: TabHubApi,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "tabhub", version: "0.1.0" });
  const summaryPollIntervalMs =
    options.summaryPollIntervalMs ?? defaultSummaryPollIntervalMs;
  const summaryPollTimeoutMs =
    options.summaryPollTimeoutMs ?? defaultSummaryPollTimeoutMs;

  server.registerTool(
    "review_disposable_pages",
    {
      description:
        "Review personalized disposable-page suggestions with reasons and safety warnings. This only returns suggestions; it never closes or deletes pages.",
      inputSchema: retentionPageInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ page, page_size: pageSize }) =>
      runTool(() => api.reviewDisposablePages({ page, pageSize })),
  );

  server.registerTool(
    "set_page_retention",
    {
      description:
        "Record that a page should be kept or reviewed later. This never closes the page or moves it to trash.",
      inputSchema: setPageRetentionInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ id, decision }) =>
      runTool(() => api.setRetentionDecision({ tabId: id, decision })),
  );

  server.registerTool(
    "close_and_forget_page",
    {
      description:
        "After explicit user confirmation, close every known physical instance of a page and move its TabHub record to the seven-day trash. If closure cannot be verified exactly, the page is not trashed.",
      inputSchema: closeAndForgetPageInputSchema,
      annotations: destructiveMutationAnnotations,
    },
    async ({ id, confirmed }) =>
      runTool(() => api.closeAndForgetPage({ tabId: id, confirmed })),
  );

  server.registerTool(
    "list_retention_trash",
    {
      description:
        "List pages in TabHub's reversible retention trash, including their scheduled permanent-deletion time.",
      inputSchema: retentionPageInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ page, page_size: pageSize }) =>
      runTool(() => api.listRetentionTrash({ page, pageSize })),
  );

  server.registerTool(
    "restore_retention_page",
    {
      description:
        "Restore a page from TabHub's retention trash and record it as a page to keep.",
      inputSchema: restoreRetentionPageInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ id }) => runTool(() => api.restoreRetentionPage(id)),
  );

  server.registerTool(
    "list_tabs",
    {
      description:
        "List TabHub tabs with REST-compatible filters, including text search or tabs similar to a positive tab ID, and pagination.",
      inputSchema: listTabsInputSchema,
      annotations: openWorldReadOnlyAnnotations,
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
      description:
        "Search captured TabHub tabs using full-text or semantic search.",
      inputSchema: searchTabsInputSchema,
      annotations: openWorldReadOnlyAnnotations,
    },
    async (input) =>
      runTool(() =>
        api.listTabs({
          ...toListTabsInput({
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
          ...(input.mode === "semantic" ? { searchMode: input.mode } : {}),
        }),
      ),
  );

  server.registerTool(
    "summarize_tab",
    {
      description:
        "Start a short or deep summary for one tab and briefly wait for its result.",
      inputSchema: summarizeTabInputSchema,
      annotations: summaryMutationAnnotations,
    },
    async ({ id, depth }) =>
      runTool(async () => {
        const enqueued = await api.summarizeTab(id, depth);
        return pollSummaryJob(
          api,
          enqueued.jobId,
          summaryPollIntervalMs,
          summaryPollTimeoutMs,
        );
      }),
  );

  server.registerTool(
    "cluster_inbox",
    {
      description:
        "Group inbox tabs by semantic similarity and return proposed clusters.",
      inputSchema: clusterInboxInputSchema,
      annotations: summaryMutationAnnotations,
    },
    async ({ max_clusters: maxClusters }) =>
      runTool(() => api.clusterInbox(maxClusters)),
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
    "set_importance",
    {
      description: "Set the importance level for one or more TabHub tabs.",
      inputSchema: setImportanceInputSchema,
      annotations: mutationAnnotations,
    },
    async ({ ids, level }) =>
      runTool(() => api.setImportance({ ids, importance: level })),
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
    "link_tabs",
    {
      description: "Create a typed link between two TabHub tabs.",
      inputSchema: linkTabsInputSchema,
      annotations: createMutationAnnotations,
    },
    async ({ from, to, kind, note }) =>
      runTool(() =>
        api.linkTabs({
          from,
          to,
          kind,
          ...(note === undefined ? {} : { note }),
        }),
      ),
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
