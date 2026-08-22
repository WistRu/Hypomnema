import type { ResourceSummary } from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { applyResourceEvaluationBulk } from "../src/resource-priority-bulk";

function resource(id: number, logicalPageCount: number): ResourceSummary {
  return {
    resource: { id, resourceKey: `resource-${id}`, name: `Resource ${id}`, kind: "website",
      accessClass: "public", lifecycleState: "active" },
    version: 1,
    preference: { userEvaluation: null, provenance: null, updatedAt: "2026-08-13T10:00:00.000Z" },
    counts: { logicalPageCount, browserPageCount: logicalPageCount, physicalOpenCopyCount: 0 },
    allTimeActivity: { window: "all", onScreenMs: 0, activeUseMs: 0, coverageStart: null },
    topicPaths: [],
  };
}

describe("Resource priority bulk", () => {
  it("updates only visible checked active Resources with stable singular idempotency keys", async () => {
    const visible = [resource(2, 3), resource(4, 5)];
    const update = vi.fn(async () => ({}));
    const result = await applyResourceEvaluationBulk({
      visibleResources: visible,
      checkedResourceIds: new Set([2, 4, 99]),
      evaluation: null,
      operationId: "bulk-clear-1",
      update,
    });

    expect(result).toMatchObject({ requested: 2, succeeded: 2, failed: 0,
      outcomeUnknown: 0, logicalPageCount: 8 });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map(([id]) => id)).toEqual([2, 4]);
    expect(update.mock.calls[0]?.[2]).toBe(await Promise.resolve(update.mock.calls[0]?.[2]));
    const retry = vi.fn(async () => ({}));
    await applyResourceEvaluationBulk({ visibleResources: visible,
      checkedResourceIds: new Set([2, 4]), evaluation: null,
      operationId: "bulk-clear-1", update: retry });
    expect(retry.mock.calls.map((call) => call[2]))
      .toEqual(update.mock.calls.map((call) => call[2]));
  });

  it("reports mixed success and unknown outcomes without pretending atomicity", async () => {
    const update = vi.fn(async (id: number) => {
      if (id === 4) throw new TypeError("network disconnected");
      return {};
    });
    await expect(applyResourceEvaluationBulk({
      visibleResources: [resource(2, 3), resource(4, 5)],
      checkedResourceIds: new Set([2, 4]), evaluation: 3,
      operationId: "bulk-3", update,
    })).resolves.toMatchObject({ requested: 2, succeeded: 1, failed: 0,
      outcomeUnknown: 1, logicalPageCount: 8 });
  });

  it("rejects an empty or over-100 visible selection before writing", async () => {
    const update = vi.fn();
    await expect(applyResourceEvaluationBulk({ visibleResources: [], checkedResourceIds: new Set(),
      evaluation: 1, operationId: "empty", update })).rejects.toThrow(/1..100/);
    const tooMany = Array.from({ length: 101 }, (_, index) => resource(index + 1, 1));
    await expect(applyResourceEvaluationBulk({ visibleResources: tooMany,
      checkedResourceIds: new Set(tooMany.map(({ resource }) => resource.id)),
      evaluation: 1, operationId: "too-many", update })).rejects.toThrow(/1..100/);
    expect(update).not.toHaveBeenCalled();
  });
});
