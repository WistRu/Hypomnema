// @vitest-environment jsdom

import type { FeatureFlagsResponse, ResourceSummary } from "@tabhub/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api";
import { ManualPriorityRating } from "../src/ManualPriorityRating";
import {
  applyPrioritySelection,
  derivePriorityCapabilities,
  resourceEvaluationIdempotencyKey,
  type PriorityListSelection,
} from "../src/priority-personalization-model";
import { applyResourceEvaluationBulk } from "../src/resource-priority-bulk";

afterEach(cleanup);

function flags(overrides: Partial<FeatureFlagsResponse> = {}): FeatureFlagsResponse {
  return {
    context: true,
    logicalImportance: true,
    priorityAssessmentWriter: true,
    priorityPersonalization: true,
    priorityReaders: true,
    priorityShadow: true,
    ...overrides,
  };
}

function resource(
  id: number,
  logicalPageCount: number,
  lifecycleState: "active" | "archived" = "active",
): ResourceSummary {
  return {
    resource: {
      id,
      resourceKey: `resource-${id}`,
      name: `Resource ${id}`,
      kind: "website",
      accessClass: "public",
      lifecycleState,
    },
    version: 1,
    preference: {
      userEvaluation: null,
      provenance: null,
      updatedAt: "2026-08-13T10:00:00.000Z",
    },
    counts: {
      logicalPageCount,
      browserPageCount: logicalPageCount,
      physicalOpenCopyCount: 0,
    },
    allTimeActivity: {
      window: "all",
      onScreenMs: 0,
      activeUseMs: 0,
      coverageStart: null,
    },
    topicPaths: [],
  };
}

describe("W60 stable-seam acceptance", () => {
  it("maps every opt-in priority mode and review filter while preserving exact Default/all", () => {
    const capabilities = derivePriorityCapabilities(flags());
    const cases: readonly [PriorityListSelection, object][] = [
      [{ mode: "default", review: "all" }, {}],
      [{ mode: "my", review: "all" }, { priorityMode: "my" }],
      [{ mode: "ai", review: "all" }, { priorityMode: "ai" }],
      [{ mode: "recommended", review: "all" }, { priorityMode: "recommended" }],
      [{ mode: "default", review: "needs_review" }, { needsReview: true }],
      [{ mode: "default", review: "does_not_need_review" }, { needsReview: false }],
      [{ mode: "recommended", review: "needs_review" }, {
        priorityMode: "recommended",
        needsReview: true,
      }],
    ];

    for (const [selection, expected] of cases) {
      expect(applyPrioritySelection(selection, capabilities)).toEqual(expected);
    }
  });

  it("emits no priority parameters while feature flags are pending or personalization is off", () => {
    const selection = { mode: "recommended", review: "needs_review" } as const;
    expect(applyPrioritySelection(selection, derivePriorityCapabilities(undefined))).toEqual({});
    expect(applyPrioritySelection(selection, derivePriorityCapabilities(flags({
      priorityPersonalization: false,
    })))).toEqual({});
  });

  it("exposes distinct Clear, 1, 2, and 3 manual actions", () => {
    const onChange = vi.fn();
    render(<ManualPriorityRating
      labels={{ group: "My importance", clear: "Clear", level: (value) => `Set ${value}` }}
      value={2}
      onChange={onChange}
    />);

    for (const name of ["Clear", "Set 1", "Set 2", "Set 3"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([null, 1, 2, 3]);
    expect(screen.getByRole("button", { name: "Set 2" }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("binds Resource idempotency to the requested evaluation as well as operation and Resource", async () => {
    const keys = await Promise.all([
      resourceEvaluationIdempotencyKey("bulk-17", 22, null),
      resourceEvaluationIdempotencyKey("bulk-17", 22, 1),
      resourceEvaluationIdempotencyKey("bulk-17", 22, 2),
      resourceEvaluationIdempotencyKey("bulk-17", 22, 3),
      resourceEvaluationIdempotencyKey("bulk-17", 23, 3),
    ]);
    expect(new Set(keys)).toHaveLength(keys.length);
  });

  it("counts only visible checked active Resources and classifies definitive API failures", async () => {
    const update = vi.fn(async (id: number) => {
      if (id === 2) throw new ApiRequestError("version conflict", "RESOURCE_VERSION_CONFLICT", 409);
      return {};
    });
    await expect(applyResourceEvaluationBulk({
      visibleResources: [resource(1, 4), resource(2, 7), resource(3, 99, "archived")],
      checkedResourceIds: new Set([1, 2, 3, 404]),
      evaluation: 2,
      operationId: "bulk-mixed",
      update,
    })).resolves.toMatchObject({
      requested: 2,
      succeeded: 1,
      failed: 1,
      outcomeUnknown: 0,
      logicalPageCount: 11,
    });
    expect(update.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("accepts exactly 100 visible active Resources and reports their exact logical-page total", async () => {
    const visibleResources = Array.from({ length: 100 }, (_, index) =>
      resource(index + 1, index + 1));
    const update = vi.fn(async () => ({}));
    const receipt = await applyResourceEvaluationBulk({
      visibleResources,
      checkedResourceIds: new Set(visibleResources.map(({ resource: item }) => item.id)),
      evaluation: 3,
      operationId: "bulk-100",
      update,
    });

    expect(receipt).toMatchObject({
      requested: 100,
      succeeded: 100,
      failed: 0,
      outcomeUnknown: 0,
      logicalPageCount: 5_050,
    });
    expect(update).toHaveBeenCalledTimes(100);
  });
});
