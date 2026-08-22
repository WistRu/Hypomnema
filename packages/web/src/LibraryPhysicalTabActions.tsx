import {
  tabCommandScopeSchema,
  type TabCommandRelayResult,
  type TabCommandScope,
  type TabInstance,
} from "@tabhub/shared";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ActionReceipt } from "./ActionReceipt";
import {
  createWorkspace,
  executeRelayedTabCommand,
  fetchConnectedTabCommandScopes,
  isRelayedTabCommandOutcomeUnknown,
  TabCommandRelayClientError,
} from "./api";
import {
  closeUndoIsDismissed,
  dismissCloseUndos,
  type CloseUndoDismissals,
} from "./close-undo-dismissals";
import {
  checkDuplicateGroupsCloseAllPreview,
  duplicateGroupsCloseAllResultMatchesPreview,
  type DuplicateGroupCloseAllBatch,
} from "./duplicate-groups-close-all";
import {
  duplicateGroupsCloseAllRejectedOutcome,
  DuplicateGroupsCloseAllUnknownOutcomeError,
} from "./duplicate-groups-close-all-outcome";
import { DuplicateGroupsCloseAllDialog } from "./DuplicateGroupsCloseAllDialog";
import {
  createWindowExtensionBridge,
  type BrowserWindowSummary,
  type ClosePreviewResult,
  type CloseUndoSummary,
  ExtensionBridgeError,
  type ExtensionProbe,
  type MoveDestination,
  type PhysicalTabScope,
  type TabCommand,
  type TabCommandResult,
  type TabMutationResult,
} from "./extension-bridge";
import { useI18n, type TranslationParams } from "./i18n";
import {
  planAddressedLibraryPhysicalClose,
  planLibraryPhysicalClose,
} from "./library-physical-actions";
import { OpenTabBulkToolbar } from "./OpenTabBulkToolbar";
import {
  addressedCloseSelection,
  type AddressedCloseSelection,
} from "./open-tab-close-routing";
import {
  addressedTabSelection,
  relayedPhysicalCommand,
  sameTabCommandScope,
} from "./open-tab-command-routing";
import {
  extraExactCopyPlan,
  removeSucceededPhysicalTabs,
  setSelectedTabs,
  tabsFromHostname,
  tabsOlderThan,
  workspaceSelectionsForTabs,
  type OpenTabSelection,
} from "./open-tab-selection";
import { serializeTabs, type TabExportFormat } from "./tab-export";
import { TabOperationDialog } from "./TabOperationDialog";
import { SavedWorkspacesDrawer } from "./SavedWorkspacesDrawer";
import type { WorkspaceCommandTarget } from "./workspace-restore-routing";

type Translate = (key: string, params?: TranslationParams) => string;

type MultiCloseExclusionReason =
  | "changed"
  | "expired"
  | "invalid"
  | "offline"
  | "unavailable";

export interface MultiCloseExcludedProfile {
  browser: string;
  browserSessionId: string | null;
  candidateCount: number;
  groupCount: number;
  installationId: string;
  reason: MultiCloseExclusionReason;
}

