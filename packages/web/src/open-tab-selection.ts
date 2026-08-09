import type { TabInstance } from "@tabhub/shared";

import type {
  ClosePreviewTarget,
  ExtensionProbe,
  PhysicalTabTarget,
  TabActivationTarget,
} from "./extension-bridge";
import { tabActivationAvailability } from "./open-tab-activation";

export type OpenTabSelection = Map<number, TabInstance>;

export interface ExactCopySelection {
  candidate: TabInstance;
  keeper: TabInstance;
}

export interface ControllableTabSelection {
  tab: TabInstance;
  target: TabActivationTarget;
}

type PhysicalSelectionScope = Pick<
  TabInstance,
  "browser" | "browserSessionId" | "installationId"
>;

export function setSelectedTabs(
  current: OpenTabSelection,
  tabs: readonly TabInstance[],
  selected: boolean,
): OpenTabSelection {
  const next = new Map(current);
  for (const tab of tabs) {
    if (selected) next.set(tab.instanceId, tab);
    else next.delete(tab.instanceId);
  }
  return next;
}

export function controllableSelection(
  selection: OpenTabSelection,
  probe: ExtensionProbe | undefined,
): ControllableTabSelection[] {
  return [...selection.values()].flatMap((tab) => {
    const availability = tabActivationAvailability(tab, probe);
    return availability.kind === "ready"
      ? [{ tab, target: availability.target }]
      : [];
  });
}

export function closePreviewTargetsForSelection(
  controlled: readonly ControllableTabSelection[],
  duplicateKeepers: ReadonlyMap<number, PhysicalTabTarget>,
): ClosePreviewTarget[] {
  return controlled.map(({ tab, target }) => {
    const keeper = duplicateKeepers.get(tab.instanceId);
    return {
      expectedUrl: tab.url,
      tabId: target.tabId,
      ...(keeper === undefined ? {} : { keeper }),
    };
  });
}

export function removeSucceededPhysicalTabs(
  selection: OpenTabSelection,
  scope: PhysicalSelectionScope,
  succeededTabIds: readonly number[],
): OpenTabSelection {
  const succeeded = new Set(succeededTabIds);
  return new Map(
    [...selection].filter(([, tab]) =>
      !(
        tab.browser === scope.browser &&
        tab.browserSessionId === scope.browserSessionId &&
        tab.installationId === scope.installationId &&
        tab.browserTabId !== null &&
        succeeded.has(tab.browserTabId)
      ),
    ),
  );
}

export function reconcileSelectionWithSnapshot(
  selection: OpenTabSelection,
  snapshot: readonly TabInstance[],
): OpenTabSelection {
  const currentById = new Map(snapshot.map((tab) => [tab.instanceId, tab]));
  return new Map(
    [...selection.keys()].flatMap((instanceId) => {
      const current = currentById.get(instanceId);
      return current === undefined ? [] : [[instanceId, current] as const];
    }),
  );
}

function recentFirst(left: TabInstance, right: TabInstance): number {
  const leftAccessed = left.lastAccessed ?? -1;
  const rightAccessed = right.lastAccessed ?? -1;
  return (
    rightAccessed - leftAccessed ||
    left.windowId - right.windowId ||
    left.index - right.index ||
    left.instanceId - right.instanceId
  );
}

/**
 * Return only live close candidates while retaining one exact-URL keeper.
 * Active and pinned copies are protected and are never candidates.
 */
export function extraExactCopyPlan(
  tabs: readonly TabInstance[],
): ExactCopySelection[] {
  const groups = new Map<string, TabInstance[]>();
  for (const tab of tabs) {
    const key = `${tab.browser}\n${tab.installationId}\n${tab.url}`;
    const group = groups.get(key);
    if (group) group.push(tab);
    else groups.set(key, [tab]);
  }

  const plan: ExactCopySelection[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const protectedTabs = group
      .filter((tab) => tab.active || tab.pinned)
      .sort((left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(right.pinned) - Number(left.pinned) ||
        recentFirst(left, right),
      );
    const unprotected = group
      .filter((tab) => !tab.active && !tab.pinned)
      .sort(recentFirst);
    const keeper = protectedTabs[0] ?? unprotected[0];
    if (keeper !== undefined) {
      plan.push(
        ...unprotected
          .filter((tab) => tab !== keeper)
          .map((candidate) => ({ candidate, keeper })),
      );
    }
  }
  return plan;
}

export function extraExactCopyCandidates(
  tabs: readonly TabInstance[],
): TabInstance[] {
  return extraExactCopyPlan(tabs).map(({ candidate }) => candidate);
}

export function tabsOlderThan(
  tabs: readonly TabInstance[],
  days: number,
  now = Date.now(),
): TabInstance[] {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  return tabs.filter(
    (tab) =>
      !tab.active &&
      !tab.pinned &&
      tab.lastAccessed !== null &&
      tab.lastAccessed <= cutoff,
  );
}

export function normalizedHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function tabsFromHostname(
  tabs: readonly TabInstance[],
  hostname: string,
): TabInstance[] {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return [];
  return tabs.filter((tab) => normalizedHostname(tab.url) === normalized);
}

export function tabsInPhysicalOrder(
  tabs: readonly TabInstance[],
): TabInstance[] {
  return [...tabs].sort(
    (left, right) =>
      left.browser.localeCompare(right.browser) ||
      left.installationId.localeCompare(right.installationId) ||
      (left.browserSessionId ?? "").localeCompare(
        right.browserSessionId ?? "",
      ) ||
      left.windowId - right.windowId ||
      left.index - right.index ||
      left.instanceId - right.instanceId,
  );
}
