import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type {
  ClusterInboxResponse,
  RetentionReviewResponse,
  RetentionTrashResponse,
  SummaryJob,
  TabDetailResponse,
  TabListResponse,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpServer,
  type ListTabsInput,
  type McpServerOptions,
  type TabHubApi,
} from "../src/server.js";

const tabList: TabListResponse = {
  items: [
    {
      id: 1,
      url: "https://example.com/agent-notes",
      urlNormalized: "https://example.com/agent-notes",
      title: "Agent notes",
      browser: "chrome",
      windowId: 3,
      index: 0,
      faviconUrl: null,
      status: "inbox",
      importance: 2,
      isOpen: true,
      firstSeenAt: "2026-08-08T12:00:00.000Z",
      lastSeenAt: "2026-08-08T12:30:00.000Z",
      closedAt: null,
      summary: null,
      tagPaths: ["Work/Research"],
      foregroundTimeMs: 125_000,
      engagedTimeMs: 45_000,
      openInstanceCount: 0,
      openForegroundTimeMs: 0,
      openEngagedTimeMs: 0,
    },
  ],
  total: 1,
  page: 2,
  pageSize: 25,
};

const tabDetail: TabDetailResponse = {
  ...tabList.items[0]!,
  content: {
    text: "Captured agent notes",
    htmlExcerpt: "<main>Captured agent notes</main>",
    summary: "A concise summary",
    summaryModel: "test-model",
    extractedAt: "2026-08-08T12:31:00.000Z",
  },
  tags: [
    {
      id: 7,
      name: "Research",
      path: "Work/Research",
      color: null,
      assignedBy: "agent",
    },
  ],
  links: [],
  customFields: {},
};

const queuedSummaryJob: SummaryJob = {
  id: 12,
  tabId: 1,
  depth: "deep",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  createdAt: "2026-08-08T12:31:00.000Z",
  startedAt: null,
  completedAt: null,
  nextAttemptAt: null,
  error: null,
  result: null,
};

const runningSummaryJob: SummaryJob = {
  ...queuedSummaryJob,
  status: "running",
  attempts: 1,
  startedAt: "2026-08-08T12:31:01.000Z",
};

const succeededSummaryJob: SummaryJob = {
  ...runningSummaryJob,
  status: "succeeded",
  completedAt: "2026-08-08T12:31:02.000Z",
  result: {
    summary: "A generated summary",
    model: "test-model",
    usage: {
      inputTokens: 120,
      outputTokens: 24,
      costUsd: 0.001,
    },
  },
};

const clusterResponse: ClusterInboxResponse = {
  clusters: [
    {
      name: "Agent research",
      keywords: ["agents", "tools"],
      tabIds: [1],
      size: 1,
    },
  ],
  indexed: 7,
  unclustered: 6,
};

const retentionReviewResponse: RetentionReviewResponse = {
  items: [
    {
      tab: tabList.items[0]!,
      score: 0.8,
      reasons: ["no_captured_content", "no_links"],
      warnings: [{ kind: "open_instances", count: 1 }],
    },
  ],
  total: 1,
  page: 2,
  pageSize: 25,
};

const forgottenPageResponse = {
  tabId: 1,
  outcome: "trashed" as const,
  reason: null,
  closedInstanceCount: 1,
  purgeAt: "2026-08-19T06:30:00.000Z",
};

const retentionTrashResponse: RetentionTrashResponse = {
  items: [
    {
      tab: tabList.items[0]!,
      decidedBy: "agent",
      trashedAt: "2026-08-12T06:30:00.000Z",
      purgeAt: "2026-08-19T06:30:00.000Z",
    },
  ],
  total: 1,
  page: 2,
  pageSize: 10,
};

const toolNames = [
  "cluster_inbox",
  "close_and_forget_page",
  "review_disposable_pages",
  "restore_retention_page",
  "list_tabs",
  "get_tab",
  "link_tabs",
  "list_retention_trash",
  "search_tabs",
  "set_page_retention",
  "set_status",
  "set_importance",
  "tag_tabs",
  "summarize_tab",
  "list_tags",
  "get_stats",
];

