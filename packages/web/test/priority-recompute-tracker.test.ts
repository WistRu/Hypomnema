import { describe, expect, it, vi } from "vitest";

import {
  createPriorityRecomputeTracker,
  priorityRecomputeStorageKey,
} from "../src/priority-recompute-tracker";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(priorityRecomputeStorageKey, initial);
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe("priority recompute tracker", () => {
  it("persists and resumes a durable priority job across reload", () => {
    const store = storage();
    const tracker = createPriorityRecomputeTracker(store);
    tracker.remember({ id: "priority_assessment:17", kind: "priority_assessment", status: "queued" });

    expect(createPriorityRecomputeTracker(store).resume()).toEqual({
      id: "priority_assessment:17", kind: "priority_assessment", status: "queued",
    });
  });

  it("fails closed on corrupt/other-kind state and clears only terminal jobs", () => {
    const corrupt = storage('{"id":"summary:1","kind":"summary","status":"queued"}');
    expect(createPriorityRecomputeTracker(corrupt).resume()).toBeNull();
    expect(corrupt.removeItem).toHaveBeenCalledWith(priorityRecomputeStorageKey);

    const store = storage();
    const tracker = createPriorityRecomputeTracker(store);
    tracker.remember({ id: "priority_assessment:17", kind: "priority_assessment", status: "running" });
    tracker.observe("running");
    expect(tracker.resume()).not.toBeNull();
    tracker.observe("succeeded");
    expect(tracker.resume()).toBeNull();

    tracker.remember({ id: "priority_assessment:18", kind: "priority_assessment",
      status: "queued" });
    tracker.observe("superseded");
    expect(tracker.resume()).toBeNull();
  });
});
