import {
  tabCommandRelayResultSchema,
  type TabCommandRelayCommand,
  type TabCommandRelayResult,
  type TabCommandScope,
} from "@tabhub/shared";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { isServerReachable, postContent, postSnapshot } from "../lib/api";
import { createActivationSequencer } from "../lib/activation-sequencer";
import {
  activateTabForScope,
  type TabActivationAdapter,
} from "../lib/activate-tab";
import {
  readBrowserState,
  type BrowserStateSource,
} from "../lib/browser-state";
import {
  EXTRACT_CONTENT_SCRIPT_FILE,
  RETRY_ALARM_NAME,
  RETRY_INTERVAL_MINUTES,
  SNAPSHOT_ALARM_NAME,
  SNAPSHOT_INTERVAL_MINUTES,
  TAB_EVENT_DEBOUNCE_MS,
  TAB_COMMAND_RELAY_WEBSOCKET_ENDPOINT,
} from "../lib/constants";
import {
  captureEligibleTabs,
  type CaptureBatchResult,
} from "../lib/content-capture";
import {
  directAppTabCommandContext,
  isAllowedAppMessageSender,
  isExtensionRequest,
  protectedAppPageTabIds,
  type AppExtensionResponse,
  type BridgeRequestType,
  type CaptureSummary,
  type ExtensionResponse,
  type ExtensionRequest,
  type ExtensionStatus,
} from "../lib/messages";
import {
  createPhysicalTabCommandExecutor,
  parsePhysicalTabCommand,
  type PhysicalTabCommandAdapter,
} from "../lib/physical-tab-commands";
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
  getOrCreateBrowserSessionId,
  getOrCreateInstallationId,
  readQueueState,
  writeIdentityAndQueueState,
  writeQueueState,
  type KnownBrowser,
} from "../lib/storage";
import { registerTabEventSnapshots } from "../lib/tab-event-snapshots";
import {
  createBrowserTabCommandRelaySocket,
  createTabCommandRelayAgent,
} from "../lib/tab-command-relay-agent";
import {
  buildIdentityTransitionSnapshots,
  buildSnapshot,
  reconcileCapturedTabUrl,
  type BrowserTabLike,
} from "../lib/tab-snapshot";

const IDENTITY_REQUIRED_ERROR =
  "Choose this extension's browser identity in Browser settings before synchronizing tabs.";

let syncTail: Promise<void> = Promise.resolve();
let tabEventTimer: ReturnType<typeof setTimeout> | undefined;
const tabCommandSequencer = createActivationSequencer();

const tabActivationAdapter: TabActivationAdapter = {
  activate: (tabId) => browser.tabs.update(tabId, { active: true }),
  focusWindow: async (windowId) => {
    await browser.windows.update(windowId, { focused: true });
  },
  get: (tabId) => browser.tabs.get(tabId),
  getWindow: (windowId) => browser.windows.get(windowId),
  restoreWindow: async (windowId) => {
    await browser.windows.update(windowId, { state: "normal" });
  },
};
const physicalTabCommandAdapter: PhysicalTabCommandAdapter = {
  createTab: (properties) =>
    browser.tabs.create(
      properties as Parameters<typeof browser.tabs.create>[0],
    ),
  createWindow: (properties) =>
    browser.windows.create(
      properties as Parameters<typeof browser.windows.create>[0],
    ),
  discardTab: (tabId) => browser.tabs.discard(tabId),
  getTab: (tabId) => browser.tabs.get(tabId),
  getWindow: (windowId) => browser.windows.get(windowId),
  listWindows: () =>
    browser.windows.getAll({ populate: true, windowTypes: ["normal"] }),
  moveTabs: (tabIds, properties) =>
    Array.isArray(tabIds)
      ? browser.tabs.move(tabIds, properties)
      : browser.tabs.move(tabIds, properties),
  reloadTab: (tabId, properties) =>
    properties === undefined
      ? browser.tabs.reload(tabId)
      : browser.tabs.reload(tabId, properties),
  removeTab: (tabId) => browser.tabs.remove(tabId),
  updateTab: (tabId, properties) => browser.tabs.update(tabId, properties),
};
const physicalTabCommandExecutor = createPhysicalTabCommandExecutor({
  adapter: physicalTabCommandAdapter,
  storage: {
    get: (key) => browser.storage.session.get(key),
    remove: (key) => browser.storage.session.remove(key),
    set: (items) => browser.storage.session.set(items),
  },
});
const browserStateSource: BrowserStateSource = {
  listPendingUndos: (scope) =>
    physicalTabCommandExecutor.listPendingUndos(scope),
  listWindows: () => physicalTabCommandExecutor.listWindows(),
};
const tabCommandRelayAgent = createTabCommandRelayAgent({
  createSocket: createBrowserTabCommandRelaySocket,
  execute: executeRelayedTabCommand,
  getScope: currentTabCommandScope,
  relayUrl: TAB_COMMAND_RELAY_WEBSOCKET_ENDPOINT,
  sequenceLiveCommand: (operation) => tabCommandSequencer.run(operation),
  storage: {
    get: (key) => browser.storage.session.get(key),
    set: (items) => browser.storage.session.set(items),
  },
  onError: (error) => console.error("TabHub command relay failed", error),
});

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

