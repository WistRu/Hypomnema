import {
  tabUrlMaxLength,
  type TabCommandRelayClosePreviewIntent,
} from "@tabhub/shared";

export interface PhysicalTabCommandScope {
  browser: string;
  browserSessionId: string;
  installationId: string;
}

export interface PhysicalTabTarget {
  expectedUrl: string;
  tabId: number;
}

export interface ClosePreviewTarget extends PhysicalTabTarget {
  keeper?: PhysicalTabTarget | undefined;
}

export type ClosePreviewIntent = TabCommandRelayClosePreviewIntent;

export type PhysicalTabMoveDestination =
  | { kind: "app-window" }
  | { kind: "new-window" }
  | { kind: "window"; windowId: number };

export type WorkspaceOpenDestination =
  | { kind: "app-window" }
  | { kind: "new-window" };

export interface WorkspaceTabToOpen {
  muted: boolean;
  pinned: boolean;
  url: string;
}

export type PhysicalTabCommand =
  | {
      kind: "set-pinned";
      targets: PhysicalTabTarget[];
      value: boolean;
    }
  | {
      kind: "set-muted";
      targets: PhysicalTabTarget[];
      value: boolean;
    }
  | {
      kind: "discard";
      targets: PhysicalTabTarget[];
    }
  | {
      bypassCache?: boolean | undefined;
      kind: "reload";
      targets: PhysicalTabTarget[];
    }
  | {
      destination: PhysicalTabMoveDestination;
      kind: "move";
      targets: PhysicalTabTarget[];
    }
  | {
      intent?: ClosePreviewIntent | undefined;
      kind: "close-preview";
      targets: ClosePreviewTarget[];
    }
  | {
      confirmed: true;
      kind: "close";
      previewId: string;
    }
  | {
      kind: "undo-close";
      undoId: string;
    }
  | {
      destination: WorkspaceOpenDestination;
      kind: "open-workspace";
      tabs: WorkspaceTabToOpen[];
    };

export interface ScopedPhysicalTabCommand extends PhysicalTabCommandScope {
  command: PhysicalTabCommand;
}

export interface PhysicalTabCommandContext {
  controlTabId?: number;
  controlWindowId?: number;
  currentScope: PhysicalTabCommandScope;
  protectedTabIds?: readonly number[];
}

export interface PhysicalTabLike {
  active?: boolean | undefined;
  discarded?: boolean | undefined;
  id?: number | undefined;
  index: number;
  mutedInfo?: { muted: boolean } | undefined;
  pendingUrl?: string | undefined;
  pinned?: boolean | undefined;
  title?: string | undefined;
  url?: string | undefined;
  windowId: number;
}

export interface PhysicalWindowLike {
  focused?: boolean | undefined;
  id?: number | undefined;
  tabs?: PhysicalTabLike[] | undefined;
  type?: string | undefined;
}

export interface PhysicalTabCommandAdapter {
  createTab(properties: Record<string, unknown>): Promise<PhysicalTabLike>;
  createWindow(properties: Record<string, unknown>): Promise<PhysicalWindowLike | undefined>;
  discardTab(tabId: number): Promise<PhysicalTabLike | undefined>;
  getTab(tabId: number): Promise<PhysicalTabLike>;
  getWindow(windowId: number): Promise<PhysicalWindowLike>;
  listWindows(): Promise<PhysicalWindowLike[]>;
  moveTabs(
    tabIds: number | number[],
    properties: { index: number; windowId?: number | undefined },
  ): Promise<PhysicalTabLike | PhysicalTabLike[]>;
  reloadTab(tabId: number, properties?: { bypassCache?: boolean }): Promise<void>;
  removeTab(tabId: number): Promise<void>;
  updateTab(
    tabId: number,
    properties: { active?: boolean; muted?: boolean; pinned?: boolean },
  ): Promise<PhysicalTabLike | undefined>;
}

export interface PhysicalTabCommandStorage {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface ExecutorOptions {
  adapter: PhysicalTabCommandAdapter;
  createId?: (() => string) | undefined;
  now?: (() => number) | undefined;
  storage: PhysicalTabCommandStorage;
}

export interface PhysicalTabCommandSkipped {
  reason: string;
  tabId: number;
}

export interface PhysicalTabCommandFailure {
  error: string;
  tabId: number;
}

export interface PhysicalTabMutationResult {
  destinationWindowId?: number | undefined;
  failed: PhysicalTabCommandFailure[];
  kind: PhysicalTabCommand["kind"];
  requested: number;
  skipped: PhysicalTabCommandSkipped[];
  succeededTabIds: number[];
  undo?: PhysicalTabCloseUndoSummary | null | undefined;
}

export interface PhysicalTabCloseUndoSummary {
  count: number;
  expiresAt: number;
  undoId: string;
}

export interface PhysicalTabClosePreviewResult {
  candidateTabIds: number[];
  expiresAt: number;
  kind: "close-preview";
  previewId: string;
  requested: number;
  skipped: PhysicalTabCommandSkipped[];
}

export type PhysicalTabCommandResult =
  | PhysicalTabMutationResult
  | PhysicalTabClosePreviewResult
  | PhysicalTabCloseUndoResult
  | OpenWorkspaceResult;

export interface PhysicalTabCloseUndoResult {
  failed: PhysicalTabCommandFailure[];
  kind: "undo-close";
  requested: number;
  retry?: PhysicalTabCloseUndoSummary;
  restoredTabIds: number[];
  skipped: PhysicalTabCommandSkipped[];
}

export interface OpenWorkspaceResult {
  destinationWindowId?: number | undefined;
  failed: Array<{ error: string; index: number }>;
  kind: "open-workspace";
  openedTabIds: number[];
  requested: number;
}

export interface PhysicalWindowSummary {
  focused: boolean;
  tabCount: number;
  windowId: number;
}

const CLOSE_PREVIEW_TTL_MS = 5 * 60 * 1_000;
const CLOSE_UNDO_TTL_MS = 10 * 60 * 1_000;
const CLOSE_UNDO_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
const CLOSE_UNDO_JOURNAL_MAX_ENTRIES = 5;
const CLOSE_UNDO_TITLE_MAX_LENGTH = 512;
const CLOSE_REMOVE_CONCURRENCY = 8;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generateOpaqueId(createId: () => string): string {
  const id = createId();
  if (!uuidPattern.test(id)) {
    throw new Error("TabHub could not generate a valid opaque id.");
  }
  return id;
}

interface StoredClosePreview extends PhysicalTabCommandScope {
  expiresAt: number;
  intent?: ClosePreviewIntent | undefined;
  previewId: string;
  targets: ClosePreviewTarget[];
  version: 1;
}

interface StoredClosedTab {
  index: number;
  muted: boolean;
  originalTabId: number;
  pinned: boolean;
  title: string | null;
  url: string;
  windowId: number;
}

interface StoredCloseUndo extends PhysicalTabCommandScope {
  expiresAt: number;
  targets: StoredClosedTab[];
  undoId: string;
  version: 1;
}

interface StoredCloseUndoJournal {
  entries: StoredCloseUndo[];
  version: 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function parsePhysicalTabTarget(value: unknown): PhysicalTabTarget | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedUrl", "tabId"]) ||
    !Number.isInteger(value.tabId) ||
    (value.tabId as number) < 0 ||
    typeof value.expectedUrl !== "string" ||
    value.expectedUrl.length === 0 ||
    value.expectedUrl.length > tabUrlMaxLength ||
    value.expectedUrl.trim() !== value.expectedUrl ||
    !URL.canParse(value.expectedUrl)
  ) {
    return undefined;
  }
  return {
    expectedUrl: value.expectedUrl,
    tabId: value.tabId as number,
  };
}

