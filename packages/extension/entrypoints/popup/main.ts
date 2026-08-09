import { browser } from "wxt/browser";

import type {
  CaptureSummary,
  ExtensionRequest,
  ExtensionResponse,
  ExtensionStatus,
} from "../../lib/messages";
import { localizedExtensionError } from "../../lib/localized-error";

const uiLocale = browser.i18n.getMessage("@@ui_locale");
const documentLocale = /^ru(?:[-_]|$)/i.test(uiLocale) ? "ru" : "en";
const numberFormatter = new Intl.NumberFormat(documentLocale);

function displayError(message: string): string {
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
let browserConfigured = false;

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
