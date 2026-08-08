import {
  browserIdentifierSchema,
  ingestContentSchema,
  ingestSnapshotSchema,
  knownBrowserOptions,
  type BrowserIdentifier,
} from "@tabhub/shared";
import { browser } from "wxt/browser";

import { STORAGE_KEYS } from "./constants";
import type { PendingItem } from "./queue";

export type KnownBrowser = (typeof knownBrowserOptions)[number];

const knownBrowsers = new Set<string>(knownBrowserOptions);
const defaultBrowser: KnownBrowser = "chrome";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isKnownBrowser(value: unknown): value is KnownBrowser {
  return typeof value === "string" && knownBrowsers.has(value);
}

export async function getBrowserIdentifier(): Promise<BrowserIdentifier> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.browser);
  const parsed = browserIdentifierSchema.safeParse(stored[STORAGE_KEYS.browser]);

  return parsed.success && isKnownBrowser(parsed.data)
    ? parsed.data
    : defaultBrowser;
}

export async function ensureBrowserIdentifier(): Promise<BrowserIdentifier> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.browser);
  const storedBrowser = stored[STORAGE_KEYS.browser];

  if (isKnownBrowser(storedBrowser)) {
    return storedBrowser;
  }

  await setBrowserIdentifier(defaultBrowser);
  return defaultBrowser;
}

export async function setBrowserIdentifier(value: KnownBrowser): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.browser]: value });
}

function parsePendingItem(value: unknown): PendingItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = value.kind === "content" ? "content" : "snapshot";

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

  if (kind === "content") {
    const payload = ingestContentSchema.safeParse(value.payload);

    if (!payload.success) {
      return undefined;
    }

    pending = { ...metadata, kind, payload: payload.data };
  } else {
    const payload = ingestSnapshotSchema.safeParse(value.payload);

    if (!payload.success) {
      return undefined;
    }

    pending = { ...metadata, kind, payload: payload.data };
  }

  if (typeof value.lastAttemptAt === "string") {
    pending.lastAttemptAt = value.lastAttemptAt;
  }

  if (typeof value.lastError === "string") {
    pending.lastError = value.lastError;
  }

  return pending;
}

export async function readPendingItems(): Promise<PendingItem[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.pendingSnapshots);
  const value = stored[STORAGE_KEYS.pendingSnapshots];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const parsed = parsePendingItem(item);
    return parsed === undefined ? [] : [parsed];
  });
}

export async function writePendingItems(
  queue: readonly PendingItem[],
): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.pendingSnapshots]: queue,
  });
}
