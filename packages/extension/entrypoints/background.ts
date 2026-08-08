import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { isServerReachable, postContent, postSnapshot } from "../lib/api";
import {
  EXTRACT_CONTENT_SCRIPT_FILE,
  RETRY_ALARM_NAME,
  RETRY_INTERVAL_MINUTES,
  SNAPSHOT_ALARM_NAME,
  SNAPSHOT_INTERVAL_MINUTES,
  TAB_EVENT_DEBOUNCE_MS,
} from "../lib/constants";
import {
  captureEligibleTabs,
  type CaptureBatchResult,
} from "../lib/content-capture";
import {
  isExtensionRequest,
  type CaptureSummary,
  type ExtensionResponse,
  type ExtensionStatus,
} from "../lib/messages";
import {
  createPendingContent,
  createPendingSnapshot,
  drainPendingQueue,
  errorMessage,
  type DrainQueueResult,
  type PendingItem,
} from "../lib/queue";
import {
  ensureBrowserIdentifier,
  getBrowserIdentifier,
  readPendingItems,
  writePendingItems,
} from "../lib/storage";
import { buildSnapshot } from "../lib/tab-snapshot";

let syncTail: Promise<void> = Promise.resolve();
let tabEventTimer: ReturnType<typeof setTimeout> | undefined;

function serializeSync<T>(operation: () => Promise<T>): Promise<T> {
  const result = syncTail.then(operation, operation);
  syncTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function flushPendingUnlocked(): Promise<DrainQueueResult> {
  const pending = await readPendingItems();
  return drainPendingQueue(pending, sendPendingItem, writePendingItems);
}

function flushPending(): Promise<DrainQueueResult> {
  return serializeSync(flushPendingUnlocked);
}

async function sendPendingItem(item: PendingItem): Promise<void> {
  if (item.kind === "snapshot") {
    await postSnapshot(item.payload);
  } else {
    await postContent(item.payload);
  }
}

async function appendAndFlushUnlocked(
  items: readonly PendingItem[],
): Promise<DrainQueueResult> {
  const pending = await readPendingItems();
  pending.push(...items);

  // Write before attempting HTTP so a terminated MV3 worker cannot lose work.
  await writePendingItems(pending);
  return drainPendingQueue(pending, sendPendingItem, writePendingItems);
}

function appendAndFlush(items: readonly PendingItem[]): Promise<DrainQueueResult> {
  return serializeSync(() => appendAndFlushUnlocked(items));
}

function captureAndSync(): Promise<DrainQueueResult> {
  return serializeSync(async () => {
    const [browserIdentifier, tabs] = await Promise.all([
      getBrowserIdentifier(),
      browser.tabs.query({}),
    ]);
    const snapshot = buildSnapshot(browserIdentifier, tabs);
    return appendAndFlushUnlocked([createPendingSnapshot(snapshot)]);
  });
}

async function extractTabContent(tabId: number): Promise<unknown> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    files: [EXTRACT_CONTENT_SCRIPT_FILE],
  });

  return results[0]?.result;
}

function addCapturedUrlsToSnapshot(
  snapshot: ReturnType<typeof buildSnapshot>,
  capture: CaptureBatchResult,
): void {
  const urls = new Set(snapshot.tabs.map(({ url }) => url));

  for (const { page, tab } of capture.captured) {
    if (urls.has(page.url)) {
      continue;
    }

    snapshot.tabs.push({
      index: tab.index,
      url: page.url,
      windowId: tab.windowId,
    });
    urls.add(page.url);
  }
}

async function captureContent(
  mode: "current" | "all",
): Promise<ExtensionResponse> {
  const selectedTabs = await browser.tabs.query(
    mode === "current" ? { active: true, currentWindow: true } : {},
  );
  const capture = await captureEligibleTabs(selectedTabs, extractTabContent);
  const baseSummary: CaptureSummary = {
    captured: capture.captured.length,
    queued: 0,
    requested: capture.requested,
    skipped: capture.skipped,
  };

  if (capture.captured.length === 0) {
    return {
      capture: baseSummary,
      ok: true,
      status: await getStatus(),
    };
  }

  const [browserIdentifier, currentTabs] = await Promise.all([
    getBrowserIdentifier(),
    browser.tabs.query({}),
  ]);
  const snapshot = buildSnapshot(browserIdentifier, currentTabs);
  addCapturedUrlsToSnapshot(snapshot, capture);
  const contentItems = capture.captured.map(({ page }) =>
    createPendingContent({
      browser: browserIdentifier,
      htmlExcerpt: page.htmlExcerpt,
      text: page.text,
      url: page.url,
    }),
  );
  const contentIds = new Set(contentItems.map(({ id }) => id));
  const drainResult = await appendAndFlush([
    createPendingSnapshot(snapshot),
    ...contentItems,
  ]);
  const summary: CaptureSummary = {
    ...baseSummary,
    queued: drainResult.remaining.filter(({ id }) => contentIds.has(id)).length,
  };

  return {
    capture: summary,
    ok: true,
    status: await getStatus(),
  };
}

