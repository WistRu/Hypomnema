import {
  isRelayedTabCommandOutcomeUnknown,
  TabCommandRelayClientError,
} from "./api";
import {
  ExtensionBridgeRejectedError,
  ExtensionBridgeTimeoutError,
} from "./extension-bridge";

/** Marks a response that arrived after dispatch but cannot prove what closed. */
export class DuplicateGroupsCloseAllUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateGroupsCloseAllUnknownOutcomeError";
  }
}

/**
 * Only typed post-dispatch/timeout failures are unknown. Explicit relay
 * not-sent responses and extension rejections are known failures that can be
 * safely re-planned after refreshing the live snapshot.
 */
export function duplicateGroupsCloseAllRejectedOutcome(
  cause: unknown,
): "failed" | "unknown" {
  if (
    cause instanceof DuplicateGroupsCloseAllUnknownOutcomeError ||
    cause instanceof ExtensionBridgeTimeoutError ||
    isRelayedTabCommandOutcomeUnknown(cause)
  ) {
    return "unknown";
  }
  if (
    cause instanceof TabCommandRelayClientError ||
    cause instanceof ExtensionBridgeRejectedError
  ) {
    return "failed";
  }
  return "unknown";
}
