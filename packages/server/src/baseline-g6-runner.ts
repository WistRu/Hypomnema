import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { localTabListResponseSchema, resourceListResponseSchema } from "@tabhub/shared";
import Database from "better-sqlite3";

import { baselineContractHash, q10kG6V1, q10kG6V1Hash,
  type G6BaselineHttpQuery } from "./baseline-contract.js";
import { checkpointG6Database, inspectG6Database, sha256G6DatabaseFile,
  type G6DatabaseFingerprint } from "./baseline-g6-database.js";
import { createApp } from "./app.js";
import { createLogicalPageCatalog } from "./logical-page-catalog.js";
import { createPersonalPriorityRulesCatalog, personalPriorityRequestFingerprint } from
  "./personal-priority-rules.js";
import { createPriorityEngine, previewPriorityRuleEvaluation, readPriorityRuleset,
  type PrioritySubject } from "./priority-engine.js";
import { createPriorityFeatureCatalog } from "./priority-feature-catalog.js";
import { createResourceCommandCatalog } from "./resource-command-catalog.js";

export interface RunG6BaselineOptions { readonly sourcePath: string; readonly workDirectory: string }
export interface G6QueryTiming { readonly id: string; readonly path: string;
  readonly samples: number; readonly p50Ms: number; readonly p95Ms: number;
  readonly maxMs: number; readonly p95LimitMs: number; readonly passed: boolean }
export interface G6CoverageReceipt { readonly passed: boolean;
  readonly page: G6SubjectCoverage; readonly resource: G6SubjectCoverage }
export interface G6SubjectCoverage { readonly userValues: readonly (number | null)[];
  readonly currentBands: readonly string[]; readonly currentExclusionCount: number;
  readonly currentReviewCount: number; readonly staleCount: number; readonly missingCount: number;
  readonly fingerprintMismatchCount: number }
export interface G6SweepReceipt { readonly passed: boolean;
  readonly pages: Readonly<Record<string, G6SweepDetail>>;
  readonly resources: Readonly<Record<string, G6SweepDetail>> }
export interface G6SweepDetail { readonly ids: readonly number[]; readonly total: number;
  readonly fetchedPages: number; readonly finalEmpty: boolean }
export interface G6BaselineResult {
  readonly contractHash: string;
  readonly official: boolean;
  readonly passed: boolean;
  readonly correctnessPassed: boolean;
  readonly performancePassed: boolean;
  readonly querySet: string;
  readonly fixture: Readonly<Record<string, unknown>>;
  readonly featureProfile: typeof q10kG6V1.measurementFeatureProfile;
  readonly databaseDeterminism: Readonly<{ primary: G6DatabaseFingerprint;
    replica: G6DatabaseFingerprint; exactMatch: boolean }>;
  readonly measurementBefore: G6DatabaseFingerprint;
  readonly measurementAfter: G6DatabaseFingerprint;
  readonly measurementNoninterference: boolean;
  readonly fixtureCoverage: G6CoverageReceipt;
  readonly duplicateBoundary: Readonly<{ logicalPageId: number; url: string;
    expectedTabIds: readonly number[]; complete: boolean }>;
  readonly queries: readonly G6QueryTiming[];
  readonly fullSweep: G6SweepReceipt;
  readonly source: Readonly<{ path: string; beforeSha256: string; afterSha256: string;
    beforeMtimeMs: number; unchanged: boolean }>;
  readonly warmups: number;
  readonly runtime: Readonly<{ command: readonly string[]; head: string;
    node: string; platform: NodeJS.Platform }>;
}

interface RunIdentity { readonly official: boolean; readonly artifactName: string;
  readonly querySet: string; readonly contractHash: string; readonly expectedSourceSha256: string;
  readonly fixture: Readonly<Record<string, unknown>> }
interface PageOutcomeRow { id: number; logical_page_id: number; agent_score: number;
  agent_band: string; needs_review: number; ruleset_id: number; ruleset_version: number;
  feature_fingerprint: string }
interface ResourceOutcomeRow { id: number; resource_id: number; agent_score: number;
  agent_band: string; needs_review: number; ruleset_id: number; ruleset_version: number;
  feature_fingerprint: string }

