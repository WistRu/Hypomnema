import { browser } from "wxt/browser";

import type { ExtensionRequest } from "../../lib/messages";
import {
  ensureBrowserIdentifier,
  isKnownBrowser,
  setBrowserIdentifier,
} from "../../lib/storage";

const select = document.querySelector<HTMLSelectElement>("#browser-select");
const saveStatus = document.querySelector<HTMLElement>("#save-status");

if (select === null || saveStatus === null) {
  throw new Error("TabHub options page is missing required controls");
}

const selectedBrowser = await ensureBrowserIdentifier();
select.value = selectedBrowser;

select.addEventListener("change", () => {
  void (async () => {
    if (!isKnownBrowser(select.value)) {
      throw new Error("Unsupported browser selection");
    }

    await setBrowserIdentifier(select.value);
    const message: ExtensionRequest = { type: "tabhub:browser-changed" };
    await browser.runtime.sendMessage(message);
    saveStatus.textContent = "Saved. A fresh snapshot has been scheduled.";
  })().catch((error: unknown) => {
    saveStatus.textContent =
      error instanceof Error ? error.message : "Could not save the setting.";
  });
});
