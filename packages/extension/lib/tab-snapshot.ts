import type {
  BrowserIdentifier,
  IngestSnapshot,
  SnapshotTab,
} from "@tabhub/shared";
import {
  snapshotTabFaviconUrlMaxLength,
  snapshotTabSchema,
  snapshotTabTitleMaxLength,
} from "@tabhub/shared";

export interface BrowserTabLike {
  active?: boolean | undefined;
  favIconUrl?: string | undefined;
  id?: number | undefined;
  index: number;
  lastAccessed?: number | undefined;
  pendingUrl?: string | undefined;
  pinned?: boolean | undefined;
  title?: string | undefined;
  url?: string | undefined;
  windowId: number;
}

export interface CapturedTabUrl {
  id: number;
  index: number;
  url: string;
  windowId: number;
}

export function toSnapshotTab(tab: BrowserTabLike): SnapshotTab | undefined {
  const url = tab.pendingUrl?.trim() || tab.url?.trim();

  if (!url) {
    return undefined;
  }

  const snapshotTab: SnapshotTab = {
    url,
    windowId: tab.windowId,
    index: tab.index,
  };

  if (tab.title !== undefined) {
    snapshotTab.title = tab.title.slice(0, snapshotTabTitleMaxLength);
  }

  if (Number.isInteger(tab.id) && (tab.id as number) >= 0) {
    snapshotTab.tabId = tab.id as number;
  }

  if (typeof tab.active === "boolean") {
    snapshotTab.active = tab.active;
  }

  if (typeof tab.pinned === "boolean") {
    snapshotTab.pinned = tab.pinned;
  }

  if (
    typeof tab.lastAccessed === "number" &&
    Number.isFinite(tab.lastAccessed) &&
    tab.lastAccessed >= 0
  ) {
    snapshotTab.lastAccessed = tab.lastAccessed;
  }

  if (
    tab.favIconUrl !== undefined &&
    tab.favIconUrl.length <= snapshotTabFaviconUrlMaxLength
  ) {
    snapshotTab.faviconUrl = tab.favIconUrl;
  }

  const parsed = snapshotTabSchema.safeParse(snapshotTab);
  return parsed.success ? parsed.data : undefined;
}

export function buildSnapshot(
  browser: BrowserIdentifier,
  installationId: string,
  tabs: readonly BrowserTabLike[],
): IngestSnapshot {
  return {
    browser,
    installationId,
    tabs: tabs.flatMap((tab) => {
      const snapshotTab = toSnapshotTab(tab);
      return snapshotTab?.tabId === undefined ? [] : [snapshotTab];
    }),
  };
}

export function reconcileCapturedTabUrl(
  snapshot: IngestSnapshot,
  captured: CapturedTabUrl,
  currentTab: BrowserTabLike | undefined,
): boolean {
  const parsed = toSnapshotTab(captured);

  if (
    parsed?.tabId === undefined ||
    currentTab?.id !== parsed.tabId ||
    Boolean(currentTab.pendingUrl?.trim()) ||
    currentTab.url?.trim() !== parsed.url
  ) {
    return false;
  }

  const existingIndex = snapshot.tabs.findIndex(
    ({ tabId }) => tabId === parsed.tabId,
  );

  if (existingIndex === -1) {
    return false;
  }

  const existing = snapshot.tabs[existingIndex];

  if (existing?.url !== parsed.url) {
    return false;
  }

  return true;
}

export function buildIdentityTransitionSnapshots(
  previousBrowser: BrowserIdentifier | undefined,
  nextBrowser: BrowserIdentifier,
  installationId: string,
  tabs: readonly BrowserTabLike[],
): IngestSnapshot[] {
  const snapshots: IngestSnapshot[] = [];

  if (previousBrowser !== undefined && previousBrowser !== nextBrowser) {
    snapshots.push({ browser: previousBrowser, installationId, tabs: [] });
  }

  snapshots.push(buildSnapshot(nextBrowser, installationId, tabs));
  return snapshots;
}
