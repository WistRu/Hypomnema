import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeRelayedTabCommand,
  fetchAllOpenTabs,
  fetchConnectedTabCommandScopes,
  fetchDuplicateGroups,
  fetchOpenTabs,
  TabCommandRelayClientError,
} from "../src/api";

const relayScope = {
  browser: "chrome" as const,
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};

function instance(instanceId: number, active = false) {
  return {
    instanceId,
    canonicalTabId: 7,
    installationId: "chrome-main",
    browserTabId: instanceId,
    url: "https://example.com/exact",
    urlNormalized: "https://example.com/exact",
    title: "Exact copy",
    browser: "chrome",
    windowId: 2,
    index: instanceId - 101,
    faviconUrl: null,
    active,
    audible: false,
    discarded: false,
    muted: false,
    pinned: false,
    lastAccessed: 1_754_700_000_000 + instanceId,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:01:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 3,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("open-tab API", () => {
  it("lists extension sessions that can receive addressed tab commands", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            ...relayScope,
            connectedAt: "2026-08-09T06:00:00.000Z",
            lastSeenAt: "2026-08-09T06:00:20.000Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConnectedTabCommandScopes()).resolves.toEqual([
      expect.objectContaining(relayScope),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tab-command-relay/scopes",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("routes a duplicate close preview to its owning extension session", async () => {
    const previewId = "423e4567-e89b-42d3-a456-426614174000";
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        requestId: "523e4567-e89b-42d3-a456-426614174000",
        scope: relayScope,
        result: {
          candidateTabIds: [12],
          expiresAt: 1_800_000_000_000,
          kind: "close-preview",
          previewId,
          requested: 1,
          skipped: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeRelayedTabCommand({
        ...relayScope,
        command: {
          kind: "close-preview",
          targets: [
            {
              expectedUrl: "https://example.com/exact",
              keeper: {
                expectedUrl: "https://example.com/exact",
                tabId: 11,
              },
              tabId: 12,
            },
          ],
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "close-preview", previewId }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tab-command-relay/commands",
      expect.objectContaining({
        body: expect.stringContaining(`\"browserSessionId\":\"${relayScope.browserSessionId}\"`),
        method: "POST",
      }),
    );
  });

  it("preserves whether a failed relay command was never sent or has an unknown outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "EXTENSION_DISCONNECTED",
            message: "The owning extension disconnected after dispatch.",
            ok: false,
            outcome: "unknown",
            requestId: "623e4567-e89b-42d3-a456-426614174000",
          },
          { status: 502 },
        )),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: {
        confirmed: true,
        kind: "close",
        previewId: "423e4567-e89b-42d3-a456-426614174000",
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "EXTENSION_DISCONNECTED",
      outcome: "unknown",
    });
  });

  it("treats a rejected relay fetch as an unknown post-dispatch outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "EXTENSION_DISCONNECTED",
      outcome: "unknown",
    });
  });

  it("keeps invalid pre-dispatch requests distinct from unknown outcomes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "set-pinned", targets: [], value: true },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toHaveProperty("message", "Invalid addressed browser command.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unreadable relay response as an unknown post-dispatch outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("treats a malformed relay receipt as an unknown post-dispatch outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, result: null })),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("marks a successful receipt from another extension session as outcome unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          requestId: "523e4567-e89b-42d3-a456-426614174000",
          scope: {
            ...relayScope,
            browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
          },
          result: {
            candidateTabIds: [],
            expiresAt: 1_800_000_000_000,
            kind: "close-preview",
            previewId: "423e4567-e89b-42d3-a456-426614174000",
            requested: 1,
            skipped: [{ reason: "missing", tabId: 12 }],
          },
        })),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: {
        kind: "close-preview",
        targets: [{ expectedUrl: "https://example.com/exact", tabId: 12 }],
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("different browser session"),
    );
  });

  it("marks a success body on a failed HTTP response as outcome unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: true,
            requestId: "523e4567-e89b-42d3-a456-426614174000",
            scope: relayScope,
            result: {
              kind: "activate-tab",
              tabId: 12,
              windowId: 2,
            },
          },
          { status: 502 },
        ),
      ),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("marks a success result for another command as outcome unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          requestId: "523e4567-e89b-42d3-a456-426614174000",
          scope: relayScope,
          result: {
            kind: "get-browser-state",
            pendingUndos: [],
            windows: [],
          },
        }),
      ),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("marks an activation receipt for another tab as outcome unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          requestId: "523e4567-e89b-42d3-a456-426614174000",
          scope: relayScope,
          result: {
            kind: "activate-tab",
            tabId: 99,
            windowId: 2,
          },
        }),
      ),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: { kind: "activate-tab", tabId: 12 },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("marks a mutation receipt for another target as outcome unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          requestId: "523e4567-e89b-42d3-a456-426614174000",
          scope: relayScope,
          result: {
            failed: [],
            kind: "set-pinned",
            requested: 1,
            skipped: [],
            succeededTabIds: [99],
          },
        }),
      ),
    );

    const error = await executeRelayedTabCommand({
      ...relayScope,
      command: {
        kind: "set-pinned",
        targets: [{ expectedUrl: "https://example.com/exact", tabId: 12 }],
        value: true,
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({
      code: "INVALID_COMMAND_RECEIPT",
      outcome: "unknown",
    });
  });

  it("loads more than 200 filtered physical occurrences with one bulk request", async () => {
    const items = Array.from({ length: 251 }, (_, index) =>
      instance(index + 101),
    );
    const fetchMock = vi.fn(async () =>
      Response.json({
        items,
        total: items.length,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllOpenTabs({
        browser: "chrome",
        duplicatesOnly: true,
        q: "exact copy",
      }),
    ).resolves.toHaveLength(251);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tab-instances/bulk?browser=chrome&duplicates_only=true&q=exact+copy",
    );
  });

  it("rejects a bulk payload that violates the shared response contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], total: "all" })),
    );

    await expect(
      fetchAllOpenTabs({ browser: "all", duplicatesOnly: false, q: "" }),
    ).rejects.toThrow("unexpected bulk open-tab list");
  });

  it("requests physical occurrences with duplicate and browser filters", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            instanceId: 101,
            canonicalTabId: 7,
            installationId: "chrome-main",
            browserTabId: 55,
            url: "https://example.com/exact",
            urlNormalized: "https://example.com/exact",
            title: "Exact copy",
            browser: "chrome",
            windowId: 2,
            index: 5,
            faviconUrl: null,
            active: false,
            audible: false,
            discarded: false,
            muted: false,
            pinned: false,
            lastAccessed: 1_754_700_000_000,
            firstSeenAt: "2026-08-09T00:00:00.000Z",
            lastSeenAt: "2026-08-09T00:01:00.000Z",
            status: "inbox",
            importance: 0,
            summary: null,
            tagPaths: [],
            duplicateGroupSize: 2,
          },
        ],
        total: 459,
        page: 2,
        pageSize: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOpenTabs({
      browser: "chrome",
      duplicatesOnly: true,
      page: 2,
      q: "exact copy",
    });

    expect(result.total).toBe(459);
    expect(result.items[0]?.instanceId).toBe(101);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tab-instances?page=2&pageSize=50&browser=chrome&duplicates_only=true&q=exact+copy",
    );
  });

  it("rejects an unreadable physical occurrence payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [] })));

    await expect(
      fetchOpenTabs({
        browser: "all",
        duplicatesOnly: false,
        page: 1,
        q: "",
      }),
    ).rejects.toThrow("unexpected open-tab list");
  });

  it("loads exact duplicate groups with an optional browser scope", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          {
            installationId: "chrome-main",
            browser: "chrome",
            url: "https://example.com/exact",
            count: 3,
            keeperInstanceId: 101,
            candidateInstanceIds: [102],
            protectedInstanceIds: [103],
            instances: [instance(101, true), instance(102), instance(103)],
          },
        ],
        totalGroups: 1,
        totalTabsInGroups: 3,
        totalDuplicateCopies: 2,
        totalCloseCandidates: 1,
        totalProtected: 1,
        page: 1,
        pageSize: 50,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDuplicateGroups({
      browser: "chrome",
      page: 1,
      q: "Needle title",
    });

    expect(result.totalDuplicateCopies).toBe(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/duplicate-groups?page=1&pageSize=50&browser=chrome&q=Needle+title",
    );
  });
});
