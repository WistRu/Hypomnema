import { useEffect, useRef } from "react";

import { activateModalDialog } from "./modal-dialog";

export function TabOperationDialog({
  busy,
  candidateCount,
  kind,
  protectedCount,
  onConfirm,
  onDismiss,
}: {
  busy: boolean;
  candidateCount: number;
  kind: "close" | "reload";
  protectedCount: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return activateModalDialog(dialog, trigger, onDismiss);
  }, [onDismiss]);

  const closing = kind === "close";
  return (
    <div className="confirmation-backdrop">
      <section
        aria-labelledby="tab-operation-title"
        aria-modal="true"
        className="duplicate-confirmation"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <p>{closing ? "Destructive browser action" : "Page state warning"}</p>
        <h3 id="tab-operation-title">
          {closing ? `Close ${candidateCount.toLocaleString()} tabs?` : `Reload ${candidateCount.toLocaleString()} tabs?`}
        </h3>
        <div>
          {closing ? (
            <p>Active, pinned, changed, TabHub control tabs, and exact-copy keepers are protected and rechecked immediately before closing.</p>
          ) : (
            <p>Reloading can discard unsaved form edits and in-page state. The TabHub control tab is protected.</p>
          )}
          {protectedCount > 0 ? <p>{protectedCount.toLocaleString()} selected tabs are already excluded by the preview.</p> : null}
        </div>
        <div className="confirmation-actions">
          <button disabled={busy} type="button" onClick={onDismiss}>Cancel</button>
          <button className={closing ? "danger-action" : "secondary-action"} disabled={busy || candidateCount === 0} type="button" onClick={onConfirm}>
            {busy ? "Working…" : closing ? "Close tabs" : "Reload tabs"}
          </button>
        </div>
      </section>
    </div>
  );
}
