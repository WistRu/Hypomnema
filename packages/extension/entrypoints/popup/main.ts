import { browser } from "wxt/browser";

import type {
  CaptureSummary,
  ContextPopupData,
  ExtensionRequest,
  ExtensionResponse,
  ExtensionStatus,
} from "../../lib/messages";
import type {
  ContextEntryKind,
  ContextVisibility,
  SessionIntent,
} from "@tabhub/shared";
import { localizedExtensionError } from "../../lib/localized-error";

const uiLocale = browser.i18n.getMessage("@@ui_locale");
const documentLocale = /^ru(?:[-_]|$)/i.test(uiLocale) ? "ru" : "en";
const numberFormatter = new Intl.NumberFormat(documentLocale);
const localizedMessage = browser.i18n.getMessage as (name: string) => string;

function displayError(message: string): string {
  if (message === "Pairing required") {
    return browser.i18n.getMessage("popupPairingRequired");
  }
  if (documentLocale === "en" || /[А-Яа-яЁё]/.test(message)) return message;
  const localized = localizedExtensionError(message);
  return browser.i18n.getMessage(
    localized.messageName,
    localized.substitutions,
  );
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`TabHub popup is missing ${selector}`);
  }

  return element;
}

const serverStatus = requiredElement<HTMLElement>("#server-status");
const pendingCount = requiredElement<HTMLElement>("#pending-count");
const pendingOperations = requiredElement<HTMLElement>("#pending-operations");
const statusDot = requiredElement<HTMLElement>("#status-dot");
const detail = requiredElement<HTMLElement>("#detail");
const captureCurrentButton = requiredElement<HTMLButtonElement>(
  "#capture-current-button",
);
const captureAllButton = requiredElement<HTMLButtonElement>(
  "#capture-all-button",
);
const snapshotButton =
  requiredElement<HTMLButtonElement>("#snapshot-button");
const optionsButton = requiredElement<HTMLButtonElement>("#options-button");
const contextSection = requiredElement<HTMLElement>("#context-section");
const contextPage = requiredElement<HTMLElement>("#context-page");
const pairingPanel = requiredElement<HTMLElement>("#pairing-panel");
const pairingChallenge = requiredElement<HTMLInputElement>("#pairing-challenge");
const pairingCode = requiredElement<HTMLInputElement>("#pairing-code");
const pairButton = requiredElement<HTMLButtonElement>("#pair-button");
const contextForm = requiredElement<HTMLFormElement>("#context-form");
const contextScope = requiredElement<HTMLSelectElement>("#context-scope");
const contextKind = requiredElement<HTMLSelectElement>("#context-kind");
const contextVisibility = requiredElement<HTMLSelectElement>("#context-visibility");
const contextBody = requiredElement<HTMLTextAreaElement>("#context-body");
const contextSave = requiredElement<HTMLButtonElement>("#context-save");
const contextFeedback = requiredElement<HTMLElement>("#context-feedback");
const contextDiscardStale = requiredElement<HTMLButtonElement>(
  "#context-discard-stale",
);
const intentPanel = requiredElement<HTMLElement>("#intent-panel");
const intentCurrent = requiredElement<HTMLElement>("#intent-current");
const intentPromote = requiredElement<HTMLButtonElement>("#intent-promote");
const intentArchive = requiredElement<HTMLButtonElement>("#intent-archive");
const intentHistory = requiredElement<HTMLUListElement>("#intent-history");
let currentIntent: SessionIntent | undefined;
let renderedMutationTarget: ContextPopupData["mutationTarget"];
let staleQueueHeadId: string | undefined;
let browserConfigured = false;
let contextDraftIdempotencyKey: string | undefined;

