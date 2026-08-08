import type {
  BrowserIdentifier,
  IngestSnapshot,
  SnapshotTab,
} from "@tabhub/shared";

export interface BrowserTabLike {
  favIconUrl?: string | undefined;
  index: number;
  title?: string | undefined;
  url?: string | undefined;
  windowId: number;
}

export function toSnapshotTab(tab: BrowserTabLike): SnapshotTab | undefined {
  const url = tab.url?.trim();

  if (!url) {
    return undefined;
  }

  const snapshotTab: SnapshotTab = {
    url,
    windowId: tab.windowId,
    index: tab.index,
  };

  if (tab.title !== undefined) {
    snapshotTab.title = tab.title;
  }

  if (tab.favIconUrl !== undefined) {
    snapshotTab.faviconUrl = tab.favIconUrl;
  }

  return snapshotTab;
}

export function buildSnapshot(
  browser: BrowserIdentifier,
  tabs: readonly BrowserTabLike[],
): IngestSnapshot {
  return {
    browser,
    tabs: tabs.flatMap((tab) => {
      const snapshotTab = toSnapshotTab(tab);
      return snapshotTab === undefined ? [] : [snapshotTab];
    }),
  };
}

export function buildIdentityTransitionSnapshots(
  previousBrowser: BrowserIdentifier | undefined,
  nextBrowser: BrowserIdentifier,
  tabs: readonly BrowserTabLike[],
): IngestSnapshot[] {
  const snapshots: IngestSnapshot[] = [];

  if (previousBrowser !== undefined && previousBrowser !== nextBrowser) {
    snapshots.push({ browser: previousBrowser, tabs: [] });
  }

  snapshots.push(buildSnapshot(nextBrowser, tabs));
  return snapshots;
}
