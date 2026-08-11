import {
  tabCommandScopeSchema,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";

import type { PhysicalTabTarget } from "./extension-bridge";
import {
  addressedCloseSelection,
  type AddressedCloseSelection,
} from "./open-tab-close-routing";
import type { OpenTabSelection } from "./open-tab-selection";

export interface LibraryPhysicalClosePlan {
  keepers: Map<number, PhysicalTabTarget>;
  protectedSelectedCount: number;
  selection: OpenTabSelection;
}

export interface AddressedLibraryPhysicalClosePlan {
  batches: AddressedCloseSelection[];
  blockedSelectedCount: number;
  closeableCount: number;
  protectedSelectedCount: number;
}

function exactCopyKey(tab: TabInstance): string {
  return JSON.stringify([
    tab.browser,
    tab.installationId,
    tab.browserSessionId,
    tab.url,
  ]);
}

function recentFirst(left: TabInstance, right: TabInstance): number {
  return (
    Number(right.active) - Number(left.active) ||
    (right.lastAccessed ?? -1) - (left.lastAccessed ?? -1) ||
    left.windowId - right.windowId ||
    left.index - right.index ||
    left.instanceId - right.instanceId
  );
}

function preferredKeeper(tabs: readonly TabInstance[]): TabInstance | null {
  const controllable = tabs.filter(({ browserTabId }) => browserTabId !== null);
  const pinned = controllable.filter(({ pinned }) => pinned).sort(recentFirst);
  return pinned[0] ?? controllable.sort(recentFirst)[0] ?? null;
}

/**
 * Plan a destructive Library close from exact physical identities. When the
 * selection contains every live exact-URL copy, one copy is retained and is
 * attached as the explicit keeper for every remaining close target.
 */
export function planLibraryPhysicalClose(
  selection: ReadonlyMap<number, TabInstance>,
  snapshot: readonly TabInstance[],
): LibraryPhysicalClosePlan {
  const snapshotGroups = new Map<string, TabInstance[]>();
  for (const tab of snapshot) {
    const key = exactCopyKey(tab);
    const group = snapshotGroups.get(key);
    if (group === undefined) snapshotGroups.set(key, [tab]);
    else group.push(tab);
  }

  const plannedSelection: OpenTabSelection = new Map(selection);
  const keepers = new Map<number, PhysicalTabTarget>();
  let protectedSelectedCount = 0;

  for (const group of snapshotGroups.values()) {
    if (group.length < 2) continue;
    const selected = group.filter(({ instanceId }) => selection.has(instanceId));
    if (selected.length === 0) continue;
    const unselected = group.filter(({ instanceId }) => !selection.has(instanceId));
    const keeper = preferredKeeper(unselected) ?? preferredKeeper(group);
    if (keeper === null || keeper.browserTabId === null) continue;

    if (plannedSelection.delete(keeper.instanceId)) protectedSelectedCount += 1;
    for (const candidate of selected) {
      if (
        candidate.instanceId !== keeper.instanceId &&
        candidate.browserTabId !== null
      ) {
        keepers.set(candidate.instanceId, {
          expectedUrl: keeper.url,
          tabId: keeper.browserTabId,
        });
      }
    }
  }

  return { keepers, protectedSelectedCount, selection: plannedSelection };
}

/**
 * Split one Library selection into independently revalidated browser-profile
 * batches. A disconnected or malformed scope is excluded as a whole while
 * connected scopes remain previewable; no command ever crosses a scope.
 */
export function planAddressedLibraryPhysicalClose(
  selection: ReadonlyMap<number, TabInstance>,
  snapshot: readonly TabInstance[],
  availableScopes: readonly TabCommandScope[],
): AddressedLibraryPhysicalClosePlan {
  const safety = planLibraryPhysicalClose(selection, snapshot);
  const selectionsByScope = new Map<string, OpenTabSelection>();
  let blockedSelectedCount = 0;

  for (const instance of safety.selection.values()) {
    const parsed = tabCommandScopeSchema.safeParse({
      browser: instance.browser,
      browserSessionId: instance.browserSessionId,
      installationId: instance.installationId,
    });
    if (!parsed.success) {
      blockedSelectedCount += 1;
      continue;
    }
    const scopeKey = JSON.stringify([
      parsed.data.browser,
      parsed.data.installationId,
      parsed.data.browserSessionId,
    ]);
    const scopedSelection = selectionsByScope.get(scopeKey) ?? new Map();
    scopedSelection.set(instance.instanceId, instance);
    selectionsByScope.set(scopeKey, scopedSelection);
  }

  const batches: AddressedCloseSelection[] = [];
  for (const scopedSelection of selectionsByScope.values()) {
    const batch = addressedCloseSelection(
      scopedSelection,
      safety.keepers,
      availableScopes,
    );
    if (batch === null) blockedSelectedCount += scopedSelection.size;
    else batches.push(batch);
  }

  return {
    batches,
    blockedSelectedCount,
    closeableCount: batches.reduce(
      (total, batch) => total + batch.targets.length,
      0,
    ),
    protectedSelectedCount: safety.protectedSelectedCount,
  };
}
