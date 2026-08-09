import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteWorkspace,
  fetchWorkspace,
  fetchWorkspaces,
  renameWorkspace,
} from "./api";
import type { TabCommand } from "./extension-bridge";
import { useI18n } from "./i18n";
import { activateModalDialog } from "./modal-dialog";
import { createWorkspaceRestoreLock } from "./workspace-restore-lock";
import {
  isWorkspaceRestoreOutcomeUnknown,
  workspaceRestoreDestination,
  type WorkspaceCommandTarget,
  type WorkspaceRestoreDestination,
} from "./workspace-restore-routing";

type DrawerError =
  | { cause: unknown; kind: "cause" }
  | { cause: unknown; kind: "restore-timeout" };

function commandTargetKey(target: WorkspaceCommandTarget): string {
  const { browser, browserSessionId, installationId } = target.scope;
  return `${browser}\n${installationId}\n${browserSessionId}`;
}

export function SavedWorkspacesDrawer({
  busy,
  onClose,
  onCommand,
  targets,
}: {
  busy: boolean;
  onClose: () => void;
  onCommand: (
    command: TabCommand,
    scope: WorkspaceCommandTarget["scope"],
  ) => Promise<void>;
  targets: readonly WorkspaceCommandTarget[];
}) {
  const { errorMessage, formatNumber, t } = useI18n();
  const queryClient = useQueryClient();
  const drawerRef = useRef<HTMLElement>(null);
  const restoreLock = useRef(createWorkspaceRestoreLock());
  const restorePendingRef = useRef(false);
  const [error, setError] = useState<DrawerError | null>(null);
  const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<
    number | null
  >(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState(
    () => targets[0] === undefined ? "" : commandTargetKey(targets[0]),
  );
  const selectedTarget =
    targets.find((target) => commandTargetKey(target) === selectedTargetKey) ??
    targets[0] ??
    null;
  useEffect(() => {
    if (
      selectedTarget === null ||
      commandTargetKey(selectedTarget) !== selectedTargetKey
    ) {
      setSelectedTargetKey(
        targets[0] === undefined ? "" : commandTargetKey(targets[0]),
      );
    }
  }, [selectedTarget, selectedTargetKey, targets]);
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: ({ signal }) => fetchWorkspaces(signal) });
  const deleteMutation = useMutation({
    mutationFn: deleteWorkspace,
    onMutate: () => setError(null),
    onError: (cause) => setError({ cause, kind: "cause" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => renameWorkspace(id, name),
    onMutate: () => setError(null),
    onError: (cause) => setError({ cause, kind: "cause" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  });
  const mutationsPending = deleteMutation.isPending || renameMutation.isPending;
  const restorePending = restoringWorkspaceId !== null;
  restorePendingRef.current = restorePending;
  const drawerBusy = busy || restorePending || mutationsPending;
  const dismiss = useCallback(() => {
    if (!restorePendingRef.current) onClose();
  }, [onClose]);
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return activateModalDialog(drawer, trigger, dismiss);
  }, [dismiss]);
  const openWorkspace = (
    id: number,
    destination: WorkspaceRestoreDestination,
    target: WorkspaceCommandTarget,
  ) =>
    restoreLock.current.run(async () => {
      setRestoringWorkspaceId(id);
      setError(null);
      try {
        const routedDestination = workspaceRestoreDestination(
          target.direct,
          destination,
        );
        if (routedDestination === null) {
          throw new Error(
            "A remote workspace can only be opened in a new browser window.",
          );
        }
        const detail = await fetchWorkspace(id);
        await onCommand(
          {
            destination: routedDestination,
            kind: "open-workspace",
            tabs: detail.items.map((item) => ({
              muted: item.muted,
              pinned: item.pinned,
              url: item.url,
            })),
          },
          target.scope,
        );
      } catch (cause) {
        if (isWorkspaceRestoreOutcomeUnknown(cause)) {
          setError({ cause, kind: "restore-timeout" });
          return;
        }
        setError({ cause, kind: "cause" });
      }
      setRestoringWorkspaceId(null);
    });

  return (
    <div className="workspace-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && dismiss()}>
      <aside
        aria-labelledby="saved-workspaces-title"
        aria-modal="true"
        className="workspace-drawer"
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div><p>{t("Saved sessions")}</p><h3 id="saved-workspaces-title">{t("Workspaces")}</h3></div>
          <button disabled={restorePending} type="button" onClick={dismiss}>{t("Close")}</button>
        </header>
        {workspaces.isPending ? <p role="status">{t("Loading workspaces…")}</p> : null}
        {workspaces.isError ? <p role="alert">{errorMessage(workspaces.error)}</p> : null}
        {error ? (
          <p role="alert">
            {error.kind === "restore-timeout"
              ? t("{message} Restore controls remain locked; verify the browser tabs before reloading TabHub.", {
                  message: errorMessage(error.cause),
                })
              : errorMessage(error.cause)}
          </p>
        ) : null}
        <label className="workspace-command-target">
          <span>{t("Browser profile")}</span>
          <select
            aria-label={t("Browser profile")}
            disabled={drawerBusy || targets.length === 0}
            value={selectedTarget === null ? "" : commandTargetKey(selectedTarget)}
            onChange={(event) => setSelectedTargetKey(event.target.value)}
          >
            {targets.length === 0 ? (
              <option value="">{t("No connected browser profiles")}</option>
            ) : null}
            {targets.map((target) => (
              <option key={commandTargetKey(target)} value={commandTargetKey(target)}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
        <div className="workspace-drawer-list">
          {workspaces.data?.items.map((workspace) => (
            <article key={workspace.id}>
              <div>
                <strong>{workspace.name}</strong>
                <span>{t("{count} tabs", {
                  count: formatNumber(workspace.itemCount),
                  rawCount: workspace.itemCount,
                })}</span>
              </div>
              <div>
                {selectedTarget?.direct ? (
                  <button
                    disabled={drawerBusy}
                    type="button"
                    onClick={() => void openWorkspace(
                      workspace.id,
                      { kind: "app-window" },
                      selectedTarget,
                    )}
                  >
                    {restoringWorkspaceId === workspace.id ? t("Opening...") : t("Open here")}
                  </button>
                ) : null}
                <button
                  disabled={drawerBusy || selectedTarget === null}
                  type="button"
                  onClick={() => selectedTarget === null
                    ? undefined
                    : void openWorkspace(
                        workspace.id,
                        { kind: "new-window" },
                        selectedTarget,
                      )}
                >
                  {restoringWorkspaceId === workspace.id ? t("Opening...") : t("New window")}
                </button>
                <button
                  disabled={drawerBusy}
                  type="button"
                  onClick={() => {
                    const name = window.prompt(t("Workspace name"), workspace.name)?.trim();
                    if (name) renameMutation.mutate({ id: workspace.id, name });
                  }}
                >{t("Rename")}</button>
                <button
                  disabled={drawerBusy}
                  type="button"
                  onClick={() => window.confirm(t("Delete workspace “{name}”?", {
                    name: workspace.name,
                  })) && deleteMutation.mutate(workspace.id)}
                >{t("Delete")}</button>
              </div>
            </article>
          ))}
          {workspaces.data?.items.length === 0 ? <p>{t("No saved workspaces yet.")}</p> : null}
        </div>
      </aside>
    </div>
  );
}
