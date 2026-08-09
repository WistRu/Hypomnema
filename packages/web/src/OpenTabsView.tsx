import type { TabInstance } from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createWorkspace, fetchAllOpenTabs, fetchOpenTabs } from "./api";
import {
  createWindowExtensionBridge,
  ExtensionBridgeError,
  type ClosePreviewResult,
  type ExtensionProbe,
  type MoveDestination,
  type PhysicalTabTarget,
  type TabCommand,
  type TabCommandResult,
  type TabMutationResult,
} from "./extension-bridge";
import { OpenTabBulkToolbar, OpenTabSelectionMenu } from "./OpenTabBulkToolbar";
import {
  tabActivationAvailability,
  type TabActivationAvailability,
} from "./open-tab-activation";
import {
  controllableSelection,
  closePreviewTargetsForSelection,
  extraExactCopyPlan,
  reconcileSelectionWithSnapshot,
  removeSucceededPhysicalTabs,
  setSelectedTabs,
  tabsFromHostname,
  tabsOlderThan,
  type OpenTabSelection,
} from "./open-tab-selection";
import { clampPage, isTrulyEmptyPage } from "./pagination";
import { serializeTabs, type TabExportFormat } from "./tab-export";
import { TabOperationDialog } from "./TabOperationDialog";
import { SavedWorkspacesDrawer } from "./SavedWorkspacesDrawer";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

function browserLabel(browser: string): string {
  return BROWSER_LABELS[browser] ?? browser;
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

function physicalLocation(tab: TabInstance): string {
  const tabId = tab.browserTabId === null ? "unknown tab" : `tab ${tab.browserTabId}`;
  return `Window ${tab.windowId} | position ${tab.index + 1} | ${tabId}`;
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
  onClick,
}: {
  checked: boolean;
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
      aria-label={label}
      checked={checked}
      className="selection-checkbox"
      ref={ref}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
      onClick={onClick}
    />
  );
}