const bootstrapSecret = "q10k-g6-local-bootstrap-only";
const bandRanks: Readonly<Record<string, number>> = { low: 1, medium: 2, high: 3, critical: 4 };
const browserRanks: Readonly<Record<string, number>> =
  { chrome: 0, yandex: 1, edge: 2, other: 3 };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function hashBucket(seed: string, type: string, id: number, modulo: number): number {
  return createHash("sha256").update(`${seed}${type}${id}`, "utf8").digest().readUInt32BE(0) % modulo;
}
function percentile(values: readonly number[], percentileValue: number): number {
  return values[Math.max(0, Math.ceil(percentileValue / 100 * values.length) - 1)] ?? 0;
}
function rounded(value: number): number { return Number(value.toFixed(3)); }
function gitHead(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function subjectId(subject: PrioritySubject): number {
  return subject.type === "page" ? subject.logicalPageId : subject.resourceId;
}

function personalRules(
  topicPaths: readonly string[],
  resourceTopicSignatures: readonly (readonly string[])[],
  marker = false,
) {
  const partition: Array<{
    effect: { exclusionReason: "policy_excluded" } | { scoreFloor: number;
      scoreCap: number; needsReview?: boolean };
  }> = [
    { effect: { exclusionReason: "policy_excluded" as const } },
    { effect: { scoreFloor: 10, scoreCap: 10, needsReview: true } },
    { effect: { scoreFloor: 10, scoreCap: 10, needsReview: true } },
    { effect: { scoreFloor: 40, scoreCap: 40 } },
    { effect: { scoreFloor: 40, scoreCap: 40 } },
    { effect: { scoreFloor: 70, scoreCap: 70 } },
    { effect: { scoreFloor: 70, scoreCap: 70 } },
    { effect: { scoreFloor: 90, scoreCap: 90 } },
    { effect: { scoreFloor: 90, scoreCap: 90 } },
    { effect: { scoreFloor: 90, scoreCap: 90 } },
  ];
  const rules: Array<{
    ruleKey: string; priority: number; label: string; appliesTo: "page" | "both";
    when: { all: Array<{ signal: "topic_paths" | "workspace_names"; operator: "in";
      value: string[] }> };
    effect: { exclusionReason: "policy_excluded" } | { scoreFloor: number;
      scoreCap: number; needsReview?: boolean } | { scoreDelta: number };
  }> = topicPaths.slice(0, 20).map((topic, index) => ({
    ruleKey: `personal.q10k-g6.topic-${String(index).padStart(2, "0")}`,
    priority: 900,
    label: `Q10K G6 topic partition ${index}`,
    appliesTo: "page" as const,
    when: { all: [{ signal: "topic_paths" as const, operator: "in" as const, value: [topic] }] },
    effect: partition[index % 10]!.effect,
  }));
  for (const [index, signature] of resourceTopicSignatures.entries()) {
    rules.push({
      ruleKey: `personal.q10k-g6.resource-topic-set-${String(index).padStart(2, "0")}`,
      priority: 900,
      label: `Q10K G6 Resource topic-set partition ${index}`,
      appliesTo: "both",
      when: { all: signature.map((topic) => ({ signal: "topic_paths", operator: "in",
        value: [topic] })) },
      effect: partition[index % 10]!.effect,
    });
  }
  if (marker) rules.push({
    ruleKey: "personal.q10k-g6-v2-marker", priority: 900,
    label: "Q10K G6 nonmatching v2 marker", appliesTo: "both" as const,
    when: { all: [{ signal: "workspace_names" as const, operator: "in" as const,
      value: ["__q10k_g6_nonmatching_marker__"] }] }, effect: { scoreDelta: 1 },
  });
  return rules;
}

function activateRequest(kind: "activate", target: { rulesetId: number; version: number },
  expectedActiveRef: { rulesetId: number; version: number }) {
  const payload = { kind, target, expectedActiveRef } as const;
  return { ...payload, requestFingerprint: personalPriorityRequestFingerprint(payload) };
}
function saveRequest(additions: ReturnType<typeof personalRules>, expectedLatestVersion: number | null,
  expectedActiveRef: { rulesetId: number; version: number }) {
  const payload = { kind: "save" as const, draft: { kind: "structured" as const, additions },
    expectedLatestVersion, expectedActiveRef };
  return { ...payload, requestFingerprint: personalPriorityRequestFingerprint(payload) };
}

async function deriveFixture(sourcePath: string, destinationPath: string) {
  await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  const app = createApp({ databasePath: destinationPath,
    featureFlags: q10kG6V1.derivationFeatureProfile, logger: false,
    clock: () => new Date(q10kG6V1.fixture.fixedClock),
    migrationClock: () => new Date(q10kG6V1.fixture.fixedClock),
    maximumMigrationVersion: q10kG6V1.fixture.expectedSchemaVersion });
  await app.ready();
  await app.close();
  const database = new Database(destinationPath, { fileMustExist: true });
  try {
    const now = () => q10kG6V1.fixture.fixedClock;
    const logicalPages = createLogicalPageCatalog(database, () => new Date(now()));
    const resources = createResourceCommandCatalog(database, () => new Date(now()));
    const pageIds = database.prepare("SELECT id FROM logical_pages ORDER BY id").pluck().all() as number[];
    const resourceIds = database.prepare(`SELECT resources.id FROM resources
      JOIN resource_heads AS heads ON heads.resource_id=resources.id
      JOIN resource_events AS events ON events.id=heads.event_id
        AND events.resource_id=resources.id WHERE events.lifecycle_state='active'
      ORDER BY resources.id`).pluck().all() as number[];
    for (const id of pageIds) {
      const value = hashBucket(q10kG6V1.fixture.preferenceSeed, "page", id, 4);
      logicalPages.setUserImportance({ logicalPageId: id,
        value: value === 0 ? null : value as 1 | 2 | 3 },
      { recordedBy: "user", recordMethod: "manual" });
    }
    for (const id of resourceIds) {
      const value = hashBucket(q10kG6V1.fixture.preferenceSeed, "resource", id, 4);
      resources.change({ kind: "set_user_evaluation", resourceId: id,
        evaluation: value === 0 ? null : value as 1 | 2 | 3,
        provenance: { actor: "user", method: "manual" },
        idempotencyKey: `q10k-g6-resource-preference-${id}` });
    }
    const topicPaths = database.prepare(`WITH RECURSIVE paths(id,path) AS (
      SELECT id,name FROM tags WHERE parent_id IS NULL UNION ALL
      SELECT tags.id,paths.path||'/'||tags.name FROM tags JOIN paths ON paths.id=tags.parent_id)
      SELECT path FROM paths WHERE path LIKE 'Baseline % topic %' ORDER BY path`).pluck().all() as string[];
    if (topicPaths.length !== 20) throw new Error("Q10K-G6 derivation requires exactly 20 baseline Topics");
    const features = createPriorityFeatureCatalog(database);
    const rules = createPersonalPriorityRulesCatalog(database, { now, featureCatalog: features,
      writerEnabled: true });
    const resourceTopicSignatures = (database.prepare(`WITH RECURSIVE paths(id,path) AS (
      SELECT id,name FROM tags WHERE parent_id IS NULL UNION ALL
      SELECT tags.id,paths.path||'/'||tags.name FROM tags JOIN paths ON paths.id=tags.parent_id),
      membership AS (SELECT assignments.logical_page_id,assignments.resource_id
        FROM logical_page_resource_heads heads JOIN logical_page_resource_assignments assignments
        ON assignments.id=heads.assignment_id WHERE assignments.action='assigned')
      SELECT membership.resource_id,GROUP_CONCAT(DISTINCT paths.path) AS paths
      FROM membership JOIN tabs ON tabs.logical_page_id=membership.logical_page_id
      JOIN tab_tags ON tab_tags.tab_id=tabs.id JOIN paths ON paths.id=tab_tags.tag_id
      GROUP BY membership.resource_id ORDER BY membership.resource_id`).all() as
      Array<{ resource_id: number; paths: string }>).map((row) => row.paths.split(",").sort());
    const uniqueResourceTopicSignatures = [...new Map(resourceTopicSignatures.map((signature) =>
      [JSON.stringify(signature), signature])).values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (uniqueResourceTopicSignatures.length !== 10 ||
        uniqueResourceTopicSignatures.some((signature) => signature.length > 8)) {
      throw new Error("Q10K-G6 derivation requires ten bounded Resource topic signatures");
    }
    const v1 = rules.change(saveRequest(personalRules(
      topicPaths, uniqueResourceTopicSignatures,
    ), null, { rulesetId: 1, version: 1 }));
    rules.change(activateRequest("activate", v1.target, { rulesetId: 1, version: 1 }));
    const engine = createPriorityEngine(database, { now });
    const allSubjects: PrioritySubject[] = [
      ...pageIds.map((logicalPageId) => ({ type: "page" as const, logicalPageId })),
      ...resourceIds.map((resourceId) => ({ type: "resource" as const, resourceId })),
    ];
    const rawBucket = (subject: PrioritySubject) => hashBucket(
      q10kG6V1.fixture.outcomeSeed, subject.type, subjectId(subject), 3,
    );
    const assess = (subjects: readonly PrioritySubject[]) => {
      for (let offset = 0; offset < subjects.length; offset += 100) {
        const reads = features.previewBatch(subjects.slice(offset, offset + 100), now());
        engine.assess(reads.map((read) => ({ subject: read.subject, features: read.features,
          eligibility: read.eligibility, assessmentMethod: "rule" as const })));
      }
    };
    assess(allSubjects.filter((subject) => rawBucket(subject) === 0));
    const v2 = rules.change(saveRequest(personalRules(
      topicPaths, uniqueResourceTopicSignatures, true,
    ), 1, v1.target));
    rules.change(activateRequest("activate", v2.target, v1.target));
    const promotedCurrentPageIds = new Set<number>();
    const promotedOutcomeKeys = new Set<string>();
    const activeAst = readPriorityRuleset(database, v2.target).ast;
    for (let offset = 0; offset < pageIds.length; offset += 100) {
      for (const read of features.previewBatch(pageIds.slice(offset, offset + 100).map(
        (logicalPageId) => ({ type: "page" as const, logicalPageId })), now())) {
        if (read.subject.type !== "page") continue;
        const outcome = previewPriorityRuleEvaluation(activeAst, {
          subject: read.subject, features: read.features, eligibility: read.eligibility,
        });
        const key = outcome.kind === "exclusion" ? "exclusion" : outcome.agentBand;
        if (!promotedOutcomeKeys.has(key)) {
          promotedOutcomeKeys.add(key);
          promotedCurrentPageIds.add(read.subject.logicalPageId);
        }
      }
    }
    if (promotedCurrentPageIds.size < 5) throw new Error(
      "Q10K-G6 cannot promote every evaluated page band and exclusion",
    );
    assess(allSubjects.filter((subject) => rawBucket(subject) === 1 ||
      subject.type === "page" && promotedCurrentPageIds.has(subject.logicalPageId)));
  } finally { database.close(); }
  checkpointG6Database(destinationPath);
  return inspectG6Database(destinationPath);
}

function currentOutcomeMaps(database: Database.Database) {
  const active = database.prepare(`SELECT ruleset_id,version FROM priority_ruleset_activations
    WHERE scope='global'`).get() as { ruleset_id: number; version: number };
  const pageAssessmentRows = database.prepare(`SELECT * FROM priority_assessments
    WHERE superseded_at IS NULL`).all() as PageOutcomeRow[];
  const resourceAssessmentRows = database.prepare(`SELECT * FROM resource_priority_assessments
    WHERE superseded_at IS NULL`).all() as ResourceOutcomeRow[];
  const pageExclusions = database.prepare(`SELECT logical_page_id AS id,ruleset_id,ruleset_version,
    feature_fingerprint FROM priority_exclusions WHERE superseded_at IS NULL`).all() as
    Array<{ id: number; ruleset_id: number; ruleset_version: number; feature_fingerprint: string }>;
  const resourceExclusions = database.prepare(`SELECT resource_id AS id,ruleset_id,ruleset_version,
    feature_fingerprint FROM resource_priority_exclusions WHERE superseded_at IS NULL`).all() as
    Array<{ id: number; ruleset_id: number; ruleset_version: number; feature_fingerprint: string }>;
  const isCurrentRef = (row: { ruleset_id: number; ruleset_version: number }) =>
    row.ruleset_id === active.ruleset_id && row.ruleset_version === active.version;
  return {
    active,
    pageAssessments: new Map(pageAssessmentRows.filter(isCurrentRef).map((row) =>
      [row.logical_page_id, row])),
    resourceAssessments: new Map(resourceAssessmentRows.filter(isCurrentRef).map((row) =>
      [row.resource_id, row])),
    pageExclusions: new Set(pageExclusions.filter(isCurrentRef).map((row) => row.id)),
    resourceExclusions: new Set(resourceExclusions.filter(isCurrentRef).map((row) => row.id)),
    pageAllOutcomeIds: new Set([...pageAssessmentRows.map((row) => row.logical_page_id),
      ...pageExclusions.map((row) => row.id)]),
    resourceAllOutcomeIds: new Set([...resourceAssessmentRows.map((row) => row.resource_id),
      ...resourceExclusions.map((row) => row.id)]),
    pageStale: new Set([...pageAssessmentRows.filter((row) => !isCurrentRef(row))
      .map((row) => row.logical_page_id), ...pageExclusions.filter((row) => !isCurrentRef(row))
      .map((row) => row.id)]),
    resourceStale: new Set([...resourceAssessmentRows.filter((row) => !isCurrentRef(row))
      .map((row) => row.resource_id), ...resourceExclusions.filter((row) => !isCurrentRef(row))
      .map((row) => row.id)]),
  };
}

function coverage(databasePath: string): G6CoverageReceipt {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const maps = currentOutcomeMaps(database);
    const features = createPriorityFeatureCatalog(database);
    const pageIds = database.prepare("SELECT id FROM logical_pages ORDER BY id").pluck().all() as number[];
    const resourceIds = database.prepare(`SELECT resources.id FROM resources JOIN resource_heads h
      ON h.resource_id=resources.id JOIN resource_events e ON e.id=h.event_id
      AND e.resource_id=resources.id WHERE e.lifecycle_state='active' ORDER BY resources.id`)
      .pluck().all() as number[];
    const result = (type: "page" | "resource", ids: readonly number[]): G6SubjectCoverage => {
      const assessments = type === "page" ? maps.pageAssessments : maps.resourceAssessments;
      const exclusions = type === "page" ? maps.pageExclusions : maps.resourceExclusions;
      const all = type === "page" ? maps.pageAllOutcomeIds : maps.resourceAllOutcomeIds;
      const stale = type === "page" ? maps.pageStale : maps.resourceStale;
      const preferenceTable = type === "page" ? "logical_page_preferences" : "resource_preferences";
      const preferenceColumn = type === "page" ? "user_importance" : "user_evaluation";
      const userValues = database.prepare(`SELECT DISTINCT ${preferenceColumn} AS value
        FROM ${preferenceTable} ORDER BY value`).pluck().all() as Array<number | null>;
      const currentRows = [...assessments.values()];
      let fingerprintMismatchCount = 0;
      const currentIds = [...new Set([...assessments.keys(), ...exclusions])].sort((a, b) => a - b);
      for (let offset = 0; offset < currentIds.length; offset += 100) {
        const reads = features.readBatch(currentIds.slice(offset, offset + 100).map((id) =>
          type === "page" ? { type: "page" as const, logicalPageId: id }
            : { type: "resource" as const, resourceId: id }), q10kG6V1.fixture.fixedClock);
        fingerprintMismatchCount += reads.filter((read) => !read.isCurrent).length;
      }
      return { userValues, currentBands: [...new Set(currentRows.map((row) => row.agent_band))].sort(),
        currentExclusionCount: exclusions.size,
        currentReviewCount: currentRows.filter((row) => row.needs_review === 1).length,
        staleCount: stale.size, missingCount: ids.filter((id) => !all.has(id)).length,
        fingerprintMismatchCount };
    };
    const page = result("page", pageIds); const resource = result("resource", resourceIds);
    const complete = (value: G6SubjectCoverage) => sameJson(value.userValues, [null, 1, 2, 3]) &&
      sameJson(value.currentBands, ["critical", "high", "low", "medium"]) &&
      value.currentExclusionCount > 0 && value.currentReviewCount > 0 && value.staleCount > 0 &&
      value.missingCount > 0 && value.fingerprintMismatchCount === 0;
    return { page, resource, passed: complete(page) && complete(resource) };
  } finally { database.close(); }
}

function selectBoundary(databasePath: string) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(`SELECT logical_page_id,url_normalized FROM tabs
      GROUP BY logical_page_id,url_normalized HAVING COUNT(*)=2 AND COUNT(DISTINCT browser)=2
      ORDER BY url_normalized,logical_page_id LIMIT 1`).get() as
      { logical_page_id: number; url_normalized: string } | undefined;
    if (row === undefined) throw new Error("Q10K-G6 duplicate boundary selector found no pair");
    const ids = database.prepare(`SELECT id FROM tabs WHERE logical_page_id=? ORDER BY
      CASE browser WHEN 'chrome' THEN 0 WHEN 'yandex' THEN 1 WHEN 'edge' THEN 2
        WHEN 'other' THEN 3 ELSE 4 END,browser COLLATE NOCASE,browser,id`)
      .pluck().all(row.logical_page_id) as number[];
    return { logicalPageId: row.logical_page_id, url: row.url_normalized,
      expectedTabIds: ids, complete: ids.length === 2 };
  } finally { database.close(); }
}

