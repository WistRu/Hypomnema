import type {
  PhysicalTabCloseUndoSummary,
  PhysicalTabCommandScope,
  PhysicalWindowSummary,
} from "./physical-tab-commands";

export interface BrowserState {
  pendingUndos: PhysicalTabCloseUndoSummary[];
  windows: PhysicalWindowSummary[];
}

export interface BrowserStateSource {
  listPendingUndos(
    scope: PhysicalTabCommandScope,
  ): Promise<PhysicalTabCloseUndoSummary[]>;
  listWindows(): Promise<PhysicalWindowSummary[]>;
}

/**
 * Read the state exposed by both the same-page probe and the addressed relay.
 * An unconfigured extension can still describe its windows, but it cannot own
 * session-scoped Undo entries yet.
 */
export async function readBrowserState(
  source: BrowserStateSource,
  scope: PhysicalTabCommandScope | undefined,
): Promise<BrowserState> {
  const [windows, pendingUndos] = await Promise.all([
    source.listWindows(),
    scope === undefined
      ? Promise.resolve([])
      : source.listPendingUndos(scope),
  ]);
  return { pendingUndos, windows };
}
