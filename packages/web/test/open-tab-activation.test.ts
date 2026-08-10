import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalTabActivationSelection,
  canonicalTabBrowserActionSelection,
  executeTabActivation,
  tabActivationAvailability,
} from "../src/open-tab-activation";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";

function tab(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    instanceId: 1,
    canonicalTabId: 1,
    installationId: INSTALLATION_ID,
    browserSessionId: BROWSER_SESSION_ID,
    browserTabId: 42,
    url: "https://example.com/live",
    urlNormalized: "https://example.com/live",
    title: "Live tab",
    browser: "chrome",
    windowId: 7,
    index: 2,
    faviconUrl: null,
    active: false,
    pinned: false,
    lastAccessed: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: 0,
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 1,
    ...overrides,
  };
}

describe("tabActivationAvailability", () => {
  it("returns the native physical target only for the connected installation", () => {
    const exactScope = {
      browser: "chrome" as const,
      browserSessionId: BROWSER_SESSION_ID,
      installationId: INSTALLATION_ID,
    };
    expect(
      tabActivationAvailability(
        tab(),
        { available: true, ...exactScope },
        undefined,
        [exactScope],
      ),
    ).toEqual({
      kind: "ready",
      route: "direct",
      target: {
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
        tabId: 42,
      },
    });
  });

  it("uses an exact connected relay when the owning tab is in another browser", () => {
    expect(
      tabActivationAvailability(
        tab({
          browser: "yandex",
          browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
          installationId: "323e4567-e89b-42d3-a456-426614174000",
        }),
        {
          available: true,
          browser: "chrome",
          browserSessionId: BROWSER_SESSION_ID,
          installationId: INSTALLATION_ID,
        },
        undefined,
        [
          {
            browser: "yandex",
            browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
            installationId: "323e4567-e89b-42d3-a456-426614174000",
          },
        ],
      ),
    ).toMatchObject({
      kind: "ready",
      route: "relay",
      target: { browser: "yandex", tabId: 42 },
    });
  });

  it("keeps English fallback copy and accepts a translator for unavailable messages", () => {
    expect(tabActivationAvailability(tab(), undefined)).toMatchObject({
      kind: "checking",
      message: "Checking connected TabHub extensions.",
    });
    expect(
      tabActivationAvailability(
        tab(),
        undefined,
        (key) => key === "Checking connected TabHub extensions."
          ? "Проверяем локальное расширение TabHub."
          : key,
      ),
    ).toMatchObject({
      kind: "checking",
      message: "Проверяем локальное расширение TabHub.",
    });
  });

  it.each([
    {
      expected: "checking",
      probe: undefined,
      target: tab(),
    },
    {
      expected: "bridge-unavailable",
      probe: {
        available: false,
        browser: null,
        browserSessionId: null,
        installationId: null,
      } as const,
      target: tab(),
    },
    {
      expected: "identity-unconfigured",
      probe: {
        available: true,
        browser: null,
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
      } as const,
      target: tab(),
    },
    {
      expected: "other-installation",
      probe: {
        available: true,
        browser: "edge",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
      } as const,
      target: tab(),
    },
    {
      expected: "other-installation",
      probe: {
        available: true,
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: "223e4567-e89b-42d3-a456-426614174000",
      } as const,
      target: tab(),
    },
    {
      expected: "missing-tab-id",
      probe: {
        available: true,
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
      } as const,
      target: tab({ browserTabId: null }),
    },
    {
      expected: "waiting-for-current-session",
      probe: {
        available: true,
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
      } as const,
      target: tab({ browserSessionId: null }),
    },
    {
      expected: "waiting-for-current-session",
      probe: {
        available: true,
        browser: "chrome",
        browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
        installationId: INSTALLATION_ID,
      } as const,
      target: tab(),
    },
  ])("returns $expected when the row cannot be switched", ({ expected, probe, target }) => {
    expect(tabActivationAvailability(target, probe)).toMatchObject({
      kind: expected,
      message: expect.any(String),
    });
  });
});

