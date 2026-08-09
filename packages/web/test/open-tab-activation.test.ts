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
    expect(
      tabActivationAvailability(tab(), {
        available: true,
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
      }),
    ).toEqual({
      kind: "ready",
      target: {
        browser: "chrome",
        browserSessionId: BROWSER_SESSION_ID,
        installationId: INSTALLATION_ID,
        tabId: 42,
      },
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