interface OracleRow { id: number; logicalPageId?: number; userValue: number | null;
  bandRank: number; agentScore: number; needsReview: boolean; browser?: string;
  activityForeground?: number; activityEngaged?: number; resourceKey?: string; name?: string;
  title?: string | null; url?: string }

function oracleRows(databasePath: string, type: "page" | "resource"): OracleRow[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const maps = currentOutcomeMaps(database);
    if (type === "page") {
      const rows = database.prepare(`SELECT tabs.id,tabs.logical_page_id,tabs.browser,
        tabs.title,tabs.url,
        preferences.user_importance,
        COALESCE(activity.foreground_ms,0) AS foreground_ms,
        COALESCE(activity.engaged_ms,0) AS engaged_ms
        FROM tabs LEFT JOIN logical_page_preferences preferences
          ON preferences.logical_page_id=tabs.logical_page_id
        LEFT JOIN tab_page_activity_totals activity ON activity.browser=tabs.browser
          AND activity.url_normalized=tabs.url_normalized
        WHERE NOT EXISTS (SELECT 1 FROM page_retention WHERE page_retention.tab_id=tabs.id
          AND page_retention.state='trashed')`).all() as Array<{ id: number;
        logical_page_id: number; browser: string; title: string | null; url: string;
        user_importance: number | null;
        foreground_ms: number; engaged_ms: number }>;
      return rows.map((row) => {
        const assessment = maps.pageAssessments.get(row.logical_page_id);
        return { id: row.id, logicalPageId: row.logical_page_id, browser: row.browser,
          userValue: row.user_importance, bandRank: assessment === undefined ? 0 : bandRanks[
            assessment.agent_band]!, agentScore: assessment?.agent_score ?? -1,
          needsReview: assessment?.needs_review === 1,
          activityForeground: row.foreground_ms, activityEngaged: row.engaged_ms,
          title: row.title, url: row.url };
      });
    }
    const rows = database.prepare(`SELECT resources.id,resources.resource_key,events.name,
      preferences.user_evaluation FROM resources JOIN resource_heads heads
      ON heads.resource_id=resources.id JOIN resource_events events ON events.id=heads.event_id
      AND events.resource_id=resources.id JOIN resource_preferences preferences
      ON preferences.resource_id=resources.id WHERE events.lifecycle_state='active'`).all() as
      Array<{ id: number; resource_key: string; name: string; user_evaluation: number | null }>;
    return rows.map((row) => {
      const assessment = maps.resourceAssessments.get(row.id);
      return { id: row.id, userValue: row.user_evaluation,
        bandRank: assessment === undefined ? 0 : bandRanks[assessment.agent_band]!,
        agentScore: assessment?.agent_score ?? -1, needsReview: assessment?.needs_review === 1,
        resourceKey: row.resource_key, name: row.name };
    });
  } finally { database.close(); }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" }) || left.localeCompare(right);
}
function orderOracle(rows: readonly OracleRow[], type: "page" | "resource",
  mode: "my" | "ai" | "recommended" | undefined,
  secondary: "default" | "activity-desc" = "default") {
  return [...rows].sort((left, right) => {
    if (mode === "my") { const delta = (right.userValue ?? 0) - (left.userValue ?? 0);
      if (delta !== 0) return delta; }
    if (mode === "ai") { const delta = right.bandRank - left.bandRank ||
      right.agentScore - left.agentScore; if (delta !== 0) return delta; }
    if (mode === "recommended") {
      const recommended = (row: OracleRow) => row.userValue ?? row.bandRank;
      const delta = recommended(right) - recommended(left) ||
        Number(right.userValue !== null) - Number(left.userValue !== null) ||
        right.agentScore - left.agentScore;
      if (delta !== 0) return delta;
    }
    if (type === "page") {
      if (secondary === "activity-desc") {
        const delta = (right.activityForeground ?? 0) - (left.activityForeground ?? 0) ||
          (right.activityEngaged ?? 0) - (left.activityEngaged ?? 0);
        if (delta !== 0) return delta;
      }
      const browser = (browserRanks[left.browser!] ?? 4) - (browserRanks[right.browser!] ?? 4) ||
        compareText(left.browser!, right.browser!);
      return browser || left.id - right.id;
    }
    const name = compareText(left.name!, right.name!);
    return name || compareText(left.resourceKey!, right.resourceKey!) || left.id - right.id;
  });
}

