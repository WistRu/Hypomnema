import { browser } from "wxt/browser";

import type {
  ExtensionRequest,
  ExtensionResponse,
} from "../../lib/messages";
import { getBrowserIdentifier, isKnownBrowser } from "../../lib/storage";

const select = document.querySelector<HTMLSelectElement>("#browser-select");
const saveStatus = document.querySelector<HTMLElement>("#save-status");

if (select === null || saveStatus === null) {
  throw new Error("TabHub options page is missing required controls");
}

const browserSelect = select;
const statusElement = saveStatus;

let selectedBrowser = await getBrowserIdentifier();
browserSelect.value = selectedBrowser ?? "";

function savedMessage(
  response: Extract<ExtensionResponse, { ok: true }>,
  previousBrowser: typeof selectedBrowser,
  requestedBrowser: NonNullable<typeof selectedBrowser>,
): string {
  if (response.status.deadLetterCount > 0) {
    const detail = response.status.lastError
      ? ` ${response.status.lastError}`
      : " Check the extension popup for the rejected upload.";
    return `Saved, but an unsendable operation was discarded.${detail}`;
  }

  if (response.status.pendingOperationCount > 0) {
    const detail = response.status.lastError
      ? ` Last error: ${response.status.lastError}`
      : "";
    return `Saved locally. ${response.status.pendingOperationCount} queued operations will retry automatically.${detail}`;
  }

  return previousBrowser === undefined || previousBrowser === requestedBrowser
    ? "Saved. This browser is synchronized."
    : "Saved. The previous identity was closed and this browser is synchronized.";
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
      throw new Error("Unsupported browser selection");
    }

    const message: ExtensionRequest = {
      browser: requestedValue,
      type: "tabhub:browser-changed",
    };
    const response = (await browser.runtime.sendMessage(
      message,
    )) as ExtensionResponse;

    if (!response.ok) {
      throw new Error(response.error);
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
        error instanceof Error ? error.message : "Could not save the setting.";
    })
    .finally(() => {
      browserSelect.disabled = false;
    });
});