function parsePhysicalTabTargets(
  value: unknown,
): PhysicalTabTarget[] | undefined {
  if (!Array.isArray(value) || value.length < 1) {
    return undefined;
  }
  const targets = value.map(parsePhysicalTabTarget);
  if (targets.some((target) => target === undefined)) return undefined;
  const parsed = targets as PhysicalTabTarget[];
  if (new Set(parsed.map(({ tabId }) => tabId)).size !== parsed.length) {
    return undefined;
  }
  return parsed;
}

function parseClosePreviewTarget(
  value: unknown,
): ClosePreviewTarget | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedUrl", "keeper", "tabId"])
  ) {
    return undefined;
  }
  const target = parsePhysicalTabTarget({
    expectedUrl: value.expectedUrl,
    tabId: value.tabId,
  });
  if (target === undefined) return undefined;
  if (value.keeper === undefined) return target;

  const keeper = parsePhysicalTabTarget(value.keeper);
  if (
    keeper === undefined ||
    keeper.tabId === target.tabId ||
    keeper.expectedUrl !== target.expectedUrl
  ) {
    return undefined;
  }
  return { ...target, keeper };
}

function parseClosePreviewTargets(
  value: unknown,
  minimumLength = 1,
): ClosePreviewTarget[] | undefined {
  if (!Array.isArray(value) || value.length < minimumLength) {
    return undefined;
  }
  const targets = value.map(parseClosePreviewTarget);
  if (targets.some((target) => target === undefined)) return undefined;
  const parsed = targets as ClosePreviewTarget[];
  const targetIds = new Set(parsed.map(({ tabId }) => tabId));
  if (
    targetIds.size !== parsed.length ||
    parsed.some(
      ({ keeper }) => keeper !== undefined && targetIds.has(keeper.tabId),
    )
  ) {
    return undefined;
  }
  return parsed;
}

function parseMoveDestination(
  value: unknown,
): PhysicalTabMoveDestination | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "app-window" || value.kind === "new-window") {
    return hasOnlyKeys(value, ["kind"])
      ? { kind: value.kind }
      : undefined;
  }
  if (
    value.kind === "window" &&
    hasOnlyKeys(value, ["kind", "windowId"]) &&
    Number.isInteger(value.windowId) &&
    (value.windowId as number) >= 0
  ) {
    return { kind: "window", windowId: value.windowId as number };
  }
  return undefined;
}

function parseWorkspaceTab(value: unknown): WorkspaceTabToOpen | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["muted", "pinned", "url"]) ||
    typeof value.muted !== "boolean" ||
    typeof value.pinned !== "boolean" ||
    typeof value.url !== "string" ||
    value.url.length === 0 ||
    value.url.length > tabUrlMaxLength ||
    value.url.trim() !== value.url ||
    !URL.canParse(value.url)
  ) {
    return undefined;
  }
  return { muted: value.muted, pinned: value.pinned, url: value.url };
}