function resolvePath(query: G6BaselineHttpQuery, boundaryUrl: string): string {
  return query.pathTemplate.replaceAll(":boundary-url", encodeURIComponent(boundaryUrl));
}
function expectedForQuery(query: G6BaselineHttpQuery, pageRows: readonly OracleRow[],
  resourceRows: readonly OracleRow[], boundaryUrl: string) {
  const url = new URL(resolvePath(query, boundaryUrl), "http://baseline.invalid");
  const mode = url.searchParams.get("priority_mode") as "my" | "ai" | "recommended" | null;
  const needs = url.searchParams.get("needs_review");
  const page = Number(url.searchParams.get("page")); const size = Number(url.searchParams.get("pageSize"));
  const source = query.assertion === "exact_resource_ids_total" ? resourceRows : pageRows;
  let filtered = source;
  if (query.assertion === "exact_duplicate_boundary") {
    filtered = pageRows.filter((row) => row.logicalPageId !== undefined &&
      boundaryUrl.length > 0 && row.logicalPageId === pageRows.find((item) =>
        item.logicalPageId === row.logicalPageId)?.logicalPageId);
    // The caller overwrites this with exact logical-page rows below.
  }
  if (needs !== null) filtered = filtered.filter((row) => row.needsReview === (needs === "true"));
  const ordered = orderOracle(filtered, query.assertion === "exact_resource_ids_total"
    ? "resource" : "page", mode ?? undefined,
  url.searchParams.get("sort_by") === "activity" ? "activity-desc" : "default");
  return { ids: ordered.slice((page - 1) * size, page * size).map((row) => row.id),
    total: ordered.length };
}

