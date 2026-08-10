import {
  tabCommandScopeSchema,
  type TabCommandRelayHttpRequest,
  type TabCommandRelayResult,
  type TabInstance,
} from "@tabhub/shared";

import {
  ExtensionBridgeError,
  type ExtensionProbe,
  type PhysicalTabScope,
  type TabActivationResult,
  type TabActivationTarget,
} from "./extension-bridge";

export type TabActivationAvailability =
  | {
      kind: "ready";
      route: "direct" | "relay";
      target: TabActivationTarget;
    }
  | {
      kind:
        | "checking"
        | "bridge-unavailable"
        | "identity-unconfigured"
        | "missing-tab-id"
        | "other-installation"
        | "waiting-for-current-session";
      message: string;
    };

export type TabActivationTranslator = (key: string) => string;

export type ReadyTabActivation = Extract<
  TabActivationAvailability,
  { kind: "ready" }
>;

export type CanonicalTabActivationSelection =
  | {
      activation: ReadyTabActivation;
      kind: "ready";
      tab: TabInstance;
    }
  | { kind: "unavailable"; message: string };

export interface CanonicalTabBrowserActionRequest {
  canonicalTabId: number;
  newTabUrlIfConfirmedClosed?: string | undefined;
}

export type CanonicalTabBrowserActionSelection =
  | CanonicalTabActivationSelection
  | { kind: "open-new"; url: string };

export interface TabActivationExecutors {
  direct(target: TabActivationTarget): Promise<TabActivationResult>;
  relay(request: TabCommandRelayHttpRequest): Promise<TabCommandRelayResult>;
}

function translatedMessage(
  t: TabActivationTranslator | undefined,
  key: string,
): string {
  return t?.(key) ?? key;
}

export function tabActivationAvailability(
  tab: TabInstance,
  probe: ExtensionProbe | undefined,
  t?: TabActivationTranslator,
  connectedScopes: readonly PhysicalTabScope[] = [],
): TabActivationAvailability {
  if (tab.browserTabId === null) {
    return {
      kind: "missing-tab-id",
      message: translatedMessage(t, "Waiting for an updated physical-tab snapshot."),
    };
  }
  const targetScope =
    tab.browserSessionId === null
      ? null
      : {
          browser: tab.browser,
          browserSessionId: tab.browserSessionId,
          installationId: tab.installationId,
        };
  const directMatches =
    targetScope !== null &&
    probe?.available === true &&
    probe.browser === targetScope.browser &&
    probe.browserSessionId === targetScope.browserSessionId &&
    probe.installationId === targetScope.installationId;
  const relayMatches =
    targetScope !== null &&
    connectedScopes.some(
      (scope) =>
        scope.browser === targetScope.browser &&
        scope.browserSessionId === targetScope.browserSessionId &&
        scope.installationId === targetScope.installationId,
    );

  if (directMatches || relayMatches) {
    return {
      kind: "ready",
      route: directMatches ? "direct" : "relay",
      target: {
        browser: tab.browser,
        browserSessionId: tab.browserSessionId!,
        installationId: tab.installationId,
        tabId: tab.browserTabId,
      },
    };
  }
  if (probe === undefined) {
    return {
      kind: "checking",
      message: translatedMessage(t, "Checking connected TabHub extensions."),
    };
  }
  if (!probe.available) {
    return {
      kind: "bridge-unavailable",
      message: translatedMessage(
        t,
        "No connected TabHub extension can control this browser profile.",
      ),
    };
  }
  if (probe.browser === null) {
    return {
      kind: "identity-unconfigured",
      message: translatedMessage(
        t,
        "Choose this extension's browser identity before switching tabs.",
      ),
    };
  }
  if (probe.browser !== tab.browser || probe.installationId !== tab.installationId) {
    return {
      kind: "other-installation",
      message: translatedMessage(
        t,
        "This tab's browser profile is not connected.",
      ),
    };
  }
  if (
    tab.browserSessionId === null ||
    probe.browserSessionId !== tab.browserSessionId
  ) {
    return {
      kind: "waiting-for-current-session",
      message: translatedMessage(
        t,
        "Waiting for a fresh snapshot from this browser session.",
      ),
    };
  }

  return {
    kind: "waiting-for-current-session",
    message: translatedMessage(
      t,
      "Waiting for a fresh snapshot from this browser session.",
    ),
  };
}

