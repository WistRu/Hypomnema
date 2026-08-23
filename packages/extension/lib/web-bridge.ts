import { tabCommandRelayCompatibleProtocolVersionSchema } from "@tabhub/shared";

import {
  type AppExtensionResponse,
  type ExtensionRequest,
  isValidBridgeRequestId,
} from "./messages";
import {
  parsePhysicalTabCommand,
  type PhysicalTabCommand,
} from "./physical-tab-commands";
import {
  isBrowserSessionId,
  isInstallationId,
  isKnownBrowser,
} from "./storage";

export const BRIDGE_CHANNEL = "tabhub-extension-bridge" as const;
export const BRIDGE_VERSION = 4 as const;

interface BridgeRequestBase {
  channel: typeof BRIDGE_CHANNEL;
  requestId: string;
  source: "tabhub-web";
  version: typeof BRIDGE_VERSION;
}

export type BridgeRequest = BridgeRequestBase &
  (
    | { type: "probe" }
    | {
        browser: "chrome" | "edge" | "other" | "yandex";
        browserSessionId: string;
        installationId: string;
        tabId: number;
        type: "activate-tab";
      }
    | {
        browser: "chrome" | "edge" | "other" | "yandex";
        browserSessionId: string;
        command: PhysicalTabCommand;
        installationId: string;
        type: "tab-command";
      }
  );

export type BridgeResponse = {
  channel: typeof BRIDGE_CHANNEL;
  requestId: string;
  source: "tabhub-extension";
  version: typeof BRIDGE_VERSION;
} & AppExtensionResponse;

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

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.source === "tabhub-web" &&
    value.channel === BRIDGE_CHANNEL &&
    value.version === BRIDGE_VERSION &&
    isValidBridgeRequestId(value.requestId)
  );
}

function isValidProbeData(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "available",
    "browser",
    "browserSessionId",
    "commandProtocolVersion",
    "controlWindowId",
    "extensionOrigin",
    "installationId",
    "pendingUndos",
    "windows",
  ])) {
    return false;
  }
  if (
    value.available !== true ||
    !(value.browser === null || isKnownBrowser(value.browser)) ||
    !isBrowserSessionId(value.browserSessionId) ||
    !isInstallationId(value.installationId) ||
    !Number.isInteger(value.controlWindowId) ||
    (value.controlWindowId as number) < 0 ||
    (value.commandProtocolVersion !== undefined &&
      !tabCommandRelayCompatibleProtocolVersionSchema.safeParse(
        value.commandProtocolVersion,
      ).success) ||
    (value.extensionOrigin !== undefined &&
      (typeof value.extensionOrigin !== "string" ||
        !/^chrome-extension:\/\/[a-p]{16,64}$/.test(value.extensionOrigin))) ||
    !Array.isArray(value.pendingUndos) ||
    !Array.isArray(value.windows)
  ) {
    return false;
  }
  return value.pendingUndos.every(
    (item) =>
      isRecord(item) &&
      hasOnlyKeys(item, ["count", "expiresAt", "undoId"]) &&
      Number.isInteger(item.count) &&
      (item.count as number) >= 0 &&
      typeof item.expiresAt === "number" &&
      isInstallationId(item.undoId),
  ) && value.windows.every(
    (item) =>
      isRecord(item) &&
      hasOnlyKeys(item, ["focused", "tabCount", "windowId"]) &&
      typeof item.focused === "boolean" &&
      Number.isInteger(item.tabCount) &&
      (item.tabCount as number) >= 0 &&
      Number.isInteger(item.windowId) &&
      (item.windowId as number) >= 0,
  );
}

export function parseBridgeRequest(value: unknown): BridgeRequest | undefined {
  if (!isRecord(value) || !hasValidEnvelope(value)) {
    return undefined;
  }

  const base: BridgeRequestBase = {
    channel: BRIDGE_CHANNEL,
    requestId: value.requestId as string,
    source: "tabhub-web",
    version: BRIDGE_VERSION,
  };

  if (value.type === "probe") {
    return hasOnlyKeys(value, [
      "channel",
      "requestId",
      "source",
      "type",
      "version",
    ])
      ? { ...base, type: "probe" }
      : undefined;
  }

  if (value.type === "activate-tab") {
    if (
      !isKnownBrowser(value.browser) ||
      !isBrowserSessionId(value.browserSessionId) ||
      !isInstallationId(value.installationId) ||
      !Number.isInteger(value.tabId) ||
      (value.tabId as number) < 0 ||
      !hasOnlyKeys(value, [
        "browser",
        "browserSessionId",
        "channel",
        "installationId",
        "requestId",
        "source",
        "tabId",
        "type",
        "version",
      ])
    ) {
      return undefined;
    }

    return {
      ...base,
      browser: value.browser,
      browserSessionId: value.browserSessionId as string,
      installationId: value.installationId as string,
      tabId: value.tabId as number,
      type: "activate-tab",
    };
  }

  if (value.type === "tab-command") {
    const command = parsePhysicalTabCommand(value.command);
    if (
      !isKnownBrowser(value.browser) ||
      !isBrowserSessionId(value.browserSessionId) ||
      !isInstallationId(value.installationId) ||
      command === undefined ||
      !hasOnlyKeys(value, [
        "browser",
        "browserSessionId",
        "channel",
        "command",
        "installationId",
        "requestId",
        "source",
        "type",
        "version",
      ])
    ) {
      return undefined;
    }

    return {
      ...base,
      browser: value.browser,
      browserSessionId: value.browserSessionId as string,
      command,
      installationId: value.installationId as string,
      type: "tab-command",
    };
  }

  return undefined;
}

export function toAppExtensionRequest(
  request: BridgeRequest,
): Extract<ExtensionRequest, { type: `tabhub:app-${string}` }> {
  switch (request.type) {
    case "probe":
      return { type: "tabhub:app-probe" };
    case "activate-tab":
      return {
        browser: request.browser,
        browserSessionId: request.browserSessionId,
        installationId: request.installationId,
        tabId: request.tabId,
        type: "tabhub:app-activate-tab",
      };
    case "tab-command":
      return {
        browser: request.browser,
        browserSessionId: request.browserSessionId,
        command: request.command,
        installationId: request.installationId,
        type: "tabhub:app-tab-command",
      };
  }
}

export function createBridgeResponse(
  request: BridgeRequest,
  response: unknown,
): BridgeResponse {
  const validResponse =
    isRecord(response) &&
    response.type === request.type &&
    ((response.ok === false &&
      typeof response.error === "string" &&
      hasOnlyKeys(response, ["error", "ok", "type"])) ||
      (response.ok === true &&
        hasOnlyKeys(response, ["data", "ok", "type"]) &&
        (request.type !== "probe" || isValidProbeData(response.data)) &&
        isRecord(response.data)));
  const correlatedResponse: AppExtensionResponse = validResponse
    ? (response as AppExtensionResponse)
    : {
        error: "TabHub extension returned an invalid bridge response.",
        ok: false,
        type: request.type,
      };

  return {
    channel: BRIDGE_CHANNEL,
    requestId: request.requestId,
    source: "tabhub-extension",
    version: BRIDGE_VERSION,
    ...correlatedResponse,
  };
}
