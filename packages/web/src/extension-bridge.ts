import {
  tabCommandRelayCompatibleProtocolVersionSchema,
  tabCommandRelayLegacyProtocolVersion,
  type TabCommandRelayCompatibleProtocolVersion,
} from "@tabhub/shared";

const BRIDGE_CHANNEL = "tabhub-extension-bridge" as const;
const BRIDGE_VERSION = 4 as const;

type BridgeRequestType =
  | "probe"
  | "activate-tab"
  | "tab-command"
  | "pair";

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
  browserSessionId: string;
  extensionOrigin?: string;
  browser: string | null;
  commandProtocolVersion?: TabCommandRelayCompatibleProtocolVersion;
  controlWindowId: number;
  pendingUndos: CloseUndoSummary[];
  windows: BrowserWindowSummary[];
}

export interface ExtensionProbeUnavailable {
  available: false;
  installationId: null;
  browserSessionId: null;
  browser: null;
  controlWindowId: null;
  pendingUndos: [];
  windows: [];
}

export type ExtensionProbe =
  | ExtensionProbeAvailable
  | ExtensionProbeUnavailable;

export interface BrowserWindowSummary {
  focused: boolean;
  tabCount: number;
  windowId: number;
}

export interface PhysicalTabScope {
  browser: string;
  browserSessionId: string;
  installationId: string;
}

export interface PhysicalTabTarget {
  expectedUrl: string;
  tabId: number;
}

export interface ClosePreviewTarget extends PhysicalTabTarget {
  keeper?: PhysicalTabTarget;
}

export type MoveDestination =
  | { kind: "app-window" }
  | { kind: "new-window" }
  | { kind: "window"; windowId: number };

export type TabCommand =
  | {
      intent?: "explicit-single" | undefined;
      kind: "close-preview";
      targets: ClosePreviewTarget[];
    }
  | { confirmed: true; kind: "close"; previewId: string }
  | { destination: MoveDestination; kind: "move"; targets: PhysicalTabTarget[] }
  | { kind: "set-pinned"; targets: PhysicalTabTarget[]; value: boolean }
  | { kind: "set-muted"; targets: PhysicalTabTarget[]; value: boolean }
  | { kind: "discard"; targets: PhysicalTabTarget[] }
  | { bypassCache?: boolean; kind: "reload"; targets: PhysicalTabTarget[] }
  | { kind: "undo-close"; undoId: string }
  | {
      destination: Extract<MoveDestination, { kind: "app-window" | "new-window" }>;
      kind: "open-workspace";
      tabs: Array<{ muted: boolean; pinned: boolean; url: string }>;
    };

export interface TabCommandRequest extends PhysicalTabScope {
  command: TabCommand;
}

export interface TabCommandSkip {
  reason: string;
  tabId: number;
}

export interface TabCommandFailure {
  error: string;
  tabId: number;
}

export interface CloseUndoSummary {
  count: number;
  expiresAt: number;
  undoId: string;
}

export interface ClosePreviewResult {
  candidateTabIds: number[];
  expiresAt: number;
  kind: "close-preview";
  previewId: string;
  requested: number;
  skipped: TabCommandSkip[];
}

export interface TabMutationResult {
  destinationWindowId?: number;
  failed: TabCommandFailure[];
  kind: "close" | "move" | "set-pinned" | "set-muted" | "discard" | "reload";
  requested: number;
  skipped: TabCommandSkip[];
  succeededTabIds: number[];
  undo?: CloseUndoSummary | null;
}

export interface UndoCloseResult {
  failed: TabCommandFailure[];
  kind: "undo-close";
  requested: number;
  retry?: CloseUndoSummary;
  restoredTabIds: number[];
  skipped: TabCommandSkip[];
}

export interface OpenWorkspaceResult {
  destinationWindowId?: number;
  failed: Array<{ error: string; index: number }>;
  kind: "open-workspace";
  openedTabIds: number[];
  requested: number;
}