export function parsePhysicalTabCommand(
  value: unknown,
): PhysicalTabCommand | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;

  if (value.kind === "close-preview") {
    const targets = parseClosePreviewTargets(value.targets);
    if (
      targets === undefined ||
      !hasOnlyKeys(value, ["intent", "kind", "targets"]) ||
      (value.intent !== undefined && value.intent !== "explicit-single") ||
      (value.intent === "explicit-single" && targets.length !== 1)
    ) {
      return undefined;
    }
    return {
      ...(value.intent === "explicit-single"
        ? { intent: value.intent }
        : {}),
      kind: "close-preview",
      targets,
    };
  }

  if (value.kind === "discard") {
    const targets = parsePhysicalTabTargets(value.targets);
    return targets !== undefined && hasOnlyKeys(value, ["kind", "targets"])
      ? { kind: "discard", targets }
      : undefined;
  }

  if (value.kind === "set-pinned" || value.kind === "set-muted") {
    const targets = parsePhysicalTabTargets(value.targets);
    return (
      targets !== undefined &&
      typeof value.value === "boolean" &&
      hasOnlyKeys(value, ["kind", "targets", "value"])
    )
      ? { kind: value.kind, targets, value: value.value }
      : undefined;
  }

  if (value.kind === "reload") {
    const targets = parsePhysicalTabTargets(value.targets);
    return (
      targets !== undefined &&
      (value.bypassCache === undefined ||
        typeof value.bypassCache === "boolean") &&
      hasOnlyKeys(value, ["bypassCache", "kind", "targets"])
    )
      ? {
          kind: "reload",
          targets,
          ...(value.bypassCache === undefined
            ? {}
            : { bypassCache: value.bypassCache }),
        }
      : undefined;
  }

  if (value.kind === "move") {
    const targets = parsePhysicalTabTargets(value.targets);
    const destination = parseMoveDestination(value.destination);
    return (
      targets !== undefined &&
      destination !== undefined &&
      hasOnlyKeys(value, ["destination", "kind", "targets"])
    )
      ? { destination, kind: "move", targets }
      : undefined;
  }

  if (value.kind === "close") {
    return value.confirmed === true &&
      typeof value.previewId === "string" &&
      uuidPattern.test(value.previewId) &&
      hasOnlyKeys(value, ["confirmed", "kind", "previewId"])
      ? { confirmed: true, kind: "close", previewId: value.previewId }
      : undefined;
  }

  if (value.kind === "undo-close") {
    return typeof value.undoId === "string" &&
      uuidPattern.test(value.undoId) &&
      hasOnlyKeys(value, ["kind", "undoId"])
      ? { kind: "undo-close", undoId: value.undoId }
      : undefined;
  }

  if (value.kind === "open-workspace") {
    if (
      !hasOnlyKeys(value, ["destination", "kind", "tabs"]) ||
      !Array.isArray(value.tabs) ||
      value.tabs.length < 1 ||
      !isRecord(value.destination) ||
      !hasOnlyKeys(value.destination, ["kind"]) ||
      (value.destination.kind !== "app-window" &&
        value.destination.kind !== "new-window")
    ) {
      return undefined;
    }
    const tabs = value.tabs.map(parseWorkspaceTab);
    return tabs.some((tab) => tab === undefined)
      ? undefined
      : {
          destination: { kind: value.destination.kind },
          kind: "open-workspace",
          tabs: tabs as WorkspaceTabToOpen[],
        };
  }

  return undefined;
}

function parseStoredClosePreview(value: unknown): StoredClosePreview | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "browser",
      "browserSessionId",
      "expiresAt",
      "intent",
      "installationId",
      "previewId",
      "targets",
      "version",
    ]) ||
    typeof value.browser !== "string" ||
    typeof value.browserSessionId !== "string" ||
    !uuidPattern.test(value.browserSessionId) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    typeof value.previewId !== "string" ||
    !uuidPattern.test(value.previewId) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) < 0 ||
    (value.intent !== undefined && value.intent !== "explicit-single") ||
    value.version !== 1 ||
    !Array.isArray(value.targets)
  ) {
    return undefined;
  }
  const targets = parseClosePreviewTargets(value.targets, 0);
  if (
    targets === undefined ||
    (value.intent === "explicit-single" && targets.length !== 1)
  ) {
    return undefined;
  }
  return {
    browser: value.browser,
    browserSessionId: value.browserSessionId,
    expiresAt: value.expiresAt as number,
    ...(value.intent === "explicit-single" ? { intent: value.intent } : {}),
    installationId: value.installationId,
    previewId: value.previewId,
    targets,
    version: 1,
  };
}

function parseStoredClosedTab(value: unknown): StoredClosedTab | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "index",
      "muted",
      "originalTabId",
      "pinned",
      "title",
      "url",
      "windowId",
    ]) ||
    !Number.isInteger(value.originalTabId) ||
    (value.originalTabId as number) < 0 ||
    !Number.isInteger(value.index) ||
    (value.index as number) < 0 ||
    !Number.isInteger(value.windowId) ||
    (value.windowId as number) < 0 ||
    typeof value.muted !== "boolean" ||
    typeof value.pinned !== "boolean" ||
    (value.title !== null &&
      (typeof value.title !== "string" ||
        value.title.length > CLOSE_UNDO_TITLE_MAX_LENGTH)) ||
    typeof value.url !== "string" ||
    value.url.length === 0 ||
    value.url.length > tabUrlMaxLength ||
    value.url.trim() !== value.url ||
    !URL.canParse(value.url)
  ) {
    return undefined;
  }
  return {
    index: value.index as number,
    muted: value.muted,
    originalTabId: value.originalTabId as number,
    pinned: value.pinned,
    title: value.title as string | null,
    url: value.url,
    windowId: value.windowId as number,
  };
}

function parseStoredCloseUndo(value: unknown): StoredCloseUndo | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "browser",
      "browserSessionId",
      "expiresAt",
      "installationId",
      "targets",
      "undoId",
      "version",
    ]) ||
    typeof value.browser !== "string" ||
    typeof value.browserSessionId !== "string" ||
    !uuidPattern.test(value.browserSessionId) ||
    typeof value.installationId !== "string" ||
    !uuidPattern.test(value.installationId) ||
    typeof value.undoId !== "string" ||
    !uuidPattern.test(value.undoId) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) < 0 ||
    value.version !== 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1
  ) {
    return undefined;
  }
  const targets = value.targets.map(parseStoredClosedTab);
  if (targets.some((target) => target === undefined)) return undefined;
  return {
    browser: value.browser,
    browserSessionId: value.browserSessionId,
    expiresAt: value.expiresAt as number,
    installationId: value.installationId,
    targets: targets as StoredClosedTab[],
    undoId: value.undoId,
    version: 1,
  };
}

function undoJournalKey(installationId: string): string {
  return `tabhub:physical-close-undo:${installationId}`;
}

function journalByteLength(entries: StoredCloseUndo[]): number {
  return new TextEncoder().encode(
    JSON.stringify({ entries, version: 2 satisfies StoredCloseUndoJournal["version"] }),
  ).byteLength;
}

function boundedStoredUndoEntries(entries: StoredCloseUndo[]): StoredCloseUndo[] {
  const bounded = entries.slice(0, CLOSE_UNDO_JOURNAL_MAX_ENTRIES);
  while (
    bounded.length > 0 &&
    journalByteLength(bounded) > CLOSE_UNDO_JOURNAL_MAX_BYTES
  ) {
    bounded.pop();
  }
  return bounded;
}

