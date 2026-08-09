import { useEffect, useRef } from "react";

import { useI18n } from "./i18n";
import { activateModalDialog } from "./modal-dialog";

export function TabOperationDialog({
  blockingMessage,
  busy,
  candidateCount,
  confirmationBlocked = false,
  kind,
  protectedCount,
  onConfirm,
  onDismiss,
}: {
  blockingMessage?: string | undefined;
  busy: boolean;
  candidateCount: number;
  confirmationBlocked?: boolean | undefined;
  kind: "close" | "reload";
  protectedCount: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const { formatNumber, t } = useI18n();
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
        <p>{closing ? t("Destructive browser action") : t("Page state warning")}</p>
        <h3 id="tab-operation-title">
          {closing
            ? t("Close {count} tabs?", {
                count: formatNumber(candidateCount),
                rawCount: candidateCount,
              })
            : t("Reload {count} tabs?", {
                count: formatNumber(candidateCount),
                rawCount: candidateCount,
              })}
        </h3>
        <div>
          {closing ? (
            <p>{t("Pinned, changed, TabHub control tabs, and exact-copy keepers are protected and rechecked immediately before closing.")}</p>
          ) : (
            <p>{t("Reloading can discard unsaved form edits and in-page state. The TabHub control tab is protected.")}</p>
          )}
          {protectedCount > 0 ? (
            <p>{t("{count} selected tabs are already excluded by the preview.", {
              count: formatNumber(protectedCount),
              rawCount: protectedCount,
            })}</p>
          ) : null}
          {blockingMessage ? (
            <p className="duplicate-action-error" role="alert">
              {blockingMessage}
            </p>
          ) : null}
        </div>
        <div className="confirmation-actions">
          <button disabled={busy} type="button" onClick={onDismiss}>{t("Cancel")}</button>
          <button className={closing ? "danger-action" : "secondary-action"} disabled={busy || candidateCount === 0 || confirmationBlocked} type="button" onClick={onConfirm}>
            {busy ? t("Working…") : closing ? t("Close tabs") : t("Reload tabs")}
          </button>
        </div>
      </section>
    </div>
  );
}