export type TabCommandResult =
  | ClosePreviewResult
  | TabMutationResult
  | UndoCloseResult
  | OpenWorkspaceResult;

export interface TabCommandResponse extends PhysicalTabScope {
  result: TabCommandResult;
}

export interface TabActivationTarget {
  browser: string;
  browserSessionId: string;
  installationId: string;
  tabId: number;
}

export interface TabActivationResult extends TabActivationTarget {
  windowId: number;
}

export interface PairingHandover {
  challengeId: string;
  code: string;
  installationId: string;
}

export interface PairingResult {
  installationId: string;
  paired: true;
}

export interface ExtensionBridge {
  probe(): Promise<ExtensionProbe>;
  activate(target: TabActivationTarget): Promise<TabActivationResult>;
  command(request: TabCommandRequest): Promise<TabCommandResponse>;
  pair(handover: PairingHandover): Promise<PairingResult>;
}

interface ExtensionBridgeOptions {
  target: BridgeWindow;
  origin: string;
  requestId?: () => string;
  timeouts?: Partial<
    Record<
      "probe" | "activate" | "close" | "command" | "workspace" | "pair",
      number
    >
  >;
}

type JsonRecord = Record<string, unknown>;

export class ExtensionBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBridgeError";
  }
}

export class ExtensionBridgeRejectedError extends ExtensionBridgeError {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionBridgeRejectedError";
  }
}

export class ExtensionBridgeTimeoutError extends ExtensionBridgeError {
  constructor(type: BridgeRequestType) {
    super(
      type === "activate-tab"
        ? "Tab switching timed out. The outcome is unknown and the switch may still complete."
        : type === "tab-command"
          ? "The browser action timed out. Its outcome is unknown and it may still complete."
        : `TabHub extension did not answer the ${type} request in time.`,
    );
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

function isWindowSummary(value: unknown): value is BrowserWindowSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["focused", "tabCount", "windowId"]) &&
    typeof value.focused === "boolean" &&
    isNonNegativeInteger(value.tabCount) &&
    isNonNegativeInteger(value.windowId)
  );
}

function parsePairing(value: unknown): PairingResult {
  if (
    !isRecord(value) ||
    value.paired !== true ||
    typeof value.installationId !== "string"
  ) {
    throw new ExtensionBridgeError(
      "TabHub extension returned an unreadable pairing result.",
    );
  }
  return { installationId: value.installationId, paired: true };
}

function parseProbe(value: unknown): ExtensionProbeAvailable {
  const commandProtocolVersion =
    isRecord(value) && value.commandProtocolVersion === undefined
      ? tabCommandRelayLegacyProtocolVersion
      : isRecord(value)
        ? tabCommandRelayCompatibleProtocolVersionSchema.safeParse(
            value.commandProtocolVersion,
          ).data
        : undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "available",
      "browser",
      "browserSessionId",
      "commandProtocolVersion",
      "controlWindowId",
      "extensionOrigin",
      "installationId",
      "pendingUndos",
      "windows",
    ]) ||
    value.available !== true ||
    commandProtocolVersion === undefined ||
    typeof value.browserSessionId !== "string" ||
    !uuidPattern.test(value.browserSessionId) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    (value.extensionOrigin !== undefined &&
      (typeof value.extensionOrigin !== "string" ||
        !/^chrome-extension:\/\/[a-z0-9_-]+$/i.test(value.extensionOrigin))) ||
    (value.browser !== null && !isKnownBrowser(value.browser)) ||
    !isNonNegativeInteger(value.controlWindowId) ||
    !Array.isArray(value.pendingUndos) ||
    value.pendingUndos.length > 5 ||
    !value.pendingUndos.every(isCloseUndoSummary) ||
    !Array.isArray(value.windows) ||
    !value.windows.every(isWindowSummary)
  ) {
    throw new ExtensionBridgeError("TabHub extension returned an invalid probe response.");
  }

  return {
    available: true,
    browserSessionId: value.browserSessionId,
    commandProtocolVersion,
    installationId: value.installationId,
    ...(typeof value.extensionOrigin === "string"
      ? { extensionOrigin: value.extensionOrigin }
      : {}),
    browser: value.browser as string | null,
    controlWindowId: value.controlWindowId,
    pendingUndos: value.pendingUndos,
    windows: value.windows,
  };
}