function parseStoredCloseUndoJournal(value: unknown): {
  canonical: boolean;
  entries: StoredCloseUndo[];
} {
  const legacyEntry = parseStoredCloseUndo(value);
  if (legacyEntry !== undefined) {
    return { canonical: false, entries: [legacyEntry] };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["entries", "version"]) ||
    value.version !== 2 ||
    !Array.isArray(value.entries)
  ) {
    return { canonical: value === undefined, entries: [] };
  }

  const parsedEntries = value.entries.map(parseStoredCloseUndo);
  const validEntries = parsedEntries.filter(
    (entry): entry is StoredCloseUndo => entry !== undefined,
  );
  const boundedEntries = boundedStoredUndoEntries(validEntries);
  return {
    canonical:
      parsedEntries.every((entry) => entry !== undefined) &&
      boundedEntries.length === value.entries.length,
    entries: boundedEntries,
  };
}

async function persistUndoJournal(
  storage: PhysicalTabCommandStorage,
  installationId: string,
  entries: StoredCloseUndo[],
): Promise<void> {
  const key = undoJournalKey(installationId);
  if (entries.length === 0) {
    await storage.remove(key);
    return;
  }
  await storage.set({
    [key]: { entries, version: 2 } satisfies StoredCloseUndoJournal,
  });
}

async function readPendingUndoEntries(
  storage: PhysicalTabCommandStorage,
  scope: PhysicalTabCommandScope,
  currentTime: number,
): Promise<StoredCloseUndo[]> {
  const key = undoJournalKey(scope.installationId);
  const stored = await storage.get(key);
  const raw = stored[key];
  const parsed = parseStoredCloseUndoJournal(raw);
  const pending = boundedStoredUndoEntries(
    parsed.entries.filter(
      (entry) => entry.expiresAt > currentTime && sameScope(scope, entry),
    ),
  );
  if (
    raw !== undefined &&
    (!parsed.canonical || pending.length !== parsed.entries.length)
  ) {
    await persistUndoJournal(storage, scope.installationId, pending);
  }
  return pending;
}

function prependUndoEntry(
  entry: StoredCloseUndo,
  existing: StoredCloseUndo[],
): StoredCloseUndo[] {
  const entries = boundedStoredUndoEntries([
    entry,
    ...existing.filter(({ undoId }) => undoId !== entry.undoId),
  ]);
  if (entries[0]?.undoId !== entry.undoId) {
    throw new Error(
      "This close is too large to store a quota-safe Undo journal entry.",
    );
  }
  return entries;
}

async function readableTab(
  adapter: PhysicalTabCommandAdapter,
  tabId: number,
): Promise<PhysicalTabLike | undefined> {
  try {
    const tab = await adapter.getTab(tabId);
    return tab.id === tabId ? tab : undefined;
  } catch {
    return undefined;
  }
}

function currentTabUrl(tab: PhysicalTabLike): string | undefined {
  return tab.pendingUrl?.trim() || tab.url?.trim() || undefined;
}

async function keeperSkipReason(
  adapter: PhysicalTabCommandAdapter,
  keeper: PhysicalTabTarget,
): Promise<"keeper-changed" | "keeper-missing" | undefined> {
  let tab: PhysicalTabLike;
  try {
    tab = await adapter.getTab(keeper.tabId);
  } catch {
    return "keeper-missing";
  }
  if (tab.id !== keeper.tabId) return "keeper-missing";
  return currentTabUrl(tab) === keeper.expectedUrl
    ? undefined
    : "keeper-changed";
}

function sameScope(
  current: PhysicalTabCommandScope,
  requested: PhysicalTabCommandScope,
): boolean {
  return (
    current.browser === requested.browser &&
    current.browserSessionId === requested.browserSessionId &&
    current.installationId === requested.installationId
  );
}

function isProtectedControlTab(
  context: PhysicalTabCommandContext,
  tabId: number,
): boolean {
  return (
    context.controlTabId === tabId ||
    context.protectedTabIds?.includes(tabId) === true
  );
}