async function bootstrapApp(databasePath: string) {
  const app = createApp({ databasePath, featureFlags: q10kG6V1.measurementFeatureProfile,
    logger: false, localDevProxySecret: bootstrapSecret,
    clock: () => new Date(q10kG6V1.fixture.fixedClock),
    migrationClock: () => new Date(q10kG6V1.fixture.fixedClock),
    maximumMigrationVersion: q10kG6V1.fixture.expectedSchemaVersion });
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/local/session/bootstrap",
    headers: { "x-tabhub-dev-proxy-secret": bootstrapSecret } });
  if (response.statusCode !== 204) throw new Error(`Q10K-G6 bootstrap returned ${response.statusCode}`);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Q10K-G6 bootstrap returned no cookie");
  return { app, cookie };
}

async function measure(databasePath: string, boundary: ReturnType<typeof selectBoundary>) {
  const pageRows = oracleRows(databasePath, "page");
  const resourceRows = oracleRows(databasePath, "resource");
  const pair = pageRows.filter((row) => row.logicalPageId === boundary.logicalPageId);
  const { app, cookie } = await bootstrapApp(databasePath);
  try {
    const timings: G6QueryTiming[] = [];
    for (const query of q10kG6V1.queries) {
      const path = resolvePath(query, boundary.url);
      const expected = query.assertion === "exact_duplicate_boundary"
        ? (() => { const url = new URL(path, "http://baseline.invalid");
          const ordered = orderOracle(pair, "page", "recommended", "activity-desc");
          const page = Number(url.searchParams.get("page"));
          return { ids: ordered.slice(page - 1, page).map((row) => row.id), total: 2 }; })()
        : expectedForQuery(query, pageRows, resourceRows, boundary.url);
      const execute = async () => {
        const started = performance.now();
        const response = await app.inject({ method: "GET", url: path,
          ...(query.audience === "local" ? { headers: { cookie,
            "sec-fetch-site": q10kG6V1.authProfile.sameSiteHeader } } : {}) });
        const duration = performance.now() - started;
        if (response.statusCode !== 200) throw new Error(
          `${query.id} returned ${response.statusCode}: ${response.body}`,
        );
        const body = query.assertion === "exact_resource_ids_total"
          ? resourceListResponseSchema.parse(response.json())
          : localTabListResponseSchema.parse(response.json());
        const actual = { ids: query.assertion === "exact_resource_ids_total"
          ? body.items.map((item) => "resource" in item ? item.resource.id : item.id)
          : body.items.map((item) => "id" in item ? item.id : item.resource.id), total: body.total };
        if (!sameJson(actual, expected)) throw new Error(`${query.id} differs from raw-SQL oracle`);
        return duration;
      };
      for (let warmup = 0; warmup < q10kG6V1.warmups; warmup += 1) await execute();
      const samples: number[] = [];
      for (let sample = 0; sample < q10kG6V1.samples; sample += 1) samples.push(await execute());
      samples.sort((a, b) => a - b); const p95Ms = rounded(percentile(samples, 95));
      timings.push({ id: query.id, path, samples: samples.length,
        p50Ms: rounded(percentile(samples, 50)), p95Ms, maxMs: rounded(samples.at(-1) ?? 0),
        p95LimitMs: q10kG6V1.p95LimitMs, passed: p95Ms <= q10kG6V1.p95LimitMs });
    }
    return timings;
  } finally { await app.close(); }
}

