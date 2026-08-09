import {
  type AppExtensionResponse,
  type BridgeRequestType,
  type ExtensionRequest,
  isValidBridgeRequestId,
  parseScopedDuplicateUrls,
} from "./messages";
import { isDuplicatePreviewId } from "./duplicate-preview-registry";

export const BRIDGE_CHANNEL = "tabhub-extension-bridge" as const;
export const BRIDGE_VERSION = 2 as const;

interface BridgeRequestBase {
  channel: typeof BRIDGE_CHANNEL;
  requestId: string;
  source: "tabhub-web";
  version: typeof BRIDGE_VERSION;
}

export type BridgeRequest = BridgeRequestBase &
  (
    | { type: "probe" }
    | { type: "preview-obvious-duplicates"; urls?: string[] }
    | {
        confirmed: true;
        previewId: string;
        type: "close-obvious-duplicates";
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

  if (
    value.type !== "preview-obvious-duplicates" &&
    value.type !== "close-obvious-duplicates"
  ) {
    return undefined;
  }

  if (value.type === "preview-obvious-duplicates") {
    const urls = parseScopedDuplicateUrls(value.urls);
    if (urls === null) {
      return undefined;
    }

    if (
      !hasOnlyKeys(value, [
        "channel",
        "requestId",
        "source",
        "type",
        "urls",
        "version",
      ])
    ) {
      return undefined;
    }

    return {
      ...base,
      type: "preview-obvious-duplicates",
      ...(urls === undefined ? {} : { urls }),
    };
  }

  if (
    value.confirmed !== true ||
    !isDuplicatePreviewId(value.previewId) ||
    !hasOnlyKeys(value, [
      "channel",
      "confirmed",
      "previewId",
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
    confirmed: true,
    previewId: value.previewId,
    type: "close-obvious-duplicates",
  };
}

export function toAppExtensionRequest(
  request: BridgeRequest,
): Extract<ExtensionRequest, { type: `tabhub:app-${string}` }> {
  switch (request.type) {
    case "probe":
      return { type: "tabhub:app-probe" };
    case "preview-obvious-duplicates":
      return {
        type: "tabhub:app-preview-obvious-duplicates",
        ...(request.urls === undefined ? {} : { urls: request.urls }),
      };
    case "close-obvious-duplicates":
      return {
        confirmed: true,
        previewId: request.previewId,
        type: "tabhub:app-close-obvious-duplicates",
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
    ((response.ok === false && typeof response.error === "string") ||
      (response.ok === true && isRecord(response.data)));
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
