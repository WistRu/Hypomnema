const BRIDGE_CHANNEL = "tabhub-extension-bridge" as const;
const BRIDGE_VERSION = 2 as const;

type BridgeRequestType =
  | "probe"
  | "preview-obvious-duplicates"
  | "close-obvious-duplicates";

interface BridgeWindow {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface ExtensionProbeAvailable {
  available: true;
  installationId: string;
  browser: string | null;
}

export interface ExtensionProbeUnavailable {
  available: false;
  installationId: null;
  browser: null;
}

export type ExtensionProbe =
  | ExtensionProbeAvailable
  | ExtensionProbeUnavailable;

export interface DuplicateClosePreview {
  browser: string;
  installationId: string;
  previewId: string;
  totalGroups: number;
  totalCloseCandidates: number;
  totalProtected: number;
}

export interface DuplicateCloseResult {
  browser: string;
  installationId: string;
  closed: number;
  skipped: number;
  failed: number;
}

export interface ExtensionBridge {
  probe(): Promise<ExtensionProbe>;
  preview(urls?: string[]): Promise<DuplicateClosePreview>;
  close(previewId: string): Promise<DuplicateCloseResult>;
}

interface ExtensionBridgeOptions {
  target: BridgeWindow;
  origin: string;
  requestId?: () => string;
  timeouts?: Partial<Record<"probe" | "preview" | "close", number>>;
}

type JsonRecord = Record<string, unknown>;

export class ExtensionBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBridgeError";
  }
}

export class ExtensionBridgeTimeoutError extends ExtensionBridgeError {
  constructor(type: BridgeRequestType) {
    super(`TabHub extension did not answer the ${type} request in time.`);
    this.name = "ExtensionBridgeTimeoutError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPreviewId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

const knownBrowsers = new Set(["chrome", "edge", "other", "yandex"]);

function isKnownBrowser(value: unknown): value is string {
  return typeof value === "string" && knownBrowsers.has(value);
}

function parseProbe(value: unknown): ExtensionProbeAvailable {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["available", "browser", "installationId"]) ||
    value.available !== true ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    (value.browser !== null && !isKnownBrowser(value.browser))
  ) {
    throw new ExtensionBridgeError("TabHub extension returned an invalid probe response.");
  }

  return {
    available: true,
    installationId: value.installationId,
    browser: value.browser as string | null,
  };
}

function parsePreview(value: unknown): DuplicateClosePreview {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "browser",
      "installationId",
      "previewId",
      "totalCloseCandidates",
      "totalGroups",
      "totalProtected",
    ]) ||
    !isKnownBrowser(value.browser) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    !isPreviewId(value.previewId) ||
    !isNonNegativeInteger(value.totalGroups) ||
    !isNonNegativeInteger(value.totalCloseCandidates) ||
    !isNonNegativeInteger(value.totalProtected)
  ) {
    throw new ExtensionBridgeError(
      "TabHub extension returned an invalid duplicate preview.",
    );
  }

  return {
    browser: value.browser,
    installationId: value.installationId,
    previewId: value.previewId,
    totalGroups: value.totalGroups,
    totalCloseCandidates: value.totalCloseCandidates,
    totalProtected: value.totalProtected,
  };
}

function parseClose(value: unknown): DuplicateCloseResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "browser",
      "closed",
      "failed",
      "installationId",
      "skipped",
    ]) ||
    !isKnownBrowser(value.browser) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    !isNonNegativeInteger(value.closed) ||
    !isNonNegativeInteger(value.skipped) ||
    !isNonNegativeInteger(value.failed)
  ) {
    throw new ExtensionBridgeError(
      "TabHub extension returned an invalid duplicate-close result.",
    );
  }

  return {
    browser: value.browser,
    installationId: value.installationId,
    closed: value.closed,
    skipped: value.skipped,
    failed: value.failed,
  };
}

function scopedUrls(urls: string[] | undefined): string[] | undefined {
  if (urls === undefined) return undefined;
  if (urls.length === 0) {
    throw new ExtensionBridgeError("Select at least one exact URL to close.");
  }

  const distinct = [
    ...new Set(
      urls.map((url) => {
        const trimmed = url.trim();
        if (!URL.canParse(trimmed)) {
          throw new ExtensionBridgeError(`Invalid duplicate URL: ${url}`);
        }
        return trimmed;
      }),
    ),
  ];
  if (distinct.length > 500) {
    throw new ExtensionBridgeError("At most 500 exact duplicate URLs can be closed at once.");
  }
  return distinct;
}

function defaultRequestId(): string {
  return `tabhub-${crypto.randomUUID()}`;
}

export function createExtensionBridge(
  options: ExtensionBridgeOptions,
): ExtensionBridge {
  const makeRequestId = options.requestId ?? defaultRequestId;
  const timeouts = {
    probe: options.timeouts?.probe ?? 2_000,
    preview: options.timeouts?.preview ?? 5_000,
    close: options.timeouts?.close ?? 30_000,
  };

  function request<T>(
    type: BridgeRequestType,
    timeoutMs: number,
    parse: (value: unknown) => T,
    extra: JsonRecord = {},
  ): Promise<T> {
    const requestId = makeRequestId();

    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timeout);
        options.target.removeEventListener("message", onMessage);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== options.target || event.origin !== options.origin) return;
        if (!isRecord(event.data)) return;
        const response = event.data;
        if (
          response.source !== "tabhub-extension" ||
          response.channel !== BRIDGE_CHANNEL ||
          response.version !== BRIDGE_VERSION ||
          response.requestId !== requestId ||
          response.type !== type ||
          typeof response.ok !== "boolean"
        ) {
          return;
        }

        finish();
        if (!response.ok) {
          reject(
            new ExtensionBridgeError(
              typeof response.error === "string"
                ? response.error
                : "TabHub extension rejected the request.",
            ),
          );
          return;
        }

        try {
          resolve(parse(response.data));
        } catch (error) {
          reject(error);
        }
      };

      options.target.addEventListener("message", onMessage);
      timeout = setTimeout(() => {
        options.target.removeEventListener("message", onMessage);
        reject(new ExtensionBridgeTimeoutError(type));
      }, timeoutMs);
      options.target.postMessage(
        {
          source: "tabhub-web",
          channel: BRIDGE_CHANNEL,
          version: BRIDGE_VERSION,
          requestId,
          type,
          ...extra,
        },
        options.origin,
      );
    });
  }

  return {
    async probe() {
      try {
        return await request("probe", timeouts.probe, parseProbe);
      } catch (error) {
        if (error instanceof ExtensionBridgeTimeoutError) {
          return { available: false, installationId: null, browser: null };
        }
        throw error;
      }
    },
    preview(urls) {
      const scoped = scopedUrls(urls);
      return request(
        "preview-obvious-duplicates",
        timeouts.preview,
        parsePreview,
        scoped === undefined ? {} : { urls: scoped },
      );
    },
    close(previewId) {
      if (!isPreviewId(previewId)) {
        throw new ExtensionBridgeError("Invalid duplicate preview identifier.");
      }
      return request(
        "close-obvious-duplicates",
        timeouts.close,
        parseClose,
        {
          confirmed: true,
          previewId,
        },
      );
    },
  };
}

export function createWindowExtensionBridge(): ExtensionBridge {
  return createExtensionBridge({ target: window, origin: window.location.origin });
}
