import {
  agentContextMutationReceiptSchema,
  agentUserImportanceResponseSchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceListResponseSchema,
  resourcePagesResponseSchema,
  shareableContextBundleSchema,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createTabHubApi } from "../src/tabhub-api.js";

const timestamp = "2026-08-12T10:00:00.000Z";
const resource = resourceDetailSchema.parse({
  resource: {
    id: 7,
    resourceKey: "youtube",
    name: "YouTube",
    kind: "platform",
    accessClass: "public",
    lifecycleState: "active",
    mergedIntoResourceId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  version: 2,
  preference: {
    userEvaluation: 3,
    provenance: { actor: "agent", method: "on_behalf_of_user" },
    updatedAt: timestamp,
  },
  counts: {
    logicalPageCount: 12,
    browserPageCount: 15,
    physicalOpenCopyCount: 4,
  },
  allTimeActivity: {
    window: "all",
    onScreenMs: 120_000,
    activeUseMs: 42_000,
    coverageStart: null,
  },
  topicPaths: ["Video/Research"],
  rulesetVersion: 3,
  aliases: [
    {
      ruleKey: "youtube-www",
      version: 1,
      hostPattern: "youtube.com",
      matchKind: "suffix_host",
      pathPrefix: "/",
      priority: 100,
      enabled: true,
      provenance: "system_seed",
    },
  ],
});
const resourceList = resourceListResponseSchema.parse({
  items: [resource],
  total: 1,
  page: 2,
  pageSize: 25,
});
const resourcePages = resourcePagesResponseSchema.parse({
  items: [
    {
      logicalPageId: 42,
      urlNormalized: "https://www.youtube.com/watch?v=fixture",
      representativeUrl: "https://www.youtube.com/watch?v=fixture",
      browserPageCount: 2,
      physicalOpenCopyCount: 1,
      browsers: ["chrome", "edge"],
      topicPaths: ["Video/Research"],
      allTimeActivity: {
        window: "all",
        onScreenMs: 10_000,
        activeUseMs: 4_000,
        coverageStart: null,
      },
      currentAssignmentId: 9,
      assignmentReason: "explicit_alias",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
});
const allResourceActivity = resourceActivityResponseSchema.parse({
  resourceId: 7,
  activity: {
    window: "all",
    onScreenMs: 120_000,
    activeUseMs: 42_000,
    coverageStart: null,
    windowStart: null,
    windowEnd: timestamp,
  },
});
const sevenDayResourceActivity = resourceActivityResponseSchema.parse({
  resourceId: 7,
  activity: {
    window: "7d",
    onScreenMs: 70_000,
    activeUseMs: 21_000,
    coverageStart: "2026-08-01T00:00:00.000Z",
    windowStart: "2026-08-06T00:00:00.000Z",
    windowEnd: "2026-08-13T00:00:00.000Z",
  },
});
const thirtyDayResourceActivity = resourceActivityResponseSchema.parse({
  resourceId: 7,
  activity: {
    window: "30d",
    onScreenMs: 110_000,
    activeUseMs: 39_000,
    coverageStart: "2026-08-01T00:00:00.000Z",
    windowStart: "2026-07-14T00:00:00.000Z",
    windowEnd: "2026-08-13T00:00:00.000Z",
  },
});
const resourceContext = shareableContextBundleSchema.parse({
  subject: { type: "resource", resourceId: 7 },
  entries: [],
  currentEntries: [],
  preview: null,
});
const contextReceipt = agentContextMutationReceiptSchema.parse({
  kind: "appended",
  entry: {
    entryKind: "purpose",
    body: "Compare long-form educational channels",
    provenance: { actor: "agent", method: "on_behalf_of_user" },
    visibility: "share_with_ai",
    staleAt: null,
    state: "active",
    createdAt: timestamp,
    reviewVerdict: null,
  },
});
const evaluationReceipt = agentUserImportanceResponseSchema.parse({
  subject: { type: "resource", resourceId: 7 },
  value: 3,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TabHub resource REST adapter", () => {
  it("discovers resource activity only from well-formed explicit feature bits", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          context: false,
          logicalImportance: false,
          resources: true,
          activityWindows: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ context: false, logicalImportance: false }),
      )
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          context: false,
          logicalImportance: false,
          resources: true,
          activityWindows: "true",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockRejectedValueOnce(new TypeError("feature discovery connection failed"));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getFeatures()).resolves.toMatchObject({
      resources: true,
      activityWindows: true,
    });
    await expect(api.getFeatures()).resolves.not.toHaveProperty("resources");
    await expect(api.getFeatures()).resolves.not.toHaveProperty("resources");
    await expect(api.getFeatures()).rejects.toThrow(
      "TabHub API GET /api/features returned an invalid response",
    );
    await expect(api.getFeatures()).rejects.toThrow(
      "TabHub API GET /api/features returned HTTP 503: Unavailable",
    );
    await expect(api.getFeatures()).rejects.toThrow(
      "feature discovery connection failed",
    );
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      Array(6).fill("http://127.0.0.1:7717/api/features"),
    );
  });

  it("maps list/detail/pages/activity/shareable-context requests and validates responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(resourceList))
      .mockResolvedValueOnce(jsonResponse(resource))
      .mockResolvedValueOnce(jsonResponse(resourcePages))
      .mockResolvedValueOnce(jsonResponse(allResourceActivity))
      .mockResolvedValueOnce(jsonResponse(allResourceActivity))
      .mockResolvedValueOnce(jsonResponse(sevenDayResourceActivity))
      .mockResolvedValueOnce(jsonResponse(thirtyDayResourceActivity))
      .mockResolvedValueOnce(jsonResponse(resourceContext));
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.listResources({
        q: "video",
        kind: "platform",
        accessClass: "public",
        lifecycleState: "active",
        browser: "chrome",
        status: "inbox",
        importance: 2,
        tag: "Video/Research",
        page: 2,
        pageSize: 25,
        sortBy: "activity",
        sortDirection: "desc",
      }),
    ).resolves.toEqual(resourceList);
    await expect(api.getResource(7)).resolves.toEqual(resource);
    await expect(
      api.listResourcePages({
        resourceId: 7,
        browser: "edge",
        status: "done",
        importance: 1,
        tag: "Video/Research",
        page: 1,
        pageSize: 10,
      }),
    ).resolves.toEqual(resourcePages);
    await expect(api.getResourceActivity(7)).resolves.toEqual(
      allResourceActivity,
    );
    await expect(api.getResourceActivity(7, "all")).resolves.toEqual(
      allResourceActivity,
    );
    await expect(api.getResourceActivity(7, "7d")).resolves.toEqual(
      sevenDayResourceActivity,
    );
    await expect(api.getResourceActivity(7, "30d")).resolves.toEqual(
      thirtyDayResourceActivity,
    );
    await expect(api.getResourceContext(7)).resolves.toEqual(resourceContext);
    expect(allResourceActivity.activity).toMatchObject(resource.allTimeActivity);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:7717/api/resources?q=video&kind=platform&accessClass=public&lifecycleState=active&browser=chrome&status=inbox&importance=2&tag=Video%2FResearch&page=2&pageSize=25&sort_by=activity&sort_direction=desc",
      "http://127.0.0.1:7717/api/resources/7",
      "http://127.0.0.1:7717/api/resources/7/pages?page=1&pageSize=10&browser=edge&status=done&importance=1&tag=Video%2FResearch",
      "http://127.0.0.1:7717/api/resources/7/activity?window=all",
      "http://127.0.0.1:7717/api/resources/7/activity?window=all",
      "http://127.0.0.1:7717/api/resources/7/activity?window=7d",
      "http://127.0.0.1:7717/api/resources/7/activity?window=30d",
      "http://127.0.0.1:7717/api/agent/resources/7/context",
    ]);
  });

  it("rejects mismatched activity subjects and windows without inference", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ...sevenDayResourceActivity, resourceId: 8 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...sevenDayResourceActivity,
          activity: { ...sevenDayResourceActivity.activity, window: "30d" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...sevenDayResourceActivity,
          activity: {
            ...sevenDayResourceActivity.activity,
            onScreenMs: 1,
            activeUseMs: 2,
          },
        }),
      );
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getResourceActivity(7, "7d")).rejects.toThrow(
      "TabHub API GET /api/resources/7/activity?window=7d returned a mismatched response",
    );
    await expect(api.getResourceActivity(7, "7d")).rejects.toThrow(
      "TabHub API GET /api/resources/7/activity?window=7d returned a mismatched response",
    );
    await expect(api.getResourceActivity(7, "7d")).rejects.toThrow(
      "TabHub API GET /api/resources/7/activity?window=7d returned an invalid response",
    );
  });

  it("propagates resource-activity REST errors and rejects invalid windows before fetch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "Resource not found" }, 404));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getResourceActivity(999, "30d")).rejects.toThrow(
      "TabHub API GET /api/resources/999/activity?window=30d returned HTTP 404: Resource not found",
    );
    await expect(
      api.getResourceActivity(7, "invalid" as "7d"),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("writes only through trusted agent routes with strict provenance and replay payloads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(contextReceipt))
      .mockResolvedValueOnce(jsonResponse(contextReceipt))
      .mockResolvedValueOnce(jsonResponse(evaluationReceipt))
      .mockResolvedValueOnce(jsonResponse(evaluationReceipt));
    const api = createTabHubApi({ fetchImpl });
    const command = {
      kind: "append" as const,
      entryKind: "purpose" as const,
      body: "Compare long-form educational channels",
      provenance: { method: "on_behalf_of_user" as const },
      idempotencyKey: "explicit-context-7",
    };

    await expect(
      api.setResourceContext({ resourceId: 7, command }),
    ).resolves.toEqual(contextReceipt);
    await expect(
      api.setResourceContext({ resourceId: 7, command }),
    ).resolves.toEqual(contextReceipt);
    await expect(
      api.setResourceEvaluation({
        resourceId: 7,
        evaluation: 3,
        authorizationRef: "user-instruction:explicit-evaluation-7",
        idempotencyKey: "explicit-evaluation-7",
      }),
    ).resolves.toEqual(evaluationReceipt);
    await expect(
      api.setResourceEvaluation({
        resourceId: 7,
        evaluation: 3,
        authorizationRef: "user-instruction:explicit-evaluation-7",
        idempotencyKey: "explicit-evaluation-7",
      }),
    ).resolves.toEqual(evaluationReceipt);

    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    }))).toEqual([
      {
        url: "http://127.0.0.1:7717/api/agent/resources/7/context",
        method: "POST",
        body: command,
      },
      {
        url: "http://127.0.0.1:7717/api/agent/resources/7/context",
        method: "POST",
        body: command,
      },
      {
        url: "http://127.0.0.1:7717/api/agent/resources/7/user-evaluation",
        method: "PUT",
        body: {
          evaluation: 3,
          authorizationRef: "user-instruction:explicit-evaluation-7",
          idempotencyKey: "explicit-evaluation-7",
        },
      },
      {
        url: "http://127.0.0.1:7717/api/agent/resources/7/user-evaluation",
        method: "PUT",
        body: {
          evaluation: 3,
          authorizationRef: "user-instruction:explicit-evaluation-7",
          idempotencyKey: "explicit-evaluation-7",
        },
      },
    ]);
  });

  it("rejects invalid resource responses and normalizes not-found failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...resource, counts: { logicalPageCount: -1 } }))
      .mockResolvedValueOnce(jsonResponse({ error: "NOT_FOUND" }, 404));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getResource(7)).rejects.toThrow(
      "TabHub API GET /api/resources/7 returned an invalid response",
    );
    await expect(api.getResourceContext(999)).rejects.toThrow(
      "TabHub API GET /api/agent/resources/999/context returned HTTP 404",
    );
  });

  it("rejects invalid resource inputs before issuing a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.listResources({ page: 1, pageSize: 201 }),
    ).rejects.toThrow();
    await expect(api.getResource(0)).rejects.toThrow();
    await expect(
      api.setResourceEvaluation({
        resourceId: 7,
        evaluation: 3,
        authorizationRef: " ",
        idempotencyKey: " ",
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the compatibility evaluation route returns another subject", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      ...evaluationReceipt,
      subject: { type: "resource", resourceId: 8 },
    }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.setResourceEvaluation({
      resourceId: 7,
      evaluation: 3,
      authorizationRef: "user-instruction:explicit-evaluation-7",
      idempotencyKey: "explicit-evaluation-7",
    })).rejects.toThrow(
      "TabHub API PUT /api/agent/resources/7/user-evaluation returned a mismatched response",
    );
  });
});
