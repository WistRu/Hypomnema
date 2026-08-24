import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tabCommandRelayProtocolVersion } from "@tabhub/shared";

const extensionBrowser = vi.hoisted(() => {
  const localValues: Record<string, unknown> = {
    "tabhub.browser": "chrome",
    "tabhub.browserConfiguredVersion": 1,
    "tabhub.installationId": "123e4567-e89b-42d3-a456-426614174000",
  };
  const sessionValues: Record<string, unknown> = {
    "tabhub.browserSessionId": "223e4567-e89b-42d3-a456-426614174000",
  };
  const read = (
    values: Record<string, unknown>,
    keys: string | readonly string[],
  ) => {
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requestedKeys.flatMap((key) =>
        Object.hasOwn(values, key) ? [[key, values[key]]] : [],
      ),
    );
  };

  return {
    __deleteLocal: (key: string) => {
      delete localValues[key];
    },
    __setLocal: (key: string, value: unknown) => {
      localValues[key] = value;
    },
    runtime: { id: "abcdefghijklmnop" },
    storage: {
      local: {
        get: vi.fn(async (keys: string | readonly string[]) =>
          read(localValues, keys),
        ),
        remove: vi.fn(async (key: string) => {
          delete localValues[key];
        }),
        setAccessLevel: vi.fn(async () => undefined),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localValues, items);
        }),
      },
      session: {
        get: vi.fn(async (keys: string | readonly string[]) =>
          read(sessionValues, keys),
        ),
        remove: vi.fn(async (key: string) => {
          delete sessionValues[key];
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionValues, items);
        }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (tabId === 12) {
          return {
            id: 12,
            index: 1,
            url: "http://localhost:7717/app/?view=open",
            windowId: 9,
          };
        }
        if (tabId === 13) {
          return {
            active: true,
            id: 13,
            index: 2,
            url: "https://example.com/article",
            windowId: 9,
          };
        }
        throw new Error("Missing tab");
      }),
      query: vi.fn(async (query: { active?: boolean } = {}) =>
        query.active
          ? [
              {
                active: true,
                id: 13,
                index: 2,
                url: "https://example.com/article",
                windowId: 9,
              },
            ]
          : [
              {
                id: 11,
                index: 0,
                url: "http://127.0.0.1:7717/app/",
                windowId: 9,
              },
              {
                id: 12,
                index: 1,
                pendingUrl: "http://localhost:7717/app/?view=open",
                windowId: 9,
              },
              {
                active: true,
                id: 13,
                index: 2,
                url: "https://example.com/article",
                windowId: 9,
              },
            ],
      ),
    },
    windows: {
      getAll: vi.fn(async () => [
        {
          focused: true,
          id: 9,
          tabs: [{ id: 11 }, { id: 12 }, { id: 13 }],
          type: "normal",
        },
      ]),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    i18n: { getMessage: (key: string) => key },
  };
});

vi.mock("wxt/browser", () => ({ browser: extensionBrowser }));
vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (setup: unknown) => setup,
}));

import {
  currentContextPopupData,
  flushContextMutations,
  handleMessage,
  refreshPendingContextMutationSnapshot,
  serializeContextMutation,
  serializeSync,
  snapshotAndExactActiveTab,
} from "../entrypoints/background";
import { createPendingContextMutation } from "./context-intent";

const CURRENT_SCOPE = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};
const CURRENT_EXACT_SCOPE = {
  browserSessionId: CURRENT_SCOPE.browserSessionId,
  browserTabId: 13,
  installationId: CURRENT_SCOPE.installationId,
};
const CURRENT_EXPECTED_PAGE = {
  instanceRevision: 1,
  logicalPageId: 17,
  url: "https://example.com/article",
  urlNormalized: "https://example.com/article",
};

