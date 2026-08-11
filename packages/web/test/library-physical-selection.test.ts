import type { TabInstance, TabListItem } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  effectiveLibraryOpenCopyCount,
  reconcileLibraryPhysicalSelection,
  retainLibraryPhysicalSelectionForContext,
  setLibraryCanonicalRowsSelected,
  setLibraryPhysicalInstanceSelected,
  type LibraryPhysicalSelection,
} from "../src/library-physical-selection";

function canonicalTab(id: number): Pick<TabListItem, "id"> {
  return { id };
}

function physicalTab(
  instanceId: number,
  canonicalTabId: number,
  overrides: Partial<TabInstance> = {},
): TabInstance {
  return {
    active: false,
    audible: false,
    browser: "chrome",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    browserTabId: 100 + instanceId,
    canonicalTabId,
    discarded: false,
    duplicateGroupSize: 1,
    engagedTimeMs: 0,
    faviconUrl: null,
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    foregroundTimeMs: 0,
    importance: 0,
    index: instanceId,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    instanceId,
    lastAccessed: null,
    lastSeenAt: "2026-08-11T00:01:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: `Physical tab ${instanceId}`,
    url: `https://example.com/${canonicalTabId}`,
    urlNormalized: `https://example.com/${canonicalTabId}`,
    windowId: 1,
    ...overrides,
  };
}

function ids(selection: LibraryPhysicalSelection): number[] {
  return [...selection.keys()];
}

describe("Library physical selection", () => {
  it("prefers the fresh physical snapshot over a stale canonical count", () => {
    expect(effectiveLibraryOpenCopyCount(0, [physicalTab(1, 7)], true)).toBe(1);
    expect(effectiveLibraryOpenCopyCount(2, [], true)).toBe(0);
    expect(effectiveLibraryOpenCopyCount(2, [], false)).toBe(2);
  });

  it("selects every physical copy represented by selected canonical rows", () => {
    const firstCopy = physicalTab(1, 7, { duplicateGroupSize: 2 });
    const secondCopy = physicalTab(2, 7, { duplicateGroupSize: 2 });
    const uniqueCopy = physicalTab(3, 8);
    const hiddenCopy = physicalTab(4, 9);

    const selection = setLibraryCanonicalRowsSelected(
      new Map(),
      [canonicalTab(7), canonicalTab(8)],
      [firstCopy, secondCopy, uniqueCopy, hiddenCopy],
      true,
    );

    expect(ids(selection)).toEqual([1, 2, 3]);
    expect(selection.get(3)).toBe(uniqueCopy);
  });

  it("deselects every selected copy belonging to a canonical parent", () => {
    const firstCopy = physicalTab(1, 7, { duplicateGroupSize: 2 });
    const secondCopy = physicalTab(2, 7, { duplicateGroupSize: 2 });
    const otherCopy = physicalTab(3, 8);
    const selection = new Map([
      [firstCopy.instanceId, firstCopy],
      [secondCopy.instanceId, secondCopy],
      [otherCopy.instanceId, otherCopy],
    ]);

    expect(
      ids(
        setLibraryCanonicalRowsSelected(
          selection,
          [canonicalTab(7)],
          [firstCopy, secondCopy],
          false,
        ),
      ),
    ).toEqual([3]);
  });

  it("toggles one disclosed physical child without changing its siblings", () => {
    const firstCopy = physicalTab(1, 7, { duplicateGroupSize: 2 });
    const secondCopy = physicalTab(2, 7, { duplicateGroupSize: 2 });
    const selected = setLibraryPhysicalInstanceSelected(
      new Map([[firstCopy.instanceId, firstCopy]]),
      secondCopy,
      true,
    );

    expect(ids(selected)).toEqual([1, 2]);
    expect(
      ids(setLibraryPhysicalInstanceSelected(selected, firstCopy, false)),
    ).toEqual([2]);
  });

  it("drops vanished instances and refreshes retained instance state", () => {
    const stale = physicalTab(1, 7, { muted: false, windowId: 9 });
    const vanished = physicalTab(2, 7);
    const fresh = { ...stale, muted: true, windowId: 3 };

    const reconciled = reconcileLibraryPhysicalSelection(
      new Map([
        [stale.instanceId, stale],
        [vanished.instanceId, vanished],
      ]),
      [fresh, physicalTab(3, 8)],
    );

    expect([...reconciled.values()]).toEqual([fresh]);
  });

  it("keeps selection across pages and clears it only when filters or mode change", () => {
    const selected = physicalTab(1, 7);
    const selection = new Map([[selected.instanceId, selected]]);
    const physicalSelection = {
      filterKey: '{"browser":"all","openState":"open"}',
      mode: "physical" as const,
    };
    const sameFiltersOnNextPage = { ...physicalSelection };

    expect(
      retainLibraryPhysicalSelectionForContext(
        selection,
        physicalSelection,
        sameFiltersOnNextPage,
      ),
    ).toBe(selection);
    expect(
      retainLibraryPhysicalSelectionForContext(selection, physicalSelection, {
        ...physicalSelection,
        filterKey: '{"browser":"chrome","openState":"open"}',
      }).size,
    ).toBe(0);
    expect(
      retainLibraryPhysicalSelectionForContext(selection, physicalSelection, {
        ...physicalSelection,
        mode: "canonical",
      }).size,
    ).toBe(0);
  });
});
