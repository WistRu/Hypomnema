import { browser } from "wxt/browser";

import type {
  CaptureSummary,
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
const captureCurrentButton = requiredElement<HTMLButtonElement>(
  "#capture-current-button",
);
const captureAllButton = requiredElement<HTMLButtonElement>(
  "#capture-all-button",
);
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
    detail.textContent = "All queued items are synchronized.";
  }
}

function formatCaptureSummary(summary: CaptureSummary): string {
  if (summary.captured === 0) {
    return `Captured 0 of ${summary.requested}; skipped ${summary.skipped}. No content was sent.`;
  }

  const queued =
    summary.queued > 0
      ? ` ${summary.queued} saved locally for automatic retry.`
      : " Content synchronized.";

  return `Captured ${summary.captured} of ${summary.requested}; skipped ${summary.skipped}.${queued}`;
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

const actionButtons = [
  captureCurrentButton,
  captureAllButton,
  snapshotButton,
];

function setActionsDisabled(disabled: boolean): void {
  for (const button of actionButtons) {
    button.disabled = disabled;
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
      detail.textContent = response.error;
    } else if (response.capture !== undefined) {
      detail.textContent = formatCaptureSummary(response.capture);
    } else if (response.status.pendingCount > 0) {
      detail.textContent = "Snapshot saved locally; retry is automatic.";
    } else {
      detail.textContent = doneLabel;
    }
  })()
    .catch((error: unknown) => {
      detail.textContent =
        error instanceof Error ? error.message : "Extension action failed.";
    })
    .finally(() => {
      setActionsDisabled(false);
      button.textContent = originalLabel;
    });
}

captureCurrentButton.addEventListener("click", () => {
  runAction(
    captureCurrentButton,
    "Capturing current tab…",
    { type: "tabhub:capture-current" },
    "Current tab captured.",
  );
});

captureAllButton.addEventListener("click", () => {
  runAction(
    captureAllButton,
    "Capturing eligible tabs…",
    { type: "tabhub:capture-all" },
    "Eligible tabs captured.",
  );
});

snapshotButton.addEventListener("click", () => {
  runAction(
    snapshotButton,
    "Taking snapshot…",
    { type: "tabhub:snapshot-now" },
    "Snapshot synchronized.",
  );
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
