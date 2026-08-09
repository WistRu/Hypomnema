import type { TabInstance } from "@tabhub/shared";

import type {
  ExtensionProbe,
  PhysicalTabScope,
  TabActivationTarget,
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