export type MultiCloseScopeReceipt =
  | {
      kind: "known";
      requested: number;
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

export interface MultiCloseFeedback {
  blockedCandidateCount: number;
  blockedGroupCount: number;
  excluded: MultiCloseExcludedProfile[];
  kind: "multi-close";
  scopes: MultiCloseScopeReceipt[];
}

type ActionFeedback =
  | { count: number; format: TabExportFormat; kind: "copied" }
  | MultiCloseFeedback
  | { count: number; kind: "saved-workspace"; name: string };

interface ScopedBrowserState {
  pendingUndos: CloseUndoSummary[];
  scope: PhysicalTabScope;
  windows: BrowserWindowSummary[];
}

type PendingOperation =
  | {
      blockedCandidateCount: number;
      blockedGroupCount: number;
      excluded: MultiCloseExcludedProfile[];
      kind: "close";
      previews: Array<{
        groupCount: number;
        preview: ClosePreviewResult;
        requested: number;
        scope: PhysicalTabScope;
      }>;
      protectedCount: number;
      source: "global-exact" | "selection";
    }
  | {
      kind: "reload";
      protectedCount: number;
      scope: PhysicalTabScope;
      targets: Array<{ expectedUrl: string; tabId: number }>;
    };

export interface LibraryPhysicalTabActionsProps {
  allFilteredInstances: readonly TabInstance[];
  onRefresh?: (() => Promise<unknown> | unknown) | undefined;
  onSelectionChange: (selection: OpenTabSelection) => void;
  selection: ReadonlyMap<number, TabInstance>;
  showSelectionControls?: boolean;
}

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

function browserLabel(browser: string, t: Translate): string {
  const label = BROWSER_LABELS[browser] ?? browser;
  return label === "Other" ? t("Other") : label;
}

function compactInstallationId(installationId: string): string {
  return installationId.length <= 12
    ? installationId
    : `${installationId.slice(0, 8)}…`;
}

function physicalTabScopeKey(scope: PhysicalTabScope): string {
  return `${scope.browser}\n${scope.installationId}\n${scope.browserSessionId}`;
}

function exactPhysicalTabScopeLabel(scope: PhysicalTabScope, t: Translate): string {
  return [
    browserLabel(scope.browser, t),
    t("Installation {id}", { id: scope.installationId }),
    t("Session {id}", { id: scope.browserSessionId }),
  ].join(" · ");
}

function multiCloseExclusionLabel(
  reason: MultiCloseExclusionReason,
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

function appendMultiCloseExclusion(
  exclusions: MultiCloseExcludedProfile[],
  entry: MultiCloseExcludedProfile,
): void {
  const existing = exclusions.find(
    (candidate) =>
      candidate.browser === entry.browser &&
      candidate.browserSessionId === entry.browserSessionId &&
      candidate.installationId === entry.installationId &&
      candidate.reason === entry.reason,
  );
  if (existing === undefined) exclusions.push({ ...entry });
  else {
    existing.candidateCount += entry.candidateCount;
    existing.groupCount += entry.groupCount;
  }
}

function targetGroupCount(targets: readonly { expectedUrl: string }[]): number {
  return new Set(targets.map(({ expectedUrl }) => expectedUrl)).size;
}

export function settledMultiCloseScopeReceipts(
  settled: readonly PromiseSettledResult<{
    requested: number;
    result: TabMutationResult;
    scope: PhysicalTabScope;
  }>[],
  planned: readonly { requested: number; scope: PhysicalTabScope }[],
): MultiCloseScopeReceipt[] {
  return settled.map((outcome, index) => {
    const { requested, scope } = planned[index]!;
    if (outcome.status === "fulfilled") {
      return { kind: "known", requested, result: outcome.value.result, scope };
    }
    const failure = { cause: outcome.reason, requested, scope };
    return duplicateGroupsCloseAllRejectedOutcome(outcome.reason) === "unknown"
      ? { ...failure, kind: "unknown" }
      : { ...failure, kind: "failed" };
  });
}

export function clearMultiCloseScopeUndo(
  feedback: MultiCloseFeedback,
  scope: PhysicalTabScope,
  undoId: string,
): MultiCloseFeedback {
  return {
    ...feedback,
    scopes: feedback.scopes.map((receipt) =>
      receipt.kind === "known" &&
      sameTabCommandScope(receipt.scope, scope) &&
      receipt.result.undo?.undoId === undoId
        ? { ...receipt, result: { ...receipt.result, undo: null } }
        : receipt,
    ),
  };
}

function relayedTabCommandResult(result: TabCommandRelayResult): TabCommandResult {
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
  if (result.kind === "open-workspace") {
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
  throw new Error("Unexpected capture result in a physical-tab mutation flow.");
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

/**
 * Browser-management module for a Library-owned physical selection. The caller
 * owns only the selection and filtered snapshot; exact routing, capability
 * checks, confirmations, receipts, workspaces, and duplicate keepers stay here.
 */
export function LibraryPhysicalTabActions({
  allFilteredInstances,
  onRefresh,
  onSelectionChange,
  selection,
  showSelectionControls = true,
}: LibraryPhysicalTabActionsProps) {
  const { errorMessage, formatNumber, t } = useI18n();
  const queryClient = useQueryClient();
  const bridge = useMemo(() => createWindowExtensionBridge(), []);
  const closeBatchInFlight = useRef(false);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [selectionHostname, setSelectionHostname] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [moveDestination, setMoveDestination] = useState<MoveDestination>({
    kind: "app-window",
  });
  const [pendingOperation, setPendingOperation] =
    useState<PendingOperation | null>(null);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [actionResult, setActionResult] = useState<TabCommandResult | null>(null);
  const [actionResultScope, setActionResultScope] =
    useState<PhysicalTabScope | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionFeedback, setActionFeedback] =
    useState<ActionFeedback | null>(null);
  const [dismissedCloseUndos, setDismissedCloseUndos] =
    useState<CloseUndoDismissals>(() => new Set());

  const commitSelection = useCallback(
    (next: OpenTabSelection) => {
      selectionRef.current = next;
      onSelectionChange(next);
    },
    [onSelectionChange],
  );

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
  const availableCommandScopes = useMemo(() => {
    const scopes = currentScope === null
      ? connectedCommandScopes
      : [currentScope, ...connectedCommandScopes];
    return [
      ...new Map(
        scopes.map((scope) => [physicalTabScopeKey(scope), scope]),
      ).values(),
    ];
  }, [connectedCommandScopes, currentScope]);
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
    () =>
      addressedTabSelection(
        new Map(selection),
        currentScope,
        connectedCommandScopes,
      ),
    [connectedCommandScopes, currentScope, selection],
  );
  const selectedBrowserState = selectedCommandPlan.kind === "ready"
    ? browserStates.find((state) =>
        sameTabCommandScope(state.scope, selectedCommandPlan.scope),
      )
    : undefined;
  const selectedScopeKey = selectedCommandPlan.kind === "ready"
    ? `${selectedCommandPlan.route}:${physicalTabScopeKey(selectedCommandPlan.scope)}`
    : selectedCommandPlan.kind;
  useEffect(() => {
    setMoveDestination(
      selectedCommandPlan.kind === "ready" && selectedCommandPlan.route === "relay"
        ? { kind: "new-window" }
        : { kind: "app-window" },
    );
  }, [selectedScopeKey]);

  const closeSafetyPlan = useMemo(
    () => planLibraryPhysicalClose(selection, allFilteredInstances),
    [allFilteredInstances, selection],
  );
  const selectedClosePlan = useMemo(
    () =>
      addressedCloseSelection(
        closeSafetyPlan.selection,
        closeSafetyPlan.keepers,
        availableCommandScopes,
      ),
    [availableCommandScopes, closeSafetyPlan],
  );
  const exactCopyPlan = useMemo(
    () => extraExactCopyPlan(allFilteredInstances),
    [allFilteredInstances],
  );
  const globalExactSelection = useMemo<OpenTabSelection>(
    () =>
      new Map(
        exactCopyPlan.map(({ candidate }) => [candidate.instanceId, candidate]),
      ),
    [exactCopyPlan],
  );
  const globalExactClosePlan = useMemo(
    () =>
      planAddressedLibraryPhysicalClose(
        globalExactSelection,
        allFilteredInstances,
        availableCommandScopes,
      ),
    [allFilteredInstances, availableCommandScopes, globalExactSelection],
  );
  const globalExactExclusions = useMemo(() => {
    const readyScopeKeys = new Set(
      globalExactClosePlan.batches.map(({ scope }) => physicalTabScopeKey(scope)),
    );
    const availableScopeKeys = new Set(
      availableCommandScopes.map((scope) => physicalTabScopeKey(scope)),
    );
    const exclusions: MultiCloseExcludedProfile[] = [];
    const groupsByExclusion = new Map<string, Set<string>>();
    for (const instance of globalExactSelection.values()) {
      const key = `${instance.browser}\n${instance.installationId}\n${instance.browserSessionId ?? ""}`;
      if (readyScopeKeys.has(key)) continue;
      const parsedScope = tabCommandScopeSchema.safeParse({
        browser: instance.browser,
        browserSessionId: instance.browserSessionId,
        installationId: instance.installationId,
      });
      const reason: MultiCloseExclusionReason =
        !parsedScope.success
          ? "invalid"
          : !availableScopeKeys.has(key)
            ? "offline"
            : "invalid";
      const exclusionKey = `${key}\n${reason}`;
      const groups = groupsByExclusion.get(exclusionKey) ?? new Set<string>();
      groups.add(instance.url);
      groupsByExclusion.set(exclusionKey, groups);
      appendMultiCloseExclusion(exclusions, {
        browser: instance.browser,
        browserSessionId: instance.browserSessionId,
        candidateCount: 1,
        groupCount: 0,
        installationId: instance.installationId,
        reason,
      });
    }
    for (const exclusion of exclusions) {
      const key = `${exclusion.browser}\n${exclusion.installationId}\n${exclusion.browserSessionId ?? ""}\n${exclusion.reason}`;
      exclusion.groupCount = groupsByExclusion.get(key)?.size ?? 0;
    }
    return exclusions;
  }, [availableCommandScopes, globalExactClosePlan.batches, globalExactSelection]);

  const refreshBrowserState = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tab-instances"] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({
        queryKey: ["tab-command-relay", "browser-state"],
      }),
      probeQuery.refetch(),
      relayScopesQuery.refetch(),
      Promise.resolve(onRefresh?.()),
    ]);
  }, [onRefresh, probeQuery, queryClient, relayScopesQuery]);

  const executeScopedCommand = async (
    command: TabCommand,
    scope: PhysicalTabScope,
  ): Promise<TabCommandResult> => {
    if (sameTabCommandScope(currentScope, scope)) {
      const response = await bridge.command({ ...scope, command });
      if (!sameTabCommandScope(scope, response)) {
        throw new ExtensionBridgeError(
          "The extension browser session changed during the action.",
        );
      }
      return response.result;
    }

    const relayed = relayedPhysicalCommand(command);
    if (relayed === null) {
      throw new ExtensionBridgeError(
        "This action is unavailable through the connected browser relay.",
      );
    }
    const relayScope = tabCommandScopeSchema.parse(scope);
    const result = relayedTabCommandResult(
      await executeRelayedTabCommand({ ...relayScope, command: relayed }),
    );
    if (result.kind !== command.kind) {
      throw new ExtensionBridgeError(
        "The extension returned a result for a different command.",
      );
    }
    return result;
  };

  const commandMutation = useMutation({
    mutationFn: ({ command, scope }: { command: TabCommand; scope: PhysicalTabScope }) =>
      executeScopedCommand(command, scope),
    onMutate: ({ command }) => {
      setActionError(null);
      if (command.kind !== "undo-close") setActionFeedback(null);
    },
    onSuccess: async (result, { scope }) => {
      setActionResult(result);
      setActionResultScope(scope);
      if (result.kind === "close") {
        commitSelection(
          removeSucceededPhysicalTabs(
            new Map(selectionRef.current),
            scope,
            result.succeededTabIds,
          ),
        );
      }
      if (result.kind !== "close-preview") await refreshBrowserState();
    },
    onError: (error) => {
      setActionError(error);
      if (isRelayedTabCommandOutcomeUnknown(error)) {
        setPendingOperation(null);
        void refreshBrowserState();
      }
    },
  });

  const commandTargets = selectedCommandPlan.kind === "ready"
    ? selectedCommandPlan.targets
    : [];
  const commandScope = selectedCommandPlan.kind === "ready"
    ? selectedCommandPlan.scope
    : null;
  const controllableCount = commandTargets.length;
  const commandUsesDirectBridge =
    selectedCommandPlan.kind === "ready" && selectedCommandPlan.route === "direct";
  const commandStatus = selectedCommandPlan.kind === "ready"
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

  const runCommand = async (
    command: TabCommand,
    scope: PhysicalTabScope | null = currentScope,
  ) => {
    if (scope === null) {
      setActionError(
        new ExtensionBridgeError(
          "No single connected browser profile owns every selected tab.",
        ),
      );
      return;
    }
    await commandMutation.mutateAsync({ command, scope });
  };

  const previewCloseBatches = async ({
    batches,
    blockedCandidateCount,
    blockedGroupCount,
    excluded,
    protectedCount,
    source,
  }: {
    batches: readonly AddressedCloseSelection[];
    blockedCandidateCount: number;
    blockedGroupCount: number;
    excluded: readonly MultiCloseExcludedProfile[];
    protectedCount: number;
    source: "global-exact" | "selection";
  }) => {
    if (closeBatchInFlight.current) return;
    closeBatchInFlight.current = true;
    setSelectionBusy(true);
    setActionError(null);
    setActionFeedback(null);
    setActionResult(null);
    try {
      const settled = await Promise.allSettled(
        batches.map(async (batch) => {
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
      const nextExcluded = excluded.map((entry) => ({ ...entry }));
      let nextBlockedCandidateCount = blockedCandidateCount;
      let nextBlockedGroupCount = blockedGroupCount;
      let nextProtectedCount = protectedCount;
      const previews: Extract<PendingOperation, { kind: "close" }>["previews"] = [];
      settled.forEach((outcome, index) => {
        const batch = batches[index]!;
        const groupCount = targetGroupCount(batch.targets);
        if (outcome.status === "rejected") {
          if (source === "global-exact") {
            const reason: MultiCloseExclusionReason =
              outcome.reason instanceof TabCommandRelayClientError &&
              outcome.reason.code === "SCOPE_OFFLINE"
                ? "offline"
                : "unavailable";
            appendMultiCloseExclusion(nextExcluded, {
              ...batch.scope,
              candidateCount: batch.targets.length,
              groupCount,
              reason,
            });
            nextBlockedCandidateCount += batch.targets.length;
            nextBlockedGroupCount += groupCount;
          } else {
            nextProtectedCount += batch.targets.length;
          }
          return;
        }
        if (source === "global-exact") {
          const check = checkDuplicateGroupsCloseAllPreview(
            {
              groups: [],
              scope: batch.scope,
              targets: batch.targets,
            } satisfies DuplicateGroupCloseAllBatch,
            outcome.value.preview,
          );
          if (check.kind === "blocked") {
            appendMultiCloseExclusion(nextExcluded, {
              ...batch.scope,
              candidateCount: batch.targets.length,
              groupCount,
              reason: check.reason === "expired" ? "expired" : "changed",
            });
            nextBlockedCandidateCount += batch.targets.length;
            nextBlockedGroupCount += groupCount;
            return;
          }
        } else {
          nextProtectedCount += outcome.value.preview.skipped.length;
        }
        if (outcome.value.preview.candidateTabIds.length > 0) {
          previews.push({
            groupCount,
            preview: outcome.value.preview,
            requested: outcome.value.preview.candidateTabIds.length,
            scope: batch.scope,
          });
        }
      });
      if (previews.length === 0) {
        if (source === "global-exact") {
          setActionFeedback({
            blockedCandidateCount: nextBlockedCandidateCount,
            blockedGroupCount: nextBlockedGroupCount,
            excluded: nextExcluded,
            kind: "multi-close",
            scopes: [],
          });
        }
        setActionError(
          new ExtensionBridgeError(
            "No connected browser profile passed the live close preview.",
          ),
        );
      } else {
        setPendingOperation({
          blockedCandidateCount: nextBlockedCandidateCount,
          blockedGroupCount: nextBlockedGroupCount,
          excluded: nextExcluded,
          kind: "close",
          previews,
          protectedCount: nextProtectedCount,
          source,
        });
      }
    } catch (error) {
      setActionError(error);
    } finally {
      closeBatchInFlight.current = false;
      setSelectionBusy(false);
    }
  };

  const previewClose = async () => {
    if (selectedClosePlan === null || selectedClosePlan.targets.length === 0) {
      setActionError(
        new ExtensionBridgeError(
          "No single connected browser profile owns every selected tab.",
        ),
      );
      return;
    }
    await previewCloseBatches({
      batches: [selectedClosePlan],
      blockedCandidateCount: 0,
      blockedGroupCount: 0,
      excluded: [],
      protectedCount: closeSafetyPlan.protectedSelectedCount,
      source: "selection",
    });
  };

  const previewGlobalExactCopies = async () => {
    if (globalExactClosePlan.closeableCount === 0) {
      setActionFeedback({
        blockedCandidateCount: globalExactClosePlan.blockedSelectedCount,
        blockedGroupCount: globalExactExclusions.reduce(
          (total, entry) => total + entry.groupCount,
          0,
        ),
        excluded: globalExactExclusions,
        kind: "multi-close",
        scopes: [],
      });
      setActionError(
        new ExtensionBridgeError(
          "No connected browser profile can close the matching duplicate copies.",
        ),
      );
      return;
    }
    await previewCloseBatches({
      batches: globalExactClosePlan.batches,
      blockedCandidateCount: globalExactClosePlan.blockedSelectedCount,
      blockedGroupCount: globalExactExclusions.reduce(
        (total, entry) => total + entry.groupCount,
        0,
      ),
      excluded: globalExactExclusions,
      protectedCount: globalExactClosePlan.protectedSelectedCount,
      source: "global-exact",
    });
  };

  const confirmClose = async (
    pending: Extract<PendingOperation, { kind: "close" }>,
  ) => {
    if (closeBatchInFlight.current) return;
    if (pending.previews.some(({ preview }) => preview.expiresAt <= Date.now())) {
      setPendingOperation(null);
      setActionError(
        new ExtensionBridgeError(
          "The live close preview expired. Run the check again; no tabs were closed.",
        ),
      );
      await refreshBrowserState().catch(setActionError);
      return;
    }

    closeBatchInFlight.current = true;
    setSelectionBusy(true);
    setActionError(null);
    try {
      const settled = await Promise.allSettled(
        pending.previews.map(async ({ preview, requested, scope }) => {
          const result = await executeScopedCommand(
            { confirmed: true, kind: "close", previewId: preview.previewId },
            scope,
          );
          if (
            result.kind !== "close" ||
            !duplicateGroupsCloseAllResultMatchesPreview(preview, result)
          ) {
            throw new DuplicateGroupsCloseAllUnknownOutcomeError(
              "TabHub returned an incomplete close result. The outcome is unknown.",
            );
          }
          return { requested, result, scope };
        }),
      );
      const scopes = settledMultiCloseScopeReceipts(settled, pending.previews);
      let nextSelection = new Map(selectionRef.current);
      scopes.forEach((receipt) => {
        if (receipt.kind === "known") {
          nextSelection = removeSucceededPhysicalTabs(
            nextSelection,
            receipt.scope,
            receipt.result.succeededTabIds,
          );
        }
      });
      commitSelection(nextSelection);
      setActionFeedback({
        blockedCandidateCount: pending.blockedCandidateCount,
        blockedGroupCount: pending.blockedGroupCount,
        excluded: pending.excluded,
        kind: "multi-close",
        scopes,
      });
      setPendingOperation(null);
    } finally {
      try {
        await refreshBrowserState();
      } catch (error) {
        setActionError(error);
      } finally {
        closeBatchInFlight.current = false;
        setSelectionBusy(false);
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
        selections: workspaceSelectionsForTabs([...selection.values()]),
      });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setActionFeedback({
        count: workspace.itemCount,
        kind: "saved-workspace",
        name: workspace.name,
      });
      if (closeAfter) await previewClose();
    } catch (error) {
      setActionError(error);
    } finally {
      setSelectionBusy(false);
    }
  };

  const copySelection = async (format: TabExportFormat) => {
    try {
      await navigator.clipboard.writeText(
        serializeTabs([...selection.values()], format),
      );
      setActionFeedback({ count: selection.size, format, kind: "copied" });
      setActionError(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error : new Error("Clipboard access failed."),
      );
    }
  };

  const selectTabs = (tabs: readonly TabInstance[]) =>
    commitSelection(setSelectedTabs(new Map(selectionRef.current), tabs, true));
  const selectExactCopies = () => {
    const keepers = new Set(
      exactCopyPlan.map(({ keeper }) => keeper.instanceId),
    );
    const withoutKeepers = new Map(selectionRef.current);
    for (const keeper of keepers) withoutKeepers.delete(keeper);
    commitSelection(
      setSelectedTabs(
        withoutKeepers,
        exactCopyPlan.map(({ candidate }) => candidate),
        true,
      ),
    );
  };

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
  const mutationReceipt =
    actionResult !== null &&
    ["close", "discard", "move", "reload", "set-muted", "set-pinned"].includes(
      actionResult.kind,
    )
      ? (actionResult as TabMutationResult)
      : null;
  const multiCloseFeedback =
    actionFeedback?.kind === "multi-close" ? actionFeedback : null;
  const multiCloseUndos = multiCloseFeedback?.scopes.flatMap((receipt) =>
    receipt.kind === "known" && receipt.result.undo
      ? [{ scope: receipt.scope, undoId: receipt.result.undo.undoId }]
      : [],
  ) ?? [];
  const multiCloseUndoKeys = new Set(
    multiCloseUndos.map(
      ({ scope, undoId }) => `${physicalTabScopeKey(scope)}\n${undoId}`,
    ),
  );
  const dismissMultiCloseFeedback = () => {
    if (multiCloseUndos.length > 0) {
      setDismissedCloseUndos((current) =>
        dismissCloseUndos(current, multiCloseUndos),
      );
    }
    setActionFeedback(null);
  };
  const undoMultiCloseScope = (scope: PhysicalTabScope, undoId: string) => {
    void commandMutation
      .mutateAsync({ command: { kind: "undo-close", undoId }, scope })
      .then((result) => {
        if (result.kind !== "undo-close") return;
        setActionFeedback((current) =>
          current?.kind !== "multi-close"
            ? current
            : clearMultiCloseScopeUndo(current, scope, undoId),
        );
      })
      .catch(() => undefined);
  };
  const dismissMutationReceipt = () => {
    if (mutationReceipt?.undo && actionResultScope) {
      setDismissedCloseUndos((current) =>
        dismissCloseUndos(current, [
          { scope: actionResultScope, undoId: mutationReceipt.undo!.undoId },
        ]),
      );
    }
    setActionResult(null);
    setActionResultScope(null);
  };
  const discoverableUndos = browserStates.flatMap((state) =>
    state.pendingUndos
      .filter(
        ({ undoId }) =>
          !closeUndoIsDismissed(dismissedCloseUndos, {
            scope: state.scope,
            undoId,
          }) &&
          !multiCloseUndoKeys.has(
            `${physicalTabScopeKey(state.scope)}\n${undoId}`,
          ) &&
          (mutationReceipt?.undo == null ||
            !sameTabCommandScope(actionResultScope, state.scope) ||
            mutationReceipt.undo.undoId !== undoId),
      )
      .map((undo) => ({ scope: state.scope, undo })),
  );
  const dismissDiscoverableUndos = () => {
    setDismissedCloseUndos((current) =>
      dismissCloseUndos(
        current,
        discoverableUndos.map(({ scope, undo }) => ({
          scope,
          undoId: undo.undoId,
        })),
      ),
    );
  };
  const multiCloseTotals = multiCloseFeedback?.scopes.reduce(
    (totals, receipt) => {
      if (receipt.kind === "known") {
        totals.failed += receipt.result.failed.length;
        totals.skipped += receipt.result.skipped.length;
        totals.succeeded += receipt.result.succeededTabIds.length;
      } else if (receipt.kind === "failed") totals.notCompleted += 1;
      else totals.unknown += 1;
      return totals;
    },
    { failed: 0, notCompleted: 0, skipped: 0, succeeded: 0, unknown: 0 },
  );
  const actionFeedbackMessage = actionFeedback?.kind === "saved-workspace"
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
      : actionFeedback?.kind === "multi-close"
        ? t(
            "Close: {succeeded} closed · {skipped} skipped · {failed} failed · {notRun} profiles not completed · {unknown} profiles unknown",
            {
              failed: formatNumber(multiCloseTotals?.failed ?? 0),
              notRun: formatNumber(multiCloseTotals?.notCompleted ?? 0),
              skipped: formatNumber(multiCloseTotals?.skipped ?? 0),
              succeeded: formatNumber(multiCloseTotals?.succeeded ?? 0),
              unknown: formatNumber(multiCloseTotals?.unknown ?? 0),
            },
          )
        : null;
  const busy = commandMutation.isPending || selectionBusy;

  return (
    <div className="library-physical-tab-actions">
      {showSelectionControls ? (
        <div className="library-physical-tab-action-menus">
        <details className="open-tab-menu selection-preset-menu">
          <summary>{t("Select")}</summary>
          <div>
            <button
              disabled={busy}
              type="button"
              onClick={() => selectTabs(allFilteredInstances)}
            >
              {t("All filtered results")}
            </button>
            <button disabled={busy} type="button" onClick={selectExactCopies}>
              {t("Extra exact copies")}
            </button>
            <button
              className="danger-action"
              disabled={busy || globalExactSelection.size === 0}
              type="button"
              onClick={() => void previewGlobalExactCopies()}
            >
              {t("Close all matching duplicates ({count})…", {
                count: formatNumber(globalExactSelection.size),
              })}
            </button>
            {[7, 30, 90].map((days) => (
              <button
                disabled={busy}
                key={days}
                type="button"
                onClick={() => selectTabs(tabsOlderThan(allFilteredInstances, days))}
              >
                {t("Inactive for {count} days", {
                  count: formatNumber(days),
                  rawCount: days,
                })}
              </button>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                selectTabs(tabsFromHostname(allFilteredInstances, selectionHostname));
              }}
            >
              <input
                aria-label={t("Exact hostname")}
                disabled={busy}
                placeholder="example.com"
                value={selectionHostname}
                onChange={(event) => setSelectionHostname(event.target.value)}
              />
              <button
                disabled={busy || !selectionHostname.trim()}
                type="submit"
              >
                {t("Select host")}
              </button>
            </form>
          </div>
        </details>
        <button type="button" onClick={() => setWorkspacesOpen(true)}>
          {t("Workspaces")}
        </button>
        </div>
      ) : null}

      {showSelectionControls && selection.size > 0 ? (
        <OpenTabBulkToolbar
          busy={busy}
          closeableCount={selectedClosePlan?.targets.length ?? 0}
          controlStatus={commandStatus}
          controlWindowId={
            commandUsesDirectBridge ? activationProbe?.controlWindowId ?? null : null
          }
          controllableCount={controllableCount}
          destination={effectiveMoveDestination}
          selectedCount={selection.size}
          showAppWindowDestination={commandUsesDirectBridge}
          windows={selectedBrowserState?.windows ?? []}
          onClear={() => commitSelection(new Map())}
          onClose={() => void previewClose()}
          onCopy={(format) => void copySelection(format)}
          onDestinationChange={setMoveDestination}
          onDiscard={() =>
            void runCommand(
              { kind: "discard", targets: commandTargets },
              commandScope,
            ).catch(() => undefined)
          }
          onMove={() =>
            void runCommand(
              {
                destination: effectiveMoveDestination,
                kind: "move",
                targets: commandTargets,
              },
              commandScope,
            ).catch(() => undefined)
          }
          onReload={() => {
            if (commandScope === null) return;
            setPendingOperation({
              kind: "reload",
              protectedCount: 0,
              scope: commandScope,
              targets: commandTargets,
            });
          }}
          onSaveWorkspace={() => void saveSelectionAsWorkspace(false)}
          onSaveWorkspaceAndClose={() => void saveSelectionAsWorkspace(true)}
          onSetMuted={(value) =>
            void runCommand(
              { kind: "set-muted", targets: commandTargets, value },
              commandScope,
            ).catch(() => undefined)
          }
          onSetPinned={(value) =>
            void runCommand(
              { kind: "set-pinned", targets: commandTargets, value },
              commandScope,
            ).catch(() => undefined)
          }
        />
      ) : null}

      {mutationReceipt ? (
        <ActionReceipt onDismiss={dismissMutationReceipt}>
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
                void runCommand(
                  { kind: "undo-close", undoId: mutationReceipt.undo!.undoId },
                  actionResultScope,
                ).catch(() => undefined)
              }
            >
              {t("Reopen closed tabs")}
            </button>
          ) : null}
        </ActionReceipt>
      ) : null}
      {multiCloseFeedback ? (
        <ActionReceipt
          className="bulk-duplicate-close-receipt"
          onDismiss={dismissMultiCloseFeedback}
        >
          <strong>{actionFeedbackMessage}</strong>
          {multiCloseFeedback.blockedGroupCount > 0 ? (
            <span>
              {t("{copies} copies in {groups} groups were unavailable or changed.", {
                copies: formatNumber(multiCloseFeedback.blockedCandidateCount),
                groups: formatNumber(multiCloseFeedback.blockedGroupCount),
              })}
            </span>
          ) : null}
          {multiCloseFeedback.excluded.length > 0 ? (
            <>
              <strong>{t("Excluded from this cleanup")}</strong>
              <ul className="duplicate-close-profile-list is-excluded">
                {multiCloseFeedback.excluded.map((entry) => (
                  <li
                    key={`${entry.browser}\n${entry.installationId}\n${entry.browserSessionId ?? ""}\n${entry.reason}`}
                  >
                    <span>
                      {entry.browserSessionId === null
                        ? `${browserLabel(entry.browser, t)} · ${t("Installation {id}", { id: entry.installationId })}`
                        : exactPhysicalTabScopeLabel(
                            {
                              browser: entry.browser,
                              browserSessionId: entry.browserSessionId,
                              installationId: entry.installationId,
                            },
                            t,
                          )}
                      <small>{multiCloseExclusionLabel(entry.reason, t)}</small>
                    </span>
                    <strong>
                      {t("{groups} groups · {copies} copies", {
                        copies: formatNumber(entry.candidateCount),
                        groups: formatNumber(entry.groupCount),
                      })}
                    </strong>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div>
            {multiCloseFeedback.scopes.map((receipt) => (
              <div key={physicalTabScopeKey(receipt.scope)}>
                <strong>{exactPhysicalTabScopeLabel(receipt.scope, t)}</strong>
                <small>
                  {t("{count} ready to close", {
                    count: formatNumber(receipt.requested),
                    rawCount: receipt.requested,
                  })}
                </small>
                {receipt.kind === "known" ? (
                  <>
                    <span>
                      {t("{kind}: {succeeded} succeeded · {skipped} skipped · {failed} failed", {
                        failed: formatNumber(receipt.result.failed.length),
                        failedCount: receipt.result.failed.length,
                        kind: t("close"),
                        skipped: formatNumber(receipt.result.skipped.length),
                        skippedCount: receipt.result.skipped.length,
                        succeeded: formatNumber(receipt.result.succeededTabIds.length),
                        succeededCount: receipt.result.succeededTabIds.length,
                      })}
                    </span>
                    {receipt.result.undo ? (
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          undoMultiCloseScope(
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
                    {t("{browser} · installation {id}: close did not complete for {count} tabs. Refresh and check again.", {
                      browser: browserLabel(receipt.scope.browser, t),
                      count: formatNumber(receipt.requested),
                      id: receipt.scope.installationId,
                    })}
                  </span>
                ) : (
                  <span className="duplicate-action-error">
                    {t("{browser} · installation {id}: result unknown for {count} tabs. Do not retry automatically.", {
                      browser: browserLabel(receipt.scope.browser, t),
                      count: formatNumber(receipt.requested),
                      id: receipt.scope.installationId,
                    })}
                  </span>
                )}
              </div>
            ))}
          </div>
        </ActionReceipt>
      ) : null}
      {discoverableUndos.length > 0 ? (
        <ActionReceipt onDismiss={dismissDiscoverableUndos}>
          <span>{t("Recent closes available to undo")}</span>
          {discoverableUndos.map(({ scope, undo }) => (
            <button
              disabled={commandMutation.isPending}
              key={`${physicalTabScopeKey(scope)}\n${undo.undoId}`}
              type="button"
              onClick={() =>
                void runCommand(
                  { kind: "undo-close", undoId: undo.undoId },
                  scope,
                ).catch(() => undefined)
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
        </ActionReceipt>
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
                void runCommand(
                  { kind: "undo-close", undoId: actionResult.retry!.undoId },
                  actionResultScope,
                ).catch(() => undefined)
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
      {actionFeedbackMessage && !multiCloseFeedback ? (
        <p className="duplicate-action-result" role="status">
          {actionFeedbackMessage}
        </p>
      ) : null}
      {actionError ? (
        <p className="duplicate-action-error" role="alert">
          {errorMessage(actionError)}
        </p>
      ) : null}

      {pendingOperation?.kind === "close" &&
      pendingOperation.source === "global-exact" ? (
        <DuplicateGroupsCloseAllDialog
          blockedCandidateCount={pendingOperation.blockedCandidateCount}
          blockedGroupCount={pendingOperation.blockedGroupCount}
          busy={busy}
          candidateCount={pendingOperation.previews.reduce(
            (total, { preview }) => total + preview.candidateTabIds.length,
            0,
          )}
          confirmationBlocked={pendingOperation.previews.length === 0}
          excludedProfiles={pendingOperation.excluded.map((entry) => ({
            candidateCount: entry.candidateCount,
            groupCount: entry.groupCount,
            label:
              entry.browserSessionId === null
                ? `${browserLabel(entry.browser, t)} · ${t("Installation {id}", { id: entry.installationId })}`
                : exactPhysicalTabScopeLabel(
                    {
                      browser: entry.browser,
                      browserSessionId: entry.browserSessionId,
                      installationId: entry.installationId,
                    },
                    t,
                  ),
            reason: multiCloseExclusionLabel(entry.reason, t),
          }))}
          groupCount={pendingOperation.previews.reduce(
            (total, { groupCount }) => total + groupCount,
            0,
          )}
          profileCount={pendingOperation.previews.length}
          profiles={pendingOperation.previews.map(({ preview, scope }) => ({
            candidateCount: preview.candidateTabIds.length,
            label: exactPhysicalTabScopeLabel(scope, t),
          }))}
          protectedCopyCount={pendingOperation.protectedCount}
          protectedGroupCount={0}
          onDismiss={() => setPendingOperation(null)}
          onConfirm={() => void confirmClose(pendingOperation)}
        />
      ) : pendingOperation ? (
        <TabOperationDialog
          busy={busy}
          candidateCount={
            pendingOperation.kind === "close"
              ? pendingOperation.previews.reduce(
                  (total, { preview }) =>
                    total + preview.candidateTabIds.length,
                  0,
                )
              : pendingOperation.targets.length
          }
          kind={pendingOperation.kind}
          protectedCount={pendingOperation.protectedCount}
          onDismiss={() => setPendingOperation(null)}
          onConfirm={() => {
            if (pendingOperation.kind === "close") {
              void confirmClose(pendingOperation);
              return;
            }
            const command: TabCommand = {
              kind: "reload",
              targets: pendingOperation.targets,
            };
            const scope = pendingOperation.scope;
            void commandMutation
              .mutateAsync({ command, scope })
              .then(() => setPendingOperation(null))
              .catch(() => undefined);
          }}
        />
      ) : null}
      {workspacesOpen ? (
        <SavedWorkspacesDrawer
          busy={commandMutation.isPending}
          onClose={() => setWorkspacesOpen(false)}
          onCommand={async (command, scope) => {
            await commandMutation.mutateAsync({ command, scope });
          }}
          targets={workspaceCommandTargets}
        />
      ) : null}
    </div>
  );
}
