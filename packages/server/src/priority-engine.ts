import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { canonicalJsonV1 as canonicalJson } from "@tabhub/shared";

export const prioritySignalNames = [
  "has_shareable_next_action",
  "has_shareable_project_context",
  "has_current_project_membership",
  "topic_paths",
  "workspace_names",
  "is_pinned",
  "is_open",
  "status",
  "relation_count",
  "active_use_30d_ms",
  "on_screen_30d_ms",
  "age_days",
  "last_seen_days",
  "has_captured_content",
  "has_current_summary",
  "has_current_research_report",
  "duplicate_physical_count",
  "resource_page_count",
  "resource_captured_page_count",
] as const;

export type PrioritySignalName = (typeof prioritySignalNames)[number];
export type PrioritySubjectType = "page" | "resource";
export type PriorityBand = "low" | "medium" | "high" | "critical";
export type PriorityExclusionReason =
  | "unsupported_url"
  | "private_or_internal"
  | "user_excluded"
  | "policy_excluded"
  | "insufficient_signals"
  | "temporarily_unavailable";

export type PrioritySubject =
  | { readonly type: "page"; readonly logicalPageId: number }
  | { readonly type: "resource"; readonly resourceId: number };

type ScalarFeature = boolean | number | readonly string[];
export type PriorityFeatures = Readonly<Partial<Record<PrioritySignalName, ScalarFeature>>>;

export interface PriorityRulesetRef {
  readonly rulesetId: number;
  readonly version: number;
}

export interface PriorityModelProvenance {
  readonly provider: string;
  readonly name: string;
  readonly promptVersion: string;
}

export type PriorityEligibility =
  | { readonly kind: "eligible" }
  | {
      readonly kind: "excluded";
      readonly reason: PriorityExclusionReason;
      readonly detail?: {
        readonly source: "eligibility" | "url_policy";
        readonly code?: string;
      };
    };

export interface PriorityAssessmentInput {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly assessmentMethod: "rule" | "model";
  readonly modelProvenance?: PriorityModelProvenance;
  readonly eligibility?: PriorityEligibility;
}

export interface PriorityReason {
  readonly code: string;
  readonly kind: "contribution" | "conflict" | "review";
  readonly label: string;
  readonly scoreDelta?: number;
  readonly confidenceDelta?: number;
  readonly appliedRuleKey?: string;
  readonly ignoredRuleKey?: string;
}

export interface PriorityAssessment {
  readonly id: number;
  readonly subject: PrioritySubject;
  readonly agentScore: number;
  readonly agentBand: PriorityBand;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly reasons: readonly PriorityReason[];
  readonly missingSignals: readonly string[];
  readonly ruleset: PriorityRulesetRef;
  readonly featureFingerprint: string;
  readonly assessmentMethod: "rule" | "model";
  readonly modelProvenance: PriorityModelProvenance | null;
  readonly revision: number;
  readonly evaluatedAt: string;
  readonly supersededAt: string | null;
}

export interface PriorityExclusion {
  readonly id: number;
  readonly subject: PrioritySubject;
  readonly reason: PriorityExclusionReason;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly ruleset: PriorityRulesetRef;
  readonly featureFingerprint: string;
  readonly revision: number;
  readonly evaluatedAt: string;
  readonly supersededAt: string | null;
}

export type PriorityOutcome =
  | { readonly kind: "assessment"; readonly assessment: PriorityAssessment }
  | { readonly kind: "exclusion"; readonly exclusion: PriorityExclusion };

export type PriorityFeedbackVerdict = "accept" | "reject" | "too_high" | "too_low";

export type PriorityFeedbackActor =
  | { readonly actor: "user"; readonly method: "manual" }
  | {
      readonly actor: "agent";
      readonly method: "on_behalf_of_user";
      readonly authorizationRef: string;
    };

export interface PriorityFeedbackInput {
  readonly subject: PrioritySubject;
  readonly assessmentId: number;
  readonly verdict: PriorityFeedbackVerdict;
  readonly note?: string;
  readonly provenance: PriorityFeedbackActor;
  readonly idempotencyKey: string;
  readonly supersedesId?: number;
}

export interface PriorityFeedbackRecord {
  readonly id: number;
  readonly subject: PrioritySubject;
  readonly assessmentId: number;
  readonly verdict: PriorityFeedbackVerdict;
  readonly note: string | null;
  readonly actor: "user" | "agent";
  readonly method: "manual" | "on_behalf_of_user";
  readonly authorizationRef: string | null;
  readonly idempotencyKey: string;
  readonly supersedesId: number | null;
  readonly supersededAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
}

export type PriorityEngineErrorCode =
  | "INVALID_PRIORITY_INPUT"
  | "INVALID_PRIORITY_RULESET"
  | "PRIORITY_SUBJECT_NOT_FOUND"
  | "PRIORITY_RESOURCE_NOT_ACTIVE"
  | "PRIORITY_BATCH_TOO_LARGE"
  | "PRIORITY_DUPLICATE_SUBJECT"
  | "PRIORITY_CLOCK_REGRESSION"
  | "PRIORITY_STORAGE_CORRUPT"
  | "PRIORITY_OUTCOME_NOT_FOUND"
  | "PRIORITY_FEEDBACK_ASSESSMENT_NOT_CURRENT"
  | "PRIORITY_FEEDBACK_SUPERSESSION_CONFLICT"
  | "IDEMPOTENCY_KEY_CONFLICT";

export class PriorityEngineError extends Error {
  constructor(
    readonly code: PriorityEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PriorityEngineError";
  }
}

type BooleanSignal =
  | "has_shareable_next_action"
  | "has_shareable_project_context"
  | "has_current_project_membership"
  | "is_pinned"
  | "is_open"
  | "has_captured_content"
  | "has_current_summary"
  | "has_current_research_report";
type NumericSignal =
  | "relation_count"
  | "active_use_30d_ms"
  | "on_screen_30d_ms"
  | "age_days"
  | "last_seen_days"
  | "duplicate_physical_count"
  | "resource_page_count"
  | "resource_captured_page_count";
type StringArraySignal = "topic_paths" | "workspace_names" | "status";

type PriorityCondition =
  | { readonly signal: BooleanSignal; readonly operator: "eq"; readonly value: boolean }
  | {
      readonly signal: NumericSignal;
      readonly operator: "eq" | "gte" | "lte";
      readonly value: number;
    }
  | {
      readonly signal: StringArraySignal;
      readonly operator: "in";
      readonly value: readonly string[];
    };

export interface PriorityRuleEffect {
  readonly scoreDelta?: number;
  readonly confidenceDelta?: number;
  readonly scoreFloor?: number;
  readonly scoreCap?: number;
  readonly needsReview?: boolean;
  readonly exclusionReason?: "user_excluded" | "policy_excluded";
}

export interface PriorityRule {
  readonly ruleKey: string;
  readonly priority: number;
  readonly label: string;
  readonly appliesTo: PrioritySubjectType | "both";
  readonly when: { readonly all: readonly PriorityCondition[] };
  readonly effect: PriorityRuleEffect;
}

export interface PriorityRuleAstV1 {
  readonly schemaVersion: 1;
  readonly policy: {
    readonly baseScore: number;
    readonly baseConfidence: number;
    readonly lowConfidenceThreshold: number;
    readonly missingCapturedContentPenalty: number;
    readonly bands: {
      readonly mediumMin: number;
      readonly highMin: number;
      readonly criticalMin: number;
    };
  };
  readonly rules: readonly PriorityRule[];
}

