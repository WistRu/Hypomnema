import { describe, expect, it } from "vitest";

import { TabCommandRelayClientError } from "../src/api";
import {
  duplicateGroupsCloseAllRejectedOutcome,
  DuplicateGroupsCloseAllUnknownOutcomeError,
} from "../src/duplicate-groups-close-all-outcome";
import {
  ExtensionBridgeRejectedError,
  ExtensionBridgeTimeoutError,
} from "../src/extension-bridge";

describe("global duplicate close outcome classification", () => {
  it("keeps explicit not-sent and extension rejections retryable after a replan", () => {
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new TabCommandRelayClientError("offline", {
          code: "SCOPE_OFFLINE",
          outcome: "not-sent",
        }),
      ),
    ).toBe("failed");
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new ExtensionBridgeRejectedError("Preview expired."),
      ),
    ).toBe("failed");
  });

  it("never makes post-dispatch, timeout, or untyped failures look safe to retry", () => {
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new TabCommandRelayClientError("disconnected", {
          code: "SCOPE_DISCONNECTED",
          outcome: "unknown",
        }),
      ),
    ).toBe("unknown");
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new Error("invalid direct bridge receipt"),
      ),
    ).toBe("unknown");
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new ExtensionBridgeTimeoutError("tab-command"),
      ),
    ).toBe("unknown");
    expect(
      duplicateGroupsCloseAllRejectedOutcome(
        new DuplicateGroupsCloseAllUnknownOutcomeError("bad receipt"),
      ),
    ).toBe("unknown");
    expect(duplicateGroupsCloseAllRejectedOutcome(new Error("network"))).toBe(
      "unknown",
    );
  });
});
