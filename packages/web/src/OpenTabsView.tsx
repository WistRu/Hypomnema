import {
  tabCommandScopeSchema,
  type TabCommandRelayResult,
  type DuplicateGroup,
  type TabCommandRelayCommand,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createWorkspace,
  executeRelayedTabCommand,
  fetchAllDuplicateGroups,
  fetchAllOpenTabs,
  fetchConnectedTabCommandScopes,
  fetchDuplicateGroups,
  fetchOpenTabs,
  isRelayedTabCommandOutcomeUnknown,
  TabCommandRelayClientError,
} from "./api";
import {
  duplicateGroupCloseSelections,
  duplicateGroupDisplayRows,
  duplicateGroupWithKeeper,
  type DuplicateGroupDisplayRole,
} from "./duplicate-group-display";
import { duplicateGroupClosePlan } from "./duplicate-group-close";
import {
  checkDuplicateGroupsCloseAllPreview,
  duplicateGroupsCloseAllPlan,
  duplicateGroupsCloseAllResultMatchesPreview,
  type DuplicateGroupCloseAllBatch,
  type DuplicateGroupsCloseAllPlan,
} from "./duplicate-groups-close-all";
import {
  duplicateGroupsCloseAllRejectedOutcome,
  DuplicateGroupsCloseAllUnknownOutcomeError,
} from "./duplicate-groups-close-all-outcome";
import { DuplicateGroupsCloseAllDialog } from "./DuplicateGroupsCloseAllDialog";
import {
  createWindowExtensionBridge,
  type BrowserWindowSummary,
  type CloseUndoSummary,
  ExtensionBridgeError,
  type ClosePreviewTarget,
  type ClosePreviewResult,
  type ExtensionProbe,
  type MoveDestination,
  type PhysicalTabScope,
  type PhysicalTabTarget,
  type TabCommand,
  type TabCommandResult,
  type TabMutationResult,
} from "./extension-bridge";
import { useI18n, type TranslationParams } from "./i18n";
import { OpenTabBulkToolbar, OpenTabSelectionMenu } from "./OpenTabBulkToolbar";
import { addressedCloseSelection } from "./open-tab-close-routing";
import {
  addressedTabSelection,
  relayedPhysicalCommand,
  sameTabCommandScope,
} from "./open-tab-command-routing";
import {
  tabActivationAvailability,
  type TabActivationAvailability,
} from "./open-tab-activation";
import {
  extraExactCopyPlan,
  reconcileSelectionWithSnapshot,
  removeSucceededPhysicalTabs,
  setSelectedTabs,
  tabsFromHostname,
  tabsOlderThan,
  workspaceSelectionsForTabs,
  type OpenTabSelection,
} from "./open-tab-selection";
import { clampPage, isTrulyEmptyPage } from "./pagination";
import { serializeTabs, type TabExportFormat } from "./tab-export";
import { TabOperationDialog } from "./TabOperationDialog";
import type { WorkspaceCommandTarget } from "./workspace-restore-routing";
import { SavedWorkspacesDrawer } from "./SavedWorkspacesDrawer";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

type Translate = (key: string, params?: TranslationParams) => string;

type ActionFeedback =
  | { count: number; format: TabExportFormat; kind: "copied" }
  | { count: number; kind: "saved-workspace"; name: string };

interface ActionError {
  cause: unknown;
}

interface ScopedBrowserState {
  pendingUndos: CloseUndoSummary[];
  scope: PhysicalTabScope;
  windows: BrowserWindowSummary[];
}

interface DuplicateGroupsCloseAllPreviewBatch {
  batch: DuplicateGroupCloseAllBatch;
  preview: ClosePreviewResult;
}

interface PendingDuplicateGroupsCloseAll {
  blockedCandidateCount: number;
  blockedGroupCount: number;
  expiresAt: number;
  excluded: DuplicateGroupsCloseAllExcludedProfile[];
  plan: DuplicateGroupsCloseAllPlan;
  previews: DuplicateGroupsCloseAllPreviewBatch[];
}

type DuplicateGroupsCloseAllExclusionReason =
  | "changed"
  | "expired"
  | "invalid"
  | "offline"
  | "unavailable";

interface DuplicateGroupsCloseAllExcludedProfile {
  browser: string;
  browserSessionId: string | null;
  candidateCount: number;
  groupCount: number;
  installationId: string;
  reason: DuplicateGroupsCloseAllExclusionReason;
}

type DuplicateGroupsCloseAllScopeReceipt =
  | {
      kind: "known";
      result: TabMutationResult;
      scope: PhysicalTabScope;
    }
  | {
      cause: unknown;
      kind: "failed";
      requested: number;
      scope: PhysicalTabScope;
    }
  | {
      cause: unknown;
      kind: "unknown";
      requested: number;
      scope: PhysicalTabScope;
    };

interface DuplicateGroupsCloseAllReceipt {
  blockedCandidateCount: number;
  blockedGroupCount: number;
  scopes: DuplicateGroupsCloseAllScopeReceipt[];
}

function browserLabel(browser: string, t: Translate): string {
  const label = BROWSER_LABELS[browser] ?? browser;
  return label === "Other" ? t("Other") : label;
}

function duplicateGroupsCloseAllExclusionLabel(
  reason: DuplicateGroupsCloseAllExclusionReason,
  t: Translate,
): string {
  switch (reason) {
    case "offline":
      return t("Browser profile offline");
    case "invalid":
      return t("Stale or incomplete tab snapshot");
    case "expired":
      return t("Live preview expired");
    case "changed":
      return t("Tabs changed during live preview");
    case "unavailable":
      return t("Live preview unavailable");
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname || new URL(url).protocol.replace(":", "");
  } catch {
    return url;
  }
}

function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

function physicalLocation(
  tab: TabInstance,
  t: Translate,
  formatNumber: (value: number) => string,
): string {
  const tabLabel =
    tab.browserTabId === null
      ? t("unknown tab")
      : t("tab {tabId}", { tabId: formatNumber(tab.browserTabId) });
  return t("Window {windowId} | position {position} | {tab}", {
    position: formatNumber(tab.index + 1),
    tab: tabLabel,
    windowId: formatNumber(tab.windowId),
  });
}

function duplicateGroupTitle(group: DuplicateGroup): string {
  const keeper = group.instances.find(
    (instance) => instance.instanceId === group.keeperInstanceId,
  );
  return (
    keeper?.title?.trim() ||
    group.instances.find((instance) => instance.title?.trim())?.title?.trim() ||
    hostname(group.url)
  );
}

function duplicateGroupIdentity(group: DuplicateGroup): string {
  return JSON.stringify([group.browser, group.installationId, group.url]);
}

function compactInstallationId(installationId: string): string {
  return installationId.length <= 12
    ? installationId
    : `${installationId.slice(0, 8)}…`;
}

function physicalTabScopeKey(scope: PhysicalTabScope): string {
  return `${scope.browser}\n${scope.installationId}\n${scope.browserSessionId}`;
}

function relayCommand(command: TabCommand): TabCommandRelayCommand | null {
  return relayedPhysicalCommand(command);
}

function relayedTabCommandResult(
  result: TabCommandRelayResult,
): TabCommandResult {
  if (result.kind === "activate-tab" || result.kind === "get-browser-state") {
    throw new ExtensionBridgeError(
      "The extension returned a result for a different command.",
    );
  }
  if (result.kind === "close-preview") {
    return {
      candidateTabIds: result.candidateTabIds,
      expiresAt: result.expiresAt,
      kind: result.kind,
      previewId: result.previewId,
      requested: result.requested,
      skipped: result.skipped,
    };
  }
  if (result.kind === "close") {
    return {
      failed: result.failed,
      kind: result.kind,
      requested: result.requested,
      skipped: result.skipped,
      succeededTabIds: result.succeededTabIds,
      ...(result.undo === undefined ? {} : { undo: result.undo }),
    };
  }
  if (result.kind === "move") {
    return {
      failed: result.failed,
      kind: result.kind,
      requested: result.requested,
      skipped: result.skipped,
      succeededTabIds: result.succeededTabIds,
      ...(result.destinationWindowId === undefined
        ? {}
        : { destinationWindowId: result.destinationWindowId }),
    };
  }
  if (
    result.kind === "discard" ||
    result.kind === "reload" ||
    result.kind === "set-muted" ||
    result.kind === "set-pinned"
  ) {
    return {
      failed: result.failed,
      kind: result.kind,
      requested: result.requested,
      skipped: result.skipped,
      succeededTabIds: result.succeededTabIds,
    };
  }
  if (result.kind === "undo-close") {
    return {
      failed: result.failed,
      kind: result.kind,
      requested: result.requested,
      restoredTabIds: result.restoredTabIds,
      skipped: result.skipped,
      ...(result.retry === undefined ? {} : { retry: result.retry }),
    };
  }
  return {
    failed: result.failed,
    kind: result.kind,
    openedTabIds: result.openedTabIds,
    requested: result.requested,
    ...(result.destinationWindowId === undefined
      ? {}
      : { destinationWindowId: result.destinationWindowId }),
  };
}