function isTabCommandSkip(value: unknown): value is TabCommandSkip {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["reason", "tabId"]) &&
    typeof value.reason === "string" &&
    isNonNegativeInteger(value.tabId)
  );
}

function isTabCommandFailure(value: unknown): value is TabCommandFailure {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["error", "tabId"]) &&
    typeof value.error === "string" &&
    isNonNegativeInteger(value.tabId)
  );
}

function isCloseUndoSummary(value: unknown): value is CloseUndoSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["count", "expiresAt", "undoId"]) &&
    isNonNegativeInteger(value.count) &&
    isNonNegativeInteger(value.expiresAt) &&
    isPreviewId(value.undoId)
  );
}

function parseTabCommandResult(value: unknown): TabCommandResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ExtensionBridgeError("TabHub extension returned an invalid tab-command result.");
  }

  if (value.kind === "close-preview") {
    if (
      !hasOnlyKeys(value, ["candidateTabIds", "expiresAt", "kind", "previewId", "requested", "skipped"]) ||
      !Array.isArray(value.candidateTabIds) ||
      !value.candidateTabIds.every(isNonNegativeInteger) ||
      !isNonNegativeInteger(value.expiresAt) ||
      !isPreviewId(value.previewId) ||
      !isNonNegativeInteger(value.requested) ||
      !Array.isArray(value.skipped) ||
      !value.skipped.every(isTabCommandSkip)
    ) {
      throw new ExtensionBridgeError("TabHub extension returned an invalid close preview.");
    }
    return value as unknown as ClosePreviewResult;
  }

  if (value.kind === "undo-close") {
    if (
      !hasOnlyKeys(value, ["failed", "kind", "requested", "restoredTabIds", "retry", "skipped"]) ||
      !Array.isArray(value.restoredTabIds) ||
      !value.restoredTabIds.every(isNonNegativeInteger) ||
      !isNonNegativeInteger(value.requested) ||
      !Array.isArray(value.skipped) ||
      !value.skipped.every(isTabCommandSkip) ||
      !Array.isArray(value.failed) ||
      !value.failed.every(isTabCommandFailure) ||
      (value.retry !== undefined && !isCloseUndoSummary(value.retry))
    ) {
      throw new ExtensionBridgeError("TabHub extension returned an invalid close-undo result.");
    }
    return value as unknown as UndoCloseResult;
  }

  if (value.kind === "open-workspace") {
    const isWorkspaceFailure = (failure: unknown) =>
      isRecord(failure) &&
      hasOnlyKeys(failure, ["error", "index"]) &&
      typeof failure.error === "string" &&
      isNonNegativeInteger(failure.index);
    if (
      !hasOnlyKeys(value, ["destinationWindowId", "failed", "kind", "openedTabIds", "requested"]) ||
      (value.destinationWindowId !== undefined && !isNonNegativeInteger(value.destinationWindowId)) ||
      !Array.isArray(value.openedTabIds) ||
      !value.openedTabIds.every(isNonNegativeInteger) ||
      !isNonNegativeInteger(value.requested) ||
      !Array.isArray(value.failed) ||
      !value.failed.every(isWorkspaceFailure)
    ) {
      throw new ExtensionBridgeError("TabHub extension returned an invalid workspace-open result.");
    }
    return value as unknown as OpenWorkspaceResult;
  }

  const mutationKinds = new Set([
    "close",
    "discard",
    "move",
    "reload",
    "set-muted",
    "set-pinned",
  ]);
  if (!mutationKinds.has(value.kind)) {
    throw new ExtensionBridgeError("TabHub extension returned an unknown tab-command result.");
  }
  const allowed = [
    "destinationWindowId",
    "failed",
    "kind",
    "requested",
    "skipped",
    "succeededTabIds",
    "undo",
  ];
  const undoValid =
    value.undo === undefined || value.undo === null ||
    isCloseUndoSummary(value.undo);
  if (
    !hasOnlyKeys(value, allowed) ||
    !isNonNegativeInteger(value.requested) ||
    !Array.isArray(value.succeededTabIds) ||
    !value.succeededTabIds.every(isNonNegativeInteger) ||
    !Array.isArray(value.skipped) ||
    !value.skipped.every(isTabCommandSkip) ||
    !Array.isArray(value.failed) ||
    !value.failed.every(isTabCommandFailure) ||
    (value.destinationWindowId !== undefined && !isNonNegativeInteger(value.destinationWindowId)) ||
    !undoValid
  ) {
    throw new ExtensionBridgeError("TabHub extension returned an invalid mutation receipt.");
  }
  return value as unknown as TabMutationResult;
}

