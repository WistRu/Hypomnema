import { describe, expect, it } from "vitest";
import { personalPriorityDraftSchema } from "@tabhub/shared";

import {
  compilePriorityRuleNaturalLanguageV1,
  PriorityRuleLanguageError,
  renderPriorityRulesReadable,
} from "../src/priority-rule-compiler.js";

function expectLanguageFailure(source: string): PriorityRuleLanguageError {
  try {
    compilePriorityRuleNaturalLanguageV1({ locale: "en", source });
  } catch (error) {
    expect(error).toBeInstanceOf(PriorityRuleLanguageError);
    expect((error as PriorityRuleLanguageError).code)
      .toBe("PRIORITY_RULE_LANGUAGE_UNSUPPORTED");
    return error as PriorityRuleLanguageError;
  }
  throw new Error(`Expected the complete source to be rejected: ${source}`);
}

describe("C60b compiler independent acceptance", () => {
  it("canonicalizes equivalent EN/RU conjunctions while retaining exact source spans", () => {
    const enSource = [
      "pages when topic path in \"Current projects\"",
      "and has next action equals true",
      "then review true and score add 20",
    ].join(" ");
    const ruSource = [
      "страницы когда есть следующий шаг равно да",
      "и тема входит \"Current projects\"",
      "тогда оценка плюс 20 и проверка да",
    ].join(" ");
    const en = compilePriorityRuleNaturalLanguageV1({ locale: "en", source: enSource });
    const ru = compilePriorityRuleNaturalLanguageV1({ locale: "ru", source: ruSource });

    expect(en.additions).toEqual(ru.additions);
    expect(en.additions).toHaveLength(1);
    expect(en.sourceSpans).toHaveLength(1);
    const span = en.sourceSpans[0]!;
    expect(enSource.slice(span.rule.start, span.rule.end)).toBe(enSource);
    expect(span.conditions.map((item) => enSource.slice(item.start, item.end)))
      .toEqual([
        "has next action equals true",
        "topic path in \"Current projects\"",
      ]);
    expect(span.effects.map((item) => enSource.slice(item.start, item.end)))
      .toEqual(["review true", "score add 20"]);
    expect(span.ruleKey).toBe(en.additions[0]!.ruleKey);

    expect(renderPriorityRulesReadable(en.additions)).toEqual(en.readableRules);
    expect(en.readableRules[0]!.en).toContain("For pages");
    expect(en.readableRules[0]!.ru).toContain("Для страниц");
  });

  it("covers the closed condition/operator/unit vocabulary through the public compiler", () => {
    const cases = [
      ["pages when has next action equals false then review true", "has_shareable_next_action", "eq", false],
      ["pages when has project context equals true then score add 1", "has_shareable_project_context", "eq", true],
      ["both when is in current project equals true then score add 1", "has_current_project_membership", "eq", true],
      ["pages when is pinned equals true then score add 1", "is_pinned", "eq", true],
      ["pages when is open equals true then score add 1", "is_open", "eq", true],
      ["both when has captured content equals true then score add 1", "has_captured_content", "eq", true],
      ["both when has current summary equals true then score add 1", "has_current_summary", "eq", true],
      ["both when has current research report equals true then score add 1", "has_current_research_report", "eq", true],
      ["both when relation count equals 3 then score add 1", "relation_count", "eq", 3],
      ["both when active use 30d equals 2 ms then score add 1", "active_use_30d_ms", "eq", 2],
      ["both when active use 30d at least 3 s then score add 1", "active_use_30d_ms", "gte", 3_000],
      ["both when active use 30d at most 4 min then score add 1", "active_use_30d_ms", "lte", 240_000],
      ["both when active use 30d at least 2 h then score add 1", "active_use_30d_ms", "gte", 7_200_000],
      ["both when active use 30d at least 2 d then score add 1", "active_use_30d_ms", "gte", 172_800_000],
      ["both when on screen 30d at most 90 s then score add 1", "on_screen_30d_ms", "lte", 90_000],
      ["both when age days at least 7 then score add 1", "age_days", "gte", 7],
      ["both when last seen days at most 30 then score add 1", "last_seen_days", "lte", 30],
      ["pages when open copy count equals 2 then score add 1", "duplicate_physical_count", "eq", 2],
      ["resources when resource page count at least 10 then score add 1", "resource_page_count", "gte", 10],
      ["resources when resource captured page count at least 2 then score add 1", "resource_captured_page_count", "gte", 2],
      ["both when topic path in \"Zeta\", \"Alpha\" then score add 1", "topic_paths", "in", ["Alpha", "Zeta"]],
      ["both when workspace name in \"Main\" then score add 1", "workspace_names", "in", ["Main"]],
      ["both when status in \"open\" then score add 1", "status", "in", ["open"]],
    ] as const;

    for (const [source, signal, operator, value] of cases) {
      const condition = compilePriorityRuleNaturalLanguageV1({ locale: "en", source })
        .additions[0]!.when.all[0]!;
      expect(condition).toEqual({ signal, operator, value });
    }

    expect(compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: [
        "both when is open equals true then score add -100",
        "and confidence add -1 and score floor 0 and score cap 100 and review false",
      ].join(" "),
    }).additions[0]!.effect).toEqual({
      scoreDelta: -100,
      confidenceDelta: -1,
      scoreFloor: 0,
      scoreCap: 100,
      needsReview: false,
    });
    expect(compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "pages when is open equals true then exclude user",
    }).additions[0]!.effect).toEqual({ exclusionReason: "user_excluded" });
    expect(compilePriorityRuleNaturalLanguageV1({
      locale: "en",
      source: "resources when is open equals true then exclude policy",
    }).additions[0]!.effect).toEqual({ exclusionReason: "policy_excluded" });
  });

  it("rejects a mixed or bounded-invalid source atomically with a precise typed span", () => {
    const invalidSources = [
      "pages when is open equals true then score add 10; surprise",
      "pages when is open equals true then score add 10 and",
      "pages when is open equals true then score add 101",
      "pages when is open equals true then confidence add 1.1",
      "pages when resource page count at least 1 then score add 1",
      "pages when has captured content equals false then score add -1",
      "pages when is open equals true then score floor 80 and score cap 20",
      "pages when unknown signal equals true then score add 1",
    ];
    for (const source of invalidSources) {
      const error = expectLanguageFailure(source);
      expect(error.span.start).toBeGreaterThanOrEqual(0);
      expect(error.span.end).toBeLessThanOrEqual(source.length);
      expect(error.span.end).toBeGreaterThan(error.span.start);
      expect(source.slice(error.span.start, error.span.end).length).toBeGreaterThan(0);
    }
  });

  it("accepts exactly 4,000 source characters and rejects 4,001", () => {
    const phrase = "pages when is open equals true then score add 1";
    const atLimit = phrase + " ".repeat(4_000 - phrase.length);
    expect([...atLimit]).toHaveLength(4_000);
    expect(compilePriorityRuleNaturalLanguageV1({ locale: "en", source: atLimit })
      .additions).toHaveLength(1);

    const aboveLimit = `${atLimit} `;
    const error = expectLanguageFailure(aboveLimit);
    expect([...aboveLimit]).toHaveLength(4_001);
    expect(error.span.start).toBe(0);
  });

  it("accepts exactly 8,192 UTF-8 bytes and rejects 8,193 before SQLite", () => {
    const phrase = "pages when is open equals true then score add 1";
    const remainingBytes = 8_192 - Buffer.byteLength(phrase, "utf8");
    const atLimit = phrase + "\u2003".repeat(Math.floor(remainingBytes / 3)) +
      " ".repeat(remainingBytes % 3);
    const aboveLimit = `${atLimit} `;

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(8_192);
    expect([...atLimit].length).toBeLessThanOrEqual(4_000);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language", locale: "en", source: atLimit,
    }).success).toBe(true);
    expect(compilePriorityRuleNaturalLanguageV1({ locale: "en", source: atLimit })
      .additions).toHaveLength(1);

    expect(Buffer.byteLength(aboveLimit, "utf8")).toBe(8_193);
    expect(personalPriorityDraftSchema.safeParse({
      kind: "natural_language", locale: "en", source: aboveLimit,
    }).success).toBe(false);
    const error = expectLanguageFailure(aboveLimit);
    expect(error.span.start).toBe(0);
  });

  it("reports invalid astral input with Unicode code-point source offsets", () => {
    const source = "pages when is open equals true then score add 1; 😀 surprise";
    const codePoints = [...source];
    const astralIndex = codePoints.indexOf("😀");
    const error = expectLanguageFailure(source);

    expect(error.span).toEqual({ start: astralIndex, end: astralIndex + 1 });
    expect(codePoints.slice(error.span.start, error.span.end).join(""))
      .toBe("😀");
  });
});
