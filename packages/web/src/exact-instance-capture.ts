import {
  supportsExactCapture,
  type ExactInstanceCaptureFailure,
  type ExactInstanceCaptureReceipt,
  type TabCommandRelayCaptureTarget,
  type TabCommandRelayConnectedScope,
  type TabCommandRelayHttpRequest,
  type TabCommandRelayResult,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";

import { TabCommandRelayClientError } from "./api";
import type { ExtensionProbe } from "./extension-bridge";

export type ExactCaptureUnavailableReason =
  | "extension_offline"
  | "protocol_unsupported"
  | "incomplete_identity"
  | "page_unsupported"
  | "discarded";

interface ExactCaptureCopyBase {
  instance: TabInstance;
  selectionKey: string;
}

export interface SelectableExactCaptureCopy extends ExactCaptureCopyBase {
  kind: "selectable";
  scope: TabCommandScope;
  target: TabCommandRelayCaptureTarget;
}

export interface UnavailableExactCaptureCopy extends ExactCaptureCopyBase {
  kind: "unavailable";
  reason: ExactCaptureUnavailableReason;
}

export type ExactCaptureCopy =
  | SelectableExactCaptureCopy
  | UnavailableExactCaptureCopy;

export type ExactCaptureOutcome =
  | { status: "captured"; receipt: ExactInstanceCaptureReceipt }
  | { status: "failed"; failure: ExactInstanceCaptureFailure };

export type ExactCaptureRelayExecutor = (
  request: TabCommandRelayHttpRequest,
) => Promise<TabCommandRelayResult>;

function sameScope(
  instance: TabInstance,
  scope: Pick<
    TabCommandRelayConnectedScope,
    "browser" | "browserSessionId" | "installationId"
  >,
): boolean {
  return (
    instance.browser === scope.browser &&
    instance.browserSessionId === scope.browserSessionId &&
    instance.installationId === scope.installationId
  );
}

function selectionKey(instance: TabInstance): string {
  // This is a stale-selection fence, not just a React key: every field that
  // addresses an exact physical incarnation is bound into the snapshot.
  return JSON.stringify([
    instance.canonicalTabId,
    instance.instanceId,
    instance.browser,
    instance.installationId,
    instance.browserSessionId,
    instance.browserTabId,
    instance.url,
    instance.instanceRevision,
    instance.firstSeenAt,
  ]);
}

function completeIdentity(instance: TabInstance): boolean {
  return (
    Number.isSafeInteger(instance.canonicalTabId) &&
    instance.canonicalTabId > 0 &&
    Number.isSafeInteger(instance.instanceId) &&
    instance.instanceId > 0 &&
    instance.browserSessionId !== null &&
    instance.browserTabId !== null &&
    Number.isSafeInteger(instance.browserTabId) &&
    instance.browserTabId >= 0 &&
    instance.installationId.trim().length > 0 &&
    URL.canParse(instance.url) &&
    Number.isSafeInteger(instance.instanceRevision) &&
    instance.instanceRevision > 0 &&
    !Number.isNaN(Date.parse(instance.firstSeenAt))
  );
}

function isSupportedPageUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Classifies current physical copies without using the URL as identity. The
 * probe is intentionally only a liveness hint: REST capture is addressable
 * exclusively through an exact connected relay scope.
 */
export function classifyExactCaptureCopies(
  instances: readonly TabInstance[],
  _probe: ExtensionProbe | undefined,
  connectedScopes: readonly TabCommandRelayConnectedScope[],
): ExactCaptureCopy[] {
  return instances.map((instance): ExactCaptureCopy => {
    const key = selectionKey(instance);
    if (!completeIdentity(instance)) {
      return {
        instance,
        kind: "unavailable",
        reason: "incomplete_identity",
        selectionKey: key,
      };
    }
    if (!isSupportedPageUrl(instance.url)) {
      return {
        instance,
        kind: "unavailable",
        reason: "page_unsupported",
        selectionKey: key,
      };
    }
    if (instance.discarded) {
      return {
        instance,
        kind: "unavailable",
        reason: "discarded",
        selectionKey: key,
      };
    }
    const matchingScopes = connectedScopes.filter((scope) =>
      sameScope(instance, scope),
    );
    if (matchingScopes.length === 0) {
      return {
        instance,
        kind: "unavailable",
        reason: "extension_offline",
        selectionKey: key,
      };
    }
    const connected = matchingScopes.find(({ protocolVersion }) =>
      supportsExactCapture(protocolVersion),
    );
    if (connected === undefined) {
      return {
        instance,
        kind: "unavailable",
        reason: "protocol_unsupported",
        selectionKey: key,
      };
    }

    return {
      instance,
      kind: "selectable",
      scope: {
        browser: connected.browser,
        browserSessionId: connected.browserSessionId,
        installationId: connected.installationId,
      },
      target: {
        expectedFirstSeenAt: instance.firstSeenAt,
        expectedInstanceRevision: instance.instanceRevision,
        expectedUrl: instance.url,
        instanceId: instance.instanceId,
        tabId: instance.browserTabId!,
      },
      selectionKey: key,
    };
  });
}

export function resolveExactCaptureSelection(
  selectedSnapshotKey: string | null | undefined,
  currentCopies: readonly ExactCaptureCopy[],
): SelectableExactCaptureCopy | undefined {
  if (!selectedSnapshotKey) return undefined;
  const current = currentCopies.find(
    (copy) => copy.selectionKey === selectedSnapshotKey,
  );
  return current?.kind === "selectable" ? current : undefined;
}

function sameTarget(
  left: TabCommandRelayCaptureTarget,
  right: TabCommandRelayCaptureTarget,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.tabId === right.tabId &&
    left.expectedUrl === right.expectedUrl &&
    left.expectedInstanceRevision === right.expectedInstanceRevision &&
    left.expectedFirstSeenAt === right.expectedFirstSeenAt
  );
}

function receiptMatchesSelection(
  receipt: ExactInstanceCaptureReceipt,
  selection: SelectableExactCaptureCopy,
): boolean {
  return (
    receipt.instanceId === selection.target.instanceId &&
    receipt.browserTabId === selection.target.tabId &&
    receipt.capturedUrl === selection.target.expectedUrl &&
    receipt.instanceRevision === selection.target.expectedInstanceRevision &&
    receipt.firstSeenAt === selection.target.expectedFirstSeenAt &&
    receipt.canonicalTabId === selection.instance.canonicalTabId
  );
}

export async function executeExactInstanceCapture(
  selection: ExactCaptureCopy,
  execute: ExactCaptureRelayExecutor,
): Promise<ExactCaptureOutcome> {
  if (selection.kind !== "selectable") {
    throw new TabCommandRelayClientError(
      "The selected physical tab is not currently available for capture.",
      { code: "EXTENSION_DISCONNECTED", outcome: "not-sent" },
    );
  }
  const result = await execute({
    ...selection.scope,
    command: { kind: "capture-tab-content", target: selection.target },
  });
  if (
    result.kind !== "capture-tab-content" ||
    !sameTarget(result.target, selection.target) ||
    (result.outcome.status === "captured" &&
      !receiptMatchesSelection(result.outcome.receipt, selection))
  ) {
    throw new TabCommandRelayClientError(
      "TabHub returned a capture receipt for a different physical tab.",
      { code: "INVALID_COMMAND_RECEIPT", outcome: "unknown" },
    );
  }
  return result.outcome;
}
