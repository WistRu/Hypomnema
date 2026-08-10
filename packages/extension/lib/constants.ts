export const SERVER_ORIGIN = "http://127.0.0.1:7717";
export const SNAPSHOT_ENDPOINT = `${SERVER_ORIGIN}/api/ingest/snapshot`;
export const CONTENT_ENDPOINT = `${SERVER_ORIGIN}/api/ingest/content`;
export const ACTIVITY_ENDPOINT = `${SERVER_ORIGIN}/api/ingest/activity`;
export const HEALTH_ENDPOINT = `${SERVER_ORIGIN}/api/health`;
export const TAB_COMMAND_RELAY_WEBSOCKET_ENDPOINT =
  "ws://127.0.0.1:7717/api/tab-command-relay/ws";

// Chrome requires executeScript file paths relative to the extension root.
// WXT's generated PublicPath type includes a leading slash, so this assertion
// keeps WXT's build-time path checking while preserving Chrome's runtime form.
export const EXTRACT_CONTENT_SCRIPT_FILE =
  "extract-content.js" as "/extract-content.js";
export const ACTIVITY_CONTENT_SCRIPT_FILE =
  "content-scripts/activity.js" as "/content-scripts/activity.js";

export const STORAGE_KEYS = {
  activityCheckpoint: "tabhub.activityCheckpoint",
  browser: "tabhub.browser",
  browserConfigured: "tabhub.browserConfiguredVersion",
  browserSessionId: "tabhub.browserSessionId",
  deadLetters: "tabhub.deadLetters",
  installationId: "tabhub.installationId",
  pendingSnapshots: "tabhub.pendingSnapshots",
} as const;

export const SNAPSHOT_ALARM_NAME = "tabhub-periodic-snapshot";
export const RETRY_ALARM_NAME = "tabhub-retry-pending";
export const ACTIVITY_ALARM_NAME = "tabhub-activity-checkpoint";

export const SNAPSHOT_INTERVAL_MINUTES = 5;
export const RETRY_INTERVAL_MINUTES = 1;
export const ACTIVITY_INTERVAL_MINUTES = 1;
export const TAB_EVENT_DEBOUNCE_MS = 1_000;
export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 5_000;

// Snapshot requests include both the upload and the server's transaction. The
// extension talks to localhost, but a full transport-budget payload can still
// take materially longer than the small health/content request timeout.
export const SNAPSHOT_REQUEST_BASE_TIMEOUT_MS = 10_000;
export const SNAPSHOT_REQUEST_MIN_THROUGHPUT_BYTES_PER_SECOND = 128 * 1024;
