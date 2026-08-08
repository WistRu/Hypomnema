import { browser } from "wxt/browser";

import type {
  ExtensionRequest,
  ExtensionResponse,
  ExtensionStatus,
} from "../../lib/messages";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`TabHub popup is missing ${selector}`);
  }

  return element;
}

const serverStatus = requiredElement<HTMLElement>("#server-status");
const pendingCount = requiredElement<HTMLElement>("#pending-count");
const statusDot = requiredElement<HTMLElement>("#status-dot");
const detail = requiredElement<HTMLElement>("#detail");
const snapshotButton =
  requiredElement<HTMLButtonElement>("#snapshot-button");
const optionsButton = requiredElement<HTMLButtonElement>("#options-button");

function renderStatus(status: ExtensionStatus): void {
  serverStatus.textContent = status.serverReachable
    ? "Available"
    : "Unavailable";
  pendingCount.textContent = String(status.pendingCount);
  statusDot.className = `status-dot ${status.serverReachable ? "online" : "offline"}`;
  statusDot.title = status.serverReachable
    ? "TabHub server available"
    : "TabHub server unavailable";

  if (status.lastError !== undefined && status.pendingCount > 0) {
    detail.textContent = status.lastError;
  } else if (status.pendingCount > 0) {
    detail.textContent = "Saved locally and waiting to retry.";
  } else {
    detail.textContent = "All snapshots are synchronized.";
  }
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
    detail.textContent = response.error;
  }
}

snapshotButton.addEventListener("click", () => {
  void (async () => {
    snapshotButton.disabled = true;
    snapshotButton.textContent = "Taking snapshot…";
    const response = await sendRequest({ type: "tabhub:snapshot-now" });
    renderStatus(response.status);

    if (!response.ok) {
      detail.textContent = response.error;
    } else if (response.status.pendingCount > 0) {
      detail.textContent = "Snapshot saved locally; retry is automatic.";
    } else {
      detail.textContent = "Snapshot synchronized.";
    }
  })()
    .catch((error: unknown) => {
      detail.textContent =
        error instanceof Error ? error.message : "Snapshot failed.";
    })
    .finally(() => {
      snapshotButton.disabled = false;
      snapshotButton.textContent = "Snapshot now";
    });
});

optionsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().then(() => window.close());
});

void refreshStatus().catch((error: unknown) => {
  serverStatus.textContent = "Unavailable";
  pendingCount.textContent = "—";
  statusDot.className = "status-dot offline";
  detail.textContent =
    error instanceof Error ? error.message : "Could not read extension status.";
});
