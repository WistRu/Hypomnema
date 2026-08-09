import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import type { TabCommand } from "../src/extension-bridge";
import {
  addressedTabSelection,
  relayedPhysicalCommand,
} from "../src/open-tab-command-routing";

const CHROME_INSTALLATION = "123e4567-e89b-42d3-a456-426614174000";
const CHROME_SESSION = "223e4567-e89b-42d3-a456-426614174000";
const YANDEX_INSTALLATION = "323e4567-e89b-42d3-a456-426614174000";
const YANDEX_SESSION = "423e4567-e89b-42d3-a456-426614174000";

function tab(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: false,
    browser: "yandex",
    browserSessionId: YANDEX_SESSION,
    browserTabId: 42,
    canonicalTabId: 1,
    discarded: false,
    duplicateGroupSize: 1,
    faviconUrl: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    importance: 0,
    index: 0,
    installationId: YANDEX_INSTALLATION,
    instanceId: 1,
    lastAccessed: null,
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Remote tab",
    url: "https://example.com/remote",
    urlNormalized: "https://example.com/remote",
    windowId: 7,
    ...overrides,
  };
}

describe("addressed tab selection", () => {
  it("routes every tab in one foreign scope through its connected relay", () => {
    const first = tab();
    const second = tab({
      browserTabId: 43,
      instanceId: 2,
      url: "https://example.com/second",
      urlNormalized: "https://example.com/second",
    });

    expect(
      addressedTabSelection(
        new Map([
          [first.instanceId, first],
          [second.instanceId, second],
        ]),
        {
          browser: "chrome",
          browserSessionId: CHROME_SESSION,
          installationId: CHROME_INSTALLATION,
        },
        [
          {
            browser: "yandex",
            browserSessionId: YANDEX_SESSION,
            installationId: YANDEX_INSTALLATION,
          },
        ],
      ),
    ).toEqual({
      kind: "ready",
      route: "relay",
      scope: {
        browser: "yandex",
        browserSessionId: YANDEX_SESSION,
        installationId: YANDEX_INSTALLATION,
      },
      tabs: [first, second],
      targets: [
        { expectedUrl: first.url, tabId: 42 },
        { expectedUrl: second.url, tabId: 43 },
      ],
    });
  });

  it("prefers the direct bridge when the same exact scope is also relayed", () => {
    const selected = tab({
      browser: "chrome",
      browserSessionId: CHROME_SESSION,
      installationId: CHROME_INSTALLATION,
    });
    const scope = {
      browser: "chrome" as const,
      browserSessionId: CHROME_SESSION,
      installationId: CHROME_INSTALLATION,
    };

    expect(
      addressedTabSelection(
        new Map([[selected.instanceId, selected]]),
        scope,
        [scope],
      ),
    ).toMatchObject({ kind: "ready", route: "direct", scope });
  });

  it("fails closed when a snapshot repeats one physical browser tab ID", () => {
    const first = tab();
    const staleDuplicate = tab({
      instanceId: 2,
      url: "https://example.com/stale",
      urlNormalized: "https://example.com/stale",
    });

    expect(
      addressedTabSelection(
        new Map([
          [first.instanceId, first],
          [staleDuplicate.instanceId, staleDuplicate],
        ]),
        null,
        [
          {
            browser: "yandex",
            browserSessionId: YANDEX_SESSION,
            installationId: YANDEX_INSTALLATION,
          },
        ],
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("fails closed for mixed scopes and an offline exact scope", () => {
    const first = tab();
    const otherScope = tab({
      browser: "chrome",
      browserSessionId: CHROME_SESSION,
      browserTabId: 99,
      installationId: CHROME_INSTALLATION,
      instanceId: 2,
    });

    expect(
      addressedTabSelection(
        new Map([
          [first.instanceId, first],
          [otherScope.instanceId, otherScope],
        ]),
        null,
        [],
      ),
    ).toEqual({ kind: "mixed-scopes" });
    expect(
      addressedTabSelection(
        new Map([[first.instanceId, first]]),
        null,
        [],
      ),
    ).toEqual({
      kind: "offline",
      scope: {
        browser: "yandex",
        browserSessionId: YANDEX_SESSION,
        installationId: YANDEX_INSTALLATION,
      },
    });
  });

  it("allows a non-close physical command through the addressed relay", () => {
    expect(
      relayedPhysicalCommand({
        kind: "set-muted",
        targets: [{ expectedUrl: "https://example.com/remote", tabId: 42 }],
        value: true,
      }),
    ).toEqual({
      kind: "set-muted",
      targets: [{ expectedUrl: "https://example.com/remote", tabId: 42 }],
      value: true,
    });
  });

  it("accepts every remotely valid tab command and rejects app-window destinations", () => {
    const target = { expectedUrl: "https://example.com/remote", tabId: 42 };
    const commands: TabCommand[] = [
      { kind: "close-preview", targets: [target] },
      {
        confirmed: true,
        kind: "close",
        previewId: "523e4567-e89b-42d3-a456-426614174000",
      },
      {
        kind: "undo-close",
        undoId: "623e4567-e89b-42d3-a456-426614174000",
      },
      { kind: "set-pinned", targets: [target], value: true },
      { kind: "set-muted", targets: [target], value: true },
      { kind: "discard", targets: [target] },
      { kind: "reload", targets: [target] },
      { destination: { kind: "new-window" }, kind: "move", targets: [target] },
      {
        destination: { kind: "window", windowId: 19 },
        kind: "move",
        targets: [target],
      },
      {
        destination: { kind: "new-window" },
        kind: "open-workspace",
        tabs: [{ muted: false, pinned: false, url: target.expectedUrl }],
      },
    ];

    expect(commands.map(relayedPhysicalCommand)).not.toContain(null);
    expect(
      relayedPhysicalCommand({
        destination: { kind: "app-window" },
        kind: "move",
        targets: [target],
      }),
    ).toBeNull();
    expect(
      relayedPhysicalCommand({
        destination: { kind: "app-window" },
        kind: "open-workspace",
        tabs: [{ muted: false, pinned: false, url: target.expectedUrl }],
      }),
    ).toBeNull();
  });
});
