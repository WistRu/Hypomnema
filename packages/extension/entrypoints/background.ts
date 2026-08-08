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
  appendPendingItems,
  compactPendingQueue,
  createPendingContent,
  createPendingSnapshot,
  drainPendingQueue,
  errorMessage,
  summarizePendingItems,
  type DrainQueueResult,
  type PendingItem,
} from "../lib/queue";
import {
  getBrowserIdentifier,
  readQueueState,
  writeIdentityAndQueueState,
  writeQueueState,
  type KnownBrowser,
} from "../lib/storage";
import {
  buildIdentityTransitionSnapshots,
  buildSnapshot,
} from "../lib/tab-snapshot";

const IDENTITY_REQUIRED_ERROR =
  "Choose this extension's browser identity in Browser settings before synchronizing tabs.";

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
  const state = await readQueueState();
  const pending = compactPendingQueue(state.pending);

  // Rewrite parsed/compacted state first so invalid legacy records and
  // duplicate snapshots do not survive indefinitely while the server is down.
  await writeQueueState(pending, state.deadLetters);
  return drainPendingQueue(
    pending,
    sendPendingItem,
    writeQueueState,
    undefined,
    state.deadLetters,
  );
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
  const state = await readQueueState();
  const pending = appendPendingItems(state.pending, items);

  // Write before attempting HTTP so a terminated MV3 worker cannot lose work.
  await writeQueueState(pending, state.deadLetters);
  return drainPendingQueue(
    pending,
    sendPendingItem,
    writeQueueState,
    undefined,
    state.deadLetters,
  );
}

function captureAndSync(
  requireConfigured = false,
): Promise<DrainQueueResult | undefined> {
  return serializeSync(async () => {
    const browserIdentifier = await getBrowserIdentifier();

    if (browserIdentifier === undefined) {
      if (requireConfigured) {
        throw new Error(IDENTITY_REQUIRED_ERROR);
      }

      return undefined;
    }

    const tabs = await browser.tabs.query({});
    const snapshot = buildSnapshot(browserIdentifier, tabs);
    return appendAndFlushUnlocked([createPendingSnapshot(snapshot)]);
  });
}

function changeBrowserIdentity(
  nextBrowser: KnownBrowser,
): Promise<DrainQueueResult> {
  return serializeSync(async () => {
    const [previousBrowser, tabs, state] = await Promise.all([
      getBrowserIdentifier(),
      browser.tabs.query({}),
      readQueueState(),
    ]);
    const transition = buildIdentityTransitionSnapshots(
      previousBrowser,
      nextBrowser,
      tabs,
    ).map((snapshot) => createPendingSnapshot(snapshot));
    const pending = appendPendingItems(state.pending, transition);

    // Browser identity and both ordered snapshots become durable atomically.
    await writeIdentityAndQueueState(
      nextBrowser,
      pending,
      state.deadLetters,
    );
    return drainPendingQueue(
      pending,
      sendPendingItem,
      writeQueueState,
      undefined,
      state.deadLetters,
    );
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

async function captureContentUnlocked(
  mode: "current" | "all",
): Promise<ExtensionResponse> {
  const browserIdentifier = await getBrowserIdentifier();

  if (browserIdentifier === undefined) {
    throw new Error(IDENTITY_REQUIRED_ERROR);
  }

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

  const currentTabs = await browser.tabs.query({});
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
  const drainResult = await appendAndFlushUnlocked([
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

function captureContent(
  mode: "current" | "all",
): Promise<ExtensionResponse> {
  return serializeSync(() => captureContentUnlocked(mode));
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

  const [serverReachable, state, browserIdentifier] = await Promise.all([
    isServerReachable(),
    readQueueState(),
    getBrowserIdentifier(),
  ]);
  const queueSummary = summarizePendingItems(state.pending);
  const pendingErrors = state.pending.flatMap((item) =>
    item.lastError === undefined
      ? []
      : [
          {
            error: item.lastError,
            timestamp: item.lastAttemptAt ?? item.createdAt,
          },
        ],
  );
  const deadLetterErrors = state.deadLetters.map((item) => ({
    error: `Discarded unsendable ${item.kind}: ${item.error}`,
    timestamp: item.failedAt,
  }));
  const latestError = [...pendingErrors, ...deadLetterErrors]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1)?.error;
  const status: ExtensionStatus = {
    browserConfigured: browserIdentifier !== undefined,
    deadLetterCount: state.deadLetters.length,
    pendingOperationCount: queueSummary.pendingOperationCount,
    pendingTabCount: queueSummary.pendingTabCount,
    serverReachable,
  };

  if (latestError !== undefined) {
    status.lastError = latestError;
  }

  return status;
}

async function handleSnapshotNow(): Promise<ExtensionResponse> {
  try {
    await captureAndSync(true);
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
        await changeBrowserIdentity(message.browser);
        return { ok: true, status: await getStatus() };
    }
  } catch (error) {
    let status: ExtensionStatus;

    try {
      status = await getStatus();
    } catch {
      status = {
        browserConfigured: false,
        deadLetterCount: 0,
        pendingOperationCount: 0,
        pendingTabCount: 0,
        serverReachable: false,
      };
    }

    return {
      error: errorMessage(error),
      ok: false,
      status,
    };
  }
}

async function initializeWorker(): Promise<void> {
  await ensureAlarms();
  await flushPending();
}

export default defineBackground(() => {
  void initializeWorker().catch((error: unknown) => {
    console.error("TabHub background initialization failed", error);
  });

  browser.runtime.onInstalled.addListener((details) => {
    void (async () => {
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
