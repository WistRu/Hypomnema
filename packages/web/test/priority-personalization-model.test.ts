import type { FeatureFlagsResponse } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  applyPrioritySelection,
  derivePriorityCapabilities,
  resourceEvaluationIdempotencyKey,
  aiOrderingNotice,
} from "../src/priority-personalization-model";

describe("priority personalization model", () => {
  it("keeps Default exact and suppresses opt-in parameters until capability is accepted", () => {
    const selection = { mode: "recommended" as const, review: "needs_review" as const };
    const unavailable = derivePriorityCapabilities(undefined);
    const featureOff = derivePriorityCapabilities({
      context: true,
      logicalImportance: true,
      priorityAssessmentWriter: true,
      priorityPersonalization: false,
      priorityReaders: true,
      priorityShadow: true,
    });

    expect(applyPrioritySelection(selection, unavailable)).toEqual({});
    expect(applyPrioritySelection(selection, featureOff)).toEqual({});
    expect(applyPrioritySelection(
      { mode: "default", review: "all" },
      derivePriorityCapabilities({
        context: true,
        logicalImportance: true,
        priorityPersonalization: true,
        priorityReaders: true,
      }),
    )).toEqual({});
  });

  it("separates read, draft, and writer capabilities exactly", () => {
    const flags = (value: Partial<FeatureFlagsResponse>) => derivePriorityCapabilities({
      context: true,
      logicalImportance: true,
      ...value,
    });

    expect(flags({ priorityReaders: true, priorityShadow: true })).toMatchObject({
      personalization: false,
      priorityReadEnabled: true,
      canPreviewAndSave: false,
      canMutateAndRecompute: false,
    });
    const writerOff = flags({ priorityReaders: true, priorityPersonalization: true });
    expect(writerOff).toMatchObject({
      personalization: true,
      priorityReadEnabled: true,
      canPreviewAndSave: true,
      canMutateAndRecompute: false,
    });
    expect(applyPrioritySelection(
      { mode: "ai", review: "does_not_need_review" }, writerOff,
    )).toEqual({ priorityMode: "ai", needsReview: false });
    expect(flags({
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: false,
    })).toMatchObject({
      priorityReadEnabled: false,
      canPreviewAndSave: true,
      canMutateAndRecompute: true,
    });
  });

  it("derives a stable per-Resource idempotency key without mixing the evaluation", async () => {
    await expect(resourceEvaluationIdempotencyKey("bulk-17", 22, null))
      .resolves.toBe(await resourceEvaluationIdempotencyKey("bulk-17", 22, null));
    await expect(resourceEvaluationIdempotencyKey("bulk-17", 22, 3))
      .resolves.not.toBe(await resourceEvaluationIdempotencyKey("bulk-17", 23, 3));
  });
});

describe("aiOrderingNotice", () => {
  const page = (logicalPageId: number, outcome: unknown) => ({
    subject: { type: "page" as const, logicalPageId },
    outcome,
    isCurrent: true,
    dirty: false,
    needsReview: false,
  }) as never;
  const anOutcome = { band: "high", score: 70 };

  it("says nothing for orderings that do not depend on the AI", () => {
    expect(aiOrderingNotice("default", [page(1, null)], false)).toBeNull();
    expect(aiOrderingNotice("my", [page(1, null)], false)).toBeNull();
  });

  it("says nothing while there is no read to judge by", () => {
    // An empty batch means "not loaded" or "nothing visible", not "no AI data".
    // Claiming degeneracy here would flash a false notice on every load.
    expect(aiOrderingNotice("ai", [], false)).toBeNull();
  });

  it("says nothing when at least one subject carries an AI outcome", () => {
    expect(aiOrderingNotice("ai", [page(1, null), page(2, anOutcome)], false)).toBeNull();
    expect(aiOrderingNotice("recommended", [page(1, anOutcome)], false)).toBeNull();
  });

  it("names the writer being off, and what the list is actually ordered by", () => {
    expect(aiOrderingNotice("ai", [page(1, null), page(2, null)], false)).toEqual({
      reason: "writer_off",
      shownInstead: "default",
    });
    expect(aiOrderingNotice("recommended", [page(1, null)], false)).toEqual({
      reason: "writer_off",
      shownInstead: "my",
    });
  });

  it("distinguishes a writer that is on but has not assessed anything yet", () => {
    expect(aiOrderingNotice("ai", [page(1, null)], true)).toEqual({
      reason: "not_assessed_yet",
      shownInstead: "default",
    });
  });
});
