import {
  tabCommandRelayCommandSchema,
  tabCommandScopeSchema,
  type TabCommandRelayCommand,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";

import type { PhysicalTabTarget, TabCommand } from "./extension-bridge";
import type { OpenTabSelection } from "./open-tab-selection";

export type TabCommandRoute = "direct" | "relay";

interface TabCommandScopeIdentity {
  browser: string;
  browserSessionId: string;
  installationId: string;
}

export interface ReadyAddressedTabSelection {
  kind: "ready";
  route: TabCommandRoute;
  scope: TabCommandScope;
  tabs: TabInstance[];
  targets: PhysicalTabTarget[];
}

export type AddressedTabSelection =
  | ReadyAddressedTabSelection
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "mixed-scopes" }
  | { kind: "offline"; scope: TabCommandScope };

export function sameTabCommandScope(
  left: TabCommandScopeIdentity | null,
  right: TabCommandScopeIdentity,
): boolean {
  return (
    left !== null &&
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function scopeForTab(tab: TabInstance): TabCommandScope | null {
  if (tab.browserSessionId === null) return null;
  const parsed = tabCommandScopeSchema.safeParse({
    browser: tab.browser,
    browserSessionId: tab.browserSessionId,
    installationId: tab.installationId,
  });
  return parsed.success ? parsed.data : null;
}

export function addressedTabSelection(
  selection: OpenTabSelection,
  directScope: TabCommandScope | null,
  connectedScopes: readonly TabCommandScope[],
): AddressedTabSelection {
  const tabs = [...selection.values()];
  if (tabs.length === 0) return { kind: "empty" };

  const scope = scopeForTab(tabs[0]!);
  if (scope === null) return { kind: "invalid" };
  const targets: PhysicalTabTarget[] = [];
  const browserTabIds = new Set<number>();
  for (const tab of tabs) {
    const currentScope = scopeForTab(tab);
    if (currentScope === null || tab.browserTabId === null) {
      return { kind: "invalid" };
    }
    if (!sameTabCommandScope(scope, currentScope)) {
      return { kind: "mixed-scopes" };
    }
    if (browserTabIds.has(tab.browserTabId)) {
      return { kind: "invalid" };
    }
    browserTabIds.add(tab.browserTabId);
    targets.push({ expectedUrl: tab.url, tabId: tab.browserTabId });
  }

  if (sameTabCommandScope(directScope, scope)) {
    return { kind: "ready", route: "direct", scope, tabs, targets };
  }
  if (connectedScopes.some((candidate) => sameTabCommandScope(candidate, scope))) {
    return { kind: "ready", route: "relay", scope, tabs, targets };
  }
  return { kind: "offline", scope };
}

export function relayedPhysicalCommand(
  command: TabCommand,
): TabCommandRelayCommand | null {
  const parsed = tabCommandRelayCommandSchema.safeParse(command);
  return parsed.success ? parsed.data : null;
}
