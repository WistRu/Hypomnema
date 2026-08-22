import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  agentContextMutationReceiptSchema,
  agentUserImportanceResponseSchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceListResponseSchema,
  shareableContextBundleSchema,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpServer,
  type McpServerOptions,
  type TabHubApi,
} from "../src/server.js";

const privateCanary = "LOCAL_ONLY_CANARY_MUST_NEVER_ESCAPE";
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
  aliases: [],
});
const resourceList = resourceListResponseSchema.parse({
  items: [resource],
  total: 1,
  page: 1,
  pageSize: 25,
});
const emptyShareableContext = shareableContextBundleSchema.parse({
  subject: { type: "resource", resourceId: 7 },
  entries: [],
  currentEntries: [],
  preview: null,
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
const allResourceActivity = resourceActivityResponseSchema.parse({
  resourceId: 7,
  activity: {
    window: "all",
    onScreenMs: 120_000,
    activeUseMs: 42_000,
    coverageStart: "2026-08-01T00:00:00.000Z",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: timestamp,
  },
});
const appendedEntry = {
  entryKind: "purpose" as const,
  body: "Compare long-form educational channels",
  provenance: { actor: "agent" as const, method: "on_behalf_of_user" as const },
  visibility: "share_with_ai" as const,
  staleAt: null,
  state: "active" as const,
  createdAt: timestamp,
  reviewVerdict: null,
};
const contextReceipt = agentContextMutationReceiptSchema.parse({
  kind: "appended",
  entry: appendedEntry,
});
const evaluationReceipt = agentUserImportanceResponseSchema.parse({
  subject: { type: "resource", resourceId: 7 },
  value: 3,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

function createApi(overrides: Partial<TabHubApi> = {}): TabHubApi {
  return new Proxy(overrides as TabHubApi, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (property === "then") return undefined;
      return async () => {
        throw new Error(`Unexpected API call: ${String(property)}`);
      };
    },
  });
}

async function connectClient(api: TabHubApi, options?: McpServerOptions) {
  const server = createMcpServer(api, options);
  const client = new Client({ name: "resource-test", version: "0.1.0" });
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
  if (block?.type !== "text") throw new Error("Expected a text result");
  return block.text;
}

const resourceOptions: McpServerOptions = {
  features: { context: false, logicalImportance: false, resources: true },
};
const resourceActivityOptions: McpServerOptions = {
  features: {
    context: false,
    logicalImportance: false,
    resources: true,
    activityWindows: true,
  },
};

describe("TabHub MCP resource surface", () => {
  it("fails closed unless resources is exactly true", async () => {
    const missing = await connectClient(createApi(), {
      features: { context: false, logicalImportance: false },
    });
    const disabled = await connectClient(createApi(), {
      features: { context: false, logicalImportance: false, resources: false },
    });
    const enabled = await connectClient(createApi(), resourceOptions);
    try {
      for (const connection of [missing, disabled]) {
        expect(
          (await connection.client.listTools()).tools.some(({ name }) =>
            name.includes("resource"),
          ),
        ).toBe(false);
        expect(
          (await connection.client.listResourceTemplates()).resourceTemplates.some(
            ({ uriTemplate }) => uriTemplate === "tabhub://resource/{id}",
          ),
        ).toBe(false);
      }
      expect(
        (await enabled.client.listTools()).tools
          .map(({ name }) => name)
          .filter((name) => name.includes("resource"))
          .sort(),
      ).toEqual([
        "get_resource",
        "get_resource_context",
        "list_resources",
        "set_resource_context",
        "set_resource_evaluation",
      ]);
      expect(
        (await enabled.client.listResourceTemplates()).resourceTemplates.some(
          ({ uriTemplate }) => uriTemplate === "tabhub://resource/{id}",
        ),
      ).toBe(true);
    } finally {
      await missing.close();
      await disabled.close();
      await enabled.close();
    }
  });

  it("exposes window activity only behind both exact capability bits", async () => {
    const getResourceActivity = vi.fn(async () => sevenDayResourceActivity);
    const api = createApi({ getResourceActivity });
    const variants = [
      undefined,
      { context: false, logicalImportance: false },
      { context: false, logicalImportance: false, resources: false },
      { context: false, logicalImportance: false, resources: true },
      {
        context: false,
        logicalImportance: false,
        resources: true,
        activityWindows: false,
      },
      {
        context: false,
        logicalImportance: false,
        resources: true,
        activityWindows: "true",
      },
    ] as const;
    const disabled = await Promise.all(
      variants.map((features) =>
        features === undefined
          ? connectClient(api)
          : connectClient(api, {
              features: features as NonNullable<McpServerOptions["features"]>,
            }),
      ),
    );
    const enabled = await connectClient(api, resourceActivityOptions);
    try {
      for (const connection of disabled) {
        expect(
          (await connection.client.listTools()).tools.some(
            ({ name }) => name === "get_resource_activity",
          ),
        ).toBe(false);
        await expect(
          connection.client.callTool({
            name: "get_resource_activity",
            arguments: { resource_id: 7, window: "7d" },
          }),
        ).rejects.toThrow();
      }
      expect(
        (await enabled.client.listTools()).tools.some(
          ({ name }) => name === "get_resource_activity",
        ),
      ).toBe(true);
      expect(getResourceActivity).not.toHaveBeenCalled();
    } finally {
      await Promise.all(disabled.map(({ close }) => close()));
      await enabled.close();
    }
  });

  it("returns exact REST activity as read-only structured content with all default", async () => {
    const getResourceActivity = vi
      .fn()
      .mockResolvedValueOnce(allResourceActivity)
      .mockResolvedValueOnce(sevenDayResourceActivity);
    const connection = await connectClient(
      createApi({ getResourceActivity }),
      resourceActivityOptions,
    );
    try {
      const listed = (await connection.client.listTools()).tools.find(
        ({ name }) => name === "get_resource_activity",
      );
      expect(listed).toMatchObject({
        annotations: { readOnlyHint: true, openWorldHint: false },
      });
      expect(listed?.outputSchema).toBeDefined();

      const all = await connection.client.callTool({
        name: "get_resource_activity",
        arguments: { resource_id: 7 },
      });
      const sevenDay = await connection.client.callTool({
        name: "get_resource_activity",
        arguments: { resource_id: 7, window: "7d" },
      });

      expect(getResourceActivity).toHaveBeenNthCalledWith(1, 7, "all");
      expect(getResourceActivity).toHaveBeenNthCalledWith(2, 7, "7d");
      expect(JSON.parse(textResult(all))).toEqual(allResourceActivity);
      expect(all.structuredContent).toEqual(allResourceActivity);
      expect(JSON.parse(textResult(sevenDay))).toEqual(sevenDayResourceActivity);
      expect(sevenDay.structuredContent).toEqual(sevenDayResourceActivity);
      expect(JSON.stringify(sevenDay)).not.toContain("local_only");
      const invalid = await connection.client.callTool({
        name: "get_resource_activity",
        arguments: { resource_id: 7, window: "year" },
      });
      expect(invalid.isError).toBe(true);
      expect(textResult(invalid)).toContain(
        "Input validation error: Invalid arguments for tool get_resource_activity",
      );
      expect(getResourceActivity).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("keeps activity adapter errors stable and makes no write calls", async () => {
    const getResourceActivity = vi.fn(async () => {
      throw new Error(
        "TabHub API GET /api/resources/999/activity?window=30d returned HTTP 404: Resource not found",
      );
    });
    const setResourceContext = vi.fn();
    const setResourceEvaluation = vi.fn();
    const connection = await connectClient(
      createApi({
        getResourceActivity,
        setResourceContext,
        setResourceEvaluation,
      }),
      resourceActivityOptions,
    );
    try {
      const result = await connection.client.callTool({
        name: "get_resource_activity",
        arguments: { resource_id: 999, window: "30d" },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result)).toBe(
        "TabHub API GET /api/resources/999/activity?window=30d returned HTTP 404: Resource not found",
      );
      expect(getResourceActivity).toHaveBeenCalledWith(999, "30d");
      expect(setResourceContext).not.toHaveBeenCalled();
      expect(setResourceEvaluation).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("maps typed list/get/context tools and exposes honest all-time totals", async () => {
    const listResources = vi.fn(async () => resourceList);
    const getResource = vi.fn(async () => resource);
    const getResourceContext = vi.fn(async () => emptyShareableContext);
    const connection = await connectClient(
      createApi({ listResources, getResource, getResourceContext }),
      resourceOptions,
    );
    try {
      const list = await connection.client.callTool({
        name: "list_resources",
        arguments: {
          q: "video",
          kind: "platform",
          access_class: "public",
          browser: "chrome",
          status: "inbox",
          importance: 2,
          tag: "Video/Research",
          page: 1,
          page_size: 25,
          sort_by: "activity",
          sort_direction: "desc",
        },
      });
      const detail = await connection.client.callTool({
        name: "get_resource",
        arguments: { resource_id: 7 },
      });
      const context = await connection.client.callTool({
        name: "get_resource_context",
        arguments: { resource_id: 7 },
      });

      expect(listResources).toHaveBeenCalledWith({
        q: "video",
        kind: "platform",
        accessClass: "public",
        lifecycleState: "active",
        browser: "chrome",
        status: "inbox",
        importance: 2,
        tag: "Video/Research",
        page: 1,
        pageSize: 25,
        sortBy: "activity",
        sortDirection: "desc",
      });
      expect(JSON.parse(textResult(list))).toMatchObject(resourceList);
      expect(JSON.parse(textResult(detail))).toMatchObject(resource);
      expect(JSON.parse(textResult(context))).toMatchObject(emptyShareableContext);
      expect(JSON.parse(textResult(detail)).allTimeActivity).toEqual({
        window: "all",
        onScreenMs: 120_000,
        activeUseMs: 42_000,
        coverageStart: null,
      });
    } finally {
      await connection.close();
    }
  });

  it("writes context provenance/idempotency and evaluation only through on-behalf interfaces", async () => {
    const setResourceContext = vi.fn(async () => contextReceipt);
    const setResourceEvaluation = vi.fn(async () => evaluationReceipt);
    const connection = await connectClient(
      createApi({ setResourceContext, setResourceEvaluation }),
      resourceOptions,
    );
    try {
      const first = await connection.client.callTool({
        name: "set_resource_context",
        arguments: {
          resource_id: 7,
          entry_kind: "purpose",
          body: "Compare long-form educational channels",
          idempotency_key: "explicit-context-7",
        },
      });
      const replay = await connection.client.callTool({
        name: "set_resource_context",
        arguments: {
          resource_id: 7,
          entry_kind: "purpose",
          body: "Compare long-form educational channels",
          idempotency_key: "explicit-context-7",
        },
      });
      const evaluation = await connection.client.callTool({
        name: "set_resource_evaluation",
        arguments: {
          resource_id: 7,
          evaluation: 3,
          idempotency_key: "explicit-evaluation-7",
          authorization_ref: "user-instruction:explicit-evaluation-7",
        },
      });
      const spoofed = await connection.client.callTool({
        name: "set_resource_evaluation",
        arguments: {
          resource_id: 7,
          evaluation: 3,
          idempotency_key: "spoofed",
          provenance: { actor: "user", method: "manual" },
        },
      });

      expect(setResourceContext).toHaveBeenNthCalledWith(1, {
        resourceId: 7,
        command: {
          kind: "append",
          entryKind: "purpose",
          body: "Compare long-form educational channels",
          provenance: { method: "on_behalf_of_user" },
          idempotencyKey: "explicit-context-7",
        },
      });
      expect(textResult(first)).toBe(textResult(replay));
      expect(setResourceEvaluation).toHaveBeenCalledTimes(1);
      expect(setResourceEvaluation).toHaveBeenCalledWith({
          resourceId: 7,
          evaluation: 3,
          authorizationRef: "user-instruction:explicit-evaluation-7",
          idempotencyKey: "explicit-evaluation-7",
      });
      expect(JSON.parse(textResult(evaluation)).provenance).toEqual({
        actor: "agent",
        method: "on_behalf_of_user",
      });
      expect(spoofed.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("keeps hidden and absent local-only context byte-identical in tools and URI resources", async () => {
    const getResource = vi.fn(async () => resource);
    const getResourceContext = vi.fn(async () => emptyShareableContext);
    const hidden = await connectClient(
      createApi({ getResource, getResourceContext }),
      resourceOptions,
    );
    const absent = await connectClient(
      createApi({ getResource, getResourceContext }),
      resourceOptions,
    );
    try {
      const hiddenTool = await hidden.client.callTool({
        name: "get_resource_context",
        arguments: { resource_id: 7 },
      });
      const absentTool = await absent.client.callTool({
        name: "get_resource_context",
        arguments: { resource_id: 7 },
      });
      const hiddenUri = await hidden.client.readResource({
        uri: "tabhub://resource/7",
      });
      const absentUri = await absent.client.readResource({
        uri: "tabhub://resource/7",
      });
      const transcript = JSON.stringify({ hiddenTool, absentTool, hiddenUri, absentUri });

      expect(textResult(hiddenTool)).toBe(textResult(absentTool));
      expect(hiddenUri).toEqual(absentUri);
      expect(transcript).not.toContain(privateCanary);
      for (const privateShape of ["hiddenCount", "privateCount", "entryId", "revision"]) {
        expect(textResult(hiddenTool)).not.toContain(privateShape);
        expect(JSON.stringify(hiddenUri)).not.toContain(privateShape);
      }
    } finally {
      await hidden.close();
      await absent.close();
    }
  });

  it("bounds aliases, topic paths, shareable history, and entry bodies with public-only metadata", async () => {
    const manyAliases = Array.from({ length: 10_000 }, (_, index) => ({
      ruleKey: `rule-${index}`,
      version: 1,
      hostPattern: `alias-${index}.example.com`,
      matchKind: "exact_host" as const,
      pathPrefix: "/",
      priority: index,
      enabled: true,
      provenance: "user_alias" as const,
    }));
    const largeResource = resourceDetailSchema.parse({
      ...resource,
      topicPaths: Array.from({ length: 200 }, (_, index) => `Topic/${index}`),
      aliases: manyAliases,
    });
    const largeBody = "x".repeat(99_990);
    const largeContext = shareableContextBundleSchema.parse({
      subject: { type: "resource", resourceId: 7 },
      entries: Array.from({ length: 100 }, (_, index) => ({
        ...appendedEntry,
        body: `${String(index).padStart(3, "0")}:${largeBody}`,
      })),
      currentEntries: Array.from({ length: 25 }, (_, index) => ({
        ...appendedEntry,
        entryKind: index % 2 === 0 ? "purpose" : "note",
        body: `${String(index).padStart(3, "0")}:${largeBody}`,
      })),
      preview: {
        entryKind: "purpose",
        body: largeBody,
        actor: "agent",
      },
    });
    const connection = await connectClient(
      createApi({
        getResource: async () => largeResource,
        getResourceContext: async () => largeContext,
      }),
      resourceOptions,
    );
    try {
      const detail = await connection.client.callTool({
        name: "get_resource",
        arguments: { resource_id: 7 },
      });
      const detailJson = JSON.parse(textResult(detail)) as {
        aliases: unknown[];
        topicPaths: unknown[];
        projection: Record<string, unknown>;
      };
      const context = await connection.client.callTool({
        name: "get_resource_context",
        arguments: { resource_id: 7 },
      });
      const contextText = textResult(context);
      const contextJson = JSON.parse(contextText) as {
        entries: Array<{ body: string; bodyTruncated: boolean }>;
        currentEntries: Array<{ body: string; bodyTruncated: boolean }>;
        projection: Record<string, unknown>;
      };
      const uri = await connection.client.readResource({
        uri: "tabhub://resource/7",
      });
      const uriContent = uri.contents[0];
      if (uriContent === undefined || !("text" in uriContent)) {
        throw new Error("Expected bounded resource text");
      }

      expect(detailJson.aliases).toHaveLength(50);
      expect(detailJson.topicPaths).toHaveLength(50);
      expect(detailJson.projection).toMatchObject({
        aliases: { shareableTotal: 10_000, returned: 50, truncated: true },
        topicPaths: { shareableTotal: 200, returned: 50, truncated: true },
      });
      expect(contextJson.entries).toHaveLength(20);
      expect(contextJson.currentEntries).toHaveLength(20);
      expect(contextJson.entries[0]!.body).toHaveLength(4_000);
      expect(contextJson.entries[0]!.bodyTruncated).toBe(true);
      expect(contextJson.projection).toMatchObject({
        visibility: "share_with_ai",
        history: { shareableTotal: 100, returned: 20, omittedOlder: 80 },
        current: { shareableTotal: 25, returned: 20, truncated: true },
        bodyCharacterLimit: 4_000,
      });
      expect(contextText.length).toBeLessThan(200_000);
      expect(uriContent.text.length).toBeLessThan(250_000);
      expect(contextText).not.toContain("hiddenCount");
      expect(uriContent.text).not.toContain("hiddenCount");
    } finally {
      await connection.close();
    }
  });

  it("normalizes malformed resource URIs and not-found errors without private text", async () => {
    const getResource = vi.fn(async () => {
      throw new Error("TabHub API GET /api/resources/999 returned HTTP 404");
    });
    const getResourceContext = vi.fn(async () => emptyShareableContext);
    const connection = await connectClient(
      createApi({ getResource, getResourceContext }),
      resourceOptions,
    );
    try {
      await expect(
        connection.client.readResource({ uri: "tabhub://resource/not-a-number" }),
      ).rejects.toThrow("Invalid TabHub resource ID");
      await expect(
        connection.client.readResource({ uri: "tabhub://resource/999" }),
      ).rejects.toThrow("TabHub API GET /api/resources/999 returned HTTP 404");
    } finally {
      await connection.close();
    }
  });
});
