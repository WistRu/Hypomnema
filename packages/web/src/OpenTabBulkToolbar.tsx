import type { BrowserWindowSummary, MoveDestination } from "./extension-bridge";
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
  return (
    <details className="open-tab-menu selection-preset-menu">
      <summary>Select</summary>
      <div>
        <button disabled={busy} type="button" onClick={onSelectVisible}>Visible page</button>
        <button disabled={busy} type="button" onClick={onSelectAllResults}>All filtered results</button>
        <button disabled={busy} type="button" onClick={onSelectExactCopies}>Extra exact copies</button>
        {[7, 30, 90].map((days) => (
          <button disabled={busy} key={days} type="button" onClick={() => onSelectOld(days)}>
            Inactive for {days} days
          </button>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSelectHostname();
          }}
        >
          <input
            aria-label="Exact hostname"
            disabled={busy}
            placeholder="example.com"
            value={hostname}
            onChange={(event) => onHostnameChange(event.target.value)}
          />
          <button disabled={busy || !hostname.trim()} type="submit">Select host</button>
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
  windows,
}: {
  busy: boolean;
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
  windows: BrowserWindowSummary[];
}) {
  const overLimit = controllableCount > 500;
  const liveDisabled = busy || controllableCount === 0 || overLimit;

  return (
    <div className="bulk-toolbar open-tab-bulk-toolbar" aria-label="Open-tab bulk actions">
      <strong>{selectedCount.toLocaleString()} selected</strong>
      <span>{controllableCount.toLocaleString()} controllable here</span>
      {overLimit ? <span className="bulk-error" role="alert">Select at most 500 for browser actions.</span> : null}
      <label>
        <span>Move destination</span>
        <select
          aria-label="Move destination"
          disabled={liveDisabled}
          value={destinationValue(destination)}
          onChange={(event) => onDestinationChange(parseDestination(event.target.value))}
        >
          <option value="app-window">This TabHub window{controlWindowId === null ? "" : ` (${controlWindowId})`}</option>
          <option value="new-window">New window</option>
          {windows.map((window) => (
            <option key={window.windowId} value={`window:${window.windowId}`}>
              Window {window.windowId} · {window.tabCount} tabs{window.focused ? " · focused" : ""}
            </option>
          ))}
        </select>
      </label>
      <button disabled={liveDisabled} type="button" onClick={onMove}>Move</button>
      <button className="danger-action" disabled={liveDisabled} type="button" onClick={onClose}>
        Close {controllableCount.toLocaleString()}…
      </button>
      <details className="open-tab-menu">
        <summary>More</summary>
        <div>
          <button disabled={liveDisabled} type="button" onClick={() => onSetPinned(true)}>Pin</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetPinned(false)}>Unpin</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetMuted(true)}>Mute</button>
          <button disabled={liveDisabled} type="button" onClick={() => onSetMuted(false)}>Unmute</button>
          <button disabled={liveDisabled} type="button" onClick={onDiscard}>Sleep</button>
          <button disabled={liveDisabled} type="button" onClick={onReload}>Reload…</button>
          <button disabled={busy} type="button" onClick={onSaveWorkspace}>Save as workspace…</button>
          <button disabled={busy || liveDisabled} type="button" onClick={onSaveWorkspaceAndClose}>Save &amp; close…</button>
          <hr />
          <button disabled={busy} type="button" onClick={() => onCopy("urls")}>Copy URLs</button>
          <button disabled={busy} type="button" onClick={() => onCopy("markdown")}>Copy Markdown</button>
          <button disabled={busy} type="button" onClick={() => onCopy("json")}>Copy JSON</button>
        </div>
      </details>
      <button className="bulk-clear" disabled={busy} type="button" onClick={onClear}>Clear</button>
    </div>
  );
}