export function createPhysicalTabCommandExecutor(options: ExecutorOptions) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());

  return {
    async listPendingUndos(
      currentScope: PhysicalTabCommandScope,
    ): Promise<PhysicalTabCloseUndoSummary[]> {
      const entries = await readPendingUndoEntries(
        options.storage,
        currentScope,
        now(),
      );
      return entries.map(({ expiresAt, targets, undoId }) => ({
        count: targets.length,
        expiresAt,
        undoId,
      }));
    },

    async listWindows(): Promise<PhysicalWindowSummary[]> {
      const windows = await options.adapter.listWindows();
      return windows
        .flatMap((window) =>
          window.type === "normal" &&
          window.id !== undefined &&
          Number.isInteger(window.id) &&
          window.id >= 0
            ? [
                {
                  focused: window.focused === true,
                  tabCount: window.tabs?.length ?? 0,
                  windowId: window.id,
                },
              ]
            : [],
        )
        .sort(
          (left, right) =>
            Number(right.focused) - Number(left.focused) ||
            left.windowId - right.windowId,
        );
    },

    async execute(
      context: PhysicalTabCommandContext,
      request: ScopedPhysicalTabCommand,
    ): Promise<PhysicalTabCommandResult> {
      if (!sameScope(context.currentScope, request)) {
        throw new Error(
          "That command belongs to a different browser installation or session.",
        );
      }

      if (request.command.kind === "close-preview") {
        const skipped: PhysicalTabCommandSkipped[] = [];
        const candidates: ClosePreviewTarget[] = [];

        for (const target of request.command.targets) {
          if (isProtectedControlTab(context, target.tabId)) {
            skipped.push({
              reason: "control-tab-protected",
              tabId: target.tabId,
            });
            continue;
          }

          let tab: PhysicalTabLike;
          try {
            tab = await options.adapter.getTab(target.tabId);
          } catch {
            skipped.push({ reason: "missing", tabId: target.tabId });
            continue;
          }

          if (tab.id !== target.tabId) {
            skipped.push({ reason: "missing", tabId: target.tabId });
          } else if (
            tab.pinned === true &&
            request.command.intent !== "explicit-single"
          ) {
            skipped.push({
              reason: "pinned-protected",
              tabId: target.tabId,
            });
          } else if (currentTabUrl(tab) !== target.expectedUrl) {
            skipped.push({ reason: "url-changed", tabId: target.tabId });
          } else if (target.keeper !== undefined) {
            const reason = await keeperSkipReason(
              options.adapter,
              target.keeper,
            );
            if (reason === undefined) {
              candidates.push(target);
            } else {
              skipped.push({ reason, tabId: target.tabId });
            }
          } else {
            candidates.push(target);
          }
        }

        const previewId = generateOpaqueId(createId);
        const expiresAt = now() + CLOSE_PREVIEW_TTL_MS;
        await options.storage.set({
          [`tabhub:physical-close-preview:${request.installationId}`]: {
            browser: request.browser,
            browserSessionId: request.browserSessionId,
            expiresAt,
            installationId: request.installationId,
            ...(request.command.intent === undefined
              ? {}
              : { intent: request.command.intent }),
            previewId,
            targets: candidates,
            version: 1,
          },
        });

        return {
          candidateTabIds: candidates.map(({ tabId }) => tabId),
          expiresAt,
          kind: "close-preview",
          previewId,
          requested: request.command.targets.length,
          skipped,
        };
      }

      if (request.command.kind === "close") {
        const previewKey =
          `tabhub:physical-close-preview:${request.installationId}`;
        const stored = await options.storage.get(previewKey);
        const preview = parseStoredClosePreview(stored[previewKey]);
        if (
          preview === undefined ||
          preview.previewId !== request.command.previewId ||
          preview.expiresAt < now() ||
          !sameScope(request, preview)
        ) {
          throw new Error(
            "This close preview expired or belongs to a different browser session. Preview again.",
          );
        }

        // A confirmation token is one-shot even if a later browser mutation fails.
        await options.storage.remove(previewKey);

        const result: PhysicalTabMutationResult = {
          failed: [],
          kind: "close",
          requested: preview.targets.length,
          skipped: [],
          succeededTabIds: [],
          undo: null,
        };
        const closable: Array<{
          closedTab: StoredClosedTab;
          keeper?: PhysicalTabTarget | undefined;
        }> = [];

        for (const target of preview.targets) {
          if (isProtectedControlTab(context, target.tabId)) {
            result.skipped.push({
              reason: "control-tab-protected",
              tabId: target.tabId,
            });
            continue;
          }

          let tab: PhysicalTabLike;
          try {
            tab = await options.adapter.getTab(target.tabId);
          } catch {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
            continue;
          }

          if (tab.id !== target.tabId) {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
          } else if (
            tab.pinned === true &&
            preview.intent !== "explicit-single"
          ) {
            result.skipped.push({
              reason: "pinned-protected",
              tabId: target.tabId,
            });
          } else if (currentTabUrl(tab) !== target.expectedUrl) {
            result.skipped.push({ reason: "url-changed", tabId: target.tabId });
          } else {
            closable.push({
              closedTab: {
                index: tab.index,
                muted: tab.mutedInfo?.muted === true,
                originalTabId: target.tabId,
                pinned: tab.pinned === true,
                title: tab.title?.slice(0, CLOSE_UNDO_TITLE_MAX_LENGTH) ?? null,
                url: target.expectedUrl,
                windowId: tab.windowId,
              },
              ...(target.keeper === undefined
                ? {}
                : { keeper: target.keeper }),
            });
          }
        }

        if (closable.length === 0) return result;

        const undoId = generateOpaqueId(createId);
        const undoExpiresAt = now() + CLOSE_UNDO_TTL_MS;
        const undoRecord: StoredCloseUndo = {
          browser: request.browser,
          browserSessionId: request.browserSessionId,
          expiresAt: undoExpiresAt,
          installationId: request.installationId,
          targets: closable.map(({ closedTab }) => closedTab),
          undoId,
          version: 1,
        };

        const pendingUndos = await readPendingUndoEntries(
          options.storage,
          request,
          now(),
        );
        const journalWithProvisionalEntry = prependUndoEntry(
          undoRecord,
          pendingUndos,
        );

        // Durability is established before the first destructive browser call.
        await persistUndoJournal(
          options.storage,
          request.installationId,
          journalWithProvisionalEntry,
        );

        const closedTargets: StoredClosedTab[] = [];
        let durableTargets = undoRecord.targets;
        type CloseRemovalOutcome =
          | { closedTab: StoredClosedTab; kind: "succeeded"; tabId: number }
          | { error: string; kind: "failed"; tabId: number };
        const inFlightRemovals = new Set<Promise<CloseRemovalOutcome>>();
        const orderedRemovals: Array<Promise<CloseRemovalOutcome>> = [];

        for (const { closedTab: target, keeper } of closable) {
          while (inFlightRemovals.size >= CLOSE_REMOVE_CONCURRENCY) {
            await Promise.race(inFlightRemovals);
          }

          let liveTarget: PhysicalTabLike;
          try {
            liveTarget = await options.adapter.getTab(target.originalTabId);
          } catch {
            result.skipped.push({
              reason: "missing",
              tabId: target.originalTabId,
            });
            continue;
          }
          if (liveTarget.id !== target.originalTabId) {
            result.skipped.push({
              reason: "missing",
              tabId: target.originalTabId,
            });
            continue;
          }
          if (
            liveTarget.pinned === true &&
            preview.intent !== "explicit-single"
          ) {
            result.skipped.push({
              reason: "pinned-protected",
              tabId: target.originalTabId,
            });
            continue;
          }
          if (currentTabUrl(liveTarget) !== target.url) {
            result.skipped.push({
              reason: "url-changed",
              tabId: target.originalTabId,
            });
            continue;
          }
          if (keeper !== undefined) {
            const reason = await keeperSkipReason(options.adapter, keeper);
            if (reason !== undefined) {
              result.skipped.push({
                reason,
                tabId: target.originalTabId,
              });
              continue;
            }
          }

          const liveClosedTab: StoredClosedTab = {
            index: liveTarget.index,
            muted: liveTarget.mutedInfo?.muted === true,
            originalTabId: target.originalTabId,
            pinned: liveTarget.pinned === true,
            title:
              liveTarget.title?.slice(0, CLOSE_UNDO_TITLE_MAX_LENGTH) ?? null,
            url: target.url,
            windowId: liveTarget.windowId,
          };
          durableTargets = durableTargets.map((storedTarget) =>
            storedTarget.originalTabId === target.originalTabId
              ? liveClosedTab
              : storedTarget,
          );
          await persistUndoJournal(
            options.storage,
            request.installationId,
            prependUndoEntry(
              { ...undoRecord, targets: durableTargets },
              pendingUndos,
            ),
          );

          const removal = (async (): Promise<CloseRemovalOutcome> => {
            try {
              await options.adapter.removeTab(target.originalTabId);
              return {
                closedTab: liveClosedTab,
                kind: "succeeded",
                tabId: target.originalTabId,
              };
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : String(error),
                kind: "failed",
                tabId: target.originalTabId,
              };
            }
          })();
          let trackedRemoval!: Promise<CloseRemovalOutcome>;
          trackedRemoval = removal.finally(() => {
            inFlightRemovals.delete(trackedRemoval);
          });
          inFlightRemovals.add(trackedRemoval);
          orderedRemovals.push(trackedRemoval);
        }

        for (const removal of await Promise.all(orderedRemovals)) {
          if (removal.kind === "succeeded") {
            closedTargets.push(removal.closedTab);
            result.succeededTabIds.push(removal.tabId);
          } else {
            result.failed.push({
              error: removal.error,
              tabId: removal.tabId,
            });
          }
        }

        if (closedTargets.length === 0) {
          await persistUndoJournal(
            options.storage,
            request.installationId,
            pendingUndos,
          );
        } else {
          await persistUndoJournal(
            options.storage,
            request.installationId,
            prependUndoEntry(
              { ...undoRecord, targets: closedTargets },
              pendingUndos,
            ),
          );
          result.undo = {
            count: closedTargets.length,
            expiresAt: undoExpiresAt,
            undoId,
          };
        }
        return result;
      }

      if (request.command.kind === "undo-close") {
        const requestedUndoId = request.command.undoId;
        const pendingUndos = await readPendingUndoEntries(
          options.storage,
          request,
          now(),
        );
        const undo = pendingUndos.find(
          ({ undoId }) => undoId === requestedUndoId,
        );
        if (undo === undefined) {
          throw new Error(
            "This Undo expired or belongs to a different browser session.",
          );
        }

        const result: PhysicalTabCloseUndoResult = {
          failed: [],
          kind: "undo-close",
          requested: undo.targets.length,
          restoredTabIds: [],
          skipped: [],
        };
        const failedTargets: StoredClosedTab[] = [];
        const missingByWindow = new Map<number, StoredClosedTab[]>();
        for (const target of undo.targets) {
          if (
            (await readableTab(options.adapter, target.originalTabId)) !==
            undefined
          ) {
            result.skipped.push({
              reason: "already-open",
              tabId: target.originalTabId,
            });
            continue;
          }
          const siblings = missingByWindow.get(target.windowId) ?? [];
          siblings.push(target);
          missingByWindow.set(target.windowId, siblings);
        }

        for (const [originalWindowId, targets] of missingByWindow) {
          targets.sort(
            (left, right) =>
              left.index - right.index ||
              left.originalTabId - right.originalTabId,
          );
          let destinationWindowId: number | undefined;
          try {
            const window = await options.adapter.getWindow(originalWindowId);
            if (
              window.id === originalWindowId &&
              (window.type === undefined || window.type === "normal")
            ) {
              destinationWindowId = originalWindowId;
            }
          } catch {
            // A replacement window is created below.
          }

          let remaining = targets;
          if (destinationWindowId === undefined) {
            const first = targets[0]!;
            let createdWindow: PhysicalWindowLike | undefined;
            try {
              createdWindow = await options.adapter.createWindow({
                focused: false,
                url: first.url,
              });
              const createdTab = createdWindow?.tabs?.[0];
              if (
                createdWindow?.id === undefined ||
                createdWindow.id < 0 ||
                createdTab?.id === undefined ||
                createdTab.id < 0
              ) {
                throw new Error("The browser did not create a replacement window.");
              }
              destinationWindowId = createdWindow.id;
              result.restoredTabIds.push(createdTab.id);
              remaining = targets.slice(1);
              const patch: { muted?: boolean; pinned?: boolean } = {};
              if (first.pinned) patch.pinned = true;
              if (first.muted) patch.muted = true;
              if (Object.keys(patch).length > 0) {
                try {
                  await options.adapter.updateTab(createdTab.id, patch);
                } catch (error) {
                  result.failed.push({
                    error: error instanceof Error ? error.message : String(error),
                    tabId: first.originalTabId,
                  });
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failedTargets.push(...targets);
              result.failed.push(
                ...targets.map(({ originalTabId }) => ({
                  error: message,
                  tabId: originalTabId,
                })),
              );
              continue;
            }
          }

          for (const target of remaining) {
            let created: PhysicalTabLike;
            try {
              created = await options.adapter.createTab({
                active: false,
                index: target.index,
                pinned: target.pinned,
                url: target.url,
                windowId: destinationWindowId,
              });
              if (created.id === undefined || created.id < 0) {
                throw new Error("The browser did not restore this tab.");
              }
              result.restoredTabIds.push(created.id);
            } catch (error) {
              failedTargets.push(target);
              result.failed.push({
                error: error instanceof Error ? error.message : String(error),
                tabId: target.originalTabId,
              });
              continue;
            }

            if (target.muted) {
              try {
                await options.adapter.updateTab(created.id!, { muted: true });
              } catch (error) {
                result.failed.push({
                  error: error instanceof Error ? error.message : String(error),
                  tabId: target.originalTabId,
                });
              }
            }
          }
        }

        if (failedTargets.length === 0) {
          await persistUndoJournal(
            options.storage,
            request.installationId,
            pendingUndos.filter(
              ({ undoId }) => undoId !== requestedUndoId,
            ),
          );
        } else {
          await persistUndoJournal(
            options.storage,
            request.installationId,
            pendingUndos.map((entry) =>
              entry.undoId === requestedUndoId
                ? { ...entry, targets: failedTargets }
                : entry,
            ),
          );
          result.retry = {
            count: failedTargets.length,
            expiresAt: undo.expiresAt,
            undoId: undo.undoId,
          };
        }

        return result;
      }

      if (request.command.kind === "open-workspace") {
        const result: OpenWorkspaceResult = {
          failed: [],
          kind: "open-workspace",
          openedTabIds: [],
          requested: request.command.tabs.length,
        };
        let destinationWindowId: number;
        let startIndex = 0;

        if (request.command.destination.kind === "app-window") {
          if (context.controlWindowId === undefined) {
            throw new Error(
              "Opening a workspace in the TabHub window requires a local TabHub page.",
            );
          }
          destinationWindowId = context.controlWindowId;
          const window = await options.adapter.getWindow(destinationWindowId);
          if (
            window.id !== destinationWindowId ||
            (window.type !== undefined && window.type !== "normal")
          ) {
            throw new Error("The TabHub page is not in a normal browser window.");
          }
        } else {
          const first = request.command.tabs[0]!;
          let createdWindow: PhysicalWindowLike | undefined;
          try {
            createdWindow = await options.adapter.createWindow({
              focused: true,
              url: first.url,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failed.push(
              ...request.command.tabs.map((_, index) => ({
                error: message,
                index,
              })),
            );
            return result;
          }
          const createdTab = createdWindow?.tabs?.[0];
          if (
            createdWindow?.id === undefined ||
            createdWindow.id < 0 ||
            createdTab?.id === undefined ||
            createdTab.id < 0
          ) {
            const error = "The browser did not create a workspace window.";
            result.failed.push(
              ...request.command.tabs.map((_, index) => ({ error, index })),
            );
            return result;
          }
          destinationWindowId = createdWindow.id;
          result.destinationWindowId = destinationWindowId;
          result.openedTabIds.push(createdTab.id);
          const patch: { muted?: boolean; pinned?: boolean } = {};
          if (first.pinned) patch.pinned = true;
          if (first.muted) patch.muted = true;
          if (Object.keys(patch).length > 0) {
            try {
              await options.adapter.updateTab(createdTab.id, patch);
            } catch (error) {
              result.failed.push({
                error: error instanceof Error ? error.message : String(error),
                index: 0,
              });
            }
          }
          startIndex = 1;
        }

        result.destinationWindowId = destinationWindowId;
        for (
          let index = startIndex;
          index < request.command.tabs.length;
          index += 1
        ) {
          const tab = request.command.tabs[index]!;
          let created: PhysicalTabLike;
          try {
            created = await options.adapter.createTab({
              active: false,
              pinned: tab.pinned,
              url: tab.url,
              windowId: destinationWindowId,
            });
            if (created.id === undefined || created.id < 0) {
              throw new Error("The browser did not open this workspace tab.");
            }
            result.openedTabIds.push(created.id);
          } catch (error) {
            result.failed.push({
              error: error instanceof Error ? error.message : String(error),
              index,
            });
            continue;
          }
          if (tab.muted) {
            try {
              await options.adapter.updateTab(created.id!, { muted: true });
            } catch (error) {
              result.failed.push({
                error: error instanceof Error ? error.message : String(error),
                index,
              });
            }
          }
        }
        return result;
      }

      const result: PhysicalTabMutationResult = {
        failed: [],
        kind: request.command.kind,
        requested: request.command.targets.length,
        skipped: [],
        succeededTabIds: [],
      };

      if (request.command.kind === "move") {
        const destination = request.command.destination;
        const liveTargets: Array<{
          expectedUrl: string;
          index: number;
          tabId: number;
          windowId: number;
        }> = [];
        for (const target of request.command.targets) {
          let tab: PhysicalTabLike;
          try {
            tab = await options.adapter.getTab(target.tabId);
          } catch {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
            continue;
          }
          if (tab.id !== target.tabId) {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
          } else if (currentTabUrl(tab) !== target.expectedUrl) {
            result.skipped.push({
              reason: "url-changed",
              tabId: target.tabId,
            });
          } else {
            liveTargets.push({
              expectedUrl: target.expectedUrl,
              index: tab.index,
              tabId: target.tabId,
              windowId: tab.windowId,
            });
          }
        }
        if (liveTargets.length === 0) return result;

        if (destination.kind === "new-window") {
          liveTargets.sort(
            (left, right) =>
              left.windowId - right.windowId ||
              left.index - right.index ||
              left.tabId - right.tabId,
          );
          let createdWindow: PhysicalWindowLike | undefined;
          let seedIndex = -1;
          for (let index = 0; index < liveTargets.length; index += 1) {
            const target = liveTargets[index]!;
            let liveTab: PhysicalTabLike;
            try {
              liveTab = await options.adapter.getTab(target.tabId);
            } catch {
              result.skipped.push({ reason: "missing", tabId: target.tabId });
              continue;
            }
            if (liveTab.id !== target.tabId) {
              result.skipped.push({ reason: "missing", tabId: target.tabId });
              continue;
            }
            if (currentTabUrl(liveTab) !== target.expectedUrl) {
              result.skipped.push({
                reason: "url-changed",
                tabId: target.tabId,
              });
              continue;
            }

            seedIndex = index;
            try {
              createdWindow = await options.adapter.createWindow({
                focused: true,
                tabId: target.tabId,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              result.failed.push(
                ...liveTargets.slice(index).map(({ tabId }) => ({
                  error: message,
                  tabId,
                })),
              );
              return result;
            }
            break;
          }
          if (seedIndex < 0) return result;

          if (
            createdWindow?.id === undefined ||
            createdWindow.id < 0 ||
            (createdWindow.type !== undefined && createdWindow.type !== "normal")
          ) {
            const error = "The browser did not create a normal destination window.";
            result.failed.push(
              ...liveTargets.slice(seedIndex).map(({ tabId }) => ({
                error,
                tabId,
              })),
            );
            return result;
          }

          const destinationWindowId = createdWindow.id;
          result.destinationWindowId = destinationWindowId;
          result.succeededTabIds.push(liveTargets[seedIndex]!.tabId);
          const remaining = liveTargets.slice(seedIndex + 1);
          for (const target of remaining) {
            let liveTab: PhysicalTabLike;
            try {
              liveTab = await options.adapter.getTab(target.tabId);
            } catch {
              result.skipped.push({ reason: "missing", tabId: target.tabId });
              continue;
            }
            if (liveTab.id !== target.tabId) {
              result.skipped.push({ reason: "missing", tabId: target.tabId });
              continue;
            }
            if (currentTabUrl(liveTab) !== target.expectedUrl) {
              result.skipped.push({
                reason: "url-changed",
                tabId: target.tabId,
              });
              continue;
            }

            try {
              const moved = await options.adapter.moveTabs(target.tabId, {
                index: -1,
                windowId: destinationWindowId,
              });
              if (Array.isArray(moved) || moved.id !== target.tabId) {
                throw new Error("The browser did not move this tab.");
              }
              result.succeededTabIds.push(target.tabId);
            } catch (error) {
              result.failed.push({
                error: error instanceof Error ? error.message : String(error),
                tabId: target.tabId,
              });
            }
          }
          return result;
        }

        let destinationWindowId: number;
        if (destination.kind === "app-window") {
          if (context.controlWindowId === undefined) {
            throw new Error(
              "Moving tabs to the TabHub window requires a local TabHub page.",
            );
          }
          destinationWindowId = context.controlWindowId;
        } else {
          destinationWindowId = destination.windowId;
        }
        const destinationWindow = await options.adapter.getWindow(
          destinationWindowId,
        );
        if (
          destinationWindow.id !== destinationWindowId ||
          (destinationWindow.type !== undefined &&
            destinationWindow.type !== "normal")
        ) {
          throw new Error("The destination is not a normal browser window.");
        }

        const movable: PhysicalTabTarget[] = [];
        for (const target of liveTargets) {
          if (target.windowId === destinationWindowId) {
            result.skipped.push({
              reason: "already-in-destination",
              tabId: target.tabId,
            });
          } else {
            movable.push({
              expectedUrl: target.expectedUrl,
              tabId: target.tabId,
            });
          }
        }

        for (const target of movable) {
          let liveTab: PhysicalTabLike;
          try {
            liveTab = await options.adapter.getTab(target.tabId);
          } catch {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
            continue;
          }
          if (liveTab.id !== target.tabId) {
            result.skipped.push({ reason: "missing", tabId: target.tabId });
            continue;
          }
          if (currentTabUrl(liveTab) !== target.expectedUrl) {
            result.skipped.push({ reason: "url-changed", tabId: target.tabId });
            continue;
          }

          try {
            const moved = await options.adapter.moveTabs(target.tabId, {
              index: -1,
              windowId: destinationWindowId,
            });
            if (Array.isArray(moved) || moved.id !== target.tabId) {
              throw new Error("The browser did not move this tab.");
            }
            result.succeededTabIds.push(target.tabId);
          } catch (error) {
            result.failed.push({
              error: error instanceof Error ? error.message : String(error),
              tabId: target.tabId,
            });
          }
        }

        result.destinationWindowId = destinationWindowId;
        return result;
      }

      for (const target of request.command.targets) {
        if (
          request.command.kind === "reload" &&
          isProtectedControlTab(context, target.tabId)
        ) {
          result.skipped.push({
            reason: "control-tab-protected",
            tabId: target.tabId,
          });
          continue;
        }

        let tab: PhysicalTabLike;
        try {
          tab = await options.adapter.getTab(target.tabId);
        } catch {
          result.skipped.push({ reason: "missing", tabId: target.tabId });
          continue;
        }

        if (tab.id !== target.tabId) {
          result.skipped.push({ reason: "missing", tabId: target.tabId });
          continue;
        }
        if (currentTabUrl(tab) !== target.expectedUrl) {
          result.skipped.push({ reason: "url-changed", tabId: target.tabId });
          continue;
        }

        if (request.command.kind === "discard") {
          if (tab.active === true) {
            result.skipped.push({
              reason: "active-protected",
              tabId: target.tabId,
            });
            continue;
          }
          if (tab.discarded === true) {
            result.skipped.push({
              reason: "already-discarded",
              tabId: target.tabId,
            });
            continue;
          }

          try {
            const discarded = await options.adapter.discardTab(target.tabId);
            if (discarded?.id !== target.tabId) {
              throw new Error("The browser did not discard this tab.");
            }
            result.succeededTabIds.push(target.tabId);
          } catch (error) {
            result.failed.push({
              error: error instanceof Error ? error.message : String(error),
              tabId: target.tabId,
            });
          }
          continue;
        }

        if (request.command.kind === "reload") {
          try {
            await options.adapter.reloadTab(target.tabId, {
              bypassCache: request.command.bypassCache ?? false,
            });
            result.succeededTabIds.push(target.tabId);
          } catch (error) {
            result.failed.push({
              error: error instanceof Error ? error.message : String(error),
              tabId: target.tabId,
            });
          }
          continue;
        }

        const alreadyInState =
          request.command.kind === "set-pinned"
            ? tab.pinned === request.command.value
            : tab.mutedInfo?.muted === request.command.value;
        if (alreadyInState) {
          result.skipped.push({
            reason: "already-in-state",
            tabId: target.tabId,
          });
          continue;
        }

        try {
          await options.adapter.updateTab(
            target.tabId,
            request.command.kind === "set-pinned"
              ? { pinned: request.command.value }
              : { muted: request.command.value },
          );
          result.succeededTabIds.push(target.tabId);
        } catch (error) {
          result.failed.push({
            error: error instanceof Error ? error.message : String(error),
            tabId: target.tabId,
          });
        }
      }

      return result;
    },
  };
}
