import {
  tabCommandRelayPreviousProtocolVersion,
  tabCommandRelayProtocolVersion,
  type ExactInstanceCaptureReceipt,
  type TabCommandRelayConnectedScope,
  type TabCommandRelayResult,
  type TabInstance,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { TabCommandRelayClientError } from "../src/api";
import {
  classifyExactCaptureCopies,
  executeExactInstanceCapture,
  resolveExactCaptureSelection,
  type ExactCaptureRelayExecutor,
} from "../src/exact-instance-capture";
import type { ExtensionProbe } from "../src/extension-bridge";

const SESSION_A = "223e4567-e89b-42d3-a456-426614174000";
const SESSION_B = "323e4567-e89b-42d3-a456-426614174000";
const INSTALLATION_A = "123e4567-e89b-42d3-a456-426614174000";
const INSTALLATION_B = "423e4567-e89b-42d3-a456-426614174000";

const unavailableProbe: ExtensionProbe = {
  available: false,
  browser: null,
  browserSessionId: null,
  controlWindowId: null,
  installationId: null,
  pendingUndos: [],
  windows: [],
};

function instance(overrides: Partial<TabInstance> = {}): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: SESSION_A,
    browserTabId: 41,
    canonicalTabId: 7,
    discarded: false,
    duplicateGroupSize: 2,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    foregroundTimeMs: 0,
    importance: "medium",
    index: 1,
    installationId: INSTALLATION_A,
    instanceId: 11,
    instanceRevision: 3,
    lastAccessed: 100,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: "Same page",
    url: "https://example.com/article",
    urlNormalized: "https://example.com/article",
    windowId: 2,
    ...overrides,
  };
}

function connectedScope(
  overrides: Partial<TabCommandRelayConnectedScope> = {},
): TabCommandRelayConnectedScope {
  return {
    browser: "chrome",
    browserSessionId: SESSION_A,
    connectedAt: "2026-08-13T08:00:00.000Z",
    installationId: INSTALLATION_A,
    lastSeenAt: "2026-08-13T08:01:00.000Z",
    protocolVersion: tabCommandRelayProtocolVersion,
    ...overrides,
  };
}

function receipt(overrides: Partial<ExactInstanceCaptureReceipt> = {}) {
  return {
    browserTabId: 41,
    canonicalTabId: 7,
    capturedUrl: "https://example.com/article",
    contentRevision: 2,
    extractedAt: "2026-08-13T08:02:00.000Z",
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    instanceId: 11,
    instanceRevision: 3,
    logicalPageId: 17,
    ...overrides,
  } satisfies ExactInstanceCaptureReceipt;
}

