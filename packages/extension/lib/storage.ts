import {
  ingestContentSchema,
  ingestSnapshotSchema,
  knownBrowserOptions,
} from "@tabhub/shared";
import { browser } from "wxt/browser";

import { STORAGE_KEYS } from "./constants";
import {
  MAX_DEAD_LETTERS,
  type DeadLetter,
  type PendingItem,
} from "./queue";

export type KnownBrowser = (typeof knownBrowserOptions)[number];

export interface StoredQueueState {
  deadLetters: DeadLetter[];
  pending: PendingItem[];
}

export const BROWSER_CONFIG_VERSION = 1;

const knownBrowsers = new Set<string>(knownBrowserOptions);
const installationUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let installationIdentityInFlight: Promise<string> | undefined;
let browserSessionIdentityInFlight: Promise<string> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isKnownBrowser(value: unknown): value is KnownBrowser {
  return typeof value === "string" && knownBrowsers.has(value);
}

export function isInstallationId(value: unknown): value is string {
  return typeof value === "string" && installationUuidPattern.test(value);
}

export const isBrowserSessionId = isInstallationId;

/**
 * A browser value is trusted only when accompanied by the explicit-choice
 * marker. Earlier extension versions silently wrote `chrome`; treating that
 * legacy value as configured would keep mislabelling Edge/Yandex installs.
 */
export async function getBrowserIdentifier(): Promise<
  KnownBrowser | undefined
> {
  const stored = await browser.storage.local.get([
    STORAGE_KEYS.browser,
    STORAGE_KEYS.browserConfigured,
  ]);
  const storedBrowser = stored[STORAGE_KEYS.browser];

  return stored[STORAGE_KEYS.browserConfigured] === BROWSER_CONFIG_VERSION &&
    isKnownBrowser(storedBrowser)
    ? storedBrowser
    : undefined;
}

async function loadOrCreateInstallationId(): Promise<string> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.installationId);
  const existing = stored[STORAGE_KEYS.installationId];

  if (
    isInstallationId(existing)
  ) {
    return existing;
  }

  const installationId = crypto.randomUUID();
  await browser.storage.local.set({
    [STORAGE_KEYS.installationId]: installationId,
  });
  return installationId;
}

/**
 * Stable per-profile routing identity. The in-flight guard prevents two
 * startup paths from persisting different UUIDs before either write finishes.
 */
export function getOrCreateInstallationId(): Promise<string> {
  if (installationIdentityInFlight !== undefined) {
    return installationIdentityInFlight;
  }

  const operation = loadOrCreateInstallationId();
  installationIdentityInFlight = operation;
  void operation.then(
    () => {
      if (installationIdentityInFlight === operation) {
        installationIdentityInFlight = undefined;
      }
    },
    () => {
      if (installationIdentityInFlight === operation) {
        installationIdentityInFlight = undefined;
      }
    },
  );
  return operation;
}

async function loadOrCreateBrowserSessionId(): Promise<string> {
  const stored = await browser.storage.session.get(
    STORAGE_KEYS.browserSessionId,
  );
  const existing = stored[STORAGE_KEYS.browserSessionId];

  if (isBrowserSessionId(existing)) {
    return existing;
  }

  const browserSessionId = crypto.randomUUID();
  await browser.storage.session.set({
    [STORAGE_KEYS.browserSessionId]: browserSessionId,
  });
  return browserSessionId;
}

/**
 * Browser-session identity survives MV3 service-worker suspension but is not
 * persisted beyond the browser session. This prevents a persisted native tab
 * ID from targeting a newly-reused ID after a browser restart.
 */
export function getOrCreateBrowserSessionId(): Promise<string> {
  if (browserSessionIdentityInFlight !== undefined) {
    return browserSessionIdentityInFlight;
  }

  const operation = loadOrCreateBrowserSessionId();
  browserSessionIdentityInFlight = operation;
  void operation.then(
    () => {
      if (browserSessionIdentityInFlight === operation) {
        browserSessionIdentityInFlight = undefined;
      }
    },
    () => {
      if (browserSessionIdentityInFlight === operation) {
        browserSessionIdentityInFlight = undefined;
      }
    },
  );
  return operation;
}

