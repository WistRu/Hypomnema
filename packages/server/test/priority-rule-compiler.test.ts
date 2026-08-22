import { describe, expect, it } from "vitest";

import {
  compilePriorityRuleNaturalLanguageV1,
  PriorityRuleLanguageError,
} from "../src/priority-rule-compiler.js";

describe("PriorityRuleNaturalLanguageCompilerV1", () => {
  it("compiles equivalent closed EN/RU phrases to one canonical AST with spans", () => {
    const en = compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "pages when has next action equals true and topic path in \"Current projects\" then score add 20 and review true",
    });
    const ru = compilePriorityRuleNaturalLanguageV1({
      locale: "ru",
      source: "страницы когда есть следующий шаг равно да и тема входит \"Current projects\" тогда оценка плюс 20 и проверка да",
    });
    expect(en.additions).toEqual(ru.additions);
    const reordered = compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "pages when topic path in \"Current projects\" and has next action equals true then review true and score add 20",
    });
    expect(reordered.additions).toEqual(en.additions);
    expect(en.additions[0]).toMatchObject({
      ruleKey: expect.stringMatching(/^personal\.nl\.[0-9a-f]{16}\.1$/),
      appliesTo: "page",
      when: { all: [
        { signal: "has_shareable_next_action", operator: "eq", value: true },
        { signal: "topic_paths", operator: "in", value: ["Current projects"] },
      ] },
      effect: { scoreDelta: 20, needsReview: true },
    });
    expect(en.sourceSpans[0]?.conditions).toHaveLength(2);
    expect(en.sourceSpans[0]?.effects).toHaveLength(2);
    expect(en.readableRules[0]).toMatchObject({
      ruleKey: en.additions[0]?.ruleKey,
      en: expect.stringContaining("For pages"),
      ru: expect.stringContaining("Для страниц"),
    });
  });

  it("converts bounded numeric units and rejects every unsupported phrase atomically", () => {
    const compiled = compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "both when active use 30d at least 15 min then confidence add 0.1",
    });
    expect(compiled.additions[0]?.when.all[0]).toEqual({
      signal: "active_use_30d_ms",
      operator: "gte",
      value: 900_000,
    });
    expect(() => compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "pages when AI decides this is useful then score add 20",
    })).toThrow(PriorityRuleLanguageError);
    for (const source of [
      "pages when is open equals true then score add 101",
      "pages when is open equals true then confidence add 2",
      "pages when resource page count at least 1 then score add 1",
      "pages when has captured content equals false then score add 1",
      "pages when is open equals true then score floor 80 and score cap 20",
    ]) {
      try {
        compilePriorityRuleNaturalLanguageV1({ locale: "en", source });
        throw new Error("expected bounds failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PriorityRuleLanguageError);
        expect((error as PriorityRuleLanguageError).code)
          .toBe("PRIORITY_RULE_LANGUAGE_UNSUPPORTED");
        expect((error as PriorityRuleLanguageError).span).toEqual({
          start: 0,
          end: source.length,
        });
      }
    }
    try {
      compilePriorityRuleNaturalLanguageV1({
        locale: "en",
        source: "pages when is open equals true then score add 20; surprise",
      });
      throw new Error("expected closed-language failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PriorityRuleLanguageError);
      expect((error as PriorityRuleLanguageError).code)
        .toBe("PRIORITY_RULE_LANGUAGE_UNSUPPORTED");
      expect((error as PriorityRuleLanguageError).span.start).toBeGreaterThan(0);
    }
  });
});