describe("exact physical-copy capture", () => {
  it("keeps two same-URL copies distinct and builds each exact target from its instance", () => {
    const copies = classifyExactCaptureCopies(
      [
        instance(),
        instance({
          browserSessionId: SESSION_B,
          browserTabId: 52,
          firstSeenAt: "2026-08-13T08:03:00.000Z",
          installationId: INSTALLATION_B,
          instanceId: 12,
          instanceRevision: 8,
          windowId: 3,
        }),
      ],
      unavailableProbe,
      [
        connectedScope(),
        connectedScope({
          browserSessionId: SESSION_B,
          installationId: INSTALLATION_B,
        }),
      ],
    );

    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({
      kind: "selectable",
      scope: {
        browser: "chrome",
        browserSessionId: SESSION_A,
        installationId: INSTALLATION_A,
      },
      target: {
        expectedFirstSeenAt: "2026-08-13T08:00:00.000Z",
        expectedInstanceRevision: 3,
        expectedUrl: "https://example.com/article",
        instanceId: 11,
        tabId: 41,
      },
    });
    expect(copies[1]).toMatchObject({
      kind: "selectable",
      target: {
        expectedFirstSeenAt: "2026-08-13T08:03:00.000Z",
        expectedInstanceRevision: 8,
        instanceId: 12,
        tabId: 52,
      },
    });
    expect(copies[0]!.selectionKey).not.toBe(copies[1]!.selectionKey);
  });

  it("selects a connected v5 scope even when it is not represented by the page probe", () => {
    const [copy] = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope()],
    );

    expect(copy).toMatchObject({ kind: "selectable" });
  });

  it("does not treat a v5 page probe as relay connectivity", () => {
    const probe: ExtensionProbe = {
      available: true,
      browser: "chrome",
      browserSessionId: SESSION_A,
      commandProtocolVersion: tabCommandRelayProtocolVersion,
      controlWindowId: 2,
      installationId: INSTALLATION_A,
      pendingUndos: [],
      windows: [],
    };

    expect(classifyExactCaptureCopies([instance()], probe, [])[0]).toMatchObject({
      kind: "unavailable",
      reason: "extension_offline",
    });
  });

  it("fails closed for v4 capture, incomplete identity, discarded tabs, and offline scopes", () => {
    const v4 = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope({ protocolVersion: tabCommandRelayPreviousProtocolVersion })],
    )[0];
    const incomplete = classifyExactCaptureCopies(
      [instance({ browserTabId: null })],
      unavailableProbe,
      [connectedScope()],
    )[0];
    const discarded = classifyExactCaptureCopies(
      [instance({ discarded: true })],
      unavailableProbe,
      [connectedScope()],
    )[0];
    const offline = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [],
    )[0];

    expect(v4).toMatchObject({ kind: "unavailable", reason: "protocol_unsupported" });
    expect(incomplete).toMatchObject({ kind: "unavailable", reason: "incomplete_identity" });
    expect(discarded).toMatchObject({ kind: "unavailable", reason: "discarded" });
    expect(offline).toMatchObject({ kind: "unavailable", reason: "extension_offline" });
  });

  it("fails closed when an exact identity field is malformed", () => {
    expect(
      classifyExactCaptureCopies(
        [instance({ firstSeenAt: "not-a-date", url: "not a URL" })],
        unavailableProbe,
        [connectedScope()],
      )[0],
    ).toMatchObject({ kind: "unavailable", reason: "incomplete_identity" });
  });

  it("preflights non-http pages as unsupported", () => {
    expect(
      classifyExactCaptureCopies(
        [instance({ url: "chrome://settings" })],
        unavailableProbe,
        [connectedScope()],
      )[0],
    ).toMatchObject({ kind: "unavailable", reason: "page_unsupported" });
  });

  it("resolves a selection only while the full target and connected scope are current", () => {
    const original = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope()],
    );
    const selectionKey = original[0]!.selectionKey;

    expect(resolveExactCaptureSelection(selectionKey, original)).toMatchObject({
      kind: "selectable",
    });
    expect(
      resolveExactCaptureSelection(
        selectionKey,
        classifyExactCaptureCopies(
          [instance({ instanceRevision: 4 })],
          unavailableProbe,
          [connectedScope()],
        ),
      ),
    ).toBeUndefined();
    expect(
      resolveExactCaptureSelection(
        selectionKey,
        classifyExactCaptureCopies([instance()], unavailableProbe, []),
      ),
    ).toBeUndefined();
  });

  it("dispatches one REST relay command for the selected exact target and returns its receipt", async () => {
    const copy = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope()],
    )[0];
    expect(copy?.kind).toBe("selectable");
    const execute = vi.fn<ExactCaptureRelayExecutor>().mockResolvedValue({
      kind: "capture-tab-content",
      outcome: { receipt: receipt(), status: "captured" },
      target: copy!.target!,
    });

    await expect(
      executeExactInstanceCapture(copy!, execute),
    ).resolves.toEqual({ receipt: receipt(), status: "captured" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      browser: "chrome",
      browserSessionId: SESSION_A,
      command: {
        kind: "capture-tab-content",
        target: copy!.target,
      },
      installationId: INSTALLATION_A,
    });
  });

  it("returns a typed recoverable capture failure without retrying", async () => {
    const copy = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope()],
    )[0]!;
    const failureResult: TabCommandRelayResult = {
      kind: "capture-tab-content",
      outcome: {
        failure: {
          code: "CAPTURE_TAB_NAVIGATED",
          message: "The tab navigated.",
          observedUrl: "https://example.com/next",
          recoverable: true,
        },
        status: "failed",
      },
      target: copy.target!,
    };
    const execute = vi
      .fn<ExactCaptureRelayExecutor>()
      .mockResolvedValue(failureResult);

    await expect(executeExactInstanceCapture(copy, execute)).resolves.toEqual(
      failureResult.outcome,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("treats an uncorrelated receipt as an unknown outcome and never retries", async () => {
    const copy = classifyExactCaptureCopies(
      [instance()],
      unavailableProbe,
      [connectedScope()],
    )[0]!;
    const execute = vi.fn<ExactCaptureRelayExecutor>().mockResolvedValue({
      kind: "capture-tab-content",
      outcome: {
        receipt: receipt({ browserTabId: 99 }),
        status: "captured",
      },
      target: copy.target!,
    });

    const error = await executeExactInstanceCapture(copy, execute).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TabCommandRelayClientError);
    expect(error).toMatchObject({ outcome: "unknown" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
