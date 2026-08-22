import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { createContextLedger } from "../src/context-ledger.js";
import {
  baselinePriorityRuleAst,
  canonicalPriorityRuleAstJson,
  createPriorityEngine,
  parsePriorityRuleAst,
  PriorityEngineError,
  type PriorityAssessmentInput,
  type PriorityRule,
  type PriorityRuleAstV1,
} from "../src/priority-engine.js";

const now = "2026-08-13T01:00:00.000Z";

function fixture() {
  const database = openDatabase(":memory:", {
    migrationClock: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  database.connection.exec(`
    INSERT INTO logical_pages (
      id, identity_key, url_normalized, representative_url, created_at, updated_at
    ) VALUES
      (501, 'https://example.com/page-1', 'https://example.com/page-1',
       'https://example.com/page-1', '${now}', '${now}'),
      (502, 'https://example.com/page-2', 'https://example.com/page-2',
       'https://example.com/page-2', '${now}', '${now}');
    INSERT INTO resources (id, resource_key, created_at)
    VALUES (501, 'website:priority-fixture.example', '${now}');
    INSERT INTO resource_events (
      id, resource_id, version, name, kind, access_class, lifecycle_state,
      merged_into_resource_id, created_by, creation_method, supersedes_id, created_at
    ) VALUES (
      9501, 501, 1, 'Priority fixture', 'website', 'public', 'active',
      NULL, 'user', 'manual', NULL, '${now}'
    );
    INSERT INTO resource_heads (resource_id, event_id) VALUES (501, 9501);
  `);
  return {
    database,
    engine: createPriorityEngine(database.connection, { now: () => now }),
  };
}

function astWith(rules: readonly PriorityRule[], policy: Partial<PriorityRuleAstV1["policy"]> = {}) {
  return {
    schemaVersion: 1 as const,
    policy: {
      ...baselinePriorityRuleAst.policy,
      ...policy,
      bands: policy.bands ?? baselinePriorityRuleAst.policy.bands,
    },
    rules,
  };
}

function installRuleset(
  connection: Database.Database,
  rulesetId: number,
  ast: PriorityRuleAstV1,
): void {
  connection.prepare(`
    INSERT INTO priority_rulesets (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(rulesetId, `Test ruleset ${rulesetId}`, now, now);
  connection.prepare(`
    INSERT INTO priority_rule_versions (
      ruleset_id, version, rule_ast_json, created_by, created_at
    ) VALUES (?, 1, ?, 'agent', ?)
  `).run(rulesetId, canonicalPriorityRuleAstJson(ast), now);
}

function expectEngineCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PriorityEngineError);
    expect((error as PriorityEngineError).code).toBe(code);
  }
}

describe("PriorityEngine", () => {
  it("rejects every AST escape hatch and subject/operator mismatch", () => {
    const validRule: PriorityRule = {
      ruleKey: "test.valid",
      priority: 1,
      label: "Valid inert label",
      appliesTo: "page",
      when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
      effect: { scoreDelta: 1 },
    };
    expect(parsePriorityRuleAst(astWith([validRule]))).toMatchObject({ schemaVersion: 1 });

    const invalidRules: unknown[] = [
      { ...validRule, when: { all: [
        { signal: "is_open", operator: "gte", value: true },
      ] } },
      { ...validRule, when: { all: [
        { signal: "relation_count", operator: "in", value: [1] },
      ] } },
      { ...validRule, when: { all: [
        { signal: "status", operator: "eq", value: "inbox" },
      ] } },
      { ...validRule, when: { all: [
        { signal: "status", operator: "in", value: ["inbox", "inbox"] },
      ] } },
      { ...validRule, when: { all: [
        { signal: "resource_page_count", operator: "gte", value: 1 },
      ] } },
      { ...validRule, effect: { scoreFloor: 80, scoreCap: 20 } },
      { ...validRule, effect: { scoreDelta: Number.POSITIVE_INFINITY } },
      { ...validRule, effect: { sql: "DROP TABLE tabs" } },
      { ...validRule, when: { all: [
        { signal: "is_open", operator: "eq", value: true, regex: ".*" },
      ] } },
      { ...validRule, prompt: "decide freely" },
    ];
    for (const invalidRule of invalidRules) {
      expect(() => parsePriorityRuleAst(astWith([invalidRule as PriorityRule])))
        .toThrow(PriorityEngineError);
    }

    for (const forbiddenEffect of [
      { scoreDelta: -1 },
      { scoreFloor: 10 },
      { scoreCap: 90 },
      { exclusionReason: "policy_excluded" },
      { confidenceDelta: 0 },
      { confidenceDelta: 0.1 },
      { needsReview: false },
    ]) {
      expect(() => parsePriorityRuleAst(astWith([{
        ...validRule,
        when: { all: [
          { signal: "has_captured_content", operator: "eq", value: false },
        ] },
        effect: forbiddenEffect,
      } as PriorityRule]))).toThrow(PriorityEngineError);
    }
    expect(parsePriorityRuleAst(astWith([{
      ...validRule,
      when: { all: [
        { signal: "has_captured_content", operator: "eq", value: false },
      ] },
      effect: { confidenceDelta: -0.1, needsReview: true },
    }]))).toMatchObject({ schemaVersion: 1 });

    expect(() => parsePriorityRuleAst(astWith([validRule, { ...validRule }])))
      .toThrow(/duplicate ruleKey/);
    expect(() => parsePriorityRuleAst(astWith(Array.from({ length: 101 }, (_, index) => ({
      ...validRule,
      ruleKey: `test.rule-${index}`,
    }))))) .toThrow(/at most 100/);
    expect(() => parsePriorityRuleAst(astWith([{
      ...validRule,
      when: { all: Array.from({ length: 9 }, () =>
        ({ signal: "is_open", operator: "eq", value: true } as const)) },
    }]))) .toThrow(/1..8/);
    expect(() => parsePriorityRuleAst({ ...astWith([validRule]), unknown: true }))
      .toThrow(/unknown field/);
    expect(() => parsePriorityRuleAst(astWith([validRule], { baseScore: 41 })))
      .toThrow(/policy constants are fixed/);
  });

  it("applies the exact transparent baseline with deterministic reasons", () => {
    const { database, engine } = fixture();
    try {
      const [outcome] = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: {
          has_shareable_next_action: true,
          has_shareable_project_context: true,
          has_current_project_membership: true,
          is_pinned: true,
          active_use_30d_ms: 900_000,
          has_current_research_report: true,
          has_current_summary: true,
          relation_count: 1,
          has_captured_content: true,
        },
        assessmentMethod: "rule",
      }]);

      expect(outcome).toMatchObject({
        kind: "assessment",
        assessment: {
          subject: { type: "page", logicalPageId: 501 },
          agentScore: 100,
          agentBand: "critical",
          confidence: 1,
          needsReview: false,
          missingSignals: [],
          ruleset: { rulesetId: 1, version: 1 },
          assessmentMethod: "rule",
          modelProvenance: null,
          revision: 1,
          evaluatedAt: now,
        },
      });
      if (outcome?.kind !== "assessment") throw new Error("Expected assessment");
      expect(outcome.assessment.reasons.map((reason) => reason.code)).toEqual([
        "rule:baseline.active-use-30d",
        "rule:baseline.current-project",
        "rule:baseline.current-research-report",
        "rule:baseline.current-summary",
        "rule:baseline.pinned",
        "rule:baseline.relations",
        "rule:baseline.shareable-next-action",
        "rule:baseline.shareable-project-context",
      ]);
      expect(database.connection.prepare(`
        SELECT agent_score, agent_band, confidence, needs_review, revision
        FROM priority_assessments WHERE logical_page_id = 501
      `).get()).toEqual({
        agent_score: 100,
        agent_band: "critical",
        confidence: 1,
        needs_review: 0,
        revision: 1,
      });
    } finally {
      database.close();
    }
  });

  it("penalizes missing captured content only in confidence and persists review", () => {
    const { database, engine } = fixture();
    try {
      const [outcome] = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: {
          has_shareable_next_action: false,
          has_shareable_project_context: false,
          has_current_project_membership: false,
          is_pinned: false,
          active_use_30d_ms: 0,
          has_current_research_report: false,
          has_current_summary: false,
          relation_count: 0,
          has_captured_content: false,
        },
        assessmentMethod: "rule",
      }]);

      expect(outcome).toMatchObject({
        kind: "assessment",
        assessment: {
          agentScore: 40,
          agentBand: "medium",
          confidence: 0.45,
          needsReview: true,
          missingSignals: ["captured_content"],
          reasons: [{ code: "review:low-confidence" }],
        },
      });
      expect(database.connection.prepare(`
        SELECT agent_score, confidence, needs_review, missing_signals_json
        FROM priority_assessments WHERE logical_page_id = 501
      `).get()).toEqual({
        agent_score: 40,
        confidence: 0.45,
        needs_review: 1,
        missing_signals_json: '["captured_content"]',
      });
    } finally {
      database.close();
    }
  });

  it("canonicalizes feature sets and keeps equal page/resource IDs physically typed", () => {
    const { database, engine } = fixture();
    try {
      const first = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: {
          topic_paths: ["Projects / Beta", "Projects / Alpha"],
          status: ["done", "inbox"],
          has_captured_content: true,
        },
        assessmentMethod: "rule",
      }])[0]!;
      const replay = engine.assess([{
        assessmentMethod: "rule",
        features: {
          has_captured_content: true,
          status: ["inbox", "done", "inbox"],
          topic_paths: ["Projects / Alpha", "Projects / Beta"],
        },
        subject: { logicalPageId: 501, type: "page" },
      }])[0]!;
      expect(replay).toEqual(first);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments WHERE logical_page_id = 501
      `).pluck().get()).toBe(1);

      const resource = engine.assess([{
        subject: { type: "resource", resourceId: 501 },
        features: { has_captured_content: true, resource_page_count: 4 },
        assessmentMethod: "rule",
      }])[0]!;
      expect(resource).toMatchObject({
        kind: "assessment",
        assessment: { subject: { type: "resource", resourceId: 501 } },
      });
      if (first.kind !== "assessment" || resource.kind !== "assessment") {
        throw new Error("Expected typed assessments");
      }
      expect(first.assessment.featureFingerprint)
        .not.toBe(resource.assessment.featureFingerprint);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_priority_assessments WHERE resource_id = 501
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("resolves bounds, review effects, and exclusions by the total rule order", () => {
    const { database, engine } = fixture();
    const matchesContent = {
      all: [{ signal: "has_captured_content", operator: "eq", value: true }],
    } as const;
    try {
      installRuleset(database.connection, 2, astWith([
        {
          ruleKey: "test.high-floor",
          priority: 300,
          label: "High precedence floor",
          appliesTo: "both",
          when: matchesContent,
          effect: { scoreFloor: 80, needsReview: false },
        },
        {
          ruleKey: "test.lower-cap",
          priority: 200,
          label: "Lower precedence cap",
          appliesTo: "both",
          when: matchesContent,
          effect: { scoreCap: 40, needsReview: true },
        },
        {
          ruleKey: "test.delta",
          priority: 100,
          label: "Add five",
          appliesTo: "both",
          when: matchesContent,
          effect: { scoreDelta: 5 },
        },
      ]));
      const bounded = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }], { rulesetId: 2, version: 1 })[0]!;
      expect(bounded).toMatchObject({
        kind: "assessment",
        assessment: {
          agentScore: 80,
          agentBand: "high",
          confidence: 0.65,
          needsReview: false,
        },
      });
      if (bounded.kind !== "assessment") throw new Error("Expected assessment");
      expect(bounded.assessment.reasons.map(({ code }) => code)).toEqual([
        "rule:test.high-floor",
        "rule:test.lower-cap",
        "rule:test.delta",
        "conflict:score-bound:test.high-floor:test.lower-cap",
      ]);

      installRuleset(database.connection, 3, astWith([
        {
          ruleKey: "test.user-exclusion",
          priority: 300,
          label: "Higher exclusion",
          appliesTo: "both",
          when: matchesContent,
          effect: { exclusionReason: "user_excluded" },
        },
        {
          ruleKey: "test.policy-exclusion",
          priority: 200,
          label: "Lower exclusion",
          appliesTo: "both",
          when: matchesContent,
          effect: { exclusionReason: "policy_excluded" },
        },
      ]));
      const excluded = engine.assess([{
        subject: { type: "page", logicalPageId: 502 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }], { rulesetId: 3, version: 1 })[0]!;
      expect(excluded).toMatchObject({
        kind: "exclusion",
        exclusion: {
          reason: "user_excluded",
          detail: {
            ruleKey: "test.user-exclusion",
            competingRuleKeys: ["test.policy-exclusion"],
          },
        },
      });
      const assessmentAfterExclusion = engine.assess([{
        subject: { type: "page", logicalPageId: 502 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }])[0]!;
      expect(assessmentAfterExclusion).toMatchObject({
        kind: "assessment",
        assessment: { revision: 2 },
      });
      const exclusionAfterAssessment = engine.assess([{
        subject: { type: "page", logicalPageId: 502 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
        eligibility: {
          kind: "excluded",
          reason: "private_or_internal",
          detail: { source: "url_policy", code: "private_ip" },
        },
      }])[0]!;
      expect(exclusionAfterAssessment).toMatchObject({
        kind: "exclusion",
        exclusion: { reason: "private_or_internal", revision: 3 },
      });
      expect(engine.explain({ type: "page", logicalPageId: 502 }))
        .toEqual(exclusionAfterAssessment);
      expect(database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM priority_assessments
            WHERE logical_page_id = 502 AND superseded_at IS NULL) AS assessments,
          (SELECT COUNT(*) FROM priority_exclusions
            WHERE logical_page_id = 502 AND superseded_at IS NULL) AS exclusions
      `).get()).toEqual({ assessments: 0, exclusions: 1 });

      installRuleset(database.connection, 4, astWith([{
        ruleKey: "test.explicit-no-review",
        priority: 100,
        label: "Explicit false cannot hide low confidence",
        appliesTo: "both",
        when: { all: [{ signal: "is_open", operator: "eq", value: true }] },
        effect: { needsReview: false },
      }]));
      expect(engine.assess([{
        subject: { type: "resource", resourceId: 501 },
        features: { has_captured_content: false, is_open: true },
        assessmentMethod: "rule",
      }], { rulesetId: 4, version: 1 })[0]).toMatchObject({
        kind: "assessment",
        assessment: { confidence: 0.45, needsReview: true },
      });
    } finally {
      database.close();
    }
  });

  it("keeps local-only existence outside inputs, fingerprints, reasons, and storage", () => {
    const { database, engine } = fixture();
    const canary = "PRIVATE_LOCAL_ONLY_CANARY_7f6b";
    try {
      createContextLedger(database.connection, { now: () => now }).change({
        kind: "append",
        subject: { type: "page", logicalPageId: 501 },
        entryKind: "project",
        body: canary,
        provenance: { actor: "user", method: "manual" },
        visibility: "local_only",
        idempotencyKey: "priority-local-only-canary",
      });
      const outcome = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }])[0]!;
      expect(JSON.stringify(outcome)).not.toContain(canary);
      const stored = database.connection.prepare(`
        SELECT feature_fingerprint, reasons_json, missing_signals_json
        FROM priority_assessments WHERE logical_page_id = 501
      `).get();
      expect(JSON.stringify(stored)).not.toContain(canary);
      const before = database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments
      `).pluck().get();
      expectEngineCode(() => engine.assess([{
        subject: { type: "page", logicalPageId: 502 },
        features: { has_local_only_context: true },
        assessmentMethod: "rule",
      } as unknown as PriorityAssessmentInput]), "INVALID_PRIORITY_INPUT");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments
      `).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("validates model provenance and atomically no-ops or replaces typed outcomes", () => {
    const { database, engine } = fixture();
    const baseInput: PriorityAssessmentInput = {
      subject: { type: "page", logicalPageId: 501 },
      features: { has_captured_content: true, relation_count: 0 },
      assessmentMethod: "rule",
    };
    try {
      const first = engine.assess([baseInput])[0]!;
      const replay = engine.assess([baseInput])[0]!;
      expect(replay).toEqual(first);
      if (first.kind !== "assessment") throw new Error("Expected assessment");

      expectEngineCode(() => engine.assess([{
        ...baseInput,
        modelProvenance: { provider: "forbidden", name: "forbidden", promptVersion: "v1" },
      }]), "INVALID_PRIORITY_INPUT");
      expectEngineCode(() => engine.assess([{
        ...baseInput,
        assessmentMethod: "model",
        modelProvenance: {
          provider: "provider",
          name: "model",
          promptVersion: "prompt-v1",
          apiKey: "secret",
        },
      } as unknown as PriorityAssessmentInput]), "INVALID_PRIORITY_INPUT");

      const model = engine.assess([{
        ...baseInput,
        subject: { type: "page", logicalPageId: 502 },
        assessmentMethod: "model",
        modelProvenance: { provider: "provider", name: "model", promptVersion: "prompt-v1" },
      }])[0]!;
      expect(model).toMatchObject({
        kind: "assessment",
        assessment: {
          assessmentMethod: "model",
          modelProvenance: { provider: "provider", name: "model", promptVersion: "prompt-v1" },
        },
      });
      const modelReplay = engine.assess([{
        ...baseInput,
        subject: { type: "page", logicalPageId: 502 },
        assessmentMethod: "model",
        modelProvenance: { provider: "provider", name: "model", promptVersion: "prompt-v1" },
      }])[0]!;
      expect(modelReplay).toEqual(model);
      const changedProvenance = engine.assess([{
        ...baseInput,
        subject: { type: "page", logicalPageId: 502 },
        assessmentMethod: "model",
        modelProvenance: { provider: "provider", name: "model", promptVersion: "prompt-v2" },
      }])[0]!;
      expect(changedProvenance).toMatchObject({
        kind: "assessment",
        assessment: { revision: 2, modelProvenance: { promptVersion: "prompt-v2" } },
      });
      const ruleAfterModel = engine.assess([{
        ...baseInput,
        subject: { type: "page", logicalPageId: 502 },
      }])[0]!;
      expect(ruleAfterModel).toMatchObject({
        kind: "assessment",
        assessment: { revision: 3, assessmentMethod: "rule", modelProvenance: null },
      });
      const eligibilityExclusion = engine.assess([{
        ...baseInput,
        assessmentMethod: "model",
        modelProvenance: { provider: "provider", name: "model", promptVersion: "prompt-v1" },
        eligibility: { kind: "excluded", reason: "temporarily_unavailable" },
      }])[0]!;
      expect(eligibilityExclusion).toMatchObject({
        kind: "exclusion",
        exclusion: { reason: "temporarily_unavailable" },
      });
      expect(engine.assess([{
        ...baseInput,
        assessmentMethod: "rule",
        eligibility: { kind: "excluded", reason: "temporarily_unavailable" },
      }])[0]).toEqual(eligibilityExclusion);

      installRuleset(database.connection, 5, astWith([]));
      const replacement = engine.assess([{
        ...baseInput,
        features: { has_captured_content: true, relation_count: 1 },
      }], { rulesetId: 5, version: 1 })[0]!;
      expect(replacement).toMatchObject({
        kind: "assessment",
        assessment: { revision: 3, ruleset: { rulesetId: 5, version: 1 } },
      });
      expect(database.connection.prepare(`
        SELECT revision, superseded_at IS NULL AS is_current
        FROM priority_assessments WHERE logical_page_id = 501 ORDER BY revision
      `).all()).toEqual([
        { revision: 1, is_current: 0 },
        { revision: 3, is_current: 1 },
      ]);

      const beforeRollback = database.connection.prepare(`
        SELECT * FROM priority_assessments WHERE logical_page_id = 501 ORDER BY revision
      `).all();
      expectEngineCode(() => engine.assess([
        { ...baseInput, features: { has_captured_content: false } },
        {
          ...baseInput,
          subject: { type: "page", logicalPageId: 999_999 },
        },
      ]), "PRIORITY_SUBJECT_NOT_FOUND");
      expect(database.connection.prepare(`
        SELECT * FROM priority_assessments WHERE logical_page_id = 501 ORDER BY revision
      `).all()).toEqual(beforeRollback);

      const beforeOversize = database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments
      `).pluck().get();
      expectEngineCode(() => engine.assess(Array.from({ length: 101 }, () => baseInput)),
        "PRIORITY_BATCH_TOO_LARGE");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments
      `).pluck().get()).toBe(beforeOversize);
      expectEngineCode(() => engine.assess([baseInput, baseInput]),
        "PRIORITY_DUPLICATE_SUBJECT");
    } finally {
      database.close();
    }
  });

  it("persists model rule exclusions and replays them independent of provenance", () => {
    const { database, engine } = fixture();
    try {
      installRuleset(database.connection, 6, astWith([{
        ruleKey: "test.model-exclusion",
        priority: 1,
        label: "Typed model exclusion",
        appliesTo: "page",
        when: { all: [{ signal: "has_captured_content", operator: "eq", value: true }] },
        effect: { exclusionReason: "policy_excluded" },
      }]));
      const model = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "model",
        modelProvenance: { provider: "provider-a", name: "model-a", promptVersion: "v1" },
      }], { rulesetId: 6, version: 1 })[0]!;
      expect(model).toMatchObject({
        kind: "exclusion",
        exclusion: { reason: "policy_excluded", revision: 1 },
      });
      const replay = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }], { rulesetId: 6, version: 1 })[0]!;
      expect(replay).toEqual(model);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM priority_exclusions WHERE logical_page_id = 501
      `).pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fails closed when stored assessment reasons or missing signals are corrupt", () => {
    for (const corruption of [
      { column: "reasons_json", value: '[{"code":"x","kind":"review","label":"x","extra":true}]' },
      { column: "reasons_json", value: '[{"code":"x","kind":"review","label":"x"},{"code":"x","kind":"review","label":"y"}]' },
      { column: "missing_signals_json", value: '["captured_content","unknown_signal"]' },
      { column: "missing_signals_json", value: '["captured_content","captured_content"]' },
    ]) {
      const { database, engine } = fixture();
      try {
        engine.assess([{
          subject: { type: "page", logicalPageId: 501 },
          features: { has_captured_content: true },
          assessmentMethod: "rule",
        }]);
        database.connection.exec("DROP TRIGGER priority_assessments_append_only");
        database.connection.pragma("ignore_check_constraints = ON");
        database.connection.prepare(`
          UPDATE priority_assessments SET ${corruption.column} = ?
          WHERE logical_page_id = 501
        `).run(corruption.value);
        database.connection.pragma("ignore_check_constraints = OFF");
        expectEngineCode(
          () => engine.explain({ type: "page", logicalPageId: 501 }),
          "PRIORITY_STORAGE_CORRUPT",
        );
      } finally {
        database.close();
      }
    }
  });

  it("uses immediate transactions so concurrent writers cannot partially persist", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabhub-priority-lock-"));
    const filename = join(directory, "priority.sqlite");
    const first = openDatabase(filename, {
      migrationClock: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const second = openDatabase(filename);
    try {
      first.connection.exec(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (501, 'https://example.com/locked', 'https://example.com/locked',
          'https://example.com/locked', '${now}', '${now}')
      `);
      second.connection.pragma("busy_timeout = 0");
      const engine = createPriorityEngine(second.connection, { now: () => now });
      first.connection.exec("BEGIN IMMEDIATE");
      expect(() => engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }])).toThrow(/database is locked/i);
      expect(first.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments WHERE logical_page_id = 501
      `).pluck().get()).toBe(0);
      first.connection.exec("ROLLBACK");

      const outcome = engine.assess([{
        subject: { type: "page", logicalPageId: 501 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }])[0]!;
      if (outcome.kind !== "assessment") throw new Error("Expected assessment");
      first.connection.exec("BEGIN IMMEDIATE");
      expect(() => engine.recordFeedback({
        subject: { type: "page", logicalPageId: 501 },
        assessmentId: outcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "locked-feedback",
      })).toThrow(/database is locked/i);
      expect(first.connection.prepare(`
        SELECT COUNT(*) FROM priority_feedback WHERE logical_page_id = 501
      `).pluck().get()).toBe(0);
      first.connection.exec("ROLLBACK");
      expect(engine.recordFeedback({
        subject: { type: "page", logicalPageId: 501 },
        assessmentId: outcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "locked-feedback",
      })).toMatchObject({ revision: 1 });
    } finally {
      if (first.connection.inTransaction) first.connection.exec("ROLLBACK");
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records assessment-only feedback with global idempotency and direct supersession", () => {
    const { database, engine } = fixture();
    const pageInput: PriorityAssessmentInput = {
      subject: { type: "page", logicalPageId: 501 },
      features: { has_captured_content: true },
      assessmentMethod: "rule",
    };
    const resourceInput: PriorityAssessmentInput = {
      subject: { type: "resource", resourceId: 501 },
      features: { has_captured_content: true },
      assessmentMethod: "rule",
    };
    try {
      const pageOutcome = engine.assess([pageInput])[0]!;
      const resourceOutcome = engine.assess([resourceInput])[0]!;
      if (pageOutcome.kind !== "assessment" || resourceOutcome.kind !== "assessment") {
        throw new Error("Expected assessments");
      }
      const firstInput = {
        subject: pageInput.subject,
        assessmentId: pageOutcome.assessment.id,
        verdict: "accept" as const,
        note: "Looks right",
        provenance: { actor: "user" as const, method: "manual" as const },
        idempotencyKey: "priority-feedback-global-1",
      };
      const first = engine.recordFeedback(firstInput);
      expect(first).toMatchObject({
        subject: { type: "page", logicalPageId: 501 },
        revision: 1,
        supersedesId: null,
        supersededAt: null,
      });
      const second = engine.recordFeedback({
        subject: pageInput.subject,
        assessmentId: pageOutcome.assessment.id,
        verdict: "too_high",
        provenance: {
          actor: "agent",
          method: "on_behalf_of_user",
          authorizationRef: "user-request:feedback-2",
        },
        idempotencyKey: "priority-feedback-global-2",
        supersedesId: first.id,
      });
      expect(second).toMatchObject({
        revision: 2,
        supersedesId: first.id,
        actor: "agent",
        method: "on_behalf_of_user",
        authorizationRef: "user-request:feedback-2",
      });
      expect(engine.recordFeedback(firstInput)).toMatchObject({
        id: first.id,
        revision: 1,
        supersededAt: now,
      });
      expectEngineCode(() => engine.recordFeedback({
        ...firstInput,
        verdict: "reject",
      }), "IDEMPOTENCY_KEY_CONFLICT");
      expectEngineCode(() => engine.recordFeedback({
        subject: resourceInput.subject,
        assessmentId: resourceOutcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "priority-feedback-global-1",
      }), "IDEMPOTENCY_KEY_CONFLICT");
      expectEngineCode(() => engine.recordFeedback({
        subject: { type: "page", logicalPageId: 502 },
        assessmentId: pageOutcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "priority-feedback-cross-subject",
      }), "PRIORITY_FEEDBACK_ASSESSMENT_NOT_CURRENT");
      expectEngineCode(() => engine.recordFeedback({
        subject: pageInput.subject,
        assessmentId: pageOutcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "priority-feedback-wrong-predecessor",
        supersedesId: first.id,
      }), "PRIORITY_FEEDBACK_SUPERSESSION_CONFLICT");
      expectEngineCode(() => engine.recordFeedback({
        subject: pageInput.subject,
        assessmentId: pageOutcome.assessment.id,
        verdict: "accept",
        provenance: { actor: "agent", method: "on_behalf_of_user" },
        idempotencyKey: "priority-feedback-no-authorization",
      } as never), "INVALID_PRIORITY_INPUT");

      const replacement = engine.assess([{
        ...pageInput,
        features: { has_captured_content: true, relation_count: 1 },
      }])[0]!;
      if (replacement.kind !== "assessment") throw new Error("Expected replacement");
      expectEngineCode(() => engine.recordFeedback({
        ...firstInput,
        idempotencyKey: "priority-feedback-old-assessment",
      }), "PRIORITY_FEEDBACK_ASSESSMENT_NOT_CURRENT");
      const third = engine.recordFeedback({
        subject: pageInput.subject,
        assessmentId: replacement.assessment.id,
        verdict: "too_low",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "priority-feedback-global-3",
        supersedesId: second.id,
      });
      expect(third).toMatchObject({ revision: 3, supersedesId: second.id });

      const regressed = createPriorityEngine(database.connection, {
        now: () => "2026-08-12T23:59:59.000Z",
      });
      expectEngineCode(() => regressed.recordFeedback({
        subject: pageInput.subject,
        assessmentId: replacement.assessment.id,
        verdict: "accept",
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: "priority-feedback-clock-regression",
        supersedesId: third.id,
      }), "PRIORITY_CLOCK_REGRESSION");
      expect(database.connection.prepare(`
        SELECT revision, superseded_at IS NULL AS is_current
        FROM priority_feedback WHERE logical_page_id = 501 ORDER BY revision
      `).all()).toEqual([
        { revision: 1, is_current: 0 },
        { revision: 2, is_current: 0 },
        { revision: 3, is_current: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("assesses sensitive active resources but rejects resources without an active head", () => {
    const { database, engine } = fixture();
    try {
      database.connection.exec(`
        INSERT INTO resources (id, resource_key, created_at)
        VALUES (502, 'website:sensitive-priority.example', '${now}');
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          merged_into_resource_id, created_by, creation_method, supersedes_id, created_at
        ) VALUES (
          9502, 502, 1, 'Sensitive active resource', 'website', 'sensitive', 'active',
          NULL, 'user', 'manual', NULL, '${now}'
        );
        INSERT INTO resource_heads (resource_id, event_id) VALUES (502, 9502);
      `);
      expect(engine.assess([{
        subject: { type: "resource", resourceId: 502 },
        features: { has_captured_content: false, is_pinned: true, status: ["inbox"] },
        assessmentMethod: "rule",
      }])[0]).toMatchObject({
        kind: "assessment",
        assessment: {
          subject: { type: "resource", resourceId: 502 },
          agentScore: 50,
          confidence: 0.5,
          needsReview: true,
        },
      });

      database.connection.exec(`
        INSERT INTO resource_events (
          id, resource_id, version, name, kind, access_class, lifecycle_state,
          merged_into_resource_id, created_by, creation_method, supersedes_id, created_at
        ) VALUES (
          9503, 502, 2, 'Sensitive merged resource', 'website', 'sensitive', 'merged',
          501, 'user', 'manual', 9502, '${now}'
        );
        UPDATE resource_heads SET event_id = 9503 WHERE resource_id = 502;
      `);
      expect(database.connection.prepare(`
        SELECT superseded_at FROM resource_priority_assessments
        WHERE resource_id = 502
      `).pluck().get()).toBe(now);
      expect(engine.explain({ type: "resource", resourceId: 502 })).toBeNull();
      const before = database.connection.prepare(`
        SELECT COUNT(*) FROM resource_priority_assessments WHERE resource_id = 502
      `).pluck().get();
      expectEngineCode(() => engine.assess([{
        subject: { type: "resource", resourceId: 502 },
        features: { has_captured_content: true },
        assessmentMethod: "rule",
      }]), "PRIORITY_RESOURCE_NOT_ACTIVE");
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM resource_priority_assessments WHERE resource_id = 502
      `).pluck().get()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("keeps 50-outcome batch p95 below 500ms without touching user judgment or retention", () => {
    const { database, engine } = fixture();
    try {
      const insertPage = database.connection.prepare(`
        INSERT INTO logical_pages (
          id, identity_key, url_normalized, representative_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertPreference = database.connection.prepare(`
        INSERT INTO logical_page_preferences (
          logical_page_id, user_importance, recorded_by, record_method,
          importance_updated_at, updated_at
        ) VALUES (?, ?, 'user', 'manual', ?, ?)
      `);
      database.connection.transaction(() => {
        for (let index = 0; index < 50; index += 1) {
          const id = 1_000 + index;
          const url = `https://example.com/performance-${index}`;
          insertPage.run(id, url, url, url, now, now);
          insertPreference.run(id, (index % 3) + 1, now, now);
        }
      })();
      const protectedBefore = {
        importance: database.connection.prepare(`
          SELECT * FROM logical_page_preferences ORDER BY logical_page_id
        `).all(),
        resourceEvaluation: database.connection.prepare(`
          SELECT * FROM resource_preferences ORDER BY resource_id
        `).all(),
        retention: database.connection.prepare(`
          SELECT * FROM page_retention ORDER BY tab_id
        `).all(),
      };
      const makeBatch = (round: number): PriorityAssessmentInput[] =>
        Array.from({ length: 50 }, (_, index) => ({
          subject: { type: "page", logicalPageId: 1_000 + index },
          features: {
            has_captured_content: true,
            active_use_30d_ms: round * 1_000 + index,
            relation_count: index % 4,
          },
          assessmentMethod: "rule",
        }));
      engine.assess(makeBatch(0));
      const elapsed: number[] = [];
      for (let round = 1; round <= 20; round += 1) {
        const startedAt = performance.now();
        expect(engine.assess(makeBatch(round))).toHaveLength(50);
        elapsed.push(performance.now() - startedAt);
      }
      elapsed.sort((left, right) => left - right);
      const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1]!;
      process.stdout.write(`C50_BATCH50_P95_MS=${p95.toFixed(3)}\n`);
      expect(p95).toBeLessThanOrEqual(500);
      expect(database.connection.prepare(`
        SELECT COUNT(*) FROM priority_assessments WHERE logical_page_id >= 1000
      `).pluck().get()).toBe(50 * 21);
      expect({
        importance: database.connection.prepare(`
          SELECT * FROM logical_page_preferences ORDER BY logical_page_id
        `).all(),
        resourceEvaluation: database.connection.prepare(`
          SELECT * FROM resource_preferences ORDER BY resource_id
        `).all(),
        retention: database.connection.prepare(`
          SELECT * FROM page_retention ORDER BY tab_id
        `).all(),
      }).toEqual(protectedBefore);
    } finally {
      database.close();
    }
  });
});
