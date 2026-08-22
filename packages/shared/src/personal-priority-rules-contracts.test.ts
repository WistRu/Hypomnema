import { describe, expect, it } from "vitest";

import {
  personalPriorityDraftSchema,
  personalPriorityLifecycleRequestSchema,
  personalPriorityPreviewResponseSchema,
  personalPriorityRuleSchema,
} from "./index.js";

const rule = {
  ruleKey: "personal.current-project",
  priority: 500,
  label: "Current project pages",
  appliesTo: "page",
  when: {
    all: [
      {
        signal: "has_current_project_membership",
        operator: "eq",
        value: true,
      },
    ],
  },
  effect: { scoreDelta: 20 },
} as const;

describe("personal priority rules contracts", () => {
  it("accepts only closed personal rules and structured or EN/RU drafts", () => {
    expect(personalPriorityRuleSchema.parse(rule)).toEqual(rule);
    expect(personalPriorityDraftSchema.parse({
      kind: "structured",
      additions: [rule],
    })).toEqual({ kind: "structured", additions: [rule] });
    expect(personalPriorityDraftSchema.parse({
      kind: "natural_language",
      locale: "ru",
      source: "страницы когда есть следующий шаг тогда увеличить оценку на 20",
    })).toMatchObject({ kind: "natural_language", locale: "ru" });

    expect(personalPriorityRuleSchema.safeParse({
      ...rule,
      ruleKey: "baseline.override",
    }).success).toBe(false);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language",
      locale: "de",
      source: "unknown",
    }).success).toBe(false);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language",
      locale: "ru",
      source: "界".repeat(3_000),
    }).success).toBe(false);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language",
      locale: "ru",
      source: "я".repeat(4_000),
    }).success).toBe(true);
    const fourThousandCodePoints = `${"\u{1f642}".repeat(1_365)}${"a".repeat(2_635)}`;
    expect([...fourThousandCodePoints]).toHaveLength(4_000);
    expect(new TextEncoder().encode(fourThousandCodePoints).byteLength).toBeLessThan(8_192);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language",
      locale: "en",
      source: fourThousandCodePoints,
    }).success).toBe(true);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "structured",
      additions: Array.from({ length: 93 }, (_, index) => ({
        ...rule,
        ruleKey: `personal.rule-${index}`,
      })),
    }).success).toBe(false);
  });

  it("requires exact CAS inputs and models bounded deterministic preview output", () => {
    const ref = { rulesetId: 2, version: 3 };
    expect(personalPriorityLifecycleRequestSchema.parse({
      kind: "activate",
      target: ref,
      expectedActiveRef: { rulesetId: 1, version: 1 },
      requestFingerprint: "a".repeat(64),
    })).toMatchObject({ kind: "activate", target: ref });

    const preview = personalPriorityPreviewResponseSchema.parse({
      compiler: {
        kind: "structured",
        compilerVersion: null,
        sourceSpans: [],
        readableRules: [{
          ruleKey: "personal.current-project",
          en: "For pages, when current project membership equals true, add 20 to score.",
          ru: "Для страниц: если участие в текущем проекте равно да, увеличить оценку на 20.",
        }],
      },
      candidate: {
        additions: [rule],
        astHash: "b".repeat(64),
        naturalLanguageSource: null,
        totalRuleCount: 9,
      },
      diff: {
        added: ["personal.current-project"],
        changed: [],
        removed: [],
      },
      examples: [],
      eligibleCount: 0,
      scannedCount: 0,
      comparedActiveRef: { rulesetId: 1, version: 1 },
      comparedActiveAstHash: "d".repeat(64),
      requestFingerprint: "c".repeat(64),
    });
    expect(preview.examples).toHaveLength(0);
    expect(preview.candidate.totalRuleCount).toBe(9);
  });
});