async function ensureAlarm(
  name: string,
  periodInMinutes: number,
): Promise<void> {
  const alarm = await browser.alarms.get(name);

  if (alarm?.periodInMinutes === periodInMinutes) {
    return;
  }

  await browser.alarms.create(name, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
}

async function ensureAlarms(): Promise<void> {
  await Promise.all([
    ensureAlarm(SNAPSHOT_ALARM_NAME, SNAPSHOT_INTERVAL_MINUTES),
    ensureAlarm(RETRY_ALARM_NAME, RETRY_INTERVAL_MINUTES),
  ]);
}

function scheduleTabEventSnapshot(): void {
  if (tabEventTimer !== undefined) {
    clearTimeout(tabEventTimer);
  }

  tabEventTimer = setTimeout(() => {
    tabEventTimer = undefined;
    void captureAndSync().catch((error: unknown) => {
      console.error("TabHub tab-event snapshot failed", error);
    });
  }, TAB_EVENT_DEBOUNCE_MS);
}

async function getStatus(retryPending = false): Promise<ExtensionStatus> {
  if (retryPending) {
    await flushPending();
  }

  const [serverReachable, pending] = await Promise.all([
    isServerReachable(),
    readPendingItems(),
  ]);
  const lastError = pending[0]?.lastError;
  const status: ExtensionStatus = {
    pendingCount: pending.length,
    serverReachable,
  };

  if (lastError !== undefined) {
    status.lastError = lastError;
  }

  return status;
}

async function handleSnapshotNow(): Promise<ExtensionResponse> {
  try {
    await captureAndSync();
    return { ok: true, status: await getStatus() };
  } catch (error) {
    return {
      error: errorMessage(error),
      ok: false,
      status: await getStatus(),
    };
  }
}

async function handleMessage(message: unknown): Promise<ExtensionResponse | void> {
  if (!isExtensionRequest(message)) {
    return;
  }

  try {
    switch (message.type) {
      case "tabhub:get-status":
        return { ok: true, status: await getStatus(true) };
      case "tabhub:snapshot-now":
        return handleSnapshotNow();
      case "tabhub:capture-current":
        return captureContent("current");
      case "tabhub:capture-all":
        return captureContent("all");
      case "tabhub:browser-changed":
        scheduleTabEventSnapshot();
        return { ok: true, status: await getStatus() };
    }
  } catch (error) {
    return {
      error: errorMessage(error),
      ok: false,
      status: {
        pendingCount: 0,
        serverReachable: false,
      },
    };
  }
}

async function initializeWorker(): Promise<void> {
  await ensureBrowserIdentifier();
  await ensureAlarms();
  await flushPending();
}

export default defineBackground(() => {
  void initializeWorker().catch((error: unknown) => {
    console.error("TabHub background initialization failed", error);
  });

  browser.runtime.onInstalled.addListener((details) => {
    void (async () => {
      await ensureBrowserIdentifier();
      await ensureAlarms();

      if (details.reason === "install") {
        await browser.runtime.openOptionsPage();
      }
    })().catch((error: unknown) => {
      console.error("TabHub installation setup failed", error);
    });
  });

  browser.runtime.onStartup.addListener(() => {
    void (async () => {
      await ensureAlarms();
      await captureAndSync();
    })().catch((error: unknown) => {
      console.error("TabHub startup snapshot failed", error);
    });
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SNAPSHOT_ALARM_NAME) {
      void captureAndSync().catch((error: unknown) => {
        console.error("TabHub periodic snapshot failed", error);
      });
    } else if (alarm.name === RETRY_ALARM_NAME) {
      void flushPending().catch((error: unknown) => {
        console.error("TabHub pending item retry failed", error);
      });
    }
  });

  browser.tabs.onCreated.addListener(scheduleTabEventSnapshot);
  browser.tabs.onUpdated.addListener(scheduleTabEventSnapshot);
  browser.tabs.onRemoved.addListener(scheduleTabEventSnapshot);

  browser.runtime.onMessage.addListener(handleMessage);
});
