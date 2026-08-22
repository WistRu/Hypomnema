import {
  personalPriorityRequestFingerprint,
  type FeatureFlagsResponse,
  type PriorityMode,
} from "@tabhub/shared";

export type PriorityReviewFilter =
  | "all"
  | "needs_review"
  | "does_not_need_review";

export interface PriorityListSelection {
  readonly mode: "default" | PriorityMode;
  readonly review: PriorityReviewFilter;
}

export interface PriorityCapabilities {
  readonly personalization: boolean;
  readonly writer: boolean;
  readonly priorityReadEnabled: boolean;
  readonly canPreviewAndSave: boolean;
  readonly canMutateAndRecompute: boolean;
}

export function derivePriorityCapabilities(
  flags: FeatureFlagsResponse | undefined,
): PriorityCapabilities {
  const personalization = flags?.priorityPersonalization === true;
  const writer = flags?.priorityAssessmentWriter === true;
  return {
    personalization,
    writer,
    priorityReadEnabled: flags?.priorityReaders === true &&
      (flags.priorityShadow === true || personalization),
    canPreviewAndSave: personalization,
    canMutateAndRecompute: personalization && writer,
  };
}

export function applyPrioritySelection(
  selection: PriorityListSelection,
  capabilities: PriorityCapabilities,
): { readonly priorityMode?: PriorityMode; readonly needsReview?: boolean } {
  if (!capabilities.personalization) return {};
  return {
    ...(selection.mode === "default" ? {} : { priorityMode: selection.mode }),
    ...(selection.review === "all" ? {} : {
      needsReview: selection.review === "needs_review",
    }),
  };
}

export async function resourceEvaluationIdempotencyKey(
  bulkOperationId: string,
  resourceId: number,
  evaluation: 1 | 2 | 3 | null,
): Promise<string> {
  const fingerprint = await personalPriorityRequestFingerprint({
    bulkOperationId,
    evaluation,
    resourceId,
  });
  return `resource-evaluation:${fingerprint}`;
}
