import type { TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  resolveCanonicalPrioritySelection,
  resolvePhysicalPrioritySelection,
} from "../src/physical-priority-selection";

function instance(instanceId: number, canonicalTabId: number): TabInstance {
  return { instanceId, canonicalTabId } as TabInstance;
}

describe("resolvePhysicalPrioritySelection", () => {
  it("deduplicates canonical aliases by logical identity", () => {
    expect(resolveCanonicalPrioritySelection([5, 8, 9], new Map([
      [5, 101], [8, 101], [9, 102],
    ]))).toEqual({ kind: "ready", canonicalTabIds: [5, 9], logicalPageCount: 2 });
  });
  it("counts cross-browser copies and canonical aliases of one logical page once", () => {
    const selection = new Map([
      [10, instance(10, 5)],
      [11, instance(11, 5)],
      [12, instance(12, 8)],
      [13, instance(13, 9)],
    ]);

    expect(resolvePhysicalPrioritySelection(selection, new Map([
      [5, 101],
      [8, 101],
      [9, 102],
    ]))).toEqual({
      kind: "ready",
      canonicalTabIds: [5, 9],
      logicalPageCount: 2,
    });
  });

  it("fails closed when any selected copy has no exact logical-page mapping", () => {
    expect(resolvePhysicalPrioritySelection(
      new Map([[10, instance(10, 5)], [11, instance(11, 8)]]),
      new Map([[5, 101]]),
    )).toEqual({ kind: "unresolved", unresolvedCanonicalTabIds: [8] });
  });
});