async function sweep(databasePath: string): Promise<G6SweepReceipt> {
  const pageOracle = oracleRows(databasePath, "page");
  const resourceOracle = oracleRows(databasePath, "resource");
  const { app, cookie } = await bootstrapApp(databasePath);
  const fetchSweep = async (type: "page" | "resource", suffix: string,
    expectedRows: readonly OracleRow[]): Promise<G6SweepDetail> => {
    const size = q10kG6V1.fullSweep.pageSize; const ids: number[] = [];
    let total: number | undefined; let page = 1; let finalEmpty = false;
    while (true) {
      const url = type === "page" ? `/api/local/tabs?q=${encodeURIComponent(
        q10kG6V1.fullSweep.pageSearch)}&${suffix}&page=${page}&pageSize=${size}`
        : `/api/resources?${suffix}&page=${page}&pageSize=${size}`;
      const response = await app.inject({ method: "GET", url,
        ...(type === "page" ? { headers: { cookie,
          "sec-fetch-site": q10kG6V1.authProfile.sameSiteHeader } } : {}) });
      if (response.statusCode !== 200) throw new Error(`Q10K-G6 sweep returned ${response.statusCode}`);
      const parsed = type === "page" ? localTabListResponseSchema.parse(response.json())
        : resourceListResponseSchema.parse(response.json());
      if (total === undefined) total = parsed.total;
      if (parsed.total !== total || parsed.page !== page || parsed.pageSize !== size) {
        throw new Error("Q10K-G6 sweep pagination metadata changed");
      }
      const pageIds = type === "page" ? parsed.items.map((item) => "id" in item ? item.id : 0)
        : parsed.items.map((item) => "resource" in item ? item.resource.id : 0);
      const expectedSlice = expectedRows.slice((page - 1) * size, page * size)
        .map((row) => row.id);
      if (!sameJson(pageIds, expectedSlice)) throw new Error(
        `Q10K-G6 ${type} sweep ${suffix} page ${page} differs from oracle`,
      );
      ids.push(...pageIds);
      if (pageIds.length === 0) { finalEmpty = true; break; }
      page += 1;
    }
    return { ids, total: total ?? 0, fetchedPages: page, finalEmpty };
  };
  try {
    const searchNeedle = q10kG6V1.fullSweep.pageSearch.toLocaleLowerCase("en-US");
    const pageSearchRows = pageOracle.filter((row) =>
      (row.title ?? row.url ?? "").toLocaleLowerCase("en-US").includes(searchNeedle) ||
      (row.url ?? "").toLocaleLowerCase("en-US").includes(searchNeedle));
    if (pageSearchRows.length === 0 || pageSearchRows.length === pageOracle.length) {
      throw new Error("Q10K-G6 pinned page search must select a non-empty strict subset");
    }
    const pages: Record<string, G6SweepDetail> = {};
    const resources: Record<string, G6SweepDetail> = {};
    for (const modeValue of q10kG6V1.fullSweep.pageModes) {
      const mode = modeValue as "my" | "ai" | "recommended";
      pages[mode] = await fetchSweep(
        "page", `priority_mode=${mode}`, orderOracle(pageSearchRows, "page", mode));
    }
    for (const value of q10kG6V1.fullSweep.reviewValues) pages[`review-${value}`] = await fetchSweep(
      "page", `needs_review=${value}`, orderOracle(pageSearchRows.filter((row) =>
        row.needsReview === value), "page", undefined));
    for (const modeValue of q10kG6V1.fullSweep.resourceModes) {
      const mode = modeValue as "my" | "ai" | "recommended";
      resources[mode] = await fetchSweep(
        "resource", `priority_mode=${mode}`, orderOracle(resourceOracle, "resource", mode));
    }
    for (const value of q10kG6V1.fullSweep.reviewValues) resources[`review-${value}`] = await fetchSweep(
      "resource", `needs_review=${value}`, orderOracle(resourceOracle.filter((row) =>
        row.needsReview === value), "resource", undefined));
    const valid = (values: Readonly<Record<string, G6SweepDetail>>) => Object.values(values)
      .every((item) => item.finalEmpty && item.ids.length === item.total &&
        new Set(item.ids).size === item.ids.length);
    const union = (values: Readonly<Record<string, G6SweepDetail>>, expected: number) => {
      const left = values["review-true"]!.ids; const right = values["review-false"]!.ids;
      return left.every((id) => !right.includes(id)) && new Set([...left, ...right]).size === expected;
    };
    return { pages, resources, passed: valid(pages) && valid(resources) &&
      union(pages, pageSearchRows.length) && union(resources, resourceOracle.length) };
  } finally { await app.close(); }
}

