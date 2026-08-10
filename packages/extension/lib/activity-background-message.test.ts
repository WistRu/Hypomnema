import { beforeEach, describe, expect, it, vi } from "vitest";

const extensionBrowser = vi.hoisted(() => {
  let session = 0;
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
    resetActivityState() {
      session += 1;
      for (const key of Object.keys(localValues)) delete localValues[key];
      Object.assign(localValues, {
        "tabhub.browser": "chrome",
        "tabhub.browserConfiguredVersion": 1,
        "tabhub.installationId": "123e4567-e89b-42d3-a456-426614174000",
      });
      sessionValues["tabhub.browserSessionId"] =
        `223e4567-e89b-42d3-a456-${String(session).padStart(12, "0")}`;
    },
    idle: {
      queryState: vi.fn(async () => "active" as const),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | readonly string[]) =>
          read(localValues, keys),
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localValues, items);
        }),
      },
      session: {
        get: vi.fn(async (keys: string | readonly string[]) =>
          read(sessionValues, keys),
        ),
        remove: vi.fn(async () => undefined),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionValues, items);
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => [
        {
          active: true,
          id: 42,
          index: 0,
          url: "https://example.com/article",
          windowId: 7,
        },
      ]),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ focused: true, id: 7 })),
    },
  };
});

vi.mock("wxt/browser", () => ({ browser: extensionBrowser }));
vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (setup: unknown) => setup,
}));

import { handleMessage } from "../entrypoints/background";

describe("background tab activity messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionBrowser.resetActivityState();
  });

  it("records foreground time and only marks time after a top-frame interaction as engaged", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const uploads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") {
          uploads.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response(null, { status: 200 });
      }),
    );
    const sender = {
      frameId: 0,
      tab: {
        id: 42,
        url: "https://example.com/article",
        windowId: 7,
      },
    };

    await handleMessage(
      {
        kind: "heartbeat",
        type: "tabhub:activity-signal",
        url: "https://example.com/article",
      },
      sender,
    );
    now = 5_000;
    await handleMessage(
      {
        kind: "heartbeat",
        type: "tabhub:activity-signal",
        url: "https://example.com/background",
      },
      {
        frameId: 0,
        tab: {
          id: 99,
          url: "https://example.com/background",
          windowId: 7,
        },
      },
    );
    now = 10_000;
    await handleMessage(
      {
        kind: "interaction",
        type: "tabhub:activity-signal",
      },
      { ...sender, frameId: 5 },
    );
    now = 20_000;
    await handleMessage(
      {
        kind: "heartbeat",
        type: "tabhub:activity-signal",
        url: "https://example.com/article",
      },
      sender,
    );

    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({
      browserTabId: 42,
      sequence: 1,
      foregroundMs: 10_000,
      engagedMs: 0,
    });
    expect(uploads[1]).toMatchObject({
      browserTabId: 42,
      sequence: 2,
      foregroundMs: 10_000,
      engagedMs: 10_000,
    });
  });

  it("serializes foreground queries before recording their observations", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const uploads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") {
          uploads.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response(null, { status: 200 });
      }),
    );
    const signal = (browserTabId: number, url: string) =>
      handleMessage(
        { kind: "heartbeat", type: "tabhub:activity-signal", url },
        { frameId: 0, tab: { id: browserTabId, url, windowId: 7 } },
      );

    await signal(42, "https://example.com/article");

    let releaseB!: () => void;
    let releaseC!: () => void;
    type QueryResult = Awaited<
      ReturnType<typeof extensionBrowser.tabs.query>
    >;
    const tabB = new Promise<QueryResult>((resolve) => {
      releaseB = () =>
        resolve([
          {
            active: true,
            id: 43,
            index: 0,
            url: "https://example.com/b",
            windowId: 7,
          },
        ]);
    });
    const tabC = new Promise<QueryResult>((resolve) => {
      releaseC = () =>
        resolve([
          {
            active: true,
            id: 44,
            index: 0,
            url: "https://example.com/c",
            windowId: 7,
          },
        ]);
    });
    extensionBrowser.tabs.query
      .mockImplementationOnce(async () => tabB)
      .mockImplementationOnce(async () => tabC);

    now = 10_000;
    const first = signal(43, "https://example.com/b");
    await vi.waitFor(() => {
      expect(extensionBrowser.tabs.query).toHaveBeenCalledTimes(2);
    });
    const second = signal(44, "https://example.com/c");
    await Promise.resolve();
    expect(extensionBrowser.tabs.query).toHaveBeenCalledTimes(2);

    releaseB();
    await first;
    now = 20_000;
    releaseC();
    await second;

    expect(uploads).toHaveLength(2);
    expect(uploads.map(({ browserTabId, sequence, url }) => ({
      browserTabId,
      sequence,
      url,
    }))).toEqual([
      {
        browserTabId: 42,
        sequence: 1,
        url: "https://example.com/article",
      },
      { browserTabId: 43, sequence: 2, url: "https://example.com/b" },
    ]);
  });

  it("samples a tab switch while the previous upload is still pending", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        await uploadGate;
        return new Response(null, { status: 200 });
      })
      .mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = (browserTabId: number, url: string) =>
      handleMessage(
        { kind: "heartbeat", type: "tabhub:activity-signal", url },
        { frameId: 0, tab: { id: browserTabId, url, windowId: 7 } },
      );

    await signal(42, "https://example.com/article");
    now = 10_000;
    const uploading = signal(42, "https://example.com/article");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    extensionBrowser.tabs.query.mockResolvedValueOnce([
      {
        active: true,
        id: 43,
        index: 0,
        url: "https://example.com/next",
        windowId: 7,
      },
    ]);
    now = 20_000;
    const switching = signal(43, "https://example.com/next");

    await vi.waitFor(() => {
      expect(extensionBrowser.tabs.query).toHaveBeenCalledTimes(3);
    });
    releaseUpload();
    await Promise.all([uploading, switching]);
  });
});
