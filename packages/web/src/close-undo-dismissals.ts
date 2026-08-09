import type { PhysicalTabScope } from "./extension-bridge";

export interface ScopedCloseUndo {
  scope: PhysicalTabScope;
  undoId: string;
}

export type CloseUndoDismissals = ReadonlySet<string>;

function scopedCloseUndoKey({ scope, undoId }: ScopedCloseUndo): string {
  return JSON.stringify([
    scope.browser,
    scope.installationId,
    scope.browserSessionId,
    undoId,
  ]);
}

export function dismissCloseUndos(
  current: CloseUndoDismissals,
  undos: readonly ScopedCloseUndo[],
): CloseUndoDismissals {
  const next = new Set(current);
  for (const undo of undos) next.add(scopedCloseUndoKey(undo));
  return next;
}

export function closeUndoIsDismissed(
  dismissals: CloseUndoDismissals,
  undo: ScopedCloseUndo,
): boolean {
  return dismissals.has(scopedCloseUndoKey(undo));
}
