import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  canonicalJsonV1 as canonicalJson,
  personalPriorityDraftSchema,
  personalPriorityLifecycleRequestSchema,
  personalPriorityRuleSchema,
  type PersonalPriorityDraft,
  type PersonalPriorityLifecycleRequest,
  type PersonalPriorityRule,
  type PersonalPriorityRuleErrorCode,
  type PriorityRulesetRefContract,
} from "@tabhub/shared";
import type Database from "better-sqlite3";

import {
  compilePriorityRuleNaturalLanguageV1,
  PriorityRuleLanguageError,
  renderPriorityRulesReadable,
} from "./priority-rule-compiler.js";
import {
  baselinePriorityRuleAst,
  baselinePriorityRuleAstHash,
  canonicalPriorityRuleAstJson,
  parsePriorityRuleAst,
  previewPriorityRuleEvaluation,
  readPriorityRuleset,
  type PriorityRuleAstV1,
  type PrioritySubject,
} from "./priority-engine.js";
import {
  createPriorityFeatureCatalog,
  type PriorityFeatureCatalog,
  type PriorityFeatureProjectionRead,
} from "./priority-feature-catalog.js";

export const personalPriorityRulesetName = "Personal priority rules" as const;
export const baselinePriorityRulesetRef = Object.freeze({ rulesetId: 1, version: 1 });
const maximumPersonalRules = 92;
const maximumPreviewSubjects = 10_000;
const previewBatchSize = 100;
const maximumPreviewWallMs = 60_000;

export class PersonalPriorityRulesError extends Error {
  constructor(
    readonly code: PersonalPriorityRuleErrorCode,
    message: string,
    readonly span?: { readonly start: number; readonly end: number },
  ) {
    super(message);
    this.name = "PersonalPriorityRulesError";
  }
}

interface VersionRow {
  ruleset_id: number;
  version: number;
  rule_ast_json: string;
  natural_language_source: string | null;
  created_by: "user" | "agent";
  created_at: string;
}

interface RulesetRow { id: number }
interface ActiveRow { ruleset_id: number; version: number }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function personalPriorityRequestFingerprint(
  request: object,
): string {
  return sha256(canonicalJson(request));
}

function refsEqual(
  left: PriorityRulesetRefContract,
  right: PriorityRulesetRefContract,
): boolean {
  return left.rulesetId === right.rulesetId && left.version === right.version;
}

function ruleMap(ast: PriorityRuleAstV1): Map<string, PersonalPriorityRule> {
  return new Map(ast.rules.filter((rule) => rule.ruleKey.startsWith("personal."))
    .map((rule) => [rule.ruleKey, personalPriorityRuleSchema.parse(rule)]));
}

function additionsFromAst(ast: PriorityRuleAstV1): readonly PersonalPriorityRule[] {
  return [...ruleMap(ast).values()];
}

function materialize(additionsValue: unknown): {
  ast: PriorityRuleAstV1;
  astJson: string;
  astHash: string;
  additions: readonly PersonalPriorityRule[];
} {
  if (!Array.isArray(additionsValue) || additionsValue.length > maximumPersonalRules) {
    throw new PersonalPriorityRulesError(
      "INVALID_PRIORITY_RULESET",
      `Personal priority rules must contain at most ${maximumPersonalRules} additions`,
    );
  }
  let ast: PriorityRuleAstV1;
  try {
    ast = parsePriorityRuleAst({
      ...baselinePriorityRuleAst,
      rules: [...baselinePriorityRuleAst.rules, ...additionsValue],
    });
  } catch (error) {
    throw new PersonalPriorityRulesError(
      "INVALID_PRIORITY_RULESET",
      error instanceof Error ? error.message : "Invalid personal priority rules",
    );
  }
  const additions = additionsFromAst(ast);
  if (additions.length !== additionsValue.length || ast.rules.length !== 8 + additions.length) {
    throw new PersonalPriorityRulesError(
      "INVALID_PRIORITY_RULESET",
      "Personal rules must use unique personal.* keys and cannot replace baseline rules",
    );
  }
  const astJson = canonicalPriorityRuleAstJson(ast);
  return { ast, astJson, astHash: sha256(astJson), additions };
}