async function run(options: RunG6BaselineOptions, identity: RunIdentity): Promise<G6BaselineResult> {
  const officialSource = resolve(q10kG6V1.fixture.acceptedSourcePath);
  if (identity.official && resolve(options.sourcePath) !== officialSource) {
    throw new Error(`Q10K-G6 accepted source path mismatch: expected ${officialSource}`);
  }
  const sourceBefore = await stat(options.sourcePath);
  const sourceSha = await sha256G6DatabaseFile(options.sourcePath);
  if (sourceSha !== identity.expectedSourceSha256.toLowerCase()) throw new Error(
    `Q10K-G6 source SHA-256 mismatch: expected ${identity.expectedSourceSha256}, got ${sourceSha}`);
  await mkdir(options.workDirectory, { recursive: true });
  if ((await readdir(options.workDirectory)).length > 0) throw new Error(
    `G6 baseline work directory must be empty: ${options.workDirectory}`);
  const claim = await open(join(options.workDirectory, ".g6-baseline-claimed"), "wx");
  try { await claim.writeFile(`${JSON.stringify({ contractHash: identity.contractHash,
    official: identity.official })}\n`); } finally { await claim.close(); }
  const primaryPath = join(options.workDirectory, "S10K-G6-v1.sqlite");
  const replicaPath = join(options.workDirectory, "S10K-G6-v1-replica.sqlite");
  const measurementPath = join(options.workDirectory, "S10K-G6-v1-measurement.sqlite");
  const primary = await deriveFixture(options.sourcePath, primaryPath);
  const replica = await deriveFixture(options.sourcePath, replicaPath);
  const exactMatch = sameJson(primary, replica);
  if (!exactMatch || primary.schemaVersion !== q10kG6V1.fixture.expectedSchemaVersion ||
      !sameJson(primary.integrityCheck, ["ok"]) || primary.foreignKeyViolationCount !== 0) {
    throw new Error("Derived Q10K-G6 fixtures differ or failed schema/integrity checks");
  }
  const fixtureCoverage = coverage(primaryPath);
  if (!fixtureCoverage.passed) throw new Error(
    `Derived Q10K-G6 fixture coverage is incomplete: ${JSON.stringify(fixtureCoverage)}`,
  );
  const duplicateBoundary = selectBoundary(primaryPath);
  if (!duplicateBoundary.complete) throw new Error("Q10K-G6 duplicate boundary is incomplete");
  await copyFile(primaryPath, measurementPath, fsConstants.COPYFILE_EXCL);
  const measurementBefore = await inspectG6Database(measurementPath);
  const queries = await measure(measurementPath, duplicateBoundary);
  const fullSweep = await sweep(measurementPath);
  checkpointG6Database(measurementPath);
  const measurementAfter = await inspectG6Database(measurementPath);
  const measurementNoninterference = sameJson(measurementBefore, measurementAfter);
  if (!measurementNoninterference) throw new Error("Q10K-G6 writer-off measurement mutated SQLite");
  if (!fullSweep.passed) throw new Error("Q10K-G6 full sweep failed");
  const sourceAfter = await stat(options.sourcePath);
  const afterSha = await sha256G6DatabaseFile(options.sourcePath);
  const sourceUnchanged = sourceSha === afterSha && sourceBefore.mtimeMs === sourceAfter.mtimeMs;
  if (!sourceUnchanged) throw new Error("Accepted S10K-v1 source changed during Q10K-G6 run");
  const performancePassed = queries.every((query) => query.passed);
  const correctnessPassed = exactMatch && fixtureCoverage.passed && duplicateBoundary.complete &&
    fullSweep.passed && measurementNoninterference;
  const result: G6BaselineResult = {
    contractHash: identity.contractHash, official: identity.official,
    passed: identity.official && performancePassed && correctnessPassed,
    correctnessPassed, performancePassed, querySet: identity.querySet,
    fixture: identity.fixture, featureProfile: q10kG6V1.measurementFeatureProfile,
    databaseDeterminism: { primary, replica, exactMatch }, measurementBefore, measurementAfter,
    measurementNoninterference, fixtureCoverage, duplicateBoundary, queries, fullSweep,
    source: { path: options.sourcePath, beforeSha256: sourceSha, afterSha256: afterSha,
      beforeMtimeMs: sourceBefore.mtimeMs, unchanged: sourceUnchanged },
    warmups: q10kG6V1.warmups,
    runtime: { command: process.argv, head: gitHead(), node: process.version,
      platform: process.platform },
  };
  const resultPath = join(options.workDirectory, identity.artifactName);
  await mkdir(dirname(resultPath), { recursive: true });
  const temporary = `${resultPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, resultPath);
  return result;
}

export async function runG6Baseline(options: RunG6BaselineOptions): Promise<G6BaselineResult> {
  return run(options, { official: true, artifactName: "Q10K-G6-v1.json",
    querySet: q10kG6V1.querySet, contractHash: q10kG6V1Hash,
    expectedSourceSha256: q10kG6V1.fixture.acceptedSourceSha256, fixture: q10kG6V1.fixture });
}

export async function runG6CandidateBaselineForTest(options: RunG6BaselineOptions &
  { readonly expectedSourceSha256: string }): Promise<G6BaselineResult> {
  const fixture = Object.freeze({ ...q10kG6V1.fixture,
    acceptedSource: "noncanonical-test-candidate", acceptedSourcePath: "candidate-only",
    acceptedSourceSha256: options.expectedSourceSha256.toLowerCase(),
    derivedFixture: "noncanonical-G6-test-candidate" });
  const querySet = "Q10K-G6-candidate";
  return run(options, { official: false, artifactName: "Q10K-G6-candidate.json", querySet,
    contractHash: baselineContractHash({ ...q10kG6V1, fixture, querySet }),
    expectedSourceSha256: fixture.acceptedSourceSha256, fixture });
}
