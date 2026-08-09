import { beforeEach, describe, expect, it, vi } from "vitest";

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
            id: 13,
            index: 2,
            url: "https://example.com/article",
            windowId: 9,
          };
        }
        throw new Error("Missing tab");
      }),
      query: vi.fn(async () => [
        { id: 11, url: "http://127.0.0.1:7717/app/", windowId: 9 },
        {
          id: 12,
          pendingUrl: "http://localhost:7717/app/?view=open",
          windowId: 9,
        },
        { id: 13, url: "https://example.com/article", windowId: 9 },
      ]),
    },
  };
});

vi.mock("wxt/browser", () => ({ browser: extensionBrowser }));
vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (setup: unknown) => setup,
}));

import { handleMessage } from "../entrypoints/background";

const CURRENT_SCOPE = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};

describe("background app tab command messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