describe("background app tab command messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionBrowser.__deleteLocal("tabhub.contextFeatures");
    extensionBrowser.__deleteLocal("tabhub.localCapability");
    extensionBrowser.__deleteLocal("tabhub.pendingContextMutations");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the current physical-command protocol in a direct probe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    await expect(
      handleMessage(
        { type: "tabhub:app-probe" },
        {
          tab: {
            id: 11,
            url: "http://127.0.0.1:7717/app/",
            windowId: 9,
          },
        },
      ),
    ).resolves.toMatchObject({
      data: {
        available: true,
        commandProtocolVersion: tabCommandRelayProtocolVersion,
        extensionOrigin: "chrome-extension://abcdefghijklmnop",
      },
      ok: true,
      type: "probe",
    });
  });

  it("queries and protects every TabHub app tab during a direct close preview", async () => {
    const response = await handleMessage(
      {
        ...CURRENT_SCOPE,
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "http://localhost:7717/app/?view=open",
              tabId: 12,
            },
            { expectedUrl: "https://example.com/article", tabId: 13 },
          ],
        },
        type: "tabhub:app-tab-command",
      },
      {
        tab: {
          id: 11,
          url: "http://127.0.0.1:7717/app/",
          windowId: 9,
        },
      },
    );

    expect(extensionBrowser.tabs.query).toHaveBeenCalledOnce();
    expect(extensionBrowser.tabs.query).toHaveBeenCalledWith({});
    expect(response).toMatchObject({
      data: {
        result: {
          candidateTabIds: [13],
          kind: "close-preview",
          skipped: [{ reason: "control-tab-protected", tabId: 12 }],
        },
      },
      ok: true,
      type: "tab-command",
    });
  });

  it("re-reads the current-window active tab after snapshot collection", async () => {
    await expect(snapshotAndExactActiveTab()).resolves.toMatchObject({
      active: { id: 13, expectedUrl: "https://example.com/article" },
      snapshot: {
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabId: 13,
            url: "https://example.com/article",
          }),
        ]),
      },
    });
    expect(extensionBrowser.tabs.query).toHaveBeenNthCalledWith(1, {
      active: true,
      currentWindow: true,
    });
    expect(extensionBrowser.tabs.query).toHaveBeenNthCalledWith(2, {});
    expect(extensionBrowser.tabs.get).toHaveBeenCalledWith(13);
    expect(extensionBrowser.tabs.query).toHaveBeenNthCalledWith(3, {
      active: true,
      currentWindow: true,
    });
  });

  it("uses one global transport order for general and context mutations", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const general = serializeSync(async () => {
      events.push("general-start");
      await gate;
      events.push("general-end");
    });
    const context = serializeContextMutation(async () => {
      events.push("context");
    });
    await vi.waitFor(() => expect(events).toEqual(["general-start"]));
    release();
    await Promise.all([general, context]);
    expect(events).toEqual(["general-start", "general-end", "context"]);
  });

  it("refreshes a queued A snapshot to live B without changing expectedUrl A", async () => {
    const queued = createPendingContextMutation(
      {
        command: {
          body: "Still about A",
          expectedUrl: "https://example.com/a",
          idempotencyKey: "stable-a",
          kind: "set",
          scope: {
            browserSessionId: CURRENT_SCOPE.browserSessionId,
            browserTabId: 13,
            installationId: CURRENT_SCOPE.installationId,
          },
          visibility: "local_only",
        },
        kind: "session-intent",
        snapshot: {
          ...CURRENT_SCOPE,
          tabs: [
            {
              active: true,
              index: 2,
              tabId: 13,
              url: "https://example.com/a",
              windowId: 9,
            },
          ],
        },
      },
      "323e4567-e89b-42d3-a456-426614174001",
      "2026-08-12T10:00:00.000Z",
    );
    const refreshed = await refreshPendingContextMutationSnapshot(queued);
    expect(refreshed.command).toMatchObject({
      expectedUrl: "https://example.com/a",
      idempotencyKey: "stable-a",
    });
    expect(refreshed.snapshot.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabId: 13,
          url: "https://example.com/article",
        }),
      ]),
    );
    expect(refreshed.snapshot.tabs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://example.com/a" }),
      ]),
    );
  });

  it("rejects a save target when focus changes to another window", async () => {
    extensionBrowser.tabs.query
      .mockResolvedValueOnce([
        {
          active: true,
          id: 13,
          index: 2,
          url: "https://example.com/article",
          windowId: 9,
        },
      ])
      .mockResolvedValueOnce([
        {
          active: true,
          id: 13,
          index: 2,
          url: "https://example.com/article",
          windowId: 9,
        },
      ])
      .mockResolvedValueOnce([
        {
          active: true,
          id: 14,
          index: 0,
          url: "https://example.net/new-window",
          windowId: 10,
        },
      ]);

    await expect(snapshotAndExactActiveTab()).rejects.toThrow(
      "The current tab cannot store personal context.",
    );
  });

  it("rejects unsupported non-HTTP active pages", async () => {
    const unsupported = {
      active: true,
      id: 13,
      index: 2,
      url: "chrome://extensions/",
      windowId: 9,
    };
    extensionBrowser.tabs.query
      .mockResolvedValueOnce([unsupported])
      .mockResolvedValueOnce([unsupported])
      .mockResolvedValueOnce([unsupported]);
    extensionBrowser.tabs.get.mockResolvedValueOnce(unsupported);

    await expect(snapshotAndExactActiveTab()).rejects.toThrow(
      "The current tab cannot store personal context.",
    );
  });

  it("returns to pairing state after a stored credential is revoked", async () => {
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/features")) {
          return Response.json({ context: true, logicalImportance: false });
        }
        if (url.endsWith("/api/ingest/snapshot")) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 401 });
      }),
    );

    await expect(currentContextPopupData()).resolves.toMatchObject({
      contextEnabled: true,
      pairingRequired: true,
    });
    expect(extensionBrowser.storage.local.remove).toHaveBeenCalledWith(
      "tabhub.localCapability",
    );
  });

  it("does not expose the context form target for unsupported active pages", async () => {
    extensionBrowser.tabs.query.mockResolvedValueOnce([
      {
        active: true,
        id: 13,
        index: 0,
        url: "chrome://extensions/",
        windowId: 9,
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ context: true, logicalImportance: false }),
      ),
    );

    await expect(currentContextPopupData()).resolves.toMatchObject({
      activeTab: null,
      contextEnabled: true,
    });
  });

  it("durably queues an unchanged idempotent context save while offline", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const response = await handleMessage(
      {
        body: "Compare this later",
        entryKind: "question",
        expectedUrl: "https://example.com/article",
        idempotencyKey: "stable-offline-key",
        scope: "this_tab",
        targetScope: CURRENT_EXACT_SCOPE,
        type: "tabhub:context-save",
        visibility: "local_only",
      },
      {},
    );

    expect(response).toMatchObject({
      context: { pendingMutationCount: 1 },
      ok: true,
    });
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          idempotencyKey: "stable-offline-key",
        }),
        lastError: "Retry required",
      }),
    ]);
  });

  it("keeps feature-off context disabled with zero enqueue, POST, or durable queue change", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: false,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    const existing = createPendingContextMutation(
      {
        command: {
          body: "Existing queued context",
          expectedUrl: "https://example.com/article",
          idempotencyKey: "existing-key",
          kind: "set",
          scope: CURRENT_EXACT_SCOPE,
          visibility: "local_only",
        },
        kind: "session-intent",
        snapshot: {
          ...CURRENT_SCOPE,
          tabs: [],
        },
      },
      "323e4567-e89b-42d3-a456-426614174002",
      "2026-08-12T10:00:00.000Z",
    );
    extensionBrowser.__setLocal("tabhub.pendingContextMutations", [existing]);
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/features")) {
          return Response.json({ context: false, logicalImportance: false });
        }
        if (url.endsWith("/api/health")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const response = await handleMessage(
      {
        body: "Must stay disabled",
        entryKind: "note",
        expectedUrl: "https://example.com/article",
        idempotencyKey: "must-not-enqueue",
        scope: "page",
        targetScope: CURRENT_EXACT_SCOPE,
        type: "tabhub:context-save",
        visibility: "local_only",
      },
      {},
    );

    expect(response).toMatchObject({ ok: false });
    expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toEqual([existing]);
  });

  it.each(["page", "this_tab"] as const)(
    "rejects a rendered page-A %s save after the exact tab navigates to B",
    async (saveScope) => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/features")) {
          return Response.json({ context: true, logicalImportance: false });
        }
        if (url.endsWith("/api/ingest/snapshot")) {
          return Response.json({ inserted: 0, updated: 1, closed: 0 });
        }
        if (url.includes("/api/local/session-intents?")) {
          return Response.json({ current: null, history: [], scope: CURRENT_EXACT_SCOPE });
        }
        if (url.endsWith("/api/health")) return new Response(null, { status: 200 });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const rendered = await currentContextPopupData();
    expect(rendered.mutationTarget).toEqual({
      expectedUrl: "https://example.com/article",
      scope: CURRENT_EXACT_SCOPE,
    });
    const postCountAfterRender = requests.filter(({ method }) => method === "POST").length;
    const pageB = {
      active: true,
      id: 13,
      index: 2,
      title: "Page B",
      url: "https://example.com/b",
      windowId: 9,
    };
    extensionBrowser.tabs.query
      .mockResolvedValueOnce([pageB])
      .mockResolvedValueOnce([pageB])
      .mockResolvedValueOnce([pageB]);
    extensionBrowser.tabs.get.mockResolvedValueOnce(pageB);

    const response = await handleMessage(
      {
        body: "Still about page A",
        entryKind: "note",
        expectedUrl: rendered.mutationTarget!.expectedUrl,
        idempotencyKey: "render-a-save",
        scope: saveScope,
        targetScope: rendered.mutationTarget!.scope,
        type: "tabhub:context-save",
        visibility: "local_only",
      },
      {},
    );

    expect(response).toMatchObject({ ok: false });
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(
      postCountAfterRender,
    );
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toBeUndefined();
    },
  );

  it("rejects a rendered page-A archive after the exact tab navigates to B", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    const renderedIntent = {
      archivedAt: null,
      body: "Intent for rendered page A",
      createdAt: "2026-08-12T10:00:00.000Z",
      expectedPage: CURRENT_EXPECTED_PAGE,
      expiresAt: null,
      id: 7,
      idempotencyKey: "intent-a",
      promotedContextEntryId: null,
      provenance: { actor: "user", method: "manual" },
      scope: CURRENT_EXACT_SCOPE,
      staleAt: null,
      state: "active",
      subject: { logicalPageId: 17, type: "page" },
      updatedAt: "2026-08-12T10:00:00.000Z",
      visibility: "local_only",
    } as const;
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/features")) {
          return Response.json({ context: true, logicalImportance: false });
        }
        if (url.endsWith("/api/ingest/snapshot")) {
          return Response.json({ inserted: 0, updated: 1, closed: 0 });
        }
        if (url.includes("/api/local/session-intents?")) {
          return Response.json({
            current: renderedIntent,
            history: [],
            scope: CURRENT_EXACT_SCOPE,
          });
        }
        if (url.endsWith("/api/health")) return new Response(null, { status: 200 });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const rendered = await currentContextPopupData();
    expect(rendered.sessionIntent?.current).toMatchObject({ id: 7 });
    const postCountAfterRender = requests.filter(({ method }) => method === "POST").length;
    const pageB = {
      active: true,
      id: 13,
      index: 2,
      title: "Page B",
      url: "https://example.com/b",
      windowId: 9,
    };
    extensionBrowser.tabs.query
      .mockResolvedValueOnce([pageB])
      .mockResolvedValueOnce([pageB])
      .mockResolvedValueOnce([pageB]);
    extensionBrowser.tabs.get.mockResolvedValueOnce(pageB);

    const response = await handleMessage(
      {
        contextKind: "note",
        expectedPage: renderedIntent.expectedPage,
        idempotencyKey: "render-a-archive",
        intentId: renderedIntent.id,
        kind: "archive",
        scope: renderedIntent.scope,
        type: "tabhub:context-intent-action",
      },
      {},
    );

    expect(response).toMatchObject({ ok: false });
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(
      postCountAfterRender,
    );
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toBeUndefined();
  });

  it("does not show or promote intent A after the exact tab navigates to B", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    const pageB = {
      active: true,
      id: 13,
      index: 2,
      title: "Page B",
      url: "https://example.com/b",
      windowId: 9,
    };
    extensionBrowser.tabs.query.mockImplementation(
      async (query: { active?: boolean } = {}) =>
        query.active ? [pageB] : [pageB],
    );
    extensionBrowser.tabs.get.mockResolvedValue(pageB);
    const scope = {
      browserSessionId: CURRENT_SCOPE.browserSessionId,
      browserTabId: 13,
      installationId: CURRENT_SCOPE.installationId,
    };
    const staleIntent = {
      archivedAt: null,
      body: "Intent for A",
      createdAt: "2026-08-12T10:00:00.000Z",
      expectedPage: {
        instanceRevision: 1,
        logicalPageId: 17,
        url: "https://example.com/a",
        urlNormalized: "https://example.com/a",
      },
      expiresAt: null,
      id: 7,
      idempotencyKey: "intent-a",
      promotedContextEntryId: null,
      provenance: { actor: "user", method: "manual" },
      scope,
      staleAt: null,
      state: "active",
      subject: { logicalPageId: 17, type: "page" },
      updatedAt: "2026-08-12T10:00:00.000Z",
      visibility: "local_only",
    } as const;
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (url.endsWith("/api/ingest/snapshot")) {
          return Response.json({ inserted: 0, updated: 1, closed: 0 });
        }
        if (url.includes("/api/local/session-intents?")) {
          return Response.json({ current: null, history: [], scope });
        }
        if (url.endsWith("/api/health")) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 500 });
      }),
    );

    const popup = await currentContextPopupData();
    expect(popup).toMatchObject({
      activeTab: { id: 13, title: "Page B", url: "https://example.com/b" },
      sessionIntent: { current: null },
    });
    expect(JSON.stringify(popup)).not.toContain("Intent for A");
    const response = await handleMessage(
      {
        contextKind: "question",
        expectedPage: staleIntent.expectedPage,
        idempotencyKey: "promote-a",
        intentId: staleIntent.id,
        kind: "promote",
        scope,
        type: "tabhub:context-intent-action",
      },
      {},
    );

    expect(response).toMatchObject({ ok: false });
    expect(requests).not.toContainEqual({
      method: "POST",
      url: expect.stringContaining("/api/local/session-intents/commands"),
    });
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toBeUndefined();
  });

  it.each(["archive", "promote"] as const)(
    "keeps a queued %s for page A blocked after navigation to B",
    async (kind) => {
      extensionBrowser.__setLocal("tabhub.contextFeatures", {
        context: true,
        logicalImportance: false,
        observedAt: "2026-08-12T10:00:00.000Z",
      });
      extensionBrowser.__setLocal("tabhub.localCapability", {
        credential: "x".repeat(40),
        credentialVersion: 1,
        installationId: CURRENT_SCOPE.installationId,
      });
      const pageA = {
        active: true,
        id: 13,
        index: 2,
        title: "Page A",
        url: CURRENT_EXPECTED_PAGE.url,
        windowId: 9,
      };
      extensionBrowser.tabs.query.mockImplementation(async () => [pageA]);
      extensionBrowser.tabs.get.mockResolvedValue(pageA);
      const intent = {
        archivedAt: null,
        body: "Lifecycle action for page A",
        createdAt: "2026-08-12T10:00:00.000Z",
        expectedPage: CURRENT_EXPECTED_PAGE,
        expiresAt: null,
        id: 27,
        idempotencyKey: "intent-before-navigation",
        promotedContextEntryId: null,
        provenance: { actor: "user", method: "manual" },
        scope: CURRENT_EXACT_SCOPE,
        staleAt: null,
        state: "active",
        subject: { logicalPageId: 17, type: "page" },
        updatedAt: "2026-08-12T10:00:00.000Z",
        visibility: "local_only",
      } as const;
      let serverPageUrl = CURRENT_EXPECTED_PAGE.url;
      let commandAttempts = 0;
      let lifecycleEffects = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/features")) {
            return Response.json({ context: true, logicalImportance: false });
          }
          if (url.endsWith("/api/ingest/snapshot")) {
            const snapshot = JSON.parse(String(init?.body)) as {
              tabs: Array<{ tabId?: number; url: string }>;
            };
            const exact = snapshot.tabs.find(({ tabId }) => tabId === 13);
            if (exact !== undefined) serverPageUrl = exact.url;
            return Response.json({ closed: 0, inserted: 0, updated: 1 });
          }
          if (url.includes("/api/local/session-intents?")) {
            return Response.json({
              current: serverPageUrl === CURRENT_EXPECTED_PAGE.url ? intent : null,
              history: [],
              scope: CURRENT_EXACT_SCOPE,
            });
          }
          if (url.endsWith("/api/local/session-intents/commands")) {
            commandAttempts += 1;
            if (commandAttempts === 1) throw new Error("offline");
            if (serverPageUrl !== CURRENT_EXPECTED_PAGE.url) {
              return Response.json({ error: "SESSION_SCOPE_STALE" }, { status: 409 });
            }
            lifecycleEffects += 1;
            return Response.json({ intent, kind: kind === "archive" ? "archived" : "promoted" });
          }
          if (url.endsWith("/api/health")) return new Response(null, { status: 200 });
          throw new Error(`Unexpected request: ${url}`);
        }),
      );

      const rendered = await currentContextPopupData();
      expect(rendered.sessionIntent?.current).toMatchObject({ id: intent.id });
      const first = await handleMessage(
        {
          contextKind: "note",
          expectedPage: intent.expectedPage,
          idempotencyKey: `queued-${kind}-before-navigation`,
          intentId: intent.id,
          kind,
          scope: intent.scope,
          type: "tabhub:context-intent-action",
        },
        {},
      );
      expect(first).toMatchObject({
        context: {
          pendingMutationCount: 1,
          pendingMutationError: "Retry required",
        },
        ok: true,
      });

      const pageB = {
        active: true,
        id: 13,
        index: 2,
        title: "Page B",
        url: "https://example.com/b",
        windowId: 9,
      };
      extensionBrowser.tabs.query.mockImplementation(
        async () => [pageB],
      );
      extensionBrowser.tabs.get.mockResolvedValue(pageB);

      const retry = await flushContextMutations();
      expect(retry).toMatchObject({
        remaining: [
          {
            command: { idempotencyKey: `queued-${kind}-before-navigation`, kind },
            lastError: "Page changed; review required",
          },
        ],
        sent: 0,
      });
      expect(commandAttempts).toBe(1);
      expect(lifecycleEffects).toBe(0);
      expect(serverPageUrl).toBe(pageB.url);
      const stored = await extensionBrowser.storage.local.get(
        "tabhub.pendingContextMutations",
      );
      expect(stored["tabhub.pendingContextMutations"]).toEqual(retry.remaining);
    },
  );

  it("resolves a confirmed stale head under background ownership and sends its successor once", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    const scope = {
      browserSessionId: CURRENT_SCOPE.browserSessionId,
      browserTabId: 13,
      installationId: CURRENT_SCOPE.installationId,
    };
    const queued = (key: string, id: string) =>
      createPendingContextMutation(
        {
          command: {
            body: `Context ${key}`,
            expectedUrl: "https://example.com/article",
            idempotencyKey: key,
            kind: "set",
            scope,
            visibility: "local_only",
          },
          kind: "session-intent",
          snapshot: {
            ...CURRENT_SCOPE,
            tabs: [
              {
                active: true,
                index: 2,
                tabId: 13,
                url: "https://example.com/article",
                windowId: 9,
              },
            ],
          },
        },
        id,
        "2026-08-12T10:00:00.000Z",
      );
    const stale = {
      ...queued("stale-a", "323e4567-e89b-42d3-a456-426614174003"),
      lastError: "Page changed; review required" as const,
    };
    const successor = queued(
      "successor-b",
      "323e4567-e89b-42d3-a456-426614174004",
    );
    extensionBrowser.__setLocal("tabhub.pendingContextMutations", [
      stale,
      successor,
    ]);
    const commandBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/ingest/snapshot")) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/api/local/session-intents/commands")) {
          commandBodies.push(JSON.parse(String(init?.body)));
          return Response.json({
            intent: {
              archivedAt: null,
              body: "Context successor-b",
              createdAt: "2026-08-12T10:01:00.000Z",
              expectedPage: {
                instanceRevision: 1,
                logicalPageId: 17,
                url: "https://example.com/article",
                urlNormalized: "https://example.com/article",
              },
              expiresAt: null,
              id: 8,
              idempotencyKey: "local:successor-b",
              promotedContextEntryId: null,
              provenance: { actor: "user", method: "manual" },
              scope,
              staleAt: null,
              state: "active",
              subject: { logicalPageId: 17, type: "page" },
              updatedAt: "2026-08-12T10:01:00.000Z",
              visibility: "local_only",
            },
            kind: "set",
          });
        }
        if (url.includes("/api/local/session-intents?")) {
          return Response.json({ current: null, history: [], scope });
        }
        if (url.endsWith("/api/health")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const response = await handleMessage(
      {
        queueHeadId: stale.id,
        type: "tabhub:context-discard-stale",
      },
      {},
    );

    expect(response).toMatchObject({
      context: { pendingMutationCount: 0 },
      ok: true,
    });
    expect(commandBodies).toEqual([
      expect.objectContaining({ idempotencyKey: "successor-b" }),
    ]);
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toEqual([]);
  });

  it("serializes a retry-alarm flush racing a stale discard and sends the successor once", async () => {
    extensionBrowser.__setLocal("tabhub.contextFeatures", {
      context: true,
      logicalImportance: false,
      observedAt: "2026-08-12T10:00:00.000Z",
    });
    extensionBrowser.__setLocal("tabhub.localCapability", {
      credential: "x".repeat(40),
      credentialVersion: 1,
      installationId: CURRENT_SCOPE.installationId,
    });
    const queued = (key: string, id: string) =>
      createPendingContextMutation(
        {
          command: {
            body: `Context ${key}`,
            expectedUrl: "https://example.com/article",
            idempotencyKey: key,
            kind: "set",
            scope: CURRENT_EXACT_SCOPE,
            visibility: "local_only",
          },
          kind: "session-intent",
          snapshot: {
            ...CURRENT_SCOPE,
            tabs: [
              {
                active: true,
                index: 2,
                tabId: 13,
                url: "https://example.com/article",
                windowId: 9,
              },
            ],
          },
        },
        id,
        "2026-08-12T10:00:00.000Z",
      );
    const stale = {
      ...queued("stale-race", "323e4567-e89b-42d3-a456-426614174005"),
      lastError: "Page changed; review required" as const,
    };
    const successor = queued(
      "successor-race",
      "323e4567-e89b-42d3-a456-426614174006",
    );
    extensionBrowser.__setLocal("tabhub.pendingContextMutations", [
      stale,
      successor,
    ]);
    const commandKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/features")) {
          return Response.json({ context: true, logicalImportance: false });
        }
        if (url.endsWith("/api/ingest/snapshot")) {
          return Response.json({ inserted: 0, updated: 1, closed: 0 });
        }
        if (url.endsWith("/api/local/session-intents/commands")) {
          const body = JSON.parse(String(init?.body)) as {
            idempotencyKey: string;
          };
          commandKeys.push(body.idempotencyKey);
          return Response.json({
            intent: {
              archivedAt: null,
              body: "Context successor-race",
              createdAt: "2026-08-12T10:01:00.000Z",
              expectedPage: CURRENT_EXPECTED_PAGE,
              expiresAt: null,
              id: 8,
              idempotencyKey: "local:successor-race",
              promotedContextEntryId: null,
              provenance: { actor: "user", method: "manual" },
              scope: CURRENT_EXACT_SCOPE,
              staleAt: null,
              state: "active",
              subject: { logicalPageId: 17, type: "page" },
              updatedAt: "2026-08-12T10:01:00.000Z",
              visibility: "local_only",
            },
            kind: "set",
          });
        }
        if (url.includes("/api/local/session-intents?")) {
          return Response.json({
            current: null,
            history: [],
            scope: CURRENT_EXACT_SCOPE,
          });
        }
        if (url.endsWith("/api/health")) return new Response(null, { status: 200 });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const alarmRetry = flushContextMutations();
    const discard = handleMessage(
      {
        queueHeadId: stale.id,
        type: "tabhub:context-discard-stale",
      },
      {},
    );
    const [retryResult, discardResult] = await Promise.all([
      alarmRetry,
      discard,
    ]);

    expect(retryResult).toMatchObject({ remaining: [stale, successor], sent: 0 });
    expect(discardResult).toMatchObject({
      context: { pendingMutationCount: 0 },
      ok: true,
    });
    expect(commandKeys).toEqual(["successor-race"]);
    const stored = await extensionBrowser.storage.local.get(
      "tabhub.pendingContextMutations",
    );
    expect(stored["tabhub.pendingContextMutations"]).toEqual([]);
  });
});