export interface PreparedPersonalPriorityDraft {
  readonly compiler:
    | {
      readonly kind: "structured";
      readonly compilerVersion: null;
      readonly sourceSpans: readonly [];
      readonly readableRules: ReturnType<typeof renderPriorityRulesReadable>;
    }
    | {
      readonly kind: "natural_language";
      readonly compilerVersion: string;
      readonly sourceSpans: ReturnType<typeof compilePriorityRuleNaturalLanguageV1>["sourceSpans"];
      readonly readableRules: ReturnType<typeof renderPriorityRulesReadable>;
    };
  readonly naturalLanguageSource: string | null;
  readonly ast: PriorityRuleAstV1;
  readonly astJson: string;
  readonly astHash: string;
  readonly additions: readonly PersonalPriorityRule[];
}

export function preparePersonalPriorityDraft(value: unknown): PreparedPersonalPriorityDraft {
  const draft = personalPriorityDraftSchema.parse(value);
  if (draft.kind === "structured") {
    const candidate = materialize(draft.additions);
    return {
      compiler: {
        kind: "structured",
        compilerVersion: null,
        sourceSpans: [],
        readableRules: renderPriorityRulesReadable(candidate.additions),
      },
      naturalLanguageSource: null,
      ...candidate,
    };
  }
  try {
    const compiled = compilePriorityRuleNaturalLanguageV1(draft);
    const candidate = materialize(compiled.additions);
    return {
      compiler: {
        kind: "natural_language",
        compilerVersion: compiled.compilerVersion,
        sourceSpans: compiled.sourceSpans,
        readableRules: renderPriorityRulesReadable(candidate.additions),
      },
      naturalLanguageSource: draft.source,
      ...candidate,
    };
  } catch (error) {
    if (error instanceof PriorityRuleLanguageError) {
      throw new PersonalPriorityRulesError(error.code, error.message, error.span);
    }
    if (error instanceof PersonalPriorityRulesError &&
        error.code === "INVALID_PRIORITY_RULESET") {
      throw new PersonalPriorityRulesError(
        "PRIORITY_RULE_LANGUAGE_UNSUPPORTED",
        error.message,
        { start: 0, end: draft.source.length },
      );
    }
    throw error;
  }
}

type PreviewEvaluation = ReturnType<typeof previewPriorityRuleEvaluation>;
type PreviewStratum = "exclusion_changed" | "band_changed" |
  "assessment_changed" | "unchanged";

function outcomeJson(value: PreviewEvaluation): string {
  return canonicalJson(value);
}

function previewStratum(before: PreviewEvaluation, after: PreviewEvaluation): PreviewStratum {
  if (before.kind !== after.kind ||
      (before.kind === "exclusion" && after.kind === "exclusion" &&
        outcomeJson(before) !== outcomeJson(after))) return "exclusion_changed";
  if (before.kind === "assessment" && after.kind === "assessment" &&
      before.agentBand !== after.agentBand) return "band_changed";
  if (before.kind === "assessment" && after.kind === "assessment" && (
    before.agentScore !== after.agentScore ||
    before.confidence !== after.confidence ||
    before.needsReview !== after.needsReview
  )) return "assessment_changed";
  return "unchanged";
}

function diffRules(active: PriorityRuleAstV1, candidate: PriorityRuleAstV1) {
  const before = ruleMap(active);
  const after = ruleMap(candidate);
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed = [...after.keys()].filter((key) => before.has(key) &&
    canonicalJson(before.get(key)) !== canonicalJson(after.get(key))).sort();
  return { added, changed, removed };
}

function evaluationFor(ast: PriorityRuleAstV1, value: PriorityFeatureProjectionRead) {
  return previewPriorityRuleEvaluation(ast, {
    subject: value.subject,
    features: value.features,
    eligibility: value.eligibility,
  });
}

function staleOutcomeCount(connection: Database.Database, ref: PriorityRulesetRefContract): number {
  return Number(connection.prepare(`
    SELECT COUNT(*) FROM (
      SELECT ruleset_id,ruleset_version FROM priority_assessments
        WHERE superseded_at IS NULL
      UNION ALL SELECT ruleset_id,ruleset_version FROM priority_exclusions
        WHERE superseded_at IS NULL
      UNION ALL SELECT ruleset_id,ruleset_version FROM resource_priority_assessments
        WHERE superseded_at IS NULL
      UNION ALL SELECT ruleset_id,ruleset_version FROM resource_priority_exclusions
        WHERE superseded_at IS NULL
    ) WHERE ruleset_id <> ? OR ruleset_version <> ?
  `).pluck().get(ref.rulesetId, ref.version));
}

