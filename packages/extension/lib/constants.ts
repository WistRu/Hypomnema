export const SERVER_ORIGIN = "http://127.0.0.1:7717";
export const SNAPSHOT_ENDPOINT = `${SERVER_ORIGIN}/api/ingest/snapshot`;
export const CONTENT_ENDPOINT = `${SERVER_ORIGIN}/api/ingest/content`;
export const HEALTH_ENDPOINT = `${SERVER_ORIGIN}/api/health`;

// Chrome requires executeScript file paths relative to the extension root.
// WXT's generated PublicPath type includes a leading slash, so this assertion
// keeps WXT's build-time path checking while preserving Chrome's runtime form.
export const EXTRACT_CONTENT_SCRIPT_FILE =
  "extract-content.js" as "/extract-content.js";

export const STORAGE_KEYS = {
  browser: "tabhub.browser",
  pendingSnapshots: "tabhub.pendingSnapshots",
} as const;

export const SNAPSHOT_ALARM_NAME = "tabhub-periodic-snapshot";
export const RETRY_ALARM_NAME = "tabhub-retry-pending";

export const SNAPSHOT_INTERVAL_MINUTES = 5;
export const RETRY_INTERVAL_MINUTES = 1;
export const TAB_EVENT_DEBOUNCE_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 5_000;