function localizeStaticUi(): void {
  document.documentElement.lang = documentLocale;
  document.title = browser.i18n.getMessage("extensionName");
  requiredElement<HTMLElement>("#popup-brand").textContent =
    browser.i18n.getMessage("extensionName");
  requiredElement<HTMLElement>("#popup-heading").textContent =
    browser.i18n.getMessage("popupHeading");
  requiredElement<HTMLElement>("#server-label").textContent =
    browser.i18n.getMessage("popupServerLabel");
  requiredElement<HTMLElement>("#pending-label").textContent =
    browser.i18n.getMessage("popupUnsyncedTabsLabel");
  requiredElement<HTMLElement>("#pending-operations-label").textContent =
    browser.i18n.getMessage("popupQueuedOperationsLabel");
  serverStatus.textContent = browser.i18n.getMessage("popupChecking");
  captureCurrentButton.textContent = browser.i18n.getMessage(
    "popupCaptureCurrentButton",
  );
  captureAllButton.textContent = browser.i18n.getMessage(
    "popupCaptureAllButton",
  );
  snapshotButton.textContent = browser.i18n.getMessage(
    "popupSnapshotButton",
  );
  optionsButton.textContent = browser.i18n.getMessage(
    "popupBrowserSettingsButton",
  );
  const localizedIds: Record<string, string> = {
    "context-heading": "popupContextHeading",
    "pairing-help": "popupPairingHelp",
    "pairing-challenge-label": "popupPairingChallengeLabel",
    "pairing-code-label": "popupPairingCodeLabel",
    "context-scope-label": "popupContextScopeLabel",
    "context-scope-page": "popupContextScopePage",
    "context-scope-tab": "popupContextScopeTab",
    "context-kind-label": "popupContextKindLabel",
    "context-visibility-label": "popupContextVisibilityLabel",
    "context-local-option": "popupContextLocalOnly",
    "context-share-option": "popupContextShareAi",
    "context-body-label": "popupContextBodyLabel",
    "intent-history-label": "popupIntentHistory",
  };
  for (const [id, messageName] of Object.entries(localizedIds)) {
    requiredElement<HTMLElement>(`#${id}`).textContent =
      localizedMessage(messageName);
  }
  pairButton.textContent = browser.i18n.getMessage("popupPairButton");
  contextSave.textContent = browser.i18n.getMessage("popupContextSave");
  intentPromote.textContent = browser.i18n.getMessage("popupIntentPromote");
  intentArchive.textContent = browser.i18n.getMessage("popupIntentArchive");
  contextDiscardStale.textContent = browser.i18n.getMessage(
    "popupContextDiscardStale",
  );
  const kindMessages: Record<string, string> = {
    purpose: "popupContextPurpose",
    interest: "popupContextInterest",
    question: "popupContextQuestion",
    project: "popupContextProject",
    next_action: "popupContextNextAction",
    note: "popupContextNote",
  };
  for (const option of contextKind.options) {
    option.textContent = localizedMessage(kindMessages[option.value]!);
  }
}

function localizedIntentState(state: string): string {
  const messages: Record<string, string> = {
    active: "popupIntentStateActive",
    archived: "popupIntentStateArchived",
    promoted: "popupIntentStatePromoted",
    expired: "popupIntentStateExpired",
  };
  return localizedMessage(messages[state] ?? "popupIntentStateArchived");
}

function renderContext(response: ExtensionResponse): void {
  const context = response.context;
  if (context === undefined || !context.contextEnabled) {
    contextSection.hidden = true;
    return;
  }
  contextSection.hidden = false;
  pairingPanel.hidden = !context.pairingRequired;
  renderedMutationTarget = context.mutationTarget;
  contextForm.hidden =
    context.pairingRequired ||
    context.activeTab === null ||
    renderedMutationTarget === undefined;
  contextPage.textContent =
    context.activeTab === null
      ? browser.i18n.getMessage("popupContextNoActiveTab")
      : `${context.activeTab.title} — ${context.activeTab.url}`;
  currentIntent = context.sessionIntent?.current ?? undefined;
  staleQueueHeadId = context.pendingMutationHeadId;
  intentPanel.hidden = context.pairingRequired || context.sessionIntent === undefined;
  intentCurrent.textContent = context.sessionIntent?.current?.body ?? "";
  intentPromote.hidden = context.sessionIntent?.current === null;
  intentArchive.hidden = context.sessionIntent?.current === null;
  intentHistory.replaceChildren(
    ...(context.sessionIntent?.history ?? []).map((intent) => {
      const item = document.createElement("li");
      item.textContent = `${localizedIntentState(intent.state)}: ${intent.body}`;
      return item;
    }),
  );
  contextFeedback.textContent =
    context.pendingMutationError === "Page changed; review required"
      ? browser.i18n.getMessage("popupContextStaleQueued")
      : context.pendingMutationCount > 0
      ? browser.i18n.getMessage("popupContextQueued")
      : "";
  contextDiscardStale.hidden =
    context.pendingMutationError !== "Page changed; review required";
}

