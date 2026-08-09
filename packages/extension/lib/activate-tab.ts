export interface ActivatableTab {
  id?: number | undefined;
  windowId: number;
}

export interface ActivatableWindow {
  state?: string | undefined;
}

export interface TabActivationAdapter {
  activate(tabId: number): Promise<ActivatableTab | undefined>;
  focusWindow(windowId: number): Promise<void>;
  get(tabId: number): Promise<ActivatableTab>;
  getWindow(windowId: number): Promise<ActivatableWindow>;
  restoreWindow(windowId: number): Promise<void>;
}

export interface TabActivationResult {
  tabId: number;
  windowId: number;
}

export interface TabActivationScope {
  browser: string;
  browserSessionId: string;
  installationId: string;
}

export interface ScopedTabActivationTarget extends TabActivationScope {
  tabId: number;
}

function isLiveTab(
  tab: ActivatableTab | undefined,
  tabId: number,
): tab is ActivatableTab {
  return (
    tab !== undefined &&
    tab.id === tabId &&
    Number.isInteger(tab.windowId) &&
    tab.windowId >= 0
  );
}

/**
 * Native tab identity, rather than URL, is the stable physical target. A tab
 * remains the same tab while it navigates, so switching must follow its live
 * window instead of rejecting a stale snapshot URL or position.
 */
export async function activateExistingTab(
  adapter: TabActivationAdapter,
  tabId: number,
): Promise<TabActivationResult> {
  const current = await adapter.get(tabId);
  if (!isLiveTab(current, tabId)) {
    throw new Error(
      "That browser tab is no longer available. Refresh Open tabs and try again.",
    );
  }

  const activated = await adapter.activate(tabId);
  if (!isLiveTab(activated, tabId)) {
    throw new Error("That browser tab changed while TabHub was switching to it.");
  }

  const window = await adapter.getWindow(activated.windowId);
  if (window.state === "minimized") {
    await adapter.restoreWindow(activated.windowId);
  }
  await adapter.focusWindow(activated.windowId);

  return { tabId, windowId: activated.windowId };
}

export async function activateTabForScope(
  adapter: TabActivationAdapter,
  currentScope: TabActivationScope,
  target: ScopedTabActivationTarget,
): Promise<TabActivationResult> {
  if (
    target.browser !== currentScope.browser ||
    target.browserSessionId !== currentScope.browserSessionId ||
    target.installationId !== currentScope.installationId
  ) {
    throw new Error(
      "That tab belongs to a different browser installation or session. Open TabHub in that browser and try again.",
    );
  }

  return activateExistingTab(adapter, target.tabId);
}