function parsePendingItem(value: unknown): PendingItem | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "snapshot" && value.kind !== "content")
  ) {
    return undefined;
  }

  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0
  ) {
    return undefined;
  }

  const metadata = {
    attempts: value.attempts as number,
    createdAt: value.createdAt,
    id: value.id,
  };
  let pending: PendingItem;

  if (value.kind === "content") {
    const payload = ingestContentSchema.safeParse(value.payload);

    if (!payload.success) {
      return undefined;
    }

    pending = { ...metadata, kind: "content", payload: payload.data };
  } else {
    const payload = ingestSnapshotSchema.safeParse(value.payload);

    if (!payload.success) {
      return undefined;
    }

    pending = { ...metadata, kind: "snapshot", payload: payload.data };
  }

  if (typeof value.lastAttemptAt === "string") {
    pending.lastAttemptAt = value.lastAttemptAt;
  }

  if (typeof value.lastError === "string") {
    pending.lastError = value.lastError;
  }

  return pending;
}

function parseDeadLetter(value: unknown): DeadLetter | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "snapshot" && value.kind !== "content") ||
    typeof value.id !== "string" ||
    typeof value.browser !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.failedAt !== "string" ||
    typeof value.error !== "string" ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 1
  ) {
    return undefined;
  }

  const deadLetter: DeadLetter = {
    attempts: value.attempts as number,
    browser: value.browser,
    createdAt: value.createdAt,
    error: value.error,
    failedAt: value.failedAt,
    id: value.id,
    kind: value.kind,
  };

  if (
    typeof value.statusCode === "number" &&
    Number.isInteger(value.statusCode)
  ) {
    deadLetter.statusCode = value.statusCode;
  }

  if (typeof value.url === "string") {
    deadLetter.url = value.url;
  }

  return deadLetter;
}

function rejectedPendingToDeadLetter(
  value: unknown,
  index: number,
  failedAt: string,
): DeadLetter | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "snapshot" && value.kind !== "content")
  ) {
    return undefined;
  }

  const payload = isRecord(value.payload) ? value.payload : undefined;
  const attempts =
    Number.isInteger(value.attempts) && (value.attempts as number) >= 0
      ? (value.attempts as number) + 1
      : 1;
  const deadLetter: DeadLetter = {
    attempts,
    browser:
      typeof payload?.browser === "string" && payload.browser.length > 0
        ? payload.browser
        : "unknown",
    createdAt:
      typeof value.createdAt === "string" ? value.createdAt : failedAt,
    error:
      "Stored operation was rejected during queue migration because its payload or metadata no longer satisfies the current schema.",
    failedAt,
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `legacy-${value.kind}-${index}`,
    kind: value.kind,
  };

  if (value.kind === "content" && typeof payload?.url === "string") {
    deadLetter.url = payload.url;
  }

  return deadLetter;
}

export async function readQueueState(): Promise<StoredQueueState> {
  const stored = await browser.storage.local.get([
    STORAGE_KEYS.pendingSnapshots,
    STORAGE_KEYS.deadLetters,
  ]);
  const pendingValue = stored[STORAGE_KEYS.pendingSnapshots];
  const deadLetterValue = stored[STORAGE_KEYS.deadLetters];
  const failedAt = new Date().toISOString();
  const rejectedPending: DeadLetter[] = [];

  const pending = Array.isArray(pendingValue)
    ? pendingValue.flatMap((item, index) => {
        const parsed = parsePendingItem(item);

        if (parsed === undefined) {
          const deadLetter = rejectedPendingToDeadLetter(
            item,
            index,
            failedAt,
          );

          if (deadLetter !== undefined) {
            rejectedPending.push(deadLetter);
          }
        }

        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const storedDeadLetters = Array.isArray(deadLetterValue)
    ? deadLetterValue
        .flatMap((item) => {
          const parsed = parseDeadLetter(item);
          return parsed === undefined ? [] : [parsed];
        })
    : [];
  const deadLetters = [...storedDeadLetters, ...rejectedPending].slice(
    -MAX_DEAD_LETTERS,
  );

  return { deadLetters, pending };
}

export async function writeQueueState(
  queue: readonly PendingItem[],
  deadLetters: readonly DeadLetter[],
): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.deadLetters]: deadLetters.slice(-MAX_DEAD_LETTERS),
    [STORAGE_KEYS.pendingSnapshots]: queue,
  });
}

export async function writeIdentityAndQueueState(
  identity: KnownBrowser,
  queue: readonly PendingItem[],
  deadLetters: readonly DeadLetter[],
): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.browser]: identity,
    [STORAGE_KEYS.browserConfigured]: BROWSER_CONFIG_VERSION,
    [STORAGE_KEYS.deadLetters]: deadLetters.slice(-MAX_DEAD_LETTERS),
    [STORAGE_KEYS.pendingSnapshots]: queue,
  });
}