describe("background app pairing handover", () => {
  const installationId = "123e4567-e89b-42d3-a456-426614174000";
  const challengeId = "322e4567-e89b-42d3-a456-426614174000";
  const code = "PAIRING-CODE-DOES-NOT-ENTER-A-URL-1234567890";
  const appSender = { tab: { id: 11, url: "http://127.0.0.1:7717/app/", windowId: 9 } };

  function stubServer(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/features")) {
        return new Response(JSON.stringify({ context: true, logicalImportance: false }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/api/local/pairing/consume")) {
        return new Response(
          JSON.stringify({ credential: "c".repeat(43), credentialVersion: 1 }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    extensionBrowser.__deleteLocal("tabhub.contextFeatures");
    extensionBrowser.__deleteLocal("tabhub.localCapability");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("consumes a handover addressed to this installation", async () => {
    stubServer();

    await expect(
      handleMessage(
        { challengeId, code, installationId, type: "tabhub:app-pair" },
        appSender,
      ),
    ).resolves.toMatchObject({
      data: { installationId, paired: true },
      ok: true,
      type: "pair",
    });
  });

  it("refuses a handover addressed to a different installation without contacting the server", async () => {
    const fetchMock = stubServer();

    const response = await handleMessage(
      {
        challengeId,
        code,
        installationId: "999e4567-e89b-42d3-a456-426614174000",
        type: "tabhub:app-pair",
      },
      appSender,
    );

    expect(response).toMatchObject({ ok: false, type: "pair" });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/local/pairing/consume"),
      ),
    ).toHaveLength(0);
  });

  it("refuses a handover that did not come from the local TabHub app", async () => {
    const fetchMock = stubServer();

    const response = await handleMessage(
      { challengeId, code, installationId, type: "tabhub:app-pair" },
      { tab: { id: 11, url: "https://example.com/attack", windowId: 9 } },
    );

    expect(response).toMatchObject({ ok: false, type: "pair" });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/local/pairing/consume"),
      ),
    ).toHaveLength(0);
  });
});

describe("server-unreachable badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the icon when the server cannot be reached", async () => {
    // Issue #37: the only way to learn TabHub was down was to try to use it.
    // The extension already knows, so it says so where the user is looking.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));

    await handleMessage({ type: "tabhub:get-status" }, {});

    // The badge update is fire-and-forget on purpose — a courtesy must not add
    // latency to a status call — so wait for it rather than assume ordering.
    await vi.waitFor(() => {
      expect(extensionBrowser.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    });
    expect(extensionBrowser.action.setTitle).toHaveBeenCalledWith({
      title: "badgeServerUnreachable",
    });
  });

  it("clears the mark once the server answers again", async () => {
    // Reachable means a readable health answer, not merely a 200: an empty
    // body is exactly what an unhealthy server returns.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "ok", database: "ok", schemaVersion: 26 }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )));

    await handleMessage({ type: "tabhub:get-status" }, {});

    await vi.waitFor(() => {
      expect(extensionBrowser.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });
    expect(extensionBrowser.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });
});