describe("canonicalTabActivationSelection", () => {
  const directProbe = {
    available: true,
    browser: "chrome" as const,
    browserSessionId: BROWSER_SESSION_ID,
    installationId: INSTALLATION_ID,
  };
  const relayScope = {
    browser: "chrome" as const,
    browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
    installationId: "323e4567-e89b-42d3-a456-426614174000",
  };

  it("prefers a directly controlled copy over a newer active relayed copy", () => {
    const selection = canonicalTabActivationSelection(
      [
        tab({ instanceId: 1, lastAccessed: 10 }),
        tab({
          active: true,
          browserSessionId: relayScope.browserSessionId,
          browserTabId: 84,
          installationId: relayScope.installationId,
          instanceId: 2,
          lastAccessed: 20,
        }),
      ],
      directProbe,
      undefined,
      [relayScope],
    );

    expect(selection).toMatchObject({
      kind: "ready",
      activation: { route: "direct", target: { tabId: 42 } },
      tab: { instanceId: 1 },
    });
  });

  it("selects an exact connected relay when no direct copy is available", () => {
    const selection = canonicalTabActivationSelection(
      [
        tab({
          browserSessionId: relayScope.browserSessionId,
          browserTabId: 84,
          installationId: relayScope.installationId,
        }),
      ],
      {
        available: false,
        browser: null,
        browserSessionId: null,
        installationId: null,
      },
      undefined,
      [relayScope],
    );

    expect(selection).toMatchObject({
      kind: "ready",
      activation: {
        route: "relay",
        target: { ...relayScope, tabId: 84 },
      },
    });
  });

  it("chooses the most recently used physical copy within one route", () => {
    const selection = canonicalTabActivationSelection(
      [
        tab({ browserTabId: 41, instanceId: 1, lastAccessed: 30 }),
        tab({
          active: true,
          browserTabId: 42,
          instanceId: 2,
          lastAccessed: 10,
        }),
        tab({ browserTabId: 43, instanceId: 3, lastAccessed: 20 }),
      ],
      directProbe,
    );

    expect(selection).toMatchObject({
      kind: "ready",
      activation: { route: "direct", target: { tabId: 41 } },
      tab: { instanceId: 1 },
    });
  });

  it("fails closed when canonical state is stale and no physical copy exists", () => {
    expect(canonicalTabActivationSelection([], directProbe)).toEqual({
      kind: "unavailable",
      message: "This tab is no longer open. Refresh the Library and try again.",
    });
  });

  it("activates a fresh physical copy even when the Library rendered it closed", () => {
    const selection = canonicalTabBrowserActionSelection(
      [tab({ browserTabId: 91 })],
      {
        canonicalTabId: 7,
        newTabUrlIfConfirmedClosed: "https://example.com/stale-closed-row",
      },
      directProbe,
    );

    expect(selection).toMatchObject({
      kind: "ready",
      activation: { route: "direct", target: { tabId: 91 } },
    });
  });

  it("authorizes a new URL tab only after the fresh lookup finds no instances", () => {
    expect(
      canonicalTabBrowserActionSelection(
        [],
        {
          canonicalTabId: 7,
          newTabUrlIfConfirmedClosed: "https://example.com/confirmed-closed",
        },
        directProbe,
      ),
    ).toEqual({
      kind: "open-new",
      url: "https://example.com/confirmed-closed",
    });
  });
});

describe("executeTabActivation", () => {
  it("uses the exact direct physical target without creating a URL action", async () => {
    const direct = vi.fn().mockResolvedValue({
      browser: "chrome",
      browserSessionId: BROWSER_SESSION_ID,
      installationId: INSTALLATION_ID,
      tabId: 42,
      windowId: 7,
    });
    const relay = vi.fn();

    await expect(
      executeTabActivation(
        {
          kind: "ready",
          route: "direct",
          target: {
            browser: "chrome",
            browserSessionId: BROWSER_SESSION_ID,
            installationId: INSTALLATION_ID,
            tabId: 42,
          },
        },
        { direct, relay },
      ),
    ).resolves.toMatchObject({ tabId: 42, windowId: 7 });
    expect(direct).toHaveBeenCalledWith(expect.objectContaining({ tabId: 42 }));
    expect(relay).not.toHaveBeenCalled();
  });

  it("addresses the owning browser scope through the relay", async () => {
    const direct = vi.fn();
    const relay = vi.fn().mockResolvedValue({
      kind: "activate-tab",
      tabId: 84,
      windowId: 9,
    });

    await expect(
      executeTabActivation(
        {
          kind: "ready",
          route: "relay",
          target: {
            browser: "yandex",
            browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
            installationId: "323e4567-e89b-42d3-a456-426614174000",
            tabId: 84,
          },
        },
        { direct, relay },
      ),
    ).resolves.toMatchObject({ kind: "activate-tab", tabId: 84 });
    expect(relay).toHaveBeenCalledWith({
      browser: "yandex",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
      command: { kind: "activate-tab", tabId: 84 },
    });
    expect(direct).not.toHaveBeenCalled();
  });
});
