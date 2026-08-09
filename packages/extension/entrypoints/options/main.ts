import { browser } from "wxt/browser";

import type {
  ExtensionRequest,
  ExtensionResponse,
} from "../../lib/messages";
import { localizedExtensionError } from "../../lib/localized-error";
import { getBrowserIdentifier, isKnownBrowser } from "../../lib/storage";

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
    throw new Error(`TabHub options page is missing ${selector}`);
  }

  return element;
}

const browserSelect =
  requiredElement<HTMLSelectElement>("#browser-select");
const statusElement = requiredElement<HTMLElement>("#save-status");

function localizeStaticUi(): void {
  document.documentElement.lang = documentLocale;
  document.title = browser.i18n.getMessage("optionsDocumentTitle");
  requiredElement<HTMLElement>("#options-brand").textContent =
    browser.i18n.getMessage("extensionName");
  requiredElement<HTMLElement>("#options-heading").textContent =
    browser.i18n.getMessage("optionsHeading");
  requiredElement<HTMLElement>("#options-description").textContent =
    browser.i18n.getMessage("optionsDescription");
  requiredElement<HTMLElement>("#browser-label").textContent =
    browser.i18n.getMessage("optionsBrowserLabel");
  requiredElement<HTMLOptionElement>(
    "#browser-option-placeholder",
  ).textContent = browser.i18n.getMessage("optionsChooseBrowser");
  requiredElement<HTMLOptionElement>("#browser-option-chrome").textContent =
    browser.i18n.getMessage("browserChrome");
  requiredElement<HTMLOptionElement>("#browser-option-yandex").textContent =
    browser.i18n.getMessage("browserYandex");
  requiredElement<HTMLOptionElement>("#browser-option-edge").textContent =
    browser.i18n.getMessage("browserEdge");
  requiredElement<HTMLOptionElement>("#browser-option-other").textContent =
    browser.i18n.getMessage("browserOther");
}

localizeStaticUi();

let selectedBrowser = await getBrowserIdentifier();
browserSelect.value = selectedBrowser ?? "";

function savedMessage(
  response: Extract<ExtensionResponse, { ok: true }>,
  previousBrowser: typeof selectedBrowser,
  requestedBrowser: NonNullable<typeof selectedBrowser>,
): string {
  if (response.status.deadLetterCount > 0) {
    return response.status.lastError
      ? browser.i18n.getMessage("optionsSavedDiscardedWithError", [
          displayError(response.status.lastError),
        ])
      : browser.i18n.getMessage("optionsSavedDiscarded");
  }

  if (response.status.pendingOperationCount > 0) {
    return response.status.lastError
      ? browser.i18n.getMessage("optionsSavedPendingWithError", [
          numberFormatter.format(response.status.pendingOperationCount),
          displayError(response.status.lastError),
        ])
      : browser.i18n.getMessage("optionsSavedPending", [
          numberFormatter.format(response.status.pendingOperationCount),
        ]);
  }

  return previousBrowser === undefined || previousBrowser === requestedBrowser
    ? browser.i18n.getMessage("optionsSavedSynchronized")
    : browser.i18n.getMessage("optionsSavedIdentityChanged");
}

async function reconcileSelection(): Promise<void> {
  selectedBrowser = await getBrowserIdentifier();
  browserSelect.value = selectedBrowser ?? "";
}

browserSelect.addEventListener("change", () => {
  const requestedValue = browserSelect.value;
  const previousBrowser = selectedBrowser;
  browserSelect.disabled = true;

  void (async () => {
    if (!isKnownBrowser(requestedValue)) {
      throw new Error(
        browser.i18n.getMessage("optionsUnsupportedBrowserSelection"),
      );
    }

    const message: ExtensionRequest = {
      browser: requestedValue,
      type: "tabhub:browser-changed",
    };
    const response = (await browser.runtime.sendMessage(
      message,
    )) as ExtensionResponse;

    if (!response.ok) {
      throw new Error(displayError(response.error));
    }

    await reconcileSelection();
    statusElement.textContent = savedMessage(
      response,
      previousBrowser,
      requestedValue,
    );
  })()
    .catch(async (error: unknown) => {
      await reconcileSelection().catch(() => undefined);
      statusElement.textContent =
        error instanceof Error
          ? displayError(error.message)
          : browser.i18n.getMessage("optionsCouldNotSave");
    })
    .finally(() => {
      browserSelect.disabled = false;
    });
});