function renderStatus(status: ExtensionStatus): void {
  browserConfigured = status.browserConfigured;
  serverStatus.textContent = status.serverReachable
    ? browser.i18n.getMessage("popupServerAvailable")
    : browser.i18n.getMessage("popupServerUnavailable");
  pendingCount.textContent = numberFormatter.format(status.pendingTabCount);
  pendingOperations.textContent = numberFormatter.format(status.pendingOperationCount);
  statusDot.className = `status-dot ${status.serverReachable ? "online" : "offline"}`;
  statusDot.title = status.serverReachable
    ? browser.i18n.getMessage("popupServerAvailableTitle")
    : browser.i18n.getMessage("popupServerUnavailableTitle");

  if (!status.browserConfigured) {
    detail.textContent = browser.i18n.getMessage(
      "popupChooseBrowserIdentity",
    );
  } else if (status.lastError !== undefined) {
    detail.textContent = displayError(status.lastError);
  } else if (status.pendingOperationCount > 0) {
    detail.textContent = browser.i18n.getMessage("popupWaitingToRetry", [
      numberFormatter.format(status.pendingTabCount),
      numberFormatter.format(status.pendingOperationCount),
    ]);
  } else {
    detail.textContent = browser.i18n.getMessage("popupAllSynchronized");
  }

  setActionsDisabled(false);
}

function formatCaptureSummary(summary: CaptureSummary): string {
  if (summary.captured === 0) {
    return browser.i18n.getMessage("popupCaptureNone", [
      numberFormatter.format(summary.requested),
      numberFormatter.format(summary.skipped),
    ]);
  }

  return summary.queued > 0
    ? browser.i18n.getMessage("popupCaptureQueued", [
        numberFormatter.format(summary.captured),
        numberFormatter.format(summary.requested),
        numberFormatter.format(summary.skipped),
        numberFormatter.format(summary.queued),
      ])
    : browser.i18n.getMessage("popupCaptureSynchronized", [
        numberFormatter.format(summary.captured),
        numberFormatter.format(summary.requested),
        numberFormatter.format(summary.skipped),
      ]);
}

async function sendRequest(
  request: ExtensionRequest,
): Promise<ExtensionResponse> {
  return (await browser.runtime.sendMessage(request)) as ExtensionResponse;
}

async function refreshStatus(): Promise<void> {
  const response = await sendRequest({ type: "tabhub:get-status" });
  renderStatus(response.status);

  if (!response.ok) {
    detail.textContent = displayError(response.error);
  }
}

export async function refreshContext(): Promise<void> {
  const response = await sendRequest({ type: "tabhub:context-features" });
  if (!response.ok) {
    contextSection.hidden = true;
    detail.textContent = displayError(response.error);
    return;
  }
  renderContext(response);
}

async function runContextRequest(request: ExtensionRequest): Promise<boolean> {
  contextFeedback.textContent = "";
  pairButton.disabled = true;
  contextSave.disabled = true;
  intentPromote.disabled = true;
  intentArchive.disabled = true;
  contextDiscardStale.disabled = true;
  try {
    const response = await sendRequest(request);
    if (!response.ok) {
      contextFeedback.textContent = displayError(response.error);
      return false;
    }
    renderContext(response);
    if (request.type === "tabhub:context-pair") {
      contextFeedback.textContent = browser.i18n.getMessage("popupContextPaired");
    } else if (
      request.type === "tabhub:context-save" ||
      request.type === "tabhub:context-intent-action"
    ) {
      contextFeedback.textContent =
        response.context?.pendingMutationCount === 0
          ? browser.i18n.getMessage("popupContextSaved")
          : browser.i18n.getMessage("popupContextQueued");
    }
    return true;
  } catch (error) {
    contextFeedback.textContent = displayError(
      error instanceof Error ? error.message : "Pairing required",
    );
    return false;
  } finally {
    pairButton.disabled = false;
    contextSave.disabled = false;
    intentPromote.disabled = false;
    intentArchive.disabled = false;
    contextDiscardStale.disabled = false;
  }
}

const actionButtons = [
  captureCurrentButton,
  captureAllButton,
  snapshotButton,
];

function setActionsDisabled(disabled: boolean): void {
  for (const button of actionButtons) {
    button.disabled = disabled || !browserConfigured;
  }
}

function runAction(
  button: HTMLButtonElement,
  busyLabel: string,
  request: ExtensionRequest,
  doneLabel: string,
): void {
  const originalLabel = button.textContent;

  void (async () => {
    setActionsDisabled(true);
    button.textContent = busyLabel;
    const response = await sendRequest(request);
    renderStatus(response.status);

    if (!response.ok) {
      detail.textContent = displayError(response.error);
    } else if (response.status.lastError === undefined) {
      if (response.capture !== undefined) {
        detail.textContent = formatCaptureSummary(response.capture);
      } else if (response.status.pendingOperationCount > 0) {
        detail.textContent = browser.i18n.getMessage(
          "popupSnapshotSavedForRetry",
        );
      } else {
        detail.textContent = doneLabel;
      }
    }
  })()
    .catch((error: unknown) => {
      detail.textContent =
        error instanceof Error
          ? displayError(error.message)
          : browser.i18n.getMessage("popupActionFailed");
    })
    .finally(() => {
      setActionsDisabled(false);
      button.textContent = originalLabel;
    });
}

