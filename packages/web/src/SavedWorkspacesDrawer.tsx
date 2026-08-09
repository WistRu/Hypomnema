import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteWorkspace,
  fetchWorkspace,
  fetchWorkspaces,
  renameWorkspace,
} from "./api";
import {
  ExtensionBridgeTimeoutError,
  type MoveDestination,
  type TabCommand,
} from "./extension-bridge";
import { activateModalDialog } from "./modal-dialog";
import { createWorkspaceRestoreLock } from "./workspace-restore-lock";

function actionErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SavedWorkspacesDrawer({
  busy,
  onClose,
  onCommand,
}: {
  busy: boolean;
  onClose: () => void;
  onCommand: (command: TabCommand) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const drawerRef = useRef<HTMLElement>(null);
  const restoreLock = useRef(createWorkspaceRestoreLock());
  const restorePendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<
    number | null
  >(null);
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: ({ signal }) => fetchWorkspaces(signal) });
  const deleteMutation = useMutation({
    mutationFn: deleteWorkspace,
    onMutate: () => setError(null),
    onError: (cause) => setError(actionErrorMessage(cause)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => renameWorkspace(id, name),
    onMutate: () => setError(null),
    onError: (cause) => setError(actionErrorMessage(cause)),
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
  const openWorkspace = (id: number, destination: MoveDestination) =>
    restoreLock.current.run(async () => {
      setRestoringWorkspaceId(id);
      setError(null);
      try {
        const detail = await fetchWorkspace(id);
        await onCommand({
          destination: destination.kind === "new-window" ? destination : { kind: "app-window" },
          kind: "open-workspace",
          tabs: detail.items.map((item) => ({
            muted: item.muted,
            pinned: item.pinned,
            url: item.url,
          })),
        });
      } catch (cause) {
        if (cause instanceof ExtensionBridgeTimeoutError) {
          setError(
            `${cause.message} Restore controls remain locked; verify the browser tabs before reloading TabHub.`,
          );
          return;
        }
        setError(actionErrorMessage(cause));
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
          <div><p>Saved sessions</p><h3 id="saved-workspaces-title">Workspaces</h3></div>
          <button disabled={restorePending} type="button" onClick={dismiss}>Close</button>
        </header>
        {workspaces.isPending ? <p role="status">Loading workspaces…</p> : null}
        {workspaces.isError ? <p role="alert">{workspaces.error.message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="workspace-drawer-list">
          {workspaces.data?.items.map((workspace) => (
            <article key={workspace.id}>
              <div>
                <strong>{workspace.name}</strong>
                <span>{workspace.itemCount.toLocaleString()} tabs</span>
              </div>
              <div>
                <button disabled={drawerBusy} type="button" onClick={() => void openWorkspace(workspace.id, { kind: "app-window" })}>{restoringWorkspaceId === workspace.id ? "Opening..." : "Open here"}</button>
                <button disabled={drawerBusy} type="button" onClick={() => void openWorkspace(workspace.id, { kind: "new-window" })}>{restoringWorkspaceId === workspace.id ? "Opening..." : "New window"}</button>
                <button
                  disabled={drawerBusy}
                  type="button"
                  onClick={() => {
                    const name = window.prompt("Workspace name", workspace.name)?.trim();
                    if (name) renameMutation.mutate({ id: workspace.id, name });
                  }}
                >Rename</button>
                <button
                  disabled={drawerBusy}
                  type="button"
                  onClick={() => window.confirm(`Delete workspace “${workspace.name}”?`) && deleteMutation.mutate(workspace.id)}
                >Delete</button>
              </div>
            </article>
          ))}
          {workspaces.data?.items.length === 0 ? <p>No saved workspaces yet.</p> : null}
        </div>
      </aside>
    </div>
  );
}
