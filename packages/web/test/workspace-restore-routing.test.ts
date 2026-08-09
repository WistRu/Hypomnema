import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeRelayedTabCommand,
  TabCommandRelayClientError,
} from "../src/api";
import { ExtensionBridgeTimeoutError } from "../src/extension-bridge";
import {
  isWorkspaceRestoreOutcomeUnknown,
  workspaceRestoreDestination,
} from "../src/workspace-restore-routing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace restore routing", () => {
  it("never maps a remote restore onto the web app window", () => {
    expect(
      workspaceRestoreDestination(false, { kind: "app-window" }),
    ).toBeNull();
    expect(
      workspaceRestoreDestination(false, { kind: "new-window" }),
    ).toEqual({ kind: "new-window" });
    expect(
      workspaceRestoreDestination(true, { kind: "app-window" }),
    ).toEqual({ kind: "app-window" });
  });

  it("recognizes direct and relay errors whose restore outcome is unknown", () => {
    expect(
      isWorkspaceRestoreOutcomeUnknown(
        new ExtensionBridgeTimeoutError("tab-command"),
      ),
    ).toBe(true);
    expect(
      isWorkspaceRestoreOutcomeUnknown(
        new TabCommandRelayClientError("Relay timed out", {
          code: "COMMAND_TIMEOUT",
          outcome: "unknown",
        }),
      ),
    ).toBe(true);
    expect(
      isWorkspaceRestoreOutcomeUnknown(
        new TabCommandRelayClientError("Offline", {
          code: "SCOPE_OFFLINE",
          outcome: "not-sent",
        }),
      ),
    ).toBe(false);
  });

  it("locks restore after transport loss because the remote tabs may already be open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = await executeRelayedTabCommand({
      browser: "chrome",
      browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      command: {
        destination: { kind: "new-window" },
        kind: "open-workspace",
        tabs: [
          {
            muted: false,
            pinned: false,
            url: "https://example.com/",
          },
        ],
      },
    }).catch((cause: unknown) => cause);

    expect(isWorkspaceRestoreOutcomeUnknown(error)).toBe(true);
  });
});
