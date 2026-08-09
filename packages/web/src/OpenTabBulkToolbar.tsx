import type { BrowserWindowSummary, MoveDestination } from "./extension-bridge";
import { useI18n } from "./i18n";
import type { TabExportFormat } from "./tab-export";

export function OpenTabSelectionMenu({
  busy,
  hostname,
  onHostnameChange,
  onSelectAllResults,
  onSelectExactCopies,
  onSelectHostname,
  onSelectOld,
  onSelectVisible,
}: {
  busy: boolean;
  hostname: string;
  onHostnameChange: (value: string) => void;
  onSelectAllResults: () => void;
  onSelectExactCopies: () => void;
  onSelectHostname: () => void;
  onSelectOld: (days: number) => void;
  onSelectVisible: () => void;
}) {
  const { formatNumber, t } = useI18n();

  return (
    <details className="open-tab-menu selection-preset-menu">
      <summary>{t("Select")}</summary>
      <div>
        <button disabled={busy} type="button" onClick={onSelectVisible}>{t("Visible page")}</button>
        <button disabled={busy} type="button" onClick={onSelectAllResults}>{t("All filtered results")}</button>
        <button disabled={busy} type="button" onClick={onSelectExactCopies}>{t("Extra exact copies")}</button>
        {[7, 30, 90].map((days) => (
          <button disabled={busy} key={days} type="button" onClick={() => onSelectOld(days)}>
            {t("Inactive for {count} days", {
              count: formatNumber(days),
              rawCount: days,
            })}
          </button>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSelectHostname();
          }}
        >
          <input
            aria-label={t("Exact hostname")}
            disabled={busy}
            placeholder="example.com"
            value={hostname}
            onChange={(event) => onHostnameChange(event.target.value)}
          />
          <button disabled={busy || !hostname.trim()} type="submit">{t("Select host")}</button>
        </form>
      </div>
    </details>
  );
}

function destinationValue(destination: MoveDestination): string {
  return destination.kind === "window" ? `window:${destination.windowId}` : destination.kind;
}

function parseDestination(value: string): MoveDestination {
  if (value === "app-window" || value === "new-window") return { kind: value };
  return { kind: "window", windowId: Number(value.slice("window:".length)) };
}

export function OpenTabBulkToolbar({
  busy,
  closeableCount,
  controlStatus,
  controlWindowId,
  controllableCount,
  destination,
  onClear,
  onClose,
  onCopy,
  onDestinationChange,
  onDiscard,
  onMove,
  onReload,
  onSaveWorkspace,
  onSaveWorkspaceAndClose,
  onSetMuted,
  onSetPinned,
  selectedCount,
  showAppWindowDestination = true,
  windows,
}: {
  busy: boolean;
  closeableCount: number;
  controlStatus?: string | undefined;
  controlWindowId: number | null;
  controllableCount: number;
  destination: MoveDestination;
  onClear: () => void;
  onClose: () => void;
  onCopy: (format: TabExportFormat) => void;
  onDestinationChange: (destination: MoveDestination) => void;
  onDiscard: () => void;
  onMove: () => void;
  onReload: () => void;
  onSaveWorkspace: () => void;
  onSaveWorkspaceAndClose: () => void;
  onSetMuted: (value: boolean) => void;
  onSetPinned: (value: boolean) => void;
  selectedCount: number;
  showAppWindowDestination?: boolean | undefined;
  windows: BrowserWindowSummary[];
}) {
  const { formatNumber, t } = useI18n();
  const liveDisabled = busy || controllableCount === 0;
  const closeDisabled = busy || closeableCount === 0;

  return (
    <div className="bulk-toolbar open-tab-bulk-toolbar" aria-label={t("Open-tab bulk actions")}>
      <strong>{t("{count} selected", {
        count: formatNumber(selectedCount),
        rawCount: selectedCount,
      })}</strong>
      <span>
        {controlStatus ??
          t("{count} controllable here", {
            count: formatNumber(controllableCount),
            rawCount: controllableCount,
          })}
      </span>
      <label>
        <span>{t("Move destination")}</span>
        <select
          aria-label={t("Move destination")}
          disabled={liveDisabled}
          value={destinationValue(destination)}
          onChange={(event) => onDestinationChange(parseDestination(event.target.value))}
        >
          {showAppWindowDestination ? (
            <option value="app-window">
              {controlWindowId === null
                ? t("This TabHub window")
                : t("This TabHub window ({id})", {
                    id: formatNumber(controlWindowId),
                  })}
            </option>
          ) : null}
          <option value="new-window">{t("New window")}</option>
          {windows.map((window) => (
            <option key={window.windowId} value={`window:${window.windowId}`}>
              {t("Window {id} · {count} tabs", {
                count: formatNumber(window.tabCount),
                id: formatNumber(window.windowId),
                rawCount: window.tabCount,
              })}
              {window.focused ? ` · ${t("focused")}` : ""}
            </option>
          ))}
        </select>
      </label>
      <button disabled={liveDisabled} type="button" onClick={onMove}>{t("Move")}</button>
      <button className="danger-action" disabled={closeDisabled} type="button" onClick={onClose}>
        {t("Close {count}…", {
          count: formatNumber(closeableCount),
          rawCount: closeableCount,
        })}
      </button>
      <details className="open-tab-menu">
        <summary>{t("More")}</summary>
        <div>
          <button disabled={liveDisabled} type="button" onClick={() => onSetPinned(true)}>{t("Pin")}</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetPinned(false)}>{t("Unpin")}</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetMuted(true)}>{t("Mute")}</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetMuted(false)}>{t("Unmute")}</button>
          <button disabled={liveDisabled} type="button" onClick={onDiscard}>{t("Sleep")}</button>
          <button disabled={liveDisabled} type="button" onClick={onReload}>{t("Reload…")}</button>
          <button disabled={busy} type="button" onClick={onSaveWorkspace}>{t("Save as workspace…")}</button>
          <button disabled={closeDisabled} type="button" onClick={onSaveWorkspaceAndClose}>{t("Save & close…")}</button>
          <hr />
          <button disabled={busy} type="button" onClick={() => onCopy("urls")}>{t("Copy URLs")}</button>
          <button disabled={busy} type="button" onClick={() => onCopy("markdown")}>{t("Copy Markdown")}</button>
          <button disabled={busy} type="button" onClick={() => onCopy("json")}>{t("Copy JSON")}</button>
        </div>
      </details>
      <button className="bulk-clear" disabled={busy} type="button" onClick={onClear}>{t("Clear")}</button>
    </div>
  );
}
