import type { TabInstance } from "@tabhub/shared";

import type {
  ExtensionProbe,
  TabActivationTarget,
} from "./extension-bridge";

export type TabActivationAvailability =
  | { kind: "ready"; target: TabActivationTarget }
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

export function tabActivationAvailability(
  tab: TabInstance,
  probe: ExtensionProbe | undefined,
): TabActivationAvailability {
  if (tab.browserTabId === null) {
    return {
      kind: "missing-tab-id",
      message: "Waiting for an updated physical-tab snapshot.",
    };
  }
  if (probe === undefined) {
    return {
      kind: "checking",
      message: "Checking the local TabHub extension.",
    };
  }
  if (!probe.available) {
    return {
      kind: "bridge-unavailable",
      message: "Open TabHub in that browser and reload the updated extension to switch tabs.",
    };
  }
  if (probe.browser === null) {
    return {
      kind: "identity-unconfigured",
      message: "Choose this extension's browser identity before switching tabs.",
    };
  }
  if (
    probe.browser !== tab.browser ||
    probe.installationId !== tab.installationId
  ) {
    return {
      kind: "other-installation",
      message: "Open TabHub in the browser profile that owns this tab to switch to it.",
    };
  }
  if (
    tab.browserSessionId === null ||
    probe.browserSessionId !== tab.browserSessionId
  ) {
    return {
      kind: "waiting-for-current-session",
      message: "Waiting for a fresh snapshot from this browser session.",
    };
  }

  return {
    kind: "ready",
    target: {
      browser: tab.browser,
      browserSessionId: tab.browserSessionId,
      installationId: tab.installationId,
      tabId: tab.browserTabId,
    },
  };
}
