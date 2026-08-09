import { knownBrowserOptions, tabUrlMaxLength } from "@tabhub/shared";

import { isDuplicatePreviewId } from "./duplicate-preview-registry";
import type { KnownBrowser } from "./storage";

export type ExtensionRequest =
  | { type: "tabhub:get-status" }
  | { type: "tabhub:snapshot-now" }
  | { type: "tabhub:capture-current" }
  | { type: "tabhub:capture-all" }
  | { type: "tabhub:browser-changed"; browser: KnownBrowser }
  | { type: "tabhub:app-probe" }
  | {
      type: "tabhub:app-preview-obvious-duplicates";
      urls?: string[];
    }
  | {
      type: "tabhub:app-close-obvious-duplicates";
      confirmed: true;
      previewId: string;
    };

export type BridgeRequestType =
  | "probe"
  | "preview-obvious-duplicates"
  | "close-obvious-duplicates";

export interface AppProbeData {
  available: true;
  browser: KnownBrowser | null;
  installationId: string;
}

export interface AppDuplicatePreviewData {
  browser: KnownBrowser;
  installationId: string;
  previewId: string;
  totalCloseCandidates: number;
  totalGroups: number;
  totalProtected: number;
}

export interface AppDuplicateCloseData {
  browser: KnownBrowser;
  closed: number;
  failed: number;
  installationId: string;
  skipped: number;
}

export type AppExtensionResponse =
  | { data: AppProbeData; ok: true; type: "probe" }
  | {
      data: AppDuplicatePreviewData;
      ok: true;
      type: "preview-obvious-duplicates";
    }
  | {
      data: AppDuplicateCloseData;
      ok: true;
      type: "close-obvious-duplicates";
    }
  | { error: string; ok: false; type: BridgeRequestType };

export interface CaptureSummary {
  captured: number;
  queued: number;
  requested: number;
  skipped: number;
}

export interface ExtensionStatus {
  browserConfigured: boolean;
  deadLetterCount: number;
  lastError?: string;
  pendingOperationCount: number;
  pendingTabCount: number;
  serverReachable: boolean;
}

export type ExtensionResponse =
  | {
      ok: true;
      status: ExtensionStatus;
      capture?: CaptureSummary;
    }
  | {
      error: string;
      ok: false;
      status: ExtensionStatus;
      capture?: CaptureSummary;
    };

interface AppMessageSenderLike {
  tab?: { url?: string | undefined } | undefined;
  url?: string | undefined;
}

const allowedAppOrigins = new Set([
  "http://127.0.0.1:7717",
  "http://localhost:7717",
]);
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isValidBridgeRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

/** `undefined` means omitted; `null` means supplied but invalid. */
export function parseScopedDuplicateUrls(
  value: unknown,
): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    return null;
  }

  const urls: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    if (typeof candidate !== "string") {
      return null;
    }

    const url = candidate.trim();
    if (
      url.length === 0 ||
      url.length > tabUrlMaxLength ||
      !URL.canParse(url) ||
      seen.has(url)
    ) {
      return null;
    }

    urls.push(url);
    seen.add(url);
  }

  return urls;
}

export function isAllowedAppMessageSender(
  sender: AppMessageSenderLike,
): boolean {
  const sourceUrl = sender.url ?? sender.tab?.url;

  if (sourceUrl === undefined) {
    return false;
  }

  try {
    const url = new URL(sourceUrl);
    return (
      allowedAppOrigins.has(url.origin) &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/"))
    );
  } catch {
    return false;
  }
}

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value) || !("type" in value)) {
    return false;
  }

  const { type } = value as { type?: unknown };

  if (type === "tabhub:browser-changed") {
    const requestedBrowser = (value as { browser?: unknown }).browser;
    return (
      typeof requestedBrowser === "string" &&
      (knownBrowserOptions as readonly string[]).includes(requestedBrowser)
    );
  }

  if (type === "tabhub:app-probe") {
    return hasOnlyKeys(value, ["type"]);
  }

  if (type === "tabhub:app-preview-obvious-duplicates") {
    const urls = parseScopedDuplicateUrls(value.urls);
    const urlsValid = value.urls === undefined || urls !== null;

    return (
      urlsValid && hasOnlyKeys(value, ["type", "urls"])
    );
  }

  if (type === "tabhub:app-close-obvious-duplicates") {
    return (
      value.confirmed === true &&
      isDuplicatePreviewId(value.previewId) &&
      hasOnlyKeys(value, ["confirmed", "previewId", "type"])
    );
  }

  return (
    type === "tabhub:get-status" ||
    type === "tabhub:snapshot-now" ||
    type === "tabhub:capture-current" ||
    type === "tabhub:capture-all"
  );
}
