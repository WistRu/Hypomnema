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

export interface AiOrderingNotice {
  /** Why no AI judgement is present — the two cases a user can act on differ. */
  readonly reason: "writer_off" | "not_assessed_yet";
  /** What the list is really ordered by while the AI contributes nothing. */
  readonly shownInstead: "default" | "my";
}

/**
 * The AI and Recommended orderings degrade silently when nothing has been
 * assessed: their primary sort key is absent for every row, so AI falls through
 * to the default tiebreakers and Recommended is left with user importance
 * alone. The list still looks deliberate, which invites the reader to treat it
 * as the AI's judgement when the AI made none (issue #35).
 *
 * Returns null when there is nothing to warn about, including when no reads
 * have arrived — an empty batch means "not loaded" or "nothing visible", and
 * claiming degeneracy from it would flash a false notice on every load.
 */
export function aiOrderingNotice(
  mode: PriorityListSelection["mode"],
  reads: Iterable<{ readonly outcome: unknown }>,
  writerEnabled: boolean,
): AiOrderingNotice | null {
  if (mode !== "ai" && mode !== "recommended") return null;
  let seen = false;
  for (const read of reads) {
    seen = true;
    if (read.outcome !== null && read.outcome !== undefined) return null;
  }
  if (!seen) return null;
  return {
    reason: writerEnabled ? "not_assessed_yet" : "writer_off",
    shownInstead: mode === "ai" ? "default" : "my",
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