function parseTabCommandResponse(value: unknown): TabCommandResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["browser", "browserSessionId", "installationId", "result"]) ||
    !isKnownBrowser(value.browser) ||
    typeof value.browserSessionId !== "string" ||
    !uuidPattern.test(value.browserSessionId) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId)
  ) {
    throw new ExtensionBridgeError("TabHub extension returned an invalid tab-command response.");
  }
  return {
    browser: value.browser,
    browserSessionId: value.browserSessionId,
    installationId: value.installationId,
    result: parseTabCommandResult(value.result),
  };
}

function parseActivation(value: unknown): TabActivationResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "browser",
      "browserSessionId",
      "installationId",
      "tabId",
      "windowId",
    ]) ||
    !isKnownBrowser(value.browser) ||
    typeof value.browserSessionId !== "string" ||
    !uuidPattern.test(value.browserSessionId) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    !isNonNegativeInteger(value.tabId) ||
    !isNonNegativeInteger(value.windowId)
  ) {
    throw new ExtensionBridgeError(
      "TabHub extension returned an invalid tab-activation result.",
    );
  }

  return {
    browser: value.browser,
    browserSessionId: value.browserSessionId,
    installationId: value.installationId,
    tabId: value.tabId,
    windowId: value.windowId,
  };
}

function activationTarget(target: TabActivationTarget): TabActivationTarget {
  if (
    !isKnownBrowser(target.browser) ||
    !uuidPattern.test(target.browserSessionId) ||
    !uuidPattern.test(target.installationId) ||
    !isNonNegativeInteger(target.tabId)
  ) {
    throw new ExtensionBridgeError("Invalid physical tab activation target.");
  }

  return target;
}

function validateScope(scope: PhysicalTabScope): void {
  if (
    !isKnownBrowser(scope.browser) ||
    !uuidPattern.test(scope.browserSessionId) ||
    !uuidPattern.test(scope.installationId)
  ) {
    throw new ExtensionBridgeError("Invalid physical tab command scope.");
  }
}

function validateTargets(targets: readonly PhysicalTabTarget[]): void {
  if (targets.length < 1) {
    throw new ExtensionBridgeError("Select at least one physical tab.");
  }
  const ids = targets.map(({ tabId }) => tabId);
  if (!ids.every(isNonNegativeInteger) || new Set(ids).size !== ids.length) {
    throw new ExtensionBridgeError("Physical tab targets must contain unique tab IDs.");
  }
  if (targets.some(({ expectedUrl }) => !URL.canParse(expectedUrl))) {
    throw new ExtensionBridgeError("Physical tab targets require their current exact URL.");
  }
}

function validateClosePreviewTargets(
  targets: readonly ClosePreviewTarget[],
): void {
  validateTargets(targets);
  const targetIds = new Set(targets.map(({ tabId }) => tabId));
  for (const target of targets) {
    if (target.keeper === undefined) continue;
    const keeper = target.keeper;
    if (
      !isNonNegativeInteger(keeper.tabId) ||
      !URL.canParse(keeper.expectedUrl) ||
      keeper.tabId === target.tabId ||
      targetIds.has(keeper.tabId) ||
      keeper.expectedUrl !== target.expectedUrl
    ) {
      throw new ExtensionBridgeError(
        "An exact-duplicate close keeper must be a different tab with the same exact URL.",
      );
    }
  }
}

