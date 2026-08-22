import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PersonalPriorityRulesError,
  personalPriorityRequestFingerprint,
  preparePersonalPriorityDraft,
} from "../src/personal-priority-rules.js";
import {
  baselinePriorityRuleAst,
  baselinePriorityRuleAstHash,
  canonicalPriorityRuleAstJson,
} from "../src/priority-engine.js";

const structuredRule = {
  ruleKey: "personal.acceptance.current-project",
  priority: 500,
  label: "Acceptance current project",
  appliesTo: "page",
  when: {
    all: [{
      signal: "has_current_project_membership",
      operator: "eq",
      value: true,
    }],
  },
  effect: { scoreDelta: 20 },
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("C60b materialization independent acceptance", () => {
  it("materializes the immutable accepted baseline plus canonical personal additions", () => {
    const baselineBefore = canonicalPriorityRuleAstJson(baselinePriorityRuleAst);
    const prepared = preparePersonalPriorityDraft({
      kind: "structured",
      additions: [structuredRule],
    });

    expect(prepared.ast.rules).toHaveLength(9);
    expect(prepared.additions).toEqual([structuredRule]);
    expect(prepared.ast.rules.filter((rule) => rule.ruleKey.startsWith("baseline.")))
      .toEqual(baselinePriorityRuleAst.rules);
    expect(prepared.astHash).toBe(sha256(prepared.astJson));
    expect(canonicalPriorityRuleAstJson(baselinePriorityRuleAst)).toBe(baselineBefore);
    expect(sha256(baselineBefore)).toBe(baselinePriorityRuleAstHash);
    expect(prepared.naturalLanguageSource).toBeNull();
    expect(prepared.compiler).toMatchObject({
      kind: "structured",
      compilerVersion: null,
      sourceSpans: [],
      readableRules: [{ ruleKey: structuredRule.ruleKey }],
    });
  });

  it("routes equivalent natural-language and structured drafts through one AST validator", () => {
    const source = "pages when is in current project equals true then score add 20";
    const natural = preparePersonalPriorityDraft({
      kind: "natural_language",
      locale: "en",
      source,
    });
    const structured = preparePersonalPriorityDraft({
      kind: "structured",
      additions: natural.additions,
    });

    expect(structured.astJson).toBe(natural.astJson);
    expect(structured.astHash).toBe(natural.astHash);
    expect(structured.additions).toEqual(natural.additions);
    expect(natural.naturalLanguageSource).toBe(source);
    expect(structured.naturalLanguageSource).toBeNull();
  });

  it("rejects baseline replacement, duplicate keys, and more than 92 additions", () => {
    const cases = [
      [{ ...structuredRule, ruleKey: "baseline.pinned" }],
      [structuredRule, structuredRule],
      Array.from({ length: 93 }, (_, index) => ({
        ...structuredRule,
        ruleKey: `personal.acceptance.rule-${index}`,
      })),
    ];
    for (const additions of cases) {
      expect(() => preparePersonalPriorityDraft({ kind: "structured", additions }))
        .toThrow();
    }
  });

  it("computes the lifecycle fingerprint from the exact canonical request payload", () => {
    const request = {
      kind: "save" as const,
      draft: { kind: "structured" as const, additions: [structuredRule] },
      expectedLatestVersion: null,
    };
    const independentlyCanonical = independentCanonicalJson({
      draft: {
        additions: [structuredRule],
        kind: "structured",
      },
      expectedLatestVersion: null,
      kind: "save",
    });
    expect(personalPriorityRequestFingerprint(request))
      .toBe(sha256(independentlyCanonical));

    const changed = {
      ...request,
      expectedLatestVersion: 1,
    };
    expect(personalPriorityRequestFingerprint(changed))
      .not.toBe(personalPriorityRequestFingerprint(request));
  });

  it("maps unsupported natural-language AST output to the closed typed error", () => {
    try {
      preparePersonalPriorityDraft({
        kind: "natural_language",
        locale: "en",
        source: "pages when is open equals true then score add 101",
      });
      throw new Error("expected unsupported language");
    } catch (error) {
      expect(error).toBeInstanceOf(PersonalPriorityRulesError);
      expect((error as PersonalPriorityRulesError).code)
        .toBe("PRIORITY_RULE_LANGUAGE_UNSUPPORTED");
      expect((error as PersonalPriorityRulesError).span).toEqual({
        start: 0,
        end: "pages when is open equals true then score add 101".length,
      });
    }
  });
});