export const baselinePriorityRuleAst: PriorityRuleAstV1 = {
  schemaVersion: 1,
  policy: {
    baseScore: 40,
    baseConfidence: 0.65,
    lowConfidenceThreshold: 0.6,
    missingCapturedContentPenalty: 0.2,
    bands: { mediumMin: 25, highMin: 60, criticalMin: 85 },
  },
  rules: [
    {
      ruleKey: "baseline.active-use-30d",
      priority: 100,
      label: "At least 15 minutes of active use in 30 days",
      appliesTo: "both",
      when: { all: [{ signal: "active_use_30d_ms", operator: "gte", value: 900_000 }] },
      effect: { scoreDelta: 10, confidenceDelta: 0.1 },
    },
    {
      ruleKey: "baseline.current-project",
      priority: 100,
      label: "Member of a current project",
      appliesTo: "both",
      when: {
        all: [{ signal: "has_current_project_membership", operator: "eq", value: true }],
      },
      effect: { scoreDelta: 15, confidenceDelta: 0.1 },
    },
    {
      ruleKey: "baseline.current-research-report",
      priority: 100,
      label: "Has a current research report",
      appliesTo: "both",
      when: {
        all: [{ signal: "has_current_research_report", operator: "eq", value: true }],
      },
      effect: { scoreDelta: 10, confidenceDelta: 0.1 },
    },
    {
      ruleKey: "baseline.current-summary",
      priority: 100,
      label: "Has a current summary",
      appliesTo: "both",
      when: { all: [{ signal: "has_current_summary", operator: "eq", value: true }] },
      effect: { scoreDelta: 0, confidenceDelta: 0.05 },
    },
    {
      ruleKey: "baseline.pinned",
      priority: 100,
      label: "Pinned in the browser",
      appliesTo: "both",
      when: { all: [{ signal: "is_pinned", operator: "eq", value: true }] },
      effect: { scoreDelta: 10, confidenceDelta: 0.05 },
    },
    {
      ruleKey: "baseline.relations",
      priority: 100,
      label: "Has knowledge relations",
      appliesTo: "both",
      when: { all: [{ signal: "relation_count", operator: "gte", value: 1 }] },
      effect: { scoreDelta: 5, confidenceDelta: 0.05 },
    },
    {
      ruleKey: "baseline.shareable-next-action",
      priority: 100,
      label: "Has a shareable next action",
      appliesTo: "both",
      when: {
        all: [{ signal: "has_shareable_next_action", operator: "eq", value: true }],
      },
      effect: { scoreDelta: 25, confidenceDelta: 0.15 },
    },
    {
      ruleKey: "baseline.shareable-project-context",
      priority: 100,
      label: "Has shareable project context",
      appliesTo: "both",
      when: {
        all: [{ signal: "has_shareable_project_context", operator: "eq", value: true }],
      },
      effect: { scoreDelta: 15, confidenceDelta: 0.1 },
    },
  ],
};

const booleanSignals = new Set<PrioritySignalName>([
  "has_shareable_next_action",
  "has_shareable_project_context",
  "has_current_project_membership",
  "is_pinned",
  "is_open",
  "has_captured_content",
  "has_current_summary",
  "has_current_research_report",
]);
const numericSignals = new Set<PrioritySignalName>([
  "relation_count",
  "active_use_30d_ms",
  "on_screen_30d_ms",
  "age_days",
  "last_seen_days",
  "duplicate_physical_count",
  "resource_page_count",
  "resource_captured_page_count",
]);
const stringArraySignals = new Set<PrioritySignalName>([
  "topic_paths",
  "workspace_names",
  "status",
]);
const resourceOnlySignals = new Set<PrioritySignalName>([
  "resource_page_count",
  "resource_captured_page_count",
]);
const exclusionReasons = new Set<PriorityExclusionReason>([
  "unsupported_url",
  "private_or_internal",
  "user_excluded",
  "policy_excluded",
  "insufficient_signals",
  "temporarily_unavailable",
]);

function invalidInput(message: string): never {
  throw new PriorityEngineError("INVALID_PRIORITY_INPUT", message);
}

