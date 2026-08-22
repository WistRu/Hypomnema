import type { TabInstance } from "@tabhub/shared";

export type PhysicalPrioritySelectionResolution =
  | {
      readonly kind: "ready";
      readonly canonicalTabIds: readonly number[];
      readonly logicalPageCount: number;
    }
  | {
      readonly kind: "unresolved";
      readonly unresolvedCanonicalTabIds: readonly number[];
    };

export function resolveCanonicalPrioritySelection(
  canonicalTabIds: readonly number[],
  logicalPageByCanonicalTabId: ReadonlyMap<number, number>,
): PhysicalPrioritySelectionResolution {
  const uniqueCanonicalIds = [...new Set(canonicalTabIds)].sort((left, right) => left - right);
  const unresolvedCanonicalTabIds = uniqueCanonicalIds.filter((canonicalTabId) =>
    !logicalPageByCanonicalTabId.has(canonicalTabId),
  );
  if (unresolvedCanonicalTabIds.length > 0) {
    return { kind: "unresolved", unresolvedCanonicalTabIds };
  }
  const canonicalByLogicalPage = new Map<number, number>();
  for (const canonicalTabId of uniqueCanonicalIds) {
    const logicalPageId = logicalPageByCanonicalTabId.get(canonicalTabId)!;
    if (!canonicalByLogicalPage.has(logicalPageId)) {
      canonicalByLogicalPage.set(logicalPageId, canonicalTabId);
    }
  }
  return {
    kind: "ready",
    canonicalTabIds: [...canonicalByLogicalPage.values()],
    logicalPageCount: canonicalByLogicalPage.size,
  };
}

/**
 * Converts exact browser-copy selection into one canonical write target per
 * logical page. The operation fails closed when any selected copy cannot be
 * tied to a known logical page, so the UI never reports an estimated count.
 */
export function resolvePhysicalPrioritySelection(
  selection: ReadonlyMap<number, TabInstance>,
  logicalPageByCanonicalTabId: ReadonlyMap<number, number>,
): PhysicalPrioritySelectionResolution {
  const canonicalIds = [...new Set(
    [...selection.values()].map(({ canonicalTabId }) => canonicalTabId),
  )];
  return resolveCanonicalPrioritySelection(canonicalIds, logicalPageByCanonicalTabId);
}