function DuplicateRelationship({
  keeperChoiceDisabled = false,
  keeper,
  onKeepThisCopy,
  role,
}: {
  keeperChoiceDisabled?: boolean;
  keeper: TabInstance;
  onKeepThisCopy?: (() => void) | undefined;
  role: DuplicateGroupDisplayRole;
}) {
  const { formatNumber, t } = useI18n();
  const keeperLocation = physicalLocation(keeper, t, formatNumber);

  if (role === "keeper") {
    return (
      <span className="duplicate-relationship is-keeper">
        <strong>{t("Keep this copy")}</strong>
        <span>{t("Keeper for this exact URL")}</span>
      </span>
    );
  }
  if (role === "duplicate") {
    return (
      <span className="duplicate-relationship is-duplicate">
        <strong>{t("Duplicate of kept copy")}</strong>
        <span>{t("Kept copy: {location}", { location: keeperLocation })}</span>
        {onKeepThisCopy ? (
          <button
            className="duplicate-keeper-choice"
            disabled={keeperChoiceDisabled}
            type="button"
            onClick={onKeepThisCopy}
          >
            {t("Keep this copy instead")}
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <span className="duplicate-relationship is-protected">
      <strong>{t("Protected duplicate")}</strong>
      <span>{t("Pinned; kept copy: {location}", { location: keeperLocation })}</span>
    </span>
  );
}

function SelectionCheckbox({
  checked,
  describedBy,
  disabled = false,
  indeterminate = false,
  label,
  onChange,
  onClick,
}: {
  checked: boolean;
  describedBy?: string | undefined;
  disabled?: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  onClick?: (event: MouseEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      aria-describedby={describedBy}
      aria-label={label}
      checked={checked}
      className="selection-checkbox"
      disabled={disabled}
      ref={ref}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
      onClick={onClick}
    />
  );
}

function unavailableLabel(
  activation: Exclude<TabActivationAvailability, { kind: "ready" }>,
  t: Translate,
): string {
  switch (activation.kind) {
    case "checking":
      return t("Checking extension");
    case "bridge-unavailable":
      return t("Extension unavailable");
    case "identity-unconfigured":
      return t("Identity required");
    case "missing-tab-id":
      return t("Waiting for snapshot");
    case "other-installation":
      return t("Other installation");
    case "waiting-for-current-session":
      return t("Waiting for current session");
  }
}

function mutationKindLabel(kind: TabMutationResult["kind"], t: Translate): string {
  switch (kind) {
    case "close":
      return t("close");
    case "discard":
      return t("discard");
    case "move":
      return t("move");
    case "reload":
      return t("reload");
    case "set-muted":
      return t("set-muted");
    case "set-pinned":
      return t("set-pinned");
  }
}

export function OpenTabRow({
  activation,
  activationError,
  activationInProgress = false,
  isActivating = false,
  tab,
  onActivateTab,
  onSelectedChange,
  onSelectCanonicalTab,
  selectionDisabled = false,
  selected = false,
  duplicateRelationship,
}: {
  activation: TabActivationAvailability;
  activationError?: string | undefined;
  activationInProgress?: boolean | undefined;
  isActivating?: boolean | undefined;
  tab: TabInstance;
  onActivateTab: (tab: TabInstance) => void;
  onSelectedChange?: (selected: boolean) => void;
  onSelectCanonicalTab: (id: number) => void;
  selectionDisabled?: boolean | undefined;
  selected?: boolean;
  duplicateRelationship?:
    | {
        keeper: TabInstance;
        keeperChoiceDisabled?: boolean;
        onKeepThisCopy?: (() => void) | undefined;
        role: DuplicateGroupDisplayRole;
      }
    | undefined;
}) {
  const { formatNumber, t } = useI18n();
  const label = tab.title?.trim() || hostname(tab.url);
  const activationMessage = activation.kind === "ready" ? undefined : activation.message;

  return (
    <tr
      aria-selected={selected}
      className={[
        selected ? "is-selected" : "",
        duplicateRelationship ? `duplicate-instance is-${duplicateRelationship.role}` : "",
      ].filter(Boolean).join(" ") || undefined}
    >
      {onSelectedChange ? (
        <td data-column="select">
          <SelectionCheckbox
            checked={selected}
            disabled={selectionDisabled}
            label={t("Select {tab}", { tab: label })}
            onChange={onSelectedChange}
          />
        </td>
      ) : null}
      <td>
        <div className="physical-tab-title">
          <div className="physical-tab-heading">
            {activation.kind === "ready" ? (
              <button
                aria-label={t("Switch to existing tab: {label}", { label })}
                className="physical-tab-switch"
                disabled={activationInProgress || isActivating}
                title={t("Switch to this existing browser tab")}
                type="button"
                onClick={() => onActivateTab(tab)}
              >
                {label}
              </button>
            ) : (
              <span className="physical-tab-label" title={activationMessage}>
                {label}
              </span>
            )}
            <button
              className="physical-tab-details"
              type="button"
              onClick={() => onSelectCanonicalTab(tab.canonicalTabId)}
            >
              {t("Details")}
            </button>
          </div>
          <span className="physical-tab-url" dir="ltr" title={tab.url}>{tab.url}</span>
          {activation.kind === "ready" ? (
            isActivating ? (
              <span className="physical-tab-action-state">{t("Switching...")}</span>
            ) : null
          ) : (
            <span className="physical-tab-action-state" title={activationMessage}>
              {unavailableLabel(activation, t)}
            </span>
          )}
          {activationError ? (
            <span className="physical-tab-action-error" role="alert">
              {activationError}
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <span className="browser-badge">
          <span
            aria-hidden="true"
            className={`browser-dot browser-${tab.browser.toLowerCase()}`}
          />
          <span>{browserLabel(tab.browser, t)}</span>
        </span>
        <span className="physical-location">
          {physicalLocation(tab, t, formatNumber)}
        </span>
      </td>
      <td>
        <div className="physical-flags">
          {tab.active ? (
            <span className="physical-flag is-active">{t("Active")}</span>
          ) : null}
          {tab.pinned ? (
            <span className="physical-flag is-protected">{t("Pinned")}</span>
          ) : null}
          {tab.audible ? (
            <span className="physical-flag is-audible">{t("Playing")}</span>
          ) : null}
          {tab.muted ? (
            <span className="physical-flag is-muted">{t("Muted")}</span>
          ) : null}
          {tab.discarded ? (
            <span className="physical-flag is-sleeping">{t("Sleeping")}</span>
          ) : null}
          {!tab.active && !tab.pinned && !tab.audible && !tab.muted && !tab.discarded ? (
            <span className="physical-flag">{t("Standard")}</span>
          ) : null}
        </div>
      </td>
      <td>
        {duplicateRelationship ? (
          <DuplicateRelationship {...duplicateRelationship} />
        ) : tab.duplicateGroupSize > 1 ? (
          <span className="duplicate-count">
            {t("{count} exact copies", {
              count: formatNumber(tab.duplicateGroupSize),
              rawCount: tab.duplicateGroupSize,
            })}
          </span>
        ) : (
          <span className="unique-copy">{t("Unique")}</span>
        )}
      </td>
    </tr>
  );
}

export function OpenTabsView({
  onSelectCanonicalTab,
}: {
  onSelectCanonicalTab: (id: number) => void;
}) {
  const { errorMessage, formatNumber, t } = useI18n();
  const [browser, setBrowser] = useState("all");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<OpenTabSelection>(() => new Map());
  const [duplicateKeepers, setDuplicateKeepers] = useState<
    Map<number, PhysicalTabTarget>
  >(() => new Map());
  const [duplicateGroupKeeperOverrides, setDuplicateGroupKeeperOverrides] =
    useState<Map<string, number>>(() => new Map());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionHostname, setSelectionHostname] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState<MoveDestination>({ kind: "app-window" });
  const [pendingDialog, setPendingDialog] = useState<
    | {
        expectedCandidateCount?: number;
        kind: "close";
        preview: ClosePreviewResult;
        scope: PhysicalTabScope;
      }
    | {
        count: number;
        kind: "reload";
        scope: PhysicalTabScope;
        targets: PhysicalTabTarget[];
      }
    | null
  >(null);
  const [pendingDuplicateGroupsCloseAll, setPendingDuplicateGroupsCloseAll] =
    useState<PendingDuplicateGroupsCloseAll | null>(null);
  const [duplicateGroupsCloseAllBusy, setDuplicateGroupsCloseAllBusy] =
    useState(false);
  const [duplicateGroupsCloseAllExpired, setDuplicateGroupsCloseAllExpired] =
    useState(false);
  const [duplicateGroupsCloseAllReceipt, setDuplicateGroupsCloseAllReceipt] =
    useState<DuplicateGroupsCloseAllReceipt | null>(null);
  const [actionResult, setActionResult] = useState<TabCommandResult | null>(null);
  const [actionResultScope, setActionResultScope] = useState<PhysicalTabScope | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const closeWorkspaces = useCallback(() => setWorkspacesOpen(false), []);
  useEffect(() => {
    setDuplicateKeepers((current) => {
      const next = new Map(
        [...current].filter(([instanceId]) => selection.has(instanceId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [selection]);
  const dismissOperationDialog = useCallback(() => setPendingDialog(null), []);
  const dismissDuplicateGroupsCloseAll = useCallback(
    () => setPendingDuplicateGroupsCloseAll(null),
    [],
  );
  useEffect(() => {
    if (pendingDuplicateGroupsCloseAll === null) {
      setDuplicateGroupsCloseAllExpired(false);
      return;
    }
    const delay = pendingDuplicateGroupsCloseAll.expiresAt - Date.now();
    if (delay <= 0) {
      setDuplicateGroupsCloseAllExpired(true);
      return;
    }
    setDuplicateGroupsCloseAllExpired(false);
    const timer = window.setTimeout(
      () => setDuplicateGroupsCloseAllExpired(true),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [pendingDuplicateGroupsCloseAll]);
  const queryClient = useQueryClient();
  const bridge = useMemo(() => createWindowExtensionBridge(), []);
  const q = useDebouncedValue(search, 300).trim();
  const probeQuery = useQuery({
    queryKey: ["extension-bridge", "probe"],
    queryFn: () => bridge.probe(),
    retry: false,
    refetchOnWindowFocus: "always",
    staleTime: 10_000,
  });
  const relayScopesQuery = useQuery({
    queryKey: ["tab-command-relay", "scopes"],
    queryFn: ({ signal }) => fetchConnectedTabCommandScopes(signal),
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
    retry: false,
    staleTime: 3_000,
  });
  const openTabsQuery = useQuery({
    queryKey: ["tab-instances", { browser, page, q }],
    queryFn: ({ signal }) =>
      fetchOpenTabs({ browser, duplicatesOnly: false, page, q }, signal),
    enabled: !duplicatesOnly,
    refetchInterval: 15_000,
  });
  const duplicateGroupsQuery = useQuery({
    queryKey: ["duplicate-groups", { browser, page, q }],
    queryFn: ({ signal }) =>
      fetchDuplicateGroups(
        { browser, page, ...(q ? { q } : {}) },
        signal,
      ),
    enabled: duplicatesOnly,
    refetchInterval: 15_000,
  });
  const physicalCountQuery = useQuery({
    queryKey: ["tab-instances", "physical-total", { browser }],
    queryFn: ({ signal }) =>
      fetchOpenTabs(
        { browser, duplicatesOnly: false, page: 1, q: "" },
        signal,
      ),
    refetchInterval: 15_000,
  });
  const activationProbe: ExtensionProbe | undefined = probeQuery.isError
    ? {
        available: false,
        browser: null,
        browserSessionId: null,
        controlWindowId: null,
        installationId: null,
        pendingUndos: [],
        windows: [],
      }
    : probeQuery.data;
  const parsedCurrentScope = tabCommandScopeSchema.safeParse(
    activationProbe?.available === true && activationProbe.browser !== null
      ? {
          browser: activationProbe.browser,
          browserSessionId: activationProbe.browserSessionId,
          installationId: activationProbe.installationId,
        }
      : null,
  );
  const currentScope: TabCommandScope | null = parsedCurrentScope.success
    ? parsedCurrentScope.data
    : null;
  const connectedCommandScopes = useMemo<TabCommandScope[]>(
    () =>
      (relayScopesQuery.data ?? []).map(
        ({ browser, browserSessionId, installationId }) => ({
          browser,
          browserSessionId,
          installationId,
        }),
      ),
    [relayScopesQuery.data],
  );
  const availableCommandScopes = useMemo<TabCommandScope[]>(() => {
    const direct = tabCommandScopeSchema.safeParse(currentScope);
    const scopes = direct.success
      ? [direct.data, ...connectedCommandScopes]
      : connectedCommandScopes;
    const unique = new Map(
      scopes.map((scope) => [
        `${scope.browser}\n${scope.installationId}\n${scope.browserSessionId}`,
        scope,
      ]),
    );
    return [...unique.values()];
  }, [connectedCommandScopes, currentScope]);
  const workspaceCommandTargets = useMemo<WorkspaceCommandTarget[]>(
    () =>
      availableCommandScopes.map((scope) => ({
        direct: sameTabCommandScope(currentScope, scope),
        label: t("{browser} · installation {id}", {
          browser: browserLabel(scope.browser, t),
          id: compactInstallationId(scope.installationId),
        }),
        scope,
      })),
    [availableCommandScopes, currentScope, t],
  );
  const remoteStateScopes = useMemo(
    () =>
      connectedCommandScopes.filter(
        (scope) => !sameTabCommandScope(currentScope, scope),
      ),
    [connectedCommandScopes, currentScope],
  );
  const remoteStateQueries = useQueries({
    queries: remoteStateScopes.map((scope) => ({
      queryKey: ["tab-command-relay", "browser-state", physicalTabScopeKey(scope)],
      queryFn: async () => {
        const result = await executeRelayedTabCommand({
          ...scope,
          command: { kind: "get-browser-state" },
        });
        if (result.kind !== "get-browser-state") {
          throw new ExtensionBridgeError(
            "The extension returned a result for a different command.",
          );
        }
        return result;
      },
      refetchInterval: 15_000,
      refetchOnWindowFocus: "always" as const,
      retry: false,
      staleTime: 5_000,
    })),
  });
  const browserStates = useMemo<ScopedBrowserState[]>(() => {
    const states: ScopedBrowserState[] = [];
    if (
      currentScope !== null &&
      activationProbe?.available === true &&
      activationProbe.browser !== null
    ) {
      states.push({
        pendingUndos: activationProbe.pendingUndos,
        scope: currentScope,
        windows: activationProbe.windows,
      });
    }
    remoteStateQueries.forEach((query, index) => {
      const state = query.data;
      const scope = remoteStateScopes[index];
      if (scope !== undefined && state?.kind === "get-browser-state") {
        states.push({
          pendingUndos: state.pendingUndos,
          scope,
          windows: state.windows,
        });
      }
    });
    return states;
  }, [activationProbe, currentScope, remoteStateQueries, remoteStateScopes]);
  const selectedCommandPlan = useMemo(
    () => addressedTabSelection(selection, currentScope, connectedCommandScopes),
    [connectedCommandScopes, currentScope, selection],
  );
  const selectedBrowserState =
    selectedCommandPlan.kind === "ready"
      ? browserStates.find((state) =>
          sameTabCommandScope(state.scope, selectedCommandPlan.scope),
        )
      : undefined;
  const selectedCommandScopeKey =
    selectedCommandPlan.kind === "ready"
      ? `${selectedCommandPlan.route}:${physicalTabScopeKey(selectedCommandPlan.scope)}`
      : selectedCommandPlan.kind;
  useEffect(() => {
    setMoveDestination(
      selectedCommandPlan.kind === "ready" &&
        selectedCommandPlan.route === "relay"
        ? { kind: "new-window" }
        : { kind: "app-window" },
    );
  }, [selectedCommandScopeKey]);
  const duplicateGroupActionPlan = useCallback(
    (group: DuplicateGroup) =>
      duplicateGroupClosePlan(
        group,
        activationProbe,
        connectedCommandScopes,
      ),
    [activationProbe, connectedCommandScopes],
  );
  const executeScopedCommand = async (
    command: TabCommand,
    scope: PhysicalTabScope,
  ): Promise<TabCommandResult> => {
    if (sameTabCommandScope(currentScope, scope)) {
      const response = await bridge.command({ ...scope, command });
      if (
        response.browser !== scope.browser ||
        response.browserSessionId !== scope.browserSessionId ||
        response.installationId !== scope.installationId
      ) {
        throw new ExtensionBridgeError(
          "The extension browser session changed during the action.",
        );
      }
      return response.result;
    }

    const addressedCommand = relayCommand(command);
    if (addressedCommand === null) {
      throw new ExtensionBridgeError(
        "This action is unavailable through the connected browser relay.",
      );
    }
    const relayScope = tabCommandScopeSchema.parse(scope);
    const result = relayedTabCommandResult(
      await executeRelayedTabCommand({
        ...relayScope,
        command: addressedCommand,
      }),
    );
    if (result.kind !== command.kind) {
      throw new ExtensionBridgeError(
        "The extension returned a result for a different command.",
      );
    }
    return result;
  };
  const commandMutation = useMutation({
    mutationFn: async ({
      command,
      scope,
    }: {
      command: TabCommand;
      scope: PhysicalTabScope;
    }) => executeScopedCommand(command, scope),
    onMutate: () => {
      setActionError(null);
      setActionFeedback(null);
    },
    onSuccess: async (result, { scope }) => {
      setActionResult(result);
      setActionResultScope(scope);
      if (result.kind === "close") {
        setSelection((current) =>
          removeSucceededPhysicalTabs(
            current,
            scope,
            result.succeededTabIds,
          ),
        );
      }
      if (result.kind !== "close-preview") {
        await Promise.all([
          duplicatesOnly
            ? duplicateGroupsQuery.refetch()
            : openTabsQuery.refetch(),
          physicalCountQuery.refetch(),
          probeQuery.refetch(),
          relayScopesQuery.refetch(),
          queryClient.invalidateQueries({
            queryKey: ["tab-command-relay", "browser-state"],
          }),
          fetchAllOpenTabs({
            browser: "all",
            duplicatesOnly: false,
            q: "",
          })
            .then((snapshot) =>
              setSelection((current) =>
                reconcileSelectionWithSnapshot(current, snapshot),
              ),
            )
            .catch(() => undefined),
        ]);
      }
    },
    onError: (error) => {
      setActionError({ cause: error });
      if (isRelayedTabCommandOutcomeUnknown(error)) {
        setPendingDialog(null);
        void Promise.all([
          duplicateGroupsQuery.refetch(),
          openTabsQuery.refetch(),
          physicalCountQuery.refetch(),
          relayScopesQuery.refetch(),
          probeQuery.refetch(),
          queryClient.invalidateQueries({
            queryKey: ["tab-command-relay", "browser-state"],
          }),
        ]);
      }
    },
  });
  const activationMutation = useMutation({
    mutationFn: async (tab: TabInstance) => {
      const availability = tabActivationAvailability(
        tab,
        activationProbe,
        t,
        connectedCommandScopes,
      );
      if (availability.kind !== "ready") {
        throw new ExtensionBridgeError(availability.message);
      }

      if (availability.route === "direct") {
        const result = await bridge.activate(availability.target);
        if (
          result.browser !== availability.target.browser ||
          result.browserSessionId !== availability.target.browserSessionId ||
          result.installationId !== availability.target.installationId ||
          result.tabId !== availability.target.tabId
        ) {
          throw new ExtensionBridgeError(
            "The extension activated a different physical tab than requested.",
          );
        }
        return result;
      }

      const relayScope = tabCommandScopeSchema.parse({
        browser: availability.target.browser,
        browserSessionId: availability.target.browserSessionId,
        installationId: availability.target.installationId,
      });
      const result = await executeRelayedTabCommand({
        ...relayScope,
        command: {
          kind: "activate-tab",
          tabId: availability.target.tabId,
        },
      });
      if (
        result.kind !== "activate-tab" ||
        result.tabId !== availability.target.tabId
      ) {
        throw new ExtensionBridgeError(
          "The extension activated a different physical tab than requested.",
        );
      }
      return result;
    },
    onError: async () => {
      await Promise.all([
        duplicatesOnly
          ? duplicateGroupsQuery.refetch()
          : openTabsQuery.refetch(),
        physicalCountQuery.refetch(),
        relayScopesQuery.refetch(),
      ]);
    },
  });
  const serverDuplicateGroups = duplicateGroupsQuery.data?.items ?? [];
  const duplicateGroups = serverDuplicateGroups.map((group) => {
    const keeperOverride = duplicateGroupKeeperOverrides.get(
      duplicateGroupIdentity(group),
    );
    return keeperOverride === undefined
      ? group
      : (duplicateGroupWithKeeper(group, keeperOverride) ?? group);
  });
  const tabs = duplicatesOnly
    ? duplicateGroups.flatMap((group) =>
        duplicateGroupDisplayRows(group).map(({ instance }) => instance),
      )
    : (openTabsQuery.data?.items ?? []);
  const visibleDuplicateGroupPlans = duplicateGroups.map((group) => ({
    group,
    plan: duplicateGroupActionPlan(group),
  }));
  const visibleClosableDuplicateGroups = visibleDuplicateGroupPlans.flatMap(
    ({ group, plan }) => (plan.canPreview ? [group] : []),
  );
  const visibleDuplicateSelections = visibleDuplicateGroupPlans.flatMap(
    ({ plan }) => (plan.canPreview ? plan.selections : []),
  );
  const visibleDuplicateSelectedCount = visibleDuplicateSelections.filter(
    ({ candidate, keeper }) => {
      const selectedKeeper = duplicateKeepers.get(candidate.instanceId);
      return (
        selection.has(candidate.instanceId) &&
        keeper.browserTabId !== null &&
        selectedKeeper?.tabId === keeper.browserTabId &&
        selectedKeeper.expectedUrl === keeper.url
      );
    },
  ).length;
  const visibleSelectedCount = duplicatesOnly
    ? visibleDuplicateSelectedCount
    : tabs.filter((tab) => selection.has(tab.instanceId)).length;
  const visibleSelectableCount = duplicatesOnly
    ? visibleDuplicateSelections.length
    : tabs.length;
  const allVisibleSelected =
    visibleSelectableCount > 0 && visibleSelectedCount === visibleSelectableCount;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const selectedTabs = [...selection.values()];
  const updateSelection = useCallback(
    (changedTabs: readonly TabInstance[], selected: boolean) => {
      setSelection((current) => setSelectedTabs(current, changedTabs, selected));
      if (!selected) {
        setDuplicateKeepers((current) => {
          const next = new Map(current);
          for (const tab of changedTabs) next.delete(tab.instanceId);
          return next;
        });
      }
    },
    [],
  );
  const updateDuplicateGroupsSelection = useCallback(
    (groups: readonly DuplicateGroup[], selected: boolean) => {
      const plans = groups.map((group) => ({
        group,
        selections: duplicateGroupCloseSelections(group),
      }));
      const plan = plans.flatMap(({ selections }) => selections);
      const candidates = plan.map(({ candidate }) => candidate);
      const groupInstanceIds = new Set(
        groups.flatMap(({ instances }) =>
          instances.map(({ instanceId }) => instanceId),
        ),
      );
      if (
        selected &&
        (candidates.length === 0 ||
          plans.some(
            ({ group, selections }) =>
              group.candidateInstanceIds.length !== selections.length,
          ) ||
          plan.some(({ keeper }) => keeper.browserTabId === null))
      ) {
        return;
      }

      setSelection((current) => {
        const withoutGroup = new Map(current);
        for (const instanceId of groupInstanceIds) {
          withoutGroup.delete(instanceId);
        }
        return selected
          ? setSelectedTabs(withoutGroup, candidates, true)
          : withoutGroup;
      });
      setDuplicateKeepers((current) => {
        const next = new Map(current);
        for (const instanceId of groupInstanceIds) {
          next.delete(instanceId);
        }
        if (!selected) return next;
        for (const { candidate, keeper } of plan) {
          next.set(candidate.instanceId, {
            expectedUrl: keeper.url,
            tabId: keeper.browserTabId!,
          });
        }
        return next;
      });
    },
    [],
  );
  const updateDuplicateGroupSelection = useCallback(
    (group: DuplicateGroup, selected: boolean) =>
      updateDuplicateGroupsSelection([group], selected),
    [updateDuplicateGroupsSelection],
  );
  const updateDuplicateCandidateSelection = useCallback(
    (
      group: DuplicateGroup,
      candidate: TabInstance,
      keeper: TabInstance,
      selected: boolean,
    ) => {
      const keeperTabId = keeper.browserTabId;
      if (keeperTabId === null) return;
      const protectedIds = new Set([
        group.keeperInstanceId,
        ...group.protectedInstanceIds,
      ]);
      setSelection((current) => {
        const next = new Map(current);
        for (const instanceId of protectedIds) next.delete(instanceId);
        if (selected) next.set(candidate.instanceId, candidate);
        else next.delete(candidate.instanceId);
        return next;
      });
      setDuplicateKeepers((current) => {
        const next = new Map(current);
        for (const instanceId of protectedIds) next.delete(instanceId);
        if (selected) {
          next.set(candidate.instanceId, {
            expectedUrl: keeper.url,
            tabId: keeperTabId,
          });
        } else {
          next.delete(candidate.instanceId);
        }
        return next;
      });
    },
    [],
  );
  const chooseDuplicateGroupKeeper = useCallback(
    (group: DuplicateGroup, keeperInstanceId: number) => {
      const updatedGroup = duplicateGroupWithKeeper(group, keeperInstanceId);
      if (updatedGroup === null) return;

      const groupInstanceIds = new Set(
        group.instances.map(({ instanceId }) => instanceId),
      );
      setSelection((current) => {
        const next = new Map(current);
        for (const instanceId of groupInstanceIds) next.delete(instanceId);
        return next;
      });
      setDuplicateKeepers((current) => {
        const next = new Map(current);
        for (const instanceId of groupInstanceIds) next.delete(instanceId);
        return next;
      });
      setDuplicateGroupKeeperOverrides((current) => {
        const next = new Map(current);
        next.set(duplicateGroupIdentity(group), updatedGroup.keeperInstanceId);
        return next;
      });
    },
    [],
  );
  const clearSelection = useCallback(() => {
    setSelection(new Map());
    setDuplicateKeepers(new Map());
  }, []);
  const loadAllFilteredTabs = () =>
    fetchAllOpenTabs({ browser, duplicatesOnly, q: search.trim() });
  const selectWithLoader = async (loader: () => Promise<TabInstance[]>) => {
    setSelectionBusy(true);
    setActionError(null);
    try {
      const selected = await loader();
      setSelection((current) => setSelectedTabs(current, selected, true));
    } catch (error) {
      setActionError({ cause: error });
    } finally {
      setSelectionBusy(false);
    }
  };
  const selectExactCopies = async (
    filterCandidates: (tabs: TabInstance[]) => TabInstance[] = (tabs) => tabs,
  ) => {
    setSelectionBusy(true);
    setActionError(null);
    try {
      const [filtered, universe] = await Promise.all([
        loadAllFilteredTabs(),
        fetchAllOpenTabs({ browser, duplicatesOnly: false, q: "" }),
      ]);
      const filteredIds = new Set(
        filterCandidates(filtered).map(({ instanceId }) => instanceId),
      );
      const plan = extraExactCopyPlan(universe).filter(
        ({ candidate, keeper }) =>
          filteredIds.has(candidate.instanceId) && keeper.browserTabId !== null,
      );
      const keepersToPreserve = new Set(
        plan.map(({ keeper }) => keeper.instanceId),
      );
      setSelection((current) => {
        const withoutKeepers = new Map(current);
        for (const instanceId of keepersToPreserve) {
          withoutKeepers.delete(instanceId);
        }
        return setSelectedTabs(
          withoutKeepers,
          plan.map(({ candidate }) => candidate),
          true,
        );
      });
      setDuplicateKeepers((current) => {
        const next = new Map(current);
        for (const instanceId of keepersToPreserve) next.delete(instanceId);
        for (const { candidate, keeper } of plan) {
          next.set(candidate.instanceId, {
            expectedUrl: keeper.url,
            tabId: keeper.browserTabId!,
          });
        }
        return next;
      });
    } catch (error) {
      setActionError({ cause: error });
    } finally {
      setSelectionBusy(false);
    }
  };
  const commandTargets =
    selectedCommandPlan.kind === "ready" ? selectedCommandPlan.targets : [];
  const commandScope =
    selectedCommandPlan.kind === "ready" ? selectedCommandPlan.scope : null;
  const controllableCount =
    selectedCommandPlan.kind === "ready" ? selectedCommandPlan.targets.length : 0;
  const commandUsesDirectBridge =
    selectedCommandPlan.kind === "ready" && selectedCommandPlan.route === "direct";
  const commandWindows = selectedBrowserState?.windows ?? [];
  const commandStatus =
    selectedCommandPlan.kind === "ready"
      ? t("{count} selected in {browser} · installation {id}", {
          browser: browserLabel(selectedCommandPlan.scope.browser, t),
          count: formatNumber(selectedCommandPlan.targets.length),
          id: compactInstallationId(selectedCommandPlan.scope.installationId),
          rawCount: selectedCommandPlan.targets.length,
        })
      : selectedCommandPlan.kind === "mixed-scopes"
        ? t(
            "Selection spans multiple browser profiles. Select one profile for browser actions.",
          )
        : selectedCommandPlan.kind === "offline"
          ? t("The selected browser profile is offline.")
          : selectedCommandPlan.kind === "invalid"
            ? t("Waiting for a fresh physical-tab snapshot for this selection.")
            : undefined;
  const effectiveMoveDestination =
    commandUsesDirectBridge || moveDestination.kind !== "app-window"
      ? moveDestination
      : ({ kind: "new-window" } as const);
  const selectedClosePlan = useMemo(
    () =>
      addressedCloseSelection(
        selection,
        duplicateKeepers,
        availableCommandScopes,
      ),
    [availableCommandScopes, duplicateKeepers, selection],
  );
  const closePreviewTargets = selectedClosePlan?.targets ?? [];
  const runCommand = (
    command: TabCommand,
    scope: PhysicalTabScope | null = currentScope,
  ) => {
    if (scope === null) {
      setActionError({
        cause: new ExtensionBridgeError(
          "No single connected browser profile owns every selected tab.",
        ),
      });
      return;
    }
    void commandMutation
      .mutateAsync({ command, scope })
      .catch(() => undefined);
  };
  const undoDuplicateGroupsCloseAllReceipt = (
    scope: PhysicalTabScope,
    undoId: string,
  ) => {
    void commandMutation
      .mutateAsync({ command: { kind: "undo-close", undoId }, scope })
      .then(() =>
        setDuplicateGroupsCloseAllReceipt((current) =>
          current === null
            ? null
            : {
                ...current,
                scopes: current.scopes.map((receipt) =>
                  receipt.kind === "known" &&
                  sameTabCommandScope(receipt.scope, scope) &&
                  receipt.result.undo?.undoId === undoId
                    ? {
                        ...receipt,
                        result: { ...receipt.result, undo: null },
                      }
                    : receipt,
                ),
              },
        ),
      )
      .catch(() => undefined);
  };
  const previewCloseTargets = async (
    targets: ClosePreviewTarget[],
    expectedCandidateCount?: number,
    scope: PhysicalTabScope | null = currentScope,
  ) => {
    if (scope === null) {
      setActionError({
        cause: new ExtensionBridgeError(
          "No single connected browser profile owns every selected tab.",
        ),
      });
      return;
    }
    try {
      const result = await commandMutation.mutateAsync({
        command: {
          kind: "close-preview",
          targets,
        },
        scope,
      });
      if (result.kind === "close-preview") {
        setPendingDialog({
          ...(expectedCandidateCount === undefined
            ? {}
            : { expectedCandidateCount }),
          kind: "close",
          preview: result,
          scope,
        });
      }
    } catch {
      // Mutation state presents the correlated bridge error.
    }
  };
  const previewClose = () =>
    previewCloseTargets(
      closePreviewTargets,
      undefined,
      selectedClosePlan?.scope ?? null,
    );
  const previewDuplicateGroup = async (group: DuplicateGroup) => {
    const action = duplicateGroupActionPlan(group);
    if (!action.canPreview || action.scope === null) return;
    await previewCloseTargets(
      action.targets,
      action.candidates.length,
      action.scope,
    );
  };
  const previewAllDuplicateGroups = async () => {
    if (duplicateGroupsCloseAllBusy) return;
    setDuplicateGroupsCloseAllBusy(true);
    setActionError(null);
    setActionFeedback(null);
    setActionResult(null);
    setDuplicateGroupsCloseAllReceipt(null);
    try {
      const serverGroups = await fetchAllDuplicateGroups({
        browser,
        ...(q ? { q } : {}),
      });
      const groups = serverGroups.map((group) => {
        const keeperOverride = duplicateGroupKeeperOverrides.get(
          duplicateGroupIdentity(group),
        );
        return keeperOverride === undefined
          ? group
          : (duplicateGroupWithKeeper(group, keeperOverride) ?? group);
      });
      const plan = duplicateGroupsCloseAllPlan(
        groups,
        availableCommandScopes,
      );
      const excluded: DuplicateGroupsCloseAllExcludedProfile[] = [];
      const addExcluded = (
        entry: DuplicateGroupsCloseAllExcludedProfile,
      ) => {
        const existing = excluded.find(
          (candidate) =>
            candidate.browser === entry.browser &&
            candidate.browserSessionId === entry.browserSessionId &&
            candidate.installationId === entry.installationId &&
            candidate.reason === entry.reason,
        );
        if (existing === undefined) {
          excluded.push(entry);
        } else {
          existing.candidateCount += entry.candidateCount;
          existing.groupCount += entry.groupCount;
        }
      };
      for (const blocked of plan.blocked) {
        addExcluded({
          browser: blocked.group.browser,
          browserSessionId:
            blocked.scope?.browserSessionId ??
            blocked.group.instances[0]?.browserSessionId ??
            null,
          candidateCount: blocked.candidateCount,
          groupCount: 1,
          installationId: blocked.group.installationId,
          reason: blocked.reason,
        });
      }

      const settled = await Promise.allSettled(
        plan.batches.map(async (batch) => {
          const result = await executeScopedCommand(
            { kind: "close-preview", targets: batch.targets },
            batch.scope,
          );
          if (result.kind !== "close-preview") {
            throw new ExtensionBridgeError(
              "The extension returned a result for a different command.",
            );
          }
          return { batch, preview: result };
        }),
      );

      const previews: DuplicateGroupsCloseAllPreviewBatch[] = [];
      let blockedCandidateCount = plan.counts.blockedCandidates;
      let blockedGroupCount = plan.counts.blockedGroups;
      settled.forEach((outcome, index) => {
        const batch = plan.batches[index]!;
        if (outcome.status === "rejected") {
          blockedCandidateCount += batch.targets.length;
          blockedGroupCount += batch.groups.length;
          addExcluded({
            ...batch.scope,
            candidateCount: batch.targets.length,
            groupCount: batch.groups.length,
            reason:
              outcome.reason instanceof TabCommandRelayClientError &&
              outcome.reason.code === "SCOPE_OFFLINE"
                ? "offline"
                : "unavailable",
          });
          return;
        }
        const check = checkDuplicateGroupsCloseAllPreview(
          batch,
          outcome.value.preview,
        );
        if (check.kind === "blocked") {
          blockedCandidateCount += batch.targets.length;
          blockedGroupCount += batch.groups.length;
          addExcluded({
            ...batch.scope,
            candidateCount: batch.targets.length,
            groupCount: batch.groups.length,
            reason: check.reason === "expired" ? "expired" : "changed",
          });
          return;
        }
        previews.push(outcome.value);
      });

      setPendingDuplicateGroupsCloseAll({
        blockedCandidateCount,
        blockedGroupCount,
        expiresAt:
          previews.length === 0
            ? Date.now()
            : Math.min(...previews.map(({ preview }) => preview.expiresAt)),
        excluded,
        plan,
        previews,
      });
    } catch (error) {
      setActionError({ cause: error });
      await Promise.all([
        duplicateGroupsQuery.refetch(),
        relayScopesQuery.refetch(),
        probeQuery.refetch(),
      ]);
    } finally {
      setDuplicateGroupsCloseAllBusy(false);
    }
  };
  const confirmAllDuplicateGroups = async () => {
    const pending = pendingDuplicateGroupsCloseAll;
    if (pending === null || duplicateGroupsCloseAllBusy) return;
    if (pending.expiresAt <= Date.now()) {
      setDuplicateGroupsCloseAllExpired(true);
      return;
    }

    setDuplicateGroupsCloseAllBusy(true);
    setActionError(null);
    try {
      const settled = await Promise.allSettled(
        pending.previews.map(async ({ preview, batch }) => {
          const result = await executeScopedCommand(
            { confirmed: true, kind: "close", previewId: preview.previewId },
            batch.scope,
          );
          if (
            result.kind !== "close" ||
            !duplicateGroupsCloseAllResultMatchesPreview(preview, result)
          ) {
            throw new DuplicateGroupsCloseAllUnknownOutcomeError(
              "TabHub returned an incomplete close result. The outcome is unknown.",
            );
          }
          return result;
        }),
      );
      const scopes: DuplicateGroupsCloseAllScopeReceipt[] = settled.map(
        (outcome, index) => {
          const batch = pending.previews[index]!.batch;
          if (outcome.status === "fulfilled") {
            return { kind: "known", result: outcome.value, scope: batch.scope };
          }
          const failure = {
            cause: outcome.reason,
            requested: batch.targets.length,
            scope: batch.scope,
          };
          return duplicateGroupsCloseAllRejectedOutcome(outcome.reason) ===
            "unknown"
            ? { ...failure, kind: "unknown" }
            : { ...failure, kind: "failed" };
        },
      );
      setSelection((current) =>
        scopes.reduce(
          (next, receipt) =>
            receipt.kind === "known"
              ? removeSucceededPhysicalTabs(
                  next,
                  receipt.scope,
                  receipt.result.succeededTabIds,
                )
              : next,
          current,
        ),
      );
      setDuplicateGroupsCloseAllReceipt({
        blockedCandidateCount: pending.blockedCandidateCount,
        blockedGroupCount: pending.blockedGroupCount,
        scopes,
      });
      setPendingDuplicateGroupsCloseAll(null);
    } finally {
      try {
        await Promise.all([
          duplicateGroupsQuery.refetch(),
          openTabsQuery.refetch(),
          physicalCountQuery.refetch(),
          probeQuery.refetch(),
          relayScopesQuery.refetch(),
          queryClient.invalidateQueries({
            queryKey: ["tab-command-relay", "browser-state"],
          }),
          fetchAllOpenTabs({
            browser: "all",
            duplicatesOnly: false,
            q: "",
          })
            .then((snapshot) =>
              setSelection((current) =>
                reconcileSelectionWithSnapshot(current, snapshot),
              ),
            )
            .catch(() => undefined),
        ]);
      } finally {
        setDuplicateGroupsCloseAllBusy(false);
      }
    }
  };
  const saveSelectionAsWorkspace = async (closeAfter: boolean) => {
    const name = window.prompt(t("Workspace name"))?.trim();
    if (!name) return;
    setSelectionBusy(true);
    setActionError(null);
    try {
      const workspace = await createWorkspace({
        name,
        selections: workspaceSelectionsForTabs(selectedTabs),
      });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setActionFeedback({
        count: workspace.itemCount,
        kind: "saved-workspace",
        name: workspace.name,
      });
      if (closeAfter) await previewClose();
    } catch (error) {
      setActionError({ cause: error });
    } finally {
      setSelectionBusy(false);
    }
  };
  const copySelection = async (format: TabExportFormat) => {
    try {
      await navigator.clipboard.writeText(serializeTabs(selectedTabs, format));
      setActionFeedback({ count: selectedTabs.length, format, kind: "copied" });
      setActionError(null);
    } catch (error) {
      setActionError({
        cause: error instanceof Error ? error : new Error("Clipboard access failed."),
      });
    }
  };
  const mutationReceipt =
    actionResult && ["close", "discard", "move", "reload", "set-muted", "set-pinned"].includes(actionResult.kind)
      ? (actionResult as TabMutationResult)
      : null;
  const duplicateGroupsCloseAllKnownReceipts =
    duplicateGroupsCloseAllReceipt?.scopes.flatMap((receipt) =>
      receipt.kind === "known" ? [receipt] : [],
    ) ?? [];
  const duplicateGroupsCloseAllSucceeded =
    duplicateGroupsCloseAllKnownReceipts.reduce(
      (total, { result }) => total + result.succeededTabIds.length,
      0,
    );
  const duplicateGroupsCloseAllSkipped =
    duplicateGroupsCloseAllKnownReceipts.reduce(
      (total, { result }) => total + result.skipped.length,
      0,
    );
  const duplicateGroupsCloseAllFailed =
    duplicateGroupsCloseAllKnownReceipts.reduce(
      (total, { result }) => total + result.failed.length,
      0,
    );
  const duplicateGroupsCloseAllUnknown =
    duplicateGroupsCloseAllReceipt?.scopes.filter(
      ({ kind }) => kind === "unknown",
    ).length ?? 0;
  const duplicateGroupsCloseAllNotCompleted =
    duplicateGroupsCloseAllReceipt?.scopes.filter(
      ({ kind }) => kind === "failed",
    ).length ?? 0;
  const duplicateGroupsCloseAllUndoKeys = new Set(
    duplicateGroupsCloseAllKnownReceipts.flatMap(({ result, scope }) =>
      result.undo
        ? [`${physicalTabScopeKey(scope)}\n${result.undo.undoId}`]
        : [],
    ),
  );
  const discoverableUndos = browserStates.flatMap((state) =>
    state.pendingUndos
      .filter(
        ({ undoId }) =>
          !duplicateGroupsCloseAllUndoKeys.has(
            `${physicalTabScopeKey(state.scope)}\n${undoId}`,
          ) &&
          (mutationReceipt?.undo == null ||
            !sameTabCommandScope(actionResultScope, state.scope) ||
            undoId !== mutationReceipt.undo.undoId),
      )
      .map((undo) => ({ scope: state.scope, undo })),
  );
  const listIsFetching = duplicatesOnly
    ? duplicateGroupsQuery.isFetching
    : openTabsQuery.isFetching;
  const listIsPending = duplicatesOnly
    ? duplicateGroupsQuery.isPending
    : openTabsQuery.isPending;
  const listIsError = duplicatesOnly
    ? duplicateGroupsQuery.isError
    : openTabsQuery.isError;
  const listError = duplicatesOnly
    ? duplicateGroupsQuery.error
    : openTabsQuery.error;
  const pageTotal = duplicatesOnly
    ? (duplicateGroupsQuery.data?.totalGroups ?? 0)
    : (openTabsQuery.data?.total ?? 0);
  const pageSize = duplicatesOnly
    ? (duplicateGroupsQuery.data?.pageSize ?? 50)
    : (openTabsQuery.data?.pageSize ?? 50);
  const totalPages = Math.max(1, Math.ceil(pageTotal / pageSize));
  const firstVisible = pageTotal > 0 ? (page - 1) * pageSize + 1 : 0;
  const visibleResultCount = duplicatesOnly ? duplicateGroups.length : tabs.length;
  const lastVisible =
    firstVisible === 0 ? 0 : firstVisible + visibleResultCount - 1;
  const actionFeedbackMessage =
    actionFeedback?.kind === "saved-workspace"
      ? t("Saved “{name}” with {count} tabs.", {
          count: formatNumber(actionFeedback.count),
          name: actionFeedback.name,
          rawCount: actionFeedback.count,
        })
      : actionFeedback?.kind === "copied"
        ? t("Copied {count} tabs as {format}.", {
            count: formatNumber(actionFeedback.count),
            format: actionFeedback.format,
            rawCount: actionFeedback.count,
          })
        : null;
  const duplicateGroupPreviewIncomplete =
    pendingDialog?.kind === "close" &&
    pendingDialog.expectedCandidateCount !== undefined &&
    (pendingDialog.preview.requested !== pendingDialog.expectedCandidateCount ||
      pendingDialog.preview.candidateTabIds.length !==
        pendingDialog.expectedCandidateCount ||
      pendingDialog.preview.skipped.length > 0);

  useEffect(() => setPage(1), [browser, duplicatesOnly, q]);
  useEffect(() => {
    if (pageTotal === 0) return;
    setPage((current) =>
      clampPage(current, pageTotal, pageSize),
    );
  }, [pageSize, pageTotal]);

  const renderOpenTabRow = (
    tab: TabInstance,
    duplicateRelationship?: {
      keeper: TabInstance;
      keeperChoiceDisabled?: boolean;
      onKeepThisCopy?: (() => void) | undefined;
      role: DuplicateGroupDisplayRole;
    },
    duplicateSelection?: {
      disabled: boolean;
      onChange: (selected: boolean) => void;
    },
  ) => (
    <OpenTabRow
      activation={tabActivationAvailability(
        tab,
        activationProbe,
        t,
        connectedCommandScopes,
      )}
      activationInProgress={activationMutation.isPending}
      activationError={
        activationMutation.isError &&
        activationMutation.variables?.instanceId === tab.instanceId
          ? errorMessage(activationMutation.error)
          : undefined
      }
      duplicateRelationship={duplicateRelationship}
      isActivating={
        activationMutation.isPending &&
        activationMutation.variables?.instanceId === tab.instanceId
      }
      key={tab.instanceId}
      selectionDisabled={duplicateSelection?.disabled}
      selected={selection.has(tab.instanceId)}
      tab={tab}
      onActivateTab={(target) => activationMutation.mutate(target)}
      onSelectedChange={
        duplicateSelection?.onChange ??
        ((checked) => updateSelection([tab], checked))
      }
      onSelectCanonicalTab={onSelectCanonicalTab}
    />
  );

  return (
    <section className="open-tabs-workspace" aria-label={t("Physical open tabs")}>
      <div className="physical-count-card">
        <div>
          <p>{t("Live browser state")}</p>
          <strong>
            {physicalCountQuery.data
              ? t("{count} physical tabs open", {
                  count: formatNumber(physicalCountQuery.data.total),
                  rawCount: physicalCountQuery.data.total,
                })
              : t("Reading physical tabs...")}
          </strong>
          <span>{t("Every open occurrence is listed, including exact copies.")}</span>
        </div>
        <button className="secondary-action" type="button" onClick={() => setWorkspacesOpen(true)}>
          {t("Workspaces")}
        </button>
        {(listIsFetching || physicalCountQuery.isFetching) &&
        !physicalCountQuery.isPending ? (
          <span className="refresh-status" role="status">
            <span aria-hidden="true" />
            {t("Refreshing")}
          </span>
        ) : null}
      </div>

      <div className="table-panel physical-table-panel">
        <div className="open-tab-bridge-status" role="status">
          <span>
            {probeQuery.isPending && relayScopesQuery.isPending
              ? t("Checking connected TabHub extensions...")
              : availableCommandScopes.length > 0
                ? t(
                    "{count} browser profiles connected. TabHub can control tabs in any connected profile.",
                    {
                      count: formatNumber(availableCommandScopes.length),
                      rawCount: availableCommandScopes.length,
                    },
                  )
                : t(
                    "No connected TabHub extension can control this browser profile.",
                  )}
          </span>
          <button
            disabled={probeQuery.isFetching || relayScopesQuery.isFetching}
            type="button"
            onClick={() => void Promise.all([
              probeQuery.refetch(),
              relayScopesQuery.refetch(),
            ])}
          >
            {probeQuery.isFetching || relayScopesQuery.isFetching
              ? t("Checking...")
              : t("Re-check extensions")}
          </button>
        </div>
        <div className="filter-bar">
          <label className="search-field physical-search-field">
            <span>{t("Search open tab titles and URLs")}</span>
            <input
              autoComplete="off"
              maxLength={500}
              placeholder={t("Search open titles and URLs")}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span>{t("Browser")}</span>
            <select value={browser} onChange={(event) => setBrowser(event.target.value)}>
              <option value="all">{t("All browsers")}</option>
              {Object.entries(BROWSER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label === "Other" ? t("Other") : label}
                </option>
              ))}
            </select>
          </label>
          <label className="duplicates-toggle">
            <input
              checked={duplicatesOnly}
              type="checkbox"
              onChange={(event) => {
                if (event.target.checked) clearSelection();
                setDuplicatesOnly(event.target.checked);
              }}
            />
            {t("Exact duplicates only")}
          </label>
          {duplicatesOnly ? (
            <button
              className="close-all-matching-duplicates danger-action"
              disabled={
                duplicateGroupsCloseAllBusy ||
                commandMutation.isPending ||
                (duplicateGroupsQuery.data?.totalCloseCandidates ?? 0) === 0 ||
                pendingDialog !== null ||
                pendingDuplicateGroupsCloseAll !== null
              }
              type="button"
              onClick={() => void previewAllDuplicateGroups()}
            >
              {duplicateGroupsCloseAllBusy
                ? t("Checking every duplicate group…")
                : t("Close all matching duplicates ({count})…", {
                    count: formatNumber(
                      duplicateGroupsQuery.data?.totalCloseCandidates ?? 0,
                    ),
                  })}
            </button>
          ) : null}
          <OpenTabSelectionMenu
            busy={selectionBusy}
            hostname={selectionHostname}
            onHostnameChange={setSelectionHostname}
            onSelectAllResults={() =>
              void (duplicatesOnly
                ? selectExactCopies()
                : selectWithLoader(loadAllFilteredTabs))
            }
            onSelectExactCopies={() => void selectExactCopies()}
            onSelectHostname={() =>
              void (duplicatesOnly
                ? selectExactCopies((filtered) =>
                    tabsFromHostname(filtered, selectionHostname),
                  )
                : selectWithLoader(async () =>
                    tabsFromHostname(
                      await loadAllFilteredTabs(),
                      selectionHostname,
                    ),
                  ))
            }
            onSelectOld={(days) =>
              void (duplicatesOnly
                ? selectExactCopies((filtered) =>
                    tabsOlderThan(filtered, days),
                  )
                : selectWithLoader(async () =>
                    tabsOlderThan(await loadAllFilteredTabs(), days),
                  ))
            }
            onSelectVisible={() =>
              duplicatesOnly
                ? updateDuplicateGroupsSelection(
                    visibleClosableDuplicateGroups,
                    true,
                  )
                : updateSelection(tabs, true)
            }
          />
          <p className="result-count">
            {duplicatesOnly
              ? duplicateGroupsQuery.data
                ? duplicateGroupsQuery.data.totalGroups === 0
                  ? t("0 duplicate groups")
                  : t(
                      "{first}-{last} of {groups} groups · {tabs} tabs · {copies} extra copies",
                      {
                        copies: formatNumber(
                          duplicateGroupsQuery.data.totalDuplicateCopies,
                        ),
                        first: formatNumber(firstVisible),
                        groups: formatNumber(
                          duplicateGroupsQuery.data.totalGroups,
                        ),
                        last: formatNumber(lastVisible),
                        tabs: formatNumber(
                          duplicateGroupsQuery.data.totalTabsInGroups,
                        ),
                      },
                    )
                : t("Loading duplicate groups")
              : openTabsQuery.data
                ? openTabsQuery.data.total === 0
                  ? t("0 physical tabs")
                  : t("{first}-{last} of {total}", {
                      first: formatNumber(firstVisible),
                      last: formatNumber(lastVisible),
                      total: formatNumber(openTabsQuery.data.total),
                    })
                : t("Loading open tabs")}
          </p>
        </div>

        {selection.size > 0 ? (
          <OpenTabBulkToolbar
            busy={
              commandMutation.isPending ||
              duplicateGroupsCloseAllBusy ||
              pendingDuplicateGroupsCloseAll !== null ||
              selectionBusy
            }
            closeableCount={selectedClosePlan?.targets.length ?? 0}
            controlStatus={commandStatus}
            controlWindowId={
              commandUsesDirectBridge
                ? activationProbe?.controlWindowId ?? null
                : null
            }
            controllableCount={controllableCount}
            destination={effectiveMoveDestination}
            selectedCount={selection.size}
            showAppWindowDestination={commandUsesDirectBridge}
            windows={commandWindows}
            onClear={clearSelection}
            onClose={() => void previewClose()}
            onCopy={(format) => void copySelection(format)}
            onDestinationChange={setMoveDestination}
            onDiscard={() => runCommand(
              { kind: "discard", targets: commandTargets },
              commandScope,
            )}
            onMove={() => runCommand(
              {
                destination: effectiveMoveDestination,
                kind: "move",
                targets: commandTargets,
              },
              commandScope,
            )}
            onReload={() => {
              if (commandScope === null) return;
              setPendingDialog({
                count: controllableCount,
                kind: "reload",
                scope: commandScope,
                targets: commandTargets,
              });
            }}
            onSaveWorkspace={() => void saveSelectionAsWorkspace(false)}
            onSaveWorkspaceAndClose={() => void saveSelectionAsWorkspace(true)}
            onSetMuted={(value) => runCommand(
              { kind: "set-muted", targets: commandTargets, value },
              commandScope,
            )}
            onSetPinned={(value) => runCommand(
              { kind: "set-pinned", targets: commandTargets, value },
              commandScope,
            )}
          />
        ) : null}

        {duplicateGroupsCloseAllReceipt ? (
          <div
            className="open-tab-action-receipt bulk-duplicate-close-receipt"
            role="status"
            tabIndex={-1}
          >
            <strong>
              {t(
                "Duplicate cleanup: {succeeded} closed · {skipped} skipped · {failed} failed · {notRun} profiles not completed · {unknown} profiles unknown",
                {
                  failed: formatNumber(duplicateGroupsCloseAllFailed),
                  notRun: formatNumber(duplicateGroupsCloseAllNotCompleted),
                  skipped: formatNumber(duplicateGroupsCloseAllSkipped),
                  succeeded: formatNumber(duplicateGroupsCloseAllSucceeded),
                  unknown: formatNumber(duplicateGroupsCloseAllUnknown),
                },
              )}
            </strong>
            {duplicateGroupsCloseAllReceipt.blockedGroupCount > 0 ? (
              <span>
                {t(
                  "{copies} copies in {groups} groups were unavailable or changed.",
                  {
                    copies: formatNumber(
                      duplicateGroupsCloseAllReceipt.blockedCandidateCount,
                    ),
                    groups: formatNumber(
                      duplicateGroupsCloseAllReceipt.blockedGroupCount,
                    ),
                  },
                )}
              </span>
            ) : null}
            <div>
              {duplicateGroupsCloseAllReceipt.scopes.map((receipt) => (
                <div key={physicalTabScopeKey(receipt.scope)}>
                  {receipt.kind === "known" ? (
                    <>
                      <span>
                        {t(
                          "{browser} · installation {id}: {closed} closed · {skipped} skipped · {failed} failed",
                          {
                            browser: browserLabel(receipt.scope.browser, t),
                            closed: formatNumber(
                              receipt.result.succeededTabIds.length,
                            ),
                            failed: formatNumber(receipt.result.failed.length),
                            id: compactInstallationId(
                              receipt.scope.installationId,
                            ),
                            skipped: formatNumber(
                              receipt.result.skipped.length,
                            ),
                          },
                        )}
                      </span>
                      {receipt.result.undo ? (
                        <button
                          disabled={
                            commandMutation.isPending ||
                            duplicateGroupsCloseAllBusy
                          }
                          type="button"
                          onClick={() =>
                            undoDuplicateGroupsCloseAllReceipt(
                              receipt.scope,
                              receipt.result.undo!.undoId,
                            )
                          }
                        >
                          {t("Reopen {count} tabs", {
                            count: formatNumber(receipt.result.undo.count),
                            rawCount: receipt.result.undo.count,
                          })}
                        </button>
                      ) : null}
                    </>
                  ) : receipt.kind === "failed" ? (
                    <span className="duplicate-action-error">
                      {t(
                        "{browser} · installation {id}: close did not complete for {count} tabs. Refresh and check again.",
                        {
                          browser: browserLabel(receipt.scope.browser, t),
                          count: formatNumber(receipt.requested),
                          id: compactInstallationId(
                            receipt.scope.installationId,
                          ),
                        },
                      )}
                    </span>
                  ) : (
                    <span className="duplicate-action-error">
                      {t(
                        "{browser} · installation {id}: result unknown for {count} tabs. Do not retry automatically.",
                        {
                          browser: browserLabel(receipt.scope.browser, t),
                          count: formatNumber(receipt.requested),
                          id: compactInstallationId(
                            receipt.scope.installationId,
                          ),
                        },
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {mutationReceipt ? (
          <div className="open-tab-action-receipt" role="status" tabIndex={-1}>
            <span>
              {t("{kind}: {succeeded} succeeded · {skipped} skipped · {failed} failed", {
                failed: formatNumber(mutationReceipt.failed.length),
                failedCount: mutationReceipt.failed.length,
                kind: mutationKindLabel(mutationReceipt.kind, t),
                skipped: formatNumber(mutationReceipt.skipped.length),
                skippedCount: mutationReceipt.skipped.length,
                succeeded: formatNumber(mutationReceipt.succeededTabIds.length),
                succeededCount: mutationReceipt.succeededTabIds.length,
              })}
            </span>
            {mutationReceipt.undo ? (
              <button
                disabled={commandMutation.isPending}
                type="button"
                onClick={() =>
                  runCommand(
                    { kind: "undo-close", undoId: mutationReceipt.undo!.undoId },
                    actionResultScope,
                  )
                }
              >
                {t("Reopen closed tabs")}
              </button>
            ) : null}
          </div>
        ) : null}
        {discoverableUndos.length > 0 ? (
          <div className="open-tab-action-receipt" role="status">
            <span>{t("Recent closes available to undo")}</span>
            {discoverableUndos.map(({ scope, undo }) => (
              <button
                disabled={commandMutation.isPending}
                key={`${physicalTabScopeKey(scope)}\n${undo.undoId}`}
                type="button"
                onClick={() =>
                  runCommand(
                    { kind: "undo-close", undoId: undo.undoId },
                    scope,
                  )
                }
              >
                {t("Reopen {count} tabs in {browser} · installation {id}", {
                  browser: browserLabel(scope.browser, t),
                  count: formatNumber(undo.count),
                  id: compactInstallationId(scope.installationId),
                  rawCount: undo.count,
                })}
              </button>
            ))}
          </div>
        ) : null}
        {actionResult?.kind === "undo-close" ? (
          <div className="duplicate-action-result" role="status">
            <span>
              {t("Reopened {restored}; skipped {skipped}; failed {failed}.", {
                failed: formatNumber(actionResult.failed.length),
                failedCount: actionResult.failed.length,
                restored: formatNumber(actionResult.restoredTabIds.length),
                restoredCount: actionResult.restoredTabIds.length,
                skipped: formatNumber(actionResult.skipped.length),
                skippedCount: actionResult.skipped.length,
              })}
            </span>
            {actionResult.retry ? (
              <button
                disabled={commandMutation.isPending}
                type="button"
                onClick={() =>
                  runCommand(
                    { kind: "undo-close", undoId: actionResult.retry!.undoId },
                    actionResultScope,
                  )
                }
              >
                {t("Retry {count} failed", {
                  count: formatNumber(actionResult.retry.count),
                  rawCount: actionResult.retry.count,
                })}
              </button>
            ) : null}
          </div>
        ) : null}
        {actionResult?.kind === "open-workspace" ? (
          <p className="duplicate-action-result" role="status">
            {t("Opened {opened} workspace tabs; failed {failed}.", {
              failed: formatNumber(actionResult.failed.length),
              failedCount: actionResult.failed.length,
              opened: formatNumber(actionResult.openedTabIds.length),
              openedCount: actionResult.openedTabIds.length,
            })}
          </p>
        ) : null}
        {actionFeedbackMessage ? <p className="duplicate-action-result" role="status">{actionFeedbackMessage}</p> : null}
        {actionError ? <p className="duplicate-action-error" role="alert">{errorMessage(actionError.cause)}</p> : null}

        <div className="physical-table-scroll">
          {duplicatesOnly && duplicateGroupsQuery.data?.totalGroups ? (
            <p className="duplicate-mode-note">
              {t(
                "Exact URLs are grouped together. TabHub shows the kept copy first, then every duplicate that points to it.",
              )}
              {" "}
              {t(
                "To close the kept copy, including an active tab, choose Keep this copy on another row first.",
              )}
            </p>
          ) : null}
          <table className="physical-tabs-table">
            <caption className="sr-only">
              {duplicatesOnly
                ? t("Exact duplicate groups and their physical tab copies")
                : t("Every physical tab currently reported by connected browsers")}
            </caption>
            <thead>
              <tr>
                <th data-column="select" scope="col">
                  <SelectionCheckbox
                    checked={allVisibleSelected}
                    disabled={
                      (duplicatesOnly && visibleSelectableCount === 0) ||
                      selectionBusy ||
                      commandMutation.isPending ||
                      pendingDialog !== null ||
                      duplicateGroupsCloseAllBusy ||
                      pendingDuplicateGroupsCloseAll !== null
                    }
                    indeterminate={someVisibleSelected}
                    label={
                      duplicatesOnly
                        ? t(
                            "Select all closable duplicate copies on this page",
                          )
                        : t("Select all open tabs on this page")
                    }
                    onChange={(checked) =>
                      duplicatesOnly
                        ? updateDuplicateGroupsSelection(
                            visibleClosableDuplicateGroups,
                            checked,
                          )
                        : updateSelection(tabs, checked)
                    }
                  />
                </th>
                <th scope="col">{t("Open tab")}</th>
                <th scope="col">{t("Browser location")}</th>
                <th scope="col">{t("State / protection")}</th>
                <th scope="col">
                  {duplicatesOnly ? t("Role in group") : t("Exact copies")}
                </th>
              </tr>
            </thead>
            {duplicatesOnly ? (
              duplicateGroups.map((group) => {
                const groupHeadingId = `duplicate-group-${group.keeperInstanceId}`;
                const groupStatusId = `${groupHeadingId}-action-status`;
                const groupProtectedId = `${groupHeadingId}-protected-note`;
                const groupTitle = duplicateGroupTitle(group);
                const groupAction = duplicateGroupActionPlan(group);
                const selectedCandidateCount = groupAction.candidates.filter(
                  ({ instanceId }) => selection.has(instanceId),
                ).length;
                const selectedWithKeeperCount = groupAction.selections.filter(
                  ({ candidate, keeper }) => {
                    const selectedKeeper = duplicateKeepers.get(
                      candidate.instanceId,
                    );
                    return (
                      selection.has(candidate.instanceId) &&
                      keeper.browserTabId !== null &&
                      selectedKeeper?.tabId === keeper.browserTabId &&
                      selectedKeeper.expectedUrl === keeper.url
                    );
                  },
                ).length;
                const allCandidatesSelected =
                  groupAction.candidates.length > 0 &&
                  selectedWithKeeperCount === groupAction.candidates.length;
                const someCandidatesSelected =
                  selectedCandidateCount > 0 && !allCandidatesSelected;
                const remainingCopyCount = Math.max(
                  1,
                  group.count - groupAction.candidates.length,
                );
                const multipleCopiesWillRemain = remainingCopyCount > 1;
                const groupActionTitle = groupAction.canPreview
                  ? t("Preview closing every extra copy in this group")
                  : groupAction.availability === "empty"
                    ? t("This group has no closable extra copies.")
                    : groupAction.availability === "offline"
                      ? t(
                          "The browser extension that owns this group is offline. Keep that browser open and reload the updated extension.",
                        )
                      : t(
                          "This duplicate group has stale or incomplete browser identity. Refresh after its browser syncs again.",
                        );
                const groupActionDisabled =
                  !groupAction.canPreview ||
                  commandMutation.isPending ||
                  selectionBusy ||
                  pendingDialog !== null ||
                  duplicateGroupsCloseAllBusy ||
                  pendingDuplicateGroupsCloseAll !== null;
                const keeperChoiceDisabled =
                  commandMutation.isPending ||
                  selectionBusy ||
                  pendingDialog !== null ||
                  duplicateGroupsCloseAllBusy ||
                  pendingDuplicateGroupsCloseAll !== null;
                return (
                  <tbody
                    aria-labelledby={groupHeadingId}
                    className="duplicate-instance-group"
                    key={`${group.installationId}\n${group.browser}\n${group.url}`}
                  >
                    <tr className="duplicate-group-heading-row">
                      <th colSpan={5} id={groupHeadingId} scope="rowgroup">
                        <div className="duplicate-group-heading">
                          <div>
                            <span>{t("Exact duplicate group")}</span>
                            <strong>{groupTitle}</strong>
                            <code dir="ltr" title={group.url}>{group.url}</code>
                          </div>
                          <div className="duplicate-group-heading-side">
                            <div className="duplicate-group-heading-meta">
                              <span>{browserLabel(group.browser, t)}</span>
                              <span title={group.installationId}>
                                {t("Installation {id}", {
                                  id: compactInstallationId(group.installationId),
                                })}
                              </span>
                              <span>
                                {t("{count} open copies", {
                                  count: formatNumber(group.count),
                                  rawCount: group.count,
                                })}
                              </span>
                            </div>
                            <div className="duplicate-group-actions">
                              <label title={groupActionTitle}>
                                <SelectionCheckbox
                                  checked={allCandidatesSelected}
                                  describedBy={
                                    !groupAction.canPreview
                                      ? groupStatusId
                                      : undefined
                                  }
                                  disabled={groupActionDisabled}
                                  indeterminate={someCandidatesSelected}
                                  label={t(
                                    "Select {count} extra copies from {group}",
                                    {
                                      count: formatNumber(
                                        groupAction.candidates.length,
                                      ),
                                      group: groupTitle,
                                      rawCount: groupAction.candidates.length,
                                    },
                                  )}
                                  onChange={(checked) =>
                                    updateDuplicateGroupSelection(group, checked)
                                  }
                                />
                                <span>
                                  {t("Select {count} extra copies", {
                                    count: formatNumber(
                                      groupAction.candidates.length,
                                    ),
                                    rawCount: groupAction.candidates.length,
                                  })}
                                </span>
                              </label>
                              <button
                                aria-describedby={
                                  !groupAction.canPreview
                                    ? groupStatusId
                                    : multipleCopiesWillRemain
                                      ? groupProtectedId
                                      : undefined
                                }
                                aria-label={
                                  multipleCopiesWillRemain
                                    ? t(
                                        "Close {count} unpinned duplicates from {group}…",
                                        {
                                          count: formatNumber(
                                            groupAction.candidates.length,
                                          ),
                                          group: groupTitle,
                                          rawCount: groupAction.candidates.length,
                                        },
                                      )
                                    : t(
                                        "Close all duplicates from {group} ({count})…",
                                        {
                                          count: formatNumber(
                                            groupAction.candidates.length,
                                          ),
                                          group: groupTitle,
                                          rawCount: groupAction.candidates.length,
                                        },
                                      )
                                }
                                className="duplicate-group-close"
                                disabled={groupActionDisabled}
                                title={groupActionTitle}
                                type="button"
                                onClick={() => void previewDuplicateGroup(group)}
                              >
                                {!multipleCopiesWillRemain
                                  ? t("Close all duplicates ({count})…", {
                                      count: formatNumber(
                                        groupAction.candidates.length,
                                      ),
                                      rawCount: groupAction.candidates.length,
                                    })
                                  : t("Close {count} unpinned duplicates…", {
                                      count: formatNumber(
                                        groupAction.candidates.length,
                                      ),
                                      rawCount: groupAction.candidates.length,
                                    })}
                              </button>
                              {multipleCopiesWillRemain ? (
                                <span
                                  className="duplicate-group-protected-note"
                                  id={groupProtectedId}
                                >
                                  {t("After closing, {count} pinned copies will remain.", {
                                    count: formatNumber(remainingCopyCount),
                                    rawCount: remainingCopyCount,
                                  })}
                                </span>
                              ) : null}
                              {!groupAction.canPreview ? (
                                <span
                                  className="duplicate-group-action-status"
                                  id={groupStatusId}
                                >
                                  {groupActionTitle}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </th>
                    </tr>
                    {duplicateGroupDisplayRows(group).map(
                      ({ instance, keeper, role }) =>
                        renderOpenTabRow(
                          instance,
                          {
                            keeper,
                            keeperChoiceDisabled,
                            onKeepThisCopy:
                              role === "duplicate" &&
                              duplicateGroupWithKeeper(
                                group,
                                instance.instanceId,
                              ) !== null
                                ? () =>
                                    chooseDuplicateGroupKeeper(
                                      group,
                                      instance.instanceId,
                                    )
                                : undefined,
                            role,
                          },
                          {
                            disabled:
                              role !== "duplicate" || groupActionDisabled,
                            onChange: (checked) =>
                              updateDuplicateCandidateSelection(
                                group,
                                instance,
                                keeper,
                                checked,
                              ),
                          },
                        ),
                    )}
                  </tbody>
                );
              })
            ) : (
              <tbody>{tabs.map((tab) => renderOpenTabRow(tab))}</tbody>
            )}
          </table>

          {listIsPending ? (
            <div className="state-panel loading-state" role="status">
              <div className="spinner" aria-hidden="true" />
              <div>
                <strong>
                  {duplicatesOnly
                    ? t("Loading duplicate groups")
                    : t("Loading every open tab")}
                </strong>
                <span>
                  {duplicatesOnly
                    ? t("Keeping every exact-copy group together...")
                    : t("Reading physical browser occurrences...")}
                </span>
              </div>
            </div>
          ) : null}
          {listIsError ? (
            <div className="state-panel error-state" role="alert">
              <div className="state-icon" aria-hidden="true">!</div>
              <div>
                <strong>
                  {duplicatesOnly
                    ? t("Couldn't load duplicate groups")
                    : t("Couldn't load open tabs")}
                </strong>
                <span>{errorMessage(listError)}</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  void (duplicatesOnly
                    ? duplicateGroupsQuery.refetch()
                    : openTabsQuery.refetch())
                }
              >
                {t("Try again")}
              </button>
            </div>
          ) : null}
          {!listIsPending && !listIsError &&
          (duplicatesOnly
            ? duplicateGroupsQuery.data?.totalGroups === 0
            : openTabsQuery.data !== undefined &&
              isTrulyEmptyPage(openTabsQuery.data)) ? (
            <div className="state-panel empty-state" role="status">
              <div>
                <strong>
                  {duplicatesOnly
                    ? t("No exact duplicates match")
                    : t("No open tabs match")}
                </strong>
                <span>
                  {duplicatesOnly
                    ? t(
                        "A group appears only when at least two tabs have the same full URL in one browser installation.",
                      )
                    : t("Wait for a connected extension to send its next snapshot.")}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {pageTotal > 0 ? (
          <nav
            className="pagination"
            aria-label={
              duplicatesOnly
                ? t("Duplicate group pages")
                : t("Open-tab list pages")
            }
          >
            <p>
              {t("Page {page} of {total}", {
                page: formatNumber(page),
                total: formatNumber(totalPages),
              })}
            </p>
            <div>
              <button
                disabled={page <= 1 || listIsFetching}
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                {t("Previous")}
              </button>
              <button
                disabled={page >= totalPages || listIsFetching}
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                {t("Next")}
              </button>
            </div>
          </nav>
        ) : null}
      </div>
      {pendingDuplicateGroupsCloseAll ? (
        <DuplicateGroupsCloseAllDialog
          blockedCandidateCount={
            pendingDuplicateGroupsCloseAll.blockedCandidateCount
          }
          blockedGroupCount={pendingDuplicateGroupsCloseAll.blockedGroupCount}
          blockingMessage={
            pendingDuplicateGroupsCloseAll.previews.length === 0
              ? t(
                  "No browser profile passed the live duplicate check. No tabs can be closed.",
                )
              : duplicateGroupsCloseAllExpired
                ? t(
                    "The live duplicate preview expired. Run the check again; no tabs were closed.",
                  )
                : undefined
          }
          busy={duplicateGroupsCloseAllBusy}
          candidateCount={pendingDuplicateGroupsCloseAll.previews.reduce(
            (total, { preview }) => total + preview.candidateTabIds.length,
            0,
          )}
          confirmationBlocked={
            duplicateGroupsCloseAllExpired ||
            pendingDuplicateGroupsCloseAll.previews.length === 0
          }
          excludedProfiles={pendingDuplicateGroupsCloseAll.excluded.map(
            (entry) => ({
              candidateCount: entry.candidateCount,
              groupCount: entry.groupCount,
              label: t("{browser} · installation {id}", {
                browser: browserLabel(entry.browser, t),
                id: compactInstallationId(entry.installationId),
              }),
              reason: duplicateGroupsCloseAllExclusionLabel(entry.reason, t),
            }),
          )}
          groupCount={pendingDuplicateGroupsCloseAll.previews.reduce(
            (total, { batch }) => total + batch.groups.length,
            0,
          )}
          profiles={pendingDuplicateGroupsCloseAll.previews.map(
            ({ batch, preview }) => ({
              candidateCount: preview.candidateTabIds.length,
              label: t("{browser} · installation {id}", {
                browser: browserLabel(batch.scope.browser, t),
                id: compactInstallationId(batch.scope.installationId),
              }),
            }),
          )}
          profileCount={pendingDuplicateGroupsCloseAll.previews.length}
          protectedCopyCount={
            pendingDuplicateGroupsCloseAll.plan.counts.protectedCopies
          }
          protectedGroupCount={
            pendingDuplicateGroupsCloseAll.plan.counts.protectedGroups
          }
          onDismiss={dismissDuplicateGroupsCloseAll}
          onConfirm={() => void confirmAllDuplicateGroups()}
        />
      ) : null}
      {pendingDialog ? (
        <TabOperationDialog
          blockingMessage={
            duplicateGroupPreviewIncomplete
              ? t(
                  "The duplicate group changed. Refresh the list and try again; no tabs will be closed.",
                )
              : undefined
          }
          busy={commandMutation.isPending}
          candidateCount={
            pendingDialog.kind === "close"
              ? pendingDialog.preview.candidateTabIds.length
              : pendingDialog.count
          }
          confirmationBlocked={duplicateGroupPreviewIncomplete}
          kind={pendingDialog.kind}
          protectedCount={
            pendingDialog.kind === "close" ? pendingDialog.preview.skipped.length : 0
          }
          onDismiss={dismissOperationDialog}
          onConfirm={() => {
            if (duplicateGroupPreviewIncomplete) return;
            const command: TabCommand =
              pendingDialog.kind === "close"
                ? {
                    confirmed: true,
                    kind: "close",
                    previewId: pendingDialog.preview.previewId,
                  }
                : { kind: "reload", targets: pendingDialog.targets };
            const scope = pendingDialog.scope;
            void commandMutation
              .mutateAsync({ command, scope })
              .then(() => setPendingDialog(null))
              .catch(() => undefined);
          }}
        />
      ) : null}
      {workspacesOpen ? (
        <SavedWorkspacesDrawer
          busy={commandMutation.isPending}
          onClose={closeWorkspaces}
          onCommand={async (command, scope) => {
            await commandMutation.mutateAsync({ command, scope });
          }}
          targets={workspaceCommandTargets}
        />
      ) : null}
    </section>
  );
}