function validatedCommandRequest(request: TabCommandRequest): TabCommandRequest {
  validateScope(request);
  const { command } = request;
  switch (command.kind) {
    case "close-preview":
      validateClosePreviewTargets(command.targets);
      if (
        command.intent === "explicit-single" &&
        command.targets.length !== 1
      ) {
        throw new ExtensionBridgeError(
          "An explicit single close requires exactly one physical tab.",
        );
      }
      break;
    case "close":
      if (!command.confirmed || !isPreviewId(command.previewId)) {
        throw new ExtensionBridgeError("Invalid confirmed close preview.");
      }
      break;
    case "move":
      validateTargets(command.targets);
      if (
        command.destination.kind === "window" &&
        !isNonNegativeInteger(command.destination.windowId)
      ) {
        throw new ExtensionBridgeError("Invalid destination browser window.");
      }
      break;
    case "set-pinned":
    case "set-muted":
      validateTargets(command.targets);
      if (typeof command.value !== "boolean") {
        throw new ExtensionBridgeError("Invalid tab state value.");
      }
      break;
    case "discard":
    case "reload":
      validateTargets(command.targets);
      break;
    case "undo-close":
      if (!isPreviewId(command.undoId)) {
        throw new ExtensionBridgeError("Invalid close undo identifier.");
      }
      break;
    case "open-workspace":
      if (command.tabs.length < 1) {
        throw new ExtensionBridgeError("A workspace must contain at least one tab.");
      }
      if (
        command.tabs.some(
          (tab) =>
            !URL.canParse(tab.url) ||
            typeof tab.pinned !== "boolean" ||
            typeof tab.muted !== "boolean",
        )
      ) {
        throw new ExtensionBridgeError("Invalid workspace tab.");
      }
      break;
  }
  return request;
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
    pair: options.timeouts?.pair ?? 5_000,
    activate: options.timeouts?.activate ?? 5_000,
    close: options.timeouts?.close ?? 10 * 60_000,
    command: options.timeouts?.command ?? 2 * 60_000,
    workspace: options.timeouts?.workspace ?? 10 * 60_000,
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
            new ExtensionBridgeRejectedError(
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
          return {
            available: false,
            browser: null,
            browserSessionId: null,
            controlWindowId: null,
            installationId: null,
            pendingUndos: [],
            windows: [],
          };
        }
        throw error;
      }
    },
    async pair(handover) {
      return request(
        "pair",
        timeouts.pair,
        parsePairing,
        {
          challengeId: handover.challengeId,
          code: handover.code,
          installationId: handover.installationId,
        },
      );
    },
    async activate(target) {
      return request(
        "activate-tab",
        timeouts.activate,
        parseActivation,
        { ...activationTarget(target) },
      );
    },
    command(commandRequest) {
      const validated = validatedCommandRequest(commandRequest);
      return request(
        "tab-command",
        validated.command.kind === "open-workspace"
          ? timeouts.workspace
          : validated.command.kind === "close" ||
              validated.command.kind === "close-preview"
            ? timeouts.close
            : timeouts.command,
        (value) => {
          const response = parseTabCommandResponse(value);
          if (response.result.kind !== validated.command.kind) {
            throw new ExtensionBridgeError(
              "TabHub extension returned a result for a different command.",
            );
          }
          return response;
        },
        {
          browser: validated.browser,
          browserSessionId: validated.browserSessionId,
          command: validated.command,
          installationId: validated.installationId,
        },
      );
    },
  };
}

export function createWindowExtensionBridge(): ExtensionBridge {
  return createExtensionBridge({ target: window, origin: window.location.origin });
}