function createApi(overrides: Partial<TabHubApi> = {}): TabHubApi {
  return {
    reviewDisposablePages: async () => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    }),
    listRetentionTrash: async () => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    }),
    setRetentionDecision: async () => {
      throw new Error("not implemented in this test");
    },
    closeAndForgetPage: async () => {
      throw new Error("not implemented in this test");
    },
    restoreRetentionPage: async () => {
      throw new Error("not implemented in this test");
    },
    listTabs: async () => tabList,
    getTab: async () => {
      throw new Error("not implemented in this test");
    },
    setStatus: async () => {
      throw new Error("not implemented in this test");
    },
    setImportance: async () => {
      throw new Error("not implemented in this test");
    },
    tagTabs: async () => {
      throw new Error("not implemented in this test");
    },
    linkTabs: async () => {
      throw new Error("not implemented in this test");
    },
    summarizeTab: async () => {
      throw new Error("not implemented in this test");
    },
    getSummaryJob: async () => {
      throw new Error("not implemented in this test");
    },
    clusterInbox: async () => {
      throw new Error("not implemented in this test");
    },
    listTags: async () => ({ items: [] }),
    getStats: async () => ({
      total: 0,
      open: 0,
      byStatus: [],
      byBrowser: [],
      byTag: [],
    }),
    ...overrides,
  };
}