async function captureAndSyncUnlocked(
  requireConfigured = false,
): Promise<DrainQueueResult | undefined> {
  const [browserIdentifier, installationId, browserSessionId] =
    await Promise.all([
      getBrowserIdentifier(),
      getOrCreateInstallationId(),
      getOrCreateBrowserSessionId(),
    ]);

  if (browserIdentifier === undefined) {
    if (requireConfigured) {
      throw new Error(IDENTITY_REQUIRED_ERROR);
    }

    return undefined;
  }

  const tabs = await browser.tabs.query({});
  const snapshot = buildSnapshot(
    browserIdentifier,
    installationId,
    browserSessionId,
    tabs,
  );
  return appendAndFlushUnlocked([createPendingSnapshot(snapshot)]);
}

function captureAndSync(
  requireConfigured = false,
): Promise<DrainQueueResult | undefined> {
  return serializeSync(() => captureAndSyncUnlocked(requireConfigured));
}

async function currentTabCommandScope(): Promise<
  TabCommandScope | undefined
> {
  const browserIdentifier = await getBrowserIdentifier();
  if (browserIdentifier === undefined) return undefined;
  const [installationId, browserSessionId] = await Promise.all([
    getOrCreateInstallationId(),
    getOrCreateBrowserSessionId(),
  ]);
  return {
    browser: browserIdentifier,
    browserSessionId,
    installationId,
  };
}

function sameTabCommandScope(
  left: TabCommandScope,
  right: TabCommandScope,
): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function currentBrowserState(scope: TabCommandScope | undefined) {
  // This is a read-only, point-in-time view. Keeping it outside the physical
  // mutation queue prevents a long workspace/close operation from making the
  // relay's short state timeout expire before the read even starts.
  return readBrowserState(browserStateSource, scope);
}

async function executeRelayedTabCommand(
  requestedScope: TabCommandScope,
  relayCommand: TabCommandRelayCommand,
): Promise<TabCommandRelayResult> {
  if (relayCommand.kind === "get-browser-state") {
    const currentScope = await currentTabCommandScope();
    if (currentScope === undefined) {
      throw new Error(IDENTITY_REQUIRED_ERROR);
    }
    if (!sameTabCommandScope(currentScope, requestedScope)) {
      throw new Error(
        "That command belongs to a different browser installation or session.",
      );
    }
    return tabCommandRelayResultSchema.parse({
      kind: "get-browser-state",
      ...(await currentBrowserState(currentScope)),
    });
  }

  if (relayCommand.kind === "activate-tab") {
    const currentScope = await currentTabCommandScope();
    if (currentScope === undefined) {
      throw new Error(IDENTITY_REQUIRED_ERROR);
    }
    try {
      const result = await activateTabForScope(
        tabActivationAdapter,
        currentScope,
        { ...requestedScope, tabId: relayCommand.tabId },
      );
      return tabCommandRelayResultSchema.parse({
        kind: "activate-tab",
        ...result,
      });
    } catch (error) {
      void captureAndSync(true).catch((refreshError: unknown) => {
        console.error(
          "TabHub relayed activation-failure snapshot failed",
          refreshError,
        );
      });
      throw error;
    }
  }

  const command = parsePhysicalTabCommand(relayCommand);
  if (command === undefined) {
    throw new Error("The relay command is not a supported browser action.");
  }

  const [currentScope, tabs] = await Promise.all([
    currentTabCommandScope(),
    browser.tabs.query({}),
  ]);
  if (currentScope === undefined) {
    throw new Error(IDENTITY_REQUIRED_ERROR);
  }
  const protectedTabIds = protectedAppPageTabIds(tabs);
  const result = await physicalTabCommandExecutor.execute(
    {
      currentScope,
      protectedTabIds,
    },
    {
      ...requestedScope,
      command,
    },
  );

  if (result.kind !== "close-preview") {
    // A result is exposed only after the local catalog has had a chance to
    // observe the mutation, matching the same-page bridge semantics.
    try {
      const synchronized = await captureAndSync(true);
      if (
        synchronized?.serverReachable !== true ||
        synchronized.remaining.length > 0
      ) {
        scheduleTabEventSnapshot();
      }
    } catch (error) {
      console.error("TabHub post-relay-command snapshot failed", error);
      scheduleTabEventSnapshot();
    }
  }

  return tabCommandRelayResultSchema.parse(result);
}

