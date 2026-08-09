import {
  tabCommandScopeSchema,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";

import type {
  ClosePreviewTarget,
  PhysicalTabTarget,
} from "./extension-bridge";
import type { OpenTabSelection } from "./open-tab-selection";

export interface AddressedCloseSelection {
  scope: TabCommandScope;
  targets: ClosePreviewTarget[];
}

function sameScope(left: TabCommandScope, right: TabCommandScope): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function tabScope(tab: TabInstance): TabCommandScope | null {
  if (tab.browserSessionId === null) return null;
  const parsed = tabCommandScopeSchema.safeParse({
    browser: tab.browser,
    browserSessionId: tab.browserSessionId,
    installationId: tab.installationId,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Build one addressed close request only when every selected physical tab is
 * owned by the same currently connected extension session. Mixed-session
 * closes are intentionally not treated as one atomic action.
 */
export function addressedCloseSelection(
  selection: OpenTabSelection,
  keepers: ReadonlyMap<number, PhysicalTabTarget>,
  availableScopes: readonly TabCommandScope[],
): AddressedCloseSelection | null {
  const tabs = [...selection.values()];
  const scope = tabs[0] === undefined ? null : tabScope(tabs[0]);
  if (
    scope === null ||
    !availableScopes.some((available) => sameScope(scope, available))
  ) {
    return null;
  }

  const targets = tabs.flatMap((tab): ClosePreviewTarget[] => {
    const currentScope = tabScope(tab);
    if (
      currentScope === null ||
      !sameScope(scope, currentScope) ||
      tab.browserTabId === null
    ) {
      return [];
    }
    const keeper = keepers.get(tab.instanceId);
    return [
      {
        expectedUrl: tab.url,
        tabId: tab.browserTabId,
        ...(keeper === undefined ? {} : { keeper }),
      },
    ];
  });
  if (targets.length !== tabs.length) return null;

  const targetIds = new Set(targets.map(({ tabId }) => tabId));
  if (targetIds.size !== targets.length) return null;
  if (
    targets.some(
      ({ expectedUrl, keeper, tabId }) =>
        keeper !== undefined &&
        (keeper.tabId === tabId ||
          targetIds.has(keeper.tabId) ||
          keeper.expectedUrl !== expectedUrl),
    )
  ) {
    return null;
  }

  return { scope, targets };
}