async function connectClient(api: TabHubApi, options?: McpServerOptions) {
  const server = createMcpServer(api, options);
  const client = new Client({ name: "tabhub-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

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

  if (block?.type !== "text") {
    throw new Error("Expected a text MCP result");
  }

  return block.text;
}

describe("TabHub MCP server", () => {
  it("reviews personalized disposable-page suggestions without mutating them", async () => {
    const reviewDisposablePages = vi.fn(async () => retentionReviewResponse);
    const connection = await connectClient(
      createApi({ reviewDisposablePages }),
    );

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(
        ({ name }) => name === "review_disposable_pages",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(tool?.description).toContain("suggestions");

      const result = await connection.client.callTool({
        name: "review_disposable_pages",
        arguments: { page: 2, page_size: 25 },
      });

      expect(reviewDisposablePages).toHaveBeenCalledWith({
        page: 2,
        pageSize: 25,
      });
      expect(JSON.parse(textResult(result))).toEqual(retentionReviewResponse);
    } finally {
      await connection.close();
    }
  });

  it("records keep or later retention decisions without closing pages", async () => {
    const setRetentionDecision = vi.fn(async () => ({
      tabId: 1,
      decision: "later" as const,
      state: "deferred" as const,
      decidedBy: "agent" as const,
      decidedAt: "2026-08-12T06:30:00.000Z",
      reviewAfter: "2026-08-19T06:30:00.000Z",
      trashedAt: null,
      purgeAt: null,
    }));
    const connection = await connectClient(
      createApi({ setRetentionDecision }),
    );

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(
        ({ name }) => name === "set_page_retention",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });

      const unsafeTrash = await connection.client.callTool({
        name: "set_page_retention",
        arguments: { id: 1, decision: "trash" },
      });
      expect(unsafeTrash.isError).toBe(true);
      expect(setRetentionDecision).not.toHaveBeenCalled();

      const result = await connection.client.callTool({
        name: "set_page_retention",
        arguments: { id: 1, decision: "later" },
      });

      expect(setRetentionDecision).toHaveBeenCalledWith({
        tabId: 1,
        decision: "later",
      });
      expect(JSON.parse(textResult(result))).toMatchObject({
        tabId: 1,
        decision: "later",
        state: "deferred",
      });
    } finally {
      await connection.close();
    }
  });

  it("requires explicit confirmation before closing every instance and forgetting a page", async () => {
    const closeAndForgetPage = vi.fn(async () => forgottenPageResponse);
    const connection = await connectClient(createApi({ closeAndForgetPage }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(
        ({ name }) => name === "close_and_forget_page",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tool?.description).toContain("explicit user confirmation");

      const unconfirmed = await connection.client.callTool({
        name: "close_and_forget_page",
        arguments: { id: 1 },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(closeAndForgetPage).not.toHaveBeenCalled();

      const confirmed = await connection.client.callTool({
        name: "close_and_forget_page",
        arguments: { id: 1, confirmed: true },
      });

      expect(closeAndForgetPage).toHaveBeenCalledWith({
        tabId: 1,
        confirmed: true,
      });
      expect(JSON.parse(textResult(confirmed))).toEqual(forgottenPageResponse);
    } finally {
      await connection.close();
    }
  });

  it("lists the reversible retention trash without changing it", async () => {
    const listRetentionTrash = vi.fn(async () => retentionTrashResponse);
    const connection = await connectClient(createApi({ listRetentionTrash }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(
        ({ name }) => name === "list_retention_trash",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });

      const result = await connection.client.callTool({
        name: "list_retention_trash",
        arguments: { page: 2, page_size: 10 },
      });

      expect(listRetentionTrash).toHaveBeenCalledWith({
        page: 2,
        pageSize: 10,
      });
      expect(JSON.parse(textResult(result))).toEqual(retentionTrashResponse);
    } finally {
      await connection.close();
    }
  });

  it("restores a page from retention trash with a fresh keep decision", async () => {
    const restoredResponse = {
      tabId: 1,
      decision: "keep" as const,
      state: "kept" as const,
      decidedBy: "agent" as const,
      decidedAt: "2026-08-12T06:35:00.000Z",
      reviewAfter: null,
      trashedAt: null,
      purgeAt: null,
    };
    const restoreRetentionPage = vi.fn(async () => restoredResponse);
    const connection = await connectClient(
      createApi({ restoreRetentionPage }),
    );

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(
        ({ name }) => name === "restore_retention_page",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });

      const result = await connection.client.callTool({
        name: "restore_retention_page",
        arguments: { id: 1 },
      });

      expect(restoreRetentionPage).toHaveBeenCalledWith(1);
      expect(JSON.parse(textResult(result))).toEqual(restoredResponse);
    } finally {
      await connection.close();
    }
  });

  it("lists filtered tabs through the MCP interface", async () => {
    const listTabs = vi.fn(async (_input: ListTabsInput) => tabList);
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        [...toolNames].sort(),
      );

      const result = await connection.client.callTool({
        name: "list_tabs",
        arguments: {
          browser: "chrome",
          status: "inbox",
          importance: 2,
          is_open: true,
          tag: "AI/Agents",
          page: 2,
          page_size: 25,
        },
      });

      expect(listTabs).toHaveBeenCalledWith({
        browser: "chrome",
        status: "inbox",
        importance: 2,
        isOpen: true,
        tag: "AI/Agents",
        page: 2,
        pageSize: 25,
      });
      expect(JSON.parse(textResult(result))).toEqual(tabList);
    } finally {
      await connection.close();
    }
  });

  it("lists tabs similar to a positive tab ID through the MCP interface", async () => {
    const listTabs = vi.fn(async (_input: ListTabsInput) => tabList);
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(({ name }) => name === "list_tabs");
      expect(tool?.description).toContain("similar");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });

      const result = await connection.client.callTool({
        name: "list_tabs",
        arguments: {
          similar_to: 41,
          search_mode: "semantic",
          page_size: 10,
        },
      });

      expect(listTabs).toHaveBeenCalledWith({
        similarTo: 41,
        searchMode: "semantic",
        page: 1,
        pageSize: 10,
      });
      expect(JSON.parse(textResult(result))).toEqual(tabList);
    } finally {
      await connection.close();
    }
  });

  it("rejects incompatible or incomplete list-tab search filters", async () => {
    const listTabs = vi.fn(async (_input: ListTabsInput) => tabList);
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const incompatible = await connection.client.callTool({
        name: "list_tabs",
        arguments: { q: "agent", similar_to: 41 },
      });
      const incompleteSemantic = await connection.client.callTool({
        name: "list_tabs",
        arguments: { search_mode: "semantic" },
      });
      const invalidId = await connection.client.callTool({
        name: "list_tabs",
        arguments: { similar_to: 0 },
      });
      const invalidTag = await connection.client.callTool({
        name: "list_tabs",
        arguments: { tag: "Research//AI" },
      });

      expect(incompatible.isError).toBe(true);
      expect(textResult(incompatible)).toContain(
        "q and similar_to cannot be combined",
      );
      expect(incompleteSemantic.isError).toBe(true);
      expect(textResult(incompleteSemantic)).toContain(
        "Semantic search requires q or similar_to",
      );
      expect(invalidId.isError).toBe(true);
      expect(invalidTag.isError).toBe(true);
      expect(listTabs).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("gets a tab with captured text only when requested", async () => {
    const getTab = vi.fn(async (_id: number) => tabDetail);
    const connection = await connectClient(createApi({ getTab }));

    try {
      const compact = await connection.client.callTool({
        name: "get_tab",
        arguments: { id: 1 },
      });
      const compactTab = JSON.parse(textResult(compact)) as TabDetailResponse;
      expect(compactTab.content).toEqual({
        summary: "A concise summary",
        summaryModel: "test-model",
        extractedAt: "2026-08-08T12:31:00.000Z",
      });

      const withContent = await connection.client.callTool({
        name: "get_tab",
        arguments: { id: 1, include_content: true },
      });
      const contentTab = JSON.parse(textResult(withContent)) as TabDetailResponse;
      expect(contentTab.content?.text).toBe("Captured agent notes");
      expect(contentTab.content).not.toHaveProperty("htmlExcerpt");
      expect(getTab).toHaveBeenNthCalledWith(1, 1);
      expect(getTab).toHaveBeenNthCalledWith(2, 1);
    } finally {
      await connection.close();
    }
  });

  it("searches full text through the tab list endpoint", async () => {
    const listTabs = vi.fn(async (_input: ListTabsInput) => tabList);
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const result = await connection.client.callTool({
        name: "search_tabs",
        arguments: {
          query: "agent notes",
          mode: "fulltext",
          status: "inbox",
          page_size: 10,
        },
      });

      expect(listTabs).toHaveBeenCalledWith({
        q: "agent notes",
        status: "inbox",
        page: 1,
        pageSize: 10,
      });
      expect(JSON.parse(textResult(result))).toEqual(tabList);
    } finally {
      await connection.close();
    }
  });

  it("routes semantic search through the REST search mode", async () => {
    const listTabs = vi.fn(async (_input: ListTabsInput) => tabList);
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(({ name }) => name === "search_tabs");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });

      const result = await connection.client.callTool({
        name: "search_tabs",
        arguments: {
          query: "agent research",
          mode: "semantic",
          page_size: 10,
        },
      });

      expect(listTabs).toHaveBeenCalledWith({
        q: "agent research",
        searchMode: "semantic",
        page: 1,
        pageSize: 10,
      });
      expect(JSON.parse(textResult(result))).toEqual(tabList);
    } finally {
      await connection.close();
    }
  });

  it("sets status and tags tabs through atomic REST adapter operations", async () => {
    const setStatus = vi.fn(async () => ({ updated: 2, status: "done" as const }));
    const tagTabs = vi.fn(async () => ({ tagId: 7, assigned: 2 }));
    const connection = await connectClient(createApi({ setStatus, tagTabs }));

    try {
      const statusResult = await connection.client.callTool({
        name: "set_status",
        arguments: { ids: [1, 2], status: "done" },
      });
      const tagResult = await connection.client.callTool({
        name: "tag_tabs",
        arguments: { ids: [1, 2], tag_path: "Work/Research" },
      });

      expect(setStatus).toHaveBeenCalledWith({ ids: [1, 2], status: "done" });
      expect(tagTabs).toHaveBeenCalledWith({
        ids: [1, 2],
        tagPath: "Work/Research",
      });
      expect(JSON.parse(textResult(statusResult))).toEqual({
        updated: 2,
        status: "done",
      });
      expect(JSON.parse(textResult(tagResult))).toEqual({
        tagId: 7,
        assigned: 2,
      });
    } finally {
      await connection.close();
    }
  });

  it("forwards every Library tab ID above the former MCP bulk ceiling", async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => index + 1);
    const setStatus = vi.fn(async () => ({
      updated: ids.length,
      status: "done" as const,
    }));
    const connection = await connectClient(createApi({ setStatus }));

    try {
      const result = await connection.client.callTool({
        name: "set_status",
        arguments: { ids, status: "done" },
      });

      expect(setStatus).toHaveBeenCalledWith({ ids, status: "done" });
      expect(JSON.parse(textResult(result))).toEqual({
        updated: ids.length,
        status: "done",
      });
    } finally {
      await connection.close();
    }
  });

  it("sets importance using the MCP level vocabulary", async () => {
    const setImportance = vi.fn(async () => ({
      updated: 2,
      importance: 3 as const,
    }));
    const connection = await connectClient(createApi({ setImportance }));

    try {
      const result = await connection.client.callTool({
        name: "set_importance",
        arguments: { ids: [1, 2], level: 3 },
      });

      expect(setImportance).toHaveBeenCalledWith({
        ids: [1, 2],
        importance: 3,
      });
      expect(JSON.parse(textResult(result))).toEqual({
        updated: 2,
        importance: 3,
      });
    } finally {
      await connection.close();
    }
  });

  it("links tabs with a related default and non-idempotent mutation metadata", async () => {
    const linkTabs = vi.fn(async () => ({
      id: 21,
      fromTab: 1,
      toTab: 2,
      kind: "related",
      note: null,
      createdBy: "agent" as const,
    }));
    const connection = await connectClient(createApi({ linkTabs }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(({ name }) => name === "link_tabs");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });

      const result = await connection.client.callTool({
        name: "link_tabs",
        arguments: { from: 1, to: 2 },
      });

      expect(linkTabs).toHaveBeenCalledWith({
        from: 1,
        to: 2,
        kind: "related",
      });
      expect(JSON.parse(textResult(result))).toEqual({
        id: 21,
        fromTab: 1,
        toTab: 2,
        kind: "related",
        note: null,
        createdBy: "agent",
      });
    } finally {
      await connection.close();
    }
  });

  it("enqueues an agent summary and polls until the job is terminal", async () => {
    const summarizeTab = vi.fn(async () => ({
      jobId: 12,
      status: "queued" as const,
    }));
    const getSummaryJob = vi
      .fn(async (_id: number): Promise<SummaryJob> => queuedSummaryJob)
      .mockResolvedValueOnce(queuedSummaryJob)
      .mockResolvedValueOnce(runningSummaryJob)
      .mockResolvedValueOnce(succeededSummaryJob);
    const connection = await connectClient(
      createApi({ summarizeTab, getSummaryJob }),
      { summaryPollIntervalMs: 1, summaryPollTimeoutMs: 100 },
    );

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(({ name }) => name === "summarize_tab");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });

      const result = await connection.client.callTool({
        name: "summarize_tab",
        arguments: { id: 1, depth: "deep" },
      });

      expect(summarizeTab).toHaveBeenCalledWith(1, "deep");
      expect(getSummaryJob).toHaveBeenCalledTimes(3);
      expect(getSummaryJob).toHaveBeenNthCalledWith(1, 12);
      expect(JSON.parse(textResult(result))).toEqual(succeededSummaryJob);
    } finally {
      await connection.close();
    }
  });

  it("returns the current summary job when the polling window expires", async () => {
    const summarizeTab = vi.fn(async () => ({
      jobId: 12,
      status: "queued" as const,
    }));
    const getSummaryJob = vi
      .fn(async (_id: number): Promise<SummaryJob> => queuedSummaryJob)
      .mockResolvedValueOnce(queuedSummaryJob)
      .mockReturnValueOnce(new Promise<SummaryJob>(() => undefined));
    const connection = await connectClient(
      createApi({ summarizeTab, getSummaryJob }),
      { summaryPollIntervalMs: 1, summaryPollTimeoutMs: 20 },
    );

    try {
      const result = await Promise.race([
        connection.client.callTool({
          name: "summarize_tab",
          arguments: { id: 1, depth: "deep" },
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Summary polling exceeded its timeout")),
            250,
          ),
        ),
      ]);

      expect(getSummaryJob).toHaveBeenCalledTimes(2);
      expect(JSON.parse(textResult(result))).toEqual(queuedSummaryJob);
    } finally {
      await connection.close();
    }
  });

  it("clusters the inbox with the canonical default cluster limit", async () => {
    const clusterInbox = vi.fn(async () => clusterResponse);
    const connection = await connectClient(createApi({ clusterInbox }));

    try {
      const listed = await connection.client.listTools();
      const tool = listed.tools.find(({ name }) => name === "cluster_inbox");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });

      const result = await connection.client.callTool({
        name: "cluster_inbox",
        arguments: {},
      });

      expect(clusterInbox).toHaveBeenCalledWith(8);
      expect(JSON.parse(textResult(result))).toEqual(clusterResponse);
    } finally {
      await connection.close();
    }
  });

  it("lists the tag tree and aggregate stats", async () => {
    const tagTree = {
      items: [
        {
          id: 7,
          name: "Work",
          path: "Work",
          color: null,
          tabCount: 2,
          children: [],
        },
      ],
    };
    const stats = {
      total: 2,
      open: 1,
      byStatus: [{ status: "inbox" as const, count: 2 }],
      byBrowser: [],
      byTag: [],
    };
    const listTags = vi.fn(async () => tagTree);
    const getStats = vi.fn(async () => stats);
    const connection = await connectClient(createApi({ listTags, getStats }));

    try {
      const tagsResult = await connection.client.callTool({
        name: "list_tags",
        arguments: {},
      });
      const statsResult = await connection.client.callTool({
        name: "get_stats",
        arguments: {},
      });

      expect(listTags).toHaveBeenCalledOnce();
      expect(getStats).toHaveBeenCalledOnce();
      expect(JSON.parse(textResult(tagsResult))).toEqual(tagTree);
      expect(JSON.parse(textResult(statsResult))).toEqual(stats);
    } finally {
      await connection.close();
    }
  });

  it("publishes tab details as a markdown resource", async () => {
    const getTab = vi.fn(async (_id: number) => tabDetail);
    const connection = await connectClient(createApi({ getTab }));

    try {
      const templates = await connection.client.listResourceTemplates();
      expect(templates.resourceTemplates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uriTemplate: "tabhub://tab/{id}" }),
        ]),
      );

      const result = await connection.client.readResource({
        uri: "tabhub://tab/1",
      });
      const resource = result.contents[0];
      expect(resource?.uri).toBe("tabhub://tab/1");
      expect(resource?.mimeType).toBe("text/markdown");
      expect(resource).toHaveProperty("text");
      if (resource && "text" in resource) {
        expect(resource.text).toContain("# Agent notes");
        expect(resource.text).toContain("https://example.com/agent-notes");
        expect(resource.text).toContain("Work/Research");
        expect(resource.text).toContain("Captured agent notes");
      }
      expect(getTab).toHaveBeenCalledWith(1);
    } finally {
      await connection.close();
    }
  });

  it("returns adapter failures as MCP tool errors without stack traces", async () => {
    const listTabs = vi.fn(async () => {
      throw new Error("TabHub API returned HTTP 503");
    });
    const connection = await connectClient(createApi({ listTabs }));

    try {
      const result = await connection.client.callTool({
        name: "list_tabs",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(textResult(result)).toBe("TabHub API returned HTTP 503");
      expect(textResult(result)).not.toContain("at ");
    } finally {
      await connection.close();
    }
  });
});