function invalidRuleset(message: string): never {
  throw new PriorityEngineError("INVALID_PRIORITY_RULESET", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  context: string,
  fail: (message: string) => never,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${context} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${context} is missing ${key}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeBoundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
  fail: (message: string) => never,
): string {
  if (typeof value !== "string") fail(`${name} must be text`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") < 1 ||
      Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    fail(`${name} must be 1..${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function normalizeFiniteNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fail: (message: string) => never,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fail: (message: string) => never,
): number {
  const result = normalizeFiniteNumber(value, name, minimum, maximum, fail);
  if (!Number.isSafeInteger(result)) fail(`${name} must be an integer`);
  return result;
}

function subjectAllowsSignal(
  appliesTo: PrioritySubjectType | "both",
  signal: PrioritySignalName,
): boolean {
  if (resourceOnlySignals.has(signal)) return appliesTo === "resource";
  return true;
}

function normalizeCondition(
  raw: unknown,
  appliesTo: PrioritySubjectType | "both",
  ruleKey: string,
  index: number,
): PriorityCondition {
  if (!isPlainObject(raw)) invalidRuleset(`${ruleKey}.when.all[${index}] must be an object`);
  assertExactKeys(
    raw,
    ["signal", "operator", "value"],
    ["signal", "operator", "value"],
    `${ruleKey}.when.all[${index}]`,
    invalidRuleset,
  );
  if (typeof raw.signal !== "string" ||
      !prioritySignalNames.includes(raw.signal as PrioritySignalName)) {
    invalidRuleset(`${ruleKey}.when.all[${index}] has unknown signal`);
  }
  const signal = raw.signal as PrioritySignalName;
  if (!subjectAllowsSignal(appliesTo, signal)) {
    invalidRuleset(`${ruleKey} uses subject-incompatible signal ${signal}`);
  }
  if (booleanSignals.has(signal)) {
    if (raw.operator !== "eq" || typeof raw.value !== "boolean") {
      invalidRuleset(`${signal} accepts only eq with a boolean`);
    }
    return { signal: signal as BooleanSignal, operator: "eq", value: raw.value };
  }
  if (numericSignals.has(signal)) {
    if (!(raw.operator === "eq" || raw.operator === "gte" || raw.operator === "lte")) {
      invalidRuleset(`${signal} accepts only eq, gte, or lte`);
    }
    const value = normalizeFiniteNumber(
      raw.value,
      `${ruleKey}.${signal}.value`,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      invalidRuleset,
    );
    return {
      signal: signal as NumericSignal,
      operator: raw.operator,
      value,
    };
  }
  if (!stringArraySignals.has(signal) || raw.operator !== "in" || !Array.isArray(raw.value)) {
    invalidRuleset(`${signal} accepts only in with a string array`);
  }
  if (raw.value.length < 1 || raw.value.length > 100) {
    invalidRuleset(`${ruleKey}.${signal}.value must contain 1..100 strings`);
  }
  const values = raw.value.map((entry, valueIndex) => normalizeBoundedString(
    entry,
    `${ruleKey}.${signal}.value[${valueIndex}]`,
    256,
    invalidRuleset,
  ));
  if (new Set(values).size !== values.length) {
    invalidRuleset(`${ruleKey}.${signal}.value must contain unique strings`);
  }
  return {
    signal: signal as StringArraySignal,
    operator: "in",
    value: [...values].sort(),
  };
}

function normalizeEffect(raw: unknown, ruleKey: string): PriorityRuleEffect {
  if (!isPlainObject(raw)) invalidRuleset(`${ruleKey}.effect must be an object`);
  const allowed = [
    "scoreDelta",
    "confidenceDelta",
    "scoreFloor",
    "scoreCap",
    "needsReview",
    "exclusionReason",
  ] as const;
  assertExactKeys(raw, allowed, [], `${ruleKey}.effect`, invalidRuleset);
  if (Object.keys(raw).length === 0) invalidRuleset(`${ruleKey}.effect must not be empty`);
  const effect: {
    scoreDelta?: number;
    confidenceDelta?: number;
    scoreFloor?: number;
    scoreCap?: number;
    needsReview?: boolean;
    exclusionReason?: "user_excluded" | "policy_excluded";
  } = {};
  if (Object.hasOwn(raw, "scoreDelta")) {
    effect.scoreDelta = normalizeInteger(raw.scoreDelta, `${ruleKey}.scoreDelta`, -100, 100,
      invalidRuleset);
  }
  if (Object.hasOwn(raw, "confidenceDelta")) {
    effect.confidenceDelta = normalizeFiniteNumber(
      raw.confidenceDelta,
      `${ruleKey}.confidenceDelta`,
      -1,
      1,
      invalidRuleset,
    );
  }
  if (Object.hasOwn(raw, "scoreFloor")) {
    effect.scoreFloor = normalizeInteger(raw.scoreFloor, `${ruleKey}.scoreFloor`, 0, 100,
      invalidRuleset);
  }
  if (Object.hasOwn(raw, "scoreCap")) {
    effect.scoreCap = normalizeInteger(raw.scoreCap, `${ruleKey}.scoreCap`, 0, 100,
      invalidRuleset);
  }
  if (effect.scoreFloor !== undefined && effect.scoreCap !== undefined &&
      effect.scoreFloor > effect.scoreCap) {
    invalidRuleset(`${ruleKey} scoreFloor must not exceed scoreCap`);
  }
  if (Object.hasOwn(raw, "needsReview")) {
    if (typeof raw.needsReview !== "boolean") {
      invalidRuleset(`${ruleKey}.needsReview must be boolean`);
    }
    effect.needsReview = raw.needsReview;
  }
  if (Object.hasOwn(raw, "exclusionReason")) {
    if (raw.exclusionReason !== "user_excluded" && raw.exclusionReason !== "policy_excluded") {
      invalidRuleset(`${ruleKey}.exclusionReason is not allowed`);
    }
    effect.exclusionReason = raw.exclusionReason;
  }
  return effect;
}

function compareRules(left: PriorityRule, right: PriorityRule): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.ruleKey < right.ruleKey ? -1 : left.ruleKey > right.ruleKey ? 1 : 0;
}

export function parsePriorityRuleAst(value: unknown): PriorityRuleAstV1 {
  if (!isPlainObject(value)) invalidRuleset("ruleset must be an object");
  assertExactKeys(
    value,
    ["schemaVersion", "policy", "rules"],
    ["schemaVersion", "policy", "rules"],
    "ruleset",
    invalidRuleset,
  );
  if (value.schemaVersion !== 1) invalidRuleset("ruleset schemaVersion must be 1");
  if (!isPlainObject(value.policy)) invalidRuleset("ruleset.policy must be an object");
  assertExactKeys(
    value.policy,
    [
      "baseScore",
      "baseConfidence",
      "lowConfidenceThreshold",
      "missingCapturedContentPenalty",
      "bands",
    ],
    [
      "baseScore",
      "baseConfidence",
      "lowConfidenceThreshold",
      "missingCapturedContentPenalty",
      "bands",
    ],
    "ruleset.policy",
    invalidRuleset,
  );
  if (!isPlainObject(value.policy.bands)) invalidRuleset("ruleset.policy.bands must be object");
  assertExactKeys(
    value.policy.bands,
    ["mediumMin", "highMin", "criticalMin"],
    ["mediumMin", "highMin", "criticalMin"],
    "ruleset.policy.bands",
    invalidRuleset,
  );
  const baseScore = normalizeInteger(value.policy.baseScore, "baseScore", 0, 100,
    invalidRuleset);
  const baseConfidence = normalizeFiniteNumber(
    value.policy.baseConfidence, "baseConfidence", 0, 1, invalidRuleset,
  );
  const lowConfidenceThreshold = normalizeFiniteNumber(
    value.policy.lowConfidenceThreshold, "lowConfidenceThreshold", 0, 1, invalidRuleset,
  );
  const missingCapturedContentPenalty = normalizeFiniteNumber(
    value.policy.missingCapturedContentPenalty,
    "missingCapturedContentPenalty",
    0,
    1,
    invalidRuleset,
  );
  const mediumMin = normalizeInteger(value.policy.bands.mediumMin, "mediumMin", 1, 100,
    invalidRuleset);
  const highMin = normalizeInteger(value.policy.bands.highMin, "highMin", 1, 100,
    invalidRuleset);
  const criticalMin = normalizeInteger(value.policy.bands.criticalMin, "criticalMin", 1, 100,
    invalidRuleset);
  if (!(mediumMin < highMin && highMin < criticalMin)) {
    invalidRuleset("priority band boundaries must be strictly increasing");
  }
  if (baseScore !== 40 || baseConfidence !== 0.65 || lowConfidenceThreshold !== 0.6 ||
      missingCapturedContentPenalty !== 0.2 || mediumMin !== 25 || highMin !== 60 ||
      criticalMin !== 85) {
    invalidRuleset("PriorityEngine v1 policy constants are fixed");
  }
  if (!Array.isArray(value.rules) || value.rules.length > 100) {
    invalidRuleset("ruleset.rules must contain at most 100 rules");
  }
  const keys = new Set<string>();
  const rules = value.rules.map((raw, index): PriorityRule => {
    if (!isPlainObject(raw)) invalidRuleset(`rules[${index}] must be an object`);
    assertExactKeys(
      raw,
      ["ruleKey", "priority", "label", "appliesTo", "when", "effect"],
      ["ruleKey", "priority", "label", "appliesTo", "when", "effect"],
      `rules[${index}]`,
      invalidRuleset,
    );
    const ruleKey = normalizeBoundedString(raw.ruleKey, `rules[${index}].ruleKey`, 128,
      invalidRuleset);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(ruleKey)) {
      invalidRuleset(`${ruleKey} is not a stable ruleKey`);
    }
    if (keys.has(ruleKey)) invalidRuleset(`duplicate ruleKey ${ruleKey}`);
    keys.add(ruleKey);
    const priority = normalizeInteger(raw.priority, `${ruleKey}.priority`, 0, 1000,
      invalidRuleset);
    const label = normalizeBoundedString(raw.label, `${ruleKey}.label`, 200, invalidRuleset);
    if (raw.appliesTo !== "page" && raw.appliesTo !== "resource" && raw.appliesTo !== "both") {
      invalidRuleset(`${ruleKey}.appliesTo is invalid`);
    }
    const appliesTo = raw.appliesTo;
    if (!isPlainObject(raw.when)) invalidRuleset(`${ruleKey}.when must be an object`);
    assertExactKeys(raw.when, ["all"], ["all"], `${ruleKey}.when`, invalidRuleset);
    if (!Array.isArray(raw.when.all) || raw.when.all.length < 1 || raw.when.all.length > 8) {
      invalidRuleset(`${ruleKey}.when.all must contain 1..8 conditions`);
    }
    const conditions = raw.when.all.map((condition, conditionIndex) =>
      normalizeCondition(condition, appliesTo, ruleKey, conditionIndex));
    conditions.sort((left, right) => {
      const leftKey = canonicalJson(left);
      const rightKey = canonicalJson(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const effect = normalizeEffect(raw.effect, ruleKey);
    const testsMissingContent = conditions.some((condition) =>
      condition.signal === "has_captured_content" &&
      condition.operator === "eq" && condition.value === false);
    if (testsMissingContent) {
      const invalid = effect.scoreDelta !== undefined || effect.scoreFloor !== undefined ||
        effect.scoreCap !== undefined || effect.exclusionReason !== undefined ||
        (effect.confidenceDelta !== undefined && effect.confidenceDelta >= 0) ||
        (effect.needsReview !== undefined && effect.needsReview !== true);
      if (invalid) {
        invalidRuleset(`${ruleKey} cannot lower score or hide review for missing content`);
      }
    }
    return {
      ruleKey,
      priority,
      label,
      appliesTo,
      when: { all: conditions },
      effect,
    };
  }).sort(compareRules);
  const normalized: PriorityRuleAstV1 = {
    schemaVersion: 1,
    policy: {
      baseScore,
      baseConfidence,
      lowConfidenceThreshold,
      missingCapturedContentPenalty,
      bands: { mediumMin, highMin, criticalMin },
    },
    rules,
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > 65_536) {
    invalidRuleset("canonical ruleset exceeds 64 KiB");
  }
  return normalized;
}

export function canonicalPriorityRuleAstJson(value: unknown): string {
  return canonicalJson(parsePriorityRuleAst(value));
}

export const baselinePriorityRuleAstJson = canonicalPriorityRuleAstJson(baselinePriorityRuleAst);
export const baselinePriorityRuleAstHash = sha256(baselinePriorityRuleAstJson);

function normalizeSubject(value: unknown): PrioritySubject {
  if (!isPlainObject(value)) invalidInput("subject must be an object");
  if (value.type === "page") {
    assertExactKeys(value, ["type", "logicalPageId"], ["type", "logicalPageId"], "subject",
      invalidInput);
    return {
      type: "page",
      logicalPageId: normalizeInteger(
        value.logicalPageId, "logicalPageId", 1, Number.MAX_SAFE_INTEGER, invalidInput,
      ),
    };
  }
  if (value.type === "resource") {
    assertExactKeys(value, ["type", "resourceId"], ["type", "resourceId"], "subject",
      invalidInput);
    return {
      type: "resource",
      resourceId: normalizeInteger(
        value.resourceId, "resourceId", 1, Number.MAX_SAFE_INTEGER, invalidInput,
      ),
    };
  }
  invalidInput("subject.type must be page or resource");
}

export const priorityFeatureSetMaximumValues = 10_000;
export const priorityFeatureValueMaximumBytes = 8_192;
export const priorityFeatureAggregateMaximumBytes = 4 * 1024 * 1024;

function normalizeFeatureStringSet(value: unknown, signal: string): readonly string[] {
  if (!Array.isArray(value)) {
    invalidInput(`${signal} must be a string array`);
  }
  const normalized = value.map((entry, index) => normalizeBoundedString(
    entry, `${signal}[${index}]`, priorityFeatureValueMaximumBytes, invalidInput,
  ));
  const unique = [...new Set(normalized)].sort();
  if (unique.length > priorityFeatureSetMaximumValues) {
    invalidInput(`${signal} must contain at most ${priorityFeatureSetMaximumValues} unique values`);
  }
  return unique;
}

function normalizeFeatures(
  value: unknown,
  subjectType: PrioritySubjectType,
): PriorityFeatures {
  if (!isPlainObject(value)) invalidInput("features must be an object");
  const result: Partial<Record<PrioritySignalName, ScalarFeature>> = {};
  for (const [rawSignal, rawValue] of Object.entries(value)) {
    if (!prioritySignalNames.includes(rawSignal as PrioritySignalName)) {
      invalidInput(`features contains unknown signal ${rawSignal}`);
    }
    const signal = rawSignal as PrioritySignalName;
    if (!subjectAllowsSignal(subjectType, signal)) {
      invalidInput(`${signal} is incompatible with ${subjectType}`);
    }
    if (booleanSignals.has(signal)) {
      if (typeof rawValue !== "boolean") invalidInput(`${signal} must be boolean`);
      result[signal] = rawValue;
    } else if (numericSignals.has(signal)) {
      result[signal] = normalizeFiniteNumber(
        rawValue,
        signal,
        0,
        Number.MAX_SAFE_INTEGER,
        invalidInput,
      );
    } else {
      result[signal] = normalizeFeatureStringSet(rawValue, signal);
    }
  }
  const aggregateBytes = Object.values(result).reduce<number>((total, feature) =>
    total + (Array.isArray(feature)
      ? feature.reduce((subtotal, item) => subtotal + Buffer.byteLength(item, "utf8"), 0)
      : 0), 0);
  if (aggregateBytes > priorityFeatureAggregateMaximumBytes) {
    invalidInput(`feature string sets exceed ${priorityFeatureAggregateMaximumBytes} UTF-8 bytes`);
  }
  return result;
}

function normalizeModelProvenance(value: unknown): PriorityModelProvenance {
  if (!isPlainObject(value)) invalidInput("modelProvenance must be an object");
  assertExactKeys(
    value,
    ["provider", "name", "promptVersion"],
    ["provider", "name", "promptVersion"],
    "modelProvenance",
    invalidInput,
  );
  return {
    provider: normalizeBoundedString(value.provider, "modelProvenance.provider", 128, invalidInput),
    name: normalizeBoundedString(value.name, "modelProvenance.name", 128, invalidInput),
    promptVersion: normalizeBoundedString(
      value.promptVersion, "modelProvenance.promptVersion", 128, invalidInput,
    ),
  };
}

function normalizeEligibility(value: unknown): PriorityEligibility {
  if (value === undefined) return { kind: "eligible" };
  if (!isPlainObject(value)) invalidInput("eligibility must be an object");
  if (value.kind === "eligible") {
    assertExactKeys(value, ["kind"], ["kind"], "eligibility", invalidInput);
    return { kind: "eligible" };
  }
  if (value.kind !== "excluded") invalidInput("eligibility.kind is invalid");
  assertExactKeys(value, ["kind", "reason", "detail"], ["kind", "reason"], "eligibility",
    invalidInput);
  if (typeof value.reason !== "string" ||
      !exclusionReasons.has(value.reason as PriorityExclusionReason)) {
    invalidInput("eligibility.reason is invalid");
  }
  let detail: { source: "eligibility" | "url_policy"; code?: string } | undefined;
  if (value.detail !== undefined) {
    if (!isPlainObject(value.detail)) invalidInput("eligibility.detail must be an object");
    assertExactKeys(value.detail, ["source", "code"], ["source"], "eligibility.detail",
      invalidInput);
    if (value.detail.source !== "eligibility" && value.detail.source !== "url_policy") {
      invalidInput("eligibility.detail.source is invalid");
    }
    detail = { source: value.detail.source };
    if (value.detail.code !== undefined) {
      detail.code = normalizeBoundedString(value.detail.code, "eligibility.detail.code", 128,
        invalidInput);
    }
  }
  return {
    kind: "excluded",
    reason: value.reason as PriorityExclusionReason,
    ...(detail === undefined ? {} : { detail }),
  };
}

interface NormalizedAssessmentInput {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly assessmentMethod: "rule" | "model";
  readonly modelProvenance: PriorityModelProvenance | null;
  readonly eligibility: PriorityEligibility;
  readonly featureFingerprint: string;
}

export interface CanonicalPriorityFeatureProjection {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly eligibility: PriorityEligibility;
  readonly featureFingerprint: string;
}

export function canonicalPriorityFeatureProjection(value: {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly eligibility?: PriorityEligibility;
}): CanonicalPriorityFeatureProjection {
  if (!isPlainObject(value)) invalidInput("feature projection must be an object");
  assertExactKeys(
    value,
    ["subject", "features", "eligibility"],
    ["subject", "features"],
    "feature projection",
    invalidInput,
  );
  const subject = normalizeSubject(value.subject);
  const features = normalizeFeatures(value.features, subject.type);
  const eligibility = normalizeEligibility(value.eligibility);
  return {
    subject,
    features,
    eligibility,
    featureFingerprint: sha256(canonicalJson({ subject, features, eligibility })),
  };
}

function normalizeAssessmentInput(value: unknown): NormalizedAssessmentInput {
  if (!isPlainObject(value)) invalidInput("assessment input must be an object");
  assertExactKeys(
    value,
    ["subject", "features", "assessmentMethod", "modelProvenance", "eligibility"],
    ["subject", "features", "assessmentMethod"],
    "assessment input",
    invalidInput,
  );
  const projection = canonicalPriorityFeatureProjection({
    subject: value.subject as PrioritySubject,
    features: value.features as PriorityFeatures,
    ...(Object.hasOwn(value, "eligibility")
      ? { eligibility: value.eligibility as PriorityEligibility }
      : {}),
  });
  const { subject, features, eligibility, featureFingerprint } = projection;
  if (value.assessmentMethod !== "rule" && value.assessmentMethod !== "model") {
    invalidInput("assessmentMethod must be rule or model");
  }
  let modelProvenance: PriorityModelProvenance | null = null;
  if (value.assessmentMethod === "model") {
    modelProvenance = normalizeModelProvenance(value.modelProvenance);
  } else if (Object.hasOwn(value, "modelProvenance") && value.modelProvenance !== undefined) {
    invalidInput("rule assessment must not include modelProvenance");
  }
  return { subject, features, assessmentMethod: value.assessmentMethod,
    modelProvenance, eligibility, featureFingerprint };
}

function subjectKey(subject: PrioritySubject): string {
  return subject.type === "page"
    ? `page:${subject.logicalPageId}`
    : `resource:${subject.resourceId}`;
}

function conditionMatches(condition: PriorityCondition, features: PriorityFeatures): boolean {
  const feature = features[condition.signal];
  if (feature === undefined) return false;
  if (condition.operator === "eq") return feature === condition.value;
  if (condition.operator === "gte") return typeof feature === "number" && feature >= condition.value;
  if (condition.operator === "lte") return typeof feature === "number" && feature <= condition.value;
  const stringCondition = condition as Extract<PriorityCondition, { operator: "in" }>;
  return Array.isArray(feature) &&
    stringCondition.value.some((candidate) => feature.includes(candidate));
}

function appliesToSubject(rule: PriorityRule, subjectType: PrioritySubjectType): boolean {
  return rule.appliesTo === "both" || rule.appliesTo === subjectType;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundConfidence(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function bandForScore(score: number, ast: PriorityRuleAstV1): PriorityBand {
  if (score >= ast.policy.bands.criticalMin) return "critical";
  if (score >= ast.policy.bands.highMin) return "high";
  if (score >= ast.policy.bands.mediumMin) return "medium";
  return "low";
}

interface EvaluationAssessment {
  readonly kind: "assessment";
  readonly agentScore: number;
  readonly agentBand: PriorityBand;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly reasons: readonly PriorityReason[];
  readonly missingSignals: readonly string[];
}

interface EvaluationExclusion {
  readonly kind: "exclusion";
  readonly reason: PriorityExclusionReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

type Evaluation = EvaluationAssessment | EvaluationExclusion;

function evaluate(ast: PriorityRuleAstV1, input: NormalizedAssessmentInput): Evaluation {
  if (input.eligibility.kind === "excluded") {
    return {
      kind: "exclusion",
      reason: input.eligibility.reason,
      detail: input.eligibility.detail ?? {},
    };
  }

  const relevant = ast.rules.filter((rule) => appliesToSubject(rule, input.subject.type));
  const missing = new Set<string>();
  if (input.features.has_captured_content !== true) missing.add("captured_content");
  const matched: PriorityRule[] = [];
  for (const rule of relevant) {
    let matches = true;
    for (const condition of rule.when.all) {
      if (input.features[condition.signal] === undefined) {
        missing.add(condition.signal);
        matches = false;
      } else if (!conditionMatches(condition, input.features)) {
        matches = false;
      }
    }
    if (matches) matched.push(rule);
  }

  const exclusion = matched.find((rule) => rule.effect.exclusionReason !== undefined);
  if (exclusion?.effect.exclusionReason !== undefined) {
    return {
      kind: "exclusion",
      reason: exclusion.effect.exclusionReason,
      detail: {
        source: "rule",
        ruleKey: exclusion.ruleKey,
        label: exclusion.label,
        competingRuleKeys: matched
          .filter((rule) => rule !== exclusion && rule.effect.exclusionReason !== undefined)
          .map((rule) => rule.ruleKey),
      },
    };
  }

  let score = ast.policy.baseScore;
  let confidence = ast.policy.baseConfidence;
  if (missing.has("captured_content")) {
    confidence -= ast.policy.missingCapturedContentPenalty;
  }
  const reasons: PriorityReason[] = matched.map((rule) => ({
    code: `rule:${rule.ruleKey}`,
    kind: "contribution",
    label: rule.label,
    ...(rule.effect.scoreDelta === undefined ? {} : { scoreDelta: rule.effect.scoreDelta }),
    ...(rule.effect.confidenceDelta === undefined
      ? {}
      : { confidenceDelta: rule.effect.confidenceDelta }),
  }));
  for (const rule of matched) {
    score += rule.effect.scoreDelta ?? 0;
    confidence += rule.effect.confidenceDelta ?? 0;
  }

  const floorCandidates = matched.filter((rule) => rule.effect.scoreFloor !== undefined);
  const capCandidates = matched.filter((rule) => rule.effect.scoreCap !== undefined);
  const floor = floorCandidates.reduce<PriorityRule | undefined>((winner, rule) => {
    if (winner === undefined || rule.effect.scoreFloor! > winner.effect.scoreFloor!) return rule;
    return winner;
  }, undefined);
  const cap = capCandidates.reduce<PriorityRule | undefined>((winner, rule) => {
    if (winner === undefined || rule.effect.scoreCap! < winner.effect.scoreCap!) return rule;
    return winner;
  }, undefined);
  let applyFloor = floor;
  let applyCap = cap;
  if (floor !== undefined && cap !== undefined && floor.effect.scoreFloor! > cap.effect.scoreCap!) {
    const floorPrecedes = compareRules(floor, cap) < 0;
    const applied = floorPrecedes ? floor : cap;
    const ignored = floorPrecedes ? cap : floor;
    reasons.push({
      code: `conflict:score-bound:${applied.ruleKey}:${ignored.ruleKey}`,
      kind: "conflict",
      label: `Applied ${applied.ruleKey}; ignored conflicting ${ignored.ruleKey}`,
      appliedRuleKey: applied.ruleKey,
      ignoredRuleKey: ignored.ruleKey,
    });
    if (floorPrecedes) applyCap = undefined;
    else applyFloor = undefined;
  }
  if (applyFloor?.effect.scoreFloor !== undefined) {
    score = Math.max(score, applyFloor.effect.scoreFloor);
  }
  if (applyCap?.effect.scoreCap !== undefined) {
    score = Math.min(score, applyCap.effect.scoreCap);
  }
  score = clamp(score, 0, 100);
  confidence = roundConfidence(clamp(confidence, 0, 1));

  const explicitReviewRule = matched.find((rule) => rule.effect.needsReview !== undefined);
  const lowConfidence = confidence < ast.policy.lowConfidenceThreshold;
  const needsReview = lowConfidence || explicitReviewRule?.effect.needsReview === true;
  if (lowConfidence) {
    reasons.push({
      code: "review:low-confidence",
      kind: "review",
      label: "Confidence is below the active review threshold",
    });
  } else if (explicitReviewRule?.effect.needsReview === true) {
    reasons.push({
      code: `review:explicit:${explicitReviewRule.ruleKey}`,
      kind: "review",
      label: `Review requested by ${explicitReviewRule.ruleKey}`,
      appliedRuleKey: explicitReviewRule.ruleKey,
    });
  }

  return {
    kind: "assessment",
    agentScore: score,
    agentBand: bandForScore(score, ast),
    confidence,
    needsReview,
    reasons,
    missingSignals: [...missing].sort(),
  };
}

/**
 * Pure, read-only evaluation used by the rules preview. It shares the exact
 * validator and evaluator with publication but cannot persist an outcome.
 */
export function previewPriorityRuleEvaluation(
  astValue: unknown,
  inputValue: Omit<PriorityAssessmentInput, "assessmentMethod" | "modelProvenance">,
): Evaluation {
  const ast = parsePriorityRuleAst(astValue);
  const input = normalizeAssessmentInput({
    ...inputValue,
    assessmentMethod: "rule",
  });
  return evaluate(ast, input);
}

interface AssessmentRow {
  id: number;
  subject_id: number;
  agent_score: number;
  agent_band: PriorityBand;
  confidence: number;
  needs_review: number;
  reasons_json: string;
  missing_signals_json: string;
  ruleset_id: number;
  ruleset_version: number;
  feature_fingerprint: string;
  assessment_method: "rule" | "model";
  model_provenance_json: string | null;
  revision: number;
  evaluated_at: string;
  superseded_at: string | null;
}

interface ExclusionRow {
  id: number;
  subject_id: number;
  reason: PriorityExclusionReason;
  detail_json: string;
  ruleset_id: number;
  ruleset_version: number;
  feature_fingerprint: string;
  revision: number;
  evaluated_at: string;
  superseded_at: string | null;
}

interface FeedbackRow {
  id: number;
  subject_id: number;
  assessment_id: number;
  verdict: PriorityFeedbackVerdict;
  note: string | null;
  actor: "user" | "agent";
  method: "manual" | "on_behalf_of_user";
  authorization_ref: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  supersedes_id: number | null;
  superseded_at: string | null;
  revision: number;
  created_at: string;
}

interface SubjectDescriptor {
  readonly type: PrioritySubjectType;
  readonly assessmentTable: "priority_assessments" | "resource_priority_assessments";
  readonly exclusionTable: "priority_exclusions" | "resource_priority_exclusions";
  readonly feedbackTable: "priority_feedback" | "resource_priority_feedback";
  readonly otherFeedbackTable: "priority_feedback" | "resource_priority_feedback";
  readonly subjectColumn: "logical_page_id" | "resource_id";
}

const pageDescriptor: SubjectDescriptor = {
  type: "page",
  assessmentTable: "priority_assessments",
  exclusionTable: "priority_exclusions",
  feedbackTable: "priority_feedback",
  otherFeedbackTable: "resource_priority_feedback",
  subjectColumn: "logical_page_id",
};
const resourceDescriptor: SubjectDescriptor = {
  type: "resource",
  assessmentTable: "resource_priority_assessments",
  exclusionTable: "resource_priority_exclusions",
  feedbackTable: "resource_priority_feedback",
  otherFeedbackTable: "priority_feedback",
  subjectColumn: "resource_id",
};

function descriptorFor(subject: PrioritySubject): SubjectDescriptor {
  return subject.type === "page" ? pageDescriptor : resourceDescriptor;
}

function subjectId(subject: PrioritySubject): number {
  return subject.type === "page" ? subject.logicalPageId : subject.resourceId;
}

function subjectFrom(type: PrioritySubjectType, id: number): PrioritySubject {
  return type === "page" ? { type, logicalPageId: id } : { type, resourceId: id };
}

function storageCorrupt(message: string): never {
  throw new PriorityEngineError("PRIORITY_STORAGE_CORRUPT", message);
}

function parseStoredJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return storageCorrupt(`${context} is not valid JSON`);
  }
}

function storedBoundedText(value: unknown, name: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.trim() !== value ||
      Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return storageCorrupt(`${name} is invalid`);
  }
  return value;
}

function parseStoredReasons(value: string): readonly PriorityReason[] {
  const parsed = parseStoredJson(value, "priority reasons");
  if (!Array.isArray(parsed) || parsed.length > 102) {
    return storageCorrupt("priority reasons must be an array with at most 102 entries");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index): PriorityReason => {
    if (!isPlainObject(entry)) return storageCorrupt(`priority reason ${index} is not an object`);
    assertExactKeys(
      entry,
      ["code", "kind", "label", "scoreDelta", "confidenceDelta", "appliedRuleKey",
        "ignoredRuleKey"],
      ["code", "kind", "label"],
      `priority reason ${index}`,
      storageCorrupt,
    );
    const code = storedBoundedText(entry.code, `priority reason ${index}.code`, 512);
    if (seen.has(code)) return storageCorrupt(`duplicate priority reason code ${code}`);
    seen.add(code);
    if (entry.kind !== "contribution" && entry.kind !== "conflict" && entry.kind !== "review") {
      return storageCorrupt(`priority reason ${index}.kind is invalid`);
    }
    const label = storedBoundedText(entry.label, `priority reason ${index}.label`, 1024);
    const result: {
      code: string;
      kind: "contribution" | "conflict" | "review";
      label: string;
      scoreDelta?: number;
      confidenceDelta?: number;
      appliedRuleKey?: string;
      ignoredRuleKey?: string;
    } = { code, kind: entry.kind, label };
    if (Object.hasOwn(entry, "scoreDelta")) {
      if (!Number.isSafeInteger(entry.scoreDelta) || (entry.scoreDelta as number) < -100 ||
          (entry.scoreDelta as number) > 100) {
        return storageCorrupt(`priority reason ${index}.scoreDelta is invalid`);
      }
      result.scoreDelta = entry.scoreDelta as number;
    }
    if (Object.hasOwn(entry, "confidenceDelta")) {
      if (typeof entry.confidenceDelta !== "number" || !Number.isFinite(entry.confidenceDelta) ||
          entry.confidenceDelta < -1 || entry.confidenceDelta > 1) {
        return storageCorrupt(`priority reason ${index}.confidenceDelta is invalid`);
      }
      result.confidenceDelta = entry.confidenceDelta;
    }
    if (Object.hasOwn(entry, "appliedRuleKey")) {
      const key = storedBoundedText(
        entry.appliedRuleKey, `priority reason ${index}.appliedRuleKey`, 128,
      );
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
        return storageCorrupt(`priority reason ${index}.appliedRuleKey is invalid`);
      }
      result.appliedRuleKey = key;
    }
    if (Object.hasOwn(entry, "ignoredRuleKey")) {
      const key = storedBoundedText(
        entry.ignoredRuleKey, `priority reason ${index}.ignoredRuleKey`, 128,
      );
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
        return storageCorrupt(`priority reason ${index}.ignoredRuleKey is invalid`);
      }
      result.ignoredRuleKey = key;
    }
    const hasScore = result.scoreDelta !== undefined;
    const hasConfidence = result.confidenceDelta !== undefined;
    const hasApplied = result.appliedRuleKey !== undefined;
    const hasIgnored = result.ignoredRuleKey !== undefined;
    if ((result.kind === "contribution" && (hasApplied || hasIgnored)) ||
        (result.kind === "conflict" && (!hasApplied || !hasIgnored || hasScore || hasConfidence)) ||
        (result.kind === "review" && (hasScore || hasConfidence || hasIgnored))) {
      return storageCorrupt(`priority reason ${index} fields do not match its kind`);
    }
    return result;
  });
}

const allowedMissingSignals = new Set<string>(["captured_content", ...prioritySignalNames]);

function parseStoredMissingSignals(value: string): readonly string[] {
  const parsed = parseStoredJson(value, "priority missing signals");
  if (!Array.isArray(parsed) || parsed.length > allowedMissingSignals.size) {
    return storageCorrupt("priority missing signals has invalid cardinality");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "string" || !allowedMissingSignals.has(entry) || seen.has(entry)) {
      return storageCorrupt(`priority missing signal ${index} is invalid or duplicated`);
    }
    seen.add(entry);
    return entry;
  });
}

function mapAssessment(type: PrioritySubjectType, row: AssessmentRow): PriorityOutcome {
  return {
    kind: "assessment",
    assessment: {
      id: row.id,
      subject: subjectFrom(type, row.subject_id),
      agentScore: row.agent_score,
      agentBand: row.agent_band,
      confidence: row.confidence,
      needsReview: row.needs_review === 1,
      reasons: parseStoredReasons(row.reasons_json),
      missingSignals: parseStoredMissingSignals(row.missing_signals_json),
      ruleset: { rulesetId: row.ruleset_id, version: row.ruleset_version },
      featureFingerprint: row.feature_fingerprint,
      assessmentMethod: row.assessment_method,
      modelProvenance: row.model_provenance_json === null
        ? null
        : parseStoredJson(row.model_provenance_json, "priority model provenance") as
          PriorityModelProvenance,
      revision: row.revision,
      evaluatedAt: row.evaluated_at,
      supersededAt: row.superseded_at,
    },
  };
}

function mapExclusion(type: PrioritySubjectType, row: ExclusionRow): PriorityOutcome {
  return {
    kind: "exclusion",
    exclusion: {
      id: row.id,
      subject: subjectFrom(type, row.subject_id),
      reason: row.reason,
      detail: parseStoredJson(row.detail_json, "priority exclusion detail") as
        Record<string, unknown>,
      ruleset: { rulesetId: row.ruleset_id, version: row.ruleset_version },
      featureFingerprint: row.feature_fingerprint,
      revision: row.revision,
      evaluatedAt: row.evaluated_at,
      supersededAt: row.superseded_at,
    },
  };
}

function mapFeedback(type: PrioritySubjectType, row: FeedbackRow): PriorityFeedbackRecord {
  return {
    id: row.id,
    subject: subjectFrom(type, row.subject_id),
    assessmentId: row.assessment_id,
    verdict: row.verdict,
    note: row.note,
    actor: row.actor,
    method: row.method,
    authorizationRef: row.authorization_ref,
    idempotencyKey: row.idempotency_key,
    supersedesId: row.supersedes_id,
    supersededAt: row.superseded_at,
    revision: row.revision,
    createdAt: row.created_at,
  };
}

export interface PriorityEngine {
  assess(
    inputs: readonly PriorityAssessmentInput[],
    ruleset?: PriorityRulesetRef,
  ): readonly PriorityOutcome[];
  explain(subject: PrioritySubject): PriorityOutcome | null;
  explainBatch(subjects: readonly PrioritySubject[]): readonly (PriorityOutcome | null)[];
  recordFeedback(input: PriorityFeedbackInput): PriorityFeedbackRecord;
}

export interface PriorityEngineOptions {
  readonly now?: () => string;
}

export interface ActivePriorityRuleset {
  readonly ref: PriorityRulesetRef;
  readonly ast: PriorityRuleAstV1;
}

export function readPriorityRuleset(
  connection: Database.Database,
  ref?: PriorityRulesetRef,
): ActivePriorityRuleset {
  let normalizedRef: PriorityRulesetRef;
  if (ref === undefined) {
    const active = connection.prepare(`
      SELECT ruleset_id, version FROM priority_ruleset_activations WHERE scope = 'global'
    `).get() as { ruleset_id: number; version: number } | undefined;
    if (active === undefined) {
      throw new PriorityEngineError("INVALID_PRIORITY_RULESET", "No global priority ruleset");
    }
    normalizedRef = { rulesetId: active.ruleset_id, version: active.version };
  } else {
    normalizedRef = {
      rulesetId: normalizeInteger(
        ref.rulesetId, "rulesetId", 1, Number.MAX_SAFE_INTEGER, invalidRuleset,
      ),
      version: normalizeInteger(
        ref.version, "ruleset version", 1, Number.MAX_SAFE_INTEGER, invalidRuleset,
      ),
    };
  }
  const row = connection.prepare(`
    SELECT rule_ast_json FROM priority_rule_versions
    WHERE ruleset_id = ? AND version = ?
  `).get(normalizedRef.rulesetId, normalizedRef.version) as
    { rule_ast_json: string } | undefined;
  if (row === undefined) {
    throw new PriorityEngineError("INVALID_PRIORITY_RULESET", "Priority ruleset not found");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rule_ast_json);
  } catch {
    invalidRuleset("Stored priority ruleset is not JSON");
  }
  return { ref: normalizedRef, ast: parsePriorityRuleAst(parsed) };
}

export function readActivePriorityRuleset(
  connection: Database.Database,
): ActivePriorityRuleset {
  return readPriorityRuleset(connection);
}

export function createPriorityEngine(
  connection: Database.Database,
  options: PriorityEngineOptions = {},
): PriorityEngine {
  const now = options.now ?? (() => new Date().toISOString());

  function currentOutcome(subject: PrioritySubject): PriorityOutcome | null {
    const descriptor = descriptorFor(subject);
    const id = subjectId(subject);
    const assessment = connection.prepare(`
      SELECT *, ${descriptor.subjectColumn} AS subject_id
      FROM ${descriptor.assessmentTable}
      WHERE ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
    `).get(id) as AssessmentRow | undefined;
    const exclusion = connection.prepare(`
      SELECT *, ${descriptor.subjectColumn} AS subject_id
      FROM ${descriptor.exclusionTable}
      WHERE ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
    `).get(id) as ExclusionRow | undefined;
    if (assessment !== undefined && exclusion !== undefined) {
      throw new PriorityEngineError(
        "PRIORITY_STORAGE_CORRUPT", `Corrupt priority XOR for ${subjectKey(subject)}`,
      );
    }
    if (assessment !== undefined) return mapAssessment(subject.type, assessment);
    if (exclusion !== undefined) return mapExclusion(subject.type, exclusion);
    return null;
  }

  function explainBatch(values: readonly PrioritySubject[]): readonly (PriorityOutcome | null)[] {
    if (!Array.isArray(values) || values.length > 100) {
      throw new PriorityEngineError("PRIORITY_BATCH_TOO_LARGE", "Priority batch limit is 100");
    }
    const subjects = values.map(normalizeSubject);
    const outcomes = new Map<string, PriorityOutcome>();
    for (const type of ["page", "resource"] as const) {
      const typed = subjects.filter((subject) => subject.type === type);
      const ids = [...new Set(typed.map((subject) => subjectId(subject)))];
      if (ids.length === 0) continue;
      const descriptor = descriptorFor(typed[0]!);
      const placeholders = ids.map(() => "?").join(",");
      const assessments = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.assessmentTable}
        WHERE ${descriptor.subjectColumn} IN (${placeholders}) AND superseded_at IS NULL
      `).all(...ids) as AssessmentRow[];
      const exclusions = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.exclusionTable}
        WHERE ${descriptor.subjectColumn} IN (${placeholders}) AND superseded_at IS NULL
      `).all(...ids) as ExclusionRow[];
      for (const row of assessments) {
        const subject: PrioritySubject = type === "page"
          ? { type, logicalPageId: row.subject_id }
          : { type, resourceId: row.subject_id };
        outcomes.set(subjectKey(subject), mapAssessment(type, row));
      }
      for (const row of exclusions) {
        const subject: PrioritySubject = type === "page"
          ? { type, logicalPageId: row.subject_id }
          : { type, resourceId: row.subject_id };
        const key = subjectKey(subject);
        if (outcomes.has(key)) throw new PriorityEngineError(
          "PRIORITY_STORAGE_CORRUPT", `Corrupt priority XOR for ${key}`,
        );
        outcomes.set(key, mapExclusion(type, row));
      }
    }
    return subjects.map((subject) => outcomes.get(subjectKey(subject)) ?? null);
  }

  function assertSubjectExists(subject: PrioritySubject): void {
    if (subject.type === "page") {
      if (connection.prepare("SELECT 1 FROM logical_pages WHERE id = ?")
        .get(subject.logicalPageId) === undefined) {
        throw new PriorityEngineError(
          "PRIORITY_SUBJECT_NOT_FOUND", `Logical page ${subject.logicalPageId} not found`,
        );
      }
      return;
    }
    if (connection.prepare("SELECT 1 FROM resources WHERE id = ?").get(subject.resourceId) ===
        undefined) {
      throw new PriorityEngineError(
        "PRIORITY_SUBJECT_NOT_FOUND", `Resource ${subject.resourceId} not found`,
      );
    }
    if (connection.prepare(`
      SELECT 1
      FROM resource_heads AS heads
      JOIN resource_events AS events
        ON events.id = heads.event_id AND events.resource_id = heads.resource_id
      WHERE heads.resource_id = ? AND events.lifecycle_state = 'active'
    `).get(subject.resourceId) === undefined) {
      throw new PriorityEngineError(
        "PRIORITY_RESOURCE_NOT_ACTIVE", `Resource ${subject.resourceId} is not currently active`,
      );
    }
  }

  function outcomeMatches(
    outcome: PriorityOutcome,
    input: NormalizedAssessmentInput,
    ref: PriorityRulesetRef,
  ): boolean {
    const value = outcome.kind === "assessment" ? outcome.assessment : outcome.exclusion;
    if (value.featureFingerprint !== input.featureFingerprint ||
        value.ruleset.rulesetId !== ref.rulesetId || value.ruleset.version !== ref.version) {
      return false;
    }
    if (outcome.kind === "exclusion") return true;
    return outcome.assessment.assessmentMethod === input.assessmentMethod &&
      canonicalJson(outcome.assessment.modelProvenance) === canonicalJson(input.modelProvenance);
  }

  function persistOne(
    input: NormalizedAssessmentInput,
    evaluation: Evaluation,
    ref: PriorityRulesetRef,
    timestamp: string,
  ): PriorityOutcome {
    assertSubjectExists(input.subject);
    const existing = currentOutcome(input.subject);
    if (existing !== null && outcomeMatches(existing, input, ref)) return existing;
    const existingValue = existing?.kind === "assessment" ? existing.assessment : existing?.exclusion;
    if (existingValue !== undefined && timestamp < existingValue.evaluatedAt) {
      throw new PriorityEngineError(
        "PRIORITY_CLOCK_REGRESSION", `Clock regressed for ${subjectKey(input.subject)}`,
      );
    }
    const descriptor = descriptorFor(input.subject);
    const id = subjectId(input.subject);
    const revision = Number(connection.prepare(`
      SELECT 1 + MAX(latest) FROM (
        SELECT COALESCE(MAX(revision), 0) AS latest FROM ${descriptor.assessmentTable}
          WHERE ${descriptor.subjectColumn} = ?
        UNION ALL
        SELECT COALESCE(MAX(revision), 0) AS latest FROM ${descriptor.exclusionTable}
          WHERE ${descriptor.subjectColumn} = ?
      )
    `).pluck().get(id, id));
    connection.prepare(`
      UPDATE ${descriptor.assessmentTable} SET superseded_at = ?
      WHERE ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
    `).run(timestamp, id);
    connection.prepare(`
      UPDATE ${descriptor.exclusionTable} SET superseded_at = ?
      WHERE ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
    `).run(timestamp, id);

    if (evaluation.kind === "assessment") {
      const inserted = connection.prepare(`
        INSERT INTO ${descriptor.assessmentTable} (
          ${descriptor.subjectColumn}, agent_score, agent_band, confidence, needs_review,
          reasons_json, missing_signals_json, ruleset_id, ruleset_version,
          feature_fingerprint, assessment_method, model_provenance_json,
          revision, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        evaluation.agentScore,
        evaluation.agentBand,
        evaluation.confidence,
        evaluation.needsReview ? 1 : 0,
        canonicalJson(evaluation.reasons),
        canonicalJson(evaluation.missingSignals),
        ref.rulesetId,
        ref.version,
        input.featureFingerprint,
        input.assessmentMethod,
        input.modelProvenance === null ? null : canonicalJson(input.modelProvenance),
        revision,
        timestamp,
      );
      const row = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.assessmentTable} WHERE id = ?
      `).get(inserted.lastInsertRowid) as AssessmentRow;
      return mapAssessment(input.subject.type, row);
    }
    const inserted = connection.prepare(`
      INSERT INTO ${descriptor.exclusionTable} (
        ${descriptor.subjectColumn}, reason, detail_json, ruleset_id, ruleset_version,
        feature_fingerprint, revision, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      evaluation.reason,
      canonicalJson(evaluation.detail),
      ref.rulesetId,
      ref.version,
      input.featureFingerprint,
      revision,
      timestamp,
    );
    const row = connection.prepare(`
      SELECT *, ${descriptor.subjectColumn} AS subject_id
      FROM ${descriptor.exclusionTable} WHERE id = ?
    `).get(inserted.lastInsertRowid) as ExclusionRow;
    return mapExclusion(input.subject.type, row);
  }

  function assess(
    values: readonly PriorityAssessmentInput[],
    ref?: PriorityRulesetRef,
  ): readonly PriorityOutcome[] {
    if (!Array.isArray(values)) invalidInput("assess input must be an array");
    if (values.length > 100) {
      throw new PriorityEngineError("PRIORITY_BATCH_TOO_LARGE", "Priority batch limit is 100");
    }
    const normalized = values.map(normalizeAssessmentInput);
    const seen = new Set<string>();
    for (const input of normalized) {
      const key = subjectKey(input.subject);
      if (seen.has(key)) {
        throw new PriorityEngineError("PRIORITY_DUPLICATE_SUBJECT", `Duplicate subject ${key}`);
      }
      seen.add(key);
    }
    const ruleset = readPriorityRuleset(connection, ref);
    const evaluations = normalized.map((input) => evaluate(ruleset.ast, input));
    const operation = connection.transaction(() => {
      const timestamp = now();
      if (timestamp !== new Date(timestamp).toISOString()) {
        invalidInput("Priority clock must return canonical ISO timestamp");
      }
      return normalized.map((input, index) =>
        persistOne(input, evaluations[index]!, ruleset.ref, timestamp));
    });
    return operation.immediate();
  }

  function normalizeFeedbackInput(value: unknown): {
    subject: PrioritySubject;
    assessmentId: number;
    verdict: PriorityFeedbackVerdict;
    note: string | null;
    actor: "user" | "agent";
    method: "manual" | "on_behalf_of_user";
    authorizationRef: string | null;
    idempotencyKey: string;
    supersedesId: number | undefined;
    requestFingerprint: string;
  } {
    if (!isPlainObject(value)) invalidInput("feedback input must be an object");
    assertExactKeys(
      value,
      ["subject", "assessmentId", "verdict", "note", "provenance", "idempotencyKey",
        "supersedesId"],
      ["subject", "assessmentId", "verdict", "provenance", "idempotencyKey"],
      "feedback input",
      invalidInput,
    );
    const subject = normalizeSubject(value.subject);
    const assessmentId = normalizeInteger(
      value.assessmentId, "assessmentId", 1, Number.MAX_SAFE_INTEGER, invalidInput,
    );
    if (value.verdict !== "accept" && value.verdict !== "reject" &&
        value.verdict !== "too_high" && value.verdict !== "too_low") {
      invalidInput("feedback verdict is invalid");
    }
    const note = value.note === undefined
      ? null
      : normalizeBoundedString(value.note, "feedback note", 4096, invalidInput);
    if (!isPlainObject(value.provenance)) invalidInput("feedback provenance must be object");
    let actor: "user" | "agent";
    let method: "manual" | "on_behalf_of_user";
    let authorizationRef: string | null;
    if (value.provenance.actor === "user") {
      assertExactKeys(value.provenance, ["actor", "method"], ["actor", "method"],
        "feedback provenance", invalidInput);
      if (value.provenance.method !== "manual") {
        invalidInput("user feedback must be manual");
      }
      actor = "user";
      method = "manual";
      authorizationRef = null;
    } else if (value.provenance.actor === "agent") {
      assertExactKeys(
        value.provenance,
        ["actor", "method", "authorizationRef"],
        ["actor", "method", "authorizationRef"],
        "feedback provenance",
        invalidInput,
      );
      if (value.provenance.method !== "on_behalf_of_user") {
        invalidInput("agent feedback must be on_behalf_of_user");
      }
      actor = "agent";
      method = "on_behalf_of_user";
      authorizationRef = normalizeBoundedString(
        value.provenance.authorizationRef, "authorizationRef", 256, invalidInput,
      );
    } else {
      invalidInput("feedback actor is invalid");
    }
    const idempotencyKey = normalizeBoundedString(
      value.idempotencyKey, "idempotencyKey", 200, invalidInput,
    );
    const supersedesId = value.supersedesId === undefined
      ? undefined
      : normalizeInteger(value.supersedesId, "supersedesId", 1, Number.MAX_SAFE_INTEGER,
        invalidInput);
    const canonicalPayload = {
      subject,
      assessmentId,
      verdict: value.verdict,
      note,
      actor,
      method,
      authorizationRef,
      supersedesId: supersedesId ?? null,
    };
    return {
      subject,
      assessmentId,
      verdict: value.verdict,
      note,
      actor,
      method,
      authorizationRef,
      idempotencyKey,
      supersedesId,
      requestFingerprint: sha256(canonicalJson(canonicalPayload)),
    };
  }

  function recordFeedback(value: PriorityFeedbackInput): PriorityFeedbackRecord {
    const input = normalizeFeedbackInput(value);
    const descriptor = descriptorFor(input.subject);
    const id = subjectId(input.subject);
    const operation = connection.transaction(() => {
      const existingSame = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.feedbackTable} WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as FeedbackRow | undefined;
      if (existingSame !== undefined) {
        if (existingSame.request_fingerprint !== input.requestFingerprint) {
          throw new PriorityEngineError(
            "IDEMPOTENCY_KEY_CONFLICT", "Feedback idempotency key payload changed",
          );
        }
        return mapFeedback(input.subject.type, existingSame);
      }
      if (connection.prepare(`
        SELECT 1 FROM ${descriptor.otherFeedbackTable} WHERE idempotency_key = ?
      `).get(input.idempotencyKey) !== undefined) {
        throw new PriorityEngineError(
          "IDEMPOTENCY_KEY_CONFLICT", "Feedback idempotency key changed subject type",
        );
      }
      const assessment = connection.prepare(`
        SELECT id, evaluated_at FROM ${descriptor.assessmentTable}
        WHERE id = ? AND ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
      `).get(input.assessmentId, id) as { id: number; evaluated_at: string } | undefined;
      if (assessment === undefined) {
        throw new PriorityEngineError(
          "PRIORITY_FEEDBACK_ASSESSMENT_NOT_CURRENT",
          "Feedback must reference the current same-subject assessment",
        );
      }
      const current = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.feedbackTable}
        WHERE ${descriptor.subjectColumn} = ? AND superseded_at IS NULL
      `).get(id) as FeedbackRow | undefined;
      if (input.supersedesId !== undefined && input.supersedesId !== current?.id) {
        throw new PriorityEngineError(
          "PRIORITY_FEEDBACK_SUPERSESSION_CONFLICT",
          "Feedback must supersede the direct current predecessor",
        );
      }
      const timestamp = now();
      if (timestamp !== new Date(timestamp).toISOString() || timestamp < assessment.evaluated_at ||
          (current !== undefined && timestamp < current.created_at)) {
        throw new PriorityEngineError(
          "PRIORITY_CLOCK_REGRESSION", "Feedback clock regressed",
        );
      }
      if (current !== undefined) {
        connection.prepare(`
          UPDATE ${descriptor.feedbackTable} SET superseded_at = ? WHERE id = ?
        `).run(timestamp, current.id);
      }
      const revision = (current?.revision ?? 0) + 1;
      const inserted = connection.prepare(`
        INSERT INTO ${descriptor.feedbackTable} (
          ${descriptor.subjectColumn}, assessment_id, verdict, note, actor, method,
          authorization_ref, idempotency_key, request_fingerprint, supersedes_id,
          revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.assessmentId,
        input.verdict,
        input.note,
        input.actor,
        input.method,
        input.authorizationRef,
        input.idempotencyKey,
        input.requestFingerprint,
        current?.id ?? null,
        revision,
        timestamp,
      );
      const row = connection.prepare(`
        SELECT *, ${descriptor.subjectColumn} AS subject_id
        FROM ${descriptor.feedbackTable} WHERE id = ?
      `).get(inserted.lastInsertRowid) as FeedbackRow;
      return mapFeedback(input.subject.type, row);
    });
    return operation.immediate();
  }

  return {
    assess,
    explain: (subject) => currentOutcome(normalizeSubject(subject)),
    explainBatch,
    recordFeedback,
  };
}