function dirtyOutcomeCount(connection: Database.Database, ref: PriorityRulesetRefContract): number {
  return Number(connection.prepare(`
    WITH denominator(type,id) AS (
      SELECT 'page',id FROM logical_pages
      UNION ALL
      SELECT 'resource',resources.id FROM resources
      JOIN resource_heads AS heads ON heads.resource_id=resources.id
      JOIN resource_events AS events ON events.id=heads.event_id
        AND events.resource_id=heads.resource_id
      WHERE events.lifecycle_state='active'
    ), outcomes(type,id,ruleset_id,ruleset_version) AS (
      SELECT 'page',logical_page_id,ruleset_id,ruleset_version
        FROM priority_assessments WHERE superseded_at IS NULL
      UNION ALL SELECT 'page',logical_page_id,ruleset_id,ruleset_version
        FROM priority_exclusions WHERE superseded_at IS NULL
      UNION ALL SELECT 'resource',resource_id,ruleset_id,ruleset_version
        FROM resource_priority_assessments WHERE superseded_at IS NULL
      UNION ALL SELECT 'resource',resource_id,ruleset_id,ruleset_version
        FROM resource_priority_exclusions WHERE superseded_at IS NULL
    ) SELECT COUNT(*) FROM denominator
    LEFT JOIN outcomes ON outcomes.type=denominator.type AND outcomes.id=denominator.id
    WHERE outcomes.id IS NULL OR outcomes.ruleset_id<>? OR outcomes.ruleset_version<>?
  `).pluck().get(ref.rulesetId, ref.version));
}

function canonicalTimestamp(now: () => string): string {
  const value = now();
  if (new Date(value).toISOString() !== value) {
    throw new PersonalPriorityRulesError(
      "PRIORITY_RULESET_CONFLICT",
      "Priority rules clock must return a canonical timestamp",
    );
  }
  return value;
}

