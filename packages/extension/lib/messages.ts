import { knownBrowserOptions } from "@tabhub/shared";
import {
  parsePhysicalTabCommand,
  type PhysicalTabCloseUndoSummary,
  type PhysicalTabCommand,
  type PhysicalTabCommandResult,
  type PhysicalWindowSummary,
} from "./physical-tab-commands";
import {
  isBrowserSessionId,
  isInstallationId,
  isKnownBrowser,
  type KnownBrowser,
} from "./storage";

export type ExtensionRequest =
  | { type: "tabhub:get-status" }
  | { type: "tabhub:snapshot-now" }
  | { type: "tabhub:capture-current" }
  | { type: "tabhub:capture-all" }
  | { type: "tabhub:browser-changed"; browser: KnownBrowser }
  | { type: "tabhub:app-probe" }
  | {
      browser: KnownBrowser;
      browserSessionId: string;
      installationId: string;
      tabId: number;
      type: "tabhub:app-activate-tab";
    }
  | {
      browser: KnownBrowser;
      browserSessionId: string;
      command: PhysicalTabCommand;
      installationId: string;
      type: "tabhub:app-tab-command";
    };

export type BridgeRequestType =
  | "probe"
  | "activate-tab"
  | "tab-command";

export interface AppProbeData {
  available: true;
  browser: KnownBrowser | null;
  browserSessionId: string;
  controlWindowId: number;
  installationId: string;
  pendingUndos: PhysicalTabCloseUndoSummary[];
  windows: PhysicalWindowSummary[];
}

export interface AppTabActivationData {
  browser: KnownBrowser;
  browserSessionId: string;
  installationId: string;
  tabId: number;
  windowId: number;
}

export interface AppTabCommandData {
  browser: KnownBrowser;
  browserSessionId: string;
  installationId: string;
  result: PhysicalTabCommandResult;
}

export type AppExtensionResponse =
  | { data: AppProbeData; ok: true; type: "probe" }
  | { data: AppTabActivationData; ok: true; type: "activate-tab" }
  | { data: AppTabCommandData; ok: true; type: "tab-command" }
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

export function isAllowedAppMessageSender(
  sender: AppMessageSenderLike,
): boolean {
  const sourceUrl = sender.url ?? sender.tab?.url;

  return isAllowedAppPageUrl(sourceUrl);
}

export function isAllowedAppPageUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
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

  if (type === "tabhub:app-activate-tab") {
    return (
      isKnownBrowser(value.browser) &&
      isBrowserSessionId(value.browserSessionId) &&
      isInstallationId(value.installationId) &&
      Number.isInteger(value.tabId) &&
      (value.tabId as number) >= 0 &&
      hasOnlyKeys(value, [
        "browser",
        "browserSessionId",
        "installationId",
        "tabId",
        "type",
      ])
    );
  }

  if (type === "tabhub:app-tab-command") {
    return (
      isKnownBrowser(value.browser) &&
      isBrowserSessionId(value.browserSessionId) &&
      isInstallationId(value.installationId) &&
      parsePhysicalTabCommand(value.command) !== undefined &&
      hasOnlyKeys(value, [
        "browser",
        "browserSessionId",
        "command",
        "installationId",
        "type",
      ])
    );
  }

  return (
    type === "tabhub:get-status" ||
    type === "tabhub:snapshot-now" ||
    type === "tabhub:capture-current" ||
    type === "tabhub:capture-all"
  );
}
