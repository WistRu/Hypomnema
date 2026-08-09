import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { tabActivationAvailability } from "../src/open-tab-activation";

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