export function createPersonalPriorityRulesCatalog(
  connection: Database.Database,
  options: {
    readonly now?: () => string;
    readonly featureCatalog?: Pick<
      PriorityFeatureCatalog,
      "listSubjectPage" | "previewBatch" | "readBatch"
    >;
    readonly writerEnabled?: boolean;
  },
) {
  const now = options.now ?? (() => new Date().toISOString());
  const features = options.featureCatalog ?? createPriorityFeatureCatalog(connection);
  const writerEnabled = options.writerEnabled === true;

  function assertBaseline(): void {
    const baseline = readPriorityRuleset(connection, baselinePriorityRulesetRef);
    if (canonicalPriorityRuleAstJson(baseline.ast) !== canonicalPriorityRuleAstJson(
      baselinePriorityRuleAst,
    ) || baselinePriorityRuleAstHash !== sha256(canonicalPriorityRuleAstJson(baseline.ast))) {
      throw new PersonalPriorityRulesError(
        "INVALID_PRIORITY_RULESET",
        "The immutable baseline priority ruleset does not match 1/1",
      );
    }
  }

  function activeRef(): PriorityRulesetRefContract {
    const row = connection.prepare(`SELECT ruleset_id,version
      FROM priority_ruleset_activations WHERE scope='global'`).get() as ActiveRow | undefined;
    if (row === undefined) throw new PersonalPriorityRulesError(
      "PRIORITY_RULESET_NOT_FOUND", "The global priority ruleset is missing",
    );
    return { rulesetId: row.ruleset_id, version: row.version };
  }

  function personalRuleset(): RulesetRow | undefined {
    return connection.prepare("SELECT id FROM priority_rulesets WHERE name=?")
      .get(personalPriorityRulesetName) as RulesetRow | undefined;
  }

  function hasDirtyOutcome(ref: PriorityRulesetRefContract): boolean {
    // The cheap relational check covers missing outcomes and ruleset-pointer
    // changes. When those match, C50 currentness still requires the canonical
    // feature fingerprint to match, so finish with the same read seam used by
    // normal priority reads instead of trying to duplicate feature SQL here.
    if (dirtyOutcomeCount(connection, ref) > 0) return true;
    const anchor = canonicalTimestamp(now);
    let after: PrioritySubject | undefined;
    while (true) {
      const page = features.listSubjectPage({
        ...(after === undefined ? {} : { after }),
        limit: previewBatchSize,
      });
      if (page.items.length > 0 && features.readBatch(page.items, anchor)
        .some((item) => item.dirty)) return true;
      if (page.nextAfter === null) return false;
      after = page.nextAfter;
    }
  }

  function versions(rulesetId: number): VersionRow[] {
    return connection.prepare(`SELECT ruleset_id,version,rule_ast_json,
      natural_language_source,created_by,created_at FROM priority_rule_versions
      WHERE ruleset_id=? ORDER BY version DESC LIMIT 1000`).all(rulesetId) as VersionRow[];
  }

  function versionCount(rulesetId: number): number {
    return Number(connection.prepare(`SELECT COUNT(*) FROM priority_rule_versions
      WHERE ruleset_id=?`).pluck().get(rulesetId));
  }

  function mapVersion(row: VersionRow, active: PriorityRulesetRefContract) {
    const ast = parsePriorityRuleAst(JSON.parse(row.rule_ast_json) as unknown);
    return {
      ref: { rulesetId: row.ruleset_id, version: row.version },
      createdBy: row.created_by,
      createdAt: row.created_at,
      naturalLanguageSource: row.natural_language_source,
      astHash: sha256(canonicalPriorityRuleAstJson(ast)),
      additions: additionsFromAst(ast),
      active: active.rulesetId === row.ruleset_id && active.version === row.version,
    };
  }

  function read() {
    assertBaseline();
    const active = activeRef();
    const personal = personalRuleset();
    const rows = personal === undefined ? [] : versions(personal.id);
    const count = personal === undefined ? 0 : versionCount(personal.id);
    const stale = staleOutcomeCount(connection, active);
    const dirty = hasDirtyOutcome(active);
    return {
      name: personalPriorityRulesetName,
      baselineRef: baselinePriorityRulesetRef,
      activeRef: active,
      latestVersion: rows[0]?.version ?? null,
      versions: rows.map((row) => mapVersion(row, active)),
      versionCount: count,
      historyTruncated: count > rows.length,
      recomputeRequired: dirty,
      staleOutcomeCount: stale,
    };
  }

  function preview(draftValue: PersonalPriorityDraft) {
    assertBaseline();
    const started = performance.now();
    const anchor = canonicalTimestamp(now);
    const candidate = preparePersonalPriorityDraft(draftValue);
    const comparedActive = readPriorityRuleset(connection);
    const active = comparedActive.ast;
    const examples: Array<{
      logicalPageId: number;
      stratum: PreviewStratum;
      before: PreviewEvaluation;
      after: PreviewEvaluation;
    }> = [];
    let after: { type: "page"; logicalPageId: number } | undefined;
    let scannedCount = 0;
    let pageCorpusExhausted = false;
    while (scannedCount < maximumPreviewSubjects) {
      if (performance.now() - started > maximumPreviewWallMs) {
        throw new PersonalPriorityRulesError(
          "PRIORITY_RULE_PREVIEW_TIMEOUT", "Priority rules preview exceeded 60 seconds",
        );
      }
      const page = features.listSubjectPage({
        ...(after === undefined ? {} : { after }),
        limit: Math.min(previewBatchSize, maximumPreviewSubjects - scannedCount),
      });
      const pages = page.items.filter((subject) => subject.type === "page");
      if (pages.length === 0) break;
      const projected = features.previewBatch(pages, anchor);
      if (performance.now() - started > maximumPreviewWallMs) {
        throw new PersonalPriorityRulesError(
          "PRIORITY_RULE_PREVIEW_TIMEOUT", "Priority rules preview exceeded 60 seconds",
        );
      }
      for (const item of projected) {
        if (item.subject.type !== "page") continue;
        const before = evaluationFor(active, item);
        const candidateOutcome = evaluationFor(candidate.ast, item);
        examples.push({
          logicalPageId: item.subject.logicalPageId,
          stratum: previewStratum(before, candidateOutcome),
          before,
          after: candidateOutcome,
        });
      }
      scannedCount += pages.length;
      if (page.nextAfter === null || page.nextAfter.type === "resource") {
        pageCorpusExhausted = true;
        break;
      }
      after = page.nextAfter;
    }
    if (scannedCount === maximumPreviewSubjects && !pageCorpusExhausted &&
        after !== undefined) {
      const probe = features.listSubjectPage({ after: after!, limit: 1 });
      if (probe.items[0]?.type === "page") throw new PersonalPriorityRulesError(
        "PRIORITY_RULE_PREVIEW_LIMIT", "Priority rules preview exceeds 10,000 pages",
      );
    }
    const rank = (item: typeof examples[number]) =>
      sha256(`${candidate.astHash}${item.logicalPageId}`);
    const sorted = [...examples].sort((left, right) => {
      const leftHash = rank(left);
      const rightHash = rank(right);
      return leftHash < rightHash ? -1 : leftHash > rightHash ? 1
        : left.logicalPageId - right.logicalPageId;
    });
    const selected: typeof examples = [];
    for (const stratum of [
      "exclusion_changed", "band_changed", "assessment_changed", "unchanged",
    ] as const) {
      selected.push(...sorted.filter((item) => item.stratum === stratum).slice(0, 4));
    }
    const selectedIds = new Set(selected.map((item) => item.logicalPageId));
    const target = Math.min(20, examples.length);
    for (const item of sorted) {
      if (selected.length >= target) break;
      if (!selectedIds.has(item.logicalPageId)) {
        selected.push(item);
        selectedIds.add(item.logicalPageId);
      }
    }
    selected.sort((left, right) => {
      const precedence: Record<PreviewStratum, number> = {
        exclusion_changed: 0,
        band_changed: 1,
        assessment_changed: 2,
        unchanged: 3,
      };
      return precedence[left.stratum] - precedence[right.stratum] ||
        rank(left).localeCompare(rank(right)) || left.logicalPageId - right.logicalPageId;
    });
    const selectDisplay = connection.prepare(`SELECT logical_pages.representative_url,
      (SELECT tabs.title FROM tabs WHERE tabs.logical_page_id=logical_pages.id
        ORDER BY tabs.id LIMIT 1) AS title
      FROM logical_pages WHERE logical_pages.id=?`);
    const selectedWithDisplay = selected.map((example) => {
      const display = selectDisplay.get(example.logicalPageId) as
        { representative_url: string; title: string | null } | undefined;
      if (display === undefined) {
        throw new PersonalPriorityRulesError(
          "PRIORITY_RULESET_CONFLICT", "Preview page metadata disappeared",
        );
      }
      return {
        ...example,
        display: {
          title: display.title,
          representativeUrl: display.representative_url,
        },
      };
    });
    if (performance.now() - started > maximumPreviewWallMs) {
      throw new PersonalPriorityRulesError(
        "PRIORITY_RULE_PREVIEW_TIMEOUT", "Priority rules preview exceeded 60 seconds",
      );
    }
    return {
      compiler: candidate.compiler,
      candidate: {
        additions: candidate.additions,
        astHash: candidate.astHash,
        naturalLanguageSource: candidate.naturalLanguageSource,
        totalRuleCount: candidate.ast.rules.length,
      },
      diff: diffRules(active, candidate.ast),
      examples: selectedWithDisplay,
      eligibleCount: examples.length,
      scannedCount,
      comparedActiveRef: comparedActive.ref,
      comparedActiveAstHash: sha256(canonicalPriorityRuleAstJson(comparedActive.ast)),
      requestFingerprint: sha256(canonicalJson({ draft: draftValue })),
    };
  }

  function assertRequestFingerprint(request: PersonalPriorityLifecycleRequest): void {
    const { requestFingerprint: _fingerprint, ...payload } = request;
    if (request.requestFingerprint !== personalPriorityRequestFingerprint(payload)) {
      throw new PersonalPriorityRulesError(
        "PRIORITY_RULESET_CONFLICT", "Priority rules request fingerprint does not match",
      );
    }
  }

  function requireVersion(ref: PriorityRulesetRefContract): VersionRow {
    const ruleset = connection.prepare("SELECT id FROM priority_rulesets WHERE id=?")
      .get(ref.rulesetId) as RulesetRow | undefined;
    if (ruleset === undefined) throw new PersonalPriorityRulesError(
      "PRIORITY_RULESET_NOT_FOUND", "Priority ruleset was not found",
    );
    const row = connection.prepare(`SELECT ruleset_id,version,rule_ast_json,
      natural_language_source,created_by,created_at FROM priority_rule_versions
      WHERE ruleset_id=? AND version=?`).get(ref.rulesetId, ref.version) as
      VersionRow | undefined;
    if (row === undefined) throw new PersonalPriorityRulesError(
      "PRIORITY_RULESET_VERSION_NOT_FOUND", "Priority ruleset version was not found",
    );
    return row;
  }

  function activatePointer(
    operation: "activate" | "disable" | "rollback",
    target: PriorityRulesetRefContract,
    expected: PriorityRulesetRefContract,
    requestFingerprint: string,
  ) {
    const targetVersion = requireVersion(target);
    const personal = personalRuleset();
    const validDisableTarget = operation === "disable" &&
      refsEqual(target, baselinePriorityRulesetRef);
    const validPersonalTarget = operation !== "disable" &&
      personal?.id === target.rulesetId && targetVersion.created_by === "user";
    if (!validDisableTarget && !validPersonalTarget) {
      throw new PersonalPriorityRulesError(
        "PRIORITY_RULESET_VERSION_NOT_FOUND",
        operation === "disable"
          ? "Disable may only activate the immutable baseline priority ruleset"
          : "Only user-created Personal priority rules versions may be activated or rolled back",
      );
    }
    if (validPersonalTarget) {
      const ast = parsePriorityRuleAst(JSON.parse(targetVersion.rule_ast_json) as unknown);
      if (materialize(additionsFromAst(ast)).astJson !== targetVersion.rule_ast_json) {
        throw new PersonalPriorityRulesError(
          "INVALID_PRIORITY_RULESET",
          "Personal priority rules version is not an exact baseline-plus-additions materialization",
        );
      }
    }
    const current = activeRef();
    if (refsEqual(current, target)) return response(operation, target, true, false,
      requestFingerprint);
    if (!refsEqual(current, expected)) conflict("Active priority ruleset changed");
    connection.prepare(`UPDATE priority_ruleset_activations SET ruleset_id=?,version=?,
      activated_at=? WHERE scope='global'`).run(
      target.rulesetId, target.version, canonicalTimestamp(now),
    );
    return response(operation, target, false, true, requestFingerprint);
  }

  function response(
    operation: "save" | "activate" | "disable" | "reset" | "rollback",
    target: PriorityRulesetRefContract,
    replayed: boolean,
    changed: boolean,
    requestFingerprint: string,
  ) {
    const active = activeRef();
    const personal = personalRuleset();
    const latest = personal === undefined ? null : (versions(personal.id)[0]?.version ?? null);
    return {
      operation,
      target,
      activeRef: active,
      latestVersion: latest,
      requestFingerprint,
      replayed,
      changed,
      recomputeRequired: operation !== "save" && changed || hasDirtyOutcome(active),
      staleOutcomeCount: staleOutcomeCount(connection, active),
    };
  }

  function conflict(message: string): never {
    throw new PersonalPriorityRulesError("PRIORITY_RULESET_CONFLICT", message);
  }

  function save(
    draft: PersonalPriorityDraft,
    expectedLatestVersion: number | null,
    expectedActiveRef: PriorityRulesetRefContract,
    requestFingerprint: string,
  ) {
    const candidate = preparePersonalPriorityDraft(draft);
    let ruleset = personalRuleset();
    const existing = ruleset === undefined ? [] : versions(ruleset.id);
    const latest = existing[0];
    const actualLatest = latest?.version ?? null;
    if (actualLatest !== expectedLatestVersion) {
      if (expectedLatestVersion !== null && latest?.version === expectedLatestVersion + 1 &&
          latest.rule_ast_json === candidate.astJson &&
          latest.natural_language_source === candidate.naturalLanguageSource &&
          latest.created_by === "user") {
        return response("save", { rulesetId: latest.ruleset_id, version: latest.version },
          true, false, requestFingerprint);
      }
      if (expectedLatestVersion === null && latest?.version === 1 &&
          latest.rule_ast_json === candidate.astJson &&
          latest.natural_language_source === candidate.naturalLanguageSource &&
          latest.created_by === "user") {
        return response("save", { rulesetId: latest.ruleset_id, version: latest.version },
          true, false, requestFingerprint);
      }
      conflict("Latest personal priority rules version changed");
    }
    if (!refsEqual(activeRef(), expectedActiveRef)) conflict("Active priority ruleset changed");
    const timestamp = canonicalTimestamp(now);
    if (ruleset === undefined) {
      const inserted = connection.prepare(`INSERT INTO priority_rulesets
        (name,created_at,updated_at) VALUES (?,?,?)`).run(
        personalPriorityRulesetName, timestamp, timestamp,
      );
      ruleset = { id: Number(inserted.lastInsertRowid) };
    }
    const version = (actualLatest ?? 0) + 1;
    connection.prepare(`INSERT INTO priority_rule_versions
      (ruleset_id,version,rule_ast_json,natural_language_source,created_by,created_at)
      VALUES (?,?,?,?, 'user',?)`).run(
      ruleset.id, version, candidate.astJson, candidate.naturalLanguageSource, timestamp,
    );
    connection.prepare("UPDATE priority_rulesets SET updated_at=? WHERE id=?")
      .run(timestamp, ruleset.id);
    return response("save", { rulesetId: ruleset.id, version }, false, true,
      requestFingerprint);
  }

  function reset(
    expectedLatestVersion: number | null,
    expectedActiveRef: PriorityRulesetRefContract,
    requestFingerprint: string,
  ) {
    const personal = personalRuleset();
    const latest = personal === undefined ? undefined : versions(personal.id)[0];
    const candidate = materialize([]);
    const targetVersion = (expectedLatestVersion ?? 0) + 1;
    if (latest?.version === targetVersion && latest.rule_ast_json === candidate.astJson &&
        latest.natural_language_source === null && latest.created_by === "user") {
      const target = { rulesetId: latest.ruleset_id, version: latest.version };
      if (refsEqual(activeRef(), target)) return response("reset", target, true, false,
        requestFingerprint);
      conflict("Reset content exists but its active pointer does not match");
    }
    if ((latest?.version ?? null) !== expectedLatestVersion) {
      conflict("Latest personal priority rules version changed");
    }
    if (!refsEqual(activeRef(), expectedActiveRef)) conflict("Active priority ruleset changed");
    const saved = save({ kind: "structured", additions: [] }, expectedLatestVersion,
      expectedActiveRef, requestFingerprint);
    connection.prepare(`UPDATE priority_ruleset_activations SET ruleset_id=?,version=?,
      activated_at=? WHERE scope='global'`).run(
      saved.target.rulesetId, saved.target.version, canonicalTimestamp(now),
    );
    return response("reset", saved.target, false, true, requestFingerprint);
  }

  const mutate = connection.transaction((request: PersonalPriorityLifecycleRequest) => {
    assertBaseline();
    assertRequestFingerprint(request);
    if (request.kind !== "save" && !writerEnabled) {
      throw new PersonalPriorityRulesError(
        "PRIORITY_FEATURE_UNAVAILABLE", "Priority assessment writer is disabled",
      );
    }
    if (request.kind === "save") return save(
      request.draft, request.expectedLatestVersion, request.expectedActiveRef,
      request.requestFingerprint,
    );
    if (request.kind === "activate") return activatePointer(
      "activate", request.target, request.expectedActiveRef, request.requestFingerprint,
    );
    if (request.kind === "rollback") return activatePointer(
      "rollback", request.target, request.expectedActiveRef, request.requestFingerprint,
    );
    if (request.kind === "disable") return activatePointer(
      "disable", baselinePriorityRulesetRef, request.expectedActiveRef,
      request.requestFingerprint,
    );
    return reset(request.expectedLatestVersion, request.expectedActiveRef,
      request.requestFingerprint);
  });

  function change(value: PersonalPriorityLifecycleRequest) {
    const request = personalPriorityLifecycleRequestSchema.parse(value);
    return mutate.immediate(request);
  }

  function readVersion(ref: PriorityRulesetRefContract) {
    assertBaseline();
    return mapVersion(requireVersion(ref), activeRef());
  }

  return { read, readVersion, preview, change };
}
