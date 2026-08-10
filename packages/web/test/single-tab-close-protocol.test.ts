import {
  tabCommandRelayProtocolVersion,
  type TabCommandRelayConnectedScope,
  type TabInstance,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionProbe } from "../src/extension-bridge";
import type {
  SingleTabCloseCommandExecutor,
  SingleTabClosePlan,
} from "../src/middle-click-close";
import {
  canonicalSingleTabCloseSelection,
  executeSingleTabCloseForConnectedScopes,
} from "../src/use-single-tab-close";
import { tabActivationAvailability } from "../src/open-tab-activation";

const CURRENT_SESSION = "223e4567-e89b-42d3-a456-426614174000";
const CURRENT_INSTALLATION = "123e4567-e89b-42d3-a456-426614174000";
const LEGACY_SESSION = "423e4567-e89b-42d3-a456-426614174000";
const LEGACY_INSTALLATION = "323e4567-e89b-42d3-a456-426614174000";

const unavailableProbe: ExtensionProbe = {
  available: false,
  browser: null,
  browserSessionId: null,
  controlWindowId: null,
  installationId: null,
  pendingUndos: [],
  windows: [],
};

const legacyDirectProbe: ExtensionProbe = {
  available: true,
  browser: "yandex",
  browserSessionId: CURRENT_SESSION,
  controlWindowId: 9,
  installationId: CURRENT_INSTALLATION,
  pendingUndos: [],
  windows: [{ focused: true, tabCount: 2, windowId: 9 }],
};

function connectedScope(
  protocolVersion: 3 | typeof tabCommandRelayProtocolVersion,
  overrides: Partial<TabCommandRelayConnectedScope> = {},
): TabCommandRelayConnectedScope {
  return {
    browser: "yandex",
    browserSessionId: CURRENT_SESSION,
    connectedAt: "2026-08-10T00:00:00.000Z",
    installationId: CURRENT_INSTALLATION,
    lastSeenAt: "2026-08-10T00:01:00.000Z",
    protocolVersion,
    ...overrides,
  };
}

function tab(overrides: Partial<TabInstance>): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "yandex",
    browserSessionId: CURRENT_SESSION,
    browserTabId: 41,
    canonicalTabId: 7,
    discarded: false,
    duplicateGroupSize: 2,
    faviconUrl: null,
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    importance: "medium",
    index: 1,
    installationId: CURRENT_INSTALLATION,
    instanceId: 1,
    lastAccessed: 10,
    lastSeenAt: "2026-08-10T00:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Open tab",
    url: "https://example.com/open",
    urlNormalized: "https://example.com/open",
    windowId: 2,
    ...overrides,
  };
}

describe("single-tab close relay protocol", () => {
  it("keeps ordinary tab activation compatible with a legacy v3 relay", () => {
    expect(
      tabActivationAvailability(
        tab({}),
        unavailableProbe,
        undefined,
        [connectedScope(3)],
      ),
    ).toMatchObject({
      kind: "ready",
      route: "relay",
      target: { tabId: 41 },
    });
  });

  it("fails clearly before dispatching to a selected legacy v3 scope", async () => {
    const scope = connectedScope(3);
    const plan: SingleTabClosePlan = {
      route: "relay",
      scope,
      target: { expectedUrl: "https://example.com/open", tabId: 41 },
    };
    const execute = vi.fn<SingleTabCloseCommandExecutor>();

    await expect(
      executeSingleTabCloseForConnectedScopes(
        plan,
        unavailableProbe,
        [scope],
        execute,
      ),
    ).rejects.toThrow(
      "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails before dispatching an exact direct close when the probe is legacy", async () => {
    const plan: SingleTabClosePlan = {
      route: "direct",
      scope: {
        browser: "yandex",
        browserSessionId: CURRENT_SESSION,
        installationId: CURRENT_INSTALLATION,
      },
      target: { expectedUrl: "https://example.com/open", tabId: 41 },
    };
    const execute = vi.fn<SingleTabCloseCommandExecutor>();

    await expect(
      executeSingleTabCloseForConnectedScopes(
        plan,
        legacyDirectProbe,
        [],
        execute,
      ),
    ).rejects.toThrow(
      "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a legacy-shaped direct probe when its exact relay negotiated v4", async () => {
    const plan: SingleTabClosePlan = {
      route: "direct",
      scope: {
        browser: "yandex",
        browserSessionId: CURRENT_SESSION,
        installationId: CURRENT_INSTALLATION,
      },
      target: { expectedUrl: "https://example.com/open", tabId: 41 },
    };
    const execute = vi
      .fn<SingleTabCloseCommandExecutor>()
      .mockResolvedValueOnce({
        candidateTabIds: [41],
        expiresAt: 1_800_000_000_000,
        kind: "close-preview",
        previewId: "523e4567-e89b-42d3-a456-426614174000",
        requested: 1,
        skipped: [],
      })
      .mockResolvedValueOnce({
        failed: [],
        kind: "close",
        requested: 1,
        skipped: [],
        succeededTabIds: [41],
        undo: null,
      });

    await expect(
      executeSingleTabCloseForConnectedScopes(
        plan,
        legacyDirectProbe,
        [connectedScope(tabCommandRelayProtocolVersion)],
        execute,
      ),
    ).resolves.toMatchObject({ kind: "close", succeededTabIds: [41] });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("prefers a v4-capable relayed copy over a newer legacy copy", () => {
    const legacyScope = connectedScope(3, {
      browserSessionId: LEGACY_SESSION,
      installationId: LEGACY_INSTALLATION,
    });
    const currentScope = connectedScope(tabCommandRelayProtocolVersion);

    const selection = canonicalSingleTabCloseSelection(
      [
        tab({
          browserSessionId: LEGACY_SESSION,
          browserTabId: 42,
          installationId: LEGACY_INSTALLATION,
          instanceId: 2,
          lastAccessed: 20,
        }),
        tab({ instanceId: 1, lastAccessed: 10 }),
      ],
      unavailableProbe,
      [legacyScope, currentScope],
    );

    expect(selection).toMatchObject({
      activation: {
        route: "relay",
        target: {
          browserSessionId: CURRENT_SESSION,
          installationId: CURRENT_INSTALLATION,
          tabId: 41,
        },
      },
      kind: "ready",
      tab: { instanceId: 1 },
    });
  });

  it("prefers a v4 relay over a matching legacy direct probe", () => {
    const currentScope = connectedScope(tabCommandRelayProtocolVersion, {
      browserSessionId: LEGACY_SESSION,
      installationId: LEGACY_INSTALLATION,
    });

    const selection = canonicalSingleTabCloseSelection(
      [
        tab({ instanceId: 1, lastAccessed: 20 }),
        tab({
          browserSessionId: LEGACY_SESSION,
          browserTabId: 42,
          installationId: LEGACY_INSTALLATION,
          instanceId: 2,
          lastAccessed: 10,
        }),
      ],
      legacyDirectProbe,
      [currentScope],
    );

    expect(selection).toMatchObject({
      activation: {
        route: "relay",
        target: {
          browserSessionId: LEGACY_SESSION,
          installationId: LEGACY_INSTALLATION,
          tabId: 42,
        },
      },
      kind: "ready",
      tab: { instanceId: 2 },
    });
  });
});
