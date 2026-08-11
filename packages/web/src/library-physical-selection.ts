import type { TabInstance, TabListItem } from "@tabhub/shared";

export type LibraryPhysicalSelection = Map<number, TabInstance>;

export interface LibraryPhysicalSelectionContext {
  filterKey: string;
  mode: "canonical" | "physical";
}

/** A completed physical resolver is the current truth even when the
 * independently paginated canonical snapshot was rendered earlier. */
export function effectiveLibraryOpenCopyCount(
  reportedCount: number,
  instances: readonly TabInstance[],
  resolutionComplete: boolean,
): number {
  return resolutionComplete ? instances.length : reportedCount;
}

/**
 * Treat a canonical Library row as the parent of all of its currently known
 * physical copies. Selecting a one-copy parent therefore selects exactly one
 * physical tab; selecting a duplicated parent selects every disclosed copy.
 */
export function setLibraryCanonicalRowsSelected(
  current: LibraryPhysicalSelection,
  rows: readonly Pick<TabListItem, "id">[],
  instances: readonly TabInstance[],
  selected: boolean,
): LibraryPhysicalSelection {
  const canonicalIds = new Set(rows.map(({ id }) => id));
  const next = new Map(current);

  if (selected) {
    for (const instance of instances) {
      if (canonicalIds.has(instance.canonicalTabId)) {
        next.set(instance.instanceId, instance);
      }
    }
  } else {
    for (const [instanceId, instance] of next) {
      if (canonicalIds.has(instance.canonicalTabId)) {
        next.delete(instanceId);
      }
    }
  }

  return next;
}

export function setLibraryPhysicalInstanceSelected(
  current: LibraryPhysicalSelection,
  instance: TabInstance,
  selected: boolean,
): LibraryPhysicalSelection {
  const next = new Map(current);
  if (selected) next.set(instance.instanceId, instance);
  else next.delete(instance.instanceId);
  return next;
}

/** Replace retained selections with fresh snapshot values and forget copies
 * which are no longer physically open. */
export function reconcileLibraryPhysicalSelection(
  current: LibraryPhysicalSelection,
  snapshot: readonly TabInstance[],
): LibraryPhysicalSelection {
  const currentInstances = new Map(
    snapshot.map((instance) => [instance.instanceId, instance]),
  );
  return new Map(
    [...current.keys()].flatMap((instanceId) => {
      const instance = currentInstances.get(instanceId);
      return instance === undefined
        ? []
        : ([[instanceId, instance]] as const);
    }),
  );
}

/**
 * A physical selection survives pagination within one filtered result set.
 * Carrying it into a different filter or metadata-selection mode would make
 * unrelated invisible tabs act on a browser, so those transitions clear it.
 */
export function retainLibraryPhysicalSelectionForContext(
  current: LibraryPhysicalSelection,
  previous: LibraryPhysicalSelectionContext,
  next: LibraryPhysicalSelectionContext,
): LibraryPhysicalSelection {
  return previous.filterKey === next.filterKey && previous.mode === next.mode
    ? current
    : new Map();
}
