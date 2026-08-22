import {
  contextEntryKindSchema,
  contextVisibilitySchema,
  exactTabScopeSchema,
  expectedTabPageSchema,
  knownBrowserOptions,
  tabUrlSchema,
  tabCommandRelayProtocolVersion,
} from "@tabhub/shared";
import {
  parsePhysicalTabCommand,
  type PhysicalTabCloseUndoSummary,
  type PhysicalTabCommand,
  type PhysicalTabCommandContext,
  type PhysicalTabCommandResult,
  type PhysicalTabCommandScope,
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
  | { type: "tabhub:context-features" }
  | { challengeId: string; code: string; type: "tabhub:context-pair" }
  | { type: "tabhub:context-current" }
  | { queueHeadId: string; type: "tabhub:context-discard-stale" }
  | {
      body: string;
      entryKind: import("@tabhub/shared").ContextEntryKind;
      expectedUrl: string;
      idempotencyKey: string;
      scope: "page" | "this_tab";
      targetScope: import("@tabhub/shared").ExactTabScope;
      type: "tabhub:context-save";
      visibility: import("@tabhub/shared").ContextVisibility;
    }
  | {
      contextKind: import("@tabhub/shared").ContextEntryKind;
      idempotencyKey: string;
      intentId: number;
      kind: "archive";
      expectedPage: import("@tabhub/shared").ExpectedTabPage;
      scope: import("@tabhub/shared").ExactTabScope;
      type: "tabhub:context-intent-action";
    }
  | {
      contextKind: import("@tabhub/shared").ContextEntryKind;
      expectedPage: import("@tabhub/shared").ExpectedTabPage;
      idempotencyKey: string;
      intentId: number;
      kind: "promote";
      scope: import("@tabhub/shared").ExactTabScope;
      type: "tabhub:context-intent-action";
    }
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
  commandProtocolVersion?: typeof tabCommandRelayProtocolVersion;
  controlWindowId: number;
  extensionOrigin?: string;
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

export interface ContextPopupData {
  activeTab: { id: number; title: string; url: string } | null;
  browserSessionId: string;
  contextEnabled: boolean;
  installationId: string;
  mutationTarget?: {
    expectedUrl: string;
    scope: import("@tabhub/shared").ExactTabScope;
  };
  pairingRequired: boolean;
  pendingMutationError?:
    | "Pairing required"
    | "Retry required"
    | "Page changed; review required";
  pendingMutationHeadId?: string;
  pendingMutationCount: number;
  sessionIntent?: import("@tabhub/shared").SessionIntentBundle;
}

export type ExtensionResponse =
  | {
      ok: true;
      status: ExtensionStatus;
      capture?: CaptureSummary;
      context?: ContextPopupData;
    }
  | {
      error: string;
      ok: false;
      status: ExtensionStatus;
      capture?: CaptureSummary;
      context?: ContextPopupData;
    };

interface AppMessageSenderLike {
  tab?: { url?: string | undefined } | undefined;
  url?: string | undefined;
}

interface AppPageTabLike {
  id?: number | undefined;
  pendingUrl?: string | undefined;
  url?: string | undefined;
}

interface DirectAppCommandTab {
  id: number;
  windowId: number;
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

export function protectedAppPageTabIds(
  tabs: readonly AppPageTabLike[],
): number[] {
  return tabs.flatMap((tab) =>
    tab.id !== undefined &&
    (isAllowedAppPageUrl(tab.url) || isAllowedAppPageUrl(tab.pendingUrl))
      ? [tab.id]
      : [],
  );
}

export function directAppTabCommandContext(
  currentScope: PhysicalTabCommandScope,
  controlTab: DirectAppCommandTab,
  tabs: readonly AppPageTabLike[],
): PhysicalTabCommandContext {
  return {
    controlTabId: controlTab.id,
    controlWindowId: controlTab.windowId,
    currentScope,
    protectedTabIds: protectedAppPageTabIds(tabs),
  };
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
      (knownBrowserOptions as readonly string[]).includes(requestedBrowser) &&
      hasOnlyKeys(value, ["browser", "type"])
    );
  }

  if (type === "tabhub:app-probe") {
    return hasOnlyKeys(value, ["type"]);
  }

  if (type === "tabhub:context-pair") {
    return (
      typeof value.challengeId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.challengeId,
      ) &&
      typeof value.code === "string" &&
      value.code.length >= 40 &&
      value.code.length <= 128 &&
      hasOnlyKeys(value, ["challengeId", "code", "type"])
    );
  }

  if (type === "tabhub:context-save") {
    return (
      (value.scope === "page" || value.scope === "this_tab") &&
      contextEntryKindSchema.safeParse(value.entryKind).success &&
      contextVisibilitySchema.safeParse(value.visibility).success &&
      exactTabScopeSchema.safeParse(value.targetScope).success &&
      tabUrlSchema.safeParse(value.expectedUrl).success &&
      typeof value.body === "string" &&
      value.body.trim().length > 0 &&
      value.body.length <= 100_000 &&
      typeof value.idempotencyKey === "string" &&
      value.idempotencyKey.trim().length > 0 &&
      value.idempotencyKey.length <= 256 &&
      hasOnlyKeys(value, [
        "body",
        "entryKind",
        "expectedUrl",
        "idempotencyKey",
        "scope",
        "targetScope",
        "type",
        "visibility",
      ])
    );
  }

  if (type === "tabhub:context-discard-stale") {
    return (
      typeof value.queueHeadId === "string" &&
      value.queueHeadId.trim().length > 0 &&
      value.queueHeadId.length <= 128 &&
      hasOnlyKeys(value, ["queueHeadId", "type"])
    );
  }

  if (type === "tabhub:context-intent-action") {
    const commonValid =
      (value.kind === "archive" || value.kind === "promote") &&
      Number.isInteger(value.intentId) &&
      (value.intentId as number) > 0 &&
      contextEntryKindSchema.safeParse(value.contextKind).success &&
      typeof value.idempotencyKey === "string" &&
      value.idempotencyKey.trim().length > 0 &&
      value.idempotencyKey.length <= 256;
    if (!commonValid) return false;
    return (
      exactTabScopeSchema.safeParse(value.scope).success &&
      expectedTabPageSchema.safeParse(value.expectedPage).success &&
      hasOnlyKeys(value, [
        "contextKind",
        "expectedPage",
        "idempotencyKey",
        "intentId",
        "kind",
        "scope",
        "type",
      ])
    );
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
    (type === "tabhub:get-status" ||
      type === "tabhub:snapshot-now" ||
      type === "tabhub:capture-current" ||
      type === "tabhub:capture-all" ||
      type === "tabhub:context-features" ||
      type === "tabhub:context-current") &&
    hasOnlyKeys(value, ["type"])
  );
}
