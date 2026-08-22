import type {
  ClusterInboxResponse,
  ExactTabScope,
  RetentionDecisionResponse,
  RetentionForgetResponse,
  RetentionReviewResponse,
  RetentionTrashResponse,
  SummaryEnqueueResponse,
  SummaryJob,
  StatsResponse,
  ShareableContextBundle,
  ShareableContextEntry,
  ShareableSessionIntentBundle,
  TabDetailResponse,
  TabLink,
  TabListResponse,
  TagTreeResponse,
} from "@tabhub/shared";
import { tabListItemSchema } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createTabHubApi,
  type AgentContextMutationReceipt,
  type AgentSessionIntentMutationReceipt,
} from "../src/tabhub-api.js";

const listResponse: TabListResponse = {
  items: [],
  total: 0,
  page: 2,
  pageSize: 25,
};

const detailResponse: TabDetailResponse = {
  id: 3,
  logicalPageId: 3,
  url: "https://example.com",
  urlNormalized: "https://example.com/",
  title: "Example",
  browser: "chrome",
  windowId: 1,
  index: 0,
  faviconUrl: null,
  status: "inbox",
  importance: 1,
  isOpen: true,
  firstSeenAt: "2026-08-08T12:00:00.000Z",
  lastSeenAt: "2026-08-08T12:30:00.000Z",
  closedAt: null,
  summary: null,
  tagPaths: [],
  foregroundTimeMs: 125_000,
  engagedTimeMs: 45_000,
  openInstanceCount: 0,
  openForegroundTimeMs: 0,
  openEngagedTimeMs: 0,
  content: null,
  tags: [],
  links: [],
  customFields: {},
};

const retentionReviewResponse: RetentionReviewResponse = {
  items: [
    {
      tab: tabListItemSchema.parse(detailResponse),
      score: 0.8,
      reasons: ["closed", "no_captured_content"],
      warnings: [],
    },
  ],
  total: 1,
  page: 2,
  pageSize: 25,
};

const keptRetentionResponse: RetentionDecisionResponse = {
  tabId: 3,
  decision: "keep",
  state: "kept",
  decidedBy: "agent",
  decidedAt: "2026-08-12T06:30:00.000Z",
  reviewAfter: null,
  trashedAt: null,
  purgeAt: null,
};

const deferredRetentionResponse: RetentionDecisionResponse = {
  ...keptRetentionResponse,
  decision: "later",
  state: "deferred",
  reviewAfter: "2026-08-19T06:30:00.000Z",
};

const forgottenRetentionResponse: RetentionForgetResponse = {
  tabId: 3,
  outcome: "trashed",
  reason: null,
  closedInstanceCount: 2,
  purgeAt: "2026-08-19T06:30:00.000Z",
};