function changeBrowserIdentity(
  nextBrowser: KnownBrowser,
): Promise<DrainQueueResult> {
  return serializeSync(async () => {
    const [
      previousBrowser,
      tabs,
      state,
      installationId,
      browserSessionId,
    ] = await Promise.all([
      getBrowserIdentifier(),
      browser.tabs.query({}),
      readQueueState(),
      getOrCreateInstallationId(),
      getOrCreateBrowserSessionId(),
    ]);
    const transition = buildIdentityTransitionSnapshots(
      previousBrowser,
      nextBrowser,
      installationId,
      browserSessionId,
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
  currentTabs: readonly BrowserTabLike[],
): Set<number> {
  const reconciledTabIds = new Set<number>();
  const currentTabsById = new Map(
    currentTabs.flatMap((tab) =>
      tab.id === undefined ? [] : [[tab.id, tab] as const],
    ),
  );

  for (const { page, tab } of capture.captured) {
    if (
      reconcileCapturedTabUrl(
        snapshot,
        {
          id: tab.id,
          index: tab.index,
          url: page.url,
          windowId: tab.windowId,
        },
        currentTabsById.get(tab.id),
      )
    ) {
      reconciledTabIds.add(tab.id);
    }
  }

  return reconciledTabIds;
}

async function captureContentUnlocked(
  mode: "current" | "all",
): Promise<ExtensionResponse> {
  const [browserIdentifier, installationId, browserSessionId] =
    await Promise.all([
      getBrowserIdentifier(),
      getOrCreateInstallationId(),
      getOrCreateBrowserSessionId(),
    ]);

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
  const snapshot = buildSnapshot(
    browserIdentifier,
    installationId,
    browserSessionId,
    currentTabs,
  );
  const reconciledTabIds = addCapturedUrlsToSnapshot(
    snapshot,
    capture,
    currentTabs,
  );
  const reconciledCapture = capture.captured.filter(({ tab }) =>
    reconciledTabIds.has(tab.id),
  );
  const contentItems = reconciledCapture.map(({ page }) =>
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
    captured: reconciledCapture.length,
    queued: drainResult.remaining.filter(({ id }) => contentIds.has(id)).length,
    requested: capture.requested,
    skipped: capture.requested - reconciledCapture.length,
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

function bridgeTypeForRequest(
  request: ExtensionRequest,
): BridgeRequestType | undefined {
  switch (request.type) {
    case "tabhub:app-probe":
      return "probe";
    case "tabhub:app-activate-tab":
      return "activate-tab";
    case "tabhub:app-tab-command":
      return "tab-command";
    default:
      return undefined;
  }
}

async function handleAppRequest(
  request: Extract<ExtensionRequest, { type: `tabhub:app-${string}` }>,
  sender: MessageSenderLike,
): Promise<AppExtensionResponse> {
  switch (request.type) {
    case "tabhub:app-probe": {
      const [browserIdentifier, installationId, browserSessionId] =
        await Promise.all([
          getBrowserIdentifier(),
          getOrCreateInstallationId(),
          getOrCreateBrowserSessionId(),
        ]);

      if (browserIdentifier !== undefined) {
        // Enqueue this before answering so a following preview is serialized
        // after a modern physical snapshot, without making the 2s probe wait.
        void captureAndSync().catch((error: unknown) => {
          console.error("TabHub app-probe snapshot failed", error);
        });
      }

      const controlWindowId = sender.tab?.windowId;
      if (
        !Number.isInteger(controlWindowId) ||
        (controlWindowId as number) < 0
      ) {
        throw new Error("TabHub could not identify its browser window.");
      }
      const scope =
        browserIdentifier === undefined
          ? undefined
          : {
              browser: browserIdentifier,
              browserSessionId,
              installationId,
            };
      const { pendingUndos, windows } = await currentBrowserState(scope);

      return {
        data: {
          available: true,
          browser: browserIdentifier ?? null,
          browserSessionId,
          controlWindowId: controlWindowId as number,
          installationId,
          pendingUndos,
          windows,
        },
        ok: true,
        type: "probe",
      };
    }
    case "tabhub:app-activate-tab": {
      return tabCommandSequencer.run(async () => {
        const [browserIdentifier, installationId, browserSessionId] =
          await Promise.all([
            getBrowserIdentifier(),
            getOrCreateInstallationId(),
            getOrCreateBrowserSessionId(),
          ]);

        if (browserIdentifier === undefined) {
          throw new Error(IDENTITY_REQUIRED_ERROR);
        }
        let result;
        try {
          result = await activateTabForScope(
            tabActivationAdapter,
            { browser: browserIdentifier, browserSessionId, installationId },
            request,
          );
        } catch (error) {
          // Refresh stale physical rows in the background. Activation itself
          // never waits behind snapshot uploads or offline queue draining.
          void captureAndSync(true).catch((refreshError: unknown) => {
            console.error(
              "TabHub activation-failure snapshot failed",
              refreshError,
            );
          });
          throw error;
        }
        return {
          data: {
            browser: browserIdentifier,
            browserSessionId,
            installationId,
            ...result,
          },
          ok: true,
          type: "activate-tab",
        };
      });
    }
    case "tabhub:app-tab-command": {
      return tabCommandSequencer.run(async () => {
        const [browserIdentifier, installationId, browserSessionId, tabs] =
          await Promise.all([
            getBrowserIdentifier(),
            getOrCreateInstallationId(),
            getOrCreateBrowserSessionId(),
            browser.tabs.query({}),
          ]);
        if (browserIdentifier === undefined) {
          throw new Error(IDENTITY_REQUIRED_ERROR);
        }
        const controlTabId = sender.tab?.id;
        const controlWindowId = sender.tab?.windowId;
        if (
          !Number.isInteger(controlTabId) ||
          (controlTabId as number) < 0 ||
          !Number.isInteger(controlWindowId) ||
          (controlWindowId as number) < 0
        ) {
          throw new Error(
            "TabHub could not identify the browser tab controlling this action.",
          );
        }

        const result = await physicalTabCommandExecutor.execute(
          directAppTabCommandContext(
            {
              browser: browserIdentifier,
              browserSessionId,
              installationId,
            },
            {
              id: controlTabId as number,
              windowId: controlWindowId as number,
            },
            tabs,
          ),
          request,
        );

        if (result.kind !== "close-preview") {
          // Do not expose a completed mutation to the web app until the local
          // catalog has observed the resulting physical order and flags. This
          // keeps an immediate Save workspace authoritative after Move/Pin/etc.
          try {
            const synchronized = await captureAndSync(true);
            if (
              synchronized?.serverReachable !== true ||
              synchronized.remaining.length > 0
            ) {
              scheduleTabEventSnapshot();
            }
          } catch (error) {
            console.error("TabHub post-command snapshot failed", error);
            scheduleTabEventSnapshot();
          }
        }

        return {
          data: {
            browser: browserIdentifier,
            browserSessionId,
            installationId,
            result,
          },
          ok: true,
          type: "tab-command",
        };
      });
    }
  }
}

export interface MessageSenderLike {
  tab?: {
    id?: number | undefined;
    url?: string | undefined;
    windowId?: number | undefined;
  } | undefined;
  url?: string | undefined;
}

export async function handleMessage(
  message: unknown,
  sender: MessageSenderLike,
): Promise<ExtensionResponse | AppExtensionResponse | void> {
  if (!isExtensionRequest(message)) {
    return;
  }

  const bridgeType = bridgeTypeForRequest(message);

  if (bridgeType !== undefined && !isAllowedAppMessageSender(sender)) {
    return {
      error: "Browser actions are available only from the local TabHub app.",
      ok: false,
      type: bridgeType,
    };
  }

  try {
    if (bridgeType !== undefined) {
      return handleAppRequest(
        message as Extract<
          ExtensionRequest,
          { type: `tabhub:app-${string}` }
        >,
        sender,
      );
    }

    switch (message.type) {
      case "tabhub:get-status":
        return { ok: true, status: await getStatus(true) };
      case "tabhub:snapshot-now":
        return handleSnapshotNow();
      case "tabhub:capture-current":
        return captureContent("current");
      case "tabhub:capture-all":
        return captureContent("all");
      case "tabhub:browser-changed": {
        try {
          await changeBrowserIdentity(message.browser);
        } finally {
          tabCommandRelayAgent.restart();
        }
        return { ok: true, status: await getStatus() };
      }
    }
  } catch (error) {
    if (bridgeType !== undefined) {
      return {
        error: errorMessage(error),
        ok: false,
        type: bridgeType,
      };
    }

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
  tabCommandRelayAgent.start();
  await ensureAlarms();
  await flushPending();
  await captureAndSync();
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
      tabCommandRelayAgent.restart();
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

  registerTabEventSnapshots(scheduleTabEventSnapshot, {
    activated: (listener) => browser.tabs.onActivated?.addListener(listener),
    attached: (listener) => browser.tabs.onAttached?.addListener(listener),
    created: (listener) => browser.tabs.onCreated?.addListener(listener),
    detached: (listener) => browser.tabs.onDetached?.addListener(listener),
    moved: (listener) => browser.tabs.onMoved?.addListener(listener),
    removed: (listener) => browser.tabs.onRemoved?.addListener(listener),
    replaced: (listener) => browser.tabs.onReplaced?.addListener(listener),
    updated: (listener) => browser.tabs.onUpdated?.addListener(listener),
  });

  browser.runtime.onMessage.addListener(handleMessage);
});