function candidateRecency(tab: TabInstance): number {
  return tab.lastAccessed ?? Date.parse(tab.lastSeenAt);
}

function compareActivationCandidates(
  left: { activation: ReadyTabActivation; tab: TabInstance },
  right: { activation: ReadyTabActivation; tab: TabInstance },
): number {
  return (
    Number(left.activation.route === "relay") -
      Number(right.activation.route === "relay") ||
    candidateRecency(right.tab) - candidateRecency(left.tab) ||
    Number(right.tab.active) - Number(left.tab.active) ||
    right.tab.instanceId - left.tab.instanceId
  );
}

/**
 * Canonical Library/Graph records can represent several physical copies. Pick
 * one copy that an exact connected browser scope can control, preferring the
 * browser that directly hosts this TabHub page and then the most recently used
 * copy. Never fall back to opening the canonical URL when no copy is reachable.
 */
export function canonicalTabActivationSelection(
  tabs: readonly TabInstance[],
  probe: ExtensionProbe | undefined,
  t?: TabActivationTranslator,
  connectedScopes: readonly PhysicalTabScope[] = [],
): CanonicalTabActivationSelection {
  if (tabs.length === 0) {
    return {
      kind: "unavailable",
      message: translatedMessage(
        t,
        "This tab is no longer open. Refresh the Library and try again.",
      ),
    };
  }

  const ready = tabs
    .map((tab) => ({
      activation: tabActivationAvailability(tab, probe, t, connectedScopes),
      tab,
    }))
    .filter(
      (
        candidate,
      ): candidate is { activation: ReadyTabActivation; tab: TabInstance } =>
        candidate.activation.kind === "ready",
    )
    .sort(compareActivationCandidates);
  const selected = ready[0];
  if (selected !== undefined) {
    return { ...selected, kind: "ready" };
  }

  const representative = [...tabs].sort(
    (left, right) =>
      candidateRecency(right) - candidateRecency(left) ||
      Number(right.active) - Number(left.active) ||
      right.instanceId - left.instanceId,
  )[0]!;
  const unavailable = tabActivationAvailability(
    representative,
    probe,
    t,
    connectedScopes,
  );
  return {
    kind: "unavailable",
    message:
      unavailable.kind === "ready"
        ? translatedMessage(
            t,
            "No connected TabHub extension can control this browser profile.",
          )
        : unavailable.message,
  };
}

/**
 * Even a Library record rendered as closed may have become open in another
 * browser since the list was fetched. Only authorize a new URL tab after the
 * click-time instance lookup confirms that no physical copy currently exists.
 */
export function canonicalTabBrowserActionSelection(
  tabs: readonly TabInstance[],
  request: CanonicalTabBrowserActionRequest,
  probe: ExtensionProbe | undefined,
  t?: TabActivationTranslator,
  connectedScopes: readonly PhysicalTabScope[] = [],
): CanonicalTabBrowserActionSelection {
  if (
    tabs.length === 0 &&
    request.newTabUrlIfConfirmedClosed !== undefined
  ) {
    return { kind: "open-new", url: request.newTabUrlIfConfirmedClosed };
  }

  return canonicalTabActivationSelection(tabs, probe, t, connectedScopes);
}

export async function executeTabActivation(
  activation: ReadyTabActivation,
  executors: TabActivationExecutors,
): Promise<
  TabActivationResult | Extract<TabCommandRelayResult, { kind: "activate-tab" }>
> {
  if (activation.route === "direct") {
    const result = await executors.direct(activation.target);
    if (
      result.browser !== activation.target.browser ||
      result.browserSessionId !== activation.target.browserSessionId ||
      result.installationId !== activation.target.installationId ||
      result.tabId !== activation.target.tabId
    ) {
      throw new ExtensionBridgeError(
        "The extension activated a different physical tab than requested.",
      );
    }
    return result;
  }

  const scope = tabCommandScopeSchema.parse({
    browser: activation.target.browser,
    browserSessionId: activation.target.browserSessionId,
    installationId: activation.target.installationId,
  });
  const result = await executors.relay({
    ...scope,
    command: { kind: "activate-tab", tabId: activation.target.tabId },
  });
  if (result.kind !== "activate-tab" || result.tabId !== activation.target.tabId) {
    throw new ExtensionBridgeError(
      "The extension activated a different physical tab than requested.",
    );
  }
  return result;
}