const retentionTrashResponse: RetentionTrashResponse = {
  items: [
    {
      tab: retentionReviewResponse.items[0]!.tab,
      decidedBy: "agent",
      trashedAt: "2026-08-12T06:30:00.000Z",
      purgeAt: "2026-08-19T06:30:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
};

const tagTree: TagTreeResponse = { items: [] };
const stats: StatsResponse = {
  total: 0,
  open: 0,
  byStatus: [],
  byBrowser: [],
  byTag: [],
};

const summaryEnqueueResponse: SummaryEnqueueResponse = {
  jobId: 12,
  status: "queued",
};

const summaryJob: SummaryJob = {
  id: 12,
  tabId: 3,
  depth: "deep",
  status: "succeeded",
  attempts: 1,
  maxAttempts: 3,
  createdAt: "2026-08-08T12:31:00.000Z",
  startedAt: "2026-08-08T12:31:01.000Z",
  completedAt: "2026-08-08T12:31:02.000Z",
  nextAttemptAt: null,
  error: null,
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

const createdLink: TabLink = {
  id: 21,
  fromTab: 3,
  toTab: 4,
  kind: "related",
  note: "Read these together",
  createdBy: "agent",
};

const clusterResponse: ClusterInboxResponse = {
  clusters: [
    {
      name: "Agent research",
      keywords: ["agents", "tools"],
      tabIds: [3, 4],
      size: 2,
    },
  ],
  indexed: 7,
  unclustered: 5,
};

const exactScope: ExactTabScope = {
  installationId: "122e4567-e89b-42d3-a456-426614174000",
  browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
  browserTabId: 7,
};
const shareableContextEntry: ShareableContextEntry = {
  entryKind: "purpose",
  body: "Compare agent frameworks",
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  visibility: "share_with_ai",
  staleAt: null,
  state: "active",
  createdAt: "2026-08-12T10:00:00.000Z",
  reviewVerdict: null,
};
const shareableContextBundle: ShareableContextBundle = {
  subject: { type: "page", logicalPageId: 42 },
  entries: [shareableContextEntry],
  currentEntries: [shareableContextEntry],
  preview: {
    entryKind: "purpose",
    body: "Compare agent frameworks",
    actor: "agent",
  },
};
const shareableSessionIntentBundle: ShareableSessionIntentBundle = {
  scope: exactScope,
  current: {
    scope: exactScope,
    subject: { type: "page", logicalPageId: 42 },
    expectedPage: {
      logicalPageId: 42,
      url: "https://example.com/research",
      urlNormalized: "https://example.com/research",
      instanceRevision: 3,
    },
    body: "Compare this exact open copy",
    provenance: { actor: "agent", method: "on_behalf_of_user" },
    visibility: "share_with_ai",
    staleAt: null,
    state: "active",
    createdAt: "2026-08-12T10:01:00.000Z",
    updatedAt: "2026-08-12T10:01:00.000Z",
  },
  history: [],
};
const contextMutationReceipt: AgentContextMutationReceipt = {
  kind: "appended",
  entry: shareableContextEntry,
};
const sessionIntentMutationReceipt: AgentSessionIntentMutationReceipt = {
  kind: "set",
  intent: shareableSessionIntentBundle.current!,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TabHub REST adapter", () => {
  it("discovers the complete feature contract and treats only exact 404 as schema-17", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({
          context: true,
          logicalImportance: false,
          agentUserImportance: true,
        }),
      )
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getFeatures()).resolves.toEqual({
      context: true,
      logicalImportance: false,
      agentUserImportance: true,
    });
    await expect(api.getFeatures()).resolves.toEqual({
      context: false,
      logicalImportance: false,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:7717/api/features",
      { method: "GET" },
    );
  });

  it("reads only strict shareable context from page-scoped agent routes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(shareableContextBundle))
      .mockResolvedValueOnce(jsonResponse([shareableContextEntry]))
      .mockResolvedValueOnce(jsonResponse(shareableSessionIntentBundle));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getPageContext(42)).resolves.toEqual(shareableContextBundle);
    await expect(
      api.searchPageContext({
        logicalPageId: 42,
        query: "agent frameworks",
        limit: 12,
      }),
    ).resolves.toEqual([shareableContextEntry]);
    await expect(api.getTabSessionIntent(exactScope)).resolves.toEqual(
      shareableSessionIntentBundle,
    );

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ["http://127.0.0.1:7717/api/agent/pages/42/context", "GET"],
      [
        "http://127.0.0.1:7717/api/agent/context/search?q=agent+frameworks&logicalPageId=42&limit=12",
        "GET",
      ],
      [
        `http://127.0.0.1:7717/api/agent/session-intents?installationId=${exactScope.installationId}&browserSessionId=${exactScope.browserSessionId}&browserTabId=7`,
        "GET",
      ],
    ]);
  });

  it("writes idempotent shareable context through strict agent-only payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(contextMutationReceipt))
      .mockResolvedValueOnce(jsonResponse(contextMutationReceipt))
      .mockResolvedValueOnce(jsonResponse(sessionIntentMutationReceipt));
    const api = createTabHubApi({ fetchImpl });
    const pageCommand = {
      kind: "append" as const,
      entryKind: "purpose" as const,
      body: "Compare agent frameworks",
      provenance: { method: "on_behalf_of_user" as const },
      idempotencyKey: "user-instruction-42",
    };

    await expect(
      api.setPageContext({ logicalPageId: 42, command: pageCommand }),
    ).resolves.toEqual(contextMutationReceipt);
    await expect(
      api.setPageContext({ logicalPageId: 42, command: pageCommand }),
    ).resolves.toEqual(contextMutationReceipt);
    await expect(
      api.setTabSessionIntent({
        kind: "set",
        scope: exactScope,
        expectedUrl: "https://example.com/research",
        body: "Model-proposed exact next action",
        provenance: {
          method: "model",
          sourceFingerprint: "intent-source-v1",
          model: {
            provider: "fixture",
            name: "model-1",
            promptVersion: "prompt-v2",
          },
          confidence: 0.8,
        },
        idempotencyKey: "model-intent-7",
      }),
    ).resolves.toEqual(sessionIntentMutationReceipt);

    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    }))).toEqual([
      {
        url: "http://127.0.0.1:7717/api/agent/pages/42/context",
        method: "POST",
        body: pageCommand,
      },
      {
        url: "http://127.0.0.1:7717/api/agent/pages/42/context",
        method: "POST",
        body: pageCommand,
      },
      {
        url: "http://127.0.0.1:7717/api/agent/session-intents",
        method: "POST",
        body: {
          kind: "set",
          scope: exactScope,
          expectedUrl: "https://example.com/research",
          body: "Model-proposed exact next action",
          provenance: {
            method: "model",
            sourceFingerprint: "intent-source-v1",
            model: {
              provider: "fixture",
              name: "model-1",
              promptVersion: "prompt-v2",
            },
            confidence: 0.8,
          },
          idempotencyKey: "model-intent-7",
        },
      },
    ]);
  });

  it("reviews disposable-page candidates through the exact paginated REST endpoint", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(retentionReviewResponse),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.reviewDisposablePages({ page: 2, pageSize: 25 }),
    ).resolves.toEqual(retentionReviewResponse);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(requestUrl)).toBe(
      "http://127.0.0.1:7717/api/retention/review?page=2&pageSize=25",
    );
    expect(init?.method).toBe("GET");
  });

  it("applies keep and later retention decisions with agent provenance", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(keptRetentionResponse))
      .mockResolvedValueOnce(jsonResponse(deferredRetentionResponse));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.setRetentionDecision({ tabId: 3, decision: "keep" }),
    ).resolves.toEqual(keptRetentionResponse);
    await expect(
      api.setRetentionDecision({ tabId: 3, decision: "later" }),
    ).resolves.toEqual(deferredRetentionResponse);

    expect(
      fetchImpl.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "http://127.0.0.1:7717/api/retention/tabs/3",
        method: "PATCH",
        body: JSON.stringify({ decision: "keep", decidedBy: "agent" }),
      },
      {
        url: "http://127.0.0.1:7717/api/retention/tabs/3",
        method: "PATCH",
        body: JSON.stringify({ decision: "later", decidedBy: "agent" }),
      },
    ]);
  });

  it("uses the close-and-forget lifecycle only after explicit confirmation", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(forgottenRetentionResponse),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.closeAndForgetPage({ tabId: 3, confirmed: true }),
    ).resolves.toEqual(forgottenRetentionResponse);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7717/api/retention/tabs/3/forget",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "agent", confirmed: true }),
      },
    );
  });

  it("lists the retention trash through the exact paginated REST endpoint", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(retentionTrashResponse),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.listRetentionTrash({ page: 1, pageSize: 50 }),
    ).resolves.toEqual(retentionTrashResponse);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7717/api/retention/trash?page=1&pageSize=50",
      { method: "GET" },
    );
  });

  it("restores a trashed page with agent provenance", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(keptRetentionResponse),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(api.restoreRetentionPage(3)).resolves.toEqual(
      keptRetentionResponse,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7717/api/retention/trash/3/restore",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "agent" }),
      },
    );
  });

  it("rejects malformed retention lifecycle responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({ ...retentionReviewResponse, total: -1 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...keptRetentionResponse, state: "unknown" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...forgottenRetentionResponse, reason: "unknown" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...retentionTrashResponse, pageSize: 0 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...keptRetentionResponse, decidedAt: "not-a-date" }),
      );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.reviewDisposablePages({ page: 1, pageSize: 50 }),
    ).rejects.toThrow("returned an invalid response");
    await expect(
      api.setRetentionDecision({ tabId: 3, decision: "keep" }),
    ).rejects.toThrow("returned an invalid response");
    await expect(
      api.closeAndForgetPage({ tabId: 3, confirmed: true }),
    ).rejects.toThrow("returned an invalid response");
    await expect(
      api.listRetentionTrash({ page: 1, pageSize: 50 }),
    ).rejects.toThrow("returned an invalid response");
    await expect(api.restoreRetentionPage(3)).rejects.toThrow(
      "returned an invalid response",
    );
  });

  it("maps list filters to the server query contract and validates the response", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(listResponse));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.listTabs({
        browser: "chrome",
        status: "inbox",
        importance: 2,
        isOpen: false,
        tag: "AI/Agents",
        q: "agent notes",
        searchMode: "semantic",
        page: 2,
        pageSize: 25,
      }),
    ).resolves.toEqual(listResponse);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      "http://127.0.0.1:7717/api/tabs",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      browser: "chrome",
      status: "inbox",
      importance: "2",
      is_open: "false",
      tag: "AI/Agents",
      q: "agent notes",
      search_mode: "semantic",
      page: "2",
      pageSize: "25",
    });
    expect(init?.method).toBe("GET");
  });

  it("maps a similar-tab filter to the exact REST query parameter", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(listResponse));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717/",
      fetchImpl,
    });

    await expect(
      api.listTabs({
        similarTo: 37,
        searchMode: "semantic",
        page: 1,
        pageSize: 10,
      }),
    ).resolves.toEqual(listResponse);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      "http://127.0.0.1:7717/api/tabs",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      similar_to: "37",
      search_mode: "semantic",
      page: "1",
      pageSize: "10",
    });
    expect(init?.method).toBe("GET");
  });

  it("uses the exact detail, mutation, tag, and stats endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(detailResponse))
      .mockResolvedValueOnce(jsonResponse({ updated: 2, status: "done" }))
      .mockResolvedValueOnce(jsonResponse({ tagId: 7, assigned: 2 }))
      .mockResolvedValueOnce(jsonResponse(tagTree))
      .mockResolvedValueOnce(jsonResponse(stats));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    await expect(api.getTab(3)).resolves.toEqual(detailResponse);
    await expect(
      api.setStatus({ ids: [3, 4], status: "done" }),
    ).resolves.toEqual({ updated: 2, status: "done" });
    await expect(
      api.tagTabs({ ids: [3, 4], tagPath: "Work/Research" }),
    ).resolves.toEqual({ tagId: 7, assigned: 2 });
    await expect(api.listTags()).resolves.toEqual(tagTree);
    await expect(api.getStats()).resolves.toEqual(stats);

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body,
    }));
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7717/api/tabs/3",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:7717/api/tabs/status",
        method: "PATCH",
        body: JSON.stringify({ ids: [3, 4], status: "done" }),
      },
      {
        url: "http://127.0.0.1:7717/api/tags/assign",
        method: "POST",
        body: JSON.stringify({
          ids: [3, 4],
          tagPath: "Work/Research",
          assignedBy: "agent",
        }),
      },
      {
        url: "http://127.0.0.1:7717/api/tags",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:7717/api/stats",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("enqueues agent summaries and fetches validated summary jobs", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(summaryEnqueueResponse))
      .mockResolvedValueOnce(jsonResponse(summaryJob));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    await expect(api.summarizeTab(3, "deep")).resolves.toEqual(
      summaryEnqueueResponse,
    );
    await expect(api.getSummaryJob(12)).resolves.toEqual(summaryJob);

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body,
    }));
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7717/api/tabs/3/summarize",
        method: "POST",
        body: JSON.stringify({ depth: "deep", requestedBy: "agent" }),
      },
      {
        url: "http://127.0.0.1:7717/api/jobs/12",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("sets user-commanded importance through the trusted agent REST contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({ context: false, logicalImportance: true }),
      )
      .mockResolvedValueOnce(jsonResponse({ updated: 2, importance: 3 }));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    const runtimeInput = {
      ids: [3, 4],
      importance: 3 as const,
      recordedBy: "user",
      recordMethod: "manual",
    };
    await expect(api.setImportance(runtimeInput)).resolves.toEqual({
      updated: 2,
      importance: 3,
    });

    expect(
      fetchImpl.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "http://127.0.0.1:7717/api/features",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:7717/api/agent/tabs/importance",
        method: "PATCH",
        body: JSON.stringify({ ids: [3, 4], importance: 3 }),
      },
    ]);
    expect(fetchImpl.mock.calls[1]![1]?.headers).toEqual({
      "content-type": "application/json",
    });
  });

  it("uses the exact legacy importance route when the feature is disabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({ context: false, logicalImportance: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ updated: 1, importance: 2 }));
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    await expect(
      api.setImportance({ ids: [3], importance: 2 }),
    ).resolves.toEqual({ updated: 1, importance: 2 });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:7717/api/features",
      { method: "GET" },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:7717/api/tabs/importance",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [3], importance: 2 }),
      },
    );
  });

  it("falls back to the legacy route only when schema 17 returns feature 404", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ updated: 1, importance: 1 }));
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.setImportance({ ids: [3], importance: 1 }),
    ).resolves.toEqual({ updated: 1, importance: 1 });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:7717/api/tabs/importance",
    );
  });

  it("fails closed before importance mutation on malformed feature state", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse({ logicalImportance: "yes" }),
    );
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.setImportance({ ids: [3], importance: 3 }),
    ).rejects.toThrow(
      "TabHub API GET /api/features returned an invalid response",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed before importance mutation on non-404 feature errors", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse({ message: "Feature state unavailable" }, 503),
    );
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.setImportance({ ids: [3], importance: 3 }),
    ).rejects.toThrow(
      "TabHub API GET /api/features returned HTTP 503: Feature state unavailable",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed before importance mutation when feature discovery is unreachable", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new TypeError("feature discovery connection failed");
    });
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.setImportance({ ids: [3], importance: 3 }),
    ).rejects.toThrow("feature discovery connection failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("creates links with explicit agent provenance", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(createdLink, 201),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    await expect(
      api.linkTabs({
        from: 3,
        to: 4,
        kind: "related",
        note: "Read these together",
      }),
    ).resolves.toEqual(createdLink);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:7717/api/links");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: 3,
        to: 4,
        kind: "related",
        note: "Read these together",
        createdBy: "agent",
      }),
    });
  });

  it("rejects malformed importance and link mutation responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({ context: false, logicalImportance: true }),
      )
      .mockResolvedValueOnce(jsonResponse({ updated: -1, importance: 3 }))
      .mockResolvedValueOnce(
        jsonResponse({ ...createdLink, createdBy: "system" }),
      );
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.setImportance({ ids: [3], importance: 3 }),
    ).rejects.toThrow(
      "TabHub API PATCH /api/agent/tabs/importance returned an invalid response",
    );
    await expect(
      api.linkTabs({ from: 3, to: 4, kind: "related" }),
    ).rejects.toThrow(
      "TabHub API POST /api/links returned an invalid response",
    );
  });

  it("requests inbox clusters through the exact REST contract", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse(clusterResponse),
    );
    const api = createTabHubApi({
      baseUrl: "http://127.0.0.1:7717",
      fetchImpl,
    });

    await expect(api.clusterInbox(4)).resolves.toEqual(clusterResponse);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:7717/api/clusters/inbox");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxClusters: 4 }),
    });
  });

  it("rejects malformed cluster responses", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse({ ...clusterResponse, indexed: -1 }),
    );
    const api = createTabHubApi({ fetchImpl });

    await expect(api.clusterInbox(4)).rejects.toThrow(
      "TabHub API POST /api/clusters/inbox returned an invalid response",
    );
  });

  it("rejects malformed summary enqueue and job responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        jsonResponse({ ...summaryEnqueueResponse, jobId: "12" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...summaryJob, status: "complete" }),
      );
    const api = createTabHubApi({ fetchImpl });

    await expect(api.summarizeTab(3, "deep")).rejects.toThrow(
      "TabHub API POST /api/tabs/3/summarize returned an invalid response",
    );
    await expect(api.getSummaryJob(12)).rejects.toThrow(
      "TabHub API GET /api/jobs/12 returned an invalid response",
    );
  });

  it("reports HTTP failures with the server message", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse({ message: "No tab exists with id 404" }, 404),
    );
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getTab(404)).rejects.toThrow(
      "TabHub API GET /api/tabs/404 returned HTTP 404: No tab exists with id 404",
    );
  });
});