captureCurrentButton.addEventListener("click", () => {
  runAction(
    captureCurrentButton,
    browser.i18n.getMessage("popupCapturingCurrent"),
    { type: "tabhub:capture-current" },
    browser.i18n.getMessage("popupCurrentCaptured"),
  );
});

captureAllButton.addEventListener("click", () => {
  runAction(
    captureAllButton,
    browser.i18n.getMessage("popupCapturingAll"),
    { type: "tabhub:capture-all" },
    browser.i18n.getMessage("popupAllCaptured"),
  );
});

snapshotButton.addEventListener("click", () => {
  runAction(
    snapshotButton,
    browser.i18n.getMessage("popupTakingSnapshot"),
    { type: "tabhub:snapshot-now" },
    browser.i18n.getMessage("popupSnapshotSynchronized"),
  );
});

optionsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => window.close());
});

pairButton.addEventListener("click", () => {
  const challengeId = pairingChallenge.value.trim();
  const code = pairingCode.value.trim();
  if (!challengeId || !code) return;
  void runContextRequest({
    challengeId,
    code,
    type: "tabhub:context-pair",
  }).finally(() => {
    pairingCode.value = "";
  });
});

contextForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = contextBody.value.trim();
  const target = renderedMutationTarget;
  if (!body || target === undefined) {
    void refreshContext();
    return;
  }
  void runContextRequest({
    body,
    entryKind: contextKind.value as ContextEntryKind,
    expectedUrl: target.expectedUrl,
    idempotencyKey:
      contextDraftIdempotencyKey ??= crypto.randomUUID(),
    scope: contextScope.value as "page" | "this_tab",
    targetScope: target.scope,
    type: "tabhub:context-save",
    visibility: contextVisibility.value as ContextVisibility,
  }).then((saved) => {
    if (saved) {
      contextBody.value = "";
      contextDraftIdempotencyKey = undefined;
    }
  });
});

contextBody.addEventListener("input", () => {
  contextDraftIdempotencyKey = undefined;
});

contextBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  contextForm.requestSubmit();
});

function runIntentAction(kind: "archive" | "promote") {
  if (currentIntent === undefined) return;
  const common = {
    contextKind: contextKind.value as ContextEntryKind,
    expectedPage: currentIntent.expectedPage,
    idempotencyKey: crypto.randomUUID(),
    intentId: currentIntent.id,
    scope: currentIntent.scope,
    type: "tabhub:context-intent-action",
  } as const;
  void runContextRequest(
    kind === "archive"
      ? { ...common, kind }
      : {
          ...common,
          kind,
        },
  );
}

intentPromote.addEventListener("click", () => runIntentAction("promote"));
intentArchive.addEventListener("click", () => runIntentAction("archive"));
contextDiscardStale.addEventListener("click", () => {
  void (async () => {
    const queueHeadId = staleQueueHeadId;
    if (queueHeadId === undefined) {
      await refreshContext();
      return;
    }
    if (
      !window.confirm(
        browser.i18n.getMessage("popupContextDiscardStaleConfirm"),
      )
    ) {
      return;
    }
    contextDiscardStale.disabled = true;
    try {
      const response = await sendRequest({
        queueHeadId,
        type: "tabhub:context-discard-stale",
      });
      if (!response.ok) {
        contextFeedback.textContent = displayError(response.error);
        return;
      }
      renderContext(response);
      contextFeedback.textContent = browser.i18n.getMessage(
        "popupContextStaleDiscarded",
      );
    } catch (error) {
      contextFeedback.textContent = displayError(
        error instanceof Error ? error.message : "Retry required",
      );
    } finally {
      contextDiscardStale.disabled = false;
    }
  })();
});

localizeStaticUi();

void refreshStatus().catch((error: unknown) => {
  serverStatus.textContent = browser.i18n.getMessage(
    "popupServerUnavailable",
  );
  pendingCount.textContent = "—";
  pendingOperations.textContent = "—";
  statusDot.className = "status-dot offline";
  detail.textContent =
    error instanceof Error
      ? displayError(error.message)
      : browser.i18n.getMessage("popupCouldNotReadStatus");
});

void refreshContext().catch(() => {
  contextSection.hidden = true;
});