function unavailableLabel(activation: Exclude<TabActivationAvailability, { kind: "ready" }>): string {
  switch (activation.kind) {
    case "checking":
      return "Checking extension";
    case "bridge-unavailable":
      return "Extension unavailable";
    case "identity-unconfigured":
      return "Identity required";
    case "missing-tab-id":
      return "Waiting for snapshot";
    case "other-installation":
      return "Other installation";
    case "waiting-for-current-session":
      return "Waiting for current session";
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
  selected = false,
}: {
  activation: TabActivationAvailability;
  activationError?: string | undefined;
  activationInProgress?: boolean | undefined;
  isActivating?: boolean | undefined;
  tab: TabInstance;
  onActivateTab: (tab: TabInstance) => void;
  onSelectedChange?: (selected: boolean) => void;
  onSelectCanonicalTab: (id: number) => void;
  selected?: boolean;
}) {
  const label = tab.title?.trim() || hostname(tab.url);

  return (
    <tr aria-selected={selected} className={selected ? "is-selected" : undefined}>
      {onSelectedChange ? (
        <td data-column="select">
          <SelectionCheckbox
            checked={selected}
            label={`Select ${label}`}
            onChange={onSelectedChange}
          />
        </td>
      ) : null}
      <td>
        <div className="physical-tab-title">
          <div className="physical-tab-heading">
            {activation.kind === "ready" ? (
              <button
                aria-label={`Switch to existing tab: ${label}`}
                className="physical-tab-switch"
                disabled={activationInProgress || isActivating}
                title="Switch to this existing browser tab"
                type="button"
                onClick={() => onActivateTab(tab)}
              >
                {label}
              </button>
            ) : (
              <span className="physical-tab-label" title={activation.message}>
                {label}
              </span>
            )}
            <button
              className="physical-tab-details"
              type="button"
              onClick={() => onSelectCanonicalTab(tab.canonicalTabId)}
            >
              Details
            </button>
          </div>
          <span className="physical-tab-url" dir="ltr" title={tab.url}>{tab.url}</span>
          {activation.kind === "ready" ? (
            isActivating ? <span className="physical-tab-action-state">Switching...</span> : null
          ) : (
            <span className="physical-tab-action-state" title={activation.message}>
              {unavailableLabel(activation)}
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
          <span>{browserLabel(tab.browser)}</span>
        </span>
        <span className="physical-location">{physicalLocation(tab)}</span>
      </td>
      <td>
        <div className="physical-flags">
          {tab.active ? <span className="physical-flag is-active">Active</span> : null}
          {tab.pinned ? <span className="physical-flag is-protected">Pinned</span> : null}
          {tab.audible ? <span className="physical-flag is-audible">Playing</span> : null}
          {tab.muted ? <span className="physical-flag is-muted">Muted</span> : null}
          {tab.discarded ? <span className="physical-flag is-sleeping">Sleeping</span> : null}
          {!tab.active && !tab.pinned && !tab.audible && !tab.muted && !tab.discarded ? (
            <span className="physical-flag">Standard</span>
          ) : null}
        </div>
      </td>
      <td>
        {tab.duplicateGroupSize > 1 ? (
          <span className="duplicate-count">
            {tab.duplicateGroupSize.toLocaleString()} exact copies
          </span>
        ) : (
          <span className="unique-copy">Unique</span>
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
  const [browser, setBrowser] = useState("all");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<OpenTabSelection>(() => new Map());
  const [duplicateKeepers, setDuplicateKeepers] = useState<
    Map<number, PhysicalTabTarget>
  >(() => new Map());
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionHostname, setSelectionHostname] = useState("");
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState<MoveDestination>({ kind: "app-window" });
  const [pendingDialog, setPendingDialog] = useState<
    | { kind: "close"; preview: ClosePreviewResult }
    | { kind: "reload"; count: number }
    | null
  >(null);
  const [actionResult, setActionResult] = useState<TabCommandResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
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
  const openTabsQuery = useQuery({
    queryKey: ["tab-instances", { browser, duplicatesOnly, page, q }],
    queryFn: ({ signal }) =>
      fetchOpenTabs({ browser, duplicatesOnly, page, q }, signal),
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
  const controlled = useMemo(
    () => controllableSelection(selection, activationProbe),
    [activationProbe, selection],
  );
  const currentScope =
    activationProbe?.available === true && activationProbe.browser !== null
      ? {
          browser: activationProbe.browser,
          browserSessionId: activationProbe.browserSessionId,
          installationId: activationProbe.installationId,
        }
      : null;
  const commandMutation = useMutation({
    mutationFn: async (command: TabCommand) => {
      if (currentScope === null) {
        throw new ExtensionBridgeError("Open TabHub in the browser profile that owns these tabs.");
      }
      const response = await bridge.command({ ...currentScope, command });
      if (
        response.browser !== currentScope.browser ||
        response.browserSessionId !== currentScope.browserSessionId ||
        response.installationId !== currentScope.installationId
      ) {
        throw new ExtensionBridgeError("The extension browser session changed during the action.");
      }
      return response.result;
    },
    onMutate: () => {
      setActionError(null);
      setActionFeedback(null);
    },
    onSuccess: async (result) => {
      setActionResult(result);
      if (result.kind === "close" && currentScope !== null) {
        setSelection((current) =>
          removeSucceededPhysicalTabs(
            current,
            currentScope,
            result.succeededTabIds,
          ),
        );
      }
      if (result.kind !== "close-preview") {
        await Promise.all([
          openTabsQuery.refetch(),
          physicalCountQuery.refetch(),
          probeQuery.refetch(),
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
    onError: (error) => setActionError(error.message),
  });
  const activationMutation = useMutation({
    mutationFn: async (tab: TabInstance) => {
      const availability = tabActivationAvailability(tab, activationProbe);
      if (availability.kind !== "ready") {
        throw new ExtensionBridgeError(availability.message);
      }

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
    },
    onError: async () => {
      await Promise.all([openTabsQuery.refetch(), physicalCountQuery.refetch()]);
    },
  });
  const tabs = openTabsQuery.data?.items ?? [];
  const visibleSelectedCount = tabs.filter((tab) => selection.has(tab.instanceId)).length;
  const allVisibleSelected = tabs.length > 0 && visibleSelectedCount === tabs.length;
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
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSelectionBusy(false);
    }
  };
  const selectExactCopies = async () => {
    setSelectionBusy(true);
    setActionError(null);
    try {
      const [filtered, universe] = await Promise.all([
        loadAllFilteredTabs(),
        fetchAllOpenTabs({ browser, duplicatesOnly: false, q: "" }),
      ]);
      const filteredIds = new Set(filtered.map(({ instanceId }) => instanceId));
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
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSelectionBusy(false);
    }
  };
  const commandTargets = controlled.map(({ tab, target }) => ({
    expectedUrl: tab.url,
    tabId: target.tabId,
  }));
  const closePreviewTargets = closePreviewTargetsForSelection(
    controlled,
    duplicateKeepers,
  );
  const runCommand = (command: TabCommand) => {
    void commandMutation.mutateAsync(command).catch(() => undefined);
  };
  const previewClose = async () => {
    try {
      const result = await commandMutation.mutateAsync({
        kind: "close-preview",
        targets: closePreviewTargets,
      });
      if (result.kind === "close-preview") {
        setPendingDialog({ kind: "close", preview: result });
      }
    } catch {
      // Mutation state presents the correlated bridge error.
    }
  };
  const saveSelectionAsWorkspace = async (closeAfter: boolean) => {
    const name = window.prompt("Workspace name")?.trim();
    if (!name) return;
    setSelectionBusy(true);
    setActionError(null);
    try {
      const workspace = await createWorkspace({
        name,
        selections: selectedTabs.map((tab) => ({
          browser: tab.browser,
          browserSessionId: tab.browserSessionId,
          browserTabId: tab.browserTabId,
          installationId: tab.installationId,
          instanceId: tab.instanceId,
        })),
      });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setActionFeedback(`Saved “${workspace.name}” with ${workspace.itemCount.toLocaleString()} tabs.`);
      if (closeAfter) await previewClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSelectionBusy(false);
    }
  };
  const copySelection = async (format: TabExportFormat) => {
    try {
      await navigator.clipboard.writeText(serializeTabs(selectedTabs, format));
      setActionFeedback(`Copied ${selectedTabs.length.toLocaleString()} tabs as ${format}.`);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Clipboard access failed.");
    }
  };
  const mutationReceipt =
    actionResult && ["close", "discard", "move", "reload", "set-muted", "set-pinned"].includes(actionResult.kind)
      ? (actionResult as TabMutationResult)
      : null;
  const discoverableUndos =
    activationProbe?.available === true
      ? activationProbe.pendingUndos.filter(
          ({ undoId }) => undoId !== mutationReceipt?.undo?.undoId,
        )
      : [];
  const totalPages = openTabsQuery.data
    ? Math.max(1, Math.ceil(openTabsQuery.data.total / openTabsQuery.data.pageSize))
    : 1;
  const firstVisible = openTabsQuery.data?.total
    ? (openTabsQuery.data.page - 1) * openTabsQuery.data.pageSize + 1
    : 0;
  const lastVisible = firstVisible === 0 ? 0 : firstVisible + tabs.length - 1;

  useEffect(() => setPage(1), [browser, duplicatesOnly, q]);
  useEffect(() => {
    if (openTabsQuery.data === undefined) return;
    setPage((current) =>
      clampPage(
        current,
        openTabsQuery.data!.total,
        openTabsQuery.data!.pageSize,
      ),
    );
  }, [openTabsQuery.data?.pageSize, openTabsQuery.data?.total]);

  return (
    <section className="open-tabs-workspace" aria-label="Physical open tabs">
      <div className="physical-count-card">
        <div>
          <p>Live browser state</p>
          <strong>
            {physicalCountQuery.data
              ? `${physicalCountQuery.data.total.toLocaleString()} physical tabs open`
              : "Reading physical tabs..."}
          </strong>
          <span>Every open occurrence is listed, including exact copies.</span>
        </div>
        <button className="secondary-action" type="button" onClick={() => setWorkspacesOpen(true)}>
          Workspaces
        </button>
        {(openTabsQuery.isFetching || physicalCountQuery.isFetching) &&
        !physicalCountQuery.isPending ? (
          <span className="refresh-status" role="status">
            <span aria-hidden="true" />
            Refreshing
          </span>
        ) : null}
      </div>

      <div className="table-panel physical-table-panel">
        <div className="open-tab-bridge-status" role="status">
          <span>
            {probeQuery.isPending
              ? "Checking the local TabHub extension..."
              : activationProbe?.available && activationProbe.browser !== null
                ? `Connected to ${browserLabel(activationProbe.browser)}. Click a tab title to switch to that existing tab.`
                : activationProbe?.available
                  ? "Choose this extension's browser identity before switching tabs."
                  : "Open TabHub in the target browser and reload the updated extension to switch tabs."}
          </span>
          <button
            disabled={probeQuery.isFetching}
            type="button"
            onClick={() => void probeQuery.refetch()}
          >
            {probeQuery.isFetching ? "Checking..." : "Re-check extension"}
          </button>
        </div>
        <div className="filter-bar">
          <label className="search-field physical-search-field">
            <span>Search open tab titles and URLs</span>
            <input
              autoComplete="off"
              maxLength={500}
              placeholder="Search open titles and URLs"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span>Browser</span>
            <select value={browser} onChange={(event) => setBrowser(event.target.value)}>
              <option value="all">All browsers</option>
              {Object.entries(BROWSER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="duplicates-toggle">
            <input
              checked={duplicatesOnly}
              type="checkbox"
              onChange={(event) => setDuplicatesOnly(event.target.checked)}
            />
            Exact duplicates only
          </label>
          <OpenTabSelectionMenu
            busy={selectionBusy}
            hostname={selectionHostname}
            onHostnameChange={setSelectionHostname}
            onSelectAllResults={() => void selectWithLoader(loadAllFilteredTabs)}
            onSelectExactCopies={() => void selectExactCopies()}
            onSelectHostname={() =>
              void selectWithLoader(async () =>
                tabsFromHostname(await loadAllFilteredTabs(), selectionHostname),
              )
            }
            onSelectOld={(days) =>
              void selectWithLoader(async () =>
                tabsOlderThan(await loadAllFilteredTabs(), days),
              )
            }
            onSelectVisible={() =>
              updateSelection(tabs, true)
            }
          />
          <p className="result-count">
            {openTabsQuery.data
              ? openTabsQuery.data.total === 0
                ? "0 physical tabs"
                : `${firstVisible.toLocaleString()}-${lastVisible.toLocaleString()} of ${openTabsQuery.data.total.toLocaleString()}`
              : "Loading open tabs"}
          </p>
        </div>

        {selection.size > 0 ? (
          <OpenTabBulkToolbar
            busy={commandMutation.isPending || selectionBusy}
            controlWindowId={activationProbe?.controlWindowId ?? null}
            controllableCount={controlled.length}
            destination={moveDestination}
            selectedCount={selection.size}
            windows={activationProbe?.windows ?? []}
            onClear={clearSelection}
            onClose={() => void previewClose()}
            onCopy={(format) => void copySelection(format)}
            onDestinationChange={setMoveDestination}
            onDiscard={() => runCommand({ kind: "discard", targets: commandTargets })}
            onMove={() => runCommand({ destination: moveDestination, kind: "move", targets: commandTargets })}
            onReload={() => setPendingDialog({ kind: "reload", count: controlled.length })}
            onSaveWorkspace={() => void saveSelectionAsWorkspace(false)}
            onSaveWorkspaceAndClose={() => void saveSelectionAsWorkspace(true)}
            onSetMuted={(value) => runCommand({ kind: "set-muted", targets: commandTargets, value })}
            onSetPinned={(value) => runCommand({ kind: "set-pinned", targets: commandTargets, value })}
          />
        ) : null}

        {mutationReceipt ? (
          <div className="open-tab-action-receipt" role="status" tabIndex={-1}>
            <span>
              {mutationReceipt.kind}: {mutationReceipt.succeededTabIds.length.toLocaleString()} succeeded · {mutationReceipt.skipped.length.toLocaleString()} skipped · {mutationReceipt.failed.length.toLocaleString()} failed
            </span>
            {mutationReceipt.undo ? (
              <button
                disabled={commandMutation.isPending}
                type="button"
                onClick={() => runCommand({ kind: "undo-close", undoId: mutationReceipt.undo!.undoId })}
              >
                Reopen closed tabs
              </button>
            ) : null}
          </div>
        ) : null}
        {discoverableUndos.length > 0 ? (
          <div className="open-tab-action-receipt" role="status">
            <span>Recent closes available to undo</span>
            {discoverableUndos.map((undo) => (
              <button
                disabled={commandMutation.isPending}
                key={undo.undoId}
                type="button"
                onClick={() =>
                  runCommand({ kind: "undo-close", undoId: undo.undoId })
                }
              >
                Reopen {undo.count.toLocaleString()} tabs
              </button>
            ))}
          </div>
        ) : null}
        {actionResult?.kind === "undo-close" ? (
          <div className="duplicate-action-result" role="status">
            <span>
              Reopened {actionResult.restoredTabIds.length.toLocaleString()}; skipped {actionResult.skipped.length.toLocaleString()}; failed {actionResult.failed.length.toLocaleString()}.
            </span>
            {actionResult.retry ? (
              <button
                disabled={commandMutation.isPending}
                type="button"
                onClick={() => runCommand({ kind: "undo-close", undoId: actionResult.retry!.undoId })}
              >
                Retry {actionResult.retry.count.toLocaleString()} failed
              </button>
            ) : null}
          </div>
        ) : null}
        {actionResult?.kind === "open-workspace" ? (
          <p className="duplicate-action-result" role="status">
            Opened {actionResult.openedTabIds.length.toLocaleString()} workspace tabs; failed {actionResult.failed.length.toLocaleString()}.
          </p>
        ) : null}
        {actionFeedback ? <p className="duplicate-action-result" role="status">{actionFeedback}</p> : null}
        {actionError ? <p className="duplicate-action-error" role="alert">{actionError}</p> : null}

        <div className="physical-table-scroll">
          <table className="physical-tabs-table">
            <caption className="sr-only">
              Every physical tab currently reported by connected browsers
            </caption>
            <thead>
              <tr>
                <th data-column="select" scope="col">
                  <SelectionCheckbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected}
                    label="Select all open tabs on this page"
                    onChange={(checked) =>
                      updateSelection(tabs, checked)
                    }
                  />
                </th>
                <th scope="col">Open tab</th>
                <th scope="col">Browser location</th>
                <th scope="col">Protection</th>
                <th scope="col">Exact copies</th>
              </tr>
            </thead>
            <tbody>
              {tabs.map((tab) => (
                <OpenTabRow
                  activation={tabActivationAvailability(tab, activationProbe)}
                  activationInProgress={activationMutation.isPending}
                  activationError={
                    activationMutation.isError &&
                    activationMutation.variables?.instanceId === tab.instanceId
                      ? activationMutation.error.message
                      : undefined
                  }
                  isActivating={
                    activationMutation.isPending &&
                    activationMutation.variables?.instanceId === tab.instanceId
                  }
                  key={tab.instanceId}
                  selected={selection.has(tab.instanceId)}
                  tab={tab}
                  onActivateTab={(target) => activationMutation.mutate(target)}
                  onSelectedChange={(checked) =>
                    updateSelection([tab], checked)
                  }
                  onSelectCanonicalTab={onSelectCanonicalTab}
                />
              ))}
            </tbody>
          </table>

          {openTabsQuery.isPending ? (
            <div className="state-panel loading-state" role="status">
              <div className="spinner" aria-hidden="true" />
              <div>
                <strong>Loading every open tab</strong>
                <span>Reading physical browser occurrences...</span>
              </div>
            </div>
          ) : null}
          {openTabsQuery.isError ? (
            <div className="state-panel error-state" role="alert">
              <div className="state-icon" aria-hidden="true">!</div>
              <div>
                <strong>Couldn't load open tabs</strong>
                <span>{openTabsQuery.error.message}</span>
              </div>
              <button type="button" onClick={() => void openTabsQuery.refetch()}>
                Try again
              </button>
            </div>
          ) : null}
          {openTabsQuery.isSuccess &&
          openTabsQuery.data !== undefined &&
          isTrulyEmptyPage(openTabsQuery.data) ? (
            <div className="state-panel empty-state" role="status">
              <div>
                <strong>
                  {duplicatesOnly ? "No exact duplicates match" : "No open tabs match"}
                </strong>
                <span>
                  {duplicatesOnly
                    ? "Active and pinned tabs can still appear when they belong to a duplicate group."
                    : "Wait for a connected extension to send its next snapshot."}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {openTabsQuery.data && openTabsQuery.data.total > 0 ? (
          <nav className="pagination" aria-label="Open-tab list pages">
            <p>
              Page <strong>{openTabsQuery.data.page.toLocaleString()}</strong> of{" "}
              {totalPages.toLocaleString()}
            </p>
            <div>
              <button
                disabled={page <= 1 || openTabsQuery.isFetching}
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages || openTabsQuery.isFetching}
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                Next
              </button>
            </div>
          </nav>
        ) : null}
      </div>
      {pendingDialog ? (
        <TabOperationDialog
          busy={commandMutation.isPending}
          candidateCount={
            pendingDialog.kind === "close"
              ? pendingDialog.preview.candidateTabIds.length
              : pendingDialog.count
          }
          kind={pendingDialog.kind}
          protectedCount={
            pendingDialog.kind === "close" ? pendingDialog.preview.skipped.length : 0
          }
          onDismiss={dismissOperationDialog}
          onConfirm={() => {
            const command: TabCommand =
              pendingDialog.kind === "close"
                ? {
                    confirmed: true,
                    kind: "close",
                    previewId: pendingDialog.preview.previewId,
                  }
                : { kind: "reload", targets: commandTargets };
            void commandMutation
              .mutateAsync(command)
              .then(() => setPendingDialog(null))
              .catch(() => undefined);
          }}
        />
      ) : null}
      {workspacesOpen ? (
        <SavedWorkspacesDrawer
          busy={commandMutation.isPending}
          onClose={closeWorkspaces}
          onCommand={async (command) => {
            await commandMutation.mutateAsync(command);
          }}
        />
      ) : null}
    </section>
  );
}
