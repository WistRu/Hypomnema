import { describe, expect, it } from "vitest";

import * as shared from "./index.js";
import {
  personalPriorityCompilerVersion,
  personalPriorityLifecycleRequestSchema,
  personalPriorityPreviewResponseSchema,
  personalPriorityRulesStateResponseSchema,
  tabBulkIdsQuerySchema,
  tabBulkIdsResponseSchema,
  tabInstanceBulkResponseSchema,
} from "./index.js";

type Fingerprint = (payload: unknown) => string | Promise<string>;

function sharedFingerprint(): Fingerprint {
  const candidate = (shared as unknown as Record<string, unknown>)[
    "personalPriorityRequestFingerprint"
  ];
  expect(candidate, "shared must export the browser-safe lifecycle fingerprint helper")
    .toEqual(expect.any(Function));
  return candidate as Fingerprint;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("C60c shared personal-priority acceptance", () => {
  it("pins browser-safe lifecycle fingerprint vectors without Node globals", async () => {
    const vectors = [
      {
        payload: {
          kind: "save",
          draft: { kind: "structured", additions: [] },
          expectedActiveRef: { rulesetId: 1, version: 1 },
          expectedLatestVersion: null,
        },
        sha256: "6abb5e9bfb81b665a05080384974112d55251a2c4ef3c158275dd01e13ca2906",
      },
      {
        payload: {
          kind: "activate",
          target: { rulesetId: 2, version: 7 },
          expectedActiveRef: { rulesetId: 1, version: 1 },
        },
        sha256: "2afcb2acdda3b2e4c62fd37cdc3460164a9da01db2a1d111934b8786ba215b23",
      },
      {
        payload: {
          kind: "reset",
          expectedLatestVersion: 7,
          expectedActiveRef: { rulesetId: 2, version: 7 },
        },
        sha256: "c866007d34106bf8d12e6d1ce2cd57fc53a67a58d8accca9dec9e554119c55a4",
      },
    ] as const;
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    try {
      Object.defineProperty(globalThis, "Buffer", {
        configurable: true,
        value: undefined,
        writable: true,
      });
      const fingerprint = sharedFingerprint();
      for (const vector of vectors) {
        await expect(Promise.resolve(fingerprint(vector.payload))).resolves.toBe(vector.sha256);
      }
    } finally {
      if (bufferDescriptor === undefined) delete (globalThis as { Buffer?: unknown }).Buffer;
      else Object.defineProperty(globalThis, "Buffer", bufferDescriptor);
    }
  });

  it("binds preview confirmation and save CAS to the compared active ruleset", () => {
    const comparedActiveRef = { rulesetId: 1, version: 1 };
    const preview = personalPriorityPreviewResponseSchema.parse({
      compiler: {
        kind: "structured",
        compilerVersion: null,
        sourceSpans: [],
        readableRules: [],
      },
      candidate: {
        additions: [],
        astHash: "a".repeat(64),
        naturalLanguageSource: null,
        totalRuleCount: 8,
      },
      comparedActiveRef,
      comparedActiveAstHash: "e".repeat(64),
      diff: { added: [], changed: [], removed: [] },
      eligibleCount: 1,
      strataCounts: {
        exclusionChanged: 0,
        bandChanged: 1,
        assessmentChanged: 0,
        unchanged: 0,
      },
      examples: [{
        logicalPageId: 7,
        display: {
          title: "Readable preview page",
          representativeUrl: "https://preview.example/page",
        },
        stratum: "unchanged",
        before: {
          kind: "assessment",
          agentScore: 40,
          agentBand: "medium",
          confidence: 1,
          needsReview: false,
          reasons: [],
          missingSignals: [],
        },
        after: {
          kind: "assessment",
          agentScore: 40,
          agentBand: "medium",
          confidence: 1,
          needsReview: false,
          reasons: [],
          missingSignals: [],
        },
      }],
      requestFingerprint: "b".repeat(64),
      scannedCount: 1,
    });
    expect((preview as typeof preview & { comparedActiveRef: typeof comparedActiveRef })
      .comparedActiveRef).toEqual(comparedActiveRef);
    expect((preview as typeof preview & { comparedActiveAstHash: string })
      .comparedActiveAstHash).toBe("e".repeat(64));
    expect((preview.examples[0] as typeof preview.examples[number] & {
      display: { title: string | null; representativeUrl: string };
    }).display).toEqual({
      title: "Readable preview page",
      representativeUrl: "https://preview.example/page",
    });

    expect(personalPriorityLifecycleRequestSchema.safeParse({
      kind: "save",
      draft: { kind: "structured", additions: [] },
      expectedLatestVersion: null,
      expectedActiveRef: comparedActiveRef,
      requestFingerprint: "c".repeat(64),
    }).success).toBe(true);
    expect(personalPriorityLifecycleRequestSchema.safeParse({
      kind: "save",
      draft: { kind: "structured", additions: [] },
      expectedLatestVersion: null,
      requestFingerprint: "c".repeat(64),
    }).success).toBe(false);
  });

  it("models a bounded latest history page without losing the exact total", () => {
    const state = personalPriorityRulesStateResponseSchema.parse({
      name: "Personal priority rules",
      baselineRef: { rulesetId: 1, version: 1 },
      activeRef: { rulesetId: 1, version: 1 },
      latestVersion: null,
      versions: [],
      versionCount: 0,
      historyTruncated: false,
      recomputeRequired: false,
      staleOutcomeCount: 0,
    });
    expect((state as typeof state & { versionCount: number }).versionCount).toBe(0);
    expect((state as typeof state & { historyTruncated: boolean }).historyTruncated)
      .toBe(false);
  });

  it("exports a deeply frozen bilingual grammar catalog for the controlled compiler", () => {
    const grammar = (shared as unknown as Record<string, unknown>)[
      "personalPriorityNaturalLanguageGrammarV1"
    ] as {
      compilerVersion: string;
      effects: readonly { value: string; phrases: { en: string; ru: string } }[];
      limits: {
        maxPersonalRules: number;
        maxSourceCodePoints: number;
        maxSourceUtf8Bytes: number;
      };
      locales: Record<"en" | "ru", {
        conjunction: string;
        examples: readonly string[];
        ruleTemplate: string;
      }>;
      signals: readonly {
        value: string;
        kind: "boolean" | "numeric" | "string_set";
        phrases: { en: string; ru: string };
      }[];
      subjects: readonly { value: string; phrases: { en: string; ru: string } }[];
    };
    expect(grammar, "shared must export the versioned EN/RU grammar catalog").toBeDefined();
    expectDeepFrozen(grammar);
    expect(grammar.compilerVersion).toBe(personalPriorityCompilerVersion);
    expect(grammar.limits).toEqual({
      maxPersonalRules: 92,
      maxSourceCodePoints: 4_000,
      maxSourceUtf8Bytes: 8_192,
    });
    expect(Object.keys(grammar.locales).sort()).toEqual(["en", "ru"]);
    for (const locale of ["en", "ru"] as const) {
      expect(grammar.locales[locale].ruleTemplate.length).toBeGreaterThan(0);
      expect(grammar.locales[locale].conjunction.length).toBeGreaterThan(0);
      expect(grammar.locales[locale].examples.length).toBeGreaterThan(0);
    }
    expect(grammar.subjects.map(({ value }) => value).sort())
      .toEqual(["both", "page", "resource"]);
    expect(grammar.signals.map(({ value }) => value).sort()).toEqual([
      "active_use_30d_ms",
      "age_days",
      "duplicate_physical_count",
      "has_captured_content",
      "has_current_project_membership",
      "has_current_research_report",
      "has_current_summary",
      "has_shareable_next_action",
      "has_shareable_project_context",
      "is_open",
      "is_pinned",
      "last_seen_days",
      "on_screen_30d_ms",
      "relation_count",
      "resource_captured_page_count",
      "resource_page_count",
      "status",
      "topic_paths",
      "workspace_names",
    ]);
    expect(grammar.effects.map(({ value }) => value).sort()).toEqual([
      "confidenceDelta",
      "exclusionReason",
      "needsReview",
      "scoreCap",
      "scoreDelta",
      "scoreFloor",
    ]);
    for (const entry of [...grammar.subjects, ...grammar.signals, ...grammar.effects]) {
      expect(entry.phrases.en.length).toBeGreaterThan(0);
      expect(entry.phrases.ru.length).toBeGreaterThan(0);
    }
  });

  it("keeps needs-review canonical and physical bulk responses logically bounded", () => {
    expect(tabBulkIdsQuerySchema.parse({ needs_review: "true" }))
      .toMatchObject({ needs_review: true });
    const canonical = tabBulkIdsResponseSchema.parse({
      ids: [11, 12],
      logicalPageCount: 1,
    });
    expect((canonical as typeof canonical & { logicalPageCount: number }).logicalPageCount)
      .toBe(1);
    const physical = tabInstanceBulkResponseSchema.parse({
      items: [],
      total: 0,
      logicalPageCount: 0,
    });
    expect((physical as typeof physical & { logicalPageCount: number }).logicalPageCount)
      .toBe(0);
  });
});
