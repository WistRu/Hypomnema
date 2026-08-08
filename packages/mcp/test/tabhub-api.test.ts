import type {
  SummaryEnqueueResponse,
  SummaryJob,
  StatsResponse,
  TabDetailResponse,
  TabListResponse,
  TagTreeResponse,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createTabHubApi } from "../src/tabhub-api.js";

const listResponse: TabListResponse = {
  items: [],
  total: 0,
  page: 2,
  pageSize: 25,
};

const detailResponse: TabDetailResponse = {
  id: 3,
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
  content: null,
  tags: [],
  links: [],
  customFields: {},
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TabHub REST adapter", () => {
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
        q: "agent notes",
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
      q: "agent notes",
      page: "2",
      pageSize: "25",
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
