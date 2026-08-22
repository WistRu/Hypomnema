import type { ResourceSummary } from "@tabhub/shared";

import { ApiRequestError } from "./api";
import { resourceEvaluationIdempotencyKey } from "./priority-personalization-model";

export interface ResourceEvaluationBulkReceipt {
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly outcomeUnknown: number;
  readonly logicalPageCount: number;
  readonly items: readonly {
    readonly resourceId: number;
    readonly outcome: "succeeded" | "failed" | "unknown";
    readonly message?: string;
  }[];
}

export async function applyResourceEvaluationBulk(input: {
  readonly visibleResources: readonly ResourceSummary[];
  readonly checkedResourceIds: ReadonlySet<number>;
  readonly evaluation: 1 | 2 | 3 | null;
  readonly operationId: string;
  readonly update: (
    resourceId: number,
    evaluation: 1 | 2 | 3 | null,
    idempotencyKey: string,
  ) => Promise<unknown>;
}): Promise<ResourceEvaluationBulkReceipt> {
  const selected = input.visibleResources.filter(({ resource }) =>
    resource.lifecycleState === "active" && input.checkedResourceIds.has(resource.id));
  if (selected.length < 1 || selected.length > 100) {
    throw new Error("Resource bulk selection must contain 1..100 visible active Resources");
  }
  const items = [] as Array<ResourceEvaluationBulkReceipt["items"][number]>;
  for (const item of selected) {
    const resourceId = item.resource.id;
    const key = await resourceEvaluationIdempotencyKey(
      input.operationId,
      resourceId,
      input.evaluation,
    );
    try {
      await input.update(resourceId, input.evaluation, key);
      items.push({ resourceId, outcome: "succeeded" });
    } catch (error) {
      items.push({
        resourceId,
        outcome: error instanceof ApiRequestError ? "failed" : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    requested: selected.length,
    succeeded: items.filter(({ outcome }) => outcome === "succeeded").length,
    failed: items.filter(({ outcome }) => outcome === "failed").length,
    outcomeUnknown: items.filter(({ outcome }) => outcome === "unknown").length,
    logicalPageCount: selected.reduce((total, item) =>
      total + item.counts.logicalPageCount, 0),
    items,
  };
}
